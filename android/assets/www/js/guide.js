/* =========================================================================
   guide.js —— 内置引导助手核心（成员 D）
   · App.Guide.buildNextStepPrompt(ctx) → { system, user }   「下一步怎么走」提示词
   · App.Guide.parseNextStep(raw)      → { summary, steps } | null  严格 JSON 解析
   · App.Guide.handleAction(action)    → 执行 navigate / focus / tap
   · App.Guide.renderSteps(steps)      → 可点击步骤清单 DOM
   · App.Guide.buildHelpPrompt(ctx)    → 帮助抽屉的 system/user（功能清单+FAQ+错误表）
   · App.Guide.sanitizeContext(ctx)    → 只保留安全字段，绝不外泄 Key / 聊天正文
   纯逻辑 + 少量 DOM 操作，不读 DB、不写 DB；加载时只定义对象。
   ========================================================================= */
(function () {
  'use strict';
  var App = window.App = window.App || {};
  var G = App.Guide = {};

  function U() { return App.Util; }
  function UI() { return App.UI; }

  /* ======================================================================
     一、本 App 功能清单（system prompt 与帮助助手共用，保持单一事实来源）
     ====================================================================== */
  G.FEATURE_LIST = [
    '【App 概述】自带 API Key 的 AI 聊天 Android 客户端：用户自己配置 OpenAI 兼容接口，没有账号系统、没有自建后端，数据只存本机。',
    '',
    '【四个 Tab（底部固定）】',
    '· 聊天（chatList）：会话列表，首屏。右上角＋新建会话（选角色）；点会话进入聊天页。',
    '· 角色（characters）：角色列表，右上角＋新建角色；每项可开始聊天 / 编辑 / 删除。',
    '· API（apiList）：供应商列表，右上角＋添加 API；每项可测试连接 / 设为引导 API / 设为默认聊天 API / 编辑 / 删除。',
    '· 设置（settings）：主题、默认聊天 API、引导 API 概览、悬浮气泡开关与位置、数据导入导出、清空数据、使用帮助、关于。',
    '',
    '【二级页（压栈，左上角返回）】',
    '· 聊天页（chat）：消息列表 + 输入框，可停止生成、重新生成、复制、编辑、查看错误说明。',
    '· 创建角色（characterCreate）：5 步向导——①类型（陪聊/助手）②世界观 ③粗略填写 ④AI 补全 ⑤预览保存。',
    '· 世界观库（worldviews）：内置 7 个预设（现代都市/古代宫廷/校园日常/赛博朋克/ABO/斗破苍穹/无世界观），可复制自定义、可用引导 API 补全。',
    '· 使用帮助（help）：离线静态 FAQ，分类折叠 + 搜索。',
    '· 关于（about）：版本、隐私声明、开源组件、免责声明。',
    '',
    '【引导助手（帮助抽屉）】独立 help 会话，不进聊天列表；入口：向导每步右上「?」、设置页「使用帮助」、错误提示下方「这是什么意思？」、聊天空态快捷问题、悬浮气泡「问引导」。',
    '',
    '【悬浮引导气泡】应用内浮层（不申请系统悬浮窗权限）：52dp 小球默认右边缘；点击展开快捷项（怎么走/问引导/这啥意思/帮助），长按=怎么走，双击收起，可拖动吸附左右并记忆位置；设置页可关闭。',
    '',
    '【配置引导 API 的唯一路径】API 管理 → 点开某条供应商 → 「设为引导 API」。全 App 只有一条引导 API；未配置时角色 AI 补全与引导助手不可用。',
    '',
    '【错误提示】所有错误都会显示错误码与中文说明，下方有「这是什么意思？」入口。'
  ].join('\n');

  /* ======================================================================
     二、常见错误对照表（文本化，注入 prompt）
     ====================================================================== */
  G.ERROR_TABLE_TEXT = (function () {
    var t = App.Data && App.Data.ERROR_TABLE;
    if (!t) return '（错误码表缺失）';
    var order = (App.Data && App.Data.ERROR_CODES) || Object.keys(t);
    return order.map(function (code) {
      var e = t[code];
      if (!e) return '';
      return '· ' + e.code + ' ' + e.title + '：' + e.meaning + ' 处理：' + e.fix;
    }).filter(Boolean).join('\n');
  })();

  /* ======================================================================
     三、路由结构（navigate 目标白名单）
     ====================================================================== */
  // target → { kind: 'tab'|'page', name }；'/chat/:id' 单独处理
  G.ROUTE_MAP = {
    '/chat': { kind: 'tab', name: 'chatList', label: '聊天列表' },
    '/characters': { kind: 'tab', name: 'characters', label: '角色列表' },
    '/characters/create': { kind: 'page', name: 'characterCreate', label: '创建角色' },
    '/api': { kind: 'tab', name: 'apiList', label: 'API 管理' },
    '/settings': { kind: 'tab', name: 'settings', label: '设置' },
    '/worldviews': { kind: 'page', name: 'worldviews', label: '世界观库' },
    '/onboarding': { kind: 'page', name: 'onboarding', label: 'API 引导' },
    '/help': { kind: 'page', name: 'help', label: '使用帮助' },
    '/about': { kind: 'page', name: 'about', label: '关于' }
  };

  G.ROUTE_TEXT = [
    '/characters/create  创建角色（二级页）',
    '/characters         角色 Tab',
    '/chat               聊天 Tab（会话列表）',
    '/chat/:id           某个具体会话的聊天页（有会话 id 时才用）',
    '/api                API 管理 Tab',
    '/settings           设置 Tab',
    '/worldviews         世界观库（二级页）',
    '/onboarding         首次 API 引导（仅未配置引导 API 时）',
    '/help               离线使用帮助',
    '/about              关于页'
  ].join('\n');

  /* 页面 id → 中文名（帮助气泡 / 抽屉里显示用） */
  var PAGE_LABELS = {
    chatList: '聊天列表', characters: '角色列表', apiList: 'API 管理', settings: '设置',
    chat: '聊天页', characterCreate: '创建角色', characterEdit: '编辑角色', worldviews: '世界观库',
    onboarding: '首次引导', help: '使用帮助', about: '关于'
  };
  G.PAGE_LABELS = PAGE_LABELS;
  G.pageLabel = function (id) {
    if (!id) return '未知页面';
    return PAGE_LABELS[id] || String(id);
  };

  /* ======================================================================
     四、上下文净化：只允许白名单字段，屏蔽 Key / 聊天正文 / 设备标识
     ====================================================================== */
  var SECRET_PATTERNS = [
    /sk-[A-Za-z0-9_\-]{8,}/g,                    // OpenAI 风格 Key
    /(bearer\s+)[A-Za-z0-9._\-]{8,}/gi,          // Bearer token
    /(api[_\-\s]?key\s*[:=]\s*)[^\s,;，；]{6,}/gi, // api_key=xxx
    /(authorization\s*[:=]\s*)[^\s,;，；]{6,}/gi
  ];

  // 清掉潜在密钥，并截断过长文本
  G.sanitizeText = function (text, maxLen) {
    var s = String(text === undefined || text === null ? '' : text);
    SECRET_PATTERNS.forEach(function (re) { s = s.replace(re, function (m, p1) { return (p1 || '') + '[已隐藏]'; }); });
    var limit = maxLen || 400;
    if (s.length > limit) s = s.slice(0, limit) + '…';
    return s;
  };

  // 只取上下文契约里的安全字段：pageId/title/stage/totalSteps/filledFields/missingFields/error/tab
  // 说明：source/context/pageTitle 是内部枚举与展示用短字符串（不含用户 Key/聊天正文），
  // 保留它们是为了帮助抽屉能按入口复用会话、并在标题栏展示「来源 + 页面名」。
  G.sanitizeContext = function (ctx) {
    ctx = ctx || {};
    var out = { pageId: '', title: '', stage: '', totalSteps: 0, filledFields: {}, missingFields: [], error: null, tab: '' };
    if (ctx.pageId) out.pageId = G.sanitizeText(ctx.pageId, 40);
    if (ctx.pageName) out.pageId = out.pageId || G.sanitizeText(ctx.pageName, 40);
    if (ctx.title) out.title = G.sanitizeText(ctx.title, 60);
    if (ctx.pageTitle) out.pageTitle = G.sanitizeText(ctx.pageTitle, 40);
    if (ctx.source) out.source = G.sanitizeText(ctx.source, 32);
    if (ctx.context) out.context = G.sanitizeText(ctx.context, 32);
    if (ctx.stage !== undefined && ctx.stage !== null && ctx.stage !== '') out.stage = G.sanitizeText(ctx.stage, 60);
    if (typeof ctx.totalSteps === 'number') out.totalSteps = ctx.totalSteps;
    if (ctx.filledFields && typeof ctx.filledFields === 'object') {
      Object.keys(ctx.filledFields).slice(0, 20).forEach(function (k) {
        var safeKey = G.sanitizeText(k, 24);
        if (safeKey) out.filledFields[safeKey] = !!ctx.filledFields[k];
      });
    }
    if (Array.isArray(ctx.missingFields)) {
      out.missingFields = ctx.missingFields.slice(0, 20).map(function (x) { return G.sanitizeText(x, 24); }).filter(Boolean);
    }
    if (ctx.error) {
      var err = typeof ctx.error === 'string' ? { code: 'unknown', message: ctx.error } : ctx.error;
      var code = (App.Data && App.Data.normalizeErrorCode) ? App.Data.normalizeErrorCode(err.code) : String(err.code || 'unknown');
      out.error = { code: code, message: G.sanitizeText(err.message, 300) };
    }
    if (ctx.tab) out.tab = G.sanitizeText(ctx.tab, 24);
    return out;
  };

  // 把净化后的上下文转成给模型看的中文多行文本
  function contextLines(ctx) {
    var c = G.sanitizeContext(ctx);
    var lines = [];
    lines.push('当前页面：' + (c.title || G.pageLabel(c.pageId) || '未知页面') + '（pageId=' + (c.pageId || 'unknown') + '）');
    if (c.tab) lines.push('当前 Tab：' + G.pageLabel(c.tab));
    if (c.stage) lines.push('当前阶段：' + c.stage + (c.totalSteps ? ('（共 ' + c.totalSteps + ' 步）') : ''));
    var filled = Object.keys(c.filledFields).filter(function (k) { return c.filledFields[k]; });
    var empty = Object.keys(c.filledFields).filter(function (k) { return !c.filledFields[k]; });
    if (filled.length) lines.push('已填字段：' + filled.join('、'));
    if (empty.length) lines.push('未填字段：' + empty.join('、'));
    if (c.missingFields.length) lines.push('缺失/待补充字段：' + c.missingFields.join('、'));
    if (c.error) {
      var info = (App.Data && App.Data.errorInfo) ? App.Data.errorInfo(c.error.code) : { title: '', fix: '' };
      lines.push('当前错误：[' + c.error.code + '] ' + info.title + (c.error.message ? ('；原始信息（可能不完整）：' + c.error.message) : ''));
      if (info.fix) lines.push('错误处理建议：' + info.fix);
    }
    if (!c.stage && !c.error && !filled.length) lines.push('当前页面没有登记向导阶段或错误，请给出「在这个页面上最自然的下一个动作」。');
    return lines.join('\n');
  }

  // 供帮助抽屉直接复用：把上下文转成中文多行说明
  G.contextBrief = function (ctx) { return contextLines(ctx); };

  /* ======================================================================
     五、提示词构造
     ====================================================================== */
  G.NEXT_STEP_SCHEMA_SAMPLE = '{"summary":"一句话说清下一步","steps":[{"text":"点右上角＋新建角色","action":{"type":"navigate","target":"/characters/create"}}]}';

  function systemHeader() {
    return [
      '你是「AI 聊天」App 内置的引导助手，唯一职责是：告诉用户「在当前这个页面，下一步该做什么」。',
      '你了解这个 App 的全部功能和常见错误，但不是通用聊天助手，不谈无关话题。',
      '',
      '【本 App 功能清单】',
      G.FEATURE_LIST,
      '',
      '【常见错误对照表】',
      G.ERROR_TABLE_TEXT,
      '',
      '【页面路由结构（navigate 只允许用这些 target）】',
      G.ROUTE_TEXT
    ].join('\n');
  }

  function outputRules() {
    return [
      '',
      '【输出要求（必须严格遵守）】',
      '1. 只输出一个 JSON 对象，不要输出 Markdown 代码块、不要解释、不要多余文字。',
      '2. 格式：' + G.NEXT_STEP_SCHEMA_SAMPLE,
      '3. summary：一句中文，说清「现在该做什么」，不超过 40 个字。',
      '4. steps：1~3 条，按操作顺序排列；每条 text 是一句可照做的中文动作，不超过 30 个字。',
      '5. action.type 只能是 navigate / focus / tap 三者之一：',
      '   · navigate：跳转页面，target 必须是上面路由结构里的路径（如 /characters/create）。',
      '   · focus：把光标放到某个表单字段，target 用字段名（如 name / personality / habit / opening / worldview / baseUrl / apiKey / model）。',
      '   · tap：高亮用户需要自己点的按钮，target 用按钮含义（如 save / create / test / send / settings / back）。',
      '6. 不确定用哪个 action，就省略 action 只写 text；宁可不跳转，也不要猜测不存在的页面。',
      '7. 如果当前有错误：第一条步骤优先解决错误（如 401 → 去 API 管理检查 Key），不要建议无关操作。',
      '8. 若当前页面已经完成、没有下一步，summary 直说「这一步已经完成」，steps 可以给下一步的引导或留空数组。',
      '9. 用简体中文；不要编造 App 没有的按钮或功能。'
    ].join('\n');
  }

  // 「怎么走」：上下文 → 提示词
  G.buildNextStepPrompt = function (ctx) {
    var system = systemHeader() + outputRules();
    var user = [
      '【当前用户所处位置】',
      contextLines(ctx),
      '',
      '请根据上面的位置，给出接下来的操作步骤，并严格按要求输出 JSON。'
    ].join('\n');
    return { system: system, user: user };
  };

  // 帮助抽屉：system = 功能清单 + FAQ + 错误表；user = 用户问题 + 页面/报错上下文
  G.buildHelpPrompt = function (ctx, question) {
    var faqText = '';
    var faq = (App.Data && App.Data.FAQ) || [];
    faqText = faq.map(function (f, i) { return (i + 1) + '. ' + f.q + '\n答：' + f.a; }).join('\n');
    var system = [
      '你是「AI 聊天」App 内置的帮助助手（说明书 + 客服）。',
      '回答范围仅限：本 App 怎么用、API 怎么配置、错误码是什么意思怎么修、本 App 的数据与隐私。',
      '不要扮演角色、不要闲聊、不要编造 App 没有的功能；不确定时明确说「不确定」，并建议看「使用帮助」里的静态 FAQ。',
      '回答用简体中文，简洁、分点、可照做；涉及点击位置时写出界面名称。',
      '绝对不要索要或复述用户的 API Key；如果用户贴了 Key，提醒他删除并到服务商后台重置。',
      '',
      '【本 App 功能清单】',
      G.FEATURE_LIST,
      '',
      '【常见错误对照表】',
      G.ERROR_TABLE_TEXT,
      '',
      '【内置 FAQ（回答可参考，不要逐字照抄）】',
      faqText
    ].join('\n');
    var user = [
      contextLines(ctx),
      '',
      '【用户问题】',
      G.sanitizeText(question, 1200) || '（用户没有输入具体问题，请根据当前页面给出最可能需要帮助的说明）'
    ].join('\n');
    return { system: system, user: user };
  };

  /* ======================================================================
     六、严格 JSON 解析与校验
     ====================================================================== */
  G.ACTION_TYPES = ['navigate', 'focus', 'tap'];

  function normAction(raw) {
    if (!raw || typeof raw !== 'object') return null;
    var type = String(raw.type || '').trim().toLowerCase();
    if (G.ACTION_TYPES.indexOf(type) < 0) return null;
    var target = String(raw.target === undefined || raw.target === null ? '' : raw.target).trim();
    if (!target) return null;
    if (target.length > 120) target = target.slice(0, 120);
    return { type: type, target: target };
  }

  // raw → { summary, steps:[{text, action}] } ；解析失败返回 null
  G.parseNextStep = function (raw) {
    var data = null;
    try {
      var text = String(raw === undefined || raw === null ? '' : raw).trim();
      if (!text) return null;
      if (U() && U().parseJSONLoose) data = U().parseJSONLoose(text);
      if (!data) { try { data = JSON.parse(text); } catch (e) { data = null; } }
      if (!data || typeof data !== 'object') return null;

      // 兼容模型把结果再包一层的情况
      if (!data.steps && data.data && typeof data.data === 'object') data = data.data;

      var summary = String(data.summary === undefined || data.summary === null ? '' : data.summary).trim();
      var list = Array.isArray(data.steps) ? data.steps : (data.steps && typeof data.steps === 'object' ? [data.steps] : []);
      var steps = [];
      list.slice(0, 6).forEach(function (s) {
        if (steps.length >= 3) return;
        if (typeof s === 'string') {
          var t0 = s.trim();
          if (t0) steps.push({ text: t0, action: null });
          return;
        }
        if (!s || typeof s !== 'object') return;
        var txt = String(s.text || s.title || s.step || '').trim();
        if (!txt) return;
        steps.push({ text: txt.slice(0, 120), action: normAction(s.action) });
      });
      if (!steps.length && !summary) return null;
      if (!summary) summary = steps.length ? steps[0].text : '按下面的步骤继续操作';
      return { summary: summary.slice(0, 120), steps: steps, raw: String(raw) };
    } catch (e) {
      return null;
    }
  };

  /* ======================================================================
     七、动作执行
     ====================================================================== */
  /* ---------------- 目标定位 ----------------
     优先用页面显式标注的 data-guide-focus / data-guide-tap；
     没有标注时按「字段含义 → 常见 placeholder/标签文字」做启发式兜底，
     保证 AI 给出的 focus/tap 目标在未标注页面上也能落到正确控件。
     只在当前可见页面（.page 中 display 不为 none 的那个）范围内找，避免命中缓存 Tab。 */
  var FOCUS_HINTS = {
    baseurl: ['input[placeholder*="URL"]', 'input[placeholder*="url"]', 'input[placeholder*="接口"]', 'input[placeholder*="地址"]', 'input[type="url"]'],
    apikey: ['input[type="password"]', 'input[placeholder*="Key"]', 'input[placeholder*="key"]', 'input[placeholder*="密钥"]'],
    model: ['input[placeholder*="模型"]', 'input[placeholder*="model"]', 'input[placeholder*="Model"]'],
    name: ['input[placeholder*="名称"]', 'input[placeholder*="名字"]', 'input[placeholder*="角色名"]', 'input[placeholder*="会话名"]', 'input[placeholder*="预设"]'],
    personality: ['textarea[placeholder*="性格"]', 'input[placeholder*="性格"]'],
    habits: ['textarea[placeholder*="习惯"]', 'input[placeholder*="习惯"]'],
    opening: ['textarea[placeholder*="开场"]', 'textarea[placeholder*="第一句"]', 'input[placeholder*="开场"]'],
    worldview: ['input[placeholder*="世界观"]', 'textarea[placeholder*="世界观"]'],
    extra: ['textarea[placeholder*="补充"]', 'input[placeholder*="补充"]'],
    rawinput: ['textarea[placeholder*="描述"]', 'textarea[placeholder*="设定"]', 'textarea'],
    composer: ['.composer textarea', '.composer-input', '.composer input']
  };

  var TAP_TEXT = {
    save: ['保存', '完成', '确定'],
    create: ['新建', '创建', '添加', '＋', '+'],
    test: ['测试连接', '测试'],
    send: ['发送'],
    close: ['关闭', '取消'],
    help: ['帮助', '使用帮助'],
    guide: ['引导', '问引导'],
    settings: ['设置']
  };

  function visibleRoot() {
    var pages = document.querySelectorAll('#page-root .page');
    for (var i = pages.length - 1; i >= 0; i--) {
      var el = pages[i];
      if (el && el.offsetParent !== null) return el;
    }
    return document.body;
  }

  function byHint(root, list) {
    for (var i = 0; i < list.length; i++) {
      try {
        var el = root.querySelector(list[i]);
        if (el && el.offsetParent !== null) return el;
      } catch (e) { /* 选择器不合法就跳过 */ }
    }
    return null;
  }

  function pressable(el) {
    if (!el) return null;
    var n = el;
    for (var i = 0; i < 4 && n; i++) {
      if (n.tagName === 'BUTTON' || n.tagName === 'A' || n.getAttribute('role') === 'button' || (n.classList && n.classList.contains('btn'))) return n;
      n = n.parentElement;
    }
    return el;
  }

  function byText(root, texts) {
    var nodes = root.querySelectorAll('button, a, [role="button"], .btn, .cell, .sheet-item');
    for (var t = 0; t < texts.length; t++) {
      for (var i = 0; i < nodes.length; i++) {
        var n = nodes[i];
        if (!n.offsetParent) continue;
        var s = (n.innerText || n.textContent || '').replace(/\s+/g, '');
        if (s && s.indexOf(texts[t]) >= 0) return pressable(n);
      }
    }
    return null;
  }

  function findEl(attr, value) {
    var v = String(value || '').trim();
    if (!v) return null;
    try {
      var exact = document.querySelector('[' + attr + '="' + v.replace(/["\\]/g, '\\$&') + '"]');
      if (exact) return exact;
    } catch (e) { /* ignore */ }
    var root = visibleRoot();
    var key = v.toLowerCase().replace(/[\s_\-]/g, '');
    if (attr === 'data-guide-focus') {
      var list = FOCUS_HINTS[key] || FOCUS_HINTS[v.toLowerCase()];
      if (list) return byHint(root, list);
      // 最后兜底：placeholder / aria-label / name 包含该词
      var cand = root.querySelectorAll('input, textarea, select');
      for (var i = 0; i < cand.length; i++) {
        var c = cand[i];
        if (!c.offsetParent) continue;
        var hay = [c.getAttribute('placeholder'), c.getAttribute('aria-label'), c.getAttribute('name'), c.id].join(' ').toLowerCase();
        if (hay.indexOf(v.toLowerCase()) >= 0) return c;
      }
      return null;
    }
    var texts = TAP_TEXT[key] || TAP_TEXT[v.toLowerCase()] || [v];
    return byText(root, texts);
  }

  function flash(el, cls, ms) {
    if (!el || !el.classList) return;
    el.classList.remove(cls);
    /* 强制重排，让动画能重新触发 */
    void el.offsetWidth;
    el.classList.add(cls);
    setTimeout(function () { if (el && el.classList) el.classList.remove(cls); }, ms || 1600);
  }

  // '/chat/abc123' → { kind:'page', name:'chat', params:{id:'abc123'} }
  function resolveRoute(target) {
    var t = String(target || '').trim();
    if (!t) return null;
    if (t.charAt(0) !== '/') t = '/' + t;
    t = t.split('?')[0].split('#')[0].replace(/\/+$/, '') || '/';
    if (G.ROUTE_MAP[t]) return { kind: G.ROUTE_MAP[t].kind, name: G.ROUTE_MAP[t].name, params: {} };
    var m = t.match(/^\/chat\/([^/]+)$/);
    if (m) return { kind: 'page', name: 'chat', params: { id: decodeURIComponent(m[1]) } };
    return null;
  }
  G.resolveRoute = resolveRoute;

  function closeHelpIfOpen() {
    if (App.Help && typeof App.Help.isOpen === 'function' && App.Help.isOpen() && typeof App.Help.close === 'function') {
      try { App.Help.close(); } catch (e) {}
    }
  }

  /*
     执行一个 action；返回 { ok:boolean, message:string }
     navigate：跳转到已知页面；focus：聚焦并高亮字段；tap：高亮按钮并提示点击
  */
  G.handleAction = function (action) {
    try {
      if (!action || !action.type) return { ok: false, message: '没有可执行的动作' };
      var type = String(action.type).toLowerCase();
      var target = String(action.target || '').trim();

      if (type === 'navigate') {
        var route = resolveRoute(target);
        if (!route) {
          if (UI()) UI().toast('这个位置我还不认识，先按上面的文字操作吧', 'error');
          return { ok: false, message: '未知跳转目标：' + target };
        }
        var R = App.Router;
        if (!R) return { ok: false, message: '路由未就绪' };
        closeHelpIfOpen();
        var go = function () {
          try {
            if (route.kind === 'tab') { R.tab(route.name); return; }
            if (typeof R.push === 'function') {
              var ret = R.push(route.name, route.params);
              if (ret && typeof ret.catch === 'function') {
                ret.catch(function (e) {
                  if (UI()) UI().toast('页面暂时无法打开：' + ((e && e.message) || '未知原因'), 'error');
                });
              }
            }
          } catch (e) {
            if (UI()) UI().toast('跳转失败：' + (e && e.message ? e.message : e), 'error');
          }
        };
        if (App.Help && typeof App.Help.isOpen === 'function' && App.Help.isOpen()) setTimeout(go, 200);
        else go();
        return { ok: true, message: '正在打开' };
      }

      if (type === 'focus') {
        var el = findEl('data-guide-focus', target);
        if (!el) {
          if (UI()) UI().toast('这个页面上没找到「' + target + '」，按文字描述操作即可');
          return { ok: false, message: '未找到可聚焦字段：' + target };
        }
        try {
          if (typeof el.scrollIntoView === 'function') el.scrollIntoView({ block: 'center', behavior: 'smooth' });
        } catch (e) { try { el.scrollIntoView(); } catch (e2) {} }
        if (typeof el.focus === 'function') { try { el.focus({ preventScroll: true }); } catch (e) { try { el.focus(); } catch (e2) {} } }
        flash(el, 'guide-focus-flash', 1600);
        return { ok: true, message: '已定位到该字段' };
      }

      if (type === 'tap') {
        var node = findEl('data-guide-tap', target);
        if (!node) {
          if (UI()) UI().toast('没找到要点的按钮，按文字说明找一下「' + target + '」');
          return { ok: false, message: '未找到可点击项：' + target };
        }
        try {
          if (typeof node.scrollIntoView === 'function') node.scrollIntoView({ block: 'center', behavior: 'smooth' });
        } catch (e) {}
        flash(node, 'guide-highlight', 1800);
        if (UI()) UI().toast('已高亮，请点一下闪烁的位置');
        return { ok: true, message: '已高亮目标' };
      }

      return { ok: false, message: '不支持的动作类型：' + type };
    } catch (e) {
      console.error('[guide] handleAction 出错', e);
      if (UI()) UI().toast('操作没能完成：' + (e && e.message ? e.message : e), 'error');
      return { ok: false, message: '执行出错' };
    }
  };

  /* ======================================================================
     八、渲染可点击步骤清单
     ====================================================================== */
  G.renderSteps = function (steps) {
    var ui = UI();
    var wrap = ui.el('div', { class: 'guide-steps', attrs: { role: 'list' } });
    var list = Array.isArray(steps) ? steps.slice(0, 3) : [];
    if (!list.length) return wrap;
    list.forEach(function (step, i) {
      if (!step || !step.text) return;
      var hasAction = !!(step.action && step.action.type);
      var row = ui.el('button', {
        class: 'guide-step' + (hasAction ? ' actionable' : ' static'),
        type: 'button',
        attrs: { role: 'listitem', 'aria-label': '第 ' + (i + 1) + ' 步：' + step.text },
        on: {
          click: function (ev) {
            ev.preventDefault();
            if (hasAction) {
              var r = G.handleAction(step.action);
              if (r && r.ok) {
                row.classList.add('done');
                setTimeout(function () { row.classList.remove('done'); }, 900);
              }
            } else if (ui.toast) {
              ui.toast('按这一步的文字操作即可');
            }
          }
        }
      });
      row.appendChild(ui.el('span', { class: 'guide-step-idx', text: String(i + 1) }));
      row.appendChild(ui.el('span', { class: 'guide-step-text', text: step.text }));
      row.appendChild(ui.el('span', { class: 'guide-step-chev', html: hasAction ? ui.icon('chev', 16) : '' }));
      wrap.appendChild(row);
    });
    return wrap;
  };

  /* 纯文本降级用：把模型原始回答裁到一个合理长度（保留换行） */
  G.plainFallback = function (raw) {
    var t = String(raw === undefined || raw === null ? '' : raw).trim();
    if (!t) return '';
    if (t.length > 600) t = t.slice(0, 600) + '…';
    return t;
  };

  /* 供气泡/帮助抽屉快速取当前页上下文（只读 Router，不做净化以外的处理） */
  G.currentContext = function () {
    try {
      var cur = App.Router && App.Router.current ? App.Router.current() : null;
      if (!cur) return null;
      var ctx = (cur.entry && cur.entry.guideCtx) || (cur.page && cur.page.guideCtx) || null;
      return ctx || null;
    } catch (e) {
      return null;
    }
  };
})();
