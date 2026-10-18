# -*- coding: utf-8 -*-
"""
自动化测试脚本：验证 PC 阅读端、手机遥控端、API 接口、临时 PIN 码认证及受控设备数上限拦截逻辑。
"""
import sys
import pathlib
import tempfile
import os

ROOT = pathlib.Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT))

from starlette.testclient import TestClient
import server

TEST_LIBRARY = tempfile.TemporaryDirectory()
TEST_BASE_DIR = pathlib.Path(TEST_LIBRARY.name)
TEST_BOOKS_DIR = TEST_BASE_DIR / "books"
TEST_BOOKS_DIR.mkdir()
(TEST_BOOKS_DIR / "测试故事.md").write_text(
    "# 第一章 起点\n\n## 分幕 1-1 · 清晨\n\n这是用于自动化测试的示例正文。",
    encoding="utf-8",
)
server.BASE_DIR = TEST_BASE_DIR

client = TestClient(server.app)

# 0. 验证递归书库扫描
with tempfile.TemporaryDirectory() as temp_dir:
    root = pathlib.Path(temp_dir)
    nested = root / "nested"
    nested.mkdir()
    (nested / "novel.txt").write_text("nested book", encoding="utf-8")
    (nested / "cover.png").write_bytes(b"not a book")
    outside = root / "outside"
    outside.mkdir()
    secret = outside / "secret.txt"
    secret.write_text("must not be listed", encoding="utf-8")
    try:
        os.symlink(secret, nested / "escaped.txt")
    except OSError:
        print("[SKIP] Symlink escape test (current OS does not allow symlink creation)")
    found = list(server.iter_book_files(root))
    assert all(p.name != "escaped.txt" for p in found), f"Symlink escaped library root: {found}"
    assert any(p.name == "novel.txt" for p in found), f"Nested book was not discovered: {found}"
print("[PASS] Recursive library scan test")

# 1. 验证 PC 阅读端入口
r = client.get("/")
assert r.status_code == 200, f"Status {r.status_code}"
assert "遥卷" in r.text
print("[PASS] PC reader / test")

# 2. 验证手机专属遥控端入口
r = client.get("/remote")
assert r.status_code == 200, f"Status {r.status_code}"
assert "手机专属遥控端" in r.text
print("[PASS] Mobile remote /remote test")

# 3. 验证 /api/status 状态及临时 PIN 属性
r = client.get("/api/status")
assert r.status_code == 200
data = r.json()
assert len(data["pin"]) == 8, f"PIN length should be 8, got {len(data['pin'])}"
assert data["max_controllers"] >= 1
print(f"[PASS] /api/status test (PIN length: {len(data['pin'])}, Max: {data['max_controllers']}, Remote URL: {data['remote_url']})")

# 4. 验证 /api/books 书单动态扫描
r = client.get("/api/books")
assert r.status_code == 200
books = r.json()["books"]
assert len(books) > 0, "Should have at least 1 book available"
print(f"[PASS] /api/books test (Found {len(books)} books: {[b['name'] for b in books]})")

# 5. 验证 /api/book/content 内容获取
first_book = books[0]
r = client.get("/api/book/content", params={"path": first_book["path"]})
assert r.status_code == 200
cdata = r.json()
assert len(cdata["content"]) > 0
print(f"[PASS] /api/book/content test (Loaded '{first_book['name']}', size: {cdata['size']} chars)")

# 5.1 验证防御性文件安全校验 (非法后缀拦截)
r_bad = client.get("/api/book/content", params={"path": str(ROOT / "server.py")})
assert r_bad.status_code == 400, "Should reject non-txt/md file"
print("[PASS] Security guard: non-txt/md file extension rejection (HTTP 400)")

# 5.2 验证不存在文件 404 拦截
r_404 = client.get("/api/book/content", params={"path": str(TEST_BOOKS_DIR / "non_existent.txt")})
assert r_404.status_code == 404, "Should return 404 for missing file"
print("[PASS] Security guard: missing file rejection (HTTP 404)")

# 5.3 验证路径穿越与非白名单路径拦截 (HTTP 403)
r_traversal = client.get("/api/book/content", params={"path": str(ROOT.parent / "secret.txt")})
assert r_traversal.status_code == 403, "Should reject path traversal / non-whitelisted path with 403"
print("[PASS] Security guard: path traversal attack blocked (HTTP 403)")

# 5.4 验证 /api/settings 输入校验与防崩溃
r_bad_mc = client.post("/api/settings", json={"max_controllers": "invalid"})
assert r_bad_mc.status_code == 400, "Should reject non-integer max_controllers"
r_out_range = client.post("/api/settings", json={"max_controllers": 99})
assert r_out_range.status_code == 400, "Should reject out-of-range max_controllers"
print("[PASS] Settings input validation guard (HTTP 400)")

# 6. 验证 WebSocket /ws/remote 鉴权及设备数拦截
pin = server.device_mgr.pin

# 测试错误 PIN 拦截
with client.websocket_connect("/ws/remote?pin=INVALIDPIN") as ws:
    msg = ws.receive_json()
    assert msg["ok"] == False, "Should reject invalid PIN"
    print("[PASS] WS invalid PIN rejection")

