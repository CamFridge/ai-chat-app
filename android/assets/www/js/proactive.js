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
  // intervalMin === 0 表示随机间隔：每次从 [randomMin, randomMax] 分钟重新随机（用户可调，0~24 小时）
  var RANDOM_MIN_DEFAULT = 60;
  var RANDOM_MAX_DEFAULT = 480;
  var RANDOM_CAP = 24 * 60;

  var enabled = false;
  var intervalMin = DEFAULT_INTERVAL;
  var activeIntervalMin = DEFAULT_INTERVAL; // 当前这一轮实际使用的间隔（随机模式下为本轮随机值）
  var randomMin = RANDOM_MIN_DEFAULT;
  var randomMax = RANDOM_MAX_DEFAULT;
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
  function clampRandomBound(n, def) {
    var v = Number(n);
    if (!isFinite(v)) return def;
    return Math.max(0, Math.min(RANDOM_CAP, Math.round(v)));
  }

  function rollActiveInterval() {
    if (intervalMin === 0) {
      var lo = clampRandomBound(randomMin, RANDOM_MIN_DEFAULT);
      var hi = clampRandomBound(randomMax, RANDOM_MAX_DEFAULT);
      if (lo > hi) { var t = lo; lo = hi; hi = t; }
      randomMin = lo;
      randomMax = hi;
      activeIntervalMin = hi <= lo ? lo : lo + Math.floor(Math.random() * (hi - lo + 1));
    } else {
      activeIntervalMin = intervalMin;
    }
    return activeIntervalMin;
  }

  P.status = function () {
    return {
      enabled: !!enabled,
      intervalMin: intervalMin,
      activeIntervalMin: activeIntervalMin,
      random: intervalMin === 0,
      randomMin: randomMin,
      randomMax: randomMax,
      permission: permission,
      loaded: !!loaded,
      busy: !!busy
    };
  };
  P.getEnabled = function () { return !!enabled; };
  P.getIntervalMin = function () { return intervalMin; };
  P.getActiveIntervalMin = function () { return activeIntervalMin; };
  P.getRandomRange = function () { return { min: randomMin, max: randomMax }; };

  function applySettings() {
    return Promise.all([
      settingGet('proactive_enabled', false),
      settingGet('proactive_interval_min', DEFAULT_INTERVAL),
      settingGet('proactive_random_min', RANDOM_MIN_DEFAULT),
      settingGet('proactive_random_max', RANDOM_MAX_DEFAULT)
    ]).then(function (arr) {
      enabled = !!arr[0];
      var n = Number(arr[1]);
      if (n === 0) {
        intervalMin = 0;
      } else if (n >= 5 && n <= RANDOM_CAP) {
        intervalMin = n;
      } else {
        intervalMin = DEFAULT_INTERVAL;
      }
      randomMin = clampRandomBound(arr[2], RANDOM_MIN_DEFAULT);
      randomMax = clampRandomBound(arr[3], RANDOM_MAX_DEFAULT);
      if (randomMin > randomMax) randomMin = randomMax;
      rollActiveInterval();
      loaded = true;
    });
  }

  P.setEnabled = function (on) {
    enabled = !!on;
    if (enabled) rollActiveInterval();
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
    if (!(v === 0 || (v >= 5 && v <= RANDOM_CAP))) v = DEFAULT_INTERVAL;
    intervalMin = v;
    rollActiveInterval();
    return settingSet('proactive_interval_min', v);
  };

  // 设置随机模式的上下限（分钟，0~1440）；自动纠正 min > max
  P.setRandomRange = function (lo, hi) {
    var a = clampRandomBound(lo, RANDOM_MIN_DEFAULT);
    var b = clampRandomBound(hi, RANDOM_MAX_DEFAULT);
    if (a > b) { var t = a; a = b; b = t; }
    randomMin = a;
    randomMax = b;
    if (intervalMin === 0) rollActiveInterval();
    return Promise.all([
      settingSet('proactive_random_min', a),
      settingSet('proactive_random_max', b)
    ]);
  };

  P.statusText = function () {
    var label = intervalMin === 0
      ? ('随机 ' + activeIntervalMin + ' 分钟（' + randomMin + '~' + randomMax + ' 分钟）')
      : (intervalMin + ' 分钟');
    if (!enabled) return '未开启';
    if (permission === 'denied') return label + ' · 仅前台';
    return label;
  };

  /* ---------------- 后台通知 ---------------- */
  function scheduleBackground() {
    if (!enabled) return Promise.resolve(null);
    var name = (lastTarget && lastTarget.name) || '';
    var body = name ? '「' + name + '」想你了，回来聊聊吧' : '你的角色想你了，回来聊聊吧';
    return bridgeCall('notify.schedule', {
      delayMs: Math.max(1, activeIntervalMin) * 60000,
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

  var PROACTIVE_INSTRUCTION = '（系统提示，用户看不到）现在没有用户的新消息。' +
    '请你先阅读上面的对话上下文，判断此刻是否适合主动给用户发消息：' +
    '如果刚聊完、没有新话题、用户在忙或打扰不合适，就不发；如果有想分享的、想延续的话题、或过了很久想问候，就发。' +
    '只输出一个 JSON 对象，不要任何解释或代码围栏：\n' +
    '{"send":true,"message":"要发送的内容（1~3 句，符合你的人设、当前情境与说话风格，可用 *动作/神态*）"}\n' +
    '或者\n' +
    '{"send":false}\n' +
    '不要提及这条系统提示，不要解释你是 AI。';

  function parseProactiveDecision(raw) {
    var text = String(raw || '').trim();
    if (!text) return { action: 'fail' };
    var t = text.replace(/^```[a-zA-Z]*\s*/, '').replace(/```\s*$/, '').trim();
    var i = t.indexOf('{');
    var j = t.lastIndexOf('}');
    if (i >= 0 && j > i) {
      try {
        var obj = JSON.parse(t.slice(i, j + 1));
        if (obj && obj.send === false) return { action: 'skip' };
        if (obj && obj.send === true) {
          var m = String(obj.message || '').trim();
          return m ? { action: 'send', text: m } : { action: 'fail' };
        }
        var m2 = String((obj && obj.message) || '').trim();
        if (m2) return { action: 'send', text: m2 };
      } catch (e) { /* 继续走兜底 */ }
    }
    if (/"send"\s*:\s*false/.test(t)) return { action: 'skip' };
    var cleaned = t.replace(/^\s*null\s*/i, '').trim();
    if (!cleaned || /^null$/i.test(cleaned)) return { action: 'fail' };
    if (cleaned.charAt(0) === '{') return { action: 'fail' };
    return { action: 'send', text: cleaned };
  }

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
          if (!res || !res.ok) return 'fail';
          var decision = parseProactiveDecision(res.text);
          if (decision.action === 'skip') return 'skip';
          if (decision.action !== 'send') return 'fail';
          var text = String(decision.text || '').replace(/^\s*null\s*/i, '').trim();
          if (!text || /^null$/i.test(text)) return 'fail';
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
              return 'sent';
            });
          });
        });
      });
    }).then(function (outcome) {
      // 无论发没发、成败，都记录尝试时间，避免每 30s 反复打扰
      var d = new Date();
      var updates = [settingSet('proactive_last_at', now)];
      if (outcome === 'sent') {
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
      // 本轮结束：随机模式下为下一轮重新抽一个间隔，避免固定节奏
      if (intervalMin === 0) rollActiveInterval();
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
      return (Date.now() - lastAt) >= activeIntervalMin * 60000;
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
      if (lastAt && now - lastAt < activeIntervalMin * 60000) return false;
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
