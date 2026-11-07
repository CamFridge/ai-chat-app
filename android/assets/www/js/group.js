/* group.js —— 多角色群聊数据层，挂到 window.App.Group（v1.4.0 契约 §2.2）
 *
 * 契约（PLAN-v1.4.0 §2.2）：
 *   Group.membersOf(session)                -> Promise<Array<{id,name,avatar,character}>>
 *   Group.buildContext(opts)                -> {messages, usedTokens, systemTokens, dropped}
 *        opts = {session, members, persona, preset, messages, godMode, scene, lore, textMode, tokenBudget}
 *   Group.decideSpeaker(opts)               -> Promise<{characterId, name}>  永不 reject
 *        opts = {session, members, messages, provider, model, timeoutMs}
 *   Group.parseSpeakerReply(text, members, fallback) -> {characterId, name, content}
 *   Group.create({name, characterIds})      -> Promise<{group, session}>
 *   Group.addMembers(session, characterIds) -> Promise<session>
 *   Group.removeMember(session, characterId)-> Promise<session>（至少保留 2 人）
 *
 * 附加（页面/列表复用的小工具，不属于契约，但行为稳定）：
 *   Group.groupOf(session) / Group.rename(session, name) / Group.dissolve(session)
 *   Group.MIN_MEMBERS
 *
 * 依赖：App.Util / App.DB 必须已加载；App.ChatKit / App.API / App.Persona / App.UI 一律懒引用，
 * 缺失时降级（本文件在 index.html 中早于 pages/chat-list.js 加载，不能顶层取 App.ChatKit）。
 */
