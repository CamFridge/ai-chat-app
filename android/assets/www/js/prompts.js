/* ============================================================
 * prompts.js
 * 角色补全 / 世界观补全的提示词构造、JSON 解析与校验、system prompt 生成。
 * 加载时机：data/worldviews.js、data/presets.js 之后，页面之前。
 *
 * 设计要点（对应需求 §四.5）：
 * 1. 严格 JSON schema + 解析 + 校验；解析失败把错误回喂模型重试 1 次（最多 2 次请求）。
 * 2. 字段缺失时用用户原始输入填充，不编造用户没提供的事实。
 * 3. 生成 fieldOrigin（user / ai），供预览页标注。
 * 4. 单次调用超时 60s，失败不阻塞建角色（由页面降级到手动填写）。
 * ============================================================ */
(function () {
  'use strict';

  var App = window.App = window.App || {};
  var P = App.Prompts = App.Prompts || {};
  var U = App.Util;

  var TIMEOUT_MS = 60000; // 单次补全超时
  var MAX_ATTEMPTS = 2;   // 首次 + 解析失败重试 1 次（防止烧 token）

  P.TIMEOUT_MS = TIMEOUT_MS;
  P.MAX_ATTEMPTS = MAX_ATTEMPTS;

  /* ============================================================
   * 一、小工具：宽松取值 / 归一化
   * ============================================================ */
  function str(v) {
    if (v == null) return '';
    if (Array.isArray(v)) {
      return v.map(function (x) { return str(x); }).filter(Boolean).join('、');
    }
    if (typeof v === 'object') {
      return str(v.name || v.value || v.text || v.label || '');
    }
    return String(v).trim();
  }

  function arr(v) {
    if (v == null || v === '') return [];
    if (Array.isArray(v)) {
      var out = [];
      for (var i = 0; i < v.length; i++) {
        var s = str(v[i]);
        if (s) out.push(s);
      }
      return out;
    }
    return String(v).split(/[、,，;；\/\n]/).map(function (s) { return s.trim(); }).filter(Boolean);
  }

  function obj(v) {
    return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
  }

  // 只保留两个元素：{user, char}
  function normDialogues(v) {
    if (!Array.isArray(v)) return [];
    var out = [];
    v.forEach(function (d) {
      if (d == null) return;
      if (typeof d === 'string') {
        var t = str(d);
        if (t) out.push({ user: '', char: t });
        return;
      }
      var o = obj(d);
      var user = str(o.user != null ? o.user : (o.human || o.question || o.u || ''));
      var ch = str(o.char != null ? o.char
        : (o.character != null ? o.character : (o.assistant || o.ai || o.reply || o.answer || o.a || '')));
      if (user || ch) out.push({ user: user, char: ch });
    });
    return out.slice(0, 4);
  }

  // 去掉模型可能套的一层壳：{character:{...}} / {card:{...}} / {data:{...}}
  function unwrap(rawObj) {
    var cur = rawObj;
    for (var i = 0; i < 3; i++) {
      if (!cur || typeof cur !== 'object' || Array.isArray(cur)) return null;
      var hasCardShape = ('type' in cur) || ('character_type' in cur) || ('name' in cur) ||
        ('companion' in cur) || ('assistant' in cur) || ('personality' in cur) || ('domain' in cur);
      if (hasCardShape) return cur;
      var next = cur.character || cur.card || cur.characterCard || cur.result || cur.data || cur.output || null;
      if (!next || typeof next !== 'object') return cur;
      cur = next;
    }
    return cur;
  }

  function isFilled(v) {
    if (Array.isArray(v)) return v.length > 0;
    if (v && typeof v === 'object') {
      if (v.user !== undefined || v.char !== undefined) return !!(str(v.user) || str(v.char));
      return Object.keys(v).length > 0;
    }
    return !!String(v == null ? '' : v).trim();
  }

  /* ============================================================
   * 二、世界观文本 / 快照
   * ============================================================ */

  /**
   * 世界观摘要（注入提示词用，纯文本）。
   * @param {Object} wv {name, summary, details}
   * @returns {string}
   */
  P.worldviewText = function (wv) {
    if (!wv) return '';
    var d = obj(wv.details);
    var lines = [];
    if (wv.name) lines.push('名称：' + wv.name);
    if (wv.summary) lines.push('概述：' + wv.summary);
    var fields = App.Data.WORLDVIEW_FIELDS || [];
    fields.forEach(function (f) {
      var v = d[f.key];
      if (f.type === 'list') {
        var list = arr(v);
        if (list.length) lines.push(f.label + '：' + list.join('、'));
      } else {
        var s = str(v);
        if (s) lines.push(f.label + '：' + s);
      }
    });
    return lines.join('\n');
  };

  /**
   * 角色卡里保存的世界观快照（之后修改世界观不影响已有角色）。
   * 格式固定以「【名称】」开头，供列表/气泡解析名称。
   * @returns {string} 无世界观时返回 ''
   */
  P.worldviewSnapshotText = function (wv) {
    if (!wv || !wv.name || wv.name === '无世界观') return '';
    var d = obj(wv.details);
    var lines = ['【' + wv.name + '】' + (wv.summary ? ' ' + wv.summary : '')];
    var fields = App.Data.WORLDVIEW_FIELDS || [];
    fields.forEach(function (f) {
      var v = d[f.key];
      if (f.type === 'list') {
        var list = arr(v);
        if (list.length) lines.push(f.label + '：' + list.join('、'));
      } else {
        var s = str(v);
        if (s) lines.push(f.label + '：' + s);
      }
    });
    return lines.join('\n');
  };

  /* ============================================================
   * 三、schema 文本
   * ============================================================ */
  var CHARACTER_SCHEMA_COMMON = [
    '{',
    '  "type": "companion 或 assistant，与所选角色类型一致",',
    '  "name": "角色名称，必须使用用户提供的名称",',
    '  "avatarHint": "头像风格建议，一句话，不要生成图片",',
    '  "companion": {',
    '    "personality": "性格",',
    '    "habits": "习惯",',
    '    "background": "背景经历",',
    '    "speechStyle": "说话风格",',
    '    "catchphrases": "口头禅",',
    '    "scenario": "对话场景",',
    '    "firstMessage": "角色的开场白",',
    '    "exampleDialogues": [{ "user": "用户台词", "char": "角色台词" }]',
    '  },',
    '  "assistant": {',
    '    "domain": "领域名称",',
    '    "specialty": ["专业1", "专业2"],',
    '    "duties": ["职责1", "职责2"],',
    '    "answerStyle": "回答风格",',
    '    "knowledgeBoundary": "知识边界",',
    '    "refusalPolicy": "拒答策略",',
    '    "firstMessage": "助手的开场白"',
    '  },',
    '  "worldviewFit": "角色与所选世界观的契合点，一句话；无世界观时留空",',
    '  "fieldOrigin": { "字段名": "user 或 ai" }',
    '}'
  ].join('\n');

  P.CHARACTER_SCHEMA = CHARACTER_SCHEMA_COMMON;

  P.WORLDVIEW_SCHEMA = [
    '{',
    '  "name": "世界观名称",',
    '  "summary": "1~2 句概括",',
    '  "details": {',
    '    "era": "时代",',
    '    "place": "主要地点",',
    '    "rules": "这个世界特有的规则（力量体系/科技水平/社会制度）",',
    '    "society": "社会结构与势力",',
    '    "taboos": "禁忌与底线",',
    '    "elements": ["常用元素1", "常用元素2"],',
    '    "characterHints": "适合写什么样的角色"',
    '  },',
    '  "fieldOrigin": { "字段名": "user 或 ai" }',
    '}'
  ].join('\n');

  /* ============================================================
   * 四、提示词构造
   * ============================================================ */

  function typeLabel(type) {
    return type === 'assistant'
      ? '领域助手（assistant）——以专业问答为主，不扮演'
      : '陪聊角色（companion）——以角色扮演、陪伴闲聊为主';
  }

  // 角色类型对应的额外要求
  function typeRules(type) {
    if (type === 'assistant') {
      return [
        '【本类型额外要求】助手用于专业问答：',
        '1. companion 对象整体留空（"" 或 [] 或 {}）。',
        '2. domain 填领域名称，specialty 填 1~3 个具体专业方向。',
        '3. duties 写 3~5 条「能帮用户做什么」，具体可执行。',
        '4. answerStyle 写回答结构要求（例如：先结论、再分点、给步骤）。',
        '5. knowledgeBoundary 写清哪些情况需要说明不确定或建议咨询执业人士。',
        '6. refusalPolicy 写清什么情况下拒答或改为风险提醒。',
        '7. firstMessage 是助手欢迎提问的第一句话，专业、克制，不要用「扮演/性格/角色」这类词。'
      ].join('\n');
    }
    return [
      '【本类型额外要求】陪聊角色用于角色扮演：',
      '1. assistant 对象整体留空（"" 或 [] 或 {}）。',
      '2. personality 要有记忆点，不要写成「善良温柔乐于助人」这种空话。',
      '3. speechStyle 与 catchphrases 要能直接指导对话（句长、语气、称呼、口癖）。',
      '4. background 给出与用户可能产生交集的关系（例如：大学同学、楼下的店主）。',
      '5. firstMessage 要有画面感、主动抛出话题，不要写成客服欢迎语。'
    ].join('\n');
  }

  /**
   * 首次生成角色卡的提示词。
   * @param {Object} ctx {type, domain, specialty[], worldview, draft{name,personality,habits,extra}}
   * @returns {{system:string, user:string}}
   */
  P.characterCompletion = function (ctx) {
    ctx = ctx || {};
    var type = ctx.type === 'assistant' ? 'assistant' : 'companion';
    var draft = ctx.draft || {};

    var system = [
      '你是一名资深角色设定师。用户只会给出很少的信息，你要把它扩写成一张完整、自洽、能直接用于聊天机器人扮演的角色卡。',
      '',
      '【输出格式】只输出一个 JSON 对象，不要 Markdown 代码围栏，不要任何解释、前言或后记。字段必须与下面 schema 完全一致：',
      '',
      CHARACTER_SCHEMA_COMMON,
      '',
      '【硬性规则】',
      '1. 只输出 JSON 本身：第一个字符必须是 {，最后一个字符必须是 }。',
      '2. 用户没有提供的事实不要编造：不要虚构真实姓名、真实机构、真实地址、真实经历、具体年龄、具体病症。不确定的字段留空字符串 "" 或空数组 []。',
      '3. 用户明确填写的字段必须保留原意，可以润色表达，但不得改变含义；name 必须使用用户提供的名称，不要改写成更花哨的名字。',
      '4. 如果给出了世界观，角色的背景、场景、用词、称呼、开场白必须与这个世界观的规则、禁忌、常用元素一致；如果没有世界观，按现代日常处理，不要引入魔法、超能力或虚构组织。',
      '5. 角色类型是陪聊（companion）时只填 companion 对象；类型是助手（assistant）时只填 assistant 对象。',
      '6. 篇幅：personality 40~80 字；background 100~180 字；speechStyle 30~60 字；scenario 30~60 字；firstMessage 30~80 字；exampleDialogues 2~3 组，每组 user/char 各一句且贴合说话风格。',
      '7. 全部使用简体中文；自然、具体、有画面感，避免陈词滥调、网络烂梗和「作为一个 AI」之类的措辞。',
      '8. fieldOrigin 只列出你实际填了内容的字段，值只能是 "user"（用户已提供）或 "ai"（你补充）。',
      '',
      typeRules(type)
    ].join('\n');

    var userLines = [
      '【任务】根据用户提供的少量信息，补全一张角色卡。',
      '',
      '【角色类型】' + typeLabel(type)
    ];

    if (type === 'assistant') {
      var domParts = [];
      if (ctx.domain) domParts.push('领域：' + ctx.domain);
      if (ctx.specialty && ctx.specialty.length) domParts.push('专业：' + ctx.specialty.join('、'));
      userLines.push('【领域与专业】' + (domParts.length ? domParts.join('；') : '用户未指定，请根据名称与补充信息推断合适的领域与专业'));
    }

    if (ctx.worldview && ctx.worldview.name && ctx.worldview.name !== '无世界观') {
      userLines.push('');
      userLines.push('【世界观】以下设定的规则/禁忌/常用元素必须体现在角色身上：');
      userLines.push(P.worldviewText(ctx.worldview));
    } else {
      userLines.push('');
      userLines.push('【世界观】用户选择了「无世界观」：按现代日常处理，不要引入超自然设定、虚构组织或异世界背景。');
    }

    userLines.push('');
    userLines.push('【用户已提供的信息】');
    userLines.push('- 名称：' + (str(draft.name) || '（未提供，请根据补充信息推断）'));
    userLines.push('- 性格：' + (str(draft.personality) || '（未提供）'));
    userLines.push('- 习惯：' + (str(draft.habits) || '（未提供）'));
    userLines.push('- 其他补充：' + (str(draft.extra) || '（未提供）'));
    userLines.push('');
    userLines.push('请补全这张角色卡，并给出 worldviewFit 与 fieldOrigin。只输出 JSON。');

    return { system: system, user: userLines.join('\n') };
  };

  /**
   * 「让 AI 改」：在现有角色卡基础上按意见修改。
   * @param {Object} ctx {card, instruction, type}
   * @returns {{system:string, user:string}}
   */
  P.characterRewrite = function (ctx) {
    ctx = ctx || {};
    var card = ctx.card || {};
    var type = (ctx.type || card.type) === 'assistant' ? 'assistant' : 'companion';

    var system = [
      '你是一名资深角色设定师。用户会给你一张现有的角色卡和一条修改意见，你要按意见修改后输出完整的新角色卡。',
      '',
      '【输出格式】只输出修改后的完整角色卡 JSON，不要 Markdown 代码围栏，不要解释、不要列出改动点。字段与下面 schema 一致：',
      '',
      CHARACTER_SCHEMA_COMMON,
      '',
      '【硬性规则】',
      '1. 只输出 JSON 本身：第一个字符必须是 {，最后一个字符必须是 }。',
      '2. 严格按「修改意见」调整；意见没有提到的字段尽量保持原样，不要擅自增删世界观、身世、关系等设定。',
      '3. 修改后必须自洽：性格、说话风格、背景、开场白之间不能互相矛盾；有世界观时必须与该世界观一致。',
      '4. 必须输出完整角色卡（不是只输出改动字段）。',
      '5. 篇幅与字段规则同首次生成：personality 40~80 字，background 100~180 字，firstMessage 30~80 字，exampleDialogues 2~3 组。',
      '6. 用户没有提供的事实不要编造；不确定的字段留空。',
      '7. fieldOrigin 只列出你实际写了内容的字段，值 "user" 或 "ai"；未改动的字段可保留原值。',
      '',
      typeRules(type)
    ].join('\n');

    var cardJson = P.cardForModel(card);
    var userLines = [
      '【角色类型】' + typeLabel(type),
      '',
      '【现有角色卡】',
      '```json',
      JSON.stringify(cardJson, null, 2),
      '```',
      '',
      '【修改意见】' + (str(ctx.instruction) || '（未提供，请只做小幅润色）'),
      ''
    ];
    var snap = card.worldviewSnapshot || '';
    if (snap) {
      userLines.push('【当前世界观（必须保持一致）】');
      userLines.push(snap);
      userLines.push('');
    }
    userLines.push('请输出修改后的完整角色卡 JSON。');
    return { system: system, user: userLines.join('\n') };
  };

  /**
   * 世界观补全提示词。
   * @param {Object} ctx {name, rawInput}
   * @returns {{system:string, user:string}}
   */
  P.worldviewCompletion = function (ctx) {
    ctx = ctx || {};
    var system = [
      '你是一名世界观设定师。用户会给出一个世界观的名称和几句很粗略的描述，你要把它扩写成一套能直接用于角色扮演的完整设定。',
      '',
      '【输出格式】只输出一个 JSON 对象，不要 Markdown 代码围栏，不要任何解释。字段与下面 schema 完全一致：',
      '',
      P.WORLDVIEW_SCHEMA,
      '',
      '【硬性规则】',
      '1. 只输出 JSON 本身：第一个字符必须是 {，最后一个字符必须是 }。',
      '2. 用户给的名称必须保留；用户给的描述是设定基础，可以细化，但不能推翻。',
      '3. 不确定的字段留空字符串 "" 或空数组 []，不要编造与用户描述无关的现实事实。',
      '4. 不要引入真实国家、真实机构、真实人物；架空设定可以自创地名与势力名，但要与用户描述的方向一致。',
      '5. 篇幅：summary 40~80 字；rules 80~160 字；society 60~120 字；taboos 40~80 字；elements 4~8 个；characterHints 40~80 字。',
      '6. 全部使用简体中文，语气平实具体，避免空泛的形容词堆砌和「总之」「众所周知」这类套话。',
      '7. fieldOrigin 只列出你实际写了内容的字段，值 "user" 或 "ai"。'
    ].join('\n');

    var userLines = [
      '【世界观名称】' + (str(ctx.name) || '（未提供，请根据描述取一个简短名称）'),
      '',
      '【用户的粗略描述】',
      str(ctx.rawInput) || '（未提供，请按名称补全一套通用的设定）',
      '',
      '请补全这套世界观设定，只输出 JSON。'
    ];
    return { system: system, user: userLines.join('\n') };
  };

  /* ============================================================
   * 五、解析与校验
   * ============================================================ */

  /**
   * 解析角色补全结果。
   * @param {string} raw 模型原始输出
   * @param {Object} ctx {type, domain, specialty[], worldview, draft}
   * @returns {{ok:boolean, card:Object|null, error:string|null, raw:string}}
   */
  P.parseCharacter = function (raw, ctx) {
    ctx = ctx || {};
    var type = ctx.type === 'assistant' ? 'assistant' : 'companion';
    var draft = ctx.draft || {};

    if (raw == null || String(raw).trim() === '') {
      return { ok: false, card: null, error: '模型没有返回任何内容', raw: '' };
    }
    var data = U.parseJSONLoose(raw);
    if (!data) {
      return { ok: false, card: null, error: '返回内容不是合法的 JSON（可能被截断，或夹杂了 JSON 之外的文字）', raw: String(raw) };
    }
    data = unwrap(data);
    if (!data) {
      return { ok: false, card: null, error: '返回的 JSON 里没有找到角色卡对象', raw: String(raw) };
    }

    var c = obj(data.companion);
    var a = obj(data.assistant);
    var useFlat = !Object.keys(c).length && !Object.keys(a).length;
    if (useFlat) c = data;
    var cFlat = Object.keys(c).length ? c : data;
    var aFlat = Object.keys(a).length ? a : data;

    var name = str(data.name) || str(draft.name);
    if (!name) {
      return { ok: false, card: null, error: '缺少角色名称（name 字段为空）', raw: String(raw) };
    }

    var card = App.Data.blankCharacter(type);
    card.name = name;
    var meta = {};

    var firstMessage = str(cFlat.firstMessage || cFlat.first_message || aFlat.firstMessage ||
      aFlat.first_message || data.firstMessage || data.first_message);

    if (type === 'companion') {
      card.personality = str(cFlat.personality) || str(draft.personality);
      card.habits = str(cFlat.habits) || str(draft.habits);
      card.background = str(cFlat.background || cFlat.backstory);
      card.speechStyle = str(cFlat.speechStyle || cFlat.speech_style);
      card.catchphrases = str(cFlat.catchphrases || cFlat.catch_phrases || cFlat.catchphrase);
      card.scenario = str(cFlat.scenario);
      card.firstMessage = firstMessage;
      card.exampleDialogues = normDialogues(cFlat.exampleDialogues || cFlat.example_dialogues || cFlat.dialogues);
      if (!card.personality && !card.background && !card.scenario && !card.firstMessage) {
        return {
          ok: false, card: null,
          error: '返回内容里没有可用的角色设定（性格 / 背景 / 场景 / 开场白都为空）',
          raw: String(raw)
        };
      }
    } else {
      card.domain = str(aFlat.domain) || str(ctx.domain) || str(data.domain);
      var spec = arr(aFlat.specialty || aFlat.specialities || aFlat.specialty_list);
      if (!spec.length) spec = arr(ctx.specialty);
      if (!spec.length && card.domain) spec = [card.domain];
      card.specialty = spec;
      card.duties = arr(aFlat.duties || aFlat.responsibilities);
      card.answerStyle = str(aFlat.answerStyle || aFlat.answer_style);
      card.knowledgeBoundary = str(aFlat.knowledgeBoundary || aFlat.knowledge_boundary);
      card.refusalPolicy = str(aFlat.refusalPolicy || aFlat.refusal_policy);
      card.firstMessage = firstMessage;
      if (!card.domain && !card.duties.length && !card.firstMessage) {
        return {
          ok: false, card: null,
          error: '返回内容里没有可用的助手设定（领域 / 职责 / 开场白都为空）',
          raw: String(raw)
        };
      }
    }

    // 世界观：落到角色上的是快照文本，之后修改世界观不影响已有角色
    if (ctx.worldview && ctx.worldview.name && ctx.worldview.name !== '无世界观') {
      card.worldviewId = ctx.worldview.id || '';
      card.worldviewSnapshot = P.worldviewSnapshotText(ctx.worldview);
    }

    meta.avatarHint = str(data.avatarHint || data.avatar_hint);
    meta.worldviewFit = str(data.worldviewFit || data.worldview_fit);
    if (str(draft.extra)) meta.extra = str(draft.extra);
    card.draft = meta;

    // fieldOrigin：用户填过的字段记为 user，其余有内容的是 ai
    var userFilled = {
      name: !!str(draft.name),
      personality: !!str(draft.personality),
      habits: !!str(draft.habits),
      domain: !!str(ctx.domain),
      specialty: !!(ctx.specialty && ctx.specialty.length),
      worldviewId: !!(ctx.worldview && ctx.worldview.id && ctx.worldview.name !== '无世界观')
    };
    var originKeys = type === 'companion'
      ? ['name', 'personality', 'habits', 'background', 'speechStyle', 'catchphrases', 'scenario', 'firstMessage', 'exampleDialogues', 'worldviewId']
      : ['name', 'domain', 'specialty', 'duties', 'answerStyle', 'knowledgeBoundary', 'refusalPolicy', 'firstMessage', 'worldviewId'];
    var origin = {};
    originKeys.forEach(function (k) {
      if (!isFilled(card[k])) return;
      origin[k] = userFilled[k] ? 'user' : 'ai';
    });
    card.fieldOrigin = origin;

    // 生成 system prompt（保存时可直接用；编辑后页面会重建）
    card.systemPrompt = P.buildSystemPrompt(card);

    return { ok: true, card: card, error: null, raw: String(raw) };
  };

  /**
   * 解析世界观补全结果。
   * @param {string} raw
   * @param {Object} ctx {name, rawInput}
   * @returns {{ok:boolean, worldview:Object|null, error:string|null, raw:string}}
   */
  P.parseWorldview = function (raw, ctx) {
    ctx = ctx || {};
    if (raw == null || String(raw).trim() === '') {
      return { ok: false, worldview: null, error: '模型没有返回任何内容', raw: '' };
    }
    var data = U.parseJSONLoose(raw);
    if (!data) {
      return { ok: false, worldview: null, error: '返回内容不是合法的 JSON（可能被截断，或夹杂了 JSON 之外的文字）', raw: String(raw) };
    }
    if (Array.isArray(data)) data = data[0];
    if (data && typeof data === 'object' && data.worldview && typeof data.worldview === 'object') {
      data = data.worldview;
    }
    if (!data || typeof data !== 'object') {
      return { ok: false, worldview: null, error: '返回的 JSON 里没有世界观对象', raw: String(raw) };
    }

    var modelName = str(data.name);
    var name = modelName || str(ctx.name);
    if (!name) {
      return { ok: false, worldview: null, error: '缺少世界观名称（name 字段为空）', raw: String(raw) };
    }

    var d = obj(data.details);
    var details = {
      era: str(d.era),
      place: str(d.place),
      rules: str(d.rules || d.rule),
      society: str(d.society || d.social),
      taboos: str(d.taboos || d.taboo),
      elements: arr(d.elements || d.elements_list),
      characterHints: str(d.characterHints || d.character_hints || d.characterHint)
    };

    var summary = str(data.summary);
    var hasDetail = !!(details.era || details.place || details.rules || details.society ||
      details.taboos || details.characterHints || details.elements.length);
    if (!summary && !hasDetail) {
      return { ok: false, worldview: null, error: '返回内容缺少世界观设定（summary 与 details 都为空）', raw: String(raw) };
    }
    if (!summary) {
      summary = U.truncate([details.era, details.place, details.rules].filter(Boolean).join(' · '), 60);
    }

    var fieldOrigin = { name: modelName ? 'ai' : 'user', summary: 'ai' };
    ['era', 'place', 'rules', 'society', 'taboos', 'characterHints'].forEach(function (k) {
      if (details[k]) fieldOrigin[k] = 'ai';
    });
    if (details.elements.length) fieldOrigin.elements = 'ai';

    var wv = {
      name: name,
      summary: summary,
      details: details,
      fieldOrigin: fieldOrigin,
      rawInput: str(ctx.rawInput)
    };
    return { ok: true, worldview: wv, error: null, raw: String(raw) };
  };

  /* ============================================================
   * 六、system prompt 生成
   * ============================================================ */

  /**
   * 陪聊角色的 system prompt。
   * @param {Object} card 角色卡
   * @param {string} [worldviewSnapshot] 世界观快照（缺省用 card.worldviewSnapshot）
   */
  P.companionSystemPrompt = function (card, worldviewSnapshot) {
    card = card || {};
    var name = str(card.name) || '角色';
    var snap = worldviewSnapshot == null || worldviewSnapshot === '' ? (card.worldviewSnapshot || '') : String(worldviewSnapshot);

    var lines = [];
    lines.push('你现在扮演「' + name + '」。');
    lines.push('');
    lines.push('【角色设定】');
    if (card.personality) lines.push('性格：' + card.personality);
    if (card.habits) lines.push('习惯：' + card.habits);
    if (card.background) lines.push('背景：' + card.background);
    if (card.speechStyle) lines.push('说话风格：' + card.speechStyle);
    if (card.catchphrases) lines.push('口头禅：' + card.catchphrases);
    if (card.scenario) lines.push('场景：' + card.scenario);
    if (card.exampleDialogues && card.exampleDialogues.length) {
      lines.push('示例对话：');
      card.exampleDialogues.forEach(function (d) {
        if (!d) return;
        lines.push('- 用户：' + (d.user || '……'));
        lines.push('- ' + name + '：' + (d.char || '……'));
      });
    }
    if (!card.personality && !card.background && !card.speechStyle) {
      lines.push('（设定较少，请用自然、有生活气息的口吻扮演，性格可以从名字与开场白推断。）');
    }

    if (snap) {
      lines.push('');
      lines.push('【世界观】');
      lines.push(snap);
      lines.push('你的用词、称呼、常识与生活细节都要符合这个世界观；不要提到自己是 AI，也不要提及现实世界之外的设定。');
    }

    lines.push('');
    lines.push('【扮演规则】');
    lines.push('1. 始终保持「' + name + '」的第一人称视角，用角色的口吻说话；绝对不要说「作为一个 AI」「我是语言模型」之类的话。');
    lines.push('2. 保持性格、经历、说话风格（包括口头禅）前后一致，不要突然变得不像自己。');
    lines.push('3. 回复以对话为主，自然、生活化，通常 1~5 句；需要时可用少量括号动作描写，但不要写成小说旁白或长篇独白。');
    lines.push('4. 主动推进对话：回应对方的情绪，适当追问或分享自己的事，不要只做机械的短回答。');
    lines.push('5. 不要替用户说话；不要总结「我们刚才聊了什么」；不要输出分析、建议列表或旁白式的心理描写（除非角色本身就会这样说话）。');
    lines.push('6. 不编造用户没提过的现实事实（真实姓名、机构、住址等）；角色不知道的事可以说不知道，或以角色视角猜测。');
    if (card.firstMessage) {
      lines.push('7. 开场白约束：对话的第一条消息应由你说出「' + card.firstMessage + '」；之后不要重复这句开场白。');
    } else {
      lines.push('7. 开场白约束：用一句符合角色性格的话自然开启对话，不要做自我介绍式的大段开场。');
    }
    lines.push('8. 只有用户明确表示「退出扮演 / 结束角色」时，才以角色口吻温和收尾。');
    return lines.join('\n');
  };

  // 按领域给出免责声明（医疗 / 法律 / 金融）
  function disclaimerFor(domain, specialty) {
    var all = String(domain || '') + ' ' + (specialty || []).join(' ');
    if (/医疗|健康|医药|药理|病|中医|营养|心理|科室|内科|外科/.test(all)) {
      return '涉及医疗健康内容时：你的回答只是健康信息参考，不能替代医生面诊、检查与处方；出现急症或持续不适请立即就医。';
    }
    if (/法律|诉讼|辩护|合同|劳动|知识产权|婚姻|合规|民商|刑事/.test(all)) {
      return '涉及法律事务时：你的回答只是法律信息参考，不构成法律意见，也不能替代执业律师；具体案件请咨询当地律师或法律援助机构。';
    }
    if (/金融|投资|理财|股票|基金|保险|财务|会计|融资/.test(all)) {
      return '涉及投资理财内容时：你的回答只是信息整理，不构成投资建议；市场有风险，决策前请自行核实信息。';
    }
    return '';
  }

  /**
   * 助手角色的 system prompt。
   * @param {Object} card
   */
  P.assistantSystemPrompt = function (card) {
    card = card || {};
    var domain = str(card.domain) || '通用';
    var spec = (card.specialty || []).filter(Boolean);
    var lines = [];
    lines.push('你是' + domain + '领域的资深专家' + (spec.length ? '，专精' + spec.join('、') + '。' : '。'));
    lines.push('');
    lines.push('【职责】');
    var duties = (card.duties || []).filter(Boolean);
    if (duties.length) {
      duties.forEach(function (d) { lines.push('- ' + d); });
    } else {
      lines.push('- 解答用户在该领域的具体问题，给出可执行的建议');
      lines.push('- 指出常见误区与风险，必要时说明还需要补充哪些信息');
    }
    lines.push('');
    lines.push('【回答要求】');
    lines.push('1. 先给结论，再给解释；多个要点时分点列出，需要操作时给出具体步骤与顺序。');
    lines.push('2. 使用准确的专业术语，但要用用户能听懂的方式解释；不确定的内容明确说明「不确定 / 需要核实」，不要编造条文、数据、剂量或价格。');
    lines.push('3. 信息不足时先问清关键条件（对象、时间、地点、已有材料等），再给建议。');
    lines.push('4. 涉及中国法律、政策、医疗规范时，以现行有效的通用规则为准，并提醒可能存在地区差异。');
    if (card.answerStyle) lines.push('5. 回答风格：' + card.answerStyle);
    if (card.knowledgeBoundary) lines.push('6. 知识边界：' + card.knowledgeBoundary);
    if (card.refusalPolicy) lines.push('7. 拒答策略：' + card.refusalPolicy);
    lines.push('');
    lines.push('【禁止】');
    lines.push('- 不要以角色口吻说话、不要卖萌、不要使用网络流行语与颜文字；不要输出与专业问题无关的闲聊。');
    lines.push('- 不要说「本助手会一直陪着你」这类陪伴式话术；不要虚构判例、法条编号、药品剂量或投资收益率。');
    lines.push('- 不要替用户做最终决定，而是给出条件、选项与风险。');
    var disc = disclaimerFor(domain, spec);
    if (disc) {
      lines.push('');
      lines.push('【免责声明】' + disc);
    }
    return lines.join('\n');
  };

  /**
   * 按类型自动选择 system prompt。
   */
  P.buildSystemPrompt = function (card) {
    if (!card) return '';
    if (card.type === 'assistant') return P.assistantSystemPrompt(card);
    return P.companionSystemPrompt(card, card.worldviewSnapshot);
  };

  /* ============================================================
   * 七、高层调用（含重试 / 超时）
   * ============================================================ */

  // 模型可读的角色卡（用于改稿请求，去掉 id / 时间戳等内部字段）
  P.cardForModel = function (card) {
    card = card || {};
    var type = card.type === 'assistant' ? 'assistant' : 'companion';
    var draft = card.draft || {};
    var out = {
      type: type,
      name: card.name || '',
      avatarHint: draft.avatarHint || '',
      companion: {},
      assistant: {},
      worldviewFit: draft.worldviewFit || '',
      fieldOrigin: card.fieldOrigin || {}
    };
    if (type === 'companion') {
      out.companion = {
        personality: card.personality || '',
        habits: card.habits || '',
        background: card.background || '',
        speechStyle: card.speechStyle || '',
        catchphrases: card.catchphrases || '',
        scenario: card.scenario || '',
        firstMessage: card.firstMessage || '',
        exampleDialogues: (card.exampleDialogues || []).map(function (d) {
          return { user: (d && d.user) || '', char: (d && d.char) || '' };
        })
      };
    } else {
      out.assistant = {
        domain: card.domain || '',
        specialty: (card.specialty || []).slice(),
        duties: (card.duties || []).slice(),
        answerStyle: card.answerStyle || '',
        knowledgeBoundary: card.knowledgeBoundary || '',
        refusalPolicy: card.refusalPolicy || '',
        firstMessage: card.firstMessage || ''
      };
    }
    return out;
  };

  function canStream() {
    return !!(App.API && typeof App.API.chatStream === 'function');
  }

  // 当前在跑的流式补全句柄（仅允许一个，用于「停止生成」）
  var activeStream = null;

  /** 停止当前流式补全（角色/世界观补全界面用）。 */
  P.cancelCompletion = function () {
    var h = activeStream;
    activeStream = null;
    if (h && typeof h.abort === 'function') {
      try { h.abort(); } catch (e) { /* 忽略 */ }
    }
    return !!h;
  };

  P.isStreaming = function () { return !!activeStream; };

  /**
   * 单次调用，统一返回 {ok, text, error}。
   * opts.stream === true 且 opts.onDelta 为函数时走流式：
   *   onDelta(accumulatedText, piece) 每次增量后回调，界面可实时显示生成内容。
   */
  function callCompletion(opts, system, user) {
    if (!opts || !opts.provider) {
      return Promise.resolve({ ok: false, text: '', error: { code: 'noprovider', message: '还没有可用的 API，请先到「API 管理」添加一个' } });
    }
    var onDelta = opts.onDelta;
    var stream = !!(opts.stream && typeof onDelta === 'function' && canStream());

    if (stream) {
      var messages = [
        { role: 'system', content: String(system || '') },
        { role: 'user', content: String(user || '') }
      ];
      return new Promise(function (resolve) {
        var acc = '';
        var finished = false;
        var handle = null;
        handle = App.API.chatStream({
          provider: opts.provider,
          model: opts.model,
          messages: messages,
          params: { temperature: 0.7, max_tokens: opts.maxTokens || 1600 },
          timeoutMs: opts.timeoutMs || TIMEOUT_MS,
          onDelta: function (piece) {
            // 防御：只接受字符串增量，避免 null / undefined 进入正文
            if (typeof piece !== 'string' || !piece) return;
            acc += piece;
            try { onDelta(acc, piece); } catch (e) { /* 界面回调异常不影响流程 */ }
          },
          onDone: function (r) {
            if (finished) return;
            finished = true;
            if (activeStream === handle) activeStream = null;
            var text = (r && typeof r.text === 'string' && r.text.length) ? r.text : acc;
            resolve({ ok: true, text: text, usage: (r && r.usage) || null, error: null });
          },
          onError: function (err) {
            if (finished) return;
            finished = true;
            if (activeStream === handle) activeStream = null;
            resolve({
              ok: false,
              text: acc,
              usage: null,
              error: err || { code: 'unknown', message: '调用失败' }
            });
          }
        });
        activeStream = handle;
      });
    }

    if (!App.API || typeof App.API.completion !== 'function') {
      return Promise.resolve({ ok: false, text: '', error: { code: 'unknown', message: '补全功能不可用（App.API.completion 缺失）' } });
    }
    return App.API.completion({
      provider: opts.provider,
      model: opts.model,
      system: system,
      user: user,
      params: { temperature: 0.7, max_tokens: opts.maxTokens || 1600 },
      timeoutMs: opts.timeoutMs || TIMEOUT_MS
    }).then(function (r) {
      if (!r) return { ok: false, text: '', error: { code: 'unknown', message: 'API 没有返回结果' } };
      if (r.ok) return { ok: true, text: String(r.text || ''), usage: r.usage || null, error: null };
      return { ok: false, text: '', error: r.error || { code: 'unknown', message: '调用失败' } };
    }).catch(function (e) {
      return { ok: false, text: '', error: { code: (e && e.code) || 'unknown', message: (e && e.message) || '调用异常' } };
    });
  }

  /**
   * 调用 + 解析 + 失败重试（仅解析失败重试，网络/鉴权错误不重试，避免烧 token）。
   * @returns {Promise<{ok, data?, card?, worldview?, raw, attempts, error?}>}
   */
  function runWithRetry(opts) {
    var prompt = opts.prompt;
    var userText = prompt.user;
    var lastRaw = '';
    var lastError = '返回格式不正确';

    function attempt(n) {
      if (typeof opts.onAttempt === 'function') {
        try { opts.onAttempt(n); } catch (e) { /* 忽略回调异常 */ }
      }
      return callCompletion(opts, prompt.system, userText).then(function (res) {
        if (!res.ok) {
          return { ok: false, card: null, worldview: null, data: null, raw: res.text || '', attempts: n, error: res.error };
        }
        lastRaw = res.text;
        var parsed = opts.parse(res.text, opts.ctx);
        if (parsed.ok) {
          return {
            ok: true,
            data: parsed.card || parsed.worldview,
            card: parsed.card || null,
            worldview: parsed.worldview || null,
            raw: res.text,
            attempts: n,
            error: null
          };
        }
        lastError = parsed.error || '返回格式不正确';
        if (n >= MAX_ATTEMPTS) {
          return {
            ok: false, card: null, worldview: null, data: null,
            raw: lastRaw, attempts: n,
            error: { code: 'parse', message: lastError, parseFailed: true }
          };
        }
        // 把解析错误回喂模型，再试一次
        userText = prompt.user + '\n\n【上次输出未通过校验】' + lastError +
          '\n请重新只输出一个符合 schema 的 JSON 对象：第一个字符是 {，最后一个字符是 }，不要任何解释或代码围栏。';
        return attempt(n + 1);
      });
    }

    return attempt(1);
  }

  /**
   * 首次生成角色卡。
   * @param {Object} opts {type, domain, specialty, worldview, draft, provider, model, timeoutMs, onAttempt}
   */
  P.completeCharacter = function (opts) {
    opts = opts || {};
    var ctx = {
      type: opts.type === 'assistant' ? 'assistant' : 'companion',
      domain: opts.domain || '',
      specialty: Array.isArray(opts.specialty) ? opts.specialty.slice() : arr(opts.specialty),
      worldview: opts.worldview || null,
      draft: opts.draft || {}
    };
    return runWithRetry({
      prompt: P.characterCompletion(ctx),
      ctx: ctx,
      parse: P.parseCharacter,
      provider: opts.provider,
      model: opts.model,
      maxTokens: opts.maxTokens || 1600,
      timeoutMs: opts.timeoutMs || TIMEOUT_MS,
      onAttempt: opts.onAttempt,
      stream: !!opts.onDelta,
      onDelta: opts.onDelta
    });
  };

  /**
   * 「让 AI 改」：按意见修改现有角色卡。
   * @param {Object} opts {card, instruction, provider, model, timeoutMs, onAttempt}
   */
  P.rewriteCharacter = function (opts) {
    opts = opts || {};
    var card = opts.card || {};
    var type = card.type === 'assistant' ? 'assistant' : 'companion';
    var ctx = {
      type: type,
      domain: card.domain || '',
      specialty: (card.specialty || []).slice(),
      worldview: null,
      draft: {
        name: card.name || '',
        personality: card.personality || '',
        habits: card.habits || ''
      }
    };
    return runWithRetry({
      prompt: P.characterRewrite({ card: card, instruction: opts.instruction, type: type }),
      ctx: ctx,
      parse: P.parseCharacter,
      provider: opts.provider,
      model: opts.model,
      maxTokens: opts.maxTokens || 2000,
      timeoutMs: opts.timeoutMs || TIMEOUT_MS,
      onAttempt: opts.onAttempt
    }).then(function (r) {
      if (!r.ok || !r.card) return r;
      var after = r.card;
      // 保留原卡的世界观、头像与草稿元信息
      after.worldviewId = card.worldviewId || '';
      after.worldviewSnapshot = card.worldviewSnapshot || '';
      after.avatar = card.avatar || '';
      after.draft = Object.assign({}, card.draft || {}, after.draft || {});
      // fieldOrigin：与上一版相同的字段保留原来源，改动过的标记为 ai
      var origin = Object.assign({}, card.fieldOrigin || {});
      var keys = ['name', 'personality', 'habits', 'background', 'speechStyle', 'catchphrases',
        'scenario', 'firstMessage', 'exampleDialogues', 'domain', 'specialty', 'duties',
        'answerStyle', 'knowledgeBoundary', 'refusalPolicy'];
      keys.forEach(function (k) {
        if (!isFilled(after[k])) { delete origin[k]; return; }
        var before = JSON.stringify(card[k] === undefined ? null : card[k]);
        var now = JSON.stringify(after[k] === undefined ? null : after[k]);
        if (before !== now) origin[k] = 'ai';
        else if (!origin[k]) origin[k] = 'ai';
      });
      after.fieldOrigin = origin;
      after.systemPrompt = P.buildSystemPrompt(after);
      r.card = after;
      r.data = after;
      return r;
    });
  };

  /**
   * 世界观补全。
   * @param {Object} opts {name, rawInput, provider, model, timeoutMs, onAttempt}
   */
  P.completeWorldview = function (opts) {
    opts = opts || {};
    var ctx = { name: opts.name || '', rawInput: opts.rawInput || '' };
    return runWithRetry({
      prompt: P.worldviewCompletion(ctx),
      ctx: ctx,
      parse: P.parseWorldview,
      provider: opts.provider,
      model: opts.model,
      maxTokens: opts.maxTokens || 1400,
      timeoutMs: opts.timeoutMs || TIMEOUT_MS,
      onAttempt: opts.onAttempt,
      stream: !!opts.onDelta,
      onDelta: opts.onDelta
    });
  };
})();
