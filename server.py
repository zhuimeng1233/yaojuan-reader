# -*- coding: utf-8 -*-
"""
遥卷 (Yaojuan) - 本地服务端
- 电脑端浏览器沉浸式小说阅读
- 局域网手机专属遥控端（无小说正文传输，纯手势/按键遥控）
- 8 位临时字母数字 PIN 验证（大小写不敏感）
- 服务端受控设备数上限管理 (防蹭连/多控)
- 原生支持 generate.py 双层分幕与常规 TXT 小说
"""

import asyncio
import datetime
import json
import io
import os
import pathlib
import random
import re
import secrets
import socket
import string
import sys
import threading
import time
import webbrowser

# 解决 Windows 终端 GBK 编码输出崩溃问题
try:
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
        sys.stderr.reconfigure(encoding="utf-8", errors="replace")
    else:
        sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")
        sys.stderr = io.TextIOWrapper(sys.stderr.buffer, encoding="utf-8", errors="replace")
except Exception:
    pass

import uvicorn
from fastapi import FastAPI, WebSocket, WebSocketDisconnect, Query, HTTPException, Request
from fastapi.responses import HTMLResponse, JSONResponse, FileResponse
from fastapi.staticfiles import StaticFiles

# 路径常量
BASE_DIR = pathlib.Path(__file__).resolve().parent
STATIC_DIR = BASE_DIR / "static"
BOOK_SUFFIXES = {".txt", ".md"}


PORT = 8765


# ---------- 获取局域网与电脑热点 IP ----------
def get_all_lan_ips() -> list[str]:
    ips = set()
    # 1. 优先通过 psutil 枚举网卡（可穿透读取 Windows 移动热点虚拟适配器）
    try:
        import psutil
        for iface_name, addrs in psutil.net_if_addrs().items():
            for addr in addrs:
                if addr.family == socket.AF_INET:
                    ip = addr.address
                    if not ip.startswith("127.") and not ip.startswith("169.254.") and not ip.startswith("198.18."):
                        ips.add(ip)
    except Exception:
        pass

    # 2. 回退通过 ipconfig 正则扫描
    if not ips:
        try:
            import subprocess
            out = subprocess.check_output("ipconfig", text=True, errors="ignore")
            for m in re.finditer(r"IPv4.*?:\s*([0-9]+\.[0-9]+\.[0-9]+\.[0-9]+)", out):
                ip = m.group(1).strip()
                if not ip.startswith("127.") and not ip.startswith("169.254.") and not ip.startswith("198.18."):
                    ips.add(ip)
        except Exception:
            pass

    # 3. 兜底 socket 探测
    if not ips:
        try:
            with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
                s.connect(("8.8.8.8", 80))
                ips.add(s.getsockname()[0])
        except Exception:
            pass

    ip_list = list(ips)
    # 排序优先级：电脑热点 (192.168.137.x) 最优先！其次 192.168.x.x，其次 172.x.x
    def ip_priority(ip: str):
        if ip.startswith("192.168.137."):
            return 0  # 电脑热点第一优先级
        if ip.startswith("192.168."):
            return 1
        if re.match(r"^172\.(1[6-9]|2\d|3[01])\.", ip):
            return 2
        if ip.startswith("10."):
            return 3
        return 4

    ip_list.sort(key=ip_priority)
    return ip_list or ["127.0.0.1"]


def is_local_request(req_or_ws) -> bool:
    """判断请求或 WebSocket 是否来自本机客户端（兼容 127.0.0.1、localhost 与本机网卡 IP）"""
    client = getattr(req_or_ws, "client", None)
    host = client.host if client else ""
    if host in ("127.0.0.1", "::1", "localhost", "testclient"):
        return True
    try:
        if host and host in get_all_lan_ips():
            return True
    except Exception:
        pass
    return False


