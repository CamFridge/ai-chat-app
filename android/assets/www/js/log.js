/* ============================================================
   运行日志（App.Log）
   ------------------------------------------------------------
   - 在内存里保留最近 300 条，并持久化最近 150 条到 localStorage，
     便于用户重启后仍能复制日志反馈问题。
   - 自动捕获 console.warn / console.error、未捕获异常、
     unhandledrejection；其它模块可用 App.Log.info/warn/error 主动记录。
   - 日志只存本地，不会上传；设置页「运行日志」可查看、复制、清空。
   ============================================================ */
(function () {
  'use strict';
  var App = window.App = window.App || {};

  var MAX_MEM = 300;
  var MAX_STORE = 150;
  var STORE_KEY = 'aichat.logs.v1';

  var entries = [];
  var installed = false;

  function safeStr(v, max) {
    var s;
    try {
      if (typeof v === 'string') s = v;
      else if (v instanceof Error) s = (v.stack || v.message || String(v));
      else if (v === undefined) s = '';
      else if (v === null) s = 'null';
      else if (typeof v === 'object') {
        try { s = JSON.stringify(v); } catch (e) { s = String(v); }
      } else s = String(v);
    } catch (e) {
      s = '[无法序列化]';
    }
    if (typeof max === 'number' && s.length > max) s = s.slice(0, max) + '…';
    return s;
  }

  function pad2(n) { return (n < 10 ? '0' : '') + n; }

  function fmtTime(ts) {
    var d = new Date(ts || Date.now());
    return pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()) + ' ' +
      pad2(d.getHours()) + ':' + pad2(d.getMinutes()) + ':' + pad2(d.getSeconds());
  }

  function loadStored() {
    try {
      var raw = window.localStorage.getItem(STORE_KEY);
      if (!raw) return;
      var arr = JSON.parse(raw);
      if (!Array.isArray(arr)) return;
      entries = arr.filter(function (e) { return e && e.t && e.msg; }).slice(-MAX_STORE);
    } catch (e) { /* 忽略损坏的本地日志 */ }
  }

  function persist() {
    try {
      window.localStorage.setItem(STORE_KEY, JSON.stringify(entries.slice(-MAX_STORE)));
    } catch (e) { /* 存储满时忽略 */ }
  }

  function add(level, msg, extra) {
    var text = safeStr(msg, 4000);
    var ex = extra === undefined ? '' : safeStr(extra, 4000);
    var entry = { t: Date.now(), lv: level || 'info', msg: text };
    if (ex) entry.ex = ex;
    entries.push(entry);
    if (entries.length > MAX_MEM) entries = entries.slice(-MAX_MEM);
    persist();
    return entry;
  }

  function hookConsole() {
    if (installed || !window.console) return;
    installed = true;
    var origWarn = window.console.warn;
    var origError = window.console.error;
    window.console.warn = function () {
      try { add('warn', Array.prototype.map.call(arguments, function (a) { return safeStr(a, 1000); }).join(' ')); } catch (e) {}
      if (origWarn) origWarn.apply(window.console, arguments);
    };
    window.console.error = function () {
      try { add('error', Array.prototype.map.call(arguments, function (a) { return safeStr(a, 2000); }).join(' ')); } catch (e) {}
      if (origError) origError.apply(window.console, arguments);
    };
    window.addEventListener('error', function (ev) {
      try {
        if (ev && ev.message) add('error', ev.message, (ev.filename || '') + ':' + (ev.lineno || 0));
      } catch (e) {}
    });
    window.addEventListener('unhandledrejection', function (ev) {
      try {
        var r = ev && ev.reason;
        add('error', 'unhandledrejection: ' + safeStr(r, 1500));
      } catch (e) {}
    });
  }

  function text() {
    if (!entries.length) return '（暂无日志）';
    var lines = entries.map(function (e) {
      var line = fmtTime(e.t) + ' [' + e.lv + '] ' + e.msg;
      if (e.ex) line += '  ' + e.ex;
      return line;
    });
    lines.push('');
    lines.push('设备：' + (App.Bridge && App.Bridge.available ? 'Android App' : '浏览器预览'));
    try {
      if (App.Bridge && App.Bridge.available && typeof App.Bridge.call === 'function') {
        App.Bridge.call('app.info', {}, { timeoutMs: 1500 }).then(function (info) {
          try { window.localStorage.setItem('aichat.logs.lastInfo', JSON.stringify(info || {})); } catch (e) {}
        }).catch(function () {});
      }
    } catch (e) {}
    return lines.join('\n');
  }

  App.Log = {
    MAX: MAX_MEM,
    add: add,
    info: function (msg, extra) { return add('info', msg, extra); },
    warn: function (msg, extra) { return add('warn', msg, extra); },
    error: function (msg, extra) { return add('error', msg, extra); },
    list: function () { return entries.slice(); },
    count: function () { return entries.length; },
    clear: function () {
      entries = [];
      try { window.localStorage.removeItem(STORE_KEY); } catch (e) {}
    },
    text: text,
    fmtTime: fmtTime,
    hookConsole: hookConsole
  };

  loadStored();
  hookConsole();
})();
