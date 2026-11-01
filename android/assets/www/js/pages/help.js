/* =========================================================================
   pages/help.js —— 使用帮助（成员 D）
   · App.Help.open({ source, page, error })：底部抽屉式引导助手
       - 独立引导会话（helpSessions / helpMessages），不写入聊天会话表
       - 系统提示词 = App 功能清单 + FAQ + 错误对照表 + 本次页面/报错上下文（经净化）
       - 流式回复；失败/断网 → 静态 FAQ 兜底 + 重试；头部「清空」；空态快捷问题
   · 页面 'help'：全屏静态 FAQ（分类折叠 + 搜索），离线可用
   ========================================================================= */
(function () {
  'use strict';
  var App = window.App = window.App || {};
  var Help = App.Help = {};

  function U() { return App.Util; }
  function UI() { return App.UI; }

  /* 空态快捷问题（≤6 字更适合气泡，这里是抽屉 chip，可稍长） */
  var QUICK_QUESTIONS = ['怎么配置 API', '401 是什么意思', '怎么建角色', '怎么用悬浮球', '数据存在哪'];

  /* 来源 → helpSessions.context 枚举（契约固定值） */
  var SOURCE_TO_CONTEXT = {
    guide_wizard: 'guide_wizard',
    settings_help: 'settings_help',
    bubble_help: 'bubble_help',
    bubble_error: 'bubble_error',
    bubble_next_step: 'bubble_next_step',
    error_hint: 'error_hint',
    about: 'settings_help',
    help_page: 'settings_help',
    help: 'settings_help'
  };
  var SOURCE_LABEL = {
    guide_wizard: '创建向导',
    settings_help: '设置页入口',
    bubble_help: '悬浮气泡',
    bubble_error: '悬浮气泡·报错',
    bubble_next_step: '悬浮气泡·怎么走',
    error_hint: '错误提示',
    about: '关于页',
    help_page: '使用帮助页'
  };

  var drawer = null;      // 当前打开的抽屉状态
  var inited = false;

  /* ======================================================================
     一、上下文整理（不读取 Key / 聊天正文，只取页面与错误码）
     ====================================================================== */
  function normalizeCtx(input) {
    input = input || {};
    var pageId = '';
    if (input.page && typeof input.page === 'object') pageId = input.page.pageId || '';
    else if (typeof input.page === 'string') pageId = input.page;
    if (!pageId) {
      try {
        var cur = App.Router && App.Router.current ? App.Router.current() : null;
        pageId = cur ? cur.name : '';
      } catch (e) { pageId = ''; }
    }
    var source = String(input.source || 'settings_help');
    var ctx = {
      source: source,
      context: SOURCE_TO_CONTEXT[source] || 'settings_help',
      pageId: pageId || '',
      pageTitle: (App.Guide && App.Guide.pageLabel) ? App.Guide.pageLabel(pageId) : pageId,
      title: '',
      stage: '',
      totalSteps: 0,
      filledFields: {},
      missingFields: [],
      tab: '',
      error: null
    };
    /* 若调用方直接传了页面 guide 上下文，尽量沿用 */
    if (input.ctx && typeof input.ctx === 'object') {
      var c = input.ctx;
      if (c.title) ctx.title = c.title;
      if (c.stage) ctx.stage = c.stage;
      if (typeof c.totalSteps === 'number') ctx.totalSteps = c.totalSteps;
      if (c.filledFields && typeof c.filledFields === 'object') ctx.filledFields = c.filledFields;
      if (Array.isArray(c.missingFields)) ctx.missingFields = c.missingFields;
      if (c.error && !input.error) ctx.error = c.error;
      if (!ctx.pageId && c.pageId) { ctx.pageId = c.pageId; ctx.pageTitle = App.Guide.pageLabel(c.pageId); }
    }
    if (input.error) {
      var err = typeof input.error === 'string' ? { code: 'unknown', message: input.error } : input.error;
      var info = (App.Data && App.Data.errorInfo) ? App.Data.errorInfo(err.code) : { code: 'unknown' };
      ctx.error = {
        code: (info && info.code) || 'unknown',
        title: (info && info.title) || '未知错误',
        message: String(err.message || err.hint || '')
      };
    }
    return (App.Guide && App.Guide.sanitizeContext) ? App.Guide.sanitizeContext(ctx) : ctx;
  }

  /* 从上下文生成一句「自动提问」，让用户一跳进来就有答案 */
  function autoQuestion(ctx) {
    if (!ctx) return '';
    if (ctx.error) {
      var msg = ctx.error.message ? ('，服务端原文是「' + ctx.error.message.slice(0, 120) + '」') : '';
      return '我在「' + (ctx.pageTitle || '当前页面') + '」遇到错误 [' + ctx.error.code + '] ' + (ctx.error.title || '') + msg + '。这是什么意思？该怎么修？';
    }
    if (ctx.stage) {
      var missing = (ctx.missingFields && ctx.missingFields.length) ? ('还没填：' + ctx.missingFields.join('、') + '。') : '';
      return '我在「' + (ctx.pageTitle || '当前页面') + '」的「' + ctx.stage + '」这一步，' + missing + '接下来该怎么做？';
    }
    return '';
  }

  /* ======================================================================
     二、会话与消息（helpSessions / helpMessages，独立于聊天会话表）
     ====================================================================== */
  function findOrCreateSession(ctx) {
    return App.DB.query('helpSessions', { where: { context: ctx.context } }).then(function (rows) {
      var list = (rows || []).slice().sort(function (a, b) { return (b.updatedAt || 0) - (a.updatedAt || 0); });
      for (var i = 0; i < list.length; i++) {
        if (String(list[i].pageId || '') === String(ctx.pageId || '')) return list[i];
      }
      var now = Date.now();
      var row = {
        id: U().uid('hs'),
        context: ctx.context,
        pageId: ctx.pageId || '',
        createdAt: now,
        updatedAt: now
      };
      return App.DB.put('helpSessions', row).then(function () { return row; });
    }).catch(function (e) {
      console.warn('[help] 会话读取失败，改用内存会话', e);
      return { id: 'tmp_' + Date.now(), context: ctx.context, pageId: ctx.pageId || '', createdAt: Date.now(), updatedAt: Date.now(), __memory: true };
    });
  }

  function loadMessages(sessionId) {
    if (!sessionId) return Promise.resolve([]);
    return App.DB.query('helpMessages', { where: { sessionId: sessionId }, sortBy: 'createdAt', desc: false })
      .catch(function () { return []; });
  }

  function saveMessage(sessionId, role, content) {
    if (!sessionId) return Promise.resolve(null);
    var row = { id: U().uid('hm'), sessionId: sessionId, role: role, content: String(content || ''), createdAt: Date.now() };
    return App.DB.put('helpMessages', row).catch(function (e) {
      console.warn('[help] 消息保存失败', e);
      return null;
    });
  }

  function touchSession(sessionId) {
    if (!sessionId) return Promise.resolve();
    return App.DB.get('helpSessions', sessionId).then(function (row) {
      if (!row) return null;
      row.updatedAt = Date.now();
      return App.DB.put('helpSessions', row);
    }).catch(function () { return null; });
  }

  /* ======================================================================
     三、抽屉 DOM
     ====================================================================== */
  function safeFocusFirst() {
    /* 不自动弹键盘：移动端打开抽屉就弹键盘会遮住内容 */
  }

  function buildDrawer(ctx) {
    var ui = UI();
    var wrap = ui.el('div', { class: 'help-drawer-wrap', attrs: { 'data-help-drawer': '1' } });
    var mask = ui.el('div', { class: 'overlay-mask help-mask', attrs: { 'aria-hidden': 'true' } });
    var box = ui.el('div', { class: 'help-drawer', attrs: { role: 'dialog', 'aria-modal': 'true', 'aria-label': '引导助手' } });

    /* ---- 头部 ---- */
    var head = ui.el('div', { class: 'help-drawer-head' });
    var grip = ui.el('div', { class: 'help-drawer-grip', attrs: { 'aria-hidden': 'true' } });
    var titleBox = ui.el('div', { class: 'help-drawer-title' });
    var nameRow = ui.el('div', { class: 'help-drawer-name', html: ui.icon('guide', 18) + '<span>引导助手</span>' });
    var sub = ui.el('div', { class: 'help-drawer-sub' });
    var subText = (SOURCE_LABEL[ctx.source] || '使用帮助') + (ctx.pageTitle ? (' · ' + ctx.pageTitle) : '') + (ctx.error ? (' · 错误 ' + ctx.error.code) : '');
    sub.textContent = subText;
    titleBox.appendChild(nameRow);
    titleBox.appendChild(sub);

    var acts = ui.el('div', { class: 'help-drawer-actions' });
    var clearBtn = ui.el('button', {
      class: 'help-head-btn', type: 'button', text: '清空',
      attrs: { 'aria-label': '清空引导会话记录' }
    });
    var closeBtn = ui.el('button', {
      class: 'help-head-btn icon-only', type: 'button', html: ui.icon('close', 20),
      attrs: { 'aria-label': '关闭引导助手' }
    });
    acts.appendChild(clearBtn);
    acts.appendChild(closeBtn);
    head.appendChild(grip);
    head.appendChild(titleBox);
    head.appendChild(acts);

    /* ---- 消息区 ---- */
    var body = ui.el('div', { class: 'help-drawer-body' });
    var list = ui.el('div', { class: 'msg-list help-msg-list', attrs: { role: 'log', 'aria-live': 'polite' } });
    body.appendChild(list);

    /* ---- 输入条 ---- */
    var composer = ui.el('div', { class: 'composer help-composer' });
    var inputWrap = ui.el('div', { class: 'composer-input-wrap' });
    var input = ui.el('textarea', {
      class: 'composer-input help-input',
      attrs: { rows: '1', placeholder: '问引导助手，例如：401 是什么意思', 'aria-label': '向引导助手提问' }
    });
    var sendBtn = ui.el('button', {
      class: 'composer-send', type: 'button', html: ui.icon('send'),
      attrs: { 'aria-label': '发送问题' }
    });
    inputWrap.appendChild(input);
    composer.appendChild(inputWrap);
    composer.appendChild(sendBtn);

    box.appendChild(head);
    box.appendChild(body);
    box.appendChild(composer);
    wrap.appendChild(mask);
    wrap.appendChild(box);

    var state = {
      wrap: wrap, mask: mask, box: box, head: head, list: list,
      input: input, sendBtn: sendBtn, ctx: ctx,
      sessionId: '', dbMsgs: [], streaming: null, sending: false,
      lastQuestion: '', closed: false, cleanups: []
    };

    /* ---- 事件 ---- */
    mask.addEventListener('click', function () { close(); });
    closeBtn.addEventListener('click', function () { close(); });
    clearBtn.addEventListener('click', function () { clearHistory(); });

    bindDrag(state);
    bindComposer(state);
    bindKeyboard(state);

    return state;
  }

  /* 头部下拉关闭 */
  function bindDrag(state) {
    var startY = 0, startT = 0, dy = 0, dragging = false, moved = false, pid = null;
    var box = state.box;
    var head = state.head;

    function onDown(ev) {
      if (ev.target && ev.target.closest && ev.target.closest('button')) return;
      if (ev.pointerType === 'mouse' && ev.button !== 0) return;
      pid = ev.pointerId;
      startY = ev.clientY;
      startT = Date.now();
      dy = 0;
      dragging = true;
      moved = false;
      box.style.transition = 'none';
      try { head.setPointerCapture(pid); } catch (e) {}
    }
    function onMove(ev) {
      if (!dragging || (pid !== null && ev.pointerId !== pid)) return;
      dy = Math.max(0, ev.clientY - startY);
      if (dy > 6) moved = true;
      if (moved) {
        box.style.transform = 'translateY(' + dy + 'px)';
        if (state.mask) state.mask.style.opacity = String(Math.max(0, 1 - dy / 320));
      }
    }
    function onUp(ev) {
      if (!dragging) return;
      dragging = false;
      try { if (pid !== null) head.releasePointerCapture(pid); } catch (e) {}
      pid = null;
      var dt = Math.max(1, Date.now() - startT);
      var fast = dy / dt > 0.55;
      box.style.transition = '';
      if (state.mask) state.mask.style.opacity = '';
      if (moved && (dy > 110 || fast)) {
        if (state.mask) state.mask.style.opacity = '';
        close();
        return;
      }
      box.style.transform = '';
    }
    head.addEventListener('pointerdown', onDown);
    head.addEventListener('pointermove', onMove);
    head.addEventListener('pointerup', onUp);
    head.addEventListener('pointercancel', onUp);
    state.cleanups.push(function () {
      head.removeEventListener('pointerdown', onDown);
      head.removeEventListener('pointermove', onMove);
      head.removeEventListener('pointerup', onUp);
      head.removeEventListener('pointercancel', onUp);
    });
  }

  /* 输入框：自适应高度、Enter 发送、发送/停止切换 */
  function bindComposer(state) {
    var input = state.input;
    var sendBtn = state.sendBtn;

    function autosize() {
      input.style.height = 'auto';
      input.style.height = Math.min(96, Math.max(22, input.scrollHeight)) + 'px';
    }
    function onInput() { autosize(); }
    function onSubmitClick() {
      if (state.sending) { stopStreaming(state); return; }
      send(state, String(input.value || '').trim());
    }
    function onKeydown(ev) {
      if (ev.key !== 'Enter') return;
      if (ev.shiftKey) return;
      if (ev.isComposing || ev.keyCode === 229) return;
      ev.preventDefault();
      if (!state.sending) send(state, String(input.value || '').trim());
    }
    input.addEventListener('input', onInput);
    input.addEventListener('keydown', onKeydown);
    sendBtn.addEventListener('click', onSubmitClick);
    state.cleanups.push(function () {
      input.removeEventListener('input', onInput);
      input.removeEventListener('keydown', onKeydown);
      sendBtn.removeEventListener('click', onSubmitClick);
    });
    autosize();
  }

  /* 键盘/窗口变化：抽屉跟随可视区域 */
  function bindKeyboard(state) {
    function fit() {
      if (!state || state.closed) return;
      var vv = window.visualViewport;
      var h = vv && vv.height ? vv.height : window.innerHeight;
      state.wrap.style.height = Math.max(240, Math.round(h)) + 'px';
    }
    fit();
    window.addEventListener('resize', fit);
    if (window.visualViewport) window.visualViewport.addEventListener('resize', fit);
    state.cleanups.push(function () {
      window.removeEventListener('resize', fit);
      if (window.visualViewport) window.visualViewport.removeEventListener('resize', fit);
    });
  }

  /* ======================================================================
     四、消息渲染
     ====================================================================== */
  function scrollBottom(state, smooth) {
    var el = state && state.list;
    if (!el) return;
    try {
      if (smooth && el.scrollTo) el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
      else el.scrollTop = el.scrollHeight;
    } catch (e) { el.scrollTop = el.scrollHeight; }
  }

  function appendMsg(state, role, text) {
    var ui = UI();
    var msg = ui.el('div', { class: 'msg ' + (role === 'user' ? 'me' : 'ai') });
    var msgBody = ui.el('div', { class: 'msg-body' });
    var bubble = ui.el('div', { class: 'msg-bubble', text: String(text || '') });
    var meta = ui.el('div', { class: 'msg-meta', text: role === 'user' ? '我' : '引导助手' });
    msgBody.appendChild(bubble);
    msgBody.appendChild(meta);
    msg.appendChild(msgBody);
    state.list.appendChild(msg);
    scrollBottom(state);
    return { msg: msg, body: msgBody, bubble: bubble, meta: meta };
  }

  function appendTyping(state) {
    var ui = UI();
    var msg = ui.el('div', { class: 'msg ai' });
    var msgBody = ui.el('div', { class: 'msg-body' });
    var bubble = ui.el('div', { class: 'msg-bubble streaming' });
    bubble.appendChild(ui.el('span', { class: 'help-typing', html: '<i></i><i></i><i></i>' }));
    var meta = ui.el('div', { class: 'msg-meta', text: '引导助手' });
    msgBody.appendChild(bubble);
    msgBody.appendChild(meta);
    msg.appendChild(msgBody);
    state.list.appendChild(msg);
    scrollBottom(state);
    return { msg: msg, body: msgBody, bubble: bubble, meta: meta, text: '' };
  }

  function renderEmpty(state, ctx) {
    if (!state || state.emptyEl) return;
    var ui = UI();
    var box = ui.el('div', { class: 'help-empty' });
    box.appendChild(ui.el('div', { class: 'help-empty-icon', html: ui.icon('guide', 44) }));
    box.appendChild(ui.el('div', { class: 'help-empty-title', text: '有问题，问我' }));
    var desc = '我只看当前页面和错误码，不读取你的聊天内容与 API Key。';
    box.appendChild(ui.el('div', { class: 'help-empty-desc', text: desc }));
    var chips = ui.el('div', { class: 'help-chips' });
    QUICK_QUESTIONS.forEach(function (q) {
      var chip = ui.el('button', {
        class: 'help-chip', type: 'button', text: q,
        attrs: { 'aria-label': '快捷提问：' + q },
        on: { click: function () { send(state, q); } }
      });
      chips.appendChild(chip);
    });
    box.appendChild(chips);
    if (ctx && ctx.error) {
      box.appendChild(ui.el('div', { class: 'help-empty-note', text: '当前错误：' + ctx.error.code + ' ' + (ctx.error.title || '') }));
    }
    state.list.appendChild(box);
    state.emptyEl = box;
  }

  function hideEmpty(state) {
    if (state && state.emptyEl && state.emptyEl.parentNode) {
      state.emptyEl.parentNode.removeChild(state.emptyEl);
    }
    if (state) state.emptyEl = null;
  }

  /* 静态 FAQ 兜底 */
  function renderFallback(state, query, title) {
    var ui = UI();
    var box = ui.el('div', { class: 'help-fallback' });
    box.appendChild(ui.el('div', { class: 'help-fallback-title', text: title || '先看看离线答案（不联网也能读）' }));
    var items = (App.Data && App.Data.matchFaq) ? (App.Data.matchFaq(query, 3) || []) : [];
    if (!items.length) {
      var faq = (App.Data && App.Data.FAQ) || [];
      items = faq.slice(0, 3);
    }
    items.forEach(function (f) {
      var item = ui.el('div', { class: 'help-faq-mini' });
      item.appendChild(ui.el('div', { class: 'help-faq-mini-q', text: f.q }));
      item.appendChild(ui.el('div', { class: 'help-faq-mini-a', text: f.a }));
      box.appendChild(item);
    });
    var more = ui.el('button', {
      class: 'help-link', type: 'button', text: '查看全部使用帮助 →',
      on: { click: function () { close(); try { App.Router.push('help'); } catch (e) {} } }
    });
    box.appendChild(more);
    state.list.appendChild(box);
    scrollBottom(state);
    return box;
  }

  /* 没有引导 API 的引导块 */
  function renderSetupTip(state) {
    var ui = UI();
    var box = ui.el('div', { class: 'help-setup' });
    box.appendChild(ui.el('div', { class: 'help-setup-title', text: '还没有可用的引导 API' }));
    box.appendChild(ui.el('div', { class: 'help-setup-desc', text: '配置一条 API 之后，我才能回答问题。你也可以先看下面的离线 FAQ。' }));
    var btns = ui.el('div', { class: 'help-setup-actions' });
    btns.appendChild(ui.el('button', {
      class: 'btn primary small', type: 'button', text: '去配置引导 API',
      on: { click: function () { close(); try { App.Router.tab('apiList'); } catch (e) {} } }
    }));
    btns.appendChild(ui.el('button', {
      class: 'btn small', type: 'button', text: '看使用帮助',
      on: { click: function () { close(); try { App.Router.push('help'); } catch (e) {} } }
    }));
    box.appendChild(btns);
    state.list.appendChild(box);
    scrollBottom(state);

    var items = (App.Data && App.Data.FAQ) ? App.Data.FAQ.filter(function (f) {
      return /API/.test(f.category) || /入门/.test(f.category);
    }).slice(0, 3) : [];
    if (items.length) {
      var fallback = ui.el('div', { class: 'help-fallback' });
      fallback.appendChild(ui.el('div', { class: 'help-fallback-title', text: '离线 FAQ' }));
      items.forEach(function (f) {
        var item = ui.el('div', { class: 'help-faq-mini' });
        item.appendChild(ui.el('div', { class: 'help-faq-mini-q', text: f.q }));
        item.appendChild(ui.el('div', { class: 'help-faq-mini-a', text: f.a }));
        fallback.appendChild(item);
      });
      state.list.appendChild(fallback);
      scrollBottom(state);
    }
  }

  function renderError(state, err, question) {
    var ui = UI();
    var info = (App.Data && App.Data.errorInfo) ? App.Data.errorInfo(err && err.code) : null;
    var uiErr = (App.API && App.API.errorInfo) ? App.API.errorInfo(err) : null;
    var box = ui.el('div', { class: 'help-error' });
    box.appendChild(ui.el('div', { class: 'help-error-title', html: ui.icon('warning', 18) + '<span>' + (uiErr && uiErr.title ? U().esc(uiErr.title) : '回答失败') + '</span>' }));
    var desc = (uiErr && uiErr.hint) ? uiErr.hint : '引导助手暂时没有回应，可能是网络或 API 的问题。';
    if (err && err.message) desc += '（' + String(err.message).slice(0, 160) + '）';
    box.appendChild(ui.el('div', { class: 'help-error-desc', text: desc }));
    var acts = ui.el('div', { class: 'help-error-actions' });
    acts.appendChild(ui.el('button', {
      class: 'btn small primary', type: 'button', text: '重试',
      attrs: { 'aria-label': '重试回答' },
      on: { click: function () { if (box.parentNode) box.parentNode.removeChild(box); requestAnswer(state, question); } }
    }));
    if (state.ctx && state.ctx.error) {
      acts.appendChild(ui.el('button', {
        class: 'btn small', type: 'button', text: '这是什么意思？',
        on: {
          click: function () {
            if (box.parentNode) box.parentNode.removeChild(box);
            send(state, '错误码 ' + state.ctx.error.code + '（' + (state.ctx.error.title || '') + '）是什么意思？怎么解决？');
          }
        }
      }));
    }
    box.appendChild(acts);
    state.list.appendChild(box);
    renderFallback(state, question || (info && info.title) || 'API 配置', '先看看离线答案（不联网也能读）');
    scrollBottom(state);
  }

  /* ======================================================================
     五、发送与流式
     ====================================================================== */
  function systemPrompt(state) {
    var base = (App.Guide && App.Guide.buildHelpPrompt) ? App.Guide.buildHelpPrompt(state.ctx, '').system : '你是本 App 的使用帮助助手。';
    var brief = (App.Guide && App.Guide.contextBrief) ? App.Guide.contextBrief(state.ctx) : '';
    return base + '\n\n【本次会话上下文（系统注入，用户看不到，回答时不要逐字复述）】\n' + (brief || '（无）');
  }

  function apiHistory(state) {
    return state.dbMsgs.filter(function (m) {
      return m && (m.role === 'user' || m.role === 'ai') && m.content;
    }).slice(-12).map(function (m) {
      return { role: m.role === 'ai' ? 'assistant' : 'user', content: String(m.content) };
    });
  }

  function setSending(state, sending) {
    state.sending = !!sending;
    if (!state.sendBtn) return;
    state.sendBtn.classList.toggle('stop', !!sending);
    state.sendBtn.innerHTML = UI().icon(sending ? 'stop' : 'send');
    state.sendBtn.setAttribute('aria-label', sending ? '停止回答' : '发送问题');
  }

  function stopStreaming(state) {
    if (state.streaming && state.streaming.abort) {
      try { state.streaming.abort(); } catch (e) {}
    }
    state.streaming = null;
    setSending(state, false);
    if (state.typing) {
      var bubble = state.typing.bubble;
      bubble.classList.remove('streaming');
      if (!bubble.textContent.trim()) bubble.textContent = '（已停止）';
      state.typing = null;
    }
  }

  function send(state, text) {
    if (!state || state.closed) return Promise.resolve();
    text = String(text || '').trim();
    if (!text) return Promise.resolve();
    if (state.sending) { UI().toast('我还在回答，稍等一下'); return Promise.resolve(); }
    hideEmpty(state);
    state.input.value = '';
    state.input.style.height = 'auto';
    state.lastQuestion = text;

    appendMsg(state, 'user', text);
    state.dbMsgs.push({ role: 'user', content: text });
    saveMessage(state.sessionId, 'user', text).then(function () { return touchSession(state.sessionId); }).catch(function () {});

    return requestAnswer(state, text);
  }

  function requestAnswer(state, question) {
    if (!state || state.closed) return Promise.resolve();
    state.lastQuestion = question;
    var typing = appendTyping(state);
    state.typing = typing;
    setSending(state, true);

    return App.DB.query('providers', { where: { role: 'guide' } }).then(function (rows) {
      var provider = (rows || [])[0] || null;
      if (!provider) {
        if (state.typing) { state.typing.msg.parentNode && state.typing.msg.parentNode.removeChild(state.typing.msg); state.typing = null; }
        setSending(state, false);
        renderSetupTip(state);
        return;
      }
      var messages = [{ role: 'system', content: systemPrompt(state) }].concat(apiHistory(state));
      if (!messages.length || messages[messages.length - 1].role !== 'user') {
        messages.push({ role: 'user', content: String(question || '') });
      }
      var t = state.typing;
      var fullText = '';
      var handle = App.API.chatStream({
        provider: provider,
        model: provider.defaultModel || '',
        messages: messages,
        params: { temperature: 0.4, max_tokens: 1000 },
        timeoutMs: 120000,
        onDelta: function (piece) {
          if (!t || state.closed) return;
          fullText += piece;
          t.text = fullText;
          t.bubble.textContent = fullText;
          scrollBottom(state);
        },
        onDone: function () {
          if (state.streaming === handle) state.streaming = null;
          setSending(state, false);
          if (t) {
            t.bubble.classList.remove('streaming');
            t.bubble.textContent = fullText || '（没有返回内容，换个问法试试）';
            t.meta.textContent = '引导助手';
            state.typing = null;
          }
          if (fullText) {
            state.dbMsgs.push({ role: 'ai', content: fullText });
            saveMessage(state.sessionId, 'ai', fullText).then(function () { return touchSession(state.sessionId); }).catch(function () {});
          }
          scrollBottom(state);
        },
        onError: function (err) {
          if (state.streaming === handle) state.streaming = null;
          setSending(state, false);
          state.typing = null;
          if (t && t.msg && t.msg.parentNode) t.msg.parentNode.removeChild(t.msg);
          if (err && err.code === 'cancel') {
            if (fullText) {
              state.dbMsgs.push({ role: 'ai', content: fullText });
              saveMessage(state.sessionId, 'ai', fullText).catch(function () {});
            }
            return;
          }
          setSending(state, false);
          renderError(state, err || { code: 'unknown', message: '未知错误' }, question);
        }
      });
      state.streaming = handle;
      if (handle && handle.done) {
        handle.done.then(function (r) {
          if (r && !r.ok && r.error && r.error.code !== 'cancel') {
            /* onError 已处理，这里只兜底未触发的情况 */
            if (state.sending) {
              setSending(state, false);
              if (state.typing && state.typing.msg && state.typing.msg.parentNode) state.typing.msg.parentNode.removeChild(state.typing.msg);
              state.typing = null;
            }
          }
          return null;
        }).catch(function () { return null; });
      }
      return null;
    }).catch(function (e) {
      console.error('[help] 请求失败', e);
      setSending(state, false);
      if (state.typing && state.typing.msg && state.typing.msg.parentNode) state.typing.msg.parentNode.removeChild(state.typing.msg);
      state.typing = null;
      renderError(state, e || { code: 'unknown', message: '请求失败' }, question);
    });
  }

  /* ======================================================================
     六、清空 / 打开 / 关闭
     ====================================================================== */
  function clearHistory() {
    if (!drawer) return;
    var state = drawer;
    UI().confirm({
      title: '清空引导记录',
      message: '只清空「引导助手」的对话记录，不影响你的角色聊天记录和已完成的引导标记。',
      okText: '清空',
      danger: true
    }).then(function (yes) {
      if (!yes) return;
      stopStreaming(state);
      return App.DB.query('helpMessages', { where: { sessionId: state.sessionId } }).then(function (rows) {
        var ids = (rows || []).map(function (r) { return r.id; });
        return App.DB.delMany('helpMessages', ids);
      }).then(function () {
        return App.DB.settings.set('help_cleared_at', Date.now());
      }).then(function () {
        state.dbMsgs = [];
        UI().clear(state.list);
        state.emptyEl = null;
        renderEmpty(state, state.ctx);
        UI().toast('已清空引导记录', 'ok');
      }).catch(function (e) {
        console.warn('[help] 清空失败', e);
        UI().toast('清空失败，请稍后再试', 'error');
      });
    }).catch(function () { return null; });
  }

  function close(immediate) {
    if (!drawer) return false;
    var state = drawer;
    drawer = null;
    try { stopStreaming(state); } catch (e) {}
    state.closed = true;
    (state.cleanups || []).forEach(function (fn) { try { fn(); } catch (e) {} });
    state.cleanups = [];
    if (window.__helpWrap) window.__helpWrap = null;
    document.body.classList.remove('help-drawer-open');
    /* 抽屉关闭后让悬浮球重新出现 */
    if (App.Bubble && typeof App.Bubble.refresh === 'function') App.Bubble.refresh();
    if (immediate) {
      if (state.wrap && state.wrap.parentNode) state.wrap.parentNode.removeChild(state.wrap);
      return true;
    }
    state.wrap.classList.remove('show');
    if (state.box) state.box.style.transform = '';
    setTimeout(function () {
      if (state.wrap && state.wrap.parentNode) state.wrap.parentNode.removeChild(state.wrap);
    }, 240);
    return true;
  }

  Help.close = function () { return close(); };

  Help.isOpen = function () { return !!drawer; };

  function mount(state) {
    var root = document.getElementById('overlay-root') || document.body;
    root.appendChild(state.wrap);
    requestAnimationFrame(function () {
      if (state.closed) return;
      state.wrap.classList.add('show');
      try { state.box.style.transition = ''; state.box.style.transform = ''; } catch (e) {}
    });
    document.body.classList.add('help-drawer-open');
    /* 抽屉打开时悬浮球收起，避免遮挡 */
    if (App.Bubble && typeof App.Bubble.collapse === 'function') App.Bubble.collapse();
    if (App.Bubble && typeof App.Bubble.refresh === 'function') App.Bubble.refresh();
    /* 窗口/键盘适配 */
    try { window.dispatchEvent(new Event('resize')); } catch (e) {}
  }

  Help.open = function (opts) {
    opts = opts || {};
    ensureInit();
    var ctx = normalizeCtx(opts);
    if (drawer) close(true);

    var state = buildDrawer(ctx);
    drawer = state;
    if (window) window.__helpWrap = state.wrap;
    mount(state);

    /* 绑定会话 */
    var ready = App.DB.ready().then(function () {
      return findOrCreateSession(ctx);
    }).then(function (session) {
      state.sessionId = session.id;
      return loadMessages(session.id);
    }).then(function (rows) {
      (rows || []).forEach(function (m) {
        state.dbMsgs.push({ role: m.role === 'assistant' ? 'ai' : m.role, content: m.content });
        appendMsg(state, m.role === 'ai' || m.role === 'assistant' ? 'ai' : 'user', m.content);
      });
      if (!state.dbMsgs.length) renderEmpty(state, ctx);
      scrollBottom(state);
      /* 从报错/向导进入时自动发问：只在新会话（没有历史）时发，避免每次打开都重复提问 */
      if (!state.dbMsgs.length) {
        var auto = autoQuestion(ctx);
        if (auto && (ctx.error || ctx.stage)) send(state, auto);
      }
      return null;
    }).catch(function (e) {
      console.warn('[help] 初始化失败', e);
      renderEmpty(state, ctx);
      return null;
    });

    /* 供调用方在需要时等待 */
    state.ready = ready;
    return state;
  };

  /* ======================================================================
     七、初始化：接系统返回、ESC
     ====================================================================== */
  function ensureInit() {
    if (inited) return;
    inited = true;
    var prev = window.__handleBack;
    window.__handleBack = function () {
      try {
        if (drawer) { close(); return true; }
      } catch (e) {}
      return typeof prev === 'function' ? prev() : false;
    };
    document.addEventListener('keydown', function (ev) {
      if (!drawer) return;
      if (ev.key === 'Escape') { ev.preventDefault(); close(); }
    }, true);
  }
  Help.init = function () { ensureInit(); };

  /* ======================================================================
     八、页面 'help'：全屏静态 FAQ（离线、可搜索、分类折叠）
     ====================================================================== */
  function buildFaqPage(root, params, page) {
    var ui = UI();
    page.setTitle('使用帮助');
    var wrap = ui.el('div', { class: 'page-scroll faq-page' });

    /* 顶部说明：离线可看 + 问引导 */
    var head = ui.el('div', { class: 'faq-head' });
    head.appendChild(ui.el('div', { class: 'faq-head-title', html: ui.icon('info', 18) + '<span>这些答案保存在本机，离线也能看</span>' }));
    head.appendChild(ui.el('div', { class: 'faq-head-desc', text: '离线可看：先看静态 FAQ；仍解决不了，可以让引导助手结合当前页面和错误码回答。' }));
    var askBtn = ui.el('button', {
      class: 'btn primary small', type: 'button', text: '问引导助手',
      on: { click: function () { Help.open({ source: 'help_page', page: 'help' }); } }
    });
    head.appendChild(askBtn);
    wrap.appendChild(head);

    /* 搜索框 */
    var search = ui.el('div', { class: 'search-bar faq-search' });
    search.innerHTML = ui.icon('search');
    var searchInput = ui.el('input', {
      class: 'faq-search-input',
      attrs: { type: 'search', placeholder: '搜索问题关键词，例如 401、Base URL、备份', 'aria-label': '搜索 FAQ' }
    });
    if (params && params.q) searchInput.value = String(params.q);
    search.appendChild(searchInput);
    wrap.appendChild(search);

    var listBox = ui.el('div', { class: 'faq-groups' });
    wrap.appendChild(listBox);

    var allGroups = (App.Data && App.Data.faqGroups) ? App.Data.faqGroups() : [];
    /* 分类展开状态，默认全展开 */
    var openState = {};
    allGroups.forEach(function (g) { openState[g.category] = true; });

    var renderToken = 0;

    function matches(item, kw) {
      if (!kw) return true;
      var hay = (item.q + ' ' + item.a + ' ' + item.category).toLowerCase();
      return kw.split(/\s+/).filter(Boolean).every(function (t) { return hay.indexOf(t) >= 0; });
    }

    function render() {
      var my = ++renderToken;
      var kw = String(searchInput.value || '').trim().toLowerCase();
      UI().clear(listBox);
      var total = 0;

      allGroups.forEach(function (g) {
        var items = g.items.filter(function (it) { return matches(it, kw); });
        if (!items.length) return;
        total += items.length;

        var group = ui.el('div', { class: 'faq-group' + (openState[g.category] ? ' open' : '') });
        var groupHead = ui.el('button', {
          class: 'faq-group-head', type: 'button',
          attrs: { 'aria-expanded': openState[g.category] ? 'true' : 'false', 'aria-label': '分类：' + g.category },
          on: {
            click: function () {
              openState[g.category] = !openState[g.category];
              group.classList.toggle('open', openState[g.category]);
              groupHead.setAttribute('aria-expanded', openState[g.category] ? 'true' : 'false');
            }
          }
        });
        groupHead.appendChild(ui.el('span', { class: 'faq-group-name', text: g.category }));
        groupHead.appendChild(ui.el('span', { class: 'faq-group-count', text: String(items.length) }));
        groupHead.appendChild(ui.el('span', { class: 'faq-group-chev', html: ui.icon('chev', 16) }));
        group.appendChild(groupHead);

        var itemsBox = ui.el('div', { class: 'faq-items' });
        items.forEach(function (item, idx) {
          var itemEl = ui.el('div', { class: 'faq-item' });
          var qBtn = ui.el('button', {
            class: 'faq-q', type: 'button',
            attrs: { 'aria-expanded': 'false', 'aria-label': '问题：' + item.q },
            on: {
              click: function () {
                var open = itemEl.classList.toggle('open');
                qBtn.setAttribute('aria-expanded', open ? 'true' : 'false');
              }
            }
          });
          qBtn.appendChild(ui.el('span', { class: 'faq-q-text', text: item.q }));
          qBtn.appendChild(ui.el('span', { class: 'faq-q-chev', html: ui.icon('chev', 16) }));
          itemEl.appendChild(qBtn);
          var a = ui.el('div', { class: 'faq-a', text: item.a });
          itemEl.appendChild(a);
          itemsBox.appendChild(itemEl);
          /* 搜索时自动展开并高亮 */
          if (kw) {
            itemEl.classList.add('open');
            qBtn.setAttribute('aria-expanded', 'true');
          }
        });
        group.appendChild(itemsBox);
        listBox.appendChild(group);
      });

      if (!total) {
        listBox.appendChild(UI().empty({
          icon: 'search',
          title: '没有找到相关问题',
          desc: '换个关键词试试，或直接问引导助手。',
          actionText: '问引导助手',
          onAction: function () { Help.open({ source: 'help_page', page: 'help' }); }
        }));
      }
      if (my !== renderToken) return;
    }

    var timer = null;
    searchInput.addEventListener('input', function () {
      if (timer) clearTimeout(timer);
      timer = setTimeout(function () { timer = null; render(); }, 120);
    });
    page.onDestroy(function () {
      if (timer) clearTimeout(timer);
      timer = null;
      renderToken++; /* 让未完成的渲染失效 */
    });

    page.setActions([{ icon: 'guide', label: '问引导', onClick: function () { Help.open({ source: 'help_page', page: 'help' }); } }]);
    render();
    root.appendChild(wrap);
    return Promise.resolve();
  }

  if (App.Router && typeof App.Router.register === 'function') {
    App.Router.register('help', {
      title: '使用帮助',
      tab: false,
      build: buildFaqPage
    });
  } else {
    console.warn('[help] Router 未就绪，页面 help 注册失败');
  }

  /* 便于其它模块（错误提示、设置页）复用：直接打开抽屉且带上上下文 */
  Help.openError = function (error, pageName) {
    return Help.open({ source: 'error_hint', error: error, page: pageName });
  };
})();
