/* main.js —— 启动引导：主题、DB、种子数据、强制引导检查、气泡挂载、错误兜底 */
(function () {
  'use strict';
  var App = window.App = window.App || {};

  var bootEl = null;

  function bootTip(text) {
    bootEl = bootEl || document.getElementById('boot');
    if (!bootEl) return;
    var tip = bootEl.querySelector('.boot-tip');
    if (tip) tip.textContent = text;
  }
  function hideBoot() {
    bootEl = bootEl || document.getElementById('boot');
    if (!bootEl) return;
    bootEl.classList.add('done');
    setTimeout(function () { if (bootEl && bootEl.parentNode) bootEl.parentNode.removeChild(bootEl); }, 260);
  }

  /* ---------------- 内置数据种子（仅当表为空） ---------------- */
  function seedWorldviews() {
    return App.DB.count('worldviews').then(function (n) {
      if (n > 0) return;
      var presets = (App.Data && App.Data.WORLDVIEW_PRESETS) || [];
      if (!presets.length) return;
      var now = Date.now();
      var rows = presets.map(function (p) {
        return {
          id: p.id || App.Util.uid('wv'),
          name: p.name || '未命名世界观',
          summary: p.summary || '',
          details: p.details || {},
          isBuiltin: true,
          source: 'preset',
          rawInput: '',
          draft: null,
          createdAt: now,
          updatedAt: now
        };
      });
      return App.DB.bulkPut('worldviews', rows);
    });
  }

  function seedPresets() {
    return App.DB.count('presets').then(function (n) {
      if (n > 0) return;
      var presets = (App.Data && App.Data.BUILTIN_PRESETS) || [];
      if (!presets.length) return;
      var rows = presets.map(function (p) {
        return {
          id: p.id || App.Util.uid('ps'),
          name: p.name || '默认预设',
          params: p.params || {},
          instructTemplate: p.instructTemplate || '',
          mode: p.mode || 'chat',
          appliesTo: p.appliesTo || 'both',
          isBuiltin: true
        };
      });
      return App.DB.bulkPut('presets', rows);
    });
  }

  function seedBuiltins() {
    return Promise.all([seedWorldviews(), seedPresets()]).catch(function (e) {
      console.warn('[main] 内置数据写入失败', e);
    });
  }

  /* ---------------- 引导状态 ---------------- */
  function guideProvider() {
    return App.DB.query('providers', { where: { role: 'guide' } }).then(function (rows) { return rows[0] || null; });
  }

  App.needsOnboarding = function () {
    return Promise.all([App.DB.settings.get('onboarding_completed', false), guideProvider()]).then(function (arr) {
      var done = !!arr[0];
      var guide = arr[1];
      return !done || !guide;
    });
  };

  /* ---------------- 主界面启动 ---------------- */
  App.bootMain = function (tabName) {
    var target = tabName || 'chatList';
    if (App.Bubble && App.Bubble.refresh) { try { App.Bubble.refresh(); } catch (e) {} }
    if (App.Router.has(target)) App.Router.tab(target);
    else App.Router.tab('chatList');
  };

  /* ---------------- 主题同步状态栏 ---------------- */
  function syncStatusBar() {
    var t = App.UI.theme();
    if (App.Bridge && App.Bridge.available) {
      App.Bridge.call('ui.statusBar', {
        dark: t !== 'light',
        color: t === 'light' ? '#ededed' : t === 'amoled' ? '#000000' : '#1c1c1e'
      }).catch(function () {});
    }
  }

  /* ---------------- 启动流程 ---------------- */
  /* v1.4.3：真实测量 flex 容器是否支持 gap。
     CSS.supports('gap','1px') 在 Chrome 84 以前也会返回 true（因为 grid 支持 gap），
     不能用来判断 flex 间距是否生效；这里用两个 1px 子元素实测间距。 */
  function probeFlexGap() {
    try {
      var box = document.createElement('div');
      box.style.cssText = 'position:absolute;left:-9999px;top:0;width:1px;display:flex;' +
        'flex-direction:column;row-gap:7px;';
      var a = document.createElement('div');
      var b = document.createElement('div');
      a.style.cssText = 'height:1px;width:1px;flex:0 0 auto;';
      b.style.cssText = 'height:1px;width:1px;flex:0 0 auto;';
      box.appendChild(a);
      box.appendChild(b);
      (document.body || document.documentElement).appendChild(box);
      var ok = (b.offsetTop - a.offsetTop) >= 7;
      if (box.parentNode) box.parentNode.removeChild(box);
      if (!ok) {
        var root = document.documentElement;
        root.className = (root.className ? root.className + ' ' : '') + 'no-flex-gap';
      }
    } catch (e) { /* 忽略 */ }
  }

  function start() {
    probeFlexGap();
    App.Router.init();
    syncStatusBar();
    try { initViewportSync(); } catch (e) { /* 忽略 */ }

    var ready = App.UI.applyStoredTheme()
      .catch(function () { return App.UI.theme(); })
      .then(function () { return App.DB.ready(); })
      .then(function () { return (App.Style && App.Style.init ? App.Style.init() : null); })
      .then(function () { return seedBuiltins(); });

    ready.then(function () {
      return App.needsOnboarding();
    }).then(function (need) {
      if (need) {
        bootTip('首次使用，先配置 API…');
        // 强制引导：清空页面栈，禁止返回；引导页由 feat-config 注册
        if (App.Router.has('onboarding')) {
          App.Router.push('onboarding', { firstRun: true }, { root: true, noBack: true, fullscreen: true }).catch(function (e) {
            console.error('[main] 引导页启动失败', e);
            renderFatal(e);
          });
        } else {
          renderFatal(new Error('引导页未加载（js/pages/onboarding.js 缺失）'));
        }
        App.Router.onChange(function (cur) {
          if (!cur) return;
          if (cur.name !== 'onboarding' && need) {
            // 未完成引导时禁止进入其它页面
            bootTip('请先完成 API 引导');
          }
        });
      } else {
        return App.DB.settings.get('last_tab', 'chatList').then(function (tab) {
          App.bootMain(tab);
        });
      }
    }).then(function () {
      hideBoot();
      mountExtras();
    }).catch(function (e) {
      console.error('[main] 启动失败', e);
      renderFatal(e);
    });
  }

  function mountExtras() {
    // 悬浮引导气泡（D 提供；内部自行判断 bubble_enabled / 首次提示）
    if (App.Bubble && typeof App.Bubble.mount === 'function') {
      try { App.Bubble.mount(); } catch (e) { console.error('[main] 气泡挂载失败', e); }
    }
    // 引导助手（D 可能延迟初始化）
    if (App.Help && typeof App.Help.init === 'function') {
      try { App.Help.init(); } catch (e) { console.error('[main] 帮助初始化失败', e); }
    }
    // 遥测/版本信息
    if (App.Bridge && App.Bridge.available) {
      App.Bridge.call('app.info', {}).then(function (info) {
        App.info = info || {};
      }).catch(function () {});
    }
    // 角色主动消息（v1.2.0）：读取开关、前台轮询、后台通知排期
    if (App.Proactive && typeof App.Proactive.init === 'function') {
      try {
        App.Proactive.init().catch(function (e) { console.error('[main] 主动消息初始化失败', e); });
      } catch (e) { console.error('[main] 主动消息初始化失败', e); }
    }
  }

  /* ---------------- 键盘/视口自适应（v1.4.2） ----------------
     个别 Android WebView 在 adjustResize 下不会缩短 layout viewport，键盘只是盖在页面上，
     导致底部输入框与消息气泡互相压住（时有时无）。用 visualViewport 算出键盘高度写进
     --kb-inset，让 .shell 相应收缩，避免「聊天框重叠」。 */
  function initViewportSync() {
    var root = document.documentElement;
    var vv = window.visualViewport;
    var lastKb = -1;
    function apply() {
      var kb = 0;
      try {
        if (vv) kb = Math.max(0, Math.round(window.innerHeight - (vv.height + vv.offsetTop)));
      } catch (e) { kb = 0; }
      if (!(kb >= 0)) kb = 0;
      if (kb === lastKb) return;
      lastKb = kb;
      try { root.style.setProperty('--kb-inset', kb + 'px'); } catch (e) { /* 忽略 */ }
      if (kb > 0) {
        try { window.dispatchEvent(new Event('kb-open')); } catch (e) { /* 忽略 */ }
      }
    }
    window.addEventListener('resize', apply);
    window.addEventListener('orientationchange', apply);
    if (vv) {
      vv.addEventListener('resize', apply);
      vv.addEventListener('scroll', apply);
    }
    apply();
  }

  function renderFatal(err) {
    hideBoot();
    var root = document.getElementById('page-root');
    if (!root) return;
    root.innerHTML = '';
    var box = App.UI.errorState({
      title: '应用启动失败',
      desc: (err && err.message) || String(err),
      actionText: '重试',
      onAction: function () { location.reload(); }
    });
    root.appendChild(box);
  }

  /* ---------------- 全局兜底 ---------------- */
  window.addEventListener('error', function (ev) {
    if (!ev || !ev.message) return;
    console.error('[global] 未捕获错误', ev.message, ev.filename, ev.lineno);
  });
  window.addEventListener('unhandledrejection', function (ev) {
    var r = ev && ev.reason;
    console.error('[global] 未处理的 Promise 拒绝', r && (r.message || r.code) ? (r.message || r.code) : r);
  });

  // 供页面调用：重新检查引导状态（例如删除引导 API 后）
  App.recheckOnboarding = function () {
    return App.needsOnboarding().then(function (need) {
      if (need) {
        App.Router.resetForOnboarding();
        App.Router.push('onboarding', { firstRun: true }, { root: true, noBack: true, fullscreen: true });
      }
      return need;
    });
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start);
  } else {
    start();
  }
})();