def is_safe_book_path(target: pathlib.Path) -> bool:
    """路径安全白名单校验：只允许访问合法受控的书库目录，杜绝任意文件读取与路径穿越"""
    try:
        resolved = target.resolve()
    except Exception:
        return False

    def is_subpath(child: pathlib.Path, parent: pathlib.Path) -> bool:
        try:
            child.relative_to(parent)
            return True
        except ValueError:
            return False

    # 1. 允许工程内置 books 目录
    books_dir = (BASE_DIR / "books").resolve()
    if books_dir.exists() and is_subpath(resolved, books_dir):
        return True

    # 2. 允许项目根目录下的示例文件
    if resolved == (BASE_DIR / "sample.md").resolve() or resolved == (BASE_DIR / "sample.txt").resolve():
        return True

    # 3. 允许 config.json 中显式登记的文件或目录
    config_file = BASE_DIR / "config.json"
    if config_file.exists():
        try:
            cfg = json.loads(config_file.read_text(encoding="utf-8", errors="ignore"))
            for p in cfg.get("custom_books", []):
                cfg_p = pathlib.Path(p).resolve()
                if resolved == cfg_p:
                    return True
                if cfg_p.is_dir() and is_subpath(resolved, cfg_p):
                    return True
        except Exception:
            pass

    # 4. 允许环境变量 NOVEL_DIR 下的文件
    env_dir = os.environ.get("NOVEL_DIR")
    if env_dir:
        ep = pathlib.Path(env_dir).resolve()
        if ep.exists() and ep.is_dir() and is_subpath(resolved, ep):
            return True

    return False


def iter_book_files(root: pathlib.Path):
    """递归枚举书库文本文件，并阻止目录内符号链接逃逸。"""
    try:
        resolved_root = root.resolve()
    except Exception:
        return

    if resolved_root.is_file():
        if resolved_root.suffix.lower() in BOOK_SUFFIXES:
            yield resolved_root
        return

    if not resolved_root.is_dir():
        return

    for candidate in sorted(resolved_root.rglob("*"), key=lambda p: str(p).lower()):
        if not candidate.is_file() or candidate.suffix.lower() not in BOOK_SUFFIXES:
            continue
        try:
            resolved = candidate.resolve()
            resolved.relative_to(resolved_root)
        except (OSError, ValueError):
            continue
        yield resolved


app = FastAPI(title="Yaojuan")

# 挂载静态资源
app.mount("/static", StaticFiles(directory=str(STATIC_DIR)), name="static")


# ---------- 网络与设备状态管理 ----------
class DeviceManager:
    def __init__(self):
        self.pin = self.generate_pin()
        self.max_controllers = 1  # 默认允许 1 台手机遥控
        self.pc_websockets: set[WebSocket] = set()
        self.controllers: dict[str, dict] = {}  # id -> {ws, ip, user_agent, connected_at}
        self.lock = asyncio.Lock()

    @staticmethod
    def generate_pin() -> str:
        # 排除容易混淆的字符：0, O, 1, I
        chars = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ"
        raw = "".join(secrets.choice(chars) for _ in range(8))
        return raw

    def check_pin(self, user_pin) -> bool:
        if user_pin is None:
            return False
        clean_user = re.sub(r"[^A-Za-z0-9]", "", str(user_pin)).upper()
        clean_curr = re.sub(r"[^A-Za-z0-9]", "", str(self.pin)).upper()
        return clean_user == clean_curr

    def refresh_pin(self) -> str:
        self.pin = self.generate_pin()
        return self.pin

    def get_controllers_info(self) -> list[dict]:
        res = []
        for cid, info in self.controllers.items():
            res.append({
                "id": cid,
                "ip": info["ip"],
                "user_agent": info["user_agent"],
                "connected_at": info["connected_at"],
            })
        return res

    async def notify_pc_devices_changed(self):
        info = {
            "type": "devices_update",
            "pin": self.pin,
            "max_controllers": self.max_controllers,
            "controllers": self.get_controllers_info(),
        }
        dead = []
        for ws in list(self.pc_websockets):
            try:
                await ws.send_text(json.dumps(info, ensure_ascii=False))
            except Exception:
                dead.append(ws)
        for d in dead:
            self.pc_websockets.discard(d)

    async def broadcast_to_pc(self, message: dict):
        dead = []
        text = json.dumps(message, ensure_ascii=False)
        for ws in list(self.pc_websockets):
            try:
                await ws.send_text(text)
            except Exception:
                dead.append(ws)
        for d in dead:
            self.pc_websockets.discard(d)

    async def kick_controller(self, controller_id: str):
        c = None
        async with self.lock:
            if controller_id in self.controllers:
                c = self.controllers.pop(controller_id)
        if c:
            try:
                await c["ws"].close(code=4003, reason="已在电脑端断开此设备")
            except Exception:
                pass
            await self.notify_pc_devices_changed()


device_mgr = DeviceManager()


# ---------- 网页路由 ----------
@app.get("/", response_class=HTMLResponse)
async def serve_pc_reader(req: Request):
    if not is_local_request(req):
        return HTMLResponse(
            "<h1>阅读器仅限本机访问</h1><p>局域网设备请打开 /remote 使用手机遥控端。</p>",
            status_code=403,
        )
    index_file = STATIC_DIR / "index.html"
    if not index_file.exists():
        return HTMLResponse("<h1>index.html not found</h1>", status_code=404)
    return FileResponse(index_file)


