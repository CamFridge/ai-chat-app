/* ============================================================
 * lorebook.js —— 世界书（Lorebook）数据层与注入构建
 *
 * 职责：
 *   1. 角色世界书的读取 / 创建：listForCharacter / ensureForCharacter
 *   2. 聊天前按关键词触发 + token 预算截断：buildInjection
 *   3. 根据角色卡 / 世界观用 AI 生成条目：generateEntries
 *
 * 只通过 App.DB 读写 lorebooks / loreEntries 两张表（字段见 PLAN-v1.4.0 §1）。
 * 挂到 window.App.Lorebook。
 * 铁律：buildInjection 无论内部出什么错，都 resolve ''，绝不阻断聊天。
 * ============================================================ */
(function () {
  'use strict';

  var App = window.App = window.App || {};
  var L = App.Lorebook = {};

  var BOOK_TABLE = 'lorebooks';
  var ENTRY_TABLE = 'loreEntries';
  var DEFAULT_BUDGET = 400;   // 单本世界书默认 token 预算
  var MAX_CONTENT = 800;      // 单条正文上限（字数，与编辑页计数一致）
  var GEN_MIN = 3;            // AI 生成条目数下限
  var GEN_MAX = 6;            // AI 生成条目数上限
  var GEN_TIMEOUT_MS = 120000;

  L.DEFAULT_TOKEN_BUDGET = DEFAULT_BUDGET;
  L.MAX_CONTENT = MAX_CONTENT;

  /* ---------------- 小工具（防御式取 App.Util / App.DB） ---------------- */

  function U() { return App.Util || {}; }
  function DB() { return App.DB || null; }

  function warn() {
    try {
      if (window.console && console.warn) console.warn.apply(console, arguments);
    } catch (e) { /* 忽略 */ }
  }

  function str(v) {
    return v === null || v === undefined ? '' : String(v);
  }

  function trim(v) {
    return str(v).replace(/^[\s\u3000]+|[\s\u3000]+$/g, '');
  }

  function nowMs() {
    var u = U();
    if (u && typeof u.now === 'function') {
      try {
        var t = u.now();
        if (typeof t === 'number' && isFinite(t)) return t;
      } catch (e) { /* 忽略 */ }
    }
    return Date.now();
  }

  function uid(prefix) {
    var u = U();
    if (u && typeof u.uid === 'function') {
      try {
        var id = u.uid(prefix);
        if (id) return String(id);
      } catch (e) { /* 忽略 */ }
    }
    return String(prefix || 'id') + '_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  }

  // 估算 token：优先 App.Util.estimateTokens，缺失时本地粗估（CJK≈1 token/字，ASCII≈1/3.6）
  function estimate(text) {
    var u = U();
    if (u && typeof u.estimateTokens === 'function') {
      try {
        var n = u.estimateTokens(text);
        if (typeof n === 'number' && isFinite(n)) return Math.max(0, Math.round(n));
      } catch (e) { /* 忽略 */ }
    }
    var s = str(text);
    if (!s) return 0;
    var cjk = (s.match(/[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uff00-\uffef]/g) || []).length;
    var rest = s.length - cjk;
    return Math.max(1, Math.ceil(cjk * 1.05 + rest / 3.6));
  }

  function clampText(text, max) {
    var s = str(text);
    if (max > 0 && s.length > max) return s.slice(0, max);
    return s;
  }

  // 数组 / 逗号分隔字符串 → 干净的字符串数组
  function toKeyList(v) {
    var raw = [];
    if (Array.isArray(v)) raw = v;
    else if (typeof v === 'string') raw = v.split(/[,，、;；|]/);
    else if (v !== null && v !== undefined) raw = [v];
    var out = [];
    for (var i = 0; i < raw.length; i++) {
      var k = trim(raw[i]);
      if (!k) continue;
      if (out.indexOf(k) < 0) out.push(k);
    }
    return out;
  }

  function num(v, dft) {
    var n = Number(v);
    if (!isFinite(n)) return dft;
    return n;
  }

  function safeErrMsg(e) {
    if (!e) return '未知错误';
    if (typeof e === 'string') return e;
    if (e.message) return String(e.message);
    return '未知错误';
  }

  function errCode(e) {
    if (!e) return 'unknown';
    if (typeof e.code === 'string' && e.code) return e.code;
    if (e.error && typeof e.error.code === 'string' && e.error.code) return e.error.code;
    return 'unknown';
  }

  /* ---------------- 表读取（索引不可用时退回全表过滤） ---------------- */

  function byIndex(table, index, value) {
    var db = DB();
    if (!db) return Promise.resolve([]);
    return Promise.resolve()
      .then(function () { return db.byIndex(table, index, value); })
      .then(function (list) {
        return Array.isArray(list) ? list : [];
      })
      .catch(function () {
        // 索引不存在 / 版本未升级：退回全表扫描
        return Promise.resolve()
          .then(function () { return db.all(table); })
          .then(function (all) {
            return (Array.isArray(all) ? all : []).filter(function (rec) {
              return rec && rec[index] === value;
            });
          })
          .catch(function () { return []; });
      });
  }

  function readAll(table) {
    var db = DB();
    if (!db) return Promise.resolve([]);
    return Promise.resolve()
      .then(function () { return db.all(table); })
      .then(function (list) { return Array.isArray(list) ? list : []; })
      .catch(function (err) {
        warn('[lorebook] 读取 ' + table + ' 失败', err);
        return [];
      });
  }

  function readOne(table, id) {
    var db = DB();
    if (!db || !id) return Promise.resolve(null);
    return Promise.resolve()
      .then(function () { return db.get(table, id); })
      .then(function (rec) { return rec || null; })
      .catch(function () { return null; });
  }

  // 记录补默认值，页面侧拿到的 book 字段永远齐全
  function normalizeBook(raw) {
    var rec = raw || {};
    return {
      id: str(rec.id),
      name: trim(rec.name) || '未命名世界书',
      characterId: str(rec.characterId),
      worldviewId: str(rec.worldviewId),
      enabled: rec.enabled !== false,
      tokenBudget: num(rec.tokenBudget, DEFAULT_BUDGET) > 0 ? Math.floor(num(rec.tokenBudget, DEFAULT_BUDGET)) : DEFAULT_BUDGET,
      createdAt: num(rec.createdAt, 0),
      updatedAt: num(rec.updatedAt, 0)
    };
  }

  // 单条条目补默认值（保留未知字段，方便以后扩展）
  function normalizeEntry(raw, lorebookId) {
    var rec = raw || {};
    var out = {};
    for (var k in rec) {
      if (Object.prototype.hasOwnProperty.call(rec, k)) out[k] = rec[k];
    }
    out.id = str(rec.id) || uid('lore');
    out.lorebookId = str(rec.lorebookId) || str(lorebookId);
    out.name = trim(rec.name);
    out.keys = toKeyList(rec.keys);
    out.secondaryKeys = toKeyList(rec.secondaryKeys);
    out.content = clampText(trim(rec.content), MAX_CONTENT);
    out.priority = num(rec.priority, 100);
    out.enabled = rec.enabled !== false;
    out.caseSensitive = rec.caseSensitive === true;
    out.alwaysOn = rec.alwaysOn === true;
    out.createdAt = num(rec.createdAt, 0) || nowMs();
    out.updatedAt = num(rec.updatedAt, 0) || out.createdAt;
    return out;
  }

  /* ---------------- 世界书列表 / 创建 ---------------- */

  // 某角色的全部世界书（一般只有 1 本，但保留多本能力）
  L.listForCharacter = function (characterId) {
    var cid = str(characterId);
    if (!cid) return Promise.resolve([]);
    return byIndex(BOOK_TABLE, 'characterId', cid)
      .then(function (list) {
        var out = [];
        for (var i = 0; i < list.length; i++) {
          if (list[i] && str(list[i].characterId) === cid) out.push(normalizeBook(list[i]));
        }
        out.sort(function (a, b) {
          return (a.createdAt || 0) - (b.createdAt || 0);
        });
        return out;
      })
      .catch(function (err) {
        warn('[lorebook] listForCharacter 失败', err);
        return [];
      });
  };

  // 保证某角色有一本世界书：有则返回第一本，无则创建（name = 角色名 + 的世界书）
  L.ensureForCharacter = function (characterId) {
    var cid = str(characterId);
    if (!cid) return Promise.reject(new Error('缺少 characterId'));

    return L.listForCharacter(cid)
      .then(function (books) {
        if (books.length > 0) return books[0];
        return readOne('characters', cid).then(function (ch) {
          var name = trim(ch && ch.name) || '角色';
          var t = nowMs();
          var book = {
            id: uid('lb'),
            name: name + '的世界书',
            characterId: cid,
            worldviewId: str(ch && ch.worldviewId),
            enabled: true,
            tokenBudget: DEFAULT_BUDGET,
            createdAt: t,
            updatedAt: t
          };
          var db = DB();
          if (!db) throw new Error('数据库未就绪');
          return Promise.resolve()
            .then(function () { return db.put(BOOK_TABLE, book); })
            .then(function (saved) { return normalizeBook(saved || book); });
        });
      })
      .catch(function (err) {
        warn('[lorebook] ensureForCharacter 失败', err);
        throw err;
      });
  };

  L.getBook = function (lorebookId) {
    return readOne(BOOK_TABLE, str(lorebookId)).then(function (rec) {
      return rec ? normalizeBook(rec) : null;
    });
  };

  // 某本世界书的全部条目（按 priority 降序，再按创建时间升序稳定排序）
  L.listEntries = function (lorebookId) {
    var lbid = str(lorebookId);
    if (!lbid) return Promise.resolve([]);
    return byIndex(ENTRY_TABLE, 'lorebookId', lbid)
      .then(function (list) {
        var out = [];
        for (var i = 0; i < list.length; i++) {
          if (list[i] && str(list[i].lorebookId) === lbid) out.push(normalizeEntry(list[i], lbid));
        }
        out.sort(function (a, b) {
          if (b.priority !== a.priority) return b.priority - a.priority;
          return (a.createdAt || 0) - (b.createdAt || 0);
        });
        return out;
      })
      .catch(function (err) {
        warn('[lorebook] listEntries 失败', err);
        return [];
      });
  };

  /* ---------------- 触发匹配 ---------------- */

  function hitAny(text, keys, caseSensitive) {
    for (var i = 0; i < keys.length; i++) {
      var k = keys[i];
      if (!k) continue;
      if (text.indexOf(k) >= 0) return true;
    }
    return false;
  }

  // 单条是否命中当前对话文本：alwaysOn 直通；keys 任一命中；有次要触发词时还要求命中其一
  L.matchEntry = function (entry, text) {
    var e = entry || {};
    if (e.enabled === false) return false;
    var body = trim(e.content);
    if (!body) return false;
    if (e.alwaysOn === true) return true;

    var keys = toKeyList(e.keys);
    if (!keys.length) return false;
    var secondary = toKeyList(e.secondaryKeys);
    var caseSensitive = e.caseSensitive === true;

    var t = str(text);
    if (!t) return false;
    if (!caseSensitive) {
      t = t.toLowerCase();
      keys = keys.map(function (k) { return k.toLowerCase(); });
      secondary = secondary.map(function (k) { return k.toLowerCase(); });
    }

    if (!hitAny(t, keys, caseSensitive)) return false;
    if (secondary.length && !hitAny(t, secondary, caseSensitive)) return false;
    return true;
  };

  function entryLabel(entry) {
    var name = trim(entry && entry.name);
    if (name) return name;
    var keys = toKeyList(entry && entry.keys);
    if (keys.length) return keys[0];
    return '条目';
  }

  // 纯函数：从候选条目拼注入文本（供 buildInjection 与自测使用）
  // budget <= 0 视为不限制
  L.composeInjection = function (entries, text, budget) {
    var list = [];
    var i;
    for (i = 0; i < (entries || []).length; i++) {
      var e = entries[i];
      if (!e) continue;
      if (L.matchEntry(e, text)) list.push(normalizeEntry(e, e.lorebookId));
    }
    list.sort(function (a, b) {
      if (b.priority !== a.priority) return b.priority - a.priority;
      return (a.createdAt || 0) - (b.createdAt || 0);
    });

    var limit = num(budget, 0);
    var used = 0;
    var lines = [];
    for (i = 0; i < list.length; i++) {
      var item = list[i];
      var line = '- ' + entryLabel(item) + '：' + trim(item.content);
      var cost = estimate(line) + 1; // +1 估算换行
      if (limit > 0 && used + cost > limit) break; // 超预算即停
      used += cost;
      lines.push(line);
    }
    if (!lines.length) return '';
    return '【世界书】\n' + lines.join('\n');
  };

  /* ---------------- 注入构建 ---------------- */

  function resolveBudget(opts, books) {
    var explicit = num(opts && opts.tokenBudget, 0);
    if (explicit > 0) return Math.floor(explicit);
    var min = 0;
    for (var i = 0; i < books.length; i++) {
      var tb = num(books[i] && books[i].tokenBudget, 0);
      if (tb > 0 && (min === 0 || tb < min)) min = Math.floor(tb);
    }
    return min || DEFAULT_BUDGET;
  }

  // 收集本次要参与注入的世界书：显式 lorebookIds 优先，否则取角色的全部世界书
  function collectBooks(opts) {
    var ids = [];
    if (Array.isArray(opts && opts.lorebookIds)) {
      ids = opts.lorebookIds.filter(function (x) { return trim(x); });
    }
    if (ids.length) {
      return Promise.all(ids.map(function (id) { return L.getBook(id); })).then(function (books) {
        return books.filter(function (b) { return !!b && b.enabled !== false; });
      });
    }
    var cid = str(opts && opts.characterId);
    if (!cid) return Promise.resolve([]);
    return L.listForCharacter(cid).then(function (books) {
      return books.filter(function (b) { return !!b && b.enabled !== false; });
    });
  }

  /**
   * 构建要拼进 system prompt 的世界书文本。
   * opts: { text, characterId, lorebookIds?, tokenBudget? }
   * 返回 Promise<string>：无命中返回 ''；任何异常也返回 ''。
   */
  L.buildInjection = function (opts) {
    var options = opts || {};
    try {
      if (!DB()) return Promise.resolve('');
      var text = str(options.text);
      return collectBooks(options)
        .then(function (books) {
          if (!books.length) return '';
          return Promise.all(books.map(function (b) { return L.listEntries(b.id); }))
            .then(function (lists) {
              var entries = [];
              for (var i = 0; i < lists.length; i++) {
                for (var j = 0; j < lists[i].length; j++) entries.push(lists[i][j]);
              }
              return L.composeInjection(entries, text, resolveBudget(options, books));
            });
        })
        .then(function (out) { return str(out); })
        .catch(function (err) {
          warn('[lorebook] buildInjection 失败（已忽略，不阻断聊天）', err);
          return '';
        });
    } catch (e) {
      warn('[lorebook] buildInjection 异常（已忽略，不阻断聊天）', e);
      return Promise.resolve('');
    }
  };

  /* ---------------- 保存条目 ---------------- */

  // 批量落库；自动补 id / 时间戳 / lorebookId。返回保存后的条目数组。
  L.saveEntries = function (entries, lorebookId) {
    var db = DB();
    if (!db) return Promise.reject(new Error('数据库未就绪'));
    var list = [];
    var i;
    for (i = 0; i < (entries || []).length; i++) {
      if (!entries[i]) continue;
      var rec = normalizeEntry(entries[i], lorebookId);
      rec.updatedAt = nowMs();
      if (!rec.createdAt) rec.createdAt = rec.updatedAt;
      list.push(rec);
    }
    if (!list.length) return Promise.resolve([]);
    var write = (typeof db.putMany === 'function')
      ? function () { return db.putMany(ENTRY_TABLE, list); }
      : (typeof db.bulkPut === 'function'
        ? function () { return db.bulkPut(ENTRY_TABLE, list); }
        : function () {
          return Promise.all(list.map(function (rec) { return db.put(ENTRY_TABLE, rec); }));
        });
    return Promise.resolve()
      .then(write)
      .then(function (saved) {
        return Array.isArray(saved) ? saved.map(function (r) { return normalizeEntry(r, lorebookId); }) : list;
      })
      .catch(function (err) {
        warn('[lorebook] saveEntries 失败', err);
        throw err;
      });
  };

  L.saveEntry = function (entry, lorebookId) {
    return L.saveEntries([entry], lorebookId).then(function (list) {
      return list[0] || null;
    });
  };

  L.deleteEntry = function (entryId) {
    var db = DB();
    if (!db) return Promise.reject(new Error('数据库未就绪'));
    return Promise.resolve()
      .then(function () { return db.del(ENTRY_TABLE, str(entryId)); })
      .catch(function (err) {
        warn('[lorebook] deleteEntry 失败', err);
        throw err;
      });
  };

  /* ---------------- 角色卡 → worldText ---------------- */

  /**
   * 把角色卡（+ 可选世界观记录）拼成给模型看的设定文本。
   * card: characters 表的一条记录；spec: worldviews 表的一条记录（可空）
   */
  L.buildWorldText = function (card, spec) {
    var c = card || {};
    var parts = [];
    var name = trim(c.name);
    if (name) parts.push('角色名：' + name);
    if (trim(c.gender)) parts.push('性别：' + trim(c.gender));
    if (trim(c.type)) parts.push('类型：' + (trim(c.type) === 'assistant' ? '助手' : '陪聊角色'));

    var fields = [
      ['身份', 'identity'],
      ['性格', 'personality'],
      ['习惯', 'habits'],
      ['背景', 'background'],
      ['外貌', 'appearance'],
      ['说话风格', 'speechStyle'],
      ['口头禅', 'catchphrases'],
      ['场景', 'scenario']
    ];
    var i;
    for (i = 0; i < fields.length; i++) {
      var v = trim(c[fields[i][1]]);
      if (v) parts.push(fields[i][0] + '：' + v);
    }
    // 场景可能是数组
    if (!trim(c.scenario) && Array.isArray(c.scenarios)) {
      var sc = [];
      for (i = 0; i < c.scenarios.length; i++) {
        if (trim(c.scenarios[i])) sc.push(trim(c.scenarios[i]));
      }
      if (sc.length) parts.push('场景：' + sc.join('；'));
    }
    var snap = trim(c.worldviewSnapshot);
    if (snap) parts.push('世界观快照：\n' + snap);

    if (spec) {
      var wvName = trim(spec.name);
      if (wvName) parts.push('所属世界观：' + wvName);
      if (trim(spec.summary)) parts.push('世界观摘要：' + trim(spec.summary));
      var wvFields = ['geography', 'factions', 'history', 'rules', 'technology', 'culture', 'detail'];
      for (i = 0; i < wvFields.length; i++) {
        var wv = trim(spec[wvFields[i]]);
        if (wv) parts.push('世界观设定：' + wv);
      }
    }
    return parts.join('\n');
  };

  /* ---------------- AI 生成条目 ---------------- */

  function buildGenMessages(worldText, retryHint) {
    var sys = '你是角色扮演应用里的世界书（Lorebook）编辑。你的任务是把角色设定拆成可被关键词触发的设定条目。' +
      '你只输出 JSON，不输出任何解释、前言、Markdown 代码块。';
    var user = '【角色 / 世界观设定】\n' + worldText + '\n\n' +
      '请把以上设定拆成 ' + GEN_MIN + '~' + GEN_MAX + ' 条世界书条目（Lorebook entries）。\n' +
      '要求：\n' +
      '1. 每条只讲一个具体的人 / 地点 / 物品 / 组织 / 规则 / 人物关系，不要写成泛泛的角色简介。\n' +
      '2. keys 是 2~4 个在该设定或日常对话里很可能出现的触发词：人名、称呼、地名、物品名、专有名词。' +
      '禁止使用「他、她、我、你、我们、他们、这个、那个」这类代词或通用词。\n' +
      '3. content 是 80~200 字的中文设定正文：第三人称、客观陈述事实，不要评论、不要「你可以……」这种指导语气。\n' +
      '4. priority：100 为默认；越关键（主角、核心地点、核心规则）越高，范围 100~200。\n' +
      '5. 只输出下面这种结构的 JSON，entries 里恰好 ' + GEN_MIN + '~' + GEN_MAX + ' 个对象：\n' +
      '{"entries":[{"name":"条目名","keys":["触发词一","触发词二"],"priority":120,"content":"条目正文"}]}';
    if (retryHint) {
      user += '\n\n【重要】上一次的输出无法被解析（' + retryHint + '）。这次请只输出一个合法 JSON 对象，' +
        '不要 Markdown 代码块、不要注释、不要多余文字，确保可以被 JSON.parse 直接解析。';
    }
    return [
      { role: 'system', content: sys },
      { role: 'user', content: user }
    ];
  }

  // 从模型输出里抽出条目数组（宽松解析）
  function parseGenerated(text) {
    var u = U();
    var obj = null;
    if (u && typeof u.parseJSONLoose === 'function') {
      try { obj = u.parseJSONLoose(str(text)); } catch (e) { obj = null; }
    }
    if (obj === null || obj === undefined) {
      try { obj = JSON.parse(str(text)); } catch (e2) { obj = null; }
    }
    if (!obj) return [];
    var raw = null;
    if (Array.isArray(obj)) raw = obj;
    else if (Array.isArray(obj.entries)) raw = obj.entries;
    else if (Array.isArray(obj.list)) raw = obj.list;
    else if (Array.isArray(obj.items)) raw = obj.items;
    else if (obj.entries && typeof obj.entries === 'object') raw = [obj.entries];
    if (!raw) return [];

    var out = [];
    for (var i = 0; i < raw.length && out.length < GEN_MAX; i++) {
      var it = raw[i];
      if (!it || typeof it !== 'object') continue;
      var content = trim(it.content || it.text || it.body || it.desc || it.description);
      if (!content) continue;
      var keys = toKeyList(it.keys || it.keywords || it.key || it.trigger || it.triggers);
      if (!keys.length) continue;
      out.push(normalizeEntry({
        name: trim(it.name || it.title) || keys[0],
        keys: keys,
        secondaryKeys: toKeyList(it.secondaryKeys || it.secondary),
        content: content,
        priority: num(it.priority, 100),
        enabled: true,
        caseSensitive: false,
        alwaysOn: it.alwaysOn === true
      }));
    }
    return out;
  }

  function resolveProvider(opts) {
    if (opts && opts.provider) return Promise.resolve(opts.provider);
    // 没显式给：优先引导 API
    var kit = App.CharKit;
    if (kit && typeof kit.loadProviders === 'function') {
      return Promise.resolve()
        .then(function () { return kit.loadProviders(); })
        .then(function (list) {
          var pick = null;
          if (kit && typeof kit.findGuide === 'function') pick = kit.findGuide(list || []);
          if (!pick && list && list.length) pick = list[0];
          return pick || null;
        })
        .catch(function () { return null; });
    }
    return Promise.resolve(null);
  }

  /**
   * 根据角色卡 / 世界观文本用 AI 生成世界书条目。
   * opts: { lorebookId, worldText, provider, model, preview? }
   *   preview === true 时只生成不落库（页面预览勾选用），返回 {created:0, entries:[...], preview:true}
   * 返回 Promise<{ created:number, entries:Array }>
   * 失败重试 1 次；仍失败则 reject（由页面展示错误）。
   */
  L.generateEntries = function (opts) {
    var o = opts || {};
    var lorebookId = str(o.lorebookId);
    var worldText = trim(o.worldText);
    var preview = o.preview === true;

    if (!lorebookId) return Promise.reject(new Error('缺少 lorebookId，无法生成条目'));
    if (!worldText) return Promise.reject(new Error('缺少角色设定文本，无法生成条目'));
    var api = App.API;
    if (!api || typeof api.chatOnce !== 'function') return Promise.reject(new Error('AI 接口未就绪'));
    if (worldText.length > 4000) worldText = worldText.slice(0, 4000);

    function attempt(round, retryHint) {
      return resolveProvider(o).then(function (provider) {
        if (!provider) {
          var e0 = new Error('还没有可用的 AI 接口，请先在「API 管理」里配置');
          e0.code = 'noprovider';
          throw e0;
        }
        var model = trim(o.model) || trim(provider.defaultModel) || trim(provider.model) || '';
        var messages = buildGenMessages(worldText, retryHint);
        return Promise.resolve()
          .then(function () {
            return api.chatOnce({
              provider: provider,
              model: model,
              messages: messages,
              params: { temperature: 0.7, max_tokens: 2000 },
              timeoutMs: GEN_TIMEOUT_MS
            });
          })
          .then(function (res) {
            if (!res || res.ok !== true) {
              var err = (res && res.error) || {};
              var ee = new Error(err.message || 'AI 生成失败');
              ee.code = err.code || 'unknown';
              ee.round = round;
              throw ee;
            }
            var entries = parseGenerated(res.text);
            if (!entries.length) {
              var e2 = new Error('AI 返回的条目格式不正确');
              e2.code = 'badjson';
              e2.round = round;
              throw e2;
            }
            return entries;
          });
      });
    }

    return attempt(1, '')
      .catch(function (err1) {
        var code = errCode(err1);
        if (code === 'cancel') throw err1;
        var hint = (code === 'badjson') ? 'JSON 格式错误' : '网络或接口错误';
        return attempt(2, hint).catch(function (err2) {
          // 第二次也失败：抛出第二次的错误，但保留第一次的信息方便排查
          var e3 = new Error(safeErrMsg(err2) || safeErrMsg(err1));
          e3.code = errCode(err2);
          e3.firstError = safeErrMsg(err1);
          throw e3;
        });
      })
      .then(function (entries) {
        if (preview) return { created: 0, entries: entries, preview: true };
        return L.saveEntries(entries, lorebookId).then(function (saved) {
          return { created: saved.length, entries: saved };
        });
      });
  };

  /* ---------------- 供聊天侧使用的便捷方法 ---------------- */

  // 便捷：直接给「已拼好的系统提示 + 当前对话文本」拿一段可直接追加的世界书文本
  L.buildFromText = function (characterId, text, tokenBudget) {
    return L.buildInjection({ characterId: characterId, text: text, tokenBudget: tokenBudget });
  };
})();
