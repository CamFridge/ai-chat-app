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
        imgCache: {},
        styleAvatarUri: '',  // 已渲染的「我」头像 data URI 缓存（v1.3.0）
        isGroup: false,      // 群聊会话（v1.4.0）
        members: [],         // 群成员 [{ id, name, avatar, character }]（v1.4.0）
        memberById: {},      // 群成员索引（v1.4.0）
        textMode: false,     // 预设为「文本模式」（v1.4.0）
        loreText: ''         // 本轮命中的世界书文本（v1.4.0）
      };

      /* ---------------- 页面骨架 ---------------- */
      var topbar = App.UI.el('div', { class: 'chat-topbar' });
      var sceneBar = App.UI.el('div', { class: 'chat-scene-bar hidden' });
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
      var wrap = App.UI.el('div', { class: 'chat-wrap chat-page-wrap' }, topbar, sceneBar, listEl, noticeEl, composer);
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
            var im = App.UI.el('img', {
              class: 'msg-image-img',
              attrs: { src: rec.dataUri, alt: rec.name || '图片', loading: 'lazy' }
            });
            im.addEventListener('load', function () {
              if (im.naturalWidth && im.naturalHeight / im.naturalWidth >= 2) {
                box.classList.add('tall');
                var tag = App.UI.el('span', { class: 'msg-img-tag', text: '长图 · 点击查看' });
                box.appendChild(tag);
              }
            });
            box.appendChild(im);
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
          var wrap = App.UI.el('div', { class: 'msg-img-box' });
          var img = App.UI.el('img', {
            class: 'msg-attach-img',
            attrs: { src: att.dataUri, alt: att.name || '图片', loading: 'lazy' }
          });
          img.setAttribute('role', 'button');
          img.setAttribute('data-att', 'image');
          img.addEventListener('load', function () {
            if (img.naturalWidth && img.naturalHeight / img.naturalWidth >= 2) {
              wrap.classList.add('tall');
              wrap.appendChild(App.UI.el('span', { class: 'msg-img-tag', text: '长图 · 点击查看' }));
            }
          });
          wrap.appendChild(img);
          return wrap;
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
        } else if (!String(m.content || '').trim() && m.status !== 'streaming') {
          // 空正文（例如请求失败）：不渲染空气泡，只保留错误条（v1.4.2）
          bubble.classList.add('md', 'is-empty');
        } else {
          bubble.classList.add('md');
          if (st.textMode) {
            // 文本模式：纯文本输出，不做动作斜体与图片标记渲染（v1.4.0）
            bubble.classList.add('text-mode');
            bubble.textContent = String(m.content || '');
          } else {
            renderRichContent(bubble, m.content);
          }
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

      /* ---------------- 「我」的头像：优先用 App.Style.getUserAvatar()（v1.3.0） ---------------- */
      function userAvatarUri() {
        try {
          if (App.Style && typeof App.Style.getUserAvatar === 'function') {
            return App.Style.getUserAvatar() || '';
          }
        } catch (e) { /* 忽略 */ }
        return '';
      }

      function myAvatarEl() {
        return K.avatarEl({
          name: (st.persona && st.persona.name) || '我',
          avatar: userAvatarUri()
        }, 'sm');
      }

      // 只替换消息列表里的「我」头像节点（不重绘整页）：Style 异步 ready 或从设置页返回时调用
      function refreshMyAvatars(force) {
        if (st.destroyed) return;
        var uri = userAvatarUri();
        if (!force && uri === st.styleAvatarUri) return;
        st.styleAvatarUri = uri;
        var nodes = listEl.querySelectorAll('.msg.me > .msg-avatar');
        for (var i = 0; i < nodes.length; i++) {
          var old = nodes[i];
          if (!old || !old.parentNode) continue;
          var fresh = myAvatarEl();
          fresh.classList.add('msg-avatar');
          old.parentNode.replaceChild(fresh, old);
        }
      }

      // Style 可能在页面 build 之后才 ready：短轮询，ready 后补一次头像刷新（避免整页重绘）
      function scheduleAvatarRefresh() {
        var tries = 0;
        function attempt() {
          if (st.destroyed) return;
          tries++;
          var ready = false;
          try {
            ready = !!(App.Style && typeof App.Style.isLoaded === 'function' && App.Style.isLoaded());
          } catch (e) { ready = false; }
          if (ready) { refreshMyAvatars(); return; }
          if (tries >= 8) return;
          setTimeout(attempt, 300);
        }
        setTimeout(attempt, 300);
      }

      function buildMsg(m) {
        var isMe = m.role === 'user';
        var node = App.UI.el('div', {
          class: 'msg ' + (isMe ? 'me' : 'ai') + (m.status === 'streaming' ? ' is-streaming' : ''),
          dataset: { id: m.id, ts: String(m.createdAt || '') }
        });
        var av;
        if (isMe) {
          av = myAvatarEl();
          st.styleAvatarUri = userAvatarUri();
        } else if (st.isGroup) {
          // 群聊：按消息上的发言人渲染头像（v1.4.0）
          var mem = memberOf(m);
          av = K.avatarEl(mem || { name: (m.speakerName || '?') }, 'sm');
        } else {
          av = K.avatarEl(st.character || { name: '?' }, 'sm');
        }
        av.classList.add('msg-avatar');
        // 点头像即可更换头像（v1.4.2）
        av.classList.add('tap-edit');
        av.setAttribute('role', 'button');
        av.setAttribute('aria-label', isMe ? '更换我的头像' : '更换角色头像');
        if (isMe) {
          av.addEventListener('click', function (ev) {
            if (ev && ev.stopPropagation) ev.stopPropagation();
            chooseMyAvatar();
          });
        } else if (st.isGroup) {
          var memTap = memberOf(m);
          if (memTap) {
            av.addEventListener('click', function (ev) {
              if (ev && ev.stopPropagation) ev.stopPropagation();
              chooseCharacterAvatar(memTap);
            });
          }
        } else if (st.character) {
          av.addEventListener('click', function (ev) {
            if (ev && ev.stopPropagation) ev.stopPropagation();
            chooseCharacterAvatar(st.character);
          });
        }
        node.appendChild(av);
        var body = App.UI.el('div', { class: 'msg-body' });
        if (!isMe && st.isGroup) {
          body.appendChild(App.UI.el('div', {
            class: 'msg-speaker',
            text: m.speakerName || (memberOf(m) && memberOf(m).name) || '角色'
          }));
        }
        body.appendChild(buildBubble(m));
        body.appendChild(buildMeta(m));
        if (m.status === 'error') body.appendChild(buildErrorBox(m));
        node.appendChild(body);
        return node;
      }

      // 群聊成员查找（v1.4.0）
      function memberOf(m) {
        if (!st.isGroup || !m || !m.characterId) return null;
        return st.memberById[m.characterId] || null;
      }

      /* ---------------- 换头像 / 聊天背景（v1.4.2） ---------------- */
      function styleApi() {
        return App.Style || null;
      }

      function errMsg(err) {
        if (!err) return '未知错误';
        if (typeof err === 'string') return err;
        return err.message || err.reason || String(err) || '未知错误';
      }

      function pickImageData() {
        var M = App.Media;
        if (!M || typeof M.pickImage !== 'function') {
          return Promise.reject(new Error('相册功能不可用，请重启 App'));
        }
        return Promise.resolve(M.pickImage());
      }

      // 图片选择面板：从相册选择 / 恢复默认
      function pickImageSheet(title, canReset, resetLabel) {
        var items = [{ id: 'pick', value: 'pick', label: '从相册选择图片', icon: 'plus' }];
        if (canReset) items.push({ id: 'reset', value: 'reset', label: resetLabel || '恢复默认', icon: 'refresh' });
        return K.sheet({ title: title, items: items, cancelText: '取消' }).then(function (item) {
          return K.itemId(item) || null;
        });
      }

      function chooseMyAvatar() {
        var S = styleApi();
        if (!S || typeof S.setUserAvatar !== 'function') {
          toast('聊天界面模块不可用，请重启 App');
          return;
        }
        var cur = '';
        try {
          cur = typeof S.getUserAvatar === 'function' ? S.getUserAvatar() || '' : userAvatarUri();
        } catch (e) {
          cur = userAvatarUri();
        }
        pickImageSheet('我的头像', !!cur, '恢复默认头像')
          .then(function (act) {
            if (!act) return null;
            if (act === 'reset') {
              return Promise.resolve(S.setUserAvatar('')).then(function () {
                refreshMyAvatars(true);
                toast('已恢复默认头像');
              });
            }
            return pickImageData().then(function (att) {
              if (!att || !att.dataUri) return null;
              return Promise.resolve(S.setUserAvatar(att.dataUri)).then(function () {
                refreshMyAvatars(true);
                toast('头像已更新');
              });
            });
          })
          .catch(function (err) {
            toast('设置头像失败：' + errMsg(err), 'error');
          });
      }

      function chooseChatBackground() {
        var S = styleApi();
        if (!S || typeof S.setBackground !== 'function') {
          toast('聊天界面模块不可用，请重启 App');
          return;
        }
        var cur = '';
        try {
          cur = typeof S.getBackground === 'function' ? S.getBackground() || '' : '';
        } catch (e) {
          cur = '';
        }
        pickImageSheet('聊天背景', !!cur, '清除聊天背景')
          .then(function (act) {
            if (!act) return null;
            if (act === 'reset') {
              var clearFn = typeof S.clearBackground === 'function'
                ? S.clearBackground
                : function () { return S.setBackground(''); };
              return Promise.resolve(clearFn.call(S)).then(function () {
                toast('聊天背景已清除');
              });
            }
            return pickImageData().then(function (att) {
              if (!att || !att.dataUri) return null;
              return Promise.resolve(S.setBackground(att.dataUri)).then(function () {
                toast('聊天背景已更新');
              });
            });
          })
          .catch(function (err) {
            toast('设置背景失败：' + errMsg(err), 'error');
          });
      }

      // 角色头像变更后，只替换该角色相关消息的头像节点
      function refreshCharacterAvatars(charId) {
        if (!Array.isArray(st.messages) || !charId) return;
        for (var i = 0; i < st.messages.length; i++) {
          var m = st.messages[i];
          if (!m || m.role === 'user' || !m.id) continue;
          if (m.status === 'streaming') continue;
          if (st.isGroup && m.characterId !== charId) continue;
          replaceMsgEl(m);
        }
      }

      function chooseCharacterAvatar(char) {
        if (!char || !char.id) return;
        pickImageSheet((char.name || '角色') + ' 的头像', true, '恢复默认（字母头像）')
          .then(function (act) {
            if (!act) return null;
            function apply(avatar) {
              var rec = {};
              Object.keys(char).forEach(function (k) { rec[k] = char[k]; });
              rec.avatar = avatar;
              rec.updatedAt = Date.now();
              return D.put('characters', rec).then(function () {
                if (st.character && st.character.id === rec.id) st.character.avatar = avatar;
                if (st.members && st.members.length) {
                  for (var i = 0; i < st.members.length; i++) {
                    if (st.members[i] && st.members[i].id === rec.id) st.members[i].avatar = avatar;
                  }
                }
                if (st.memberById && st.memberById[rec.id]) st.memberById[rec.id].avatar = avatar;
                char.avatar = avatar;
                refreshCharacterAvatars(rec.id);
                renderTopbar();
                toast(avatar ? '角色头像已更新' : '已恢复默认头像');
              });
            }
            if (act === 'reset') return apply('');
            return pickImageData().then(function (att) {
              if (!att || !att.dataUri) return null;
              return apply(att.dataUri);
            });
          })
          .catch(function (err) {
            toast('设置角色头像失败：' + errMsg(err), 'error');
          });
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
        var card = st.character || (st.isGroup && st.members && st.members[0]) || { name: '聊天' };
        var name = st.isGroup ? ((st.session && st.session.title) || '群聊') : (card.name || '开始聊天');
        var tip = st.isGroup
          ? ('群里有 ' + ((st.members && st.members.length) || 1) + ' 个角色，发第一条消息开始吧')
          : '还没有消息，发第一条消息开始对话吧';
        var node = App.UI.el('div', { class: 'chat-empty' },
          K.avatarEl(card, 'lg'),
          App.UI.el('div', { class: 'chat-empty-name', text: name }),
          App.UI.el('div', { class: 'chat-empty-tip', text: tip })
        );
        listEl.appendChild(node);
      }

      /* ---------------- 顶部信息条 ---------------- */
      function renderTopbar() {
        K.clear(topbar);
        var card = st.character || {};
        var title = st.isGroup
          ? ((st.session && st.session.title) || '群聊')
          : (card.name || (st.session && st.session.title) || '聊天');
        var sub = st.isGroup
          ? ('群聊 · ' + (st.members.length || ((st.session && st.session.characterIds) || []).length) + ' 人')
          : K.typeLabel(card.type);
        var left = App.UI.el('button', { class: 'chat-topbar-char', attrs: { type: 'button' } },
          App.UI.el('span', { class: 'chat-topbar-name', text: title }),
          App.UI.el('span', { class: 'chat-topbar-type', text: sub })
        );
        left.addEventListener('click', function () {
          if (st.isGroup) {
            try { App.Router.push('groupManage', { sessionId: sessionId }); } catch (e) { toast('无法打开群成员'); }
            return;
          }
          openCharacterDrawer();
        });

        var modelText = (st.session && st.session.model) || '未设置模型';
        var right = App.UI.el('button', { class: 'chat-topbar-model', attrs: { type: 'button', 'aria-label': '切换模型' } },
          App.UI.el('span', { class: 'chat-topbar-model-text', text: modelText }),
          App.UI.el('span', { class: 'chat-topbar-chev', html: K.iconHtml('chev') })
        );
        right.addEventListener('click', function () { openModelSheet(); });

        topbar.appendChild(left);
        topbar.appendChild(right);

        // 场景条（v1.3.2）：有场景时显示当前场景，点一下可切换
        var scenes = Array.isArray(card.scenarios) ? card.scenarios.filter(Boolean) : [];
        var curScene = (st.session && st.session.scene) || '';
        K.clear(sceneBar);
        if (!scenes.length && !curScene) {
          sceneBar.classList.add('hidden');
        } else {
          sceneBar.classList.remove('hidden');
          var txt = curScene ? ('场景：' + curScene) : '场景：由上下文自由判断';
          var chip = App.UI.el('button', { class: 'chat-scene-chip', attrs: { type: 'button', 'aria-label': '切换场景' } },
            App.UI.el('span', { class: 'chat-scene-icon', html: K.iconHtml('world') }),
            App.UI.el('span', { class: 'chat-scene-text ellipsis', text: txt }),
            App.UI.el('span', { class: 'chat-scene-chev', html: K.iconHtml('chev') })
          );
          chip.addEventListener('click', function () { openSceneSheet(); });
          sceneBar.appendChild(chip);
        }
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
      // 性能：流式期间最多每 90ms 做一次完整富文本渲染（Markdown 解析 + 图片节点重建），
      // 其余帧只更新纯文本，避免长回复时每帧 innerHTML 重建造成掉帧、输入卡顿。
      var RICH_RENDER_MS = 90;
      function applyStreaming(s) {
        var node = msgEl(s.target.id);
        if (!node) return;
        var bubble = node.querySelector('.msg-bubble');
        if (!bubble) return;
        var content = s.target.content;
        if (s.target.role === 'user') {
          bubble.textContent = content;
        } else {
          // 群聊：流式期间隐藏模型自报家门的「【角色名】」前缀
          content = stripLeadingSpeaker(content);
          if (String(content || '').trim()) {
            // 空内容（或只有空白）时保留「正在输入」动画，避免气泡被 :empty 规则隐藏
            if (st.textMode) {
              bubble.textContent = content;
            } else {
              var now = Date.now();
              if (!s.lastRichAt || now - s.lastRichAt >= RICH_RENDER_MS) {
                s.lastRichAt = now;
                renderRichContent(bubble, content);
              } else {
                bubble.textContent = content;
              }
            }
            bubble.classList.remove('typing');
          }
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
        // 群聊：按开头「【角色名】」确定最终发言人，并把前缀从正文里去掉（v1.4.0）
        if (st.isGroup && content.trim()) {
          var fallbackSpk = { characterId: target.characterId || '', name: target.speakerName || '' };
          var parsed = null;
          try {
            if (App.Group && typeof App.Group.parseSpeakerReply === 'function') {
              parsed = App.Group.parseSpeakerReply(content, st.members, fallbackSpk);
            }
          } catch (e) { parsed = null; }
          if (parsed && typeof parsed.content === 'string') {
            content = parsed.content;
            if (parsed.characterId) target.characterId = parsed.characterId;
            if (parsed.name) target.speakerName = parsed.name;
          } else {
            content = stripLeadingSpeaker(content);
          }
          content = stripLeadingSpeaker(content, true);
        }
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

      /* ---------------- 上下文准备：群聊发言人 / 世界书 / 文本模式（v1.4.0） ---------------- */
      function loreApi() {
        return (App.Lorebook && typeof App.Lorebook.buildInjection === 'function') ? App.Lorebook : null;
      }
      function groupApi() {
        return (App.Group && typeof App.Group.buildContext === 'function') ? App.Group : null;
      }

      // 用于世界书关键词匹配的最近上下文（最近 8 条）
      function loreMatchText(history) {
        var parts = [];
        (history || []).slice(-8).forEach(function (m) {
          var t = String((m && m.content) || '').trim();
          if (!t) return;
          parts.push((m.role === 'user' ? '' : ((m.speakerName || '') + (m.speakerName ? '：' : ''))) + t);
        });
        return parts.join('\n').slice(-4000);
      }

      function loadLore(history) {
        var L = loreApi();
        if (!L) return Promise.resolve('');
        var text = loreMatchText(history);
        if (!text) return Promise.resolve('');
        var p;
        try {
          p = L.buildInjection({
            text: text,
            characterId: (st.session && st.session.characterId) || '',
            lorebookIds: (st.session && Array.isArray(st.session.lorebookIds)) ? st.session.lorebookIds : undefined
          });
        } catch (e) { return Promise.resolve(''); }
        return Promise.resolve(p).then(function (v) { return typeof v === 'string' ? v : ''; })
          .catch(function () { return ''; });
      }

      // 把世界书与「文本模式」约束拼进 system（不依赖 chat-list.js 的 buildSystemPrompt）
      function decorateContext(ctx, lore) {
        var out = ctx || {};
        var msgs = Array.isArray(out.messages) ? out.messages.slice() : [];
        var extra = '';
        if (lore) extra += '\n\n' + lore;
        if (st.textMode) {
          extra += '\n\n【输出模式：纯文本】只输出正文文本：不要使用【角色名】等对话标记、不要用星号包裹动作神态、不要输出图片标记、不要使用 Markdown 标题或列表。';
        }
        if (extra) {
          var sysIdx = -1;
          for (var i = 0; i < msgs.length; i++) {
            if (msgs[i] && msgs[i].role === 'system') { sysIdx = i; break; }
          }
          if (sysIdx >= 0) {
            msgs[sysIdx] = { role: 'system', content: String(msgs[sysIdx].content || '') + extra };
          } else {
            msgs.unshift({ role: 'system', content: extra.replace(/^\n+/, '') });
          }
        }
        out.messages = msgs;
        return out;
      }

      // 群里决定谁发言（模块缺失/失败返回 null，由 Group 内部退回轮换）
      function decideGroupSpeaker(history) {
        var G = groupApi();
        if (!G || typeof G.decideSpeaker !== 'function') return Promise.resolve(null);
        var p;
        try {
          p = G.decideSpeaker({
            session: st.session,
            members: st.members,
            messages: history,
            provider: st.provider,
            model: (st.session && st.session.model) || ''
          });
        } catch (e) { return Promise.resolve(null); }
        return Promise.resolve(p).then(function (spk) {
          if (!spk || !spk.characterId) return null;
          return spk;
        }).catch(function () { return null; });
      }

      // 上下文 + 发言人：Promise<{ ctx, speaker }>
      function prepareContext(history, target) {
        var godOn = !!(st.character && st.character.godMode) || st.godMode === true;
        var scene = (st.session && st.session.scene) || '';
        var loreP = loadLore(history);
        if (st.isGroup) {
          var G = groupApi();
          if (!G) return Promise.reject(new Error('群聊模块未加载，请重启应用'));
          return Promise.resolve().then(function () {
            return G.membersOf(st.session);
          }).then(function (members) {
            st.members = Array.isArray(members) ? members.slice() : [];
            st.memberById = {};
            st.members.forEach(function (x) { if (x && x.id) st.memberById[x.id] = x; });
            return decideGroupSpeaker(history);
          }).then(function (spk) {
            if (spk) {
              target.characterId = spk.characterId;
              target.speakerName = spk.name || '';
            }
            return loreP.then(function (lore) {
              st.loreText = lore;
              var ctx = G.buildContext({
                session: st.session,
                members: st.members,
                persona: st.persona,
                preset: st.preset,
                messages: history,
                godMode: godOn,
                scene: scene,
                lore: lore,
                textMode: st.textMode
              });
              return { ctx: ctx, speaker: spk || null };
            });
          });
        }
        return loreP.then(function (lore) {
          st.loreText = lore;
          var ctx = K.buildContext({
            character: st.character,
            persona: st.persona,
            preset: st.preset,
            messages: history,
            godMode: godOn,
            images: st.images,
            scene: scene,
            scenarios: (st.character && Array.isArray(st.character.scenarios)) ? st.character.scenarios : []
          });
          return { ctx: decorateContext(ctx, lore), speaker: null };
        });
      }

      // 群聊流式展示时去掉模型回复开头的「【角色名】」
      function stripLeadingSpeaker(text, loose) {
        var s = String(text || '');
        if (!st.isGroup) return s;
        var m = /^\s*【([^】]{1,30})】\s*/.exec(s);
        if (!m) m = /^\s*\[([^\]]{1,30})\]\s*/.exec(s);
        if (!m) return s;
        var name = String(m[1] || '').trim();
        var hit = false;
        (st.members || []).forEach(function (x) { if (x && x.name === name) hit = true; });
        return (hit || loose) ? s.slice(m[0].length) : s;
      }

      // 发起一次流式请求。opts: {target, history, mode:'new'|'regen'|'continue'}
      function requestStream(opts) {
        var target = opts.target;
        if (st.streaming) { toast('正在生成，请先停止'); return Promise.resolve(); }
        if (st.destroyed) return Promise.resolve();
        if (!st.character && !st.isGroup) {
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
        var params = K.paramsOf(st.preset);

        function begin(prepped) {
          var ctx = prepped.ctx;
          var s = {
            target: target,
            handle: null,
            stopped: false,
            generated: '',
            base: opts.mode === 'continue' ? String(target.content || '') : '',
            mode: opts.mode,
            ctxTokens: (ctx && ctx.usedTokens) || 0,
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
              messages: (ctx && ctx.messages) || [],
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

        return Promise.resolve().then(function () {
          return prepareContext(history, target);
        }).then(function (prepped) {
          if (st.destroyed) return null;
          if (!prepped || !prepped.ctx) throw new Error('上下文为空');
          return begin(prepped);
        }).catch(function (err) {
          console.error('[chat] 生成前置准备失败', err);
          failTarget(target, { code: 'unknown', message: '上下文组装失败：' + ((err && err.message) || ''), title: '生成失败' });
          return null;
        });
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
        try { p = M.pickImage({ maxSide: 1280, quality: 88 }); } catch (e) { p = Promise.reject(e); }
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
        if (!st.character && !st.isGroup) { toast('会话角色已被删除，无法继续聊天', 'error'); return; }
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

      /* ---------------- 从某条消息分支对话（v1.4.0 需求⑥） ---------------- */
      function branchFrom(m) {
        if (!st.session || !m) return Promise.resolve();
        var idx = st.messages.indexOf(m);
        if (idx < 0) return Promise.resolve();
        var src = st.messages.slice(0, idx + 1);
        var now = U.now();
        var newSession = {
          id: U.uid('sess'),
          title: ((st.session.title || '对话') + '（分支）').slice(0, 40),
          characterId: st.session.characterId || '',
          personaId: st.session.personaId || '',
          presetId: st.session.presetId || '',
          providerId: st.session.providerId || '',
          model: st.session.model || '',
          pinned: false,
          unread: 0,
          isGenerating: false,
          greetingIndex: typeof st.session.greetingIndex === 'number' ? st.session.greetingIndex : 0,
          scene: st.session.scene || '',
          kind: st.session.kind || 'single',
          characterIds: (st.session.characterIds || []).slice(),
          groupId: st.session.groupId || '',
          lorebookIds: (st.session.lorebookIds || []).slice(),
          lastText: '',
          lastRole: '',
          lastAt: now,
          createdAt: now,
          updatedAt: now
        };
        var copies = src.map(function (x) {
          var c = {};
          Object.keys(x || {}).forEach(function (k) { c[k] = x[k]; });
          c.id = U.uid('msg');
          c.sessionId = newSession.id;
          delete c.deleted;
          return c;
        });
        var last = copies[copies.length - 1];
        if (last) {
          newSession.lastText = String(last.content || '').slice(0, 80);
          newSession.lastRole = last.role || '';
        }
        return D.put('sessions', newSession).then(function () {
          return copies.length ? D.bulkPut('messages', copies) : null;
        }).then(function () {
          if (st.destroyed) return null;
          toast('已分出分支（' + copies.length + ' 条消息）', 'ok');
          try { App.Router.push('chat', { sessionId: newSession.id }); } catch (e) { /* 忽略 */ }
          return null;
        }).catch(function (err) {
          console.error('[chat] 分支失败', err);
          toast('分支失败：' + ((err && err.message) || '未知错误'), 'error');
        });
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
        items.push({ id: 'branch', value: 'branch', label: '从这里分支对话', icon: 'link' });
        items.push({ id: 'delete', value: 'delete', label: '删除消息', icon: 'delete', danger: true });
        K.sheet({ title: '消息操作', items: items, cancelText: '取消' }).then(function (item) {
          var act = K.itemId(item);
          if (!act) return;
          if (act === 'copy') return copyMessage(m);
          if (act === 'edit') return editMessage(m);
          if (act === 'regen') return regenerate(m);
          if (act === 'continue') return continueGeneration(m);
          if (act === 'branch') return branchFrom(m);
          if (act === 'delete') return deleteMessage(m);
          return null;
        }).catch(function (err) { console.error('[chat] 消息菜单出错', err); });
      }

      /* ---------------- 会话菜单 / 重命名 / 切模型 / 生成设置 ---------------- */
      function renameSession() {
        var isGroup = !!st.isGroup;
        return K.prompt({
          title: isGroup ? '重命名群聊' : '重命名会话',
          value: (st.session && st.session.title) || '',
          placeholder: '会话名称',
          okText: '保存'
        }).then(function (name) {
          if (name === null) return;
          var title = String(name).trim();
          if (!title) { toast('名称不能为空'); return; }
          st.session.title = title;
          var writeP;
          if (isGroup && App.Group && typeof App.Group.rename === 'function') {
            writeP = Promise.resolve().then(function () { return App.Group.rename(st.session, title); });
          } else {
            writeP = D.put('sessions', st.session);
          }
          return writeP.then(function () {
            applyTitle();
            toast('已重命名', 'ok');
          });
        }).catch(function (err) {
          console.error('[chat] 重命名失败', err);
          toast('重命名失败', 'error');
        });
      }

      /* ---------------- 问候语（首选 / 备选）：换个开场白（v1.2.0 契约 §2） ---------------- */
      // 收集问候语：idx 0 = 首选 firstMessage，idx N = 第 N 条备选（忽略空串）
      function greetingEntries() {
        var card = st.character || {};
        var list = [];
        var first = String(card.firstMessage || '').trim();
        if (first) list.push({ idx: 0, kind: '首选', text: first });
        var alts = Array.isArray(card.alternateGreetings) ? card.alternateGreetings : [];
        alts.forEach(function (raw, i) {
          var text = String(raw || '').trim();
          if (!text) return;
          list.push({ idx: i + 1, kind: '备选 ' + (i + 1), text: text });
        });
        return list;
      }

      function findGreetingEntry(idx) {
        var entries = greetingEntries();
        for (var i = 0; i < entries.length; i++) {
          if (entries[i].idx === idx) return entries[i];
        }
        return null;
      }

      // 当前会话使用的开场白索引：-1 表示空对话（不使用问候语）
      function currentGreetingIndex() {
        var raw = st.session ? st.session.greetingIndex : undefined;
        if (raw === -1) return -1;
        if (typeof raw === 'number' && raw >= 0 && findGreetingEntry(raw)) return raw;
        return firstAssistantMessage() ? 0 : -1;
      }

      function hasUserMessage() {
        return (st.messages || []).some(function (m) { return m && m.role === 'user'; });
      }

      function firstAssistantMessage() {
        var list = st.messages || [];
        for (var i = 0; i < list.length; i++) {
          if (list[i] && list[i].role === 'assistant' && !list[i].deleted) return list[i];
        }
        return null;
      }

      function openGreetingSheet() {
        // 已经发过消息的会话不允许换开场白
        if (hasUserMessage()) {
          toast('已经聊起来了，不能换开场白', 'info');
          return;
        }
        var entries = greetingEntries();
        var current = currentGreetingIndex();
        var items = entries.map(function (e) {
          return {
            id: String(e.idx),
            value: String(e.idx),
            label: e.kind + ' · ' + U.truncate(e.text, 24),
            icon: 'chat'
          };
        });
        items.push({
          id: '-1',
          value: '-1',
          label: '不使用开场白（空对话）',
          desc: '会话从空白开始，由你先说第一句',
          icon: 'close'
        });
        if (!entries.length) {
          items.unshift({
            id: '',
            value: 'hint',
            label: '这个角色还没有问候语',
            desc: '可在「角色信息 → 编辑角色 → 问候语」里添加',
            icon: 'info'
          });
        }
        K.sheet({
          title: '换个开场白',
          items: items,
          selected: String(current),
          cancelText: '取消'
        }).then(function (item) {
          var act = K.itemId(item);
          if (act === '' || act === 'hint') return;
          var idx = Number(act);
          if (!isNaN(idx)) return applyGreeting(idx);
          return null;
        }).catch(function (err) {
          console.error('[chat] 更换开场白失败', err);
          toast('更换开场白失败', 'error');
        });
      }

      // 应用问候语：替换首条 assistant 消息（没有消息则插入），并写回 session.greetingIndex
      function applyGreeting(idx) {
        if (hasUserMessage()) { toast('已经聊起来了，不能换开场白', 'info'); return Promise.resolve(); }
        if (idx === -1) return applyEmptyGreeting();
        var entry = findGreetingEntry(idx);
        if (!entry) { toast('这条问候语不存在了', 'error'); return Promise.resolve(); }
        var target = firstAssistantMessage();
        var now = U.now();
        var writeMsg;
        if (target) {
          target.content = entry.text;
          target.status = 'ok';
          target.errorText = '';
          target.errorCode = '';
          target.variants = [{ content: entry.text, createdAt: target.createdAt || now }];
          target.variantIndex = 0;
          target.isActive = true;
          writeMsg = D.put('messages', target);
        } else {
          writeMsg = D.put('messages', {
            sessionId: sessionId,
            role: 'assistant',
            content: entry.text,
            variantIndex: 0,
            isActive: true,
            status: 'ok',
            errorText: '',
            tokensIn: 0,
            tokensOut: 0,
            createdAt: now
          });
        }
        return writeMsg.then(function (saved) {
          var patch = {
            greetingIndex: entry.idx,
            lastText: K.previewMessage(saved, 60),
            lastRole: 'assistant',
            lastAt: saved.createdAt || now,
            updatedAt: now
          };
          st.session = Object.assign({}, st.session || {}, patch);
          return D.put('sessions', st.session);
        }).then(function () {
          if (st.destroyed) return null;
          return loadMessages().then(function () {
            if (st.destroyed) return null;
            renderMessagesInitial();
            scrollToBottom(true);
            markRead();
            toast('已更换开场白', 'ok');
            return null;
          });
        }).catch(function (err) {
          console.error('[chat] 应用开场白失败', err);
          toast('更换开场白失败', 'error');
        });
      }

      // 空对话：删除开场白消息（仅允许在还没有用户消息时），会话从空白开始
      function applyEmptyGreeting() {
        if (hasUserMessage()) { toast('已经聊起来了，不能换开场白', 'info'); return Promise.resolve(); }
        var target = firstAssistantMessage();
        var now = U.now();
        var chain = target ? D.del('messages', target.id) : Promise.resolve();
        return chain.then(function () {
          var patch = {
            greetingIndex: -1,
            lastText: '',
            lastRole: '',
            lastAt: 0,
            updatedAt: now
          };
          st.session = Object.assign({}, st.session || {}, patch);
          return D.put('sessions', st.session);
        }).then(function () {
          if (st.destroyed) return null;
          return loadMessages().then(function () {
            if (st.destroyed) return null;
            renderMessagesInitial();
            scrollToBottom(true);
            markRead();
            toast('已设为空对话', 'ok');
            return null;
          });
        }).catch(function (err) {
          console.error('[chat] 清空开场白失败', err);
          toast('设置失败', 'error');
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
          title: st.isGroup ? '删除群聊' : '删除会话',
          message: st.isGroup ? '将删除该群聊及其全部消息，不可恢复。确定删除吗？' : '将删除该会话及其全部消息，不可恢复。确定删除吗？',
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
            // 群聊：级联删除群记录（v1.4.0）
            var gid = st.session && st.session.groupId;
            if (!gid) return null;
            return D.del('groups', gid).catch(function () { return null; });
          }).then(function () {
            st.destroyed = true;
            toast(st.isGroup ? '已删除群聊' : '已删除会话', 'ok');
            var popped = false;
            try { popped = App.Router.pop(); } catch (e) { popped = false; }
            if (!popped) { try { App.Router.goChatList(); } catch (e2) { /* 忽略 */ } }
          });
        }).catch(function (err) {
          console.error('[chat] 删除会话失败', err);
          toast('删除失败', 'error');
        });
      }

      /* ---------------- 存档 / 读档 / 以存档开新对话（v1.3.0） ---------------- */
      function savesApi() {
        var S = App.Saves;
        if (!S || typeof S.snapshot !== 'function') {
          toast('当前版本不支持存档', 'error');
          return null;
        }
        return S;
      }

      function pad2(n) { return n < 10 ? '0' + n : String(n); }

      // 存档时间：MM-DD HH:mm
      function fmtSaveTime(ts) {
        if (!Number(ts)) return '';
        var d = new Date(Number(ts));
        return pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()) + ' ' + pad2(d.getHours()) + ':' + pad2(d.getMinutes());
      }

      function defaultSaveName() {
        var d = new Date();
        var who = (st.character && st.character.name) || (st.session && st.session.title) || '会话';
        return who + ' · ' + (d.getMonth() + 1) + '/' + d.getDate() + ' ' + pad2(d.getHours()) + ':' + pad2(d.getMinutes());
      }

      // 生成中不允许存档/读档
      function guardGenerating() {
        if (st.streaming) {
          toast('正在生成，请先停止', 'info');
          return false;
        }
        return true;
      }

      // 新建存档：先让用户起名
      function createSave() {
        var S = savesApi();
        if (!S) return;
        if (!guardGenerating()) return;
        var def = defaultSaveName();
        K.prompt({
          title: '存档',
          message: '给这个存档点起个名字',
          value: def,
          okText: '存档',
          cancelText: '取消'
        }).then(function (name) {
          if (name === null) return null; // 用户取消
          return S.snapshot(sessionId, { name: name || def }).then(function (save) {
            toast('已存档：' + ((save && save.name) || def), 'ok');
            return null;
          });
        }).catch(function (err) {
          console.error('[chat] 存档失败', err);
          toast('存档失败：' + ((err && err.message) || '未知错误'), 'error');
        });
      }

      // 存档点列表（含「新建存档」）
      function openSavesSheet() {
        var S = savesApi();
        if (!S) return;
        if (!guardGenerating()) return;
        S.list({ sessionId: sessionId }).then(function (list) {
          var items = [{
            id: '__new__',
            value: '__new__',
            label: '＋ 新建存档',
            desc: '把当前对话存成一个小档',
            icon: 'plus'
          }];
          (list || []).forEach(function (sv) {
            var n = Array.isArray(sv.messages) ? sv.messages.length : 0;
            items.push({
              id: sv.id,
              value: sv.id,
              label: sv.name || '未命名存档',
              desc: n + ' 条消息 · ' + fmtSaveTime(sv.createdAt),
              icon: 'time'
            });
          });
          return K.sheet({ title: '存档点', items: items, cancelText: '取消' });
        }).then(function (item) {
          var id = K.itemId(item);
          if (!id) return null;
          if (id === '__new__') return createSave();
          return openSaveActions(id);
        }).catch(function (err) {
          console.error('[chat] 读取存档列表失败', err);
          toast('读取存档失败', 'error');
        });
      }

      // 单个存档的操作菜单
      function openSaveActions(saveId) {
        var S = savesApi();
        if (!S) return Promise.resolve(null);
        return S.get(saveId).then(function (save) {
          if (!save) { toast('存档不存在', 'error'); return null; }
          return K.sheet({
            title: save.name || '存档',
            items: [
              { id: 'restore', value: 'restore', label: '读档', desc: '回到这个存档点（当前这段对话会被替换）', icon: 'refresh' },
              { id: 'new', value: 'new', label: '以此开新对话', desc: '保留存档，另开一个新会话', icon: 'chat' },
              { id: 'rename', value: 'rename', label: '重命名', icon: 'edit' },
              { id: 'delete', value: 'delete', label: '删除存档', icon: 'delete', danger: true }
            ],
            cancelText: '取消'
          }).then(function (item) {
            var act = K.itemId(item);
            if (!act) return null;
            if (act === 'restore') return restoreSave(saveId);
            if (act === 'new') return newChatFromSave(saveId);
            if (act === 'rename') return renameSave(save);
            if (act === 'delete') return deleteSave(save);
            return null;
          });
        }).catch(function (err) {
          console.error('[chat] 打开存档失败', err);
          toast('打开存档失败', 'error');
        });
      }

      // 读档：覆盖当前会话的消息与配置，然后重载本页
      function restoreSave(saveId) {
        var S = savesApi();
        if (!S) return Promise.resolve(null);
        if (!guardGenerating()) return Promise.resolve(null);
        return K.confirm({
          title: '读档',
          message: '回到这个存档点？当前这段对话会被替换。',
          okText: '读档',
          cancelText: '取消',
          danger: true
        }).then(function (ok) {
          if (!ok) return null;
          return S.restore(saveId).then(function (res) {
            if (st.destroyed) return null;
            st.hasOlder = false;
            st.startIndex = 0;
            return reloadMeta().then(function () {
              return loadMessages();
            }).then(function () {
              if (st.destroyed) return null;
              applyTitle();
              renderTopbar();
              renderMessagesInitial();
              U.raf(function () { scrollToBottom(true); });
              markRead();
              var name = (res && res.save && res.save.name) || '存档点';
              toast('已回到存档点：' + name, 'ok');
              return null;
            });
          });
        }).catch(function (err) {
          console.error('[chat] 读档失败', err);
          toast('读档失败：' + ((err && err.message) || '未知错误'), 'error');
        });
      }

      // 以某个存档为起点开新对话
      function newChatFromSave(saveId) {
        var S = savesApi();
        if (!S) return Promise.resolve(null);
        if (!guardGenerating()) return Promise.resolve(null);
        return S.newFromSave(saveId).then(function (session) {
          toast('已从存档点开始新对话', 'ok');
          return App.Router.push('chat', { sessionId: session.id });
        }).catch(function (err) {
          console.error('[chat] 以存档开新对话失败', err);
          toast('开新对话失败：' + ((err && err.message) || '未知错误'), 'error');
        });
      }

      function renameSave(save) {
        var S = savesApi();
        if (!S) return Promise.resolve(null);
        return K.prompt({
          title: '重命名存档',
          value: save.name || '',
          placeholder: '存档名字',
          okText: '保存',
          cancelText: '取消'
        }).then(function (name) {
          if (name === null || !name) return null;
          return S.rename(save.id, name).then(function () {
            toast('已重命名', 'ok');
            return null;
          });
        }).catch(function (err) {
          console.error('[chat] 重命名存档失败', err);
          toast('重命名失败', 'error');
        });
      }

      function deleteSave(save) {
        var S = savesApi();
        if (!S) return Promise.resolve(null);
        return K.confirm({
          title: '删除存档',
          message: '删除「' + (save.name || '存档') + '」？此操作不可恢复。',
          okText: '删除',
          cancelText: '取消',
          danger: true
        }).then(function (ok) {
          if (!ok) return null;
          return S.remove(save.id).then(function () {
            toast('已删除存档', 'ok');
            return null;
          });
        }).catch(function (err) {
          console.error('[chat] 删除存档失败', err);
          toast('删除存档失败', 'error');
        });
      }

      /* ---------------- 切换场景（v1.3.2） ---------------- */
      function openSceneSheet() {
        var scenes = (st.character && Array.isArray(st.character.scenarios)) ? st.character.scenarios.filter(Boolean) : [];
        var cur = String((st.session && st.session.scene) || '');
        var AUTO_ID = '__auto__';
        var items = [{ id: AUTO_ID, value: AUTO_ID, label: '由上下文自由判断', desc: '不限定场景，角色会根据对话自然带入环境' }];
        scenes.forEach(function (text, i) {
          var t = String(text || '').trim();
          if (!t) return;
          items.push({
            id: t, value: t,
            label: '场景 ' + (i + 1) + '：' + (t.length > 18 ? t.slice(0, 18) + '…' : t),
            desc: t
          });
        });
        if (!scenes.length) {
          items.push({ id: '__hint', value: '__hint', label: '这个角色还没有保存场景', desc: '可在角色编辑页添加多条场景，之后聊天时自由切换', icon: 'info' });
        }
        K.sheet({
          title: '这次对话发生在哪里？',
          items: items.filter(function (it) { return it.value !== '__hint'; }),
          cancelText: '取消',
          selected: cur ? cur : AUTO_ID
        }).then(function (item) {
          if (!item) return null;
          var raw = String(K.itemId(item) || '');
          var val = raw === AUTO_ID ? '' : raw;
          if (!st.session) return null;
          st.session.scene = val;
          return D.put('sessions', st.session).then(function () {
            st.scene = val;
            toast(val ? '场景已切换：' + (val.length > 20 ? val.slice(0, 20) + '…' : val) : '场景已设为「由上下文自由判断」', 'ok');
            return null;
          });
        }).catch(function (err) { console.error('[chat] 切换场景失败', err); });
      }

      /* ---------------- 我的身份 / 世界书 / 群成员（v1.4.0） ---------------- */
      function pickPersona() {
        var P = App.Persona;
        if (!P || typeof P.pickForSession !== 'function') { toast('身份模块未加载，请重启应用'); return Promise.resolve(); }
        var p;
        try { p = P.pickForSession(sessionId); } catch (e) {
          toast('打开身份选择失败', 'error');
          return Promise.resolve();
        }
        return Promise.resolve(p).then(function (res) {
          if (res === undefined) return null; // 用户取消选择
          st.persona = res || { id: '', name: '我', description: '', avatar: '' };
          if (st.session) st.session.personaId = (res && res.id) || '';
          renderTopbar();
          refreshMyAvatars(true);
          toast(res && res.id ? ('已切换身份：' + (res.name || '我')) : '已切换为不设定身份', 'ok');
          return null;
        }).catch(function (err) {
          console.error('[chat] 切换身份失败', err);
          toast('切换身份失败', 'error');
        });
      }

      function openLorebook() {
        var cid = (st.session && st.session.characterId) || '';
        if (!cid) { toast('群聊请到各角色编辑页管理世界书', 'error'); return; }
        try { App.Router.push('lorebook', { characterId: cid }); } catch (e) { toast('打开世界书失败', 'error'); }
      }

      function openGroupMembers() {
        try { App.Router.push('groupManage', { sessionId: sessionId }); } catch (e) { toast('打开群成员失败', 'error'); }
      }

      function openSessionMenu() {
        var items = [
          { id: 'rename', value: 'rename', label: '重命名会话', icon: 'edit' },
          { id: 'model', value: 'model', label: '切换模型 / API', icon: 'api' },
          { id: 'greeting', value: 'greeting', label: '换个开场白', icon: 'chat' },
          { id: 'scene', value: 'scene', label: '切换场景', icon: 'world' },
          { id: 'gen', value: 'gen', label: '生成设置（预设）', icon: 'settings' },
          { id: 'persona', value: 'persona', label: '我的身份', icon: 'user' },
          { id: 'myavatar', value: 'myavatar', label: '换我的头像', icon: 'user' },
          { id: 'bg', value: 'bg', label: '聊天背景', icon: 'star' }
        ];
        if (st.isGroup) {
          items.push({ id: 'members', value: 'members', label: '群成员', icon: 'character' });
        } else {
          items.push({ id: 'lorebook', value: 'lorebook', label: '世界书', icon: 'world' });
        }
        items.push({ id: 'save', value: 'save', label: '存档', icon: 'check' });
        items.push({ id: 'saves', value: 'saves', label: '存档点', icon: 'time' });
        if (!st.isGroup) items.push({ id: 'char', value: 'char', label: '角色信息', icon: 'character' });
        items.push({ id: 'clear', value: 'clear', label: '清空消息', icon: 'trash' });
        items.push({ id: 'delete', value: 'delete', label: '删除会话', icon: 'delete', danger: true });
        K.sheet({
          title: (st.session && st.session.title) || '会话操作',
          items: items,
          cancelText: '取消'
        }).then(function (item) {
          var act = K.itemId(item);
          if (!act) return;
          if (act === 'rename') return renameSession();
          if (act === 'model') return openModelSheet();
          if (act === 'greeting') return openGreetingSheet();
          if (act === 'scene') return openSceneSheet();
          if (act === 'gen') return openGenSettings();
          if (act === 'persona') return pickPersona();
          if (act === 'myavatar') return chooseMyAvatar();
          if (act === 'bg') return chooseChatBackground();
          if (act === 'members') return openGroupMembers();
          if (act === 'lorebook') return openLorebook();
          if (act === 'save') return createSave();
          if (act === 'saves') return openSavesSheet();
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
        // 换头像入口（v1.4.2）
        var avatarBtn = App.UI.el('button', { class: 'chat-drawer-avatarbtn', attrs: { type: 'button' }, text: '换头像' });
        avatarBtn.addEventListener('click', function () {
          chooseCharacterAvatar(st.character);
        });
        head.appendChild(avatarBtn);
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
        var curScene = (st.session && st.session.scene) || '';
        var sceneList = Array.isArray(st.character.scenarios) ? st.character.scenarios.filter(Boolean) : [];
        if (curScene) field('当前场景', curScene);
        else if (sceneList.length) field('场景', '由上下文自由判断（共 ' + sceneList.length + ' 个可选场景）');
        else field('场景', st.character.scenario);
        field('开场白', st.character.firstMessage);
        // 只读展示：角色级上帝模式开关（在角色编辑页修改）
        field('上帝模式', st.character.godMode === true ? '已开启（角色设置）' : '未开启（可在角色编辑页开启）');
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

      /* ---------------- 贴底跟随加固（v1.4.2） ----------------
         图片异步解码、字体替换、键盘/视口变化都会让内容高度在 scrollToBottom 之后继续变化，
         导致「看着像最后一条被挤出屏幕 / 与输入框贴在一起」。这里统一在这些时机重新贴底。 */
      var pinRaf = 0, pinRo = null;
      function pinToBottom() {
        if (st.destroyed || !st.followBottom) return;
        try {
          listEl.scrollTop = listEl.scrollHeight;
        } catch (e) { /* 忽略 */ }
      }
      function schedulePin() {
        if (st.destroyed || !st.followBottom || pinRaf) return;
        pinRaf = window.requestAnimationFrame(function () {
          pinRaf = 0;
          pinToBottom();
          // 再补一帧：图片解码后高度可能二次变化
          pinRaf = window.requestAnimationFrame(function () { pinRaf = 0; pinToBottom(); });
        });
      }
      function onListResLoad(ev) {
        var t = ev && ev.target;
        if (t && (t.tagName === 'IMG' || t.tagName === 'VIDEO')) schedulePin();
      }
      function onViewportChange() { schedulePin(); }
      listEl.addEventListener('load', onListResLoad, true);
      listEl.addEventListener('error', onListResLoad, true);
      window.addEventListener('resize', onViewportChange);
      window.addEventListener('kb-open', onViewportChange);
      inputEl.addEventListener('focus', function () { setTimeout(schedulePin, 120); });
      if (window.visualViewport) {
        window.visualViewport.addEventListener('resize', onViewportChange);
        window.visualViewport.addEventListener('scroll', onViewportChange);
      }
      if (window.ResizeObserver) {
        pinRo = new ResizeObserver(function () { schedulePin(); });
        try { pinRo.observe(listEl); } catch (e) { /* 忽略 */ }
      }
      setTimeout(schedulePin, 60);
      setTimeout(schedulePin, 360);
      try {
        if (document.fonts && document.fonts.ready && document.fonts.ready.then) {
          document.fonts.ready.then(function () { setTimeout(schedulePin, 0); });
        }
      } catch (e) { /* 忽略 */ }

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

      /* ---------------- 群成员加载（v1.4.0） ---------------- */
      /* 会话人格（v1.4.0）：会话未指定时回退到默认身份 */
      function resolveSessionPersona(s) {
        var pid = (s && s.personaId) || '';
        var P = App.Persona;
        if (!P || typeof P.ensureDefault !== 'function') {
          return pid ? D.get('personas', pid).catch(function () { return null; }) : null;
        }
        return Promise.resolve().then(function () { return P.ensureDefault(); }).then(function (def) {
          var id = pid || (def && def.id) || '';
          return id ? D.get('personas', id).catch(function () { return null; }) : null;
        }).catch(function () { return null; });
      }

      function loadMembers() {
        st.members = st.character ? [st.character] : [];
        st.memberById = {};
        if (!st.isGroup) {
          if (st.character && st.character.id) st.memberById[st.character.id] = st.character;
          return Promise.resolve();
        }
        var G = App.Group;
        if (!G || typeof G.membersOf !== 'function' || !st.session) return Promise.resolve();
        var p;
        try { p = G.membersOf(st.session); } catch (e) { return Promise.resolve(); }
        return Promise.resolve(p).then(function (list) {
          var arr = [];
          if (Array.isArray(list)) arr = list;
          else if (list && Array.isArray(list.members)) arr = list.members;
          arr = arr.filter(Boolean);
          st.members = arr;
          st.memberById = {};
          arr.forEach(function (c) { if (c && c.id) st.memberById[c.id] = c; });
          return null;
        }).catch(function (err) {
          console.error('[chat] 群成员加载失败', err);
        });
      }

      function load() {
        return D.get('sessions', sessionId).then(function (s) {
          if (!s) throw new Error('会话不存在或已被删除');
          st.session = s;
          return Promise.all([
            s.characterId ? D.get('characters', s.characterId).catch(function () { return null; }) : null,
            resolveSessionPersona(s),
            s.presetId ? D.get('presets', s.presetId).catch(function () { return null; }) : null
          ]);
        }).then(function (arr) {
          st.character = arr && arr[0] ? arr[0] : null;
          st.persona = arr && arr[1] ? arr[1] : null;
          st.preset = arr && arr[2] ? arr[2] : null;
          st.isGroup = !!(st.session && st.session.kind === 'group');
          if (!st.persona) st.persona = { id: '', name: '我', description: '', avatar: '' };
          if (!st.preset) st.preset = K.defaultPresetFor(st.character && st.character.type);
          st.textMode = !!(st.preset && st.preset.mode === 'text');
          return loadMembers();
        }).then(function () {
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
          scheduleAvatarRefresh();
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
            resolveSessionPersona(s),
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
          return loadMembers();
        }).then(function () {
          if (st.destroyed) return null;
          applyTitle();
          renderTopbar();
          refreshImageNodes();
          refreshMyAvatars();
          syncGuide();
          return null;
        }).catch(function (err) { console.error('[chat] 重新加载元数据失败', err); });
      }

      /* ---------------- 角色主动消息：外部会话更新（v1.2.0 契约 §3.1） ---------------- */
      // proactive.js 把主动消息落库后派发 aichat:session-updated，本页据此增量追加
      function onExternalSessionUpdate(ev) {
        if (st.destroyed) return;
        var detail = (ev && ev.detail) || {};
        if (!detail.sessionId || !st.session || detail.sessionId !== st.session.id) return;
        // 正在生成时交给流式逻辑收尾，避免两条回复互相覆盖
        if (st.streaming) return;
        D.get('sessions', sessionId).then(function (s) {
          if (st.destroyed || !s) return null;
          st.session = s;
          return loadMessages();
        }).then(function () {
          if (st.destroyed) return;
          renderTopbar();
          var nodes = listEl.querySelectorAll('.msg[data-id]');
          if (!nodes.length) {
            // 之前是空态：整体渲染
            renderMessagesInitial();
            scrollToBottom(true);
            markRead();
            return;
          }
          // 只追加「渲染窗口末尾之后」的新消息，避免把未渲染的历史消息一次性塞进 DOM
          var lastRenderedId = nodes[nodes.length - 1].getAttribute('data-id');
          var lastAt = -1;
          for (var i = 0; i < st.messages.length; i++) {
            if (st.messages[i].id === lastRenderedId) { lastAt = i; break; }
          }
          if (lastAt < 0) {
            // 渲染窗口失效（消息被替换/删除），整体重绘
            var wasBottom2 = atBottom();
            renderMessagesInitial();
            if (wasBottom2) scrollToBottom(true);
            markRead();
            return;
          }
          var tail = st.messages.slice(lastAt + 1);
          if (tail.length) {
            var wasBottom = atBottom();
            tail.forEach(function (m) { appendMsgEl(m); });
            if (wasBottom) scrollToBottom(true);
          }
          markRead();
        }).catch(function (err) {
          console.error('[chat] 刷新主动消息失败', err);
        });
      }
      document.addEventListener('aichat:session-updated', onExternalSessionUpdate);

      st.unsubRoute = App.Router.onChange(function (cur) {
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
        if (typeof st.unsubRoute === 'function') st.unsubRoute();
        // 贴底跟随的监听清理（v1.4.2）
        try { listEl.removeEventListener('load', onListResLoad, true); } catch (e) { /* 忽略 */ }
        try { listEl.removeEventListener('error', onListResLoad, true); } catch (e) { /* 忽略 */ }
        try { window.removeEventListener('resize', onViewportChange); } catch (e) { /* 忽略 */ }
        try { window.removeEventListener('kb-open', onViewportChange); } catch (e) { /* 忽略 */ }
        try {
          if (window.visualViewport) {
            window.visualViewport.removeEventListener('resize', onViewportChange);
            window.visualViewport.removeEventListener('scroll', onViewportChange);
          }
        } catch (e) { /* 忽略 */ }
        try { if (pinRo) pinRo.disconnect(); } catch (e) { /* 忽略 */ }
        if (pinRaf) { try { window.cancelAnimationFrame(pinRaf); } catch (e) { /* 忽略 */ } pinRaf = 0; }
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
        document.removeEventListener('aichat:session-updated', onExternalSessionUpdate);
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