@app.get("/remote", response_class=HTMLResponse)
async def serve_mobile_remote():
    remote_file = STATIC_DIR / "remote.html"
    if not remote_file.exists():
        return HTMLResponse("<h1>remote.html not found</h1>", status_code=404)
    return FileResponse(remote_file)


# ---------- API 接口 ----------
@app.get("/api/status")
async def get_status(req: Request):
    lan_ips = get_all_lan_ips()
    primary_ip = lan_ips[0] if lan_ips else "127.0.0.1"
    is_local = is_local_request(req)
    remote_url = f"http://{primary_ip}:{PORT}/remote"
    if not is_local:
        # 局域网只获得连接手机遥控端所需的最低限度信息。
        return {
            "status": "ok",
            "remote_url": remote_url,
        }

    data = {
        "status": "ok",
        "primary_ip": primary_ip,
        "all_ips": lan_ips,
        "port": PORT,
        "remote_url": remote_url,
        "max_controllers": device_mgr.max_controllers,
        "active_controllers": len(device_mgr.controllers),
        "controllers": device_mgr.get_controllers_info(),
    }
    data["pin"] = device_mgr.pin
    return data


@app.post("/api/settings")
async def update_settings(req: Request):
    # 鉴权：仅允许本机直接调用，或提供正确 PIN 码
    is_local = is_local_request(req)
    try:
        data = await req.json()
        if not isinstance(data, dict):
            raise ValueError()
    except Exception:
        raise HTTPException(status_code=400, detail="请求体必须是合法 JSON 对象")

    if not is_local:
        req_pin = req.headers.get("X-PIN") or req.headers.get("Authorization", "").replace("Bearer ", "").strip()
        auth_pin = req_pin or data.get("pin", "")
        if not device_mgr.check_pin(auth_pin):
            raise HTTPException(status_code=403, detail="未授权的操作：需要提供有效 PIN 码")

    if "max_controllers" in data:
        try:
            mc = int(data["max_controllers"])
            if 1 <= mc <= 10:
                device_mgr.max_controllers = mc
            else:
                raise HTTPException(status_code=400, detail="max_controllers 取值范围必须在 1 到 10 之间")
        except (ValueError, TypeError):
            raise HTTPException(status_code=400, detail="max_controllers 必须是整数")

    if data.get("refresh_pin"):
        device_mgr.refresh_pin()
    if data.get("kick_id"):
        await device_mgr.kick_controller(str(data["kick_id"]))

    await device_mgr.notify_pc_devices_changed()
    resp = {
        "status": "ok",
        "max_controllers": device_mgr.max_controllers,
        "controllers": device_mgr.get_controllers_info(),
    }
    if is_local:
        resp["pin"] = device_mgr.pin
    return resp


@app.get("/api/books")
async def list_preset_books(req: Request):
    """动态扫描本地书库：支持 books/ 目录与可选的 config.json 自定义书单"""
    if not is_local_request(req):
        raise HTTPException(status_code=403, detail="书单接口仅限本机访问")

    roots = []
    
    # 1. 优先读取本地配置文件 config.json (gitignored，保护个人私密路径)
    config_file = BASE_DIR / "config.json"
    if config_file.exists():
        try:
            cfg = json.loads(config_file.read_text(encoding="utf-8", errors="ignore"))
            for p in cfg.get("custom_books", []):
                roots.append(pathlib.Path(p))
        except Exception:
            pass

    # 2. 自动扫描工程内置的 books/ 目录
    books_dir = BASE_DIR / "books"
    if books_dir.exists() and books_dir.is_dir():
        roots.append(books_dir)

    # 3. 环境变量可选拓展
    env_dir = os.environ.get("NOVEL_DIR")
    if env_dir:
        ep = pathlib.Path(env_dir)
        if ep.exists() and ep.is_dir():
            roots.append(ep)

    books = []
    seen_paths = set()
    for root in roots:
        for t in iter_book_files(root):
            try:
                t_res = t.resolve()
                if t_res in seen_paths:
                    continue
                seen_paths.add(t_res)
                stat = t.stat()
                books.append({
                    "name": t.name,
                    "path": str(t),
                    "size_mb": round(stat.st_size / (1024 * 1024), 2),
                    "updated_at": datetime.datetime.fromtimestamp(stat.st_mtime).strftime("%Y-%m-%d %H:%M"),
                })
            except Exception:
                pass
    return {"books": books}