(function () {
  'use strict';
  var App = window.App = window.App || {};
  var G = App.Group = App.Group || {};

  G.MIN_MEMBERS = 2;

  /* =============================== 基础小工具 =============================== */

  function db() { return App.DB || null; }
  function util() { return App.Util || {}; }
  function kit() { return App.ChatKit || {}; }
  function api() { return App.API || null; }

  function nowTs() {
    try {
      if (util() && typeof util().now === 'function') return util().now();
    } catch (e) { /* 继续兜底 */ }
    return Date.now();
  }

  function uid(prefix) {
    try {
      if (util() && typeof util().uid === 'function') return util().uid(prefix);
    } catch (e) { /* 继续兜底 */ }
    return String(prefix || 'id') + '_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  }

  function str(v) { return v === undefined || v === null ? '' : String(v); }

  function nowLine(text, max) {
    var s = str(text).replace(/\s+/g, ' ').trim();
    if (!s) return '';
    var n = Number(max) || 0;
    return n > 0 && s.length > n ? s.slice(0, n) + '…' : s;
  }

  // token 估算：复用 App.Util.estimateTokens（与 ChatKit 同一套算法），缺失时按字符粗估
  function estimateTokens(text) {
    var s = str(text);
    if (!s) return 0;
    try {
      if (typeof util().estimateTokens === 'function') return Number(util().estimateTokens(s)) || 0;
    } catch (e) { /* 继续兜底 */ }
    return Math.ceil(s.length / 3);
  }

  function attachmentTokens(atts) {
    var total = 0;
    (Array.isArray(atts) ? atts : []).forEach(function (att) {
      if (!att) return;
      if (att.kind === 'image') total += 85;
      else if (att.kind === 'file') total += estimateTokens(att.text) + 12;
    });
    return total;
  }

  function messageTokens(row) {
    if (!row) return 0;
    return estimateTokens(row.content) + 4 + attachmentTokens(row.attachments);
  }

  function dbReady() {
    var D = db();
    if (!D) return false;
    return typeof D.get === 'function' && typeof D.put === 'function';
  }

  function dbFail() {
    return Promise.reject(new Error('数据层未就绪，请重启应用'));
  }

  function safeGet(table, id) {
    var D = db();
    if (!D || !id) return Promise.resolve(null);
    return Promise.resolve(D.get(table, id)).catch(function () { return null; });
  }

  function safeAll(table) {
    var D = db();
    if (!D) return Promise.resolve([]);
    return Promise.resolve(D.all(table)).then(function (list) {
      return Array.isArray(list) ? list : [];
    }).catch(function () { return []; });
  }

  /* =============================== 成员 =============================== */

  // 统一成 {id, name, avatar, character}，按传入顺序去重
  function normMembers(members) {
    var out = [];
    var seen = {};
    (Array.isArray(members) ? members : []).forEach(function (m) {
      if (!m) return;
      // 兼容直接传 character 记录（没有 character 字段时视为角色本身）
      var c = m.character || m;
      var id = str(m.id || c.id).trim();
      if (!id || seen[id]) return;
      seen[id] = true;
      out.push({
        id: id,
        name: str(m.name || c.name).trim() || '未命名角色',
        avatar: str(m.avatar || c.avatar || ''),
        character: m.character || (m.name || m.type || m.personality ? m : null)
      });
    });
    return out;
  }

  function findById(members, id) {
    var key = str(id).trim();
    if (!key) return null;
    for (var i = 0; i < members.length; i++) {
      if (str(members[i].id) === key) return members[i];
    }
    return null;
  }

  function findByName(members, name) {
    var key = str(name).replace(/\s+/g, '').trim();
    if (!key) return null;
    for (var i = 0; i < members.length; i++) {
      if (str(members[i].name).replace(/\s+/g, '').trim() === key) return members[i];
    }
    return null;
  }

  function uniqueIds(list) {
    var out = [];
    var seen = {};
    (Array.isArray(list) ? list : []).forEach(function (v) {
      var id = str(v).trim();
      if (!id || seen[id]) return;
      seen[id] = true;
      out.push(id);
    });
    return out;
  }

  // 会话成员 id 列表：优先 session.characterIds，缺失时回落到 groups 记录
  function memberIdsOf(session) {
    var s = session || {};
    if (Array.isArray(s.characterIds) && s.characterIds.length) return Promise.resolve(uniqueIds(s.characterIds));
    if (!s.groupId) return Promise.resolve([]);
    return safeGet('groups', s.groupId).then(function (g) {
      return g && Array.isArray(g.characterIds) ? uniqueIds(g.characterIds) : [];
    });
  }

  G.membersOf = function (session) {
    if (!dbReady()) return Promise.resolve([]);
    return memberIdsOf(session).then(function (ids) {
      return Promise.all(ids.map(function (id) { return safeGet('characters', id); }));
    }).then(function (chars) {
      var members = [];
      (chars || []).forEach(function (c) {
        if (!c || !c.id) return;
        members.push({
          id: c.id,
          name: str(c.name).trim() || '未命名角色',
          avatar: str(c.avatar || ''),
          character: c
        });
      });
      return members;
    }).catch(function (err) {
      console.error('[group] 读取群成员失败', err);
      return [];
    });
  };

  /* =============================== system prompt =============================== */

  function typeLabel(c) {
    var K = kit();
    try {
      if (typeof K.typeLabel === 'function') return K.typeLabel((c && c.type) || 'companion');
    } catch (e) { /* 继续 */ }
    return (c && c.type === 'assistant') ? '助手' : '陪聊';
  }

  // 成员的一句人设：性格 > 简介 > 系统提示词 > 场景
  function memberPersona(m) {
    var c = (m && m.character) || {};
    var text = str(c.personality || c.description || c.systemPrompt || c.scenario || '').replace(/\s+/g, ' ').trim();
    if (!text) return '暂无设定';
    return text.length > 90 ? text.slice(0, 90) + '…' : text;
  }

  function personaLine(persona) {
    var P = App.Persona;
    if (P && typeof P.promptLine === 'function') {
      try {
        var line = P.promptLine(persona);
        if (line) return str(line);
      } catch (e) { /* 继续兜底 */ }
    }
    if (!persona || (!persona.name && !persona.description)) return '';
    var out = '【用户设定】用户扮演：' + str(persona.name || '我');
    if (persona.description) out += '，' + str(persona.description);
    return out;
  }

  function buildGroupSystem(opts, members) {
    opts = opts || {};
    var session = opts.session || {};
    var title = str(session.title || opts.name || '').trim() || '群聊';
    var names = members.map(function (m) { return m.name; });
    var parts = [];
    var rules = [];

    rules.push('【群聊模式】你正在参与一个多角色群聊「' + title + '」，同时扮演群里的 ' + members.length +
      ' 位成员：' + (names.length ? names.join('、') : '（暂无成员）') + '。');
    rules.push('群聊规则：');
    rules.push('1. 每次只由一位成员发言，不要一人分饰多角，也不要替用户说话或总结全场。');
    rules.push('2. 回复的第一行必须是【角色名】，角色名只能从下面的成员名单里选；从第二行开始才是正文。');
    rules.push('3. 只以被选中那位成员的口吻说话，保持他/她的性格、记忆与说话习惯，不要写旁白分析。');
    rules.push('4. 群成员之间可以互相接话、吐槽、补充，但要自然，不要轮流念台词。');
    rules.push('5. 如果用户用 @名字 点名某位成员，优先由被 @ 的成员回应。');

    if (members.length) {
      rules.push('【群成员名单】');
      members.forEach(function (m, i) {
        var c = m.character || {};
        var label = typeLabel(c);
        var line = (i + 1) + '. ' + m.name + (label ? '（' + label + '）' : '') + '：' + memberPersona(m);
        rules.push(line);
      });
    }
    parts.push(rules.join('\n'));

    var pLine = personaLine(opts.persona);
    if (pLine) parts.push(pLine);

    var preset = opts.preset || null;
    if (preset) {
      var extra = str(preset.instructTemplate || preset.systemPrompt).trim();
      if (extra) parts.push(extra);
    }

    if (opts.textMode) {
      parts.push('【输出模式：纯文本】正文只输出文本：不要使用 Markdown 标题或列表，不要用星号包裹动作神态，不要输出图片标记；'
        + '但第一行的【角色名】标记必须保留。');
    } else {
      var K = kit();
      var expr = str(K.EXPRESSION_PROMPT).trim();
      if (expr) parts.push(expr);
    }

    var lore = str(opts.lore).trim();
    if (lore) parts.push(lore);

    var K2 = kit();
    if (opts.godMode === true) {
      var god = str(K2.GOD_MODE_PROMPT).trim();
      if (god) parts.push(god);
    }

    var scene = str(opts.scene).trim();
    if (scene) {
      parts.push('【当前场景】' + scene + '\n对话发生在上述场景里：自然带入环境、光线、声音与动作细节，不要生硬复述场景名。');
    }

    return parts.join('\n\n');
  }

  /* =============================== 上下文组装 =============================== */

  function speakerPrefix(m, members, persona) {
    if (m.role === 'user') return str((persona && persona.name) || '我');
    var name = str(m.speakerName).trim();
    if (!name) {
      var byId = findById(members, m.characterId);
      if (byId) name = byId.name;
    }
    return name || '成员';
  }

  function toApiRow(m, members, persona) {
    var text = str(m.content);
    var prefix = speakerPrefix(m, members, persona);
    var row = {
      role: m.role,
      content: text ? (prefix + '：' + text) : ''
    };
    if (Array.isArray(m.attachments) && m.attachments.length) row.attachments = m.attachments;
    return row;
  }

  G.buildContext = function (opts) {
    opts = opts || {};
    var members = normMembers(opts.members);
    var history = (Array.isArray(opts.messages) ? opts.messages : []).filter(function (m) {
      if (!m) return false;
      if (m.role !== 'user' && m.role !== 'assistant') return false;
      if (m.status === 'error') return false;
      if (m.isActive === false) return false;
      var atts = Array.isArray(m.attachments) ? m.attachments : [];
      return str(m.content).trim() !== '' || atts.length > 0;
    });

    var sys = buildGroupSystem(opts, members);
    var sysTokens = estimateTokens(sys);

    var budget = Number(opts.tokenBudget) || 0;
    if (!budget) {
      try { budget = Number(kit().TOKEN_BUDGET) || 0; } catch (e) { budget = 0; }
    }
    if (!budget) budget = 3000;
    var left = Math.max(600, budget - sysTokens);

    var rows = history.map(function (m) { return toApiRow(m, members, opts.persona); });
    var tokens = rows.map(function (row) { return messageTokens(row); });

    // 保留最近一轮完整（从最后一条 user 开始），再从新往旧补更早的历史；system 永不丢
    var lastUser = -1;
    for (var i = rows.length - 1; i >= 0; i--) {
      if (rows[i].role === 'user') { lastUser = i; break; }
    }
    var tail = lastUser >= 0 ? rows.slice(lastUser) : [];
    var used = 0;
    for (var t = lastUser >= 0 ? lastUser : rows.length; t < rows.length; t++) used += tokens[t] || 0;

    var head = [];
    var start = lastUser >= 0 ? lastUser - 1 : rows.length - 1;
    for (var j = start; j >= 0; j--) {
      var one = tokens[j] || 0;
      if (used + one > left) break;
      head.unshift(rows[j]);
      used += one;
    }
    var picked = head.concat(tail);
    // 对话尽量从用户消息开始（裁掉头部孤立的成员发言，避免模型蒙圈）
    while (picked.length && picked[0].role === 'assistant') {
      used -= messageTokens(picked[0]);
      picked.shift();
    }
    if (used < 0) used = 0;

    var messages = [];
    if (sys) messages.push({ role: 'system', content: sys });
    picked.forEach(function (row) { messages.push(row); });

    return {
      messages: messages,
      usedTokens: used + sysTokens,
      systemTokens: sysTokens,
      dropped: Math.max(0, rows.length - picked.length)
    };
  };

  /* =============================== 发言人决策 =============================== */

  function withTimeout(promise, ms, fallbackValue) {
    return new Promise(function (resolve) {
      var done = false;
      var timer = setTimeout(function () {
        if (done) return;
        done = true;
        resolve(fallbackValue);
      }, Number(ms) || 15000);
      Promise.resolve(promise).then(function (v) {
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolve(v);
      }, function () {
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolve(fallbackValue);
      });
    });
  }

  // 轮换兜底：上一条 assistant 发言人之后的那位成员；没有则第一位
  function nextSpeaker(members, messages) {
    if (!members.length) return { characterId: '', name: '' };
    var list = Array.isArray(messages) ? messages : [];
    var last = null;
    for (var i = list.length - 1; i >= 0; i--) {
      var m = list[i];
      if (m && m.role === 'assistant') { last = m; break; }
    }
    var idx = -1;
    if (last) {
      var hit = findById(members, last.characterId);
      if (!hit && last.speakerName) hit = findByName(members, last.speakerName);
      if (hit) idx = members.indexOf(hit);
    }
    var next = idx >= 0 ? members[(idx + 1) % members.length] : members[0];
    return { characterId: str(next.id), name: str(next.name) };
  }

  function decodeSpeaker(text) {
    var s = str(text).trim();
    if (!s) return null;
    // 去掉 ```json 包裹
    s = s.replace(/^```[a-zA-Z]*\s*/, '').replace(/\s*```$/, '').trim();
    var obj = null;
    try {
      if (typeof util().parseJSONLoose === 'function') obj = util().parseJSONLoose(s);
    } catch (e) { obj = null; }
    if (!obj) {
      try { obj = JSON.parse(s); } catch (e2) { obj = null; }
    }
    if (Array.isArray(obj)) obj = obj[0] || null;
    if (obj && typeof obj === 'object') {
      var inner = obj.speaker || obj.character || obj.data || obj.result || null;
      if (inner && typeof inner === 'object') obj = inner;
      var id = str(obj.characterId || obj.id || obj.character_id || '').trim();
      var name = str(obj.name || obj.speakerName || obj.speaker_name || '').trim();
      if (id || name) return { characterId: id, name: name };
    }
    return null;
  }

  function pickSpeaker(candidate, members) {
    if (!candidate) return null;
    var hit = candidate.characterId ? findById(members, candidate.characterId) : null;
    if (!hit && candidate.name) hit = findByName(members, candidate.name);
    if (!hit) return null;
    return { characterId: str(hit.id), name: str(hit.name) };
  }

  function pickSpeakerFromText(text, members) {
    var s = str(text);
    var m = /"characterId"\s*:\s*"([^"]+)"/.exec(s);
    if (m) {
      var byId = findById(members, m[1]);
      if (byId) return { characterId: str(byId.id), name: str(byId.name) };
    }
    // 最后兜底：找第一个出现在文本里的成员名
    var best = null;
    var bestAt = -1;
    members.forEach(function (item) {
      var at = s.indexOf(item.name);
      if (at < 0) return;
      if (bestAt < 0 || at < bestAt) { bestAt = at; best = item; }
    });
    return best ? { characterId: str(best.id), name: str(best.name) } : null;
  }

  function speakerRequest(opts, members) {
    var session = opts.session || {};
    var title = str(session.title || '群聊').trim() || '群聊';
    var lines = (Array.isArray(opts.messages) ? opts.messages : []).filter(function (m) {
      return m && (m.role === 'user' || m.role === 'assistant') && str(m.content).trim();
    }).slice(-6).map(function (m) {
      var who = m.role === 'user'
        ? '用户'
        : (str(m.speakerName).trim() || '某位成员');
      return who + '：' + nowLine(m.content, 120);
    });

    var memberLines = members.map(function (m) {
      return '- id=' + m.id + '｜' + m.name + '｜' + memberPersona(m);
    });

    var system = '你是群聊「' + title + '」的发言调度器：从群成员里挑出最适合接下来说话的一位。'
      + '只输出一个 JSON 对象，格式 {"characterId":"成员id","why":"一句理由"}，不要输出任何其它文字。';
    var user = '【群成员】\n' + memberLines.join('\n')
      + '\n\n【最近对话】\n' + (lines.length ? lines.join('\n') : '（还没有对话）')
      + '\n\n请选择下一位发言的成员，只输出 JSON。';

    return [
      { role: 'system', content: system },
      { role: 'user', content: user }
    ];
  }

  G.decideSpeaker = function (opts) {
    opts = opts || {};
    var members = normMembers(opts.members);
    var fallback = { characterId: '', name: '' };
    try { fallback = nextSpeaker(members, opts.messages); } catch (e) { fallback = { characterId: '', name: '' }; }

    if (members.length <= 1) return Promise.resolve(fallback);
    var provider = opts.provider || null;
    if (!provider || (!provider.id && !provider.baseUrl)) return Promise.resolve(fallback);
    var A = api();
    if (!A || typeof A.chatOnce !== 'function') return Promise.resolve(fallback);

    var messages;
    try { messages = speakerRequest(opts, members); } catch (e) { return Promise.resolve(fallback); }

    // 整条链路（含就绪检查）统一加超时兜底，永不 reject
    var task = Promise.resolve().then(function () {
      var ready = null;
      try { ready = typeof A.checkProviderReady === 'function' ? A.checkProviderReady(provider) : null; } catch (e) { ready = null; }
      return Promise.resolve(ready).then(function (r) {
        if (r && r.ok === false) return fallback;
        return A.chatOnce({
          provider: provider,
          model: str(opts.model).trim(),
          messages: messages,
          params: { temperature: 0.2, top_p: 0.9, max_tokens: 120 },
          timeoutMs: Number(opts.timeoutMs) || 12000
        }).then(function (res) {
          if (!res || !res.ok) return fallback;
          var picked = pickSpeaker(decodeSpeaker(res.text), members) || pickSpeakerFromText(res.text, members);
          return picked || fallback;
        });
      });
    });

    return withTimeout(task, Number(opts.timeoutMs) || 15000, fallback).then(function (spk) {
      if (!spk || !spk.characterId) return fallback;
      return spk;
    }).catch(function () {
      return fallback;
    });
  };

  /* =============================== 回复解析 =============================== */

  function normFallback(fallback, members) {
    var fb = fallback || {};
    var id = str(fb.characterId || fb.id || '').trim();
    var name = str(fb.name || fb.speakerName || '').trim();
    var hit = id ? findById(members, id) : null;
    if (!hit && name) hit = findByName(members, name);
    if (hit) return { characterId: str(hit.id), name: str(hit.name) };
    if (id || name) return { characterId: id, name: name || '成员' };
    if (members.length) return { characterId: str(members[0].id), name: str(members[0].name) };
    return { characterId: '', name: '' };
  }

  G.parseSpeakerReply = function (text, members, fallback) {
    var raw = text === undefined || text === null ? '' : String(text);
    var list = normMembers(members);
    var fb = normFallback(fallback, list);
    if (!raw.trim()) return { characterId: fb.characterId, name: fb.name, content: '' };

    // 首行标记：【角色名】 或 [角色名]
    var m = /^\s*(?:【([^】\n]{1,40})】|\[([^\]\n]{1,40})\])\s*([\s\S]*)$/.exec(raw);
    if (!m) return { characterId: fb.characterId, name: fb.name, content: raw.trim() };

    var name = str(m[1] || m[2] || '').trim();
    var body = str(m[3] || '').replace(/^[ \t]*\r?\n/, '').trim();
    var hit = findByName(list, name);
    if (!hit) return { characterId: fb.characterId, name: fb.name, content: raw.trim() };
    return { characterId: str(hit.id), name: str(hit.name), content: body };
  };

  /* =============================== 创建 / 成员管理 =============================== */

  function defaultProviderId() {
    var D = db();
    if (!D || !D.settings || typeof D.settings.get !== 'function') return Promise.resolve('');
    return Promise.resolve(D.settings.get('default_chat_provider_id', '')).then(function (v) {
      return str(v);
    }).catch(function () { return ''; });
  }

  function defaultPresetId() {
    var D = db();
    if (!D || !D.settings || typeof D.settings.get !== 'function') return Promise.resolve('');
    return Promise.resolve(D.settings.get('default_preset_id', '')).then(function (v) {
      return str(v);
    }).catch(function () { return ''; });
  }

  function defaultPersonaId() {
    var P = App.Persona;
    if (P && typeof P.getDefaultId === 'function') {
      try {
        return Promise.resolve(P.getDefaultId()).then(function (id) { return str(id); }).catch(function () { return ''; });
      } catch (e) { /* 继续兜底 */ }
    }
    var D = db();
    if (!D || !D.settings || typeof D.settings.get !== 'function') return Promise.resolve('');
    return Promise.resolve(D.settings.get('default_persona_id', '')).then(function (v) {
      return str(v);
    }).catch(function () { return ''; });
  }

  function pickProvider(providers, defId) {
    var list = (Array.isArray(providers) ? providers : []).filter(function (p) {
      return p && (p.role === 'chat' || !p.role);
    });
    if (!list.length) list = (Array.isArray(providers) ? providers : []).slice();
    var found = null;
    list.forEach(function (p) { if (!found && p.id === defId) found = p; });
    if (!found && list.length) found = list[0];
    return found || null;
  }

  function providerModel(provider) {
    if (!provider) return '';
    return str(provider.defaultModel || (Array.isArray(provider.models) ? provider.models[0] : '') || '');
  }

  function validateCharacters(ids) {
    return Promise.all(ids.map(function (id) {
      return safeGet('characters', id).then(function (c) { return c && c.id ? c.id : null; });
    })).then(function (list) {
      return uniqueIds(list);
    });
  }

  // 同步 groups 记录里的成员/群名（不存在就跳过，不阻断主流程）
  function syncGroup(session, patch) {
    var s = session || {};
    if (!s.groupId || !dbReady()) return Promise.resolve(null);
    return safeGet('groups', s.groupId).then(function (g) {
      if (!g) return null;
      var next = g;
      if (patch && Object.prototype.hasOwnProperty.call(patch, 'characterIds')) next.characterIds = uniqueIds(patch.characterIds);
      if (patch && Object.prototype.hasOwnProperty.call(patch, 'name')) next.name = str(patch.name);
      next.updatedAt = nowTs();
      return db().put('groups', next);
    }).catch(function (err) {
      console.error('[group] 同步群记录失败', err);
      return null;
    });
  }

  G.groupOf = function (session) {
    var s = session || {};
    if (!s.groupId) return Promise.resolve(null);
    return safeGet('groups', s.groupId);
  };

  G.create = function (options) {
    var opts = options || {};
    if (!dbReady()) return dbFail();
    var name = str(opts.name).replace(/\s+/g, ' ').trim();
    if (!name) return Promise.reject(new Error('请填写群聊名称'));
    var ids = uniqueIds(opts.characterIds);
    if (ids.length < G.MIN_MEMBERS) return Promise.reject(new Error('群聊至少需要 ' + G.MIN_MEMBERS + ' 位成员'));

    return validateCharacters(ids).then(function (validIds) {
      if (validIds.length < G.MIN_MEMBERS) {
        throw new Error('群聊至少需要 ' + G.MIN_MEMBERS + ' 位可用角色');
      }
      var ts = nowTs();
      var group = {
        id: uid('grp'),
        name: name,
        characterIds: validIds,
        avatar: '',
        createdAt: ts,
        updatedAt: ts
      };
      return Promise.resolve(db().put('groups', group)).then(function (savedGroup) {
        var g = savedGroup && savedGroup.id ? savedGroup : group;
        return Promise.all([
          safeAll('providers'),
          defaultProviderId(),
          defaultPresetId(),
          defaultPersonaId()
        ]).then(function (arr) {
          var provider = pickProvider(arr[0], arr[1]);
          var presetId = str(arr[2]);
          if (!presetId) {
            try {
              var K = kit();
              if (typeof K.defaultPresetFor === 'function') {
                var p = K.defaultPresetFor('companion');
                presetId = str(p && p.id);
              }
            } catch (e) { presetId = ''; }
          }
          var ts2 = nowTs();
          var session = {
            id: uid('sess'),
            kind: 'group',
            title: name,
            characterId: '',
            characterIds: validIds.slice(),
            groupId: g.id,
            personaId: str(arr[3]),
            presetId: presetId,
            model: providerModel(provider),
            providerId: str(provider && provider.id),
            pinned: false,
            unread: 0,
            isGenerating: false,
            greetingIndex: -1,
            scene: '',
            lorebookIds: [],
            lastText: '',
            lastRole: '',
            lastAt: ts2,
            createdAt: ts2,
            updatedAt: ts2
          };
          return Promise.resolve(db().put('sessions', session)).then(function (savedSession) {
            var s = savedSession && savedSession.id ? savedSession : session;
            return { group: g, session: s };
          });
        });
      });
    });
  };

  G.addMembers = function (session, characterIds) {
    if (!dbReady()) return dbFail();
    var s = session || {};
    if (!s.id) return Promise.reject(new Error('缺少会话信息'));
    var add = uniqueIds(characterIds);
    if (!add.length) return Promise.resolve(s);

    return memberIdsOf(s).then(function (ids) {
      var merged = uniqueIds(ids.concat(add));
      if (merged.length === ids.length) return s; // 全都已经在群里
      return validateCharacters(merged).then(function (validIds) {
        if (validIds.length < G.MIN_MEMBERS) throw new Error('群聊至少需要 ' + G.MIN_MEMBERS + ' 位成员');
        var next = s;
        next.characterIds = validIds;
        next.updatedAt = nowTs();
        return Promise.resolve(db().put('sessions', next)).then(function (saved) {
          var out = saved && saved.id ? saved : next;
          return syncGroup(out, { characterIds: validIds }).then(function () { return out; });
        });
      });
    });
  };

  G.removeMember = function (session, characterId) {
    if (!dbReady()) return dbFail();
    var s = session || {};
    if (!s.id) return Promise.reject(new Error('缺少会话信息'));
    var removeId = str(characterId).trim();
    if (!removeId) return Promise.reject(new Error('缺少要移除的成员'));

    return memberIdsOf(s).then(function (ids) {
      if (ids.indexOf(removeId) < 0) return s;
      var rest = ids.filter(function (id) { return id !== removeId; });
      if (rest.length < G.MIN_MEMBERS) {
        throw new Error('群聊至少需要 ' + G.MIN_MEMBERS + ' 位成员，不能再减少');
      }
      var next = s;
      next.characterIds = rest;
      next.updatedAt = nowTs();
      return Promise.resolve(db().put('sessions', next)).then(function (saved) {
        var out = saved && saved.id ? saved : next;
        return syncGroup(out, { characterIds: rest }).then(function () { return out; });
      });
    });
  };

  G.rename = function (session, name) {
    if (!dbReady()) return dbFail();
    var s = session || {};
    if (!s.id) return Promise.reject(new Error('缺少会话信息'));
    var nextName = str(name).replace(/\s+/g, ' ').trim();
    if (!nextName) return Promise.reject(new Error('群聊名称不能为空'));

    var next = s;
    next.title = nextName;
    next.updatedAt = nowTs();
    return Promise.resolve(db().put('sessions', next)).then(function (saved) {
      var out = saved && saved.id ? saved : next;
      return syncGroup(out, { name: nextName }).then(function () { return out; });
    });
  };

  // 解散群聊：删消息 + 会话 + 群记录
  G.dissolve = function (session) {
    if (!dbReady()) return dbFail();
    var s = session || {};
    if (!s.id) return Promise.reject(new Error('缺少会话信息'));
    var D = db();
    var groupId = str(s.groupId);
    var msgP = (typeof D.byIndex === 'function')
      ? Promise.resolve(D.byIndex('messages', 'sessionId', s.id)).then(function (list) {
        var ids = (Array.isArray(list) ? list : []).map(function (m) { return m && m.id; }).filter(Boolean);
        if (!ids.length || typeof D.delMany !== 'function') return null;
        return D.delMany('messages', ids);
      }).catch(function () { return null; })
      : Promise.resolve(null);
    return msgP.then(function () {
      return D.del('sessions', s.id);
    }).then(function () {
      if (!groupId) return null;
      return D.del('groups', groupId).catch(function () { return null; });
    }).then(function () {
      return true;
    });
  };
})();
