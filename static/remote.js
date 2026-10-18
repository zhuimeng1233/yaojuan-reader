/**
 * 遥卷 (Yaojuan) - 手机专属无线遥控端脚本
 * 纯手势与按键遥控，支持临时 PIN 鉴权、受控上限门禁与虚拟滑板
 */

(function () {
  'use strict';

  let ws = null;
  let activePin = '';
  let wakeLock = null;
  let reconnectAttempts = 0;
  let reconnectTimer = null;
  let manualDisconnect = false;

  function scheduleReconnect() {
    if (manualDisconnect || !activePin) return;
    clearTimeout(reconnectTimer);
    const delay = Math.min(15000, 1000 * Math.pow(1.5, reconnectAttempts));
    authErrorMsg.textContent = `遥控连接已断开，将在 ${(delay / 1000).toFixed(1)} 秒后尝试自动恢复...`;
    reconnectTimer = setTimeout(() => {
      reconnectAttempts++;
      connect(activePin);
    }, delay);
  }

  // DOM 元素缓存
  const authScreen = document.getElementById('authScreen');
  const controllerScreen = document.getElementById('controllerScreen');
  const pinInput = document.getElementById('pinInput');
  const authErrorMsg = document.getElementById('authErrorMsg');
  const btnConnect = document.getElementById('btnConnect');
  const btnDisconnect = document.getElementById('btnDisconnect');
  const trackpadArea = document.getElementById('trackpadArea');
  const trackpadRipple = document.getElementById('trackpadRipple');

  // 获取设备简短名 (例如 "iPhone", "Android", "Mobile")
  function getDeviceLabel() {
    const ua = navigator.userAgent;
    if (/iPhone/i.test(ua)) return 'iPhone 遥控器';
    if (/iPad/i.test(ua)) return 'iPad 遥控器';
    if (/Android/i.test(ua)) return 'Android 手机遥控';
    return '手机遥控器';
  }

  // 细腻振动反馈
  function vibrate(ms = 15) {
    if (navigator.vibrate) {
      try {
        navigator.vibrate(ms);
      } catch (e) {}
    }
  }

  // 发送指令到 WebSocket
  function sendAction(actionObj) {
    vibrate(15);
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(actionObj));
    }
  }

  // 保持屏幕常亮 (Wake Lock)
  async function requestWakeLock() {
    if ('wakeLock' in navigator) {
      try {
        wakeLock = await navigator.wakeLock.request('screen');
        wakeLock.addEventListener('release', () => {
          wakeLock = null;
        });
      } catch (err) {
        console.warn('Wake Lock error:', err);
      }
    }
  }

  function releaseWakeLock() {
    if (wakeLock) {
      wakeLock.release().catch(() => {});
      wakeLock = null;
    }
  }

  // 连接 WebSocket
  function connect(pin) {
    pin = pin.trim().replace(/[^a-zA-Z0-9]/g, '').toUpperCase();
    if (pin.length !== 8) {
      authErrorMsg.textContent = '请输入完整的 8 位字母数字 PIN 码';
      return;
    }

    authErrorMsg.textContent = '正在连接电脑端进行身份核验...';
    btnConnect.disabled = true;

    if (ws) {
      ws.onclose = ws.onerror = ws.onmessage = null;
      ws.close();
      ws = null;
    }

    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const clientName = encodeURIComponent(getDeviceLabel());
    const wsUrl = `${protocol}//${location.host}/ws/remote?pin=${pin}&client_name=${clientName}`;

    ws = new WebSocket(wsUrl);

    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        if (msg.type === 'auth_result') {
          btnConnect.disabled = false;
          if (msg.ok) {
            // 认证通过
            activePin = pin;
            reconnectAttempts = 0;
            clearTimeout(reconnectTimer);
            try {
              localStorage.setItem('yaojuan_remote_pin', pin);
            } catch (e) {}

            authScreen.style.display = 'none';
            controllerScreen.style.display = 'flex';
            requestWakeLock();
            vibrate([20, 50, 20]);
          } else {
            // 认证失败或已达上限
            authErrorMsg.textContent = msg.message || '连接失败，请核对 PIN 码';
            ws.close();
          }
        }
      } catch (err) {
        console.error('Parse WS message error:', err);
      }
    };

    ws.onclose = (event) => {
      btnConnect.disabled = false;
      releaseWakeLock();
      controllerScreen.style.display = 'none';
      authScreen.style.display = 'flex';

      // 4001: PIN 无效; 4002: 上限满员; 4003: 被电脑端主动踢出
      if (event.code === 4001 || event.code === 4002 || event.code === 4003) {
        activePin = '';
        clearTimeout(reconnectTimer);
        authErrorMsg.textContent = event.reason || '连接已关闭或被电脑端移除';
        return;
      }

      authErrorMsg.textContent = event.reason || '与电脑端的遥控连接已断开';
      if (activePin && !manualDisconnect) {
        scheduleReconnect();
      }
    };

    ws.onerror = () => {
      btnConnect.disabled = false;
      authErrorMsg.textContent = '网络连接错误，请确认手机与电脑在同一个局域网/Wi-Fi 下';
    };
  }

  // 虚拟滑板手势系统 (Trackpad) - RAF 防高刷泛洪与背压控制
  function initTrackpad() {
    let startX = 0;
    let startY = 0;
    let lastX = 0;
    let lastY = 0;
    let startTime = 0;
    let isTouching = false;
    let pendingDeltaY = 0;
    let rafTouchId = null;

    trackpadArea.addEventListener('touchstart', (e) => {
      if (e.touches.length !== 1) return;
      const touch = e.touches[0];
      const rect = trackpadArea.getBoundingClientRect();
      startX = touch.clientX;
      startY = touch.clientY;
      lastX = touch.clientX;
      lastY = touch.clientY;
      startTime = Date.now();
      isTouching = true;

      // 视觉光圈反馈
      trackpadRipple.style.left = `${touch.clientX - rect.left}px`;
      trackpadRipple.style.top = `${touch.clientY - rect.top}px`;
      trackpadRipple.classList.add('active');
    }, { passive: true });

    trackpadArea.addEventListener('touchmove', (e) => {
      if (!isTouching || e.touches.length !== 1) return;
      const touch = e.touches[0];
      const rect = trackpadArea.getBoundingClientRect();
      const currentX = touch.clientX;
      const currentY = touch.clientY;
      const deltaY = lastY - currentY; // 手指向上划 -> 电脑向下滚
      lastX = currentX;
      lastY = currentY;

      // 移动光圈
      trackpadRipple.style.left = `${touch.clientX - rect.left}px`;
      trackpadRipple.style.top = `${touch.clientY - rect.top}px`;

      // 累加位移
      pendingDeltaY += Math.round(deltaY * 2.2);

      // 通过 requestAnimationFrame 限制在与屏幕刷新率对齐的 60fps 发送，消除 120Hz/240Hz 屏幕触控事件泛洪
      if (!rafTouchId) {
        rafTouchId = requestAnimationFrame(() => {
          if (ws && ws.readyState === WebSocket.OPEN) {
            // 防御性背压控制：若 socket 发送缓冲区排队超过 32KB，丢弃高频滑动包，防网络拥塞
            if (ws.bufferedAmount < 32768 && Math.abs(pendingDeltaY) > 0) {
              ws.send(JSON.stringify({ action: 'scroll_by', delta: pendingDeltaY }));
            }
          }
          pendingDeltaY = 0;
          rafTouchId = null;
        });
      }
    }, { passive: true });

    trackpadArea.addEventListener('touchend', (e) => {
      if (!isTouching) return;
      isTouching = false;
      trackpadRipple.classList.remove('active');

      const endTime = Date.now();
      const touchDuration = endTime - startTime;
      const moveDistanceY = Math.abs(lastY - startY);
      const moveDistanceX = Math.abs(lastX - startX);

      // 单击判断 (时长 < 250ms 且 X/Y 位移均 < 10px -> 触发点击下翻页)
      if (touchDuration < 250 && moveDistanceY < 10 && moveDistanceX < 10) {
        sendAction({ action: 'page_down' });
      }
    }, { passive: true });

    trackpadArea.addEventListener('touchcancel', () => {
      isTouching = false;
      pendingDeltaY = 0;
      trackpadRipple.classList.remove('active');
    }, { passive: true });
  }

  // 界面交互绑定
  function initUI() {
    // 自动填充 URL query 或本地记录的 PIN
    const urlParams = new URLSearchParams(window.location.search);
    const pinInUrl = urlParams.get('pin');
    let savedPin = '';
    try {
      savedPin = localStorage.getItem('yaojuan_remote_pin')
        || localStorage.getItem('comfort_reader_remote_pin')
        || '';
    } catch (e) {}

    const initPin = pinInUrl || savedPin;
    if (initPin) {
      pinInput.value = initPin.toUpperCase();
    }

    pinInput.addEventListener('input', (e) => {
      e.target.value = e.target.value.replace(/[^a-zA-Z0-9]/g, '').toUpperCase();
    });

    pinInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        connect(pinInput.value);
      }
    });

    btnConnect.addEventListener('click', () => {
      manualDisconnect = false;
      connect(pinInput.value);
    });

    btnDisconnect.addEventListener('click', () => {
      manualDisconnect = true;
      clearTimeout(reconnectTimer);
      if (ws) ws.close();
      controllerScreen.style.display = 'none';
      authScreen.style.display = 'flex';
      authErrorMsg.textContent = '已手动断开遥控连接';
    });

    // 翻页与跳转大按键
    document.getElementById('btnPageDown').addEventListener('click', () => {
      sendAction({ action: 'page_down' });
    });
    document.getElementById('btnPageUp').addEventListener('click', () => {
      sendAction({ action: 'page_up' });
    });
    document.getElementById('btnNextScene').addEventListener('click', () => {
      sendAction({ action: 'next_scene' });
    });
    document.getElementById('btnPrevScene').addEventListener('click', () => {
      sendAction({ action: 'prev_scene' });
    });

    // 缩放控制 (放大 / 缩小字号)
    document.getElementById('btnZoomIn').addEventListener('click', () => {
      sendAction({ action: 'zoom', dir: 'in' });
    });
    document.getElementById('btnZoomOut').addEventListener('click', () => {
      sendAction({ action: 'zoom', dir: 'out' });
    });

    // 辅助工具按键
    document.getElementById('btnTheme').addEventListener('click', () => {
      sendAction({ action: 'toggle_theme' });
    });
    document.getElementById('btnFullscreen').addEventListener('click', () => {
      sendAction({ action: 'toggle_fullscreen' });
    });
    document.getElementById('btnToggleToc').addEventListener('click', () => {
      sendAction({ action: 'toggle_toc' });
    });
    document.getElementById('btnScrollTop').addEventListener('click', () => {
      sendAction({ action: 'scroll_top' });
    });
    document.getElementById('btnScrollBottom').addEventListener('click', () => {
      sendAction({ action: 'scroll_bottom' });
    });

    // 虚拟滑板初始化
    initTrackpad();

    // 如果从扫码带了 PIN 且格式正确，自动尝试一次握手
    if (pinInUrl && pinInUrl.length === 8) {
      setTimeout(() => connect(pinInUrl), 300);
    }
  }

  window.addEventListener('DOMContentLoaded', initUI);
})();
