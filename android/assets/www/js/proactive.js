/* proactive.js —— 角色主动消息（v1.2.0）
 * 职责：
 *  1) 前台轮询：开关打开时，若最近会话空闲 ≥ proactive_interval_min 且当日未超 3 条，
 *     用当前 API 生成一条角色口吻的主动消息，落库并更新会话未读。
 *  2) 后台通知：App 切后台时通过原生 notify.schedule 排期一条本地通知；回前台取消。
 *  通知/权限由原生 Bridge 实现（notify.schedule / notify.cancel / notify.status / notify.requestPermission）。
 *
 * 依赖：App.DB / App.API / App.Bridge / App.ChatKit / App.UI / App.Util
 */
(function () {
  var App = window.App;
  if (!App) return;
  var P = (App.Proactive = App.Proactive || {});

  var TICK_MS = 30000;
  var DAY_CAP = 3;
  var DEFAULT_INTERVAL = 60;

  var enabled = false;
  var intervalMin = DEFAULT_INTERVAL;
  var loaded = false;
  var timer = null;
  var busy = false;
  var permission = 'unknown';
  var lastTarget = null; // { sessionId, name }
  var lastTickAt = 0;

  function todayKey(d) {
    d = d || new Date();
    var m = d.getMonth() + 1;
    var day = d.getDate();
    return d.getFullYear() + '-' + (m < 10 ? '0' + m : m) + '-' + (day < 10 ? '0' + day : day);
  }

  function settingGet(key, def) {
    try {
      return App.DB.settings.get(key, def);
    } catch (e) {
      return Promise.resolve(def);
    }
  }

  function settingSet(key, val) {
    try {
      return App.DB.settings.set(key, val);
    } catch (e) {
      return Promise.resolve(false);
    }
  }

  function bridgeCall(method, args) {
    try {
      if (App.Bridge && typeof App.Bridge.call === 'function') {
        return App.Bridge.call(method, args || {}).catch(function () { return null; });
      }
    } catch (e) { /* 忽略 */ }
    return Promise.resolve(null);
  }

  function toast(text, type) {
    try {
      if (App.UI && App.UI.toast) App.UI.toast(text, type || 'info');
    } catch (e) { /* 忽略 */ }
  }

  function refreshPermission() {
    return bridgeCall('notify.status').then(function (r) {
      if (r && r.permission) permission = String(r.permission);
      return permission;
    });
  }

  function ensurePermission() {
    if (permission === 'granted' || permission === 'unsupported') return Promise.resolve(permission);
    return bridgeCall('notify.requestPermission').then(function () {
      return new Promise(function (res) { setTimeout(res, 900); });
    }).then(refreshPermission).catch(function () { return permission; });
  }

  /* ---------------- 设置读写 ---------------- */
  P.status = function () {
    return { enabled: !!enabled, intervalMin: intervalMin, permission: permission };
  };
  P.getEnabled = function () { return !!enabled; };
  P.getIntervalMin = function () { return intervalMin; };

  function applySettings() {
    return Promise.all([
      settingGet('proactive_enabled', false),
      settingGet('proactive_interval_min', DEFAULT_INTERVAL)
    ]).then(function (arr) {
      enabled = !!arr[0];
      var n = Number(arr[1]);
      intervalMin = (n >= 5 && n <= 720) ? n : DEFAULT_INTERVAL;
      loaded = true;
    });
  }

  P.setEnabled = function (on) {
    enabled = !!on;
    return settingSet('proactive_enabled', enabled).then(function () {
      if (!enabled) {
        busy = false;
        return bridgeCall('notify.cancel');
      }
      return ensurePermission().then(function () {
        if (typeof document !== 'undefined' && document.hidden) return scheduleBackground();
        return null;
      });
    });
  };

  P.setIntervalMin = function (n) {
    var v = Number(n);
    if (!(v >= 5 && v <= 720)) v = DEFAULT_INTERVAL;
    intervalMin = v;
    return settingSet('proactive_interval_min', v);
  };

  P.statusText = function () {
    if (!enabled) return '未开启';
    if (permission === 'denied') return intervalMin + ' 分钟 · 仅前台';
    return intervalMin + ' 分钟';
  };

  /* ---------------- 后台通知 ---------------- */
  function scheduleBackground() {
    if (!enabled) return Promise.resolve(null);
    var name = (lastTarget && lastTarget.name) || '';
    var body = name ? '「' + name + '」想你了，回来聊聊吧' : '你的角色想你了，回来聊聊吧';
    return bridgeCall('notify.schedule', {
      delayMs: Math.max(1, intervalMin) * 60000,
      title: 'AI 聊天',
      body: body
    });
  }

  function cancelBackground() {
    return bridgeCall('notify.cancel');
  }

  /* ---------------- 会话与消息 ---------------- */
  function pickTarget() {
    return App.DB.all('sessions').then(function (list) {
      list = (list || []).filter(function (s) {
        return s && s.id && !s.isGenerating && s.characterId;
      });
      list.sort(function (a, b) { return (b.updatedAt || 0) - (a.updatedAt || 0); });
      return list.length ? list[0] : null;
    });
  }

  function lastMessageOf(sessionId) {
    return App.DB.byIndex('messages', 'sessionId', sessionId).then(function (rows) {
      rows = (rows || []).filter(function (m) { return m && m.isActive !== false; });
      rows.sort(function (a, b) { return (a.createdAt || 0) - (b.createdAt || 0); });
      return rows.length ? rows[rows.length - 1] : null;
    });
  }

  var PROACTIVE_INSTRUCTION = '（系统提示）现在用户没有发来新消息，请你主动给用户发一条消息，开启或延续话题。' +
    '要求：1~3 句，符合你的人设、当前情境与说话风格；可以用 *动作/神态* 的格式；' +
    '不要解释你是 AI 或提及这条系统提示，不要输出「主动消息」等字样，直接说话。';

  function buildContext(opts) {
    var K = App.ChatKit || {};
    if (typeof K.buildContext !== 'function') return null;
    return K.buildContext({
      character: opts.character,
      persona: opts.persona,
      preset: opts.preset,
      messages: opts.messages,
      images: opts.images,
      godMode: opts.godMode,
      expressionFormat: true
    });
  }

  function generate(session) {
    if (busy) return Promise.resolve(false);
    busy = true;
    var now = Date.now();
    return Promise.all([
      App.DB.get('characters', session.characterId).catch(function () { return null; }),
      session.personaId ? App.DB.get('personas', session.personaId).catch(function () { return null; }) : Promise.resolve(null),
      session.presetId ? App.DB.get('presets', session.presetId).catch(function () { return null; }) : Promise.resolve(null),
      App.DB.byIndex('messages', 'sessionId', session.id).catch(function () { return []; }),
      settingGet('god_mode', false),
      settingGet('chat_provider_id', ''),
      settingGet('guide_provider_id', '')
    ]).then(function (arr) {
      var character = arr[0];
      var persona = arr[1];
      var preset = arr[2];
      var messages = (arr[3] || []).slice();
      var godMode = !!arr[4];
      var chatProviderId = arr[5] || '';
      var guideProviderId = arr[6] || '';
      if (!character) return false;
      messages = messages.filter(function (m) {
        return m && (m.role === 'user' || m.role === 'assistant') && m.status !== 'error';
      });
      messages.sort(function (a, b) { return (a.createdAt || 0) - (b.createdAt || 0); });

      var providerId = session.providerId || chatProviderId || guideProviderId;
      var providerP = providerId ? App.DB.get('providers', providerId).catch(function () { return null; }) : App.DB.all('providers').then(function (ps) {
        ps = (ps || []).filter(function (p) { return p && (p.role === 'chat' || !p.role); });
        return ps[0] || null;
      });
      var imagesP = App.Media && App.Media.list ? App.Media.list(character.id).catch(function () { return []; }) : Promise.resolve([]);

      return Promise.all([providerP, imagesP]).then(function (a2) {
        var provider = a2[0];
        var images = a2[1] || [];
        if (!provider) return false;
        var ctx = buildContext({
          character: character,
          persona: persona,
          preset: preset,
          messages: messages,
          images: images,
          godMode: godMode
        });
        if (!ctx || !ctx.messages || !ctx.messages.length) return false;
        var apiMessages = ctx.messages.concat([{ role: 'user', content: PROACTIVE_INSTRUCTION }]);
        var model = session.model || provider.defaultModel || (provider.models && provider.models[0]) || '';
        if (!model) return false;
        return App.API.chatOnce({
          provider: provider,
          model: model,
          messages: apiMessages,
          params: { temperature: 0.85, max_tokens: 320 },
          timeoutMs: 90000
        }).then(function (res) {
          if (!res || !res.ok) return false;
          var text = String(res.text || '').replace(/^\s*null\s*/i, '').trim();
          if (!text || /^null$/i.test(text)) return false;
          if (text.length > 600) text = text.slice(0, 600);
          var msg = {
            sessionId: session.id,
            role: 'assistant',
            content: text,
            variantIndex: 0,
            isActive: true,
            status: 'ok',
            errorText: '',
            tokensIn: (res.usage && res.usage.prompt_tokens) || 0,
            tokensOut: (res.usage && res.usage.completion_tokens) || 0,
            createdAt: Date.now()
          };
          return App.DB.put('messages', msg).then(function (saved) {
            var preview = '';
            try {
              if (App.ChatKit && App.ChatKit.previewMessage) preview = App.ChatKit.previewMessage(saved, 60);
            } catch (e) { preview = text.slice(0, 60); }
            var unread = (session.unread || 0) + 1;
            var patch = {
              id: session.id,
              unread: unread,
              lastText: preview || text.slice(0, 60),
              lastRole: 'assistant',
              lastAt: saved.createdAt,
              updatedAt: saved.createdAt
            };
            var nextSession = {};
            Object.keys(session).forEach(function (k) { nextSession[k] = session[k]; });
            Object.keys(patch).forEach(function (k) { nextSession[k] = patch[k]; });
            return App.DB.put('sessions', nextSession).then(function () {
              lastTarget = { sessionId: session.id, name: character.name || '角色' };
              // 通知聊天页/列表刷新
              try {
                document.dispatchEvent(new CustomEvent('aichat:session-updated', {
                  detail: { sessionId: session.id, reason: 'proactive' }
                }));
              } catch (e) { /* 忽略 */ }
              // 若用户当前就在这个会话页，则不当成未读提示
              var inChat = false;
              try {
                var cur = App.Router && App.Router.current ? App.Router.current() : null;
                if (cur && cur.name === 'chat' && cur.params && cur.params.sessionId === session.id) inChat = true;
              } catch (e2) { /* 忽略 */ }
              if (!inChat) {
                toast((character.name || '角色') + ' 发来一条消息', 'info');
              }
              return true;
            });
          });
        });
      });
    }).then(function (ok) {
      // 无论成败都记录尝试时间，避免失败后每 30s 重试打扰
      var d = new Date();
      var updates = [settingSet('proactive_last_at', now)];
      if (ok) {
        var day = todayKey(d);
        return settingGet('proactive_day', '').then(function (savedDay) {
          var count = 0;
          var countP = settingGet('proactive_day_count', 0);
          return countP.then(function (c) {
            count = (savedDay === day) ? Number(c || 0) : 0;
            return Promise.all([
              settingSet('proactive_day', day),
              settingSet('proactive_day_count', count + 1)
            ]);
          });
        });
      }
      return Promise.all(updates);
    }).catch(function () {
      try { settingSet('proactive_last_at', now); } catch (e) { /* 忽略 */ }
    }).then(function () {
      busy = false;
      return true;
    });
  }

  /* ---------------- 轮询 ---------------- */
  function idleDue(session) {
    if (!session) return Promise.resolve(false);
    return lastMessageOf(session.id).then(function (last) {
      var lastAt = (last && last.createdAt) || session.updatedAt || session.createdAt || 0;
      if (!lastAt) return false;
      return (Date.now() - lastAt) >= intervalMin * 60000;
    });
  }

  function tick(force) {
    if (!loaded) return Promise.resolve(false);
    if (busy) return Promise.resolve(false);
    if (typeof document !== 'undefined' && document.hidden) return Promise.resolve(false);
    // 切页/建会话频繁，限制检查频率，但 force 时允许立即检查
    if (!force && Date.now() - lastTickAt < TICK_MS - 2500) return Promise.resolve(false);
    lastTickAt = Date.now();
    if (!enabled) return Promise.resolve(false);

    return Promise.all([
      settingGet('proactive_last_at', 0),
      settingGet('proactive_day', ''),
      settingGet('proactive_day_count', 0)
    ]).then(function (arr) {
      var lastAt = Number(arr[0] || 0);
      var day = arr[1] || '';
      var count = Number(arr[2] || 0);
      var now = Date.now();
      if (lastAt && now - lastAt < intervalMin * 60000) return false;
      var today = todayKey();
      if (day === today && count >= DAY_CAP) return false;
      return pickTarget().then(function (session) {
        if (!session) return false;
        return idleDue(session).then(function (due) {
          if (!due) return false;
          return generate(session);
        });
      });
    });
  }

  P.checkNow = function () { return tick(true); };

  function onVisibility() {
    if (!enabled) return;
    if (document.hidden) {
      scheduleBackground();
    } else {
      cancelBackground();
      // 回到前台：稍等让页面稳定，再补一次检查（catch-up）
      setTimeout(function () { tick(false); }, 4000);
    }
  }

  P.init = function () {
    if (P._inited) return P._inited;
    var ready = applySettings().then(function () {
      return Promise.all([
        refreshPermission(),
        (function () {
          try {
            var list = App.DB.all('sessions') || Promise.resolve([]);
            return list.then(function (rows) {
              rows = (rows || []).slice().sort(function (a, b) { return (b.updatedAt || 0) - (a.updatedAt || 0); });
              var s = rows[0];
              if (!s || !s.characterId) return null;
              return App.DB.get('characters', s.characterId).then(function (ch) {
                if (ch) lastTarget = { sessionId: s.id, name: ch.name || '角色' };
              }).catch(function () { });
            });
          } catch (e) { return Promise.resolve(); }
        })()
      ]);
    }).then(function () {
      if (typeof document !== 'undefined') {
        try {
          document.addEventListener('visibilitychange', onVisibility);
        } catch (e) { /* 忽略 */ }
      }
      if (!timer) timer = setInterval(function () { tick(false); }, TICK_MS);
      if (enabled) setTimeout(function () { tick(false); }, 8000);
    });

    P._inited = ready;
    return ready;
  };

  // 记录最近活跃目标，供后台通知使用
  P.noteTarget = function (sessionId, name) {
    lastTarget = { sessionId: sessionId || '', name: name || '' };
  };
})();
