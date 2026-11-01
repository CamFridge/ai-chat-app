/* =========================================================================
   bubble.js —— 应用内悬浮引导气泡（成员 D）
   · 纯应用内浮层（渲染在 #overlay-root），不申请系统悬浮窗权限
   · 52dp 小球，默认右边缘垂直约 62%；可拖动、松手吸附左右边缘、位置记忆
   · 点击扇形展开 3~4 个快捷项（逐个 40ms 弹出）+ 20% 黑遮罩；长按=「怎么走」，双击收起
   · 空闲 3s 透明度 0.55；键盘/聊天输入框聚焦时上移或淡出
   · 页面感知：上下文来自当前页 page.guideCtx（App.Router.current().entry.guideCtx）
   · 首次提示：bubble_hint_shown=false 时首次进主界面 2s 后呼吸一次 + 「有问题点这里问我」
   · 设置键：bubble_enabled / bubble_position / bubble_hint_shown
   ========================================================================= */
(function () {
  'use strict';
  var App = window.App = window.App || {};
  var B = App.Bubble = {};

  function U() { return App.Util; }
  function UI() { return App.UI; }

  var SIZE = 52;                 // 小球直径 dp
  var MARGIN = 8;                // 距屏幕边缘最小留白
  var SAFE_GAP = 12;             // 与底部 Tab 的间距
  var IDLE_MS = 3000;            // 空闲降低透明度
  var LONG_PRESS_MS = 480;       // 长按
  var DOUBLE_MS = 300;           // 双击间隔

  var state = {
    mounted: false,
    enabled: true,
    edge: 'right',
    y: 0.62,
    expanded: false,
    panel: null,
    panelMask: null,
    mask: null,
    hint: null,
    lastTapAt: 0,
    root: null,
    ball: null,
    fan: null,
    items: [],
    pageName: null,
    timers: { refresh: null, idle: null, hint: null, hintHide: null, long: null, click: null },
    drag: null,
    idleTimer: null,
    reduceMotion: false
  };

  try {
    state.reduceMotion = !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  } catch (e) { state.reduceMotion = false; }

  /* ======================================================================
     一、几何计算（只用 transform 定位，避免触发 layout）
     ====================================================================== */
  function metrics() {
    var vw = document.documentElement.clientWidth || window.innerWidth || 360;
    var vh = (window.visualViewport && window.visualViewport.height) || document.documentElement.clientHeight || window.innerHeight || 640;
    var tabbar = document.getElementById('tabbar');
    var tabH = 0;
    if (tabbar && !tabbar.classList.contains('hidden')) {
      var r = tabbar.getBoundingClientRect();
      tabH = r && r.height ? r.height : 56;
    }
    var minX = MARGIN;
    var maxX = Math.max(minX, vw - SIZE - MARGIN);
    var minY = MARGIN;
    /* 小球底边与 Tab 保持 ≥12dp（无 Tab 的二级页则贴底 12dp） */
    var maxY = Math.max(minY, vh - tabH - SAFE_GAP - SIZE);
    return { vw: vw, vh: vh, minX: minX, maxX: maxX, minY: minY, maxY: maxY, tabH: tabH };
  }

  function targetPos() {
    var m = metrics();
    var x = state.edge === 'right' ? m.maxX : m.minX;
    var ty = m.minY + (m.maxY - m.minY) * U().clamp(state.y, 0, 1);
    return { x: Math.round(x), y: Math.round(ty), m: m };
  }

  function applyBallPos(x, y, animate) {
    if (!state.ball) return;
    state.ball.style.transition = animate ? '' : 'none';
    state.ball.style.transform = 'translate3d(' + Math.round(x) + 'px,' + Math.round(y) + 'px,0)';
    if (!animate) {
      /* 强制一次重排后恢复过渡（拖拽结束回弹用） */
      void state.ball.offsetWidth;
      state.ball.style.transition = '';
    }
  }

  function placeBall(animate) {
    var p = targetPos();
    applyBallPos(p.x, p.y, animate);
    if (state.hint) positionHint();
    if (state.expanded) layoutFan();
    if (state.panel) positionPanel();
  }

  function ballRect() {
    if (!state.ball) return { x: 0, y: 0, w: SIZE, h: SIZE };
    var r = state.ball.getBoundingClientRect();
    return { x: r.left, y: r.top, w: r.width || SIZE, h: r.height || SIZE };
  }

  function ballCenter() {
    var r = ballRect();
    return { x: r.x + r.w / 2, y: r.y + r.h / 2 };
  }

  /* ======================================================================
     二、DOM 构建
     ====================================================================== */
  function ensureRoot() {
    if (state.root) return state.root;
    var ui = UI();
    var root = ui.el('div', { class: 'bubble-root', attrs: { 'data-bubble-root': '1' } });
    var ball = ui.el('button', {
      class: 'bubble-ball', type: 'button',
      attrs: {
        'aria-label': '引导助手',
        'aria-haspopup': 'dialog',
        'aria-expanded': 'false'
      }
    });
    ball.appendChild(ui.el('span', { class: 'bubble-q', attrs: { 'aria-hidden': 'true' }, text: '?' }));
    ball.appendChild(ui.el('span', { class: 'bubble-ball-label', attrs: { 'aria-hidden': 'true' }, text: '引导' }));

    root.appendChild(ball);
    var host = document.getElementById('overlay-root') || document.body;
    host.appendChild(root);

    state.root = root;
    state.ball = ball;
    bindBall(ball);
    poke();
    return root;
  }

  function teardownDom() {
    closePanel(true);
    collapseFan(true);
    dismissHint();
    if (state.root && state.root.parentNode) state.root.parentNode.removeChild(state.root);
    state.root = null;
    state.ball = null;
    state.fan = null;
    state.items = [];
    state.drag = null;
  }

  /* ======================================================================
     三、小球交互：拖动 / 吸附 / 长按 / 双击 / 点击
     ====================================================================== */
  function bindBall(ball) {
    var drag = null;

    function onDown(ev) {
      if (ev.pointerType === 'mouse' && ev.button !== 0) return;
      if (state.panel) { closePanel(); return; }
      drag = {
        id: ev.pointerId,
        sx: ev.clientX, sy: ev.clientY,
        base: targetPos(),
        moved: false, longFired: false,
        t: Date.now()
      };
      state.drag = drag;
      ball.classList.add('pressing');
      ball.classList.remove('idle');
      try { ball.setPointerCapture(ev.pointerId); } catch (e) {}
      clearTimeout(state.timers.long);
      state.timers.long = setTimeout(function () {
        if (!state.drag || state.drag.moved) return;
        state.drag.longFired = true;
        if (drag && drag.id !== undefined) { /* 保持引用 */ }
        ball.classList.remove('pressing');
        try { if (App.Bridge && App.Bridge.call) App.Bridge.call('ui.vibrate', { ms: 20 }).catch(function () {}); } catch (e) {}
        if (state.expanded) collapseFan();
        runNextStep();
      }, LONG_PRESS_MS);
      poke();
      ev.preventDefault();
    }

    function onMove(ev) {
      if (!drag || ev.pointerId !== drag.id) return;
      var dx = ev.clientX - drag.sx;
      var dy = ev.clientY - drag.sy;
      if (!drag.moved) {
        if (Math.abs(dx) < 8 && Math.abs(dy) < 8) return;
        drag.moved = true;
        clearTimeout(state.timers.long);
        closePanel();
        collapseFan();
      }
      var m = drag.base.m;
      var nx = U().clamp(drag.base.x + dx, m.minX - 4, m.maxX + 4);
      var ny = U().clamp(drag.base.y + dy, m.minY - 4, m.maxY + 4);
      applyBallPos(nx, ny, false);
      poke();
      ev.preventDefault();
    }

    function finishDrag(ev) {
      if (!drag || (ev && ev.pointerId !== drag.id)) return;
      clearTimeout(state.timers.long);
      var d = drag;
      drag = null;
      state.drag = null;
      ball.classList.remove('pressing');
      try { ball.releasePointerCapture(d.id); } catch (e) {}
      poke();

      if (d.moved) {
        var m = metrics();
        var r = ballRect();
        var centerX = r.x + r.w / 2;
        var edge = centerX < m.vw / 2 ? 'left' : 'right';
        var y = (m.maxY - m.minY) > 0 ? (r.y - m.minY) / (m.maxY - m.minY) : state.y;
        state.edge = edge;
        state.y = U().clamp(y, 0, 1);
        savePosition();
        placeBall(true);
        return;
      }
      if (d.longFired) return;

      /* 点击 / 双击判定 */
      var now = Date.now();
      var firstTap = !state.timers.click;
      if (!firstTap && state.lastTapAt && now - state.lastTapAt <= DOUBLE_MS) {
        clearTimeout(state.timers.click);
        state.timers.click = null;
        state.lastTapAt = 0;
        dismissHint();
        B.collapse();
        return;
      }
      state.lastTapAt = now;
      if (state.timers.click) return;
      state.timers.click = setTimeout(function () {
        state.timers.click = null;
        state.lastTapAt = 0;
        dismissHint();
        if (state.expanded) collapseFan(); else expandFan();
      }, state.reduceMotion ? 0 : 230);
    }

    ball.addEventListener('pointerdown', onDown);
    ball.addEventListener('pointermove', onMove);
    ball.addEventListener('pointerup', finishDrag);
    ball.addEventListener('pointercancel', function (ev) {
      if (drag) { clearTimeout(state.timers.long); drag = null; state.drag = null; ball.classList.remove('pressing'); }
      state.drag = null;
    });
    ball.addEventListener('contextmenu', function (ev) { ev.preventDefault(); });
    /* 触摸开始就恢复不透明度（无需等待 3s 空闲计时） */
    ball.addEventListener('touchstart', function () { poke(); }, { passive: true });
  }

  function savePosition() {
    if (!App.DB || !App.DB.settings) return;
    App.DB.settings.set('bubble_position', { edge: state.edge, y: Math.round(state.y * 1000) / 1000 })
      .catch(function (e) { console.warn('[bubble] 位置保存失败', e); });
  }

  function poke() {
    clearTimeout(state.idleTimer);
    if (state.ball) state.ball.classList.remove('idle');
    state.idleTimer = setTimeout(function () {
      if (!state.mounted) return;
      if (state.expanded || state.panel) return;
      if (state.ball) state.ball.classList.add('idle');
    }, IDLE_MS);
  }

  /* ======================================================================
     四、展开扇形快捷项
     ====================================================================== */
  function getContext() {
    var cur = null;
    try { cur = App.Router && App.Router.current ? App.Router.current() : null; } catch (e) { cur = null; }
    var ctx = null;
    if (cur) {
      ctx = (cur.entry && cur.entry.guideCtx) || (cur.page && cur.page.guideCtx) || null;
    }
    if (ctx) return ctx;
    /* 兜底：没有注册 guide 上下文的页面，也给一个最小上下文 */
    return {
      pageId: cur ? cur.name : '',
      title: (App.Guide && App.Guide.pageLabel) ? App.Guide.pageLabel(cur ? cur.name : '') : '',
      stage: '', totalSteps: 0, filledFields: {}, missingFields: [], error: null
    };
  }
  B.getContext = getContext;

  function computeItems(ctx) {
    var items = [];
    items.push({ key: 'next', label: '怎么走', icon: 'guide', run: runNextStep });
    items.push({
      key: 'ask', label: '问引导', icon: 'chat', run: function () {
        if (App.Help && App.Help.open) App.Help.open({ source: 'bubble_help', page: ctx && ctx.pageId });
      }
    });
    /* 多步创建向导期间只保留「怎么走 / 问引导」，避免干扰（单页 stage 不算向导） */
    if (ctx && ctx.stage && Number(ctx.totalSteps) > 1) return items;
    if (ctx && ctx.error) {
      items.push({
        key: 'error', label: '这啥意思', icon: 'warning', run: function () {
          if (App.Help && App.Help.open) App.Help.open({ source: 'bubble_error', error: ctx.error, page: ctx.pageId });
        }
      });
    }
    items.push({
      key: 'help', label: '帮助', icon: 'help', run: function () {
        try {
          var ret = App.Router && App.Router.push('help');
          if (ret && ret.catch) ret.catch(function () { UI().toast('使用帮助暂时打不开', 'error'); });
        } catch (e) { UI().toast('使用帮助暂时打不开', 'error'); }
      }
    });
    return items.slice(0, 4);
  }

  function expandFan() {
    if (state.expanded || !state.ball) return;
    state.expanded = true;
    state.ball.setAttribute('aria-expanded', 'true');
    state.ball.classList.add('open');
    poke();

    var ui = UI();
    var mask = ui.el('div', { class: 'bubble-mask', attrs: { 'aria-hidden': 'true' } });
    mask.addEventListener('click', function () { collapseFan(); });
    mask.addEventListener('pointerdown', function (ev) { ev.stopPropagation(); });
    state.root.appendChild(mask);
    state.mask = mask;
    requestAnimationFrame(function () { if (state.mask) state.mask.classList.add('show'); });

    var fan = ui.el('div', { class: 'bubble-fan', attrs: { role: 'menu', 'aria-label': '引导快捷项' } });
    var ctx = getContext();
    var items = computeItems(ctx);
    state.fan = fan;
    state.items = [];
    state.root.appendChild(fan);

    var c = ballCenter();
    items.forEach(function (item, i) {
      var el = ui.el('button', {
        class: 'bubble-item', type: 'button',
        attrs: { role: 'menuitem', 'aria-label': item.label },
        on: {
          click: function (ev) {
            ev.preventDefault();
            ev.stopPropagation();
            collapseFan();
            try { item.run(); } catch (e) { console.error('[bubble] 快捷项执行失败', e); UI().toast('操作没能完成', 'error'); }
          }
        }
      });
      var circle = ui.el('span', { class: 'bubble-item-circle', html: ui.icon(item.icon, 20) });
      var label = ui.el('span', { class: 'bubble-item-label', text: item.label });
      el.appendChild(circle);
      el.appendChild(label);
      /* 初始位置：小球中心，缩到很小 */
      el.style.transform = 'translate3d(' + (c.x - 22) + 'px,' + (c.y - 22) + 'px,0) scale(.3)';
      el.style.opacity = '0';
      el.style.transitionDelay = (i * 40) + 'ms';
      fan.appendChild(el);
      state.items.push({ el: el, item: item, index: i });
    });

    requestAnimationFrame(function () {
      layoutFan(true);
      state.items.forEach(function (it, i) {
        it.el.style.transitionDelay = (i * 40) + 'ms';
        it.el.style.opacity = '1';
      });
    });
  }

  function layoutFan(buildScale) {
    if (!state.items.length) return;
    var m = metrics();
    var c = ballCenter();
    var n = state.items.length;
    var radius = n > 3 ? 108 : 96;
    var baseAngle = state.edge === 'right' ? Math.PI : 0;
    var spread = n <= 2 ? 0.9 : 1.55;
    state.items.forEach(function (it, i) {
      var a = n === 1 ? baseAngle : (baseAngle - spread / 2 + spread * (i / (n - 1)));
      var ax = c.x + Math.cos(a) * radius;
      var ay = c.y + Math.sin(a) * radius;
      ax = U().clamp(ax, 12 + 22, m.vw - 12 - 22);
      ay = U().clamp(ay, 12 + 22, m.vh - 12 - 22);
      it.el.style.transform = 'translate3d(' + Math.round(ax - 22) + 'px,' + Math.round(ay - 22) + 'px,0) scale(1)';
    });
  }

  function collapseFan(immediate) {
    var mask = state.mask;
    state.mask = null;
    if (mask) {
      mask.classList.remove('show');
      setTimeout(function () { if (mask.parentNode) mask.parentNode.removeChild(mask); }, 200);
    }
    var fan = state.fan;
    var items = state.items;
    state.fan = null;
    state.items = [];
    state.expanded = false;
    if (state.ball) {
      state.ball.classList.remove('open');
      state.ball.setAttribute('aria-expanded', 'false');
    }
    if (fan) {
      var c = ballCenter();
      items.forEach(function (it) {
        it.el.style.opacity = '0';
        it.el.style.transitionDelay = '0ms';
        it.el.style.transform = 'translate3d(' + (c.x - 22) + 'px,' + (c.y - 22) + 'px,0) scale(.3)';
        it.el.style.pointerEvents = 'none';
      });
      var wait = immediate ? 0 : 180;
      setTimeout(function () { if (fan.parentNode) fan.parentNode.removeChild(fan); }, wait);
    }
    poke();
  }

  /* ======================================================================
     五、结果面板（怎么走 / 兜底 / 配置引导）
     ====================================================================== */
  function closePanel(immediate) {
    var mask = state.panelMask;
    var panel = state.panel;
    state.panelMask = null;
    state.panel = null;
    if (mask) {
      mask.classList.remove('show');
      setTimeout(function () { if (mask.parentNode) mask.parentNode.removeChild(mask); }, immediate ? 0 : 200);
    }
    if (panel) {
      panel.classList.remove('show');
      setTimeout(function () { if (panel.parentNode) panel.parentNode.removeChild(panel); }, immediate ? 0 : 200);
    }
  }

  function openPanel(opts) {
    opts = opts || {};
    closePanel(true);
    var ui = UI();
    if (state.expanded) collapseFan();

    var mask = ui.el('div', { class: 'bubble-panel-mask', attrs: { 'aria-hidden': 'true' } });
    mask.addEventListener('click', function () { closePanel(); });
    var panel = ui.el('div', {
      class: 'bubble-panel', attrs: { role: 'dialog', 'aria-modal': 'false', 'aria-label': opts.title || '引导' }
    });

    var head = ui.el('div', { class: 'bubble-panel-head' });
    head.appendChild(ui.el('span', { class: 'bubble-panel-title', text: opts.title || '怎么走' }));
    var closeBtn = ui.el('button', {
      class: 'bubble-panel-close', type: 'button', html: ui.icon('close', 18),
      attrs: { 'aria-label': '关闭' }
    });
    closeBtn.addEventListener('click', function () { closePanel(); });
    head.appendChild(closeBtn);
    panel.appendChild(head);

    var body = ui.el('div', { class: 'bubble-panel-body' });
    if (typeof opts.body === 'string') body.appendChild(ui.el('div', { class: 'bubble-panel-text', text: opts.body }));
    else if (opts.body) body.appendChild(opts.body);
    panel.appendChild(body);

    if (opts.loading) {
      var loading = ui.el('div', { class: 'bubble-panel-loading' });
      loading.appendChild(ui.spinnerEl());
      loading.appendChild(ui.el('span', { text: opts.loadingText || '正在想下一步…' }));
      body.appendChild(loading);
    }

    if (opts.actions && opts.actions.length) {
      var foot = ui.el('div', { class: 'bubble-panel-foot' });
      opts.actions.slice(0, 3).forEach(function (a) {
        var btn = ui.el('button', {
          class: 'btn small ' + (a.class || ''), type: 'button', text: a.text || '好',
          on: { click: function (ev) { ev.preventDefault(); try { if (a.onClick) a.onClick(); } catch (e) { console.error(e); } } }
        });
        foot.appendChild(btn);
      });
      panel.appendChild(foot);
    }

    state.root.appendChild(mask);
    state.root.appendChild(panel);
    state.panelMask = mask;
    state.panel = panel;
    positionPanel();
    requestAnimationFrame(function () {
      if (mask) mask.classList.add('show');
      if (panel) panel.classList.add('show');
    });
    poke();
    return panel;
  }

  function positionPanel() {
    var panel = state.panel;
    if (!panel || !state.root) return;
    var m = metrics();
    var r = ballRect();
    var pw = panel.offsetWidth || 280;
    var ph = panel.offsetHeight || 180;
    var x, y;
    if (state.edge === 'right') {
      x = r.x - pw - 12;
      if (x < MARGIN) x = Math.max(MARGIN, Math.min(m.vw - pw - MARGIN, r.x - pw + 8));
    } else {
      x = r.x + r.w + 12;
      if (x + pw > m.vw - MARGIN) x = Math.max(MARGIN, m.vw - pw - MARGIN);
    }
    y = r.y + r.h / 2 - ph / 2;
    if (y < MARGIN + 8) y = Math.min(m.vh - ph - MARGIN, MARGIN + 8);
    if (y + ph > m.vh - MARGIN) y = Math.max(MARGIN, m.vh - ph - MARGIN);
    panel.style.transform = 'translate3d(' + Math.round(x) + 'px,' + Math.round(y) + 'px,0)';
  }

  /* 静态 FAQ 兜底（最多 2 条，面板里保持紧凑） */
  function faqFallbackNode(query, title) {
    var ui = UI();
    var box = ui.el('div', { class: 'bubble-faq' });
    box.appendChild(ui.el('div', { class: 'bubble-faq-title', text: title || '离线 FAQ 参考' }));
    var items = (App.Data && App.Data.matchFaq) ? App.Data.matchFaq(query, 2) : [];
    if (!items.length) items = ((App.Data && App.Data.FAQ) || []).slice(0, 2);
    items.forEach(function (f) {
      var row = ui.el('div', { class: 'bubble-faq-item' });
      row.appendChild(ui.el('div', { class: 'bubble-faq-q', text: f.q }));
      var a = ui.el('div', { class: 'bubble-faq-a', text: f.a });
      row.appendChild(a);
      row.addEventListener('click', function () { row.classList.toggle('open'); });
      box.appendChild(row);
    });
    var more = ui.el('button', {
      class: 'bubble-link', type: 'button', text: '查看全部使用帮助 →',
      on: {
        click: function () {
          try {
            var ret = App.Router && App.Router.push('help');
            if (ret && ret.catch) ret.catch(function () { UI().toast('使用帮助暂时打不开', 'error'); });
            closePanel();
          } catch (e) {}
        }
      }
    });
    box.appendChild(more);
    return box;
  }

  function openSetupPanel(reason) {
    var ui = UI();
    var body = ui.el('div');
    body.appendChild(ui.el('div', {
      class: 'bubble-panel-desc',
      text: reason || '「怎么走」需要用引导 API 回答。配置一条 API 后就能结合当前页面告诉我下一步。'
    }));
    body.appendChild(faqFallbackNode('API 配置', '先看看离线 FAQ'));
    openPanel({
      title: '还没配置引导 API',
      body: body,
      actions: [
        {
          text: '去配置引导 API', class: 'primary', onClick: function () {
            closePanel();
            try { App.Router.tab('apiList'); } catch (e) {}
          }
        },
        {
          text: '问引导', onClick: function () {
            closePanel();
            if (App.Help && App.Help.open) App.Help.open({ source: 'bubble_next_step', page: getContext().pageId });
          }
        }
      ]
    });
  }

  function openResultPanel(parsed, rawText, ctx) {
    var ui = UI();
    var body = ui.el('div');
    if (parsed && parsed.summary) {
      body.appendChild(ui.el('div', { class: 'bubble-summary', text: parsed.summary }));
    }
    if (parsed && parsed.steps && parsed.steps.length) {
      var steps = (App.Guide && App.Guide.renderSteps) ? App.Guide.renderSteps(parsed.steps) : null;
      if (steps) {
        steps.classList.add('bubble-steps');
        body.appendChild(steps);
      }
    } else {
      var raw = (App.Guide && App.Guide.plainFallback) ? App.Guide.plainFallback(rawText) : String(rawText || '');
      if (raw) {
        body.appendChild(ui.el('div', { class: 'bubble-plain', text: raw }));
        body.appendChild(ui.el('div', { class: 'bubble-plain-tip', text: '回答格式没看懂，已按原文展示。' }));
      } else {
        body.appendChild(ui.el('div', { class: 'bubble-panel-desc', text: '没有拿到可用的回答，换个问法或直接问引导助手吧。' }));
      }
    }
    openPanel({
      title: '下一步',
      body: body,
      actions: [
        {
          text: '问引导', class: 'primary', onClick: function () {
            closePanel();
            if (App.Help && App.Help.open) App.Help.open({ source: 'bubble_next_step', page: ctx && ctx.pageId });
          }
        },
        { text: '关掉', onClick: function () { closePanel(); } }
      ]
    });
  }

  function openNextStepError(err, ctx, retryFn) {
    var ui = UI();
    var info = (App.Data && App.Data.errorInfo) ? App.Data.errorInfo(err && err.code) : null;
    var body = ui.el('div');
    var msg = (info ? (info.title + '：' + info.fix) : '引导助手暂时没能回答，可能是网络或 API 的问题。');
    if (err && err.message) msg += '（' + String(err.message).slice(0, 120) + '）';
    body.appendChild(ui.el('div', { class: 'bubble-panel-desc', text: msg }));
    body.appendChild(faqFallbackNode((err && err.code) || 'API 配置', '离线 FAQ 参考'));
    openPanel({
      title: '没想出来',
      body: body,
      actions: [
        { text: '重试', class: 'primary', onClick: function () { closePanel(); if (retryFn) retryFn(); } },
        {
          text: '问引导', onClick: function () {
            closePanel();
            if (App.Help && App.Help.open) App.Help.open({ source: 'bubble_next_step', page: ctx && ctx.pageId });
          }
        }
      ]
    });
  }

  /* ======================================================================
     六、「怎么走」：调用引导 API，解析为可点击步骤
     ====================================================================== */
  function runNextStep() {
    var ctx = getContext();
    if (!ctx || !ctx.pageId) {
      UI().toast('还没进入页面，稍等一下再试', 'error');
      return Promise.resolve();
    }
    var ui = UI();
    if (!ui || !App.API) { UI().toast('API 模块未加载', 'error'); return Promise.resolve(); }
    openPanel({ title: '怎么走', body: null, loading: true, loadingText: '正在结合当前页面想下一步…' });

    return App.DB.query('providers', { where: { role: 'guide' } }).then(function (rows) {
      var provider = (rows || [])[0] || null;
      if (!provider) {
        closePanel(true);
        openSetupPanel('还没有可用的引导 API，先配置一条吧。');
        return null;
      }
      if (!App.Guide || !App.Guide.buildNextStepPrompt) {
        closePanel(true);
        UI().toast('引导模块未加载', 'error');
        return null;
      }
      var prompt = App.Guide.buildNextStepPrompt(ctx);
      return App.API.completion({
        provider: provider,
        model: provider.defaultModel || '',
        system: prompt.system,
        user: prompt.user,
        params: { temperature: 0.3, max_tokens: 600 },
        timeoutMs: 30000
      }).then(function (r) {
        if (!r || !r.ok) {
          closePanel(true);
          openNextStepError((r && r.error) || { code: 'unknown', message: '没有返回内容' }, ctx, runNextStep);
          return null;
        }
        var parsed = App.Guide.parseNextStep(r.text);
        closePanel(true);
        openResultPanel(parsed, r.text, ctx);
        return null;
      });
    }).catch(function (e) {
      console.error('[bubble] 怎么走失败', e);
      closePanel(true);
      openNextStepError(e || { code: 'unknown', message: '请求失败' }, ctx, runNextStep);
      return null;
    });
  }

  /* ======================================================================
     七、首次发现性提示
     ====================================================================== */
  function dismissHint() {
    clearTimeout(state.timers.hint);
    clearTimeout(state.timers.hintHide);
    state.timers.hint = null;
    state.timers.hintHide = null;
    if (state.ball) state.ball.classList.remove('breath');
    var hint = state.hint;
    state.hint = null;
    if (hint) {
      hint.classList.remove('show');
      setTimeout(function () { if (hint.parentNode) hint.parentNode.removeChild(hint); }, 200);
    }
  }

  function showHint() {
    if (!state.root || !state.ball || state.hint) return;
    var ui = UI();
    var hint = ui.el('div', { class: 'bubble-hint', attrs: { role: 'status' } });
    hint.appendChild(ui.el('div', { class: 'bubble-hint-text', text: '有问题点这里问我' }));
    hint.addEventListener('click', function () { dismissHint(); });
    state.root.appendChild(hint);
    state.hint = hint;
    state.ball.classList.add('breath');
    positionHint();
    requestAnimationFrame(function () { if (hint) hint.classList.add('show'); });
    clearTimeout(state.timers.hintHide);
    state.timers.hintHide = setTimeout(function () { dismissHint(); }, 5000);
  }

  function positionHint() {
    if (!state.hint || !state.ball) return;
    var m = metrics();
    var r = ballRect();
    var hw = state.hint.offsetWidth || 150;
    var hh = state.hint.offsetHeight || 34;
    var x = state.edge === 'right' ? (r.x - hw - 10) : (r.x + r.w + 10);
    x = U().clamp(x, MARGIN, m.vw - hw - MARGIN);
    var y = U().clamp(r.y + r.h / 2 - hh / 2, MARGIN, m.vh - hh - MARGIN);
    state.hint.style.transform = 'translate3d(' + Math.round(x) + 'px,' + Math.round(y) + 'px,0)';
  }

  function maybeShowHintOnce() {
    if (!App.DB || !App.DB.settings) return;
    App.DB.settings.get('bubble_hint_shown', false).then(function (shown) {
      if (shown) return null;
      if (!state.mounted || !state.enabled) return null;
      var cur = null;
      try { cur = App.Router && App.Router.current ? App.Router.current() : null; } catch (e) { cur = null; }
      /* 只在主界面（Tab 页）提示，向导/二级页不打扰 */
      if (!cur || !(cur.entry && cur.entry.isTab) || cur.name === 'onboarding') return null;
      clearTimeout(state.timers.hint);
      state.timers.hint = setTimeout(function () {
        if (!state.mounted || !state.enabled || state.expanded || state.panel) return;
        showHint();
        App.DB.settings.set('bubble_hint_shown', true).catch(function () {});
      }, 2000);
      return null;
    }).catch(function () { return null; });
  }

  /* ======================================================================
     八、可见性 / 刷新（router 每次导航都会调用，必须轻量幂等）
     ====================================================================== */
  function shouldShow() {
    if (!state.enabled) return false;
    if (App.Help && typeof App.Help.isOpen === 'function' && App.Help.isOpen()) return false;
    var cur = null;
    try { cur = App.Router && App.Router.current ? App.Router.current() : null; } catch (e) { cur = null; }
    if (cur && cur.name === 'onboarding') return false;
    if (!cur) return false;
    /* 聊天输入框聚焦时的淡出由 CSS（body.chat-input-focus）处理，
       这里不硬隐藏，保证键盘收起后能平滑恢复 */
    return true;
  }

  function applyRefresh() {
    if (!state.mounted) return;
    if (!state.enabled) {
      teardownDom();
      return;
    }
    var cur = null;
    try { cur = App.Router && App.Router.current ? App.Router.current() : null; } catch (e) { cur = null; }
    var pageName = cur ? cur.name : '';
    if (state.pageName !== pageName) {
      state.pageName = pageName;
      if (state.expanded) collapseFan();
      closePanel();
    }
    if (!shouldShow()) {
      dismissHint();
      if (state.root) state.root.classList.add('bubble-hidden');
      return;
    }
    ensureRoot();
    if (state.root) state.root.classList.remove('bubble-hidden');
    if (!state.drag) placeBall(false);   /* 拖动过程中不要抢回位置 */
    poke();
  }

  /* 60ms 合并刷新：router 每次导航/标题变化都会调用，必须轻量且幂等 */
  function scheduleRefresh() {
    clearTimeout(state.timers.refresh);
    state.timers.refresh = setTimeout(function () {
      state.timers.refresh = null;
      /* 每次都重读设置，设置页切换开关 / 恢复默认位置后立即生效 */
      loadSettings().then(function () {
        applyRefresh();
        return null;
      }).catch(function () {
        applyRefresh();
      });
    }, 60);
  }

  B.refresh = function () {
    if (!state.mounted) return B;
    scheduleRefresh();
    return B;
  };

  B.isOpen = function () { return !!(state.expanded || state.panel); };

  B.collapse = function () {
    var was = B.isOpen() || !!state.hint;
    dismissHint();
    closePanel();
    collapseFan();
    poke();
    return was;
  };

  /* ======================================================================
     九、挂载 / 全局监听
     ====================================================================== */
  function loadSettings() {
    if (!App.DB || !App.DB.settings) {
      state.enabled = true;
      state.edge = 'right';
      state.y = 0.62;
      return Promise.resolve();
    }
    return App.DB.settings.getMany(['bubble_enabled', 'bubble_position'], { bubble_enabled: true, bubble_position: null })
      .then(function (vals) {
        state.enabled = vals.bubble_enabled !== false;
        var pos = vals.bubble_position;
        if (pos && typeof pos === 'object') {
          state.edge = pos.edge === 'left' ? 'left' : 'right';
          var y = Number(pos.y);
          state.y = isFinite(y) ? U().clamp(y, 0, 1) : 0.62;
        }
        return null;
      }).catch(function () {
        state.enabled = true;
        return null;
      });
  }

  function bindGlobal() {
    var onResize = function () {
      if (!state.mounted || !state.root) return;
      placeBall(false);
    };
    window.addEventListener('resize', onResize);
    if (window.visualViewport) window.visualViewport.addEventListener('resize', onResize);
    /* 聊天输入框聚焦时淡出：CSS 已处理（body.chat-input-focus），这里只保证键盘弹起时重新定位 */
    document.addEventListener('focusin', function (ev) {
      if (!state.mounted) return;
      poke();
      if (ev && ev.target && ev.target.closest && ev.target.closest('.composer')) {
        setTimeout(function () { if (state.mounted) placeBall(false); }, 260);
      }
    });
    /* 页面切换：router 会主动 refresh，但底部 Tab 高度变化（隐藏/显示）需要重新定位 */
    if (App.Router && App.Router.onChange) {
      App.Router.onChange(function () {
        poke();
        if (state.mounted) scheduleRefresh();
      });
    }
  }

  B.mount = function () {
    if (state.mounted) return B;
    state.mounted = true;
    bindGlobal();
    loadSettings().then(function () {
      if (!state.mounted) return null;
      if (!state.enabled) return null;
      applyRefresh();
      maybeShowHintOnce();
      return null;
    }).catch(function (e) {
      console.error('[bubble] 挂载失败', e);
      return null;
    });
    return B;
  };

  B.enabled = function () { return state.enabled; };
  B.position = function () { return { edge: state.edge, y: state.y }; };
})();