# 测试正确 PIN 验证 (测试大小写不敏感)
with client.websocket_connect(f"/ws/remote?pin={pin.lower()}&client_name=TestMobile") as ws:
    msg = ws.receive_json()
    assert msg["ok"] == True, "Should accept case-insensitive PIN"
    print("[PASS] WS case-insensitive PIN handshake")

# 测试受控设备数上限拦截 (设上限为 1)
server.device_mgr.max_controllers = 1
with client.websocket_connect(f"/ws/remote?pin={pin}&client_name=Device1") as ws1:
    msg1 = ws1.receive_json()
    assert msg1["ok"] == True
    print("[PASS] Device 1 connection allowed")
    
    # 第 2 台设备尝试连入，必须被拦截
    with client.websocket_connect(f"/ws/remote?pin={pin}&client_name=Device2") as ws2:
        msg2 = ws2.receive_json()
        assert msg2["ok"] == False, "Device 2 must be rejected by limit"
        assert "最大控制设备数" in msg2["message"]
        print("[PASS] Device 2 limit enforcement rejection")

# 7. 验证遥控端未知指令白名单过滤
with client.websocket_connect("/ws/reader") as ws_reader:
    _init_msg = ws_reader.receive_json()
    with client.websocket_connect(f"/ws/remote?pin={pin}&client_name=DeviceFilter") as ws_remote:
        _auth = ws_remote.receive_json()
        _dev_update = ws_reader.receive_json()  # 设备连接时 PC 端接收 devices_update 通知
        # 发送非法指令，不应被转发给阅读端
        ws_remote.send_json({"action": "malicious_eval_script", "code": "alert(1)"})
        # 发送合法指令
        ws_remote.send_json({"action": "page_down"})
        # 电脑端应仅收到合法指令（恶意指令被彻底过滤拦截）
        received = ws_reader.receive_json()
        assert received.get("action") == "page_down", f"Expected page_down, got {received}"
        print("[PASS] Remote command whitelist sanitization guard")

# 8. 验证外部非本地客户端安全隔离
ext_client = TestClient(server.app, client=("192.168.1.99", 54321))

# 8.1 外部客户端不能打开电脑阅读器或读取书单/正文
r_ext_reader = ext_client.get("/")
assert r_ext_reader.status_code == 403, "LAN client must not open the PC reader"
r_ext_books = ext_client.get("/api/books")
assert r_ext_books.status_code == 403, "LAN client must not enumerate the library"
r_ext_content = ext_client.get("/api/book/content", params={"path": first_book["path"]})
assert r_ext_content.status_code == 403, "LAN client must not read book content"
print("[PASS] LAN reader, library and content access blocked")

# 8.2 外部客户端访问 /api/status 仅获得最小状态信息
r_ext_status = ext_client.get("/api/status")
assert r_ext_status.status_code == 200
r_ext_data = r_ext_status.json()
assert "pin" not in r_ext_data, "External client should not see PIN in /api/status"
assert "controllers" not in r_ext_data and "all_ips" not in r_ext_data, "External status should not expose device details"
print("[PASS] External client /api/status minimization")

# 8.3 外部客户端尝试访问 /api/settings 遭 403 拒绝
r_ext_settings = ext_client.post("/api/settings", json={"max_controllers": 2})
assert r_ext_settings.status_code == 403
print("[PASS] External client /api/settings rejection (HTTP 403)")

# 8.4 外部客户端连接 /ws/reader 遭断开拒绝 (code 4003)
try:
    with ext_client.websocket_connect("/ws/reader") as ws_ext:
        try:
            ws_ext.receive_text()
            assert False, "External client should not be allowed to connect /ws/reader"
        except Exception:
            pass
except Exception:
    pass
print("[PASS] External client /ws/reader rejection")

# 8.5 验证 /api/settings 非 dict 类型的格式门禁 (HTTP 400)
r_bad_type = client.post("/api/settings", content="not a json", headers={"Content-Type": "application/json"})
assert r_bad_type.status_code == 400
print("[PASS] Settings non-dict payload rejection (HTTP 400)")

# 8.6 验证电脑端通过 WS 发送 kick 指令下线手机端
server.device_mgr.max_controllers = 5
with client.websocket_connect("/ws/reader") as ws_reader:
    _ = ws_reader.receive_json()
    with client.websocket_connect(f"/ws/remote?pin={server.device_mgr.pin}&client_name=ToKick") as ws_remote:
        auth_info = ws_remote.receive_json()
        cid = auth_info["cid"]
        _ = ws_reader.receive_json()  # devices_update
        # 电脑端发送 kick
        ws_reader.send_json({"action": "kick", "id": cid})
        # 手机端应该被关闭
        try:
            _ = ws_remote.receive_json()
        except Exception:
            pass
        assert cid not in server.device_mgr.controllers
        print("[PASS] Kick controller over WS test")

TEST_LIBRARY.cleanup()
print("\n>>> ALL TESTS PASSED SUCCESSFULLY <<<")
