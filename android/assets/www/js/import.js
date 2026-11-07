/* ============================================================
 * App.Import —— 导入聊天记录 / 设定文本，转成人格素材
 * 支持：DeepSeek 导出的 JSON / JSONL、常见「我：/TA：」文本记录
 * ============================================================ */
(function () {
  'use strict';

  var App = window.App = window.App || {};
  var I = {};

  var USER_ROLES = ['user', 'human', 'me', '我', '用户', '提问', 'you'];
  var AI_ROLES = ['assistant', 'ai', 'bot', 'deepseek', 'chatgpt', '助手', '角色', 'ta', '对方', '回答', 'model'];

  function str(v) {
    return v == null ? '' : String(v);
  }

  function extractText(content) {
    if (content == null) return '';
    if (typeof content === 'string') return content;
    if (Object.prototype.toString.call(content) === '[object Array]') {
      var parts = [];
      content.forEach(function (part) {
        if (part == null) return;
        if (typeof part === 'string') { parts.push(part); return; }
        if (typeof part.text === 'string') parts.push(part.text);
        else if (typeof part.content === 'string') parts.push(part.content);
      });
      return parts.join('\n');
    }
    if (typeof content.text === 'string') return content.text;
    if (typeof content.content === 'string') return content.content;
    return '';
  }

  function roleOf(v) {
    var r = str(v).toLowerCase().trim();
    if (USER_ROLES.indexOf(r) >= 0) return 'user';
    if (AI_ROLES.indexOf(r) >= 0) return 'assistant';
    return '';
  }

  function pickMessages(obj) {
    if (!obj || typeof obj !== 'object') return [];
    var lists = ['messages', 'chat_messages', 'chatMessages', 'conversation', 'history', 'items', 'data'];
    for (var i = 0; i < lists.length; i++) {
      var v = obj[lists[i]];
      if (Object.prototype.toString.call(v) === '[object Array]') return v;
      if (v && typeof v === 'object') {
        var nested = pickMessages(v);
        if (nested.length) return nested;
      }
    }
    return [];
  }

  function normalizeEntries(rawList) {
    var out = [];
    (rawList || []).forEach(function (m) {
      if (!m || typeof m !== 'object') return;
      var role = roleOf(m.role || m.sender || m.from || m.type);
      var text = extractText(m.content != null ? m.content : (m.text != null ? m.text : m.message));
      text = str(text).trim();
      if (!role || !text) return;
      if (text.length > 4000) text = text.slice(0, 4000) + '…';
      out.push({ role: role, text: text });
    });
    return out;
  }

  function parseJSONLoose(text) {
    var s = String(text || '').trim();
    if (!s) return null;
    if (App.Util && typeof App.Util.parseJSONLoose === 'function') {
      try { return App.Util.parseJSONLoose(s); } catch (e) { /* fall through */ }
    }
    try { return JSON.parse(s); } catch (e) { return null; }
  }

  function fromText(text) {
    var lines = String(text || '').split(/\r?\n/);
    var entries = [];
    var re = /^\s*[\[<（(]?\s*(我|用户|user|you|human|deepseek|ai|助手|bot|角色|对方|ta|assistant|chatgpt)\s*[\]>）)]?\s*[:：]\s*(.*)$/i;
    lines.forEach(function (line) {
      var m = re.exec(line);
      if (!m) return;
      var role = roleOf(m[1]);
      var body = str(m[2]).trim();
      if (!role || !body) return;
      if (body.length > 4000) body = body.slice(0, 4000) + '…';
      entries.push({ role: role, text: body });
    });
    return entries;
  }

  /** 解析聊天记录文本；返回 {ok, entries, title, format, error} */
  I.parseChat = function (text, filename) {
    var raw = String(text || '').trim();
    if (!raw) return { ok: false, entries: [], error: '文件是空的' };
    var title = String(filename || '').replace(/\.[a-z0-9]+$/i, '');

    // 1) JSON / JSONL
    if (/^[\s\[{]/.test(raw) || /\.(json|jsonl)$/i.test(filename || '')) {
      var data = parseJSONLoose(raw);
      if (data) {
        var list = pickMessages(data);
        if (!list.length && Object.prototype.toString.call(data) === '[object Array]') list = data;
        var entries = normalizeEntries(list);
        if (!entries.length && data && typeof data === 'object') {
          // 有些导出是 {conversations:[{title, messages:[...]}]}
          var convs = data.conversations || data.chats || data.sessions;
          if (Object.prototype.toString.call(convs) === '[object Array]' && convs.length) {
            var conv = convs[0] || {};
            title = str(conv.title || conv.name) || title;
            entries = normalizeEntries(pickMessages(conv));
          }
        }
        if (entries.length >= 2) {
          return { ok: true, entries: entries, title: title, format: 'json' };
        }
      }
    }

    // 2) 纯文本「我：… / TA：…」
    var textEntries = fromText(raw);
    if (textEntries.length >= 2) {
      return { ok: true, entries: textEntries, title: title, format: 'text' };
    }

    return { ok: false, entries: [], error: '没有识别出聊天记录（至少需要一轮对话）' };
  };

  /** 把 entries 转成给模型阅读的 transcript */
  I.transcript = function (entries, opts) {
    opts = opts || {};
    var maxChars = opts.maxChars || 8000;
    var out = '';
    (entries || []).forEach(function (e) {
      var label = e.role === 'user' ? '用户' : '角色';
      var line = label + '：' + e.text + '\n';
      if (out.length + line.length > maxChars) return;
      out += line;
    });
    if (out.length >= maxChars) out = out.slice(0, maxChars) + '…';
    return out.trim();
  };

  /** 本地兜底：当 AI 不可用时，尽可能提取一个可编辑角色卡 */
  I.fallbackCard = function (opts) {
    opts = opts || {};
    var entries = opts.entries || [];
    var raw = str(opts.text || '');
    var aiText = '';
    entries.forEach(function (e) { if (e.role === 'assistant') aiText += e.text + '\n'; });
    var name = str(opts.title || '').trim() || '未命名角色';
    var card = (App.Data && App.Data.blankCharacter) ? App.Data.blankCharacter('companion') : {
      type: 'companion', name: name, personality: '', habits: '', background: '', speechStyle: '',
      catchphrases: '', scenario: '', firstMessage: '', alternateGreetings: [], exampleDialogues: [],
      systemPrompt: '', fieldOrigin: {}, gender: ''
    };
    card.name = name;
    card.background = (aiText || raw).slice(0, 3000);
    var first = '';
    entries.forEach(function (e) {
      if (!first && e.role === 'assistant') first = e.text.split(/\n/)[0].slice(0, 120);
    });
    if (first) card.firstMessage = first;
    card.fieldOrigin = card.fieldOrigin || {};
    card.fieldOrigin.background = 'user';
    return card;
  };

  /**
   * 长截图兜底切片：浏览器 / 原生未切片时，用 canvas 按宽度切条带。
   * 返回 Promise<string[]>（每段 data:image/jpeg;base64）。
   */
  I.sliceImage = function (dataUri, opts) {
    opts = opts || {};
    var maxW = Math.max(360, Math.min(1400, opts.maxWidth || 1100));
    var ratio = Math.max(1.4, Math.min(2.4, opts.ratio || 2));
    var overlapRatio = Math.max(0, Math.min(0.2, opts.overlap || 0.1));
    var maxSlices = Math.max(1, Math.min(8, opts.maxSlices || 6));
    var quality = Math.max(0.6, Math.min(0.95, opts.quality || 0.9));
    return new Promise(function (resolve, reject) {
      var img = new Image();
      img.onload = function () {
        try {
          var sw = img.naturalWidth || img.width;
          var sh = img.naturalHeight || img.height;
          if (!sw || !sh) return reject(new Error('图片尺寸异常'));
          var outW = Math.min(sw, maxW);
          var scale = outW / sw;
          var outH = Math.round(sh * scale);
          // 不需要切：整张图不超过 2.2 张屏高
          if (outH <= outW * 2.2 && outH <= 4000) {
            var cv0 = document.createElement('canvas');
            cv0.width = outW; cv0.height = outH;
            var c0 = cv0.getContext('2d');
            c0.fillStyle = '#ffffff'; c0.fillRect(0, 0, outW, outH);
            c0.drawImage(img, 0, 0, outW, outH);
            return resolve([cv0.toDataURL('image/jpeg', quality)]);
          }
          var sliceH = Math.round(outW * ratio);
          var overlap = Math.round(sliceH * overlapRatio);
          var step = Math.max(1, sliceH - overlap);
          var n = Math.min(maxSlices, Math.max(1, Math.ceil((outH - overlap) / step)));
          // 段数被上限截断时，增大每段高度，保证覆盖完整
          if (n === maxSlices) sliceH = Math.ceil((outH + overlap * (n - 1)) / n);
          step = Math.max(1, sliceH - overlap);
          var out = [];
          var y = 0;
          for (var i = 0; i < n && y < outH; i++) {
            var h = Math.min(sliceH, outH - y);
            if (h <= 0) break;
            var cv = document.createElement('canvas');
            cv.width = outW; cv.height = h;
            var ctx = cv.getContext('2d');
            ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, outW, h);
            ctx.drawImage(img, 0, y, outW, h, 0, 0, outW, h);
            out.push(cv.toDataURL('image/jpeg', quality));
            y += step;
            if (i === n - 1) break;
          }
          resolve(out.length ? out : [dataUri]);
        } catch (e) { reject(e); }
      };
      img.onerror = function () { reject(new Error('图片加载失败')); };
      img.src = dataUri;
    });
  };

  I.roleOf = roleOf;
  App.Import = I;
})();
