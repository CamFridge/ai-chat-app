/* chat-list.js —— 聊天列表页（Tab 首屏），并定义 App.ChatKit 供 chat.js / preset-edit.js 复用
   依赖：App.Util(App.Util)、App.DB、App.UI、App.Router（均在页面脚本之前加载） */
(function () {
  'use strict';
  var App = window.App = window.App || {};
  var U = App.Util;
  var D = App.DB;

  /* =========================================================================
     一、App.ChatKit —— 聊天相关公共工具（本文件加载最早，供后两个页面使用）
     ========================================================================= */
  var K = App.ChatKit = App.ChatKit || {};

  K.PAGE_SIZE = 40;          // 聊天页初始渲染条数
  K.OLDER_PAGE_SIZE = 30;    // 上滑每次加载更早的条数
  K.TOKEN_BUDGET = 3000;     // 上下文历史 token 预算（system 不计入裁剪）
  K.generating = Object.create(null); // 内存态生成标记：sessionId -> true

  /* ---------------- 生成中标记 ---------------- */
  K.isGenerating = function (sessionId) { return !!K.generating[sessionId]; };
  K.setGenerating = function (sessionId, on) {
    if (!sessionId) return;
    if (on) K.generating[sessionId] = true; else delete K.generating[sessionId];
    // 同步持久化到会话上，聊天列表可展示「生成中…」；异常退出由列表清理
    D.get('sessions', sessionId).then(function (s) {
      if (!s) return null;
      if (!!s.isGenerating === !!on) return null;
      s.isGenerating = !!on;
      return D.put('sessions', s);
    }).catch(function () { /* 静默：标记失败不影响聊天 */ });
  };

  /* ---------------- 预设兜底 ---------------- */
  // C 的 data/presets.js 未就绪时的兜底内置预设（只读）
  var FALLBACK_PRESETS = [
    {
      id: 'builtin_companion', name: '陪聊 · 默认', isBuiltin: true, mode: 'chat', appliesTo: 'companion',
      instructTemplate: '你是用户的陪伴型聊天角色。请始终以角色口吻自然聊天，保持性格与记忆一致；回复生活化、有情绪，不要写成小说旁白或分析报告。',
      params: { temperature: 0.9, top_p: 0.95, top_k: 0, max_tokens: 1024, presence_penalty: 0.3, frequency_penalty: 0.3, stop: [] }
    },
    {
      id: 'builtin_assistant', name: '助手 · 默认', isBuiltin: true, mode: 'chat', appliesTo: 'assistant',
      instructTemplate: '你是一位严谨、务实的助手。先给结论，再给必要的步骤；信息不足时先问清关键点；不确定的内容要明确说明不确定。',
      params: { temperature: 0.3, top_p: 0.9, top_k: 0, max_tokens: 1536, presence_penalty: 0, frequency_penalty: 0, stop: [] }
    }
  ];
  K.FALLBACK_PRESETS = FALLBACK_PRESETS;
  K.DEFAULT_PARAMS = { temperature: 0.8, top_p: 0.95, top_k: 0, max_tokens: 1024, presence_penalty: 0, frequency_penalty: 0, stop: [] };

  // 读取内置预设（兼容数组/对象两种形态，缺失则兜底）
  K.builtinPresets = function () {
    var list = App.Data && App.Data.BUILTIN_PRESETS;
    if (!list) return FALLBACK_PRESETS.slice();
    if (Array.isArray(list)) return list.length ? list : FALLBACK_PRESETS.slice();
    if (typeof list === 'object') {
      var arr = [];
      Object.keys(list).forEach(function (key) {
        var v = list[key];
        if (v && typeof v === 'object') {
          if (!v.id) v.id = key;
          arr.push(v);
        }
      });
      return arr.length ? arr : FALLBACK_PRESETS.slice();
    }
    return FALLBACK_PRESETS.slice();
  };
  K.defaultPresetFor = function (characterType) {
    var targets = characterType === 'assistant' ? ['assistant', 'both'] : ['companion', 'both'];
    var list = K.builtinPresets();
    for (var i = 0; i < list.length; i++) {
      if (targets.indexOf(list[i].appliesTo) >= 0) return list[i];
    }
    return list[0] || null;
  };
  // 归一化预设参数（补齐默认值、stop 统一为数组）
  K.paramsOf = function (preset) {
    var src = (preset && preset.params) || {};
    var out = {};
    Object.keys(K.DEFAULT_PARAMS).forEach(function (key) {
      var v = src[key];
      if (key === 'stop') {
        if (Array.isArray(v)) out.stop = v.filter(Boolean).slice(0, 4);
        else if (typeof v === 'string') out.stop = v.split(/[,，]/).map(function (t) { return t.trim(); }).filter(Boolean).slice(0, 4);
        else out.stop = [];
      } else {
        v = Number(v);
        out[key] = isNaN(v) ? K.DEFAULT_PARAMS[key] : v;
      }
    });
    return out;
  };

  /* ---------------- 安全 Markdown 最小渲染（转义优先，禁止裸 innerHTML 用户内容） ---------------- */
  function inlineMd(raw) {
    var s = U.esc(raw);
    var out = '';
    var i = 0;
    var len = s.length;
    while (i < len) {
      var ch = s.charAt(i);
      if (ch === '`') {
        var end = s.indexOf('`', i + 1);
        if (end > i + 1) {
          out += '<code class="inline">' + s.slice(i + 1, end) + '</code>';
          i = end + 1;
          continue;
        }
      }
      if (ch === '*' && s.charAt(i + 1) === '*') {
        var end2 = s.indexOf('**', i + 2);
        if (end2 > i + 2) {
          out += '<strong>' + s.slice(i + 2, end2) + '</strong>';
          i = end2 + 2;
          continue;
        }
      }
      // 单星号斜体：*动作/神态* → <em class="md-action">（在 **加粗** 之后匹配；未闭合不转换）
      if (ch === '*' && s.charAt(i + 1) !== '*') {
        var endIt = -1;
        for (var k = i + 1; k < len; k++) {
          if (s.charAt(k) !== '*') continue;
          // 跳过 ** 的一部分，避免把 *a** 误判
          if (s.charAt(k - 1) === '*' || s.charAt(k + 1) === '*') continue;
          endIt = k;
          break;
        }
        if (endIt > i + 1 && s.slice(i + 1, endIt).trim()) {
          out += '<em class="md-action">' + s.slice(i + 1, endIt) + '</em>';
          i = endIt + 1;
          continue;
        }
      }
      out += ch;
      i += 1;
    }
    return out;
  }
  K.md = function (text) {
    var src = String(text === undefined || text === null ? '' : text).replace(/\r\n?/g, '\n');
    var lines = src.split('\n');
    var out = [];
    var i = 0;
    while (i < lines.length) {
      var line = lines[i];
      // 代码块
      var fence = /^\s*```\s*([A-Za-z0-9_+\-]*)\s*$/.exec(line);
      if (fence) {
        var code = [];
        i += 1;
        while (i < lines.length && !/^\s*```\s*$/.test(lines[i])) {
          code.push(lines[i]);
          i += 1;
        }
        if (i < lines.length) i += 1; // 跳过结束围栏
        out.push('<pre class="msg-code">' + U.esc(code.join('\n')) + '</pre>');
        continue;
      }
      // 无序列表
      var m = /^\s*[-*+]\s+(.*)$/.exec(line);
      if (m) {
        var uls = [];
        while (i < lines.length && (m = /^\s*[-*+]\s+(.*)$/.exec(lines[i]))) {
          uls.push('<li>' + inlineMd(m[1]) + '</li>');
          i += 1;
        }
        out.push('<ul class="md-ul">' + uls.join('') + '</ul>');
        continue;
      }
      // 有序列表
      m = /^\s*\d+[.)、]\s*(.*)$/.exec(line);
      if (m) {
        var ols = [];
        while (i < lines.length && (m = /^\s*\d+[.)、]\s*(.*)$/.exec(lines[i]))) {
          ols.push('<li>' + inlineMd(m[1]) + '</li>');
          i += 1;
        }
        out.push('<ol class="md-ol">' + ols.join('') + '</ol>');
        continue;
      }
      // 空行
      if (!line.trim()) {
        out.push('<div class="md-blank"></div>');
        i += 1;
        continue;
      }
      out.push('<div class="md-line">' + inlineMd(line) + '</div>');
      i += 1;
    }
    return out.join('');
  };

  /* ---------------- 基础小工具 ---------------- */
  K.typeLabel = function (type) { return type === 'assistant' ? '助手' : '陪聊'; };

  K.avatarEl = function (obj, size) {
    obj = obj || {};
    var name = obj.name || '?';
    var uri = obj.avatar || '';
    try {
      if (App.UI && App.UI.avatar) return App.UI.avatar(name, uri, size || 'md');
    } catch (e) { /* 退回自绘 */ }
    var el = document.createElement('div');
    el.className = 'avatar ' + (size || 'md');
    el.textContent = U.initial(name);
    return el;
  };

  // 列表/时间戳：刚刚 / n分钟前 / HH:mm / 昨天 / MM-DD / YYYY-MM-DD
  K.relativeTime = function (ts) {
    ts = Number(ts) || 0;
    if (!ts) return '';
    var now = Date.now();
    var diff = now - ts;
    if (diff < 0) diff = 0;
    if (diff < 60000) return '刚刚';
    if (diff < 3600000) return Math.floor(diff / 60000) + '分钟前';
    var d = new Date(ts);
    var n = new Date();
    if (d.getFullYear() === n.getFullYear() && d.getMonth() === n.getMonth() && d.getDate() === n.getDate()) {
      return U.fmtTime(ts);
    }
    return U.fmtTime(ts);
  };

  // 消息分组日期标签
  K.dayLabel = function (ts) {
    var d = new Date(Number(ts) || Date.now());
    var n = new Date();
    function isSame(a, b) {
      return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
    }
    if (isSame(d, n)) return '今天';
    var y = new Date(n.getTime() - 86400000);
    if (isSame(d, y)) return '昨天';
    return (d.getMonth() + 1) + '月' + d.getDate() + '日';
  };

  // 摘要：去 markdown 标记、压缩空白、截断
  K.preview = function (text, max) {
    var s = String(text === undefined || text === null ? '' : text);
    s = s.replace(/\[\[img:[^\]]*\]\]/g, '［图片］');
    s = s.replace(/```[\s\S]*?```/g, '［代码］');
    s = s.replace(/[#>*_`~]/g, '');
    s = s.replace(/\s+/g, ' ').trim();
    if (!s) return '';
    return s.length > (max || 60) ? s.slice(0, max || 60) + '…' : s;
  };

  // 消息摘要：优先文本；只有附件时给「［图片］/［文件］名称」
  K.previewMessage = function (m, max) {
    if (!m) return '';
    var text = K.preview(m.content, max);
    var att = Array.isArray(m.attachments) ? m.attachments[0] : null;
    if (!att) return text;
    var label = att.kind === 'image' ? '［图片］' : '［文件］' + (att.name || '');
    return text ? text + ' ' + label : label;
  };

  K.sortMessages = function (list) {
    return (list || []).slice().sort(function (a, b) {
      var x = Number(a.createdAt) || 0;
      var y = Number(b.createdAt) || 0;
      if (x !== y) return x - y;
      return String(a.id || '').localeCompare(String(b.id || ''));
    });
  };

  // 更新会话摘要/更新时间（聊天页每次落库后调用）
  K.touchSession = function (sessionId, lastMsg, extra) {
    if (!sessionId) return Promise.resolve(null);
    return D.get('sessions', sessionId).then(function (s) {
      if (!s) return null;
      s.updatedAt = U.now();
      if (lastMsg) {
        s.lastText = K.previewMessage(lastMsg, 60);
        s.lastRole = lastMsg.role;
        s.lastAt = lastMsg.createdAt || U.now();
      }
      if (extra) Object.keys(extra).forEach(function (key) { s[key] = extra[key]; });
      return D.put('sessions', s);
    }).catch(function () { return null; });
  };

  /* ---------------- 系统提示词 / 上下文组装 ---------------- */
  K.fallbackSystem = function (card) {
    card = card || {};
    var name = card.name || '角色';
    if (card.type === 'assistant') {
      return '你是名为「' + name + '」的助手。回答准确、简洁、可执行；不确定时明确说明不确定。';
    }
    var s = '你是「' + name + '」，请始终以第一人称扮演该角色与用户聊天，保持人物设定一致，语气自然。';
    if (card.personality) s += '\n性格：' + card.personality;
    if (card.speechStyle) s += '\n说话风格：' + card.speechStyle;
    if (card.background) s += '\n背景：' + card.background;
    if (card.scenario) s += '\n场景：' + card.scenario;
    return s;
  };

  /* 动作/神态的表达格式约定（配合 K.md 的单星号斜体渲染） */
  K.EXPRESSION_PROMPT = '【表达格式】动作、神态、环境描写用 *星号包裹*（例如 *她低头笑了笑*），人物说出的话直接用正文，不要整段加引号。';
  /* 上帝模式：角色知道自己是被 AI 扮演的虚拟角色 */
  K.GOD_MODE_PROMPT = '【上帝模式】你清楚自己只是这个 App 里的虚拟角色，由 AI 扮演，不是真实的人。用户可以随时和你聊这件事；\n' +
    '承认这一点时保持角色口吻，不要破坏设定，也不要假装自己是真人或声称有真实身体/现实经历。';

  // 角色图片库清单：优先用 App.Media.promptBlock；media.js 缺失时按契约格式本地兜底
  K.imagesPromptBlock = function (images) {
    var list = Array.isArray(images) ? images.filter(Boolean) : [];
    if (!list.length) return '';
    try {
      if (App.Media && typeof App.Media.promptBlock === 'function') {
        var block = App.Media.promptBlock(list);
        if (block) return String(block);
      }
    } catch (e) { /* 退回本地实现 */ }
    var pick = list.length > 30 ? list.slice(list.length - 30) : list;
    function oneLine(v) { return String(v === undefined || v === null ? '' : v).replace(/\s+/g, ' ').trim(); }
    var rows = pick.map(function (img) {
      var name = oneLine(img.name) || '未命名图片';
      var caption = oneLine(img.caption);
      return '- ID=' + oneLine(img.id) + '｜名称=' + name + (caption ? '｜说明=' + caption : '｜说明=');
    });
    return '【图片库】你有一组可以主动发给用户的图片：\n' + rows.join('\n') +
      '\n怎么发图：在回复中单独一行写 [[img:图片ID]]（例如 [[img:' + oneLine(pick[0] && pick[0].id) + ']]），' +
      '可以在这行前后各配一句话。只能使用上面列出的 ID，禁止编造不存在的 ID；不需要发图时不要输出该标记。' +
      (list.length > pick.length ? '\n（图片较多，只列出了最近 ' + pick.length + ' 张）' : '');
  };

  K.buildSystemPrompt = function (character, persona, preset, opts) {
    var P = App.Prompts || {};
    var parts = [];
    var sys = '';
    if (character) {
      if (character.systemPrompt && String(character.systemPrompt).trim()) {
        sys = String(character.systemPrompt).trim();
      } else {
        try {
          if (character.type === 'assistant' && typeof P.assistantSystemPrompt === 'function') {
            sys = P.assistantSystemPrompt(character) || '';
          } else if (typeof P.companionSystemPrompt === 'function') {
            sys = P.companionSystemPrompt(character, character.worldviewSnapshot || character.worldview || null) || '';
          }
        } catch (e) {
          sys = '';
        }
      }
      if (!sys) sys = K.fallbackSystem(character);
    }
    if (sys) parts.push(sys);
    if (persona) {
      var line = '【用户设定】用户扮演：' + (persona.name || '我');
      if (persona.description) line += '，' + persona.description;
      parts.push(line);
    }
    if (preset) {
      var extra = String(preset.instructTemplate || preset.systemPrompt || '').trim();
      if (extra) parts.push(extra);
    }
    // 第 4 参可选的表达格式 / 图片库 / 上帝模式（旧 3 参调用保持原行为）
    opts = opts || null;
    if (opts && opts.expressionFormat !== false) parts.push(K.EXPRESSION_PROMPT);
    if (opts && opts.images && opts.images.length) {
      var imgBlock = K.imagesPromptBlock(opts.images);
      if (imgBlock) parts.push(imgBlock);
    }
    if (opts && opts.godMode === true) parts.push(K.GOD_MODE_PROMPT);
    return parts.join('\n\n');
  };

  // 单条消息的 token 估算：文本 + 附件（图片 85 tok/张，文件按文本字数）
  K.estimateMessageTokens = function (m) {
    if (!m) return 0;
    var total = U.estimateTokens(m.content) + 4;
    var atts = Array.isArray(m.attachments) ? m.attachments : [];
    atts.forEach(function (att) {
      if (!att) return;
      if (att.kind === 'image') total += 85;
      else if (att.kind === 'file') total += U.estimateTokens(att.text || '') + 12;
    });
    return total;
  };

  // 上下文裁剪：system 永不丢；保留最近一轮完整；超出预算从最旧丢
  K.buildContext = function (opts) {
    opts = opts || {};
    var budget = opts.tokenBudget || K.TOKEN_BUDGET;
    var sys = K.buildSystemPrompt(opts.character, opts.persona, opts.preset, {
      expressionFormat: opts.expressionFormat,
      images: opts.images,
      godMode: opts.godMode
    });
    var list = (opts.messages || []).filter(function (m) {
      if (!m) return false;
      if (m.role !== 'user' && m.role !== 'assistant') return false;
      if (m.status === 'error') return false;
      var hasAttach = Array.isArray(m.attachments) && m.attachments.length > 0;
      return String(m.content || '').trim() !== '' || hasAttach;
    });
    var sysTokens = U.estimateTokens(sys);
    var left = Math.max(600, budget - sysTokens);
    var lastUser = -1;
    for (var i = list.length - 1; i >= 0; i--) {
      if (list[i].role === 'user') { lastUser = i; break; }
    }
    var tail = lastUser >= 0 ? list.slice(lastUser) : [];
    var used = 0;
    tail.forEach(function (m) { used += K.estimateMessageTokens(m); });
    var head = [];
    var start = lastUser >= 0 ? lastUser - 1 : list.length - 1;
    for (var j = start; j >= 0; j--) {
      var t = K.estimateMessageTokens(list[j]);
      if (used + t > left) break;
      head.unshift(list[j]);
      used += t;
    }
    var picked = head.concat(tail);
    // 保持对话从用户消息开始（裁掉头部孤立的 assistant，避免上游模型困惑）
    while (picked.length && picked[0].role === 'assistant') picked.shift();
    var messages = [];
    if (sys) messages.push({ role: 'system', content: sys });
    picked.forEach(function (m) {
      var row = { role: m.role, content: String(m.content || '') };
      if (Array.isArray(m.attachments) && m.attachments.length) row.attachments = m.attachments;
      messages.push(row);
    });
    return {
      messages: messages,
      usedTokens: used + sysTokens,
      systemTokens: sysTokens,
      dropped: list.length - picked.length
    };
  };

  /* ---------------- 弹层/提示统一封装（走 App.UI，全部带 catch） ---------------- */
  K.toast = function (text, type) {
    try {
      if (App.UI && App.UI.toast) App.UI.toast(text, type || 'info');
    } catch (e) { /* 忽略 */ }
  };
  K.sheet = function (opts) {
    try {
      return Promise.resolve(App.UI.sheet(opts)).catch(function () { return null; });
    } catch (e) {
      return Promise.resolve(null);
    }
  };
  K.confirm = function (opts) {
    try {
      return Promise.resolve(App.UI.confirm(opts)).catch(function () { return false; });
    } catch (e) {
      return Promise.resolve(false);
    }
  };
  K.prompt = function (opts) {
    try {
      return Promise.resolve(App.UI.prompt(opts)).catch(function () { return null; });
    } catch (e) {
      return Promise.resolve(null);
    }
  };
  // 兼容：sheet 返回 item 对象时取业务 id
  K.itemId = function (item) {
    if (!item) return '';
    if (typeof item === 'string') return item;
    return String(item.id || item.value || item.key || item.label || '');
  };

  /* ---------------- DOM 小工具 ---------------- */
  K.closest = function (node, selector) {
    while (node && node !== document) {
      if (node.nodeType === 1 && node.matches && node.matches(selector)) return node;
      node = node.parentNode;
    }
    return null;
  };
  K.iconHtml = function (name) {
    try {
      if (App.UI && App.UI.icon) return App.UI.icon(name);
    } catch (e) { /* 忽略 */ }
    return '';
  };
  K.clear = function (node) {
    if (!node) return node;
    while (node.firstChild) node.removeChild(node.firstChild);
    return node;
  };

  K.providerLabel = function (provider, model) {
    if (!provider) return model || '未配置模型';
    return (provider.name || provider.baseUrl || 'API') + (model ? ' · ' + model : '');
  };

  /* =========================================================================
     二、聊天列表页
     ========================================================================= */
  App.Router.register('chatList', {
    tab: true,
    title: '聊天',
    tabLabel: '聊天',
    tabIcon: 'chat',
    build: function (root, params, page) {
      root.style.overflow = 'hidden';
      root.classList.add('chat-list-page');

      var state = {
        sessions: [],
        chars: {},
        charsCount: 0,
        previews: {},          // sessionId -> {text, role, at}
        previewLoading: {},
        search: '',
        ready: false,
        destroyed: false
      };

      var listEl = App.UI.el('div', { class: 'list chat-session-list' });
      var scrollEl = App.UI.el('div', { class: 'chat-list-scroll' }, listEl);
      var bodyEl = App.UI.el('div', { class: 'chat-list-body' }, scrollEl);

      var searchInput = App.UI.el('input', {
        class: 'chat-search-input',
        attrs: { type: 'search', placeholder: '搜索会话 / 角色名 / 消息', 'aria-label': '搜索会话' }
      });
      var searchBar = App.UI.el('div', { class: 'search-bar chat-search' },
        App.UI.el('span', { class: 'search-icon', html: K.iconHtml('search') }),
        searchInput
      );

      root.appendChild(App.UI.el('div', { class: 'chat-list-wrap' }, searchBar, bodyEl));

      /* ---------- 页面骨架（导航栏） ---------- */
      try { page.setTitle('聊天'); } catch (e) { /* 忽略 */ }
      try {
        page.setActions([{
          icon: 'plus',
          label: '新建会话',
          onClick: function () { openNewSession(); }
        }]);
      } catch (e) { /* 忽略 */ }

      /* ---------- 会话列表渲染 ---------- */
      function previewOf(session) {
        if (K.isGenerating(session.id)) return { text: '生成中…', role: '', at: 0, generating: true };
        var pv = state.previews[session.id];
        if (pv) return pv;
        if (session.lastText) return { text: session.lastText, role: session.lastRole || '', at: session.lastAt || 0 };
        return null;
      }

      function buildRow(session) {
        var card = state.chars[session.characterId] || { name: session.title || '未知角色', type: 'companion' };
        var generating = K.isGenerating(session.id) || !!session.isGenerating;
        var pv = previewOf(session);
        var unread = Number(session.unread) || 0;

        var row = App.UI.el('div', {
          class: 'cell session-cell' + (session.pinned ? ' pinned' : '') + (generating ? ' generating' : ''),
          dataset: { id: session.id }
        });
        row.appendChild(K.avatarEl(card, 'md'));

        var main = App.UI.el('div', { class: 'main' });
        var titleRow = App.UI.el('div', { class: 'title session-title' },
          App.UI.el('span', { class: 'session-name ellipsis', text: session.title || card.name || '未命名会话' }),
          App.UI.el('span', {
            class: 'type-tag ' + (card.type === 'assistant' ? 'assistant' : 'companion'),
            text: K.typeLabel(card.type)
          })
        );
        if (session.pinned) {
          titleRow.appendChild(App.UI.el('span', { class: 'pin-flag', html: K.iconHtml('pin') }));
        }
        main.appendChild(titleRow);

        var subText = generating ? '生成中…' : (pv && pv.text ? (pv.role === 'user' ? '我：' + pv.text : pv.text) : '还没有消息，打个招呼吧');
        main.appendChild(App.UI.el('div', { class: 'sub session-preview ellipsis' + (generating ? ' generating' : ''), text: subText }));
        row.appendChild(main);

        var side = App.UI.el('div', { class: 'side session-side' });
        side.appendChild(App.UI.el('div', { class: 'session-side-top' },
          App.UI.el('span', { class: 'session-time', text: session.updatedAt || session.lastAt ? K.relativeTime(session.updatedAt || session.lastAt) : '' })
        ));
        var bottom = App.UI.el('div', { class: 'session-side-bottom' });
        if (unread > 0) {
          bottom.appendChild(App.UI.el('span', { class: 'unread-dot', text: unread > 99 ? '99+' : String(unread) }));
        }
        if (generating) {
          bottom.appendChild(App.UI.el('span', { class: 'gen-tag' }, App.UI.el('i'), App.UI.el('span', { text: '生成中' })));
        }
        bottom.appendChild(App.UI.el('button', {
          class: 'session-more',
          attrs: { type: 'button', 'aria-label': '会话操作' },
          html: K.iconHtml('more')
        }));
        side.appendChild(bottom);
        row.appendChild(side);
        return row;
      }

      function renderEmpty(opts) {
        K.clear(bodyEl);
        var node;
        try {
          node = App.UI.empty(opts);
        } catch (e) {
          node = App.UI.el('div', { class: 'empty' }, App.UI.el('div', { class: 'empty-title', text: opts.title || '' }));
        }
        node.classList.add('chat-list-empty');
        bodyEl.appendChild(node);
      }

      function renderList() {
        if (state.destroyed) return;
        var q = (state.search || '').trim().toLowerCase();
        var rows = state.sessions.filter(function (s) {
          if (!q) return true;
          var card = state.chars[s.characterId] || {};
          var pv = previewOf(s);
          var hay = ((s.title || '') + ' ' + (card.name || '') + ' ' + (pv && pv.text ? pv.text : '')).toLowerCase();
          return hay.indexOf(q) >= 0;
        });

        K.clear(bodyEl);
        if (!state.sessions.length) {
          if (!state.charsCount) {
            renderEmpty({
              icon: 'character',
              title: '还没有角色',
              desc: '聊天需要先创建角色。创建陪聊角色或助手角色后即可开始对话。',
              actionText: '创建角色',
              onAction: function () { openCreateCharacter(); }
            });
          } else {
            renderEmpty({
              icon: 'chat',
              title: '还没有会话',
              desc: '选择角色开始第一段对话吧。',
              actionText: '新建会话',
              onAction: function () { openNewSession(); }
            });
          }
          return;
        }
        if (!rows.length) {
          renderEmpty({ icon: 'search', title: '没有找到匹配的会话', desc: '换个关键词试试，搜索会匹配角色名与消息内容。' });
          return;
        }
        bodyEl.appendChild(scrollEl);
        K.clear(listEl);
        var frag = document.createDocumentFragment();
        rows.forEach(function (s) { frag.appendChild(buildRow(s)); });
        listEl.appendChild(frag);
      }

      /* ---------- 数据加载 ---------- */
      function load() {
        return Promise.all([D.all('sessions'), D.all('characters'), D.all('providers')]).then(function (arr) {
          var sessions = arr[0] || [];
          var chars = arr[1] || [];
          var providers = arr[2] || [];
          state.chars = {};
          chars.forEach(function (c) { state.chars[c.id] = c; });
          state.charsCount = chars.length;
          state.providerCount = providers.length;

          // 过滤掉不该出现在列表里的会话（如引导临时会话），并清理僵死的生成标记
          state.sessions = sessions.filter(function (s) {
            return s && !s.hidden && !s.hideFromList && s.kind !== 'guide' && s.type !== 'guide';
          }).sort(function (a, b) {
            var pa = a.pinned ? 1 : 0;
            var pb = b.pinned ? 1 : 0;
            if (pa !== pb) return pb - pa;
            return (Number(b.updatedAt) || Number(b.createdAt) || 0) - (Number(a.updatedAt) || Number(a.createdAt) || 0);
          });
          state.sessions.forEach(function (s) {
            if (s.isGenerating && !K.isGenerating(s.id)) {
              s.isGenerating = false;
              D.put('sessions', s).catch(function () { /* 忽略 */ });
            }
          });
          state.ready = true;
          return fillPreviews();
        }).then(function () {
          renderList();
        }).catch(function (err) {
          console.error('[chatList] 加载会话失败', err);
          K.clear(bodyEl);
          var box;
          try {
            box = App.UI.errorState({
              title: '会话加载失败', desc: (err && err.message) || '未知错误',
              actionText: '重试', onAction: function () { load(); }
            });
          } catch (e) {
            box = App.UI.el('div', { class: 'error-box' }, App.UI.el('div', { class: 'error-text', text: '会话加载失败' }));
          }
          bodyEl.appendChild(box);
        });
      }

      // 为缺少摘要的会话补最后一条消息（正常情况由聊天页写回，这里只兜底）
      function fillPreviews() {
        var need = state.sessions.filter(function (s) {
          return !s.lastText && !state.previews[s.id] && !state.previewLoading[s.id];
        }).slice(0, 20);
        if (!need.length) return Promise.resolve();
        return Promise.all(need.map(function (s) {
          state.previewLoading[s.id] = true;
          return D.byIndex('messages', 'sessionId', s.id).then(function (msgs) {
            var sorted = K.sortMessages(msgs);
            var last = sorted[sorted.length - 1];
            if (last) {
              state.previews[s.id] = { text: K.previewMessage(last, 60), role: last.role, at: last.createdAt };
            }
          }).catch(function () {
            /* 单条失败不影响整体 */
          }).then(function () { delete state.previewLoading[s.id]; });
        })).then(function () { /* 完成 */ });
      }

      function refresh() {
        return load().catch(function (err) {
          console.error('[chatList] 刷新失败', err);
        });
      }

      /* ---------- 打开会话 ---------- */
      function openChat(session) {
        if (searchInput && document.activeElement === searchInput) searchInput.blur();
        App.Router.push('chat', { sessionId: session.id }).catch(function (err) {
          K.toast('打开会话失败：' + ((err && err.message) || '未知错误'), 'error');
        });
      }

      function openCreateCharacter() {
        if (App.Router.has('characterCreate')) {
          App.Router.push('characterCreate').catch(function (err) {
            K.toast('打开创建角色失败：' + ((err && err.message) || '未知错误'), 'error');
          });
        } else {
          K.toast('创建角色页面尚未就绪', 'error');
        }
      }

      /* ---------- 会话操作菜单 ---------- */
      function openSessionMenu(session) {
        K.sheet({
          title: session.title || '会话操作',
          items: [
            { id: 'rename', value: 'rename', label: '重命名会话', icon: 'edit' },
            { id: 'pin', value: 'pin', label: session.pinned ? '取消置顶' : '置顶会话', icon: 'pin' },
            { id: 'clear', value: 'clear', label: '清空消息', icon: 'trash' },
            { id: 'delete', value: 'delete', label: '删除会话', icon: 'delete', danger: true }
          ],
          cancelText: '取消'
        }).then(function (item) {
          var act = K.itemId(item);
          if (!act) return;
          if (act === 'rename') return doRename(session);
          if (act === 'pin') return doPin(session);
          if (act === 'clear') return doClear(session);
          if (act === 'delete') return doDelete(session);
          return null;
        }).catch(function (err) {
          console.error('[chatList] 会话菜单出错', err);
        });
      }

      function doRename(session) {
        return K.prompt({
          title: '重命名会话',
          message: '给这段对话起个名字',
          value: session.title || '',
          placeholder: '会话名称',
          okText: '保存'
        }).then(function (name) {
          if (name === null) return null;
          var title = String(name).trim();
          if (!title) { K.toast('名称不能为空'); return null; }
          session.title = title;
          return D.put('sessions', session).then(function () {
            K.toast('已重命名', 'ok');
            return refresh();
          });
        }).catch(function (err) {
          console.error('[chatList] 重命名失败', err);
          K.toast('重命名失败', 'error');
        });
      }

      function doPin(session) {
        session.pinned = !session.pinned;
        return D.put('sessions', session).then(function () {
          K.toast(session.pinned ? '已置顶' : '已取消置顶', 'ok');
          return refresh();
        }).catch(function (err) {
          console.error('[chatList] 置顶失败', err);
          K.toast('操作失败', 'error');
        });
      }

      function doClear(session) {
        return K.confirm({
          title: '清空消息',
          message: '确定清空「' + (session.title || '该会话') + '」的全部消息吗？此操作不可恢复。',
          okText: '清空',
          danger: true
        }).then(function (ok) {
          if (!ok) return null;
          return D.byIndex('messages', 'sessionId', session.id).then(function (msgs) {
            var ids = (msgs || []).map(function (m) { return m.id; });
            return D.delMany('messages', ids);
          }).then(function () {
            session.lastText = '';
            session.lastRole = '';
            session.lastAt = 0;
            session.updatedAt = U.now();
            session.isGenerating = false;
            K.setGenerating(session.id, false);
            return D.put('sessions', session);
          }).then(function () {
            K.toast('已清空消息', 'ok');
            return refresh();
          });
        }).catch(function (err) {
          console.error('[chatList] 清空消息失败', err);
          K.toast('清空失败', 'error');
        });
      }

      function doDelete(session) {
        return K.confirm({
          title: '删除会话',
          message: '将删除「' + (session.title || '该会话') + '」及其全部消息，且不可恢复。',
          okText: '删除',
          danger: true
        }).then(function (ok) {
          if (!ok) return null;
          K.setGenerating(session.id, false);
          return D.byIndex('messages', 'sessionId', session.id).then(function (msgs) {
            var ids = (msgs || []).map(function (m) { return m.id; });
            return D.delMany('messages', ids);
          }).then(function () {
            return D.del('sessions', session.id);
          }).then(function () {
            K.toast('已删除会话', 'ok');
            return refresh();
          });
        }).catch(function (err) {
          console.error('[chatList] 删除会话失败', err);
          K.toast('删除失败', 'error');
        });
      }

      /* ---------- 新建会话：角色选择器（分组 + 搜索） ---------- */
      function openNewSession() {
        Promise.all([
          D.all('characters'),
          D.all('personas'),
          D.all('providers'),
          D.settings.get('default_chat_provider_id'),
          D.settings.get('default_preset_id')
        ]).then(function (arr) {
          var chars = arr[0] || [];
          var personas = arr[1] || [];
          var providers = arr[2] || [];
          var defProviderId = arr[3];
          var defPresetId = arr[4];
          if (!chars.length) {
            return K.confirm({
              title: '还没有角色',
              message: '聊天需要先创建角色，现在去创建吗？',
              okText: '去创建',
              cancelText: '取消'
            }).then(function (ok) {
              if (ok) openCreateCharacter();
            });
          }
          openCharacterPicker(chars, function (character) {
            createSession(character, personas, providers, defProviderId, defPresetId).catch(function (err) {
              console.error('[chatList] 创建会话失败', err);
              K.toast('创建会话失败：' + ((err && err.message) || '未知错误'), 'error');
            });
          });
        }).catch(function (err) {
          console.error('[chatList] 加载角色失败', err);
          K.toast('角色加载失败：' + ((err && err.message) || '未知错误'), 'error');
        });
      }

      function openCharacterPicker(chars, onPick) {
        var listWrap = App.UI.el('div', { class: 'char-picker-list' });
        var searchInput2 = App.UI.el('input', {
          class: 'char-picker-input',
          attrs: { type: 'text', placeholder: '搜索角色名 / 性格 / 类型', 'aria-label': '搜索角色' }
        });
        var body = App.UI.el('div', { class: 'char-picker' },
          App.UI.el('div', { class: 'search-bar char-picker-search' },
            App.UI.el('span', { class: 'search-icon', html: K.iconHtml('search') }),
            searchInput2
          ),
          listWrap
        );
        var modal;
        try {
          modal = App.UI.modal({
            title: '选择角色',
            content: body,
            dismissible: true,
            actions: [{ text: '取消', class: 'ghost', onClick: function (close) { close(); } }]
          });
        } catch (e) {
          K.toast('无法打开角色选择器', 'error');
          return;
        }

        function renderPicker() {
          var q = String(searchInput2.value || '').trim().toLowerCase();
          K.clear(listWrap);
          var groups = [
            { type: 'companion', title: '陪聊角色' },
            { type: 'assistant', title: '助手角色' }
          ];
          var total = 0;
          groups.forEach(function (g) {
            var list = chars.filter(function (c) {
              if ((c.type || 'companion') !== g.type) return false;
              if (!q) return true;
              var hay = ((c.name || '') + ' ' + (c.personality || '') + ' ' + (g.title)).toLowerCase();
              return hay.indexOf(q) >= 0;
            });
            if (!list.length) return;
            total += list.length;
            listWrap.appendChild(App.UI.el('div', { class: 'group-title char-picker-group', text: g.title + '（' + list.length + '）' }));
            list.forEach(function (c) {
              var row = App.UI.el('div', { class: 'char-picker-item' },
                K.avatarEl(c, 'sm'),
                App.UI.el('div', { class: 'char-picker-main' },
                  App.UI.el('div', { class: 'char-picker-name ellipsis', text: c.name || '未命名角色' }),
                  App.UI.el('div', { class: 'char-picker-desc ellipsis', text: (c.personality || c.scenario || '暂无角色简介') })
                )
              );
              row.addEventListener('click', function () {
                if (modal && modal.close) modal.close();
                onPick(c);
              });
              listWrap.appendChild(row);
            });
          });
          if (!total) {
            listWrap.appendChild(App.UI.el('div', { class: 'char-picker-none', text: '没有匹配的角色' }));
          }
        }
        searchInput2.addEventListener('input', U.debounce(renderPicker, 120));
        renderPicker();
      }

      function pickProvider(providers, defId) {
        var list = (providers || []).filter(function (p) { return p && (p.role === 'chat' || !p.role); });
        if (!list.length) list = (providers || []).slice();
        var found = null;
        list.forEach(function (p) { if (!found && p.id === defId) found = p; });
        if (!found && list.length) found = list[0];
        return found || null;
      }

      function pickProviderModel(provider) {
        if (!provider) return '';
        return provider.defaultModel || (provider.models && provider.models[0]) || '';
      }

      /* ---------- 问候语：首选 firstMessage，缺省时退回第一条备选（v1.2.0 契约 §2） ---------- */
      function pickGreeting(character) {
        var card = character || {};
        var first = String(card.firstMessage || '').trim();
        if (first) return { text: first, index: 0 };
        var alts = Array.isArray(card.alternateGreetings) ? card.alternateGreetings : [];
        for (var i = 0; i < alts.length; i++) {
          var text = String(alts[i] || '').trim();
          if (text) return { text: text, index: i + 1 };
        }
        return { text: '', index: -1 };
      }

      function createSession(character, personas, providers, defProviderId, defPresetId) {
        var provider = pickProvider(providers, defProviderId);
        var model = pickProviderModel(provider);
        var personaPromise = (personas && personas.length)
          ? Promise.resolve(personas[0])
          : D.put('personas', { name: '我', description: '用户本人', avatar: '' });

        return personaPromise.then(function (persona) {
          var presetPromise = defPresetId
            ? D.get('presets', defPresetId).catch(function () { return null; })
            : Promise.resolve(null);
          return presetPromise.then(function (preset) {
            if (!preset) preset = K.defaultPresetFor(character.type);
            var now = U.now();
            var greeting = pickGreeting(character);
            var session = {
              id: U.uid('sess'),
              title: character.name || '新会话',
              characterId: character.id,
              personaId: (persona && persona.id) || '',
              presetId: (preset && preset.id) || '',
              model: model,
              providerId: (provider && provider.id) || '',
              pinned: false,
              unread: 0,
              isGenerating: false,
              greetingIndex: greeting.index,
              lastText: '',
              lastRole: '',
              lastAt: now,
              createdAt: now,
              updatedAt: now
            };
            return D.put('sessions', session).then(function (saved) {
              var first = greeting.text;
              if (!first) return saved;
              // 角色开场白作为第一条 assistant 消息
              return D.put('messages', {
                sessionId: saved.id,
                role: 'assistant',
                content: first,
                variantIndex: 0,
                isActive: true,
                status: 'ok',
                errorText: '',
                tokensIn: 0,
                tokensOut: 0,
                createdAt: U.now()
              }).then(function (msg) {
                saved.lastText = K.previewMessage(msg, 60);
                saved.lastRole = 'assistant';
                saved.lastAt = msg.createdAt;
                return D.put('sessions', saved);
              });
            }).then(function (saved) {
              K.toast('已创建会话', 'ok');
              return App.Router.push('chat', { sessionId: saved.id });
            });
          });
        });
      }

      /* ---------- 事件委托：点击 / 长按 / 右键 ---------- */
      function openMenuForRow(row) {
        if (!row) return;
        var id = row.getAttribute('data-id');
        var session = null;
        state.sessions.forEach(function (s) { if (s.id === id) session = s; });
        if (session) openSessionMenu(session);
      }

      var pressTimer = null;
      var pressMoved = false;
      var pressTarget = null;
      var suppressClick = false;

      listEl.addEventListener('click', function (ev) {
        var row = K.closest(ev.target, '.session-cell');
        if (!row) return;
        if (suppressClick) { suppressClick = false; return; }
        var more = K.closest(ev.target, '.session-more');
        if (more) {
          ev.preventDefault();
          ev.stopPropagation();
          openMenuForRow(row);
          return;
        }
        var id = row.getAttribute('data-id');
        var session = null;
        state.sessions.forEach(function (s) { if (s.id === id) session = s; });
        if (session) openChat(session);
      }, false);

      listEl.addEventListener('touchstart', function (ev) {
        var row = K.closest(ev.target, '.session-cell');
        if (!row || K.closest(ev.target, '.session-more')) return;
        pressTarget = row;
        pressMoved = false;
        clearTimeout(pressTimer);
        pressTimer = setTimeout(function () {
          if (pressMoved || !pressTarget) return;
          suppressClick = true;
          try {
            if (App.Bridge && App.Bridge.call) App.Bridge.call('ui.vibrate', { ms: 12 }).catch(function () {});
          } catch (e) { /* 忽略 */ }
          openMenuForRow(pressTarget);
        }, 520);
      }, { passive: true });

      listEl.addEventListener('touchmove', function () {
        pressMoved = true;
        clearTimeout(pressTimer);
      }, { passive: true });

      listEl.addEventListener('touchend', function () {
        clearTimeout(pressTimer);
        setTimeout(function () { suppressClick = false; }, 400);
      }, { passive: true });

      listEl.addEventListener('touchcancel', function () {
        pressMoved = true;
        clearTimeout(pressTimer);
      }, { passive: true });

      listEl.addEventListener('contextmenu', function (ev) {
        var row = K.closest(ev.target, '.session-cell');
        if (!row) return;
        ev.preventDefault();
        openMenuForRow(row);
      }, false);

      /* ---------- 搜索 ---------- */
      searchInput.addEventListener('input', U.debounce(function () {
        state.search = searchInput.value || '';
        if (!state.sessions.length) {
          refresh();
        } else {
          renderList();
        }
      }, 120));

      /* ---------- 角色主动消息：收到外部会话更新事件后刷新列表（v1.2.0 契约 §3.1） ---------- */
      var refreshByExternal = U.debounce(function () {
        if (state.destroyed) return;
        if (!root.isConnected) return;
        // tab 页被隐藏时（display:none）不刷新，等重新展示时 router 的 onChange 会补一次
        if (root.offsetParent === null) return;
        refresh();
      }, 150);

      function onSessionUpdated(ev) {
        if (state.destroyed) return;
        var detail = (ev && ev.detail) || {};
        if (!detail.sessionId) return;
        // 清掉该会话的旧摘要缓存，避免覆盖新的 lastText
        try { delete state.previews[detail.sessionId]; } catch (e) { /* 忽略 */ }
        refreshByExternal();
      }
      document.addEventListener('aichat:session-updated', onSessionUpdated);

      /* ---------- 页面被重新展示时刷新（新建会话/聊完返回/角色变更） ---------- */
      App.Router.onChange(function (cur) {
        if (state.destroyed) return;
        if (!root.isConnected) return;
        if (!cur || !cur.entry || cur.entry.el !== root) return;
        refresh();
      });

      page.onDestroy(function () {
        state.destroyed = true;
        clearTimeout(pressTimer);
        document.removeEventListener('aichat:session-updated', onSessionUpdated);
      });

      return load();
    }
  });
})();
