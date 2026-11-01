/* util.js —— 通用工具，挂到 window.App.Util */
(function () {
  'use strict';
  var App = window.App = window.App || {};
  var U = App.Util = {};

  /* ---------------- 字符串 / 转义 ---------------- */
  var ESC_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  U.esc = function (s) {
    if (s === null || s === undefined) return '';
    return String(s).replace(/[&<>"']/g, function (c) { return ESC_MAP[c]; });
  };
  // 保留换行的转义（聊天气泡/预览用）
  U.escLines = function (s) {
    return U.esc(s).replace(/\r\n/g, '\n');
  };
  U.hasChinese = function (s) { return /[\u4e00-\u9fa5]/.test(String(s || '')); };

  /* ---------------- id / 时间 ---------------- */
  var seq = 0;
  U.uid = function (prefix) {
    seq = (seq + 1) % 100000;
    return (prefix || 'id') + '_' + Date.now().toString(36) + '_' + seq.toString(36) + Math.random().toString(36).slice(2, 6);
  };
  U.now = function () { return Date.now(); };

  function pad2(n) { return n < 10 ? '0' + n : '' + n; }
  function d2(ts) {
    var d = new Date(ts);
    return { y: d.getFullYear(), m: d.getMonth() + 1, d: d.getDate(), hh: pad2(d.getHours()), mm: pad2(d.getMinutes()) };
  }
  U.fmtTime = function (ts) {
    if (!ts) return '';
    var d = new Date(ts), n = new Date();
    var sameDay = d.getFullYear() === n.getFullYear() && d.getMonth() === n.getMonth() && d.getDate() === n.getDate();
    if (sameDay) return pad2(d.getHours()) + ':' + pad2(d.getMinutes());
    var y = new Date(n.getTime() - 86400000);
    if (d.getFullYear() === y.getFullYear() && d.getMonth() === y.getMonth() && d.getDate() === y.getDate()) return '昨天';
    if (d.getFullYear() === n.getFullYear()) return (d.getMonth() + 1) + '-' + d.getDate();
    return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
  };
  U.fmtDateTime = function (ts) {
    if (!ts) return '';
    var t = d2(ts);
    return t.y + '-' + pad2(t.m) + '-' + pad2(t.d) + ' ' + t.hh + ':' + t.mm;
  };

  /* ---------------- 数值 / 杂项 ---------------- */
  U.clamp = function (v, min, max) { v = Number(v); if (isNaN(v)) v = min; return Math.min(max, Math.max(min, v)); };
  U.sleep = function (ms) { return new Promise(function (r) { setTimeout(r, ms || 0); }); };
  U.debounce = function (fn, wait) {
    var t = null;
    return function () {
      var ctx = this, args = arguments;
      clearTimeout(t);
      t = setTimeout(function () { fn.apply(ctx, args); }, wait || 200);
    };
  };
  U.throttle = function (fn, wait) {
    var last = 0, t = null;
    return function () {
      var ctx = this, args = arguments, now = Date.now(), left = (wait || 100) - (now - last);
      if (left <= 0) { last = now; fn.apply(ctx, args); }
      else if (!t) { t = setTimeout(function () { t = null; last = Date.now(); fn.apply(ctx, args); }, left); }
    };
  };
  U.pct = function (v) { return Math.round(U.clamp(v, 0, 1) * 100) + '%'; };
  U.fmtTokens = function (n) { n = Number(n) || 0; return n >= 1000 ? (n / 1000).toFixed(1) + 'k' : String(n); };
  U.initial = function (name) {
    var s = String(name || '').trim();
    if (!s) return '?';
    if (/^[\u4e00-\u9fa5]/.test(s)) return s.slice(0, 1);
    if (/^[A-Za-z]/.test(s)) return s.slice(0, 1).toUpperCase();
    return s.slice(0, 1);
  };
  U.deepClone = function (v) {
    if (v === null || typeof v !== 'object') return v;
    try { return JSON.parse(JSON.stringify(v)); } catch (e) { return v; }
  };
  U.bytes = function (n) {
    n = Number(n) || 0;
    if (n < 1024) return n + ' B';
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
    return (n / 1024 / 1024).toFixed(1) + ' MB';
  };
  U.escapeRegExp = function (s) { return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); };

  /* ---------------- JSON 宽松解析 ---------------- */
  // 剥 ```json 围栏 → 找首个 { 到最后一个 } → 修复尾逗号 → JSON.parse；失败返回 null
  U.parseJSONLoose = function (text) {
    if (text === null || text === undefined) return null;
    if (typeof text === 'object') return text;
    var s = String(text).trim();
    if (!s) return null;
    var fence = s.match(/```(?:json|JSON)?\s*([\s\S]*?)```/);
    if (fence && fence[1]) s = fence[1].trim();
    var first = s.search(/[\[{]/);
    if (first > 0) s = s.slice(first);
    var lastCurly = s.lastIndexOf('}');
    var lastSquare = s.lastIndexOf(']');
    var last = Math.max(lastCurly, lastSquare);
    if (last >= 0) s = s.slice(0, last + 1);
    var attempts = [s, s.replace(/,\s*([}\]])/g, '$1'), s.replace(/,\s*([}\]])/g, '$1').replace(/([{,]\s*)([A-Za-z_$][\w$]*)\s*:/g, '$1"$2":')];
    for (var i = 0; i < attempts.length; i++) {
      try { return JSON.parse(attempts[i]); } catch (e) { /* 继续尝试 */ }
    }
    return null;
  };

  /* ---------------- token 估算 ---------------- */
  // 粗略：ASCII 4 字符≈1 token；中日韩 1 字符≈1 token
  U.estimateTokens = function (text) {
    var s = String(text || '');
    if (!s) return 0;
    var cjk = 0, other = 0;
    for (var i = 0; i < s.length; i++) {
      var c = s.charCodeAt(i);
      if (c > 0x2e80) cjk++; else other++;
    }
    return Math.ceil(cjk * 1.05 + other / 3.6);
  };

  /* ---------------- 剪贴板 ---------------- */
  U.copyText = function (text) {
    var s = String(text === undefined || text === null ? '' : text);
    function fallback() {
      return new Promise(function (resolve) {
        try {
          var ta = document.createElement('textarea');
          ta.value = s;
          ta.setAttribute('readonly', 'readonly');
          ta.style.position = 'fixed';
          ta.style.left = '-9999px';
          ta.style.top = '0';
          document.body.appendChild(ta);
          ta.select();
          ta.setSelectionRange(0, s.length);
          var ok = false;
          try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
          document.body.removeChild(ta);
          resolve(ok);
        } catch (e) { resolve(false); }
      });
    }
    if (App.Bridge && App.Bridge.available && App.Bridge.call) {
      return App.Bridge.call('ui.copy', { text: s }).then(function (r) {
        return !!(r && (r.ok || r.copied || r.value === undefined));
      }).catch(fallback);
    }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      return navigator.clipboard.writeText(s).then(function () { return true; }).catch(fallback);
    }
    return fallback();
  };

  /* ---------------- 文本处理 ---------------- */
  // 截断（按字符数，中文友好）
  U.truncate = function (s, n) {
    s = String(s || '');
    return s.length > n ? s.slice(0, n) + '…' : s;
  };
  // 把纯文本转为安全 HTML：转义 + 换行 + 简单代码块
  U.textToHtml = function (text) {
    var s = U.esc(text).replace(/\r\n/g, '\n');
    s = s.replace(/```[a-zA-Z0-9_+-]*\n?([\s\S]*?)```/g, function (m, code) {
      return '\u0000CODE\u0000' + code.replace(/\n$/, '') + '\u0001';
    });
    s = s.replace(/\n/g, '<br>');
    s = s.replace(/\u0000CODE\u0000([\s\S]*?)\u0001/g, function (m, code) {
      return '<pre class="msg-code">' + code + '</pre>';
    });
    return s;
  };
  // 取文本首行作为标题
  U.firstLine = function (s, max) {
    var t = String(s || '').replace(/\s+/g, ' ').trim();
    return U.truncate(t, max || 40);
  };

  /* ---------------- DOM 小助手 ---------------- */
  U.qs = function (sel, root) { return (root || document).querySelector(sel); };
  U.qsa = function (sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); };
  U.on = function (el, evt, fn, opts) { if (el) el.addEventListener(evt, fn, opts); return el; };
  U.off = function (el, evt, fn) { if (el) el.removeEventListener(evt, fn); };
  U.raf = function (fn) { return (window.requestAnimationFrame || function (f) { return setTimeout(f, 16); })(fn); };

  /* ---------------- 表单校验 ---------------- */
  U.isUrl = function (s) { return /^https?:\/\/[^\s]+$/i.test(String(s || '').trim()); };
  U.normalizeBaseUrl = function (s) {
    var t = String(s || '').trim().replace(/\s+/g, '');
    if (!t) return '';
    t = t.replace(/\/+$/, '');
    if (/\/chat\/completions$/i.test(t)) t = t.replace(/\/chat\/completions$/i, '');
    return t;
  };

  /* ---------------- 排序：中文友好 ---------------- */
  U.cmpText = function (a, b) {
    return String(a || '').localeCompare(String(b || ''), 'zh-Hans-CN');
  };
})();
