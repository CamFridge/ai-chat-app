/* router.js —— 页面注册表 + 导航栈 + 导航栏/底部 Tab，挂到 window.App.Router */
(function () {
  'use strict';
  var App = window.App = window.App || {};
  var R = App.Router = {};

  var TABS = [
    { name: 'chatList', label: '聊天', icon: 'chat', title: '聊天' },
    { name: 'characters', label: '角色', icon: 'character', title: '角色管理' },
    { name: 'apiList', label: 'API', icon: 'api', title: 'API 管理' },
    { name: 'settings', label: '设置', icon: 'settings', title: '设置' }
  ];
  var TAB_NAMES = TABS.map(function (t) { return t.name; });
  var defs = Object.create(null);      // name -> cfg
  var tabEntries = Object.create(null); // name -> entry（缓存，不销毁）
  var stack = [];                       // 当前栈：底部通常是 tab entry，二级页压栈
  var listeners = [];
  var inited = false;
  var busy = false;
  var backGuard = null;                 // fn() -> bool，返回 true 表示已消费

  var els = {};

  /* ---------------- 页面条目 ---------------- */
  function makeEntry(name, params, cfg, isTab) {
    var pageEl = document.createElement('div');
    pageEl.className = 'page';
    pageEl.setAttribute('data-page', name);
    pageEl.style.display = 'none';
    var entry = {
      name: name, params: params || {}, cfg: cfg, isTab: !!isTab,
      el: pageEl, destroyFns: [], built: false, guideCtx: null, page: null, dead: false
    };
    var handle = entry.page = {
      name: name,
      params: entry.params,
      root: pageEl,
      el: pageEl,
      setTitle: function (t) {
        entry.title = String(t || '');
        if (current() && current().entry === entry) renderTitle();
      },
      setActions: function (list) {
        entry.actions = list || [];
        if (current() && current().entry === entry) renderActions();
      },
      setBackVisible: function (v) {
        entry.forceHideBack = v === false;
        if (current() && current().entry === entry) renderBack();
      },
      guide: function (ctx) {
        entry.guideCtx = ctx || null;
        notify();
        if (App.Bubble && App.Bubble.refresh) { try { App.Bubble.refresh(); } catch (e) {} }
      },
      onDestroy: function (fn) { if (typeof fn === 'function') entry.destroyFns.push(fn); }
    };
    return entry;
  }

  function destroyEntry(entry) {
    if (!entry || entry.dead) return;
    entry.dead = true;
    entry.destroyFns.forEach(function (fn) { try { fn(); } catch (e) { console.error('[router] onDestroy 出错', e); } });
    if (entry.el && entry.el.parentNode) entry.el.parentNode.removeChild(entry.el);
  }

  function buildInto(entry) {
    if (entry.built) return Promise.resolve(entry);
    entry.built = true;
    var cfg = entry.cfg || {};
    var fn = cfg.build;
    if (typeof fn !== 'function') {
      entry.el.appendChild(App.UI.errorState({ title: '页面未实现', desc: '页面 ' + entry.name + ' 缺少 build 函数' }));
      return Promise.resolve(entry);
    }
    var loading = document.createElement('div');
    loading.className = 'loading';
    loading.appendChild(App.UI.spinnerEl ? App.UI.spinnerEl() : document.createElement('span'));
    loading.appendChild(document.createTextNode('加载中…'));
    entry.el.appendChild(loading);
    var ret;
    try {
      ret = fn(entry.el, entry.params, entry.page);
    } catch (err) {
      console.error('[router] build 出错：' + entry.name, err);
      entry.el.innerHTML = '';
      entry.el.appendChild(App.UI.errorState({
        title: '页面加载失败', desc: (err && err.message) || String(err),
        actionText: '重试', onAction: function () { entry.built = false; entry.el.innerHTML = ''; buildInto(entry); }
      }));
      return Promise.resolve(entry);
    }
    return Promise.resolve(ret).then(function () {
      if (loading.parentNode) loading.parentNode.removeChild(loading);
      return entry;
    }).catch(function (err) {
      console.error('[router] build 异步出错：' + entry.name, err);
      entry.el.innerHTML = '';
      entry.el.appendChild(App.UI.errorState({
        title: '页面加载失败', desc: (err && err.message) || String(err),
        actionText: '重试', onAction: function () { entry.built = false; entry.el.innerHTML = ''; buildInto(entry); }
      }));
      return entry;
    });
  }

  /* ---------------- 导航栏 ---------------- */
  function current() {
    var entry = stack[stack.length - 1];
    return entry ? { name: entry.name, params: entry.params, page: entry.page, entry: entry } : null;
  }
  R.current = current;

  function renderTitle() {
    var entry = stack[stack.length - 1];
    if (!entry) return;
    var cfg = entry.cfg || {};
    var raw = entry.title !== undefined ? entry.title : (typeof cfg.title === 'function' ? cfg.title(entry.params) : cfg.title);
    var fallback = entry.isTab ? (TABS.filter(function (t) { return t.name === entry.name; })[0] || {}).title : '';
    els.title.textContent = raw || fallback || '';
  }

  function renderBack() {
    var entry = stack[stack.length - 1];
    if (!entry || entry.isTab || stack.length <= 1 || entry.forceHideBack || (entry.params && entry.params.__noBack)) {
      els.back.style.display = 'none';
      return;
    }
    els.back.style.display = '';
    els.back.innerHTML = App.UI.icon('back');
  }

  function renderActions() {
    var entry = stack[stack.length - 1];
    els.actions.innerHTML = '';
    if (!entry) return;
    var list = (entry.actions || []).slice(0, 2);
    list.forEach(function (a) {
      if (!a) return;
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'nav-action' + (a.label && !a.icon ? ' text' : '');
      if (a.label) btn.setAttribute('aria-label', a.label);
      if (a.icon) btn.innerHTML = App.UI.icon(a.icon);
      else btn.textContent = a.label || '';
      btn.addEventListener('click', function (ev) {
        ev.preventDefault();
        try { a.onClick && a.onClick(ev); } catch (err) { console.error('[router] 导航按钮出错', err); }
      });
      els.actions.appendChild(btn);
    });
  }

  function renderTabbar() {
    els.tabbar.innerHTML = '';
    TABS.forEach(function (t) {
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'tab';
      b.setAttribute('data-tab', t.name);
      b.setAttribute('aria-label', t.label);
      var cfg = defs[t.name] || {};
      var label = cfg.tabLabel || t.label;
      var icon = cfg.tabIcon || t.icon;
      b.innerHTML = App.UI.icon(icon) + '<span>' + App.Util.esc(label) + '</span>';
      b.addEventListener('click', function () { R.tab(t.name); });
      els.tabbar.appendChild(b);
    });
  }

  function syncChrome() {
    var entry = stack[stack.length - 1];
    if (!entry) return;
    renderTitle();
    renderBack();
    renderActions();
    var showTab = !!entry.isTab && !entry.fullscreen;
    els.tabbar.classList.toggle('hidden', !showTab);
    Array.prototype.forEach.call(els.tabbar.querySelectorAll('.tab'), function (btn) {
      btn.classList.toggle('active', btn.getAttribute('data-tab') === entry.name);
    });
    document.body.classList.toggle('has-tabbar', showTab);
    document.body.classList.toggle('is-secondary', !entry.isTab);
    if (window.App && App.Bubble && App.Bubble.refresh) { try { App.Bubble.refresh(); } catch (e) {} }
  }

  /* ---------------- 显示/隐藏（含过渡） ---------------- */
  var reduceMotion = window.matchMedia ? window.matchMedia('(prefers-reduced-motion: reduce)').matches : false;

  function showPage(entry, dir) {
    var el = entry.el;
    el.style.display = '';
    // 清理同一页面的其他可见页
    Array.prototype.forEach.call(els.root.children, function (child) {
      if (child !== el) child.style.display = 'none';
    });
    if (!dir || reduceMotion) return;
    var from = dir === 'forward' ? '100%' : (dir === 'back' ? '-22%' : '0');
    el.style.transition = 'none';
    el.style.transform = 'translateX(' + from + ')';
    el.style.opacity = dir === 'back' ? '1' : '1';
    requestAnimationFrame(function () {
      el.style.transition = 'transform .22s cubic-bezier(.2,.8,.2,1)';
      el.style.transform = 'translateX(0)';
      setTimeout(function () { el.style.transition = ''; el.style.transform = ''; }, 260);
    });
  }

  function hidePage(entry, dir) {
    var el = entry.el;
    if (!dir || reduceMotion) { el.style.display = 'none'; return; }
    el.style.transition = 'transform .22s cubic-bezier(.2,.8,.2,1)';
    el.style.transform = 'translateX(' + (dir === 'back' ? '100%' : '-22%') + ')';
    setTimeout(function () {
      el.style.display = 'none';
      el.style.transition = '';
      el.style.transform = '';
    }, 230);
  }

  /* ---------------- 公共 API ---------------- */
  R.TABS = TABS;

  R.register = function (name, cfg) {
    if (!name || !cfg) throw new Error('Router.register 参数不完整');
    defs[name] = cfg || {};
    if (TAB_NAMES.indexOf(name) >= 0 && inited) renderTabbar();
    return R;
  };

  R.has = function (name) { return !!defs[name]; };

  R.tab = function (name) {
    if (TAB_NAMES.indexOf(name) < 0) { console.warn('[router] 不是 Tab 页：' + name); return R; }
    if (busy) return R;
    var cur = current();
    if (cur && cur.name === name && cur.entry.isTab && stack.length === 1) return R;
    // 关闭所有二级页
    while (stack.length > 1) destroyEntry(stack.pop());
    // 清空栈里残留的旧 tab（缓存页保留 DOM，只隐藏，不销毁）
    while (stack.length) {
      var oldEntry = stack.pop();
      if (oldEntry && oldEntry.el) oldEntry.el.style.display = 'none';
    }
    var entry = tabEntries[name];
    if (!entry) {
      var cfg = defs[name] || {};
      entry = makeEntry(name, {}, cfg, true);
      tabEntries[name] = entry;
      els.root.appendChild(entry.el);
      stack.push(entry);
      showPage(entry, cur ? 'fade' : null);
      setBusy();
      buildInto(entry).then(function () {
        syncChrome();
        App.DB.settings.set('last_tab', name).catch(function () {});
        setFree();
      });
      syncChrome();
      if (App.DB && App.DB.settings) App.DB.settings.set('last_tab', name).catch(function () {});
      notify();
      return R;
    }
    stack.push(entry);
    showPage(entry, 'tab');
    syncChrome();
    App.DB.settings.set('last_tab', name).catch(function () {});
    notify();
    return R;
  };

  R.push = function (name, params, opts) {
    opts = opts || {};
    if (!defs[name]) {
      console.warn('[router] 未注册页面：' + name);
      return Promise.reject(new Error('页面未注册：' + name));
    }
    if (busy) return Promise.resolve(false);
    var cfg = defs[name] || {};
    var entry = makeEntry(name, params, cfg, false);
    entry.fullscreen = !!opts.fullscreen;
    if (opts.noBack) entry.params.__noBack = true;
    var old = current();
    if (opts.root) {
      while (stack.length) destroyEntry(stack.pop());
      tabEntries = Object.create(null);
    }
    stack.push(entry);
    els.root.appendChild(entry.el);
    entry.el.style.display = '';
    showPage(entry, 'forward');
    if (old && old.entry.el !== entry.el) {
      old.entry.el.style.display = 'none';
      old.entry.el.style.transition = '';
      old.entry.el.style.transform = '';
    }
    syncChrome();
    setBusy();
    return buildInto(entry).then(function () {
      syncChrome();
      notify();
      setFree();
      return entry.page;
    });
  };

  R.replace = function (name, params, opts) {
    if (stack.length) {
      var top = stack.pop();
      destroyEntry(top);
    }
    var prev = current();
    if (prev) prev.entry.el.style.display = '';
    return R.push(name, params, opts);
  };

  R.pop = function () {
    if (busy) return false;
    if (stack.length <= 1) return false;
    var top = stack.pop();
    hidePage(top, 'back');
    destroyEntry(top);
    var prev = current();
    if (prev) prev.entry.el.style.display = '';
    syncChrome();
    notify();
    return true;
  };

  R.popTo = function (name) {
    while (stack.length > 1 && stack[stack.length - 1].name !== name) {
      var top = stack.pop();
      destroyEntry(top);
    }
    var prev = current();
    if (prev) prev.entry.el.style.display = '';
    syncChrome();
    notify();
    return true;
  };

  R.depth = function () { return stack.length; };

  R.page = function (name) {
    for (var i = stack.length - 1; i >= 0; i--) if (stack[i].name === name) return stack[i].page;
    for (var k in tabEntries) if (k === name) return tabEntries[k].page;
    return null;
  };

  // 注册路由变化监听；返回取消订阅函数（页面销毁时应调用，避免长期运行后回调累积）
  R.onChange = function (fn) {
    if (typeof fn !== 'function') return function () {};
    listeners.push(fn);
    var off = false;
    return function () {
      if (off) return;
      off = true;
      var i = listeners.indexOf(fn);
      if (i >= 0) listeners.splice(i, 1);
    };
  };

  R.goChatList = function () { return R.tab('chatList'); };

  R.refreshChrome = function () { syncChrome(); };

  R.setBackGuard = function (fn) { backGuard = typeof fn === 'function' ? fn : null; };

  R.handleBack = function () {
    // 1) 弹层优先
    if (window.App && App.UI && App.UI.closeTopOverlay) {
      try { if (App.UI.closeTopOverlay()) return true; } catch (e) {}
    }
    // 2) 业务拦截（如未保存确认、气泡展开）
    if (backGuard) {
      try { if (backGuard()) return true; } catch (e) { console.error('[router] backGuard 出错', e); }
    }
    if (window.App && App.Bubble && App.Bubble.collapse && App.Bubble.isOpen && App.Bubble.isOpen()) {
      try { if (App.Bubble.collapse()) return true; } catch (e) {}
    }
    // 3) 栈回退
    if (R.pop()) return true;
    // 4) 已在 Tab 根页：不退出（由原生决定是否最小化/退出）
    return false;
  };
  window.__handleBack = function () { return R.handleBack(); };

  function notify() {
    var cur = current();
    listeners.forEach(function (fn) { try { fn(cur); } catch (e) { console.error('[router] onChange 出错', e); } });
  }
  function setBusy() { busy = true; }
  function setFree() { busy = false; }

  R.init = function () {
    if (inited) return R;
    inited = true;
    els.root = document.getElementById('page-root');
    els.back = document.getElementById('nav-back');
    els.title = document.getElementById('nav-title');
    els.actions = document.getElementById('nav-actions');
    els.tabbar = document.getElementById('tabbar');
    els.back.addEventListener('click', function (e) { e.preventDefault(); R.handleBack(); });
    renderTabbar();
    notify();
    return R;
  };

  R.resetForOnboarding = function () {
    while (stack.length) destroyEntry(stack.pop());
    tabEntries = Object.create(null);
    els.root.innerHTML = '';
    syncChrome();
  };
})();
