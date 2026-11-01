/* chat.js —— 聊天页（二级页，参数 {sessionId}）
   流式生成 / 停止 / 重新生成 / 继续生成 / 编辑 / 删除 / 多版本 variants / 上滑加载更早 / 断网只读
   依赖：App.Util、App.DB、App.UI、App.Router、App.API、App.ChatKit（chat-list.js 已定义） */
(function () {
  'use strict';
  var App = window.App = window.App || {};
  var U = App.Util;
  var D = App.DB;
  var K = App.ChatKit;

  /* 安全取错误中文信息 */
  function safeErrorInfo(err) {
    try {
      if (App.API && typeof App.API.errorInfo === 'function') {
        var info = App.API.errorInfo(err);
        if (info && info.title) return info;
      }
    } catch (e) { /* 忽略，走兜底 */ }
    var code = (err && err.code) || 'unknown';
    var title = (err && err.message) || '生成失败';
    return { code: code, title: title, hint: '请检查网络与 API 配置后重试。' };
  }

  function dayKey(ts) {
    var d = new Date(Number(ts) || Date.now());
    function p(n) { return n < 10 ? '0' + n : String(n); }
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
  }

  App.Router.register('chat', {
    tab: false,
    title: '聊天',
    build: function (root, params, page) {
      root.style.overflow = 'hidden';
      root.classList.add('chat-page');

      var sessionId = params && params.sessionId;
      if (!sessionId) {
        root.appendChild(App.UI.errorState({
          title: '缺少会话参数', desc: '请从聊天列表进入会话。',
          actionText: '返回', onAction: function () { App.Router.pop(); }
        }));
        return;
      }

      /* ---------------- 状态 ---------------- */
      var st = {
        sessionId: sessionId,
        session: null,
        character: null,
        persona: null,
        preset: null,
        provider: null,
        providers: [],
        messages: [],
        byId: {},
        startIndex: 0,
        hasOlder: false,
        loadingOlder: false,
        streaming: null,
        drawer: null,
        destroyed: false,
        followBottom: true,
        lastDraft: '',
        lastError: null,
        metaRefreshing: false,
        godMode: false,
        images: [],
        pendingAttach: null,
        imgCache: {}
      };

      /* ---------------- 页面骨架 ---------------- */
      var topbar = App.UI.el('div', { class: 'chat-topbar' });
      var listEl = App.UI.el('div', { class: 'msg-list chat-msg-list', attrs: { role: 'log', 'aria-live': 'polite' } });
      var noticeEl = App.UI.el('div', { class: 'chat-notice hidden' });
      var inputEl = App.UI.el('textarea', {
        class: 'composer-input',
        attrs: { rows: '1', placeholder: '发消息…', 'aria-label': '输入消息' }
      });
      var sendBtn = App.UI.el('button', { class: 'composer-send', attrs: { type: 'button' }, text: '发送' });
      // 附件按钮（相册图片 / 文件），契约 §4.1
      var attachBtn = App.UI.el('button', {
        class: 'composer-attach',
        attrs: { type: 'button', 'aria-label': '添加图片或文件', title: '添加图片或文件' },
        html: K.iconHtml('plus') || '＋'
      });
      var attachChips = App.UI.el('div', { class: 'composer-attach-chips hidden' });
      inputEl.setAttribute('data-guide-focus', 'composer');
      sendBtn.setAttribute('data-guide-tap', 'send');
      attachBtn.setAttribute('data-guide-tap', 'attach');
      var composerInputWrap = App.UI.el('div', { class: 'composer-input-wrap composer-input-col' }, attachChips, inputEl);
      var composer = App.UI.el('div', { class: 'composer' }, attachBtn, composerInputWrap, sendBtn);
      var wrap = App.UI.el('div', { class: 'chat-wrap chat-page-wrap' }, topbar, listEl, noticeEl, composer);
      root.appendChild(wrap);

      try { page.setTitle('聊天'); } catch (e) { /* 忽略 */ }
      try { inputEl.style.height = '24px'; } catch (e) { /* 忽略 */ }

      /* ---------------- 通用小工具 ---------------- */
      function msgEl(id) {
        if (!id) return null;
        return listEl.querySelector('.msg[data-id="' + id + '"]');
      }
      function findMsg(id) { return st.byId[id] || null; }
      function syncIndex() {
        st.byId = {};
        st.messages.forEach(function (m) { if (m && m.id) st.byId[m.id] = m; });
      }
      function lastMessage() { return st.messages.length ? st.messages[st.messages.length - 1] : null; }
      function persist(m) {
        if (!m) return Promise.resolve(null);
        return D.put('messages', m);
      }
      function atBottom() {
        return (listEl.scrollHeight - listEl.scrollTop - listEl.clientHeight) < 140;
      }
      function scrollToBottom(force) {
        if (force || st.followBottom) {
          listEl.scrollTop = listEl.scrollHeight;
        }
      }
      function toast(text, type) { K.toast(text, type); }

      function applyTitle() {
        var name = (st.session && st.session.title) || (st.character && st.character.name) || '聊天';
        try { page.setTitle(name); } catch (e) { /* 忽略 */ }
      }

      /* ---------------- 天气/日期分隔 + 消息元素 ---------------- */
      function buildDaySep(ts) {
        return App.UI.el('div', { class: 'chat-day', text: K.dayLabel(ts), dataset: { day: dayKey(ts) } });
      }

      // 按消息时间重排日期分隔条（保证上滑加载后不重复/不缺失）
      function normalizeDays() {
        // 只清理真正的日期分隔条（olderTip 也带 .chat-day，需保留以免被误删）
        var olds = listEl.querySelectorAll('.chat-day[data-day]');
        for (var i = olds.length - 1; i >= 0; i--) olds[i].parentNode.removeChild(olds[i]);
        var msgs = listEl.querySelectorAll('.msg');
        var prevDay = '';
        for (var j = 0; j < msgs.length; j++) {
          var node = msgs[j];
          var ts = Number(node.getAttribute('data-ts')) || 0;
          var key = dayKey(ts);
          if (key !== prevDay) {
            listEl.insertBefore(buildDaySep(ts), node);
            prevDay = key;
          }
        }
      }

      function variantCount(m) {
        return Array.isArray(m.variants) ? m.variants.length : 0;
      }

      function buildMeta(m) {
        var meta = App.UI.el('div', { class: 'msg-meta' });
        meta.appendChild(App.UI.el('span', { class: 'msg-time', text: U.fmtTime(m.createdAt) || '' }));
        if (m.role === 'assistant' && Number(m.tokensOut) > 0) {
          meta.appendChild(App.UI.el('span', { class: 'msg-tokens', text: '· ' + U.fmtTokens(m.tokensOut) + ' tokens' }));
        }
        if (m.role === 'assistant' && variantCount(m) > 1) {
          var idx = typeof m.variantIndex === 'number' ? m.variantIndex : 0;
          var swipe = App.UI.el('span', { class: 'swipe msg-variants' },
            App.UI.el('button', { class: 'msg-variant-prev', attrs: { type: 'button', 'aria-label': '上一版' }, text: '‹' }),
            App.UI.el('span', { class: 'msg-variant-idx', text: (idx + 1) + '/' + variantCount(m) }),
            App.UI.el('button', { class: 'msg-variant-next', attrs: { type: 'button', 'aria-label': '下一版' }, text: '›' })
          );
          meta.appendChild(swipe);
        }
        meta.appendChild(App.UI.el('button', { class: 'msg-op', attrs: { type: 'button', 'aria-label': '消息操作' }, text: '⋯' }));
        return meta;
      }

      function buildErrorBox(m) {
        var box = App.UI.el('div', { class: 'msg-error' });
        box.appendChild(App.UI.el('div', { class: 'msg-error-text', text: m.errorText || '生成失败，请重试' }));
        box.appendChild(App.UI.el('div', { class: 'msg-error-actions' },
          App.UI.el('button', { class: 'link msg-retry', attrs: { type: 'button' }, text: '重试' }),
          App.UI.el('button', { class: 'link msg-explain', attrs: { type: 'button' }, text: '这是什么意思？' })
        ));
        return box;
      }

      /* ---------------- 附件 / 图片库渲染（契约 §4.1 §4.2） ---------------- */
      function fmtSize(bytes) {
        var n = Number(bytes);
        if (!n || n < 0) return '';
        if (n < 1024) return n + ' B';
        if (n < 1024 * 1024) return (n / 1024).toFixed(n < 10240 ? 1 : 0) + ' KB';
        return (n / 1024 / 1024).toFixed(1) + ' MB';
      }

      function mediaApi() { return App.Media || null; }

      // 图片库记录异步获取（同一 id 只查一次，失败缓存 null）
      function imgRecord(id) {
        if (!id) return Promise.resolve(null);
        if (st.imgCache[id] !== undefined) return st.imgCache[id];
        var cached;
        try {
          var M = mediaApi();
          cached = (M && typeof M.get === 'function') ? Promise.resolve(M.get(id)) : Promise.resolve(null);
        } catch (e) {
          cached = Promise.resolve(null);
        }
        st.imgCache[id] = cached.catch(function () { return null; });
        return st.imgCache[id];
      }

      // 按 [[img:ID]] 切分内容：文本段走 K.md，图片段走图片库
      var IMG_TOKEN_RE = /\[\[img:([A-Za-z0-9_\-]+)\]\]/g;
      function splitImageTokens(text) {
        var src = String(text || '');
        var parts = [];
        var last = 0;
        var m;
        IMG_TOKEN_RE.lastIndex = 0;
        while ((m = IMG_TOKEN_RE.exec(src))) {
          if (m.index > last) parts.push({ type: 'text', text: src.slice(last, m.index) });
          parts.push({ type: 'img', id: m[1] });
          last = m.index + m[0].length;
        }
        if (last < src.length) parts.push({ type: 'text', text: src.slice(last) });
        return parts;
      }

      function buildImageNode(id) {
        var box = App.UI.el('div', { class: 'msg-image', dataset: { img: id || '' } });
        box.appendChild(App.UI.el('div', { class: 'msg-image-loading', text: '图片加载中…' }));
        imgRecord(id).then(function (rec) {
          K.clear(box);
          if (rec && rec.dataUri) {
            box.appendChild(App.UI.el('img', {
              class: 'msg-image-img',
              attrs: { src: rec.dataUri, alt: rec.name || '图片', loading: 'lazy' }
            }));
            if (rec.name) box.appendChild(App.UI.el('div', { class: 'msg-image-name', text: rec.name }));
          } else {
            box.classList.add('missing');
            box.appendChild(App.UI.el('div', { class: 'msg-image-missing', text: '图片已不可用' }));
          }
        }).catch(function () {
          K.clear(box);
          box.classList.add('missing');
          box.appendChild(App.UI.el('div', { class: 'msg-image-missing', text: '图片已不可用' }));
        });
        return box;
      }

      // 渲染助手内容（文本 + 图片混排）；无图片标记时走快路径
      function renderRichContent(container, text) {
        var src = String(text || '');
        if (src.indexOf('[[img:') === -1) {
          container.innerHTML = K.md(src);
          return;
        }
        K.clear(container);
        splitImageTokens(src).forEach(function (part) {
          if (part.type === 'img') {
            container.appendChild(buildImageNode(part.id));
            return;
          }
          if (!part.text) return;
          var box = App.UI.el('div', { class: 'md-part' });
          box.innerHTML = K.md(part.text);
          container.appendChild(box);
        });
      }

      // 用户消息的附件（图片缩略图 / 文件卡片）
      function buildAttachNode(att) {
        if (!att || !att.kind) return null;
        if (att.kind === 'image') {
          if (!att.dataUri) return null;
          var img = App.UI.el('img', {
            class: 'msg-attach-img',
            attrs: { src: att.dataUri, alt: att.name || '图片', loading: 'lazy' }
          });
          img.setAttribute('role', 'button');
          img.setAttribute('data-att', 'image');
          return img;
        }
        var card = App.UI.el('div', {
          class: 'msg-attach-file',
          attrs: { role: 'button', tabindex: '0', 'aria-label': '查看文件内容' }
        },
          App.UI.el('span', { class: 'msg-attach-file-icon', html: K.iconHtml('link') }),
          App.UI.el('span', { class: 'msg-attach-file-main' },
            App.UI.el('span', { class: 'msg-attach-file-name', text: att.name || '文件' }),
            App.UI.el('span', {
              class: 'msg-attach-file-size',
              text: fmtSize(att.size) + (att.truncated ? ' · 已截断' : '')
            })
          )
        );
        return card;
      }

      function buildBubble(m) {
        var bubble = App.UI.el('div', { class: 'msg-bubble' });
        if (m.role === 'user') {
          // 图片消息内容可能为空，只显示附件
          var hasText = String(m.content || '').trim() !== '';
          if (hasText) bubble.textContent = m.content;
          var atts = Array.isArray(m.attachments) ? m.attachments : [];
          if (atts.length) {
            bubble.classList.add('has-attach');
            if (!hasText && atts[0] && atts[0].kind === 'image') bubble.classList.add('attach-only');
            atts.forEach(function (att) {
              var node = buildAttachNode(att);
              if (node) bubble.appendChild(node);
            });
          }
        } else {
          bubble.classList.add('md');
          renderRichContent(bubble, m.content);
        }
        var streaming = m.status === 'streaming';
        if (streaming) {
          bubble.classList.add('streaming');
          if (!String(m.content || '').trim()) {
            bubble.classList.add('typing');
            bubble.innerHTML = '<span class="typing-dots"><i></i><i></i><i></i></span>';
          }
        }
        return bubble;
      }

      function buildMsg(m) {
        var isMe = m.role === 'user';
        var node = App.UI.el('div', {
          class: 'msg ' + (isMe ? 'me' : 'ai') + (m.status === 'streaming' ? ' is-streaming' : ''),
          dataset: { id: m.id, ts: String(m.createdAt || '') }
        });
        var av = K.avatarEl(isMe ? st.persona : (st.character || { name: '?' }), 'sm');
        av.classList.add('msg-avatar');
        node.appendChild(av);
        var body = App.UI.el('div', { class: 'msg-body' });
        body.appendChild(buildBubble(m));
        body.appendChild(buildMeta(m));
        if (m.status === 'error') body.appendChild(buildErrorBox(m));
        node.appendChild(body);
        return node;
      }

      function replaceMsgEl(m) {
        var old = msgEl(m.id);
        var fresh = buildMsg(m);
        if (old && old.parentNode) old.parentNode.replaceChild(fresh, old);
        else listEl.appendChild(fresh);
        normalizeDays();
      }
      function appendMsgEl(m) {
        listEl.appendChild(buildMsg(m));
        normalizeDays();
      }

      /* ---------------- 空态 ---------------- */
      function renderEmptyState() {
        K.clear(listEl);
        var card = st.character || { name: '聊天' };
        var node = App.UI.el('div', { class: 'chat-empty' },
          K.avatarEl(card, 'lg'),
          App.UI.el('div', { class: 'chat-empty-name', text: card.name || '开始聊天' }),
          App.UI.el('div', { class: 'chat-empty-tip', text: '还没有消息，发第一条消息开始对话吧' })
        );
        listEl.appendChild(node);
      }

      /* ---------------- 顶部信息条 ---------------- */
      function renderTopbar() {
        K.clear(topbar);
        var card = st.character || {};
        var left = App.UI.el('button', { class: 'chat-topbar-char', attrs: { type: 'button' } },
          App.UI.el('span', { class: 'chat-topbar-name', text: card.name || (st.session && st.session.title) || '聊天' }),
          App.UI.el('span', { class: 'chat-topbar-type', text: K.typeLabel(card.type) })
        );
        left.addEventListener('click', function () { openCharacterDrawer(); });

        var modelText = (st.session && st.session.model) || '未设置模型';
        var right = App.UI.el('button', { class: 'chat-topbar-model', attrs: { type: 'button', 'aria-label': '切换模型' } },
          App.UI.el('span', { class: 'chat-topbar-model-text', text: modelText }),
          App.UI.el('span', { class: 'chat-topbar-chev', html: K.iconHtml('chev') })
        );
        right.addEventListener('click', function () { openModelSheet(); });

        topbar.appendChild(left);
        topbar.appendChild(right);
      }

      /* ---------------- 生成中按钮状态 ---------------- */
      function setGeneratingUI(on) {
        if (on) {
          sendBtn.textContent = '停止';
          sendBtn.classList.add('stop');
          sendBtn.setAttribute('aria-label', '停止生成');
          if (attachBtn) attachBtn.classList.add('disabled');
        } else {
          sendBtn.textContent = '发送';
          sendBtn.classList.remove('stop');
          sendBtn.setAttribute('aria-label', '发送');
          if (attachBtn) attachBtn.classList.remove('disabled');
        }
      }

      /* ---------------- 引导上下文 ---------------- */
      function syncGuide() {
        try {
          page.guide({
            pageId: 'chat',
            title: '聊天 · ' + ((st.character && st.character.name) || (st.session && st.session.title) || ''),
            stage: '',
            totalSteps: 0,
            filledFields: {},
            missingFields: [],
            error: st.lastError ? { code: st.lastError.code || 'unknown', message: st.lastError.message || '' } : null
          });
        } catch (e) { /* 忽略 */ }
      }

      /* ---------------- 消息窗口渲染（只渲染最后 N 条） ---------------- */
      function renderMessagesInitial() {
        K.clear(listEl);
        var total = st.messages.length;
        if (!total) {
          st.startIndex = 0;
          st.hasOlder = false;
          renderEmptyState();
          updateOlderTip();
          return;
        }
        var start = Math.max(0, total - K.PAGE_SIZE);
        st.startIndex = start;
        st.hasOlder = start > 0;
        var frag = document.createDocumentFragment();
        for (var i = start; i < total; i++) frag.appendChild(buildMsg(st.messages[i]));
        listEl.appendChild(frag);
        normalizeDays();
        updateOlderTip();
      }

      /* ---------------- 上滑加载更早（每次 30 条，保留滚动位置） ---------------- */
      var olderTip = null;
      function updateOlderTip() {
        if (!st.hasOlder) {
          if (olderTip && olderTip.parentNode) olderTip.parentNode.removeChild(olderTip);
          olderTip = null;
          return;
        }
        if (!olderTip) {
          olderTip = App.UI.el('div', { class: 'chat-older-tip chat-day', text: '上滑加载更早消息' });
        }
        if (olderTip.parentNode !== listEl) listEl.insertBefore(olderTip, listEl.firstChild);
      }

      function loadOlder() {
        if (st.loadingOlder || !st.hasOlder) return;
        st.loadingOlder = true;
        if (olderTip) olderTip.textContent = '正在加载…';
        setTimeout(function () {
          if (st.destroyed) { st.loadingOlder = false; return; }
          var oldHeight = listEl.scrollHeight;
          var oldTop = listEl.scrollTop;
          var from = Math.max(0, st.startIndex - K.OLDER_PAGE_SIZE);
          var frag = document.createDocumentFragment();
          for (var i = from; i < st.startIndex; i++) frag.appendChild(buildMsg(st.messages[i]));
          var anchor = olderTip && olderTip.parentNode === listEl ? olderTip.nextSibling : listEl.firstChild;
          listEl.insertBefore(frag, anchor);
          st.startIndex = from;
          st.hasOlder = from > 0;
          normalizeDays();
          updateOlderTip();
          listEl.scrollTop = oldTop + (listEl.scrollHeight - oldHeight);
          st.loadingOlder = false;
          if (olderTip) olderTip.textContent = '上滑加载更早消息';
        }, 30);
      }

      /* ---------------- 变体（多版本） ---------------- */
      function ensureVariants(m) {
        if (!Array.isArray(m.variants)) m.variants = [];
        if (!m.variants.length) {
          m.variants.push({ content: m.content || '', createdAt: m.createdAt || U.now() });
        }
        if (typeof m.variantIndex !== 'number' || m.variantIndex < 0) m.variantIndex = 0;
        if (m.variantIndex >= m.variants.length) m.variantIndex = m.variants.length - 1;
        return m.variants;
      }
      // 契约：variants 元素固定为 { content, createdAt }
      function writeVariant(m, content) {
        if (!Array.isArray(m.variants)) m.variants = [];
        var idx = typeof m.variantIndex === 'number' ? m.variantIndex : 0;
        if (!m.variants.length) {
          m.variants.push({ content: content, createdAt: U.now() });
          m.variantIndex = 0;
        } else {
          if (idx < 0 || idx >= m.variants.length) idx = m.variants.length - 1;
          m.variants[idx] = { content: content, createdAt: U.now() };
          m.variantIndex = idx;
        }
      }
      function switchVariant(m, dir) {
        if (st.streaming) { toast('正在生成，请先停止'); return; }
        ensureVariants(m);
        if (m.variants[m.variantIndex]) m.variants[m.variantIndex].content = m.content || '';
        var next = m.variantIndex + dir;
        if (next < 0 || next >= m.variants.length) return;
        m.variantIndex = next;
        m.content = (m.variants[next] && m.variants[next].content) || '';
        m.status = 'ok';
        m.errorText = '';
        m.errorCode = '';
        persist(m).then(function () {
          replaceMsgEl(m);
          return K.touchSession(sessionId, lastMessage());
        }).catch(function (err) {
          console.error('[chat] 切换版本失败', err);
          toast('切换版本失败', 'error');
        });
      }

      /* ---------------- 流式生成核心 ---------------- */
      function applyStreaming(s) {
        var node = msgEl(s.target.id);
        if (!node) return;
        var bubble = node.querySelector('.msg-bubble');
        if (!bubble) return;
        if (s.target.role === 'user') {
          bubble.textContent = s.target.content;
        } else if (String(s.target.content || '').trim()) {
          // 空内容（或只有空白）时保留「正在输入」动画，避免气泡被 :empty 规则隐藏
          renderRichContent(bubble, s.target.content);
          bubble.classList.remove('typing');
        }
        bubble.classList.add('streaming');
        if (st.followBottom) scrollToBottom(true);
      }

      function finalizeOk(s, content, usage) {
        if (s.discard) return;
        if (st.streaming !== s) return;
        st.streaming = null;
        var target = s.target;
        content = String(content === undefined || content === null ? '' : content);
        target.content = content;
        writeVariant(target, content, usage);
        var u = usage || {};
        target.tokensIn = Number(u.prompt_tokens || u.input_tokens || s.ctxTokens) || target.tokensIn || 0;
        target.tokensOut = Number(u.completion_tokens || u.output_tokens) || U.estimateTokens(content);
        if (content.trim()) {
          target.status = 'ok';
          target.errorText = '';
          target.errorCode = '';
        } else {
          // 空内容（一生成就停止/接口没返回内容）按失败处理，避免留下空气泡
          target.status = 'error';
          target.errorText = s.stopped ? '已停止生成，本次没有产生内容，可点重试。' : '没有收到任何内容，请重试。';
          target.errorCode = s.stopped ? 'cancel' : 'unknown';
        }
        setGeneratingUI(false);
        K.setGenerating(sessionId, false);
        st.lastError = target.status === 'error'
          ? { code: target.errorCode || 'unknown', message: target.errorText }
          : null;
        persist(target).then(function () {
          if (st.destroyed) return null;
          replaceMsgEl(target);
          if (st.followBottom) scrollToBottom(true);
          return K.touchSession(sessionId, lastMessage());
        }).catch(function (err) {
          console.error('[chat] 保存生成结果失败', err);
          toast('内容保存失败，请重试', 'error');
        });
        syncGuide();
      }

      function finalizeError(s, err) {
        if (s.discard) return;
        if (st.streaming !== s) return;
        st.streaming = null;
        var target = s.target;
        var info = safeErrorInfo(err);
        target.status = 'error';
        target.errorText = info.title + (info.hint ? '：' + info.hint : '') +
          (err && err.message && info.code === 'unknown' ? '（' + err.message + '）' : '');
        target.errorCode = info.code;
        setGeneratingUI(false);
        K.setGenerating(sessionId, false);
        st.lastError = { code: info.code, message: info.title };
        persist(target).then(function () {
          if (st.destroyed) return;
          replaceMsgEl(target);
        }).catch(function () { /* 忽略 */ });
        syncGuide();
        toast(info.title, 'error');
      }

      function failTarget(target, err) {
        var info = safeErrorInfo(err);
        target.status = 'error';
        target.errorText = info.title + (info.hint ? '：' + info.hint : '');
        target.errorCode = info.code;
        if (!target.content) target.content = '';
        setGeneratingUI(false);
        K.setGenerating(sessionId, false);
        st.lastError = { code: info.code, message: info.title };
        persist(target).then(function () {
          if (st.destroyed) return;
          replaceMsgEl(target);
        }).catch(function () { /* 忽略 */ });
        syncGuide();
        toast(info.title, 'error');
        return null;
      }

      // 发起一次流式请求。opts: {target, history, mode:'new'|'regen'|'continue'}
      function requestStream(opts) {
        var target = opts.target;
        if (st.streaming) { toast('正在生成，请先停止'); return Promise.resolve(); }
        if (st.destroyed) return Promise.resolve();
        if (!st.character) {
          return Promise.resolve(failTarget(target, { code: 'unknown', message: '会话角色已被删除，无法继续聊天', title: '无法发送' }));
        }
        var provider = st.provider;
        var model = (st.session && st.session.model) || (provider && (provider.defaultModel || (provider.models && provider.models[0]))) || '';
        if (!provider) {
          return Promise.resolve(failTarget(target, { code: 'unknown', message: '还没有配置聊天 API，请先到「API 管理」添加', title: '未配置 API' }));
        }
        if (!model) {
          return Promise.resolve(failTarget(target, { code: 'unknown', message: '当前 API 没有可用模型，请点顶部模型名称切换', title: '未选择模型' }));
        }
        var ready = null;
        try {
          if (App.API && typeof App.API.checkProviderReady === 'function') ready = App.API.checkProviderReady(provider);
        } catch (e) { ready = { ok: false, reason: (e && e.message) || 'API 配置异常' }; }
        if (ready && ready.ok === false) {
          return Promise.resolve(failTarget(target, { code: 'unknown', message: ready.reason || 'API 配置不完整', title: 'API 配置不完整' }));
        }

        var history = (opts.history || []).slice();
        if (opts.mode === 'continue') {
          history.push({ role: 'user', content: '（请接着你上一条回复继续写下去，不要重复已经写过的内容。）' });
        }
        var ctx;
        try {
          ctx = K.buildContext({
            character: st.character,
            persona: st.persona,
            preset: st.preset,
            messages: history,
            godMode: st.godMode === true,
            images: st.images
          });
        } catch (e) {
          return Promise.resolve(failTarget(target, { code: 'unknown', message: '上下文组装失败：' + ((e && e.message) || ''), title: '生成失败' }));
        }
        var params = K.paramsOf(st.preset);
        var s = {
          target: target,
          handle: null,
          stopped: false,
          generated: '',
          base: opts.mode === 'continue' ? String(target.content || '') : '',
          mode: opts.mode,
          ctxTokens: ctx.usedTokens,
          startedAt: U.now(),
          pending: false
        };
        st.streaming = s;
        target.status = 'streaming';
        target.errorText = '';
        target.errorCode = '';
        K.setGenerating(sessionId, true);
        setGeneratingUI(true);
        replaceMsgEl(target);
        var save = U.throttle(function () {
          if (st.streaming === s && !s.discard) persist(target).catch(function () { /* 节流落库失败可容忍 */ });
        }, 600);
        function schedule() {
          if (s.pending) return;
          s.pending = true;
          U.raf(function () {
            s.pending = false;
            if (st.streaming !== s) return;
            applyStreaming(s);
          });
        }
        try {
          s.handle = App.API.chatStream({
            provider: provider,
            model: model,
            messages: ctx.messages,
            params: params,
            onDelta: function (chunk) {
              if (typeof chunk !== 'string' || !chunk || st.streaming !== s) return;
              s.generated += chunk;
              target.content = s.base + s.generated;
              schedule();
              save();
            },
            onDone: function (res) {
              if (st.streaming !== s) return;
              var text = res && typeof res.text === 'string' ? res.text : '';
              var finalText = s.base + (text || s.generated);
              finalizeOk(s, finalText, res && res.usage);
            },
            onError: function (err) {
              if (st.streaming !== s) return;
              if (s.stopped || (err && (err.code === 'cancel' || err.code === 'aborted'))) {
                finalizeOk(s, target.content, null);
              } else {
                finalizeError(s, err);
              }
            }
          });
        } catch (e) {
          finalizeError(s, { code: 'unknown', message: (e && e.message) || '请求失败' });
        }
        scrollToBottom(true);
        return Promise.resolve();
      }

      function stopStream() {
        var s = st.streaming;
        if (!s) return;
        s.stopped = true;
        try { if (s.handle && typeof s.handle.abort === 'function') s.handle.abort(); } catch (e) { /* 忽略 */ }
        // 兜底：若 abort 没有回调，500ms 后强制保留已生成内容收尾
        setTimeout(function () {
          if (st.streaming === s) finalizeOk(s, s.target.content, null);
        }, 600);
      }

      /* ---------------- 附件选择（契约 §4.1） ---------------- */
      // 输入框上方的待发送附件 chip
      function renderAttachChips() {
        if (!attachChips) return;
        K.clear(attachChips);
        var att = st.pendingAttach;
        if (!att) {
          attachChips.classList.add('hidden');
          return;
        }
        attachChips.classList.remove('hidden');
        var chip = App.UI.el('div', { class: 'composer-attach-chip' });
        if (att.kind === 'image' && att.dataUri) {
          chip.appendChild(App.UI.el('img', {
            class: 'composer-attach-thumb',
            attrs: { src: att.dataUri, alt: att.name || '图片' }
          }));
        } else {
          chip.appendChild(App.UI.el('span', { class: 'composer-attach-fileicon', html: K.iconHtml('link') }));
        }
        chip.appendChild(App.UI.el('span', {
          class: 'composer-attach-name',
          text: att.name || (att.kind === 'image' ? '图片' : '文件')
        }));
        var remove = App.UI.el('button', {
          class: 'composer-attach-remove',
          attrs: { type: 'button', 'aria-label': '移除附件' },
          text: '×'
        });
        remove.addEventListener('click', function (ev) {
          ev.preventDefault();
          ev.stopPropagation();
          st.pendingAttach = null;
          renderAttachChips();
        });
        chip.appendChild(remove);
        attachChips.appendChild(chip);
      }

      function pickAttachImage() {
        var M = mediaApi();
        if (!M || typeof M.pickImage !== 'function') {
          toast('当前版本不支持发送图片', 'error');
          return Promise.resolve();
        }
        var p;
        try { p = M.pickImage(); } catch (e) { p = Promise.reject(e); }
        return Promise.resolve(p).then(function (att) {
          if (!att) return null;
          if (!att.kind) att.kind = 'image';
          if (!att.dataUri) { toast('图片读取失败，请重试', 'error'); return null; }
          st.pendingAttach = att;
          renderAttachChips();
          try { inputEl.focus(); } catch (e) { /* 忽略 */ }
          return null;
        }).catch(function (err) {
          console.error('[chat] 选择图片失败', err);
          toast((err && err.message) || '图片读取失败，未添加', 'error');
          return null;
        });
      }

      function pickAttachFile() {
        var M = mediaApi();
        if (!M || typeof M.pickFile !== 'function') {
          toast('当前版本不支持发送文件', 'error');
          return Promise.resolve();
        }
        var p;
        try { p = M.pickFile(); } catch (e) { p = Promise.reject(e); }
        return Promise.resolve(p).then(function (att) {
          if (!att) return null;
          if (!att.kind) att.kind = 'file';
          if (!String(att.text || '').trim()) { toast('这个文件没有可读取的文本内容', 'error'); return null; }
          st.pendingAttach = att;
          renderAttachChips();
          try { inputEl.focus(); } catch (e) { /* 忽略 */ }
          return null;
        }).catch(function (err) {
          console.error('[chat] 选择文件失败', err);
          toast((err && err.message) || '文件读取失败，未添加', 'error');
          return null;
        });
      }

      function openAttachSheet() {
        if (st.streaming) { toast('生成中不能添加附件，请先停止'); return; }
        var M = mediaApi();
        if (!M || typeof M.pickImage !== 'function') {
          toast('当前版本不支持发送图片或文件', 'error');
          return;
        }
        K.sheet({
          title: '添加附件',
          items: [
            { id: 'image', label: '相册图片', desc: '选一张图发给 TA（会自动压缩）', icon: 'star' },
            { id: 'file', label: '文件', desc: '文本类文件内容会作为文本发给模型', icon: 'link' }
          ]
        }).then(function (item) {
          var id = K.itemId(item);
          if (id === 'image') return pickAttachImage();
          if (id === 'file') return pickAttachFile();
          return null;
        }).catch(function (err) {
          console.error('[chat] 打开附件菜单失败', err);
        });
      }

      /* ---------------- 图片 / 文件预览 ---------------- */
      function previewDataUri(dataUri, name) {
        if (!dataUri) { toast('图片已不可用', 'error'); return; }
        var M = mediaApi();
        if (M && typeof M.preview === 'function') {
          try { M.preview(dataUri, { name: name || '' }); return; } catch (e) { /* 回退自绘 */ }
        }
        try {
          App.UI.modal({
            title: name || '图片',
            content: App.UI.el('img', { class: 'msg-image-full', attrs: { src: dataUri, alt: name || '图片' } }),
            actions: [{ text: '关闭' }]
          });
        } catch (e) { /* 忽略 */ }
      }

      function previewAttachment(att) {
        if (!att) return;
        if (att.kind === 'file') { openFileTextModal(att); return; }
        if (att.kind === 'image') previewDataUri(att.dataUri, att.name);
      }

      function previewLibraryImage(id) {
        imgRecord(id).then(function (rec) {
          if (!rec || !rec.dataUri) { toast('图片已不可用', 'error'); return; }
          var M = mediaApi();
          if (M && typeof M.preview === 'function') {
            try { M.preview(rec); return; } catch (e) { /* 回退自绘 */ }
          }
          previewDataUri(rec.dataUri, rec.name);
        }).catch(function () { toast('图片已不可用', 'error'); });
      }

      function openFileTextModal(att) {
        if (!att) return;
        var meta = (att.name || '文件') + (att.size ? ' · ' + fmtSize(att.size) : '') + (att.truncated ? ' · 已截断' : '');
        var wrap = App.UI.el('div', { class: 'msg-file-modal' },
          App.UI.el('div', { class: 'msg-file-meta', text: meta }),
          App.UI.el('pre', { class: 'msg-file-text', text: String(att.text || '（没有可显示的内容）') })
        );
        try {
          App.UI.modal({ title: '文件内容', content: wrap, alignLeft: true, actions: [{ text: '关闭' }] });
        } catch (e) {
          toast('打不开文件内容', 'error');
        }
      }

      /* ---------------- 发送 / 重新生成 / 继续生成 ---------------- */
      function lastAssistant() {
        var last = lastMessage();
        return last && last.role === 'assistant' ? last : null;
      }

      function send() {
        if (st.streaming) { stopStream(); return; }
        var text = String(inputEl.value || '').replace(/\s+$/, '');
        var attach = st.pendingAttach || null;
        if (!text.trim() && !attach) { toast('请输入内容或添加附件'); return; }
        if (typeof navigator !== 'undefined' && navigator.onLine === false) {
          toast('网络不可用，消息未发送', 'error');
          return;
        }
        if (!st.character) { toast('会话角色已被删除，无法继续聊天', 'error'); return; }
        st.lastDraft = text;
        st.pendingAttach = null;
        renderAttachChips();
        inputEl.value = '';
        autosize();
        var userMsg = {
          sessionId: sessionId,
          role: 'user',
          content: text,
          attachments: attach ? [attach] : [],
          variantIndex: 0,
          isActive: true,
          status: 'ok',
          errorText: '',
          errorCode: '',
          tokensIn: 0,
          tokensOut: 0,
          createdAt: U.now()
        };
        D.put('messages', userMsg).then(function (rec) {
          st.messages.push(rec);
          syncIndex();
          appendMsgEl(rec);
          st.followBottom = true;
          scrollToBottom(true);
          return K.touchSession(sessionId, rec);
        }).then(function () {
          return createReplyFor(st.messages[st.messages.length - 1]);
        }).catch(function (err) {
          console.error('[chat] 发送失败', err);
          // 用户消息都没落库成功：把文本与附件还回输入区
          if (!inputEl.value) inputEl.value = st.lastDraft;
          if (attach && !st.pendingAttach) st.pendingAttach = attach;
          renderAttachChips();
          autosize();
          toast('发送失败：' + ((err && err.message) || '未知错误'), 'error');
        });
      }

      function createReplyFor(userMsg) {
        var history = st.messages.slice(); // 含刚保存的用户消息
        var placeholder = {
          sessionId: sessionId,
          role: 'assistant',
          content: '',
          variantIndex: 0,
          isActive: true,
          status: 'streaming',
          errorText: '',
          errorCode: '',
          tokensIn: 0,
          tokensOut: 0,
          createdAt: U.now()
        };
        return D.put('messages', placeholder).then(function (rec) {
          st.messages.push(rec);
          syncIndex();
          appendMsgEl(rec);
          st.followBottom = true;
          scrollToBottom(true);
          return requestStream({ target: rec, history: history, mode: 'new' });
        });
      }

      function regenerate(target) {
        if (st.streaming) { toast('正在生成，请先停止'); return; }
        var idx = st.messages.indexOf(target);
        if (idx < 0) return;
        var history = st.messages.slice(0, idx);
        var hasUser = false;
        history.forEach(function (m) { if (m.role === 'user' && String(m.content || '').trim()) hasUser = true; });
        if (!hasUser) { toast('没有可用的对话历史'); return; }
        ensureVariants(target);
        if (target.variants[target.variantIndex]) target.variants[target.variantIndex].content = target.content || '';
        target.variants.push({ content: '', createdAt: U.now() });
        target.variantIndex = target.variants.length - 1;
        target.content = '';
        target.status = 'streaming';
        target.errorText = '';
        target.errorCode = '';
        persist(target).then(function () {
          if (st.destroyed) return;
          replaceMsgEl(target);
          return requestStream({ target: target, history: history, mode: 'regen' });
        }).catch(function (err) {
          console.error('[chat] 重新生成失败', err);
          toast('重新生成失败', 'error');
        });
      }

      function continueGeneration(target) {
        if (st.streaming) { toast('正在生成，请先停止'); return; }
        if (!target || target !== lastMessage() || target.role !== 'assistant') {
          toast('只能在最后一条回复上继续生成');
          return;
        }
        if (!String(target.content || '').trim()) { toast('这条回复还没有内容'); return; }
        ensureVariants(target);
        if (target.variants[target.variantIndex]) target.variants[target.variantIndex].content = target.content || '';
        var idx = st.messages.indexOf(target);
        var history = st.messages.slice(0, idx + 1); // 包含最后一条 assistant 内容
        requestStream({ target: target, history: history, mode: 'continue' });
      }

      function retryMessage(target) {
        if (st.streaming) { toast('正在生成，请先停止'); return; }
        if (target.status !== 'error') return;
        var idx = st.messages.indexOf(target);
        if (idx < 0) return;
        if (target.role !== 'assistant') { toast('用户消息无法重试，请重新发送'); return; }
        var history = st.messages.slice(0, idx);
        var hasUser = false;
        history.forEach(function (m) { if (m.role === 'user' && String(m.content || '').trim()) hasUser = true; });
        if (!hasUser) { toast('没有可用的对话历史'); return; }
        target.content = '';
        target.status = 'streaming';
        target.errorText = '';
        target.errorCode = '';
        if (!Array.isArray(target.variants)) target.variants = [];
        if (target.variants.length) {
          var vi = typeof target.variantIndex === 'number' ? target.variantIndex : 0;
          if (vi < 0 || vi >= target.variants.length) vi = target.variants.length - 1;
          target.variantIndex = vi;
          target.variants[vi] = { content: '', createdAt: U.now() };
        }
        persist(target).then(function () {
          if (st.destroyed) return;
          replaceMsgEl(target);
          return requestStream({ target: target, history: history, mode: 'regen' });
        }).catch(function (err) {
          console.error('[chat] 重试失败', err);
          toast('重试失败', 'error');
        });
      }

      /* ---------------- 消息操作 ---------------- */
      function copyMessage(m) {
        U.copyText(m.content || '').then(function (ok) {
          toast(ok ? '已复制' : '复制失败', ok ? 'ok' : 'error');
        }).catch(function () { toast('复制失败', 'error'); });
      }

      function editMessage(m) {
        K.prompt({
          title: '编辑消息',
          message: m.role === 'assistant' ? '修改 AI 回复内容' : '修改你的消息',
          value: m.content || '',
          multiline: true,
          okText: '保存',
          cancelText: '取消'
        }).then(function (val) {
          if (val === null) return;
          var text = val;
          if (!String(text).trim()) { toast('内容不能为空'); return; }
          ensureVariants(m);
          m.content = text;
          m.status = 'ok';
          m.errorText = '';
          m.errorCode = '';
          if (m.role === 'assistant' && m.variants[m.variantIndex]) {
            m.variants[m.variantIndex].content = text;
          }
          return persist(m).then(function () {
            if (st.destroyed) return null;
            replaceMsgEl(m);
            return K.touchSession(sessionId, lastMessage());
          }).then(function () {
            if (m.role === 'user') return maybeRegenerateAfterEdit(m);
            return null;
          });
        }).catch(function (err) {
          console.error('[chat] 编辑失败', err);
          toast('编辑失败', 'error');
        });
      }

      function maybeRegenerateAfterEdit(userMsg) {
        var idx = st.messages.indexOf(userMsg);
        if (idx < 0) return null;
        var after = st.messages.slice(idx + 1);
        if (!after.length) return null;
        return K.confirm({
          title: '重新生成回复',
          message: '这条消息之后已有回复，是否基于新内容重新生成？',
          okText: '重新生成',
          cancelText: '保留原回复'
        }).then(function (ok) {
          if (!ok) return null;
          var ids = after.map(function (m) { return m.id; });
          return D.delMany('messages', ids).then(function () {
            st.messages = st.messages.filter(function (m) { return ids.indexOf(m.id) < 0; });
            syncIndex();
            renderMessagesInitial();
            scrollToBottom(true);
            return createReplyFor(userMsg);
          });
        });
      }

      function deleteMessage(m) {
        K.confirm({ title: '删除消息', message: '删除后不可恢复，确定删除这条消息吗？', okText: '删除', danger: true }).then(function (ok) {
          if (!ok) return;
          return D.del('messages', m.id).then(function () {
            st.messages = st.messages.filter(function (x) { return x.id !== m.id; });
            syncIndex();
            var node = msgEl(m.id);
            if (node && node.parentNode) node.parentNode.removeChild(node);
            normalizeDays();
            if (!st.messages.length) renderEmptyState();
            return K.touchSession(sessionId, lastMessage());
          }).then(function () { toast('已删除', 'ok'); });
        }).catch(function (err) {
          console.error('[chat] 删除消息失败', err);
          toast('删除失败', 'error');
        });
      }

      function openErrorHelp(m) {
        try {
          if (App.Help && typeof App.Help.open === 'function') {
            App.Help.open({ source: 'error_hint', page: 'chat', error: { code: m.errorCode || 'unknown', message: m.errorText || '' } });
          } else {
            toast('帮助面板尚未就绪');
          }
        } catch (e) {
          toast('打开帮助失败', 'error');
        }
      }

      function openMsgMenu(m) {
        var items = [
          { id: 'copy', value: 'copy', label: '复制', icon: 'copy' },
          { id: 'edit', value: 'edit', label: '编辑内容', icon: 'edit' }
        ];
        if (m.role === 'assistant') {
          items.push({ id: 'regen', value: 'regen', label: '重新生成', icon: 'refresh' });
          if (m === lastMessage()) items.push({ id: 'continue', value: 'continue', label: '继续生成', icon: 'play' });
        }
        items.push({ id: 'delete', value: 'delete', label: '删除消息', icon: 'delete', danger: true });
        K.sheet({ title: '消息操作', items: items, cancelText: '取消' }).then(function (item) {
          var act = K.itemId(item);
          if (!act) return;
          if (act === 'copy') return copyMessage(m);
          if (act === 'edit') return editMessage(m);
          if (act === 'regen') return regenerate(m);
          if (act === 'continue') return continueGeneration(m);
          if (act === 'delete') return deleteMessage(m);
          return null;
        }).catch(function (err) { console.error('[chat] 消息菜单出错', err); });
      }

      /* ---------------- 会话菜单 / 重命名 / 切模型 / 生成设置 ---------------- */
      function renameSession() {
        return K.prompt({
          title: '重命名会话',
          value: (st.session && st.session.title) || '',
          placeholder: '会话名称',
          okText: '保存'
        }).then(function (name) {
          if (name === null) return;
          var title = String(name).trim();
          if (!title) { toast('名称不能为空'); return; }
          st.session.title = title;
          return D.put('sessions', st.session).then(function () {
            applyTitle();
            toast('已重命名', 'ok');
          });
        }).catch(function (err) {
          console.error('[chat] 重命名失败', err);
          toast('重命名失败', 'error');
        });
      }

      function findProvider(id) {
        var found = null;
        (st.providers || []).forEach(function (p) { if (!found && p.id === id) found = p; });
        return found;
      }

      function openModelSheet() {
        D.all('providers').then(function (list) {
          st.providers = list || [];
          if (!st.providers.length) {
            return K.confirm({
              title: '还没有可用的 API',
              message: '请先在「API 管理」中添加聊天 API，再来切换模型。',
              okText: '去添加',
              cancelText: '取消'
            }).then(function (ok) {
              if (ok) return App.Router.push('apiList');
              return null;
            });
          }
          var items = st.providers.map(function (p) {
            var current = st.session && st.session.providerId === p.id ? ' ✓' : '';
            return {
              id: 'p:' + p.id, value: 'p:' + p.id,
              label: (p.name || p.baseUrl || '未命名 API') + current,
              desc: (p.role === 'guide' ? '引导 API' : '聊天 API') + ' · ' + (p.defaultModel || (p.models && p.models[0]) || '未设置模型')
            };
          });
          return K.sheet({ title: '切换模型 / API', items: items, cancelText: '取消' }).then(function (item) {
            var id = K.itemId(item);
            if (!id) return null;
            var pid = id.indexOf('p:') === 0 ? id.slice(2) : id;
            var provider = findProvider(pid);
            if (!provider) return null;
            return chooseModel(provider);
          });
        }).catch(function (err) {
          console.error('[chat] 加载 API 列表失败', err);
          toast('加载 API 列表失败', 'error');
        });
      }

      function chooseModel(provider) {
        var models = (provider.models || []).slice();
        var items = models.map(function (model) {
          return { id: 'm:' + model, value: 'm:' + model, label: model, desc: '模型' };
        });
        items.push({ id: 'm:__custom__', value: 'm:__custom__', label: '手动输入模型名…', icon: 'edit' });
        return K.sheet({ title: '选择模型 · ' + (provider.name || ''), items: items, cancelText: '取消' }).then(function (item) {
          var id = K.itemId(item);
          if (!id) return null;
          if (id === 'm:__custom__') {
            return K.prompt({
              title: '输入模型名',
              value: (st.session && st.session.model) || provider.defaultModel || '',
              placeholder: '如 deepseek-chat',
              okText: '确定'
            }).then(function (val) {
              if (val === null) return null;
              var model = String(val).trim();
              if (!model) { toast('模型名不能为空'); return null; }
              return applyModel(provider, model);
            });
          }
          var model = id.indexOf('m:') === 0 ? id.slice(2) : id;
          return applyModel(provider, model);
        });
      }

      function applyModel(provider, model) {
        if (!st.session) return null;
        st.session.providerId = provider.id;
        st.session.model = model;
        st.provider = provider;
        return D.put('sessions', st.session).then(function () {
          renderTopbar();
          toast('已切换为 ' + (provider.name || '') + ' · ' + model, 'ok');
        }).catch(function (err) {
          console.error('[chat] 切换模型失败', err);
          toast('切换模型失败', 'error');
        });
      }

      function openGenSettings() {
        App.Router.push('presetEdit', { sessionId: sessionId }).catch(function (err) {
          console.error('[chat] 打开预设编辑失败', err);
          toast('打开生成设置失败', 'error');
        });
      }

      function clearMessages() {
        K.confirm({
          title: '清空消息',
          message: '确定清空本会话的全部消息吗？此操作不可恢复。',
          okText: '清空',
          danger: true
        }).then(function (ok) {
          if (!ok) return;
          // 正在生成：直接放弃本次流（丢弃结果，不落库，避免清空后又被写回一条）
          if (st.streaming) {
            var s0 = st.streaming;
            s0.discard = true;
            s0.stopped = true;
            try { if (s0.handle && typeof s0.handle.abort === 'function') s0.handle.abort(); } catch (e) { /* 忽略 */ }
            st.streaming = null;
            setGeneratingUI(false);
            K.setGenerating(sessionId, false);
          }
          return D.byIndex('messages', 'sessionId', sessionId).then(function (msgs) {
            return D.delMany('messages', (msgs || []).map(function (m) { return m.id; }));
          }).then(function () {
            st.messages = [];
            syncIndex();
            st.startIndex = 0;
            st.hasOlder = false;
            K.clear(listEl);
            renderEmptyState();
            st.session.lastText = '';
            st.session.lastRole = '';
            st.session.lastAt = 0;
            st.session.updatedAt = U.now();
            return D.put('sessions', st.session);
          }).then(function () { toast('已清空消息', 'ok'); });
        }).catch(function (err) {
          console.error('[chat] 清空消息失败', err);
          toast('清空失败', 'error');
        });
      }

      function deleteSession() {
        K.confirm({
          title: '删除会话',
          message: '将删除该会话及其全部消息，不可恢复。确定删除吗？',
          okText: '删除',
          danger: true
        }).then(function (ok) {
          if (!ok) return;
          if (st.streaming) {
            var s1 = st.streaming;
            s1.discard = true;
            s1.stopped = true;
            try { if (s1.handle && typeof s1.handle.abort === 'function') s1.handle.abort(); } catch (e) { /* 忽略 */ }
            st.streaming = null;
          }
          K.setGenerating(sessionId, false);
          return D.byIndex('messages', 'sessionId', sessionId).then(function (msgs) {
            return D.delMany('messages', (msgs || []).map(function (m) { return m.id; }));
          }).then(function () {
            return D.del('sessions', sessionId);
          }).then(function () {
            st.destroyed = true;
            toast('已删除会话', 'ok');
            var popped = false;
            try { popped = App.Router.pop(); } catch (e) { popped = false; }
            if (!popped) { try { App.Router.goChatList(); } catch (e2) { /* 忽略 */ } }
          });
        }).catch(function (err) {
          console.error('[chat] 删除会话失败', err);
          toast('删除失败', 'error');
        });
      }

      function openSessionMenu() {
        K.sheet({
          title: (st.session && st.session.title) || '会话操作',
          items: [
            { id: 'rename', value: 'rename', label: '重命名会话', icon: 'edit' },
            { id: 'model', value: 'model', label: '切换模型 / API', icon: 'api' },
            { id: 'gen', value: 'gen', label: '生成设置（预设）', icon: 'settings' },
            { id: 'char', value: 'char', label: '角色信息', icon: 'character' },
            { id: 'clear', value: 'clear', label: '清空消息', icon: 'trash' },
            { id: 'delete', value: 'delete', label: '删除会话', icon: 'delete', danger: true }
          ],
          cancelText: '取消'
        }).then(function (item) {
          var act = K.itemId(item);
          if (!act) return;
          if (act === 'rename') return renameSession();
          if (act === 'model') return openModelSheet();
          if (act === 'gen') return openGenSettings();
          if (act === 'char') return openCharacterDrawer();
          if (act === 'clear') return clearMessages();
          if (act === 'delete') return deleteSession();
          return null;
        }).catch(function (err) { console.error('[chat] 会话菜单出错', err); });
      }

      /* ---------------- 角色信息抽屉 ---------------- */
      function joinText(v) {
        if (Array.isArray(v)) return v.filter(Boolean).join('、');
        return String(v || '');
      }

      function openCharacterDrawer() {
        if (!st.character) { toast('该会话的角色已被删除'); return; }
        closeDrawer();
        var mask = App.UI.el('div', { class: 'chat-drawer-mask' });
        var drawer = App.UI.el('div', { class: 'chat-drawer', attrs: { role: 'dialog', 'aria-label': '角色信息' } });
        var wv = st.character.worldviewSnapshot || {};

        var head = App.UI.el('div', { class: 'chat-drawer-head' },
          K.avatarEl(st.character, 'lg'),
          App.UI.el('div', { class: 'chat-drawer-head-main' },
            App.UI.el('div', { class: 'chat-drawer-name', text: st.character.name || '未命名角色' }),
            App.UI.el('div', {
              class: 'chat-drawer-sub',
              text: K.typeLabel(st.character.type) + (wv.name ? ' · ' + wv.name : '')
            })
          )
        );
        var body = App.UI.el('div', { class: 'chat-drawer-body' });

        function field(label, value) {
          var text = joinText(value).trim();
          if (!text) return;
          body.appendChild(App.UI.el('div', { class: 'chat-drawer-field' },
            App.UI.el('div', { class: 'chat-drawer-label', text: label }),
            App.UI.el('div', { class: 'chat-drawer-value', text: text })
          ));
        }
        field('世界观', wv.name ? (wv.name + (wv.summary ? '：' + wv.summary : '')) : '');
        field('性格', st.character.personality);
        field('习惯', st.character.habits);
        field('背景', st.character.background);
        field('说话风格', st.character.speechStyle);
        field('口头禅', st.character.catchphrases);
        field('场景', st.character.scenario);
        field('开场白', st.character.firstMessage);
        if (st.character.type === 'assistant') {
          field('领域', st.character.domain);
          field('专长', st.character.specialty);
          field('职责', st.character.duties);
          field('回答风格', st.character.answerStyle);
          field('知识边界', st.character.knowledgeBoundary);
        }
        field('当前用户扮演', st.persona ? (st.persona.name + (st.persona.description ? '：' + st.persona.description : '')) : '');
        if (!body.firstChild) {
          body.appendChild(App.UI.el('div', { class: 'chat-drawer-empty', text: '这个角色还没有填写详细设定' }));
        }

        var editBtn = App.UI.el('button', { class: 'btn primary small', attrs: { type: 'button' }, text: '编辑角色' });
        var closeBtn = App.UI.el('button', { class: 'btn small', attrs: { type: 'button' }, text: '关闭' });
        body.appendChild(App.UI.el('div', { class: 'chat-drawer-actions' }, editBtn, closeBtn));

        editBtn.addEventListener('click', function () {
          closeDrawer();
          if (App.Router.has('characterEdit') && st.character) {
            App.Router.push('characterEdit', { id: st.character.id }).catch(function (err) {
              console.error('[chat] 打开角色编辑失败', err);
              toast('打开角色编辑失败', 'error');
            });
          } else {
            toast('角色编辑页尚未就绪');
          }
        });
        closeBtn.addEventListener('click', closeDrawer);

        drawer.appendChild(head);
        drawer.appendChild(body);
        var host = document.getElementById('overlay-root') || document.body;
        host.appendChild(mask);
        host.appendChild(drawer);
        st.drawer = { mask: mask, drawer: drawer };
        // 返回键优先关闭抽屉（否则会直接退出聊天页）
        try {
          App.Router.setBackGuard(function () {
            if (st.drawer) { closeDrawer(); return true; }
            return false;
          });
        } catch (e) { /* 忽略 */ }
        mask.addEventListener('click', closeDrawer);
        U.raf(function () {
          mask.classList.add('show');
          drawer.classList.add('show');
        });
      }

      function closeDrawer() {
        var d = st.drawer;
        if (!d) return;
        st.drawer = null;
        try { App.Router.setBackGuard(null); } catch (e) { /* 忽略 */ }
        try {
          d.mask.classList.remove('show');
          d.drawer.classList.remove('show');
        } catch (e) { /* 忽略 */ }
        setTimeout(function () {
          if (d.mask && d.mask.parentNode) d.mask.parentNode.removeChild(d.mask);
          if (d.drawer && d.drawer.parentNode) d.drawer.parentNode.removeChild(d.drawer);
        }, 260);
      }

      /* ---------------- 断网提示 ---------------- */
      function updateOnlineState() {
        var offline = typeof navigator !== 'undefined' && navigator.onLine === false;
        if (offline) {
          noticeEl.textContent = '网络已断开，可查看历史消息；发送会失败。';
          noticeEl.classList.remove('hidden');
        } else {
          noticeEl.textContent = '';
          noticeEl.classList.add('hidden');
        }
      }
      function onOnline() { updateOnlineState(); }
      function onOffline() { updateOnlineState(); }

      /* ---------------- 事件委托 ---------------- */
      var lpTimer = null, lpMoved = false, lpMsg = null, suppressClick = false;

      listEl.addEventListener('scroll', function () {
        st.followBottom = atBottom();
        if (listEl.scrollTop < 60 && st.hasOlder && !st.loadingOlder) loadOlder();
      }, { passive: true });

      listEl.addEventListener('click', function (ev) {
        var variantBtn = K.closest(ev.target, '.msg-variant-prev') || K.closest(ev.target, '.msg-variant-next');
        var msgNode = K.closest(ev.target, '.msg');
        if (!msgNode) return;
        var m = findMsg(msgNode.getAttribute('data-id'));
        if (!m) return;
        if (variantBtn) {
          ev.preventDefault();
          switchVariant(m, variantBtn.classList.contains('msg-variant-prev') ? -1 : 1);
          return;
        }
        if (K.closest(ev.target, '.msg-retry')) {
          ev.preventDefault();
          retryMessage(m);
          return;
        }
        if (K.closest(ev.target, '.msg-explain')) {
          ev.preventDefault();
          openErrorHelp(m);
          return;
        }
        if (K.closest(ev.target, '.msg-op')) {
          ev.preventDefault();
          openMsgMenu(m);
          return;
        }
        // 角色发的图片：点击预览（契约 §4.2）
        var libImg = K.closest(ev.target, '.msg-image');
        if (libImg) {
          if (suppressClick) { suppressClick = false; return; }
          ev.preventDefault();
          previewLibraryImage(libImg.getAttribute('data-img'));
          return;
        }
        // 用户发的图片 / 文件
        if (K.closest(ev.target, '.msg-attach-img')) {
          if (suppressClick) { suppressClick = false; return; }
          ev.preventDefault();
          previewAttachment((m.attachments || [])[0]);
          return;
        }
        if (K.closest(ev.target, '.msg-attach-file')) {
          if (suppressClick) { suppressClick = false; return; }
          ev.preventDefault();
          openFileTextModal((m.attachments || [])[0]);
          return;
        }
        if (K.closest(ev.target, '.msg-bubble')) {
          if (suppressClick) { suppressClick = false; return; }
          openMsgMenu(m);
        }
      }, false);

      listEl.addEventListener('touchstart', function (ev) {
        var bubble = K.closest(ev.target, '.msg-bubble');
        var msgNode = K.closest(ev.target, '.msg');
        if (!bubble || !msgNode) return;
        lpMsg = findMsg(msgNode.getAttribute('data-id'));
        lpMoved = false;
        clearTimeout(lpTimer);
        lpTimer = setTimeout(function () {
          if (lpMoved || !lpMsg) return;
          suppressClick = true;
          try {
            if (App.Bridge && App.Bridge.call) App.Bridge.call('ui.vibrate', { ms: 12 }).catch(function () { /* 忽略 */ });
          } catch (e) { /* 忽略 */ }
          openMsgMenu(lpMsg);
        }, 480);
      }, { passive: true });

      listEl.addEventListener('touchmove', function () {
        lpMoved = true;
        clearTimeout(lpTimer);
      }, { passive: true });

      listEl.addEventListener('touchend', function () {
        clearTimeout(lpTimer);
        setTimeout(function () { suppressClick = false; }, 420);
      }, { passive: true });

      listEl.addEventListener('touchcancel', function () {
        lpMoved = true;
        clearTimeout(lpTimer);
      }, { passive: true });

      /* ---------------- 输入区 ---------------- */
      function autosize() {
        try {
          inputEl.style.height = 'auto';
          var h = Math.max(24, Math.min(120, inputEl.scrollHeight));
          inputEl.style.height = h + 'px';
        } catch (e) { /* 忽略 */ }
      }

      inputEl.addEventListener('input', autosize);
      inputEl.addEventListener('focus', function () {
        document.body.classList.add('chat-input-focus');
        setTimeout(function () { if (st.followBottom) scrollToBottom(true); }, 260);
      });
      inputEl.addEventListener('blur', function () {
        document.body.classList.remove('chat-input-focus');
      });
      inputEl.addEventListener('keydown', function (ev) {
        // Enter 换行（默认行为）；Ctrl/Cmd + Enter 发送
        if (ev.key === 'Enter' && (ev.ctrlKey || ev.metaKey)) {
          ev.preventDefault();
          send();
        }
      });
      sendBtn.addEventListener('click', function () {
        if (st.streaming) stopStream(); else send();
      });
      attachBtn.addEventListener('click', function (ev) {
        ev.preventDefault();
        openAttachSheet();
      });

      window.addEventListener('online', onOnline);
      window.addEventListener('offline', onOffline);

      var vvHandler = function () {
        if (st.followBottom) setTimeout(function () { scrollToBottom(true); }, 60);
      };
      if (window.visualViewport) {
        window.visualViewport.addEventListener('resize', vvHandler);
      }

      /* ---------------- 数据加载 ---------------- */
      function resolveProvider() {
        return D.all('providers').then(function (list) {
          st.providers = list || [];
          var current = st.session && st.session.providerId ? findProvider(st.session.providerId) : null;
          if (!current) {
            var candidates = st.providers.filter(function (p) { return p && (p.role === 'chat' || !p.role); });
            current = candidates[0] || st.providers[0] || null;
          }
          st.provider = current;
          if (current && st.session) {
            var changed = false;
            if (!st.session.providerId) { st.session.providerId = current.id; changed = true; }
            if (!st.session.model) {
              var model = current.defaultModel || (current.models && current.models[0]) || '';
              if (model) { st.session.model = model; changed = true; }
            }
            if (changed) D.put('sessions', st.session).catch(function () { /* 忽略 */ });
          }
          return null;
        }).catch(function (err) {
          console.error('[chat] 加载 API 配置失败', err);
          st.providers = [];
          st.provider = null;
          return null;
        });
      }

      function loadMessages() {
        return D.byIndex('messages', 'sessionId', sessionId).then(function (msgs) {
          st.messages = K.sortMessages(msgs || []).filter(function (m) { return m && !m.deleted; });
          // 清理上一次异常退出遗留的 streaming 状态
          var dirty = [];
          st.messages.forEach(function (m) {
            if (m.status === 'streaming') {
              if (String(m.content || '').trim()) {
                m.status = 'ok';
              } else {
                m.status = 'error';
                m.errorText = m.errorText || '生成被中断，请重试';
                m.errorCode = m.errorCode || 'unknown';
              }
              dirty.push(m);
            }
          });
          syncIndex();
          if (dirty.length) {
            Promise.all(dirty.map(function (m) { return D.put('messages', m).catch(function () { return null; }); })).catch(function () { /* 忽略 */ });
          }
          return null;
        });
      }

      /* 读取上帝模式开关与角色图片库（契约 §4.4 §4.2） */
      function loadMediaState() {
        var p = Promise.resolve(false);
        try {
          if (App.DB && App.DB.settings && typeof App.DB.settings.get === 'function') {
            p = App.DB.settings.get('god_mode', false);
          }
        } catch (e) { p = Promise.resolve(false); }
        return Promise.resolve(p).then(function (v) {
          st.godMode = v === true;
          return null;
        }).catch(function (err) {
          console.error('[chat] 读取上帝模式失败', err);
          st.godMode = false;
          return null;
        }).then(function () {
          var M = mediaApi();
          var cid = st.character && st.character.id;
          if (!M || typeof M.list !== 'function' || !cid) { st.images = []; return null; }
          var lp;
          try { lp = M.list(cid); } catch (e) { lp = Promise.resolve([]); }
          return Promise.resolve(lp).then(function (list) {
            st.images = Array.isArray(list) ? list : [];
            return null;
          }).catch(function (err) {
            console.error('[chat] 加载角色图片失败', err);
            st.images = [];
            return null;
          });
        });
      }

      // 图片库变化后重渲染含图片标记的消息
      function refreshImageNodes() {
        st.imgCache = {};
        st.messages.forEach(function (m) {
          if (!m || m.role !== 'assistant') return;
          if (String(m.content || '').indexOf('[[img:') === -1) return;
          try { replaceMsgEl(m); } catch (e) { /* 忽略 */ }
        });
      }

      function load() {
        return D.get('sessions', sessionId).then(function (s) {
          if (!s) throw new Error('会话不存在或已被删除');
          st.session = s;
          return Promise.all([
            s.characterId ? D.get('characters', s.characterId).catch(function () { return null; }) : null,
            s.personaId ? D.get('personas', s.personaId).catch(function () { return null; }) : null,
            s.presetId ? D.get('presets', s.presetId).catch(function () { return null; }) : null
          ]);
        }).then(function (arr) {
          st.character = arr && arr[0] ? arr[0] : null;
          st.persona = arr && arr[1] ? arr[1] : null;
          st.preset = arr && arr[2] ? arr[2] : null;
          if (!st.persona) st.persona = { id: '', name: '我', description: '', avatar: '' };
          if (!st.preset) st.preset = K.defaultPresetFor(st.character && st.character.type);
          return resolveProvider();
        }).then(function () {
          return loadMediaState();
        }).then(function () {
          return loadMessages();
        }).then(function () {
          applyTitle();
          renderTopbar();
          renderMessagesInitial();
          setGeneratingUI(!!st.streaming);
          updateOnlineState();
          markRead();
          syncGuide();
          try { page.setActions([{ icon: 'more', label: '会话菜单', onClick: openSessionMenu }]); } catch (e) { /* 忽略 */ }
          st.followBottom = true;
          U.raf(function () { scrollToBottom(true); });
          return null;
        }).catch(function (err) {
          console.error('[chat] 加载失败', err);
          K.clear(root);
          root.appendChild(App.UI.errorState({
            title: '会话加载失败',
            desc: (err && err.message) || '未知错误',
            actionText: '返回聊天列表',
            onAction: function () {
              try { App.Router.pop(); } catch (e) { /* 忽略 */ }
            }
          }));
          return null;
        });
      }

      function markRead() {
        if (!st.session || !st.session.unread) return;
        st.session.unread = 0;
        D.put('sessions', st.session).catch(function () { /* 忽略 */ });
      }

      /* 从其它页面返回本页时重新加载元数据（预设/角色可能已修改） */
      function reloadMeta() {
        if (!st.session) return Promise.resolve();
        return D.get('sessions', sessionId).then(function (s) {
          if (!s) return null;
          st.session = s;
          return Promise.all([
            s.characterId ? D.get('characters', s.characterId).catch(function () { return null; }) : null,
            s.personaId ? D.get('personas', s.personaId).catch(function () { return null; }) : null,
            s.presetId ? D.get('presets', s.presetId).catch(function () { return null; }) : null
          ]);
        }).then(function (arr) {
          if (!arr) return null;
          if (arr[0]) st.character = arr[0];
          if (arr[1]) st.persona = arr[1];
          st.preset = arr[2] || (st.preset ? st.preset : K.defaultPresetFor(st.character && st.character.type));
          return resolveProvider();
        }).then(function () {
          return loadMediaState();
        }).then(function () {
          if (st.destroyed) return null;
          applyTitle();
          renderTopbar();
          refreshImageNodes();
          syncGuide();
          return null;
        }).catch(function (err) { console.error('[chat] 重新加载元数据失败', err); });
      }

      App.Router.onChange(function (cur) {
        if (st.destroyed || st.metaRefreshing) return;
        if (!root.isConnected) return;
        if (!cur || !cur.entry || cur.entry.el !== root) return;
        st.metaRefreshing = true;
        reloadMeta().then(function () {
          setTimeout(function () { st.metaRefreshing = false; }, 100);
        }).catch(function () { st.metaRefreshing = false; });
      });

      /* ---------------- 销毁清理 ---------------- */
      page.onDestroy(function () {
        st.destroyed = true;
        var s = st.streaming;
        st.streaming = null;
        if (s) {
          // 退出页面：保留已生成内容；一个字都没生成则标为中断错误，避免空气泡
          if (s.discard) {
            // 已主动丢弃（清空/删除会话），不再写回
          } else if (String(s.target.content || '').trim()) {
            s.target.status = 'ok';
            s.target.errorText = '';
            s.target.errorCode = '';
          } else {
            s.target.status = 'error';
            s.target.errorText = '生成被中断，请重试';
            s.target.errorCode = 'unknown';
          }
          try { s.handle && s.handle.abort && s.handle.abort(); } catch (e) { /* 忽略 */ }
          if (!s.discard) {
            D.put('messages', s.target).catch(function () { /* 忽略 */ });
            K.touchSession(sessionId, s.target).catch(function () { /* 忽略 */ });
          }
        }
        K.setGenerating(sessionId, false);
        document.body.classList.remove('chat-input-focus');
        closeDrawer();
        window.removeEventListener('online', onOnline);
        window.removeEventListener('offline', onOffline);
        if (window.visualViewport) {
          try { window.visualViewport.removeEventListener('resize', vvHandler); } catch (e) { /* 忽略 */ }
        }
      });

      return load();
    }
  });
})();
