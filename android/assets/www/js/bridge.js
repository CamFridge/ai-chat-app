/* bridge.js —— 原生桥（window.AndroidBridge）封装；浏览器下自动降级为 mock，便于调试/截图 */
(function () {
  'use strict';
  var App = window.App = window.App || {};
  var Bridge = App.Bridge = {};

  var native = window.AndroidBridge;
  Bridge.available = !!(native && typeof native.call === 'function');

  var seq = 0;
  var pendingCalls = Object.create(null);   // id -> {resolve, reject, timer}
  var pendingStreams = Object.create(null); // id -> {onEvent, resolveDone, timer}

  function nextId(prefix) {
    seq += 1;
    return prefix + Date.now().toString(36) + seq.toString(36);
  }

  function parseMaybe(raw) {
    if (raw === null || raw === undefined || raw === '') return null;
    if (typeof raw === 'object') return raw;
    try { return JSON.parse(raw); } catch (e) { return null; }
  }

  /* ---------------- 原生回调入口 ---------------- */
  window.__nativeResult = function (id, ok, json) {
    var item = pendingCalls[id];
    if (!item) return;
    delete pendingCalls[id];
    if (item.timer) clearTimeout(item.timer);
    var data = parseMaybe(json);
    if (ok) item.resolve(data);
    else item.reject(data || { code: 'unknown', message: '原生调用失败' });
  };

  window.__nativeEvent = function (id, json) {
    var item = pendingStreams[id];
    if (!item) return;
    var ev = parseMaybe(json) || {};
    if (item.timer) { clearTimeout(item.timer); item.timer = null; }
    try { item.onEvent(ev); } catch (e) { console.error('[bridge] 事件回调出错', e); }
    if (ev.type === 'done') {
      delete pendingStreams[id];
      item.resolveDone({ ok: true, usage: ev.usage || null });
    } else if (ev.type === 'error') {
      delete pendingStreams[id];
      item.resolveDone({ ok: false, error: ev.error || { code: 'stream', message: '流式传输中断' } });
    }
  };

  /* ---------------- 原生调用 ---------------- */
  Bridge.call = function (method, args, opts) {
    opts = opts || {};
    if (!Bridge.available) return mockCall(method, args, opts);
    var id = nextId('c');
    var timeout = opts.timeoutMs || 60000;
    return new Promise(function (resolve, reject) {
      pendingCalls[id] = {
        resolve: resolve,
        reject: reject,
        timer: setTimeout(function () {
          if (pendingCalls[id]) {
            delete pendingCalls[id];
            reject({ code: 'timeout', message: '原生调用超时：' + method });
          }
        }, timeout)
      };
      try {
        native.call(id, method, JSON.stringify(args || {}));
      } catch (e) {
        delete pendingCalls[id];
        reject({ code: 'unknown', message: '原生桥调用异常：' + (e && e.message ? e.message : e) });
      }
    });
  };

  /* ---------------- 流式 ---------------- */
  Bridge.stream = function (args, onEvent) {
    if (!Bridge.available) return mockStream(args, onEvent);
    var id = nextId('s');
    var resolveDone;
    var donePromise = new Promise(function (res) { resolveDone = res; });
    var finished = false;
    var handle = {
      id: id,
      done: donePromise,
      abort: function () {
        if (finished) return;
        finished = true;
        var item = pendingStreams[id];
        if (item) {
          if (item.timer) clearTimeout(item.timer);
          delete pendingStreams[id];
        }
        try { Bridge.call('net.abort', { id: id }).catch(function () {}); } catch (e) {}
        resolveDone({ ok: false, error: { code: 'cancel', message: '已取消' } });
      }
    };
    pendingStreams[id] = {
      onEvent: function (ev) {
        if (finished) return;
        if (ev.type === 'done') finished = true;
        if (ev.type === 'error') finished = true;
        onEvent(ev);
      },
      resolveDone: function (r) { finished = true; resolveDone(r); return r; },
      timer: setTimeout(function () {
        if (pendingStreams[id] && !finished) {
          handle.abort();
          onEvent({ type: 'error', error: { code: 'timeout', message: '生成超时' } });
        }
      }, (args && args.timeoutMs ? args.timeoutMs : 180000) + 15000)
    };
    try {
      native.call(id, 'net.stream', JSON.stringify(args || {}));
    } catch (e) {
      delete pendingStreams[id];
      finished = true;
      setTimeout(function () {
        onEvent({ type: 'error', error: { code: 'unknown', message: '原生桥调用异常' } });
      }, 0);
      resolveDone({ ok: false, error: { code: 'unknown', message: '原生桥调用异常' } });
    }
    return handle;
  };

  /* ==================================================================
     浏览器 mock：不发真实请求，返回可预测的假数据，用于无头截图/调试
     ================================================================== */
  var LS_PREFIX = 'aichat.sec.';

  function secGet(key) {
    try { return localStorage.getItem(LS_PREFIX + key) || ''; } catch (e) { return ''; }
  }
  function secSet(key, value) {
    try { localStorage.setItem(LS_PREFIX + key, value === undefined || value === null ? '' : String(value)); return true; } catch (e) { return false; }
  }
  function secDel(key) { try { localStorage.removeItem(LS_PREFIX + key); return true; } catch (e) { return false; } }

  var MOCK_MODELS = ['gpt-4o-mini', 'gpt-4o', 'deepseek-chat', 'deepseek-reasoner', 'claude-3-5-sonnet', 'qwen-max'];

  function mockReply(prompt) {
    var p = String(prompt || '').slice(-80);
    return '（本机演示模式）我收到你的消息了：「' + (p || '你好') + '」。\n\n这是浏览器预览下的模拟回复：在 Android APK 中，这里会通过你配置的远程 API 流式生成真实内容。\n\n可以试着打开「设置 → 使用帮助」看看引导助手，或长按底部绿色小球试试「怎么走」。';
  }

  function mockCall(method, args, opts) {
    args = args || {};
    return new Promise(function (resolve, reject) {
      var delay = 60 + Math.random() * 120;
      setTimeout(function () {
        try {
          switch (method) {
            case 'net.test': {
              var base = String(args.baseUrl || '');
              if (!/^https?:\/\//i.test(base)) { resolve({ ok: false, models: [], error: { code: 'nobase', message: '缺少或非法的 Base URL' } }); return; }
              if (!args.apiKey || String(args.apiKey).length < 6) { resolve({ ok: false, models: [], error: { code: '401', message: 'Unauthorized：Key 看起来不完整' } }); return; }
              if (/limit|rate/i.test(String(args.apiKey))) { resolve({ ok: false, models: [], error: { code: '429', message: 'Rate limit exceeded' } }); return; }
              resolve({ ok: true, status: 200, models: MOCK_MODELS.slice() });
              return;
            }
            case 'net.models':
              resolve({ ok: true, models: MOCK_MODELS.slice() });
              return;
            case 'net.chat': {
              var last = (args.messages || []).filter(function (m) { return m.role === 'user'; }).pop();
              resolve({ ok: true, text: mockReply(last && last.content), usage: { prompt_tokens: 32, completion_tokens: 96, total_tokens: 128 } });
              return;
            }
            case 'net.abort':
              resolve({ ok: true });
              return;
            case 'secure.set':
              resolve({ ok: secSet(args.key, args.value) });
              return;
            case 'secure.get':
              resolve({ value: secGet(args.key) });
              return;
            case 'secure.del':
              resolve({ ok: secDel(args.key) });
              return;
            case 'ui.toast':
              if (App.UI && App.UI.toast) App.UI.toast(args.text || '', args.type);
              resolve({ ok: true });
              return;
            case 'ui.copy':
              if (navigator.clipboard && navigator.clipboard.writeText) {
                navigator.clipboard.writeText(String(args.text || '')).then(function () { resolve({ ok: true }); }, function () { resolve({ ok: false }); });
              } else { resolve({ ok: false }); }
              return;
            case 'ui.pickImage': {
              pickImageMock().then(function (r) { resolve(r); }, function () { resolve({ dataUri: '', name: '' }); });
              return;
            }
            case 'ui.statusBar':
              resolve({ ok: true });
              return;
            case 'ui.vibrate':
              try { if (navigator.vibrate) navigator.vibrate(Number(args.ms) || 15); } catch (e) {}
              resolve({ ok: true });
              return;
            case 'file.export': {
              var blob = new Blob([String(args.data || '')], { type: args.mime || 'application/json' });
              var url = URL.createObjectURL(blob);
              var a = document.createElement('a');
              a.href = url;
              a.download = args.name || 'export.json';
              document.body.appendChild(a);
              a.click();
              setTimeout(function () { document.body.removeChild(a); URL.revokeObjectURL(url); }, 500);
              resolve({ ok: true });
              return;
            }
            case 'file.import': {
              pickFileMock(args.accept).then(function (r) { resolve(r); }, function () { resolve({ name: '', data: '' }); });
              return;
            }
            case 'app.info':
              resolve({ version: '1.0.0-demo', platform: 'web', apiLevel: 0 });
              return;
            case 'app.setBackGuard':
              resolve({ ok: true });
              return;
            default:
              resolve({ ok: true });
          }
        } catch (e) {
          reject({ code: 'unknown', message: 'mock 调用异常：' + (e && e.message) });
        }
      }, delay);
    });
  }

  function pickFileMock(accept) {
    // 测试钩子：E2E 里设置 window.__AICHAT_MOCK_FILE__ = {name,data} 可跳过系统文件选择框
    var hook = window.__AICHAT_MOCK_FILE__;
    if (hook !== undefined) {
      return Promise.resolve(typeof hook === 'function' ? hook() : (hook || { name: '', data: '' }));
    }
    return new Promise(function (resolve) {
      var input = document.createElement('input');
      input.type = 'file';
      if (accept) input.accept = accept;
      input.style.display = 'none';
      document.body.appendChild(input);
      input.onchange = function () {
        var f = input.files && input.files[0];
        if (!f) { document.body.removeChild(input); resolve({ name: '', data: '' }); return; }
        var reader = new FileReader();
        reader.onload = function () {
          document.body.removeChild(input);
          resolve({ name: f.name || '', data: String(reader.result || '') });
        };
        reader.onerror = function () { document.body.removeChild(input); resolve({ name: f.name || '', data: '' }); };
        reader.readAsText(f);
      };
      input.click();
    });
  }

  function pickImageMock() {
    // 测试钩子：E2E 里设置 window.__AICHAT_MOCK_IMAGE__ = {dataUri,name} 可跳过系统相册
    var hook = window.__AICHAT_MOCK_IMAGE__;
    if (hook !== undefined) {
      return Promise.resolve(typeof hook === 'function' ? hook() : (hook || { dataUri: '', name: '' }));
    }
    return new Promise(function (resolve) {
      var input = document.createElement('input');
      input.type = 'file';
      input.accept = 'image/*';
      input.style.display = 'none';
      document.body.appendChild(input);
      input.onchange = function () {
        var f = input.files && input.files[0];
        if (!f) { document.body.removeChild(input); resolve({ dataUri: '', name: '' }); return; }
        var reader = new FileReader();
        reader.onload = function () {
          document.body.removeChild(input);
          resolve({ dataUri: String(reader.result || ''), name: f.name || '' });
        };
        reader.onerror = function () { document.body.removeChild(input); resolve({ dataUri: '', name: '' }); };
        reader.readAsDataURL(f);
      };
      input.click();
    });
  }

  var MOCK_STREAM_TEXT = [
    '好呀，我在呢。', '\n\n', '从你这句话里，我能感觉到你想找个人说说话。',
    '如果愿意，可以再讲讲今天发生了什么——', '开心的、烦的、无聊的都可以。',
    '我会认真听着，不打断你。'
  ];

  function mockStream(args, onEvent) {
    var finished = false;
    var idx = 0;
    var timer = null;
    var resolveDone;
    var donePromise = new Promise(function (res) { resolveDone = res; });
    var lastUser = '';
    (args && args.messages ? args.messages : []).forEach(function (m) { if (m.role === 'user') lastUser = m.content; });
    var text = '（演示模式）我听到你说「' + String(lastUser || '').slice(0, 60) + '」了。\n\n' + MOCK_STREAM_TEXT.join('');

    function tick() {
      if (finished) return;
      if (idx >= text.length) {
        finished = true;
        onEvent({ type: 'done', usage: { prompt_tokens: 40, completion_tokens: Math.ceil(text.length / 2), total_tokens: 40 + Math.ceil(text.length / 2) } });
        resolveDone({ ok: true, usage: { prompt_tokens: 40, completion_tokens: Math.ceil(text.length / 2), total_tokens: 40 + Math.ceil(text.length / 2) } });
        return;
      }
      var step = 1 + Math.floor(Math.random() * 2);
      var piece = text.slice(idx, idx + step);
      idx += step;
      onEvent({ type: 'delta', text: piece });
      timer = setTimeout(tick, 18 + Math.random() * 30);
    }
    timer = setTimeout(tick, 260);

    return {
      id: 'mock',
      done: donePromise,
      abort: function () {
        if (finished) return;
        finished = true;
        if (timer) clearTimeout(timer);
        resolveDone({ ok: false, error: { code: 'cancel', message: '已取消' } });
      }
    };
  }

  Bridge.mockMode = !Bridge.available;
})();