MAX_FILE_SIZE = 60 * 1024 * 1024  # 60MB 安全上限，防止超大文件耗尽系统内存

@app.get("/api/book/content")
async def get_book_content(req: Request, path: str = Query(...)):
    """加载本地小说内容，智能自适应 UTF-8 / GB18030 / GBK 编码（带防御性门禁）"""
    if not is_local_request(req):
        raise HTTPException(status_code=403, detail="正文接口仅限本机访问")

    try:
        target = pathlib.Path(path).resolve()
    except Exception:
        raise HTTPException(status_code=400, detail="非法路径格式")

    # 1. 安全扩展名校验
    if target.suffix.lower() not in [".txt", ".md"]:
        raise HTTPException(status_code=400, detail="仅支持读取 .txt 与 .md 文本小说")

    # 2. 路径白名单安全校验（杜绝路径穿越与非授权文件读取/侧信道探测）
    if not is_safe_book_path(target):
        raise HTTPException(status_code=403, detail="安全拦截：目标路径不在允许的书库白名单范围内")

    if not target.exists() or not target.is_file():
        raise HTTPException(status_code=404, detail="文件不存在")

    # 3. 文件体积安全卫兵
    try:
        fsize = target.stat().st_size
        if fsize > MAX_FILE_SIZE:
            raise HTTPException(
                status_code=413,
                detail=f"文件体积为 {round(fsize / 1024 / 1024, 1)}MB，超出 60MB 上限，为保护系统内存已拦截"
            )
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"获取文件信息异常: {str(e)}")

    def _read_and_decode(p: pathlib.Path) -> str:
        raw_bytes = p.read_bytes()
        t = ""
        if raw_bytes.startswith(b"\xef\xbb\xbf"):
            t = raw_bytes[3:].decode("utf-8", errors="replace")
        elif raw_bytes.startswith(b"\xff\xfe"):
            t = raw_bytes[2:].decode("utf-16le", errors="replace")
        elif raw_bytes.startswith(b"\xfe\xff"):
            t = raw_bytes[2:].decode("utf-16be", errors="replace")

        if not t:
            try:
                t = raw_bytes.decode("utf-8")
            except UnicodeDecodeError:
                pass

        if not t:
            try:
                t = raw_bytes.decode("gb18030")
            except UnicodeDecodeError:
                try:
                    t = raw_bytes.decode("gbk", errors="replace")
                except Exception:
                    pass

        if not t:
            t = raw_bytes.decode("utf-8", errors="replace")
        return t

    try:
        text = await asyncio.to_thread(_read_and_decode, target)
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"文件读取异常: {str(e)}")

    return {
        "name": target.name,
        "path": str(target),
        "size": len(text),
        "content": text,
    }


# ---------- WebSocket 通信 ----------
@app.websocket("/ws/reader")
async def ws_reader_endpoint(websocket: WebSocket):
    """电脑端阅读器连接通道（仅允许本地请求，防局域网偷取控制权和 PIN）"""
    if not is_local_request(websocket):
        await websocket.close(code=4003, reason="Local access only")
        return

    await websocket.accept()
    device_mgr.pc_websockets.add(websocket)
    try:
        # 连接成功后推送当前状态
        await websocket.send_text(json.dumps({
            "type": "init",
            "pin": device_mgr.pin,
            "max_controllers": device_mgr.max_controllers,
            "controllers": device_mgr.get_controllers_info(),
        }, ensure_ascii=False))

        while True:
            data = await websocket.receive_text()
            if len(data) > 8192:
                continue
            # 处理电脑端的主动设置变更（如修改人数、刷新PIN）
            try:
                msg = json.loads(data)
                if msg.get("action") == "refresh_pin":
                    device_mgr.refresh_pin()
                    await device_mgr.notify_pc_devices_changed()
                elif msg.get("action") == "set_max_controllers":
                    val = int(msg.get("value", 1))
                    if 1 <= val <= 10:
                        device_mgr.max_controllers = val
                        await device_mgr.notify_pc_devices_changed()
                elif msg.get("action") == "kick":
                    cid = msg.get("id")
                    if cid:
                        await device_mgr.kick_controller(cid)
            except Exception:
                pass
    except WebSocketDisconnect:
        pass
    finally:
        device_mgr.pc_websockets.discard(websocket)


@app.websocket("/ws/remote")
async def ws_remote_endpoint(
    websocket: WebSocket,
    pin: str = Query(""),
    client_name: str = Query("手机遥控器"),
):
    """手机端专属触控遥控器通道"""
    cid = f"ctrl_{secrets.token_hex(6)}"

    # 1. 验证 PIN（大小写不敏感，纯内存校验，无需持锁）
    if not device_mgr.check_pin(pin):
        await websocket.accept()
        await websocket.send_text(json.dumps({
            "type": "auth_result",
            "ok": False,
            "message": "PIN 码不正确或已失效，请在电脑端查看最新 8 位 PIN",
        }, ensure_ascii=False))
        await websocket.close(code=4001, reason="PIN invalid")
        return

    # 2. 检查设备数上限 (仅在锁内校验并占位，所有网络 I/O 移出锁外)
    limit_exceeded = False
    async with device_mgr.lock:
        if len(device_mgr.controllers) >= device_mgr.max_controllers:
            limit_exceeded = True
        else:
            client_ip = websocket.client.host if websocket.client else "未知IP"
            device_mgr.controllers[cid] = {
                "ws": websocket,
                "ip": client_ip,
                "user_agent": client_name[:50] if client_name else "手机遥控器",
                "connected_at": datetime.datetime.now().strftime("%H:%M:%S"),
            }

    if limit_exceeded:
        await websocket.accept()
        await websocket.send_text(json.dumps({
            "type": "auth_result",
            "ok": False,
            "message": f"连接已被拒绝：已达最大控制设备数（当前上限：{device_mgr.max_controllers} 台）。请在电脑端调整上限或断开其他设备。",
        }, ensure_ascii=False))
        await websocket.close(code=4002, reason="Device limit exceeded")
        return

    # 3. 授权通过
    await websocket.accept()
    await websocket.send_text(json.dumps({
        "type": "auth_result",
        "ok": True,
        "cid": cid,
        "message": "连接成功！您已获得电脑端遥控权限。",
    }, ensure_ascii=False))

    # 通知电脑端设备连入
    await device_mgr.notify_pc_devices_changed()

    ALLOWED_ACTIONS = {
        "page_down", "page_up", "next_scene", "prev_scene",
        "scroll_by", "zoom", "toggle_theme", "toggle_fullscreen",
        "toggle_toc", "scroll_top", "scroll_bottom",
    }

    try:
        while True:
            text = await websocket.receive_text()
            if len(text) > 8192:
                continue
            try:
                raw_cmd = json.loads(text)
                if not isinstance(raw_cmd, dict):
                    continue
                action = raw_cmd.get("action")
                if action not in ALLOWED_ACTIONS:
                    continue
                clean_cmd = {"action": action, "from_cid": cid}
                if action == "scroll_by":
                    delta = raw_cmd.get("delta")
                    if isinstance(delta, (int, float)) and -5000 <= delta <= 5000:
                        clean_cmd["delta"] = float(delta)
                    else:
                        continue
                elif action == "zoom":
                    direction = raw_cmd.get("dir")
                    if direction in ("in", "out"):
                        clean_cmd["dir"] = direction
                    else:
                        continue
                # 转发清洗后的遥控指令至电脑端
                await device_mgr.broadcast_to_pc(clean_cmd)
            except Exception:
                pass
    except WebSocketDisconnect:
        pass
    finally:
        async with device_mgr.lock:
            device_mgr.controllers.pop(cid, None)
        await device_mgr.notify_pc_devices_changed()


def main():
    lan_ips = get_all_lan_ips()
    primary = lan_ips[0] if lan_ips else "127.0.0.1"

    print("=" * 66, flush=True)
    print(" [*] 遥卷 (Yaojuan) 服务端已就绪！", flush=True)
    print(f" [PC] 电脑阅读端入口:  http://localhost:{PORT}", flush=True)
    print(f" [APP] 手机专属遥控端:  http://{primary}:{PORT}/remote", flush=True)
    print(f" [PIN] 当前临时 PIN 码: {device_mgr.pin} (8位字母数字，大小写不敏感)", flush=True)
    print(f" [MAX] 默认受控设备数: {device_mgr.max_controllers} 台", flush=True)
    print("=" * 66, flush=True)

    # 自动弹出浏览器
    def open_browser():
        time.sleep(1.2)
        try:
            webbrowser.open(f"http://localhost:{PORT}")
        except Exception:
            pass

    threading.Thread(target=open_browser, daemon=True).start()

    uvicorn.run(app, host="0.0.0.0", port=PORT, log_level="warning")


if __name__ == "__main__":
    main()
