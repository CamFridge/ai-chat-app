/* ============================================================
 * data/worldviews.js
 * 内置世界观 / 领域 / 类型等静态数据，以及角色模块共用的 App.CharKit。
 * 加载时机：index.html 中紧跟 ui.js / api.js 之后、所有页面之前。
 * 约定：本文件只定义数据与工具函数，模块加载时不读写 DB、不操作 DOM，
 *       所有 DOM/DB 操作都发生在页面调用时。
 * ============================================================ */
(function () {
  'use strict';

  var App = window.App = window.App || {};
  App.Data = App.Data || {};

  /* ============================================================
   * 一、7 个内置世界观（恰好 7 个，只读 preset）
   * 字段：id / name / summary / details{era,place,rules,society,taboos,elements[],characterHints}
   * ============================================================ */
  App.Data.WORLDVIEW_PRESETS = [
    {
      id: 'wv-modern',
      name: '现代都市',
      summary: '高楼、地铁、便利店与加班夜归的当下世界，人际关系与生活压力才是主要张力。',
      isBuiltin: true,
      source: 'preset',
      details: {
        era: '当代（近十几年内），智能手机与移动互联网普及。',
        place: '一线/新一线城市：写字楼、老小区、地铁、便利店、深夜食堂。',
        rules: '没有超自然力量，一切事件遵循现实物理与社会规则；钱、时间、关系是硬约束。',
        society: '以职场与家庭为基本单位，社交依赖微信式即时通讯，圈层与人情并行。',
        taboos: '当众越界打探隐私、欠钱不还、职场性骚扰、背叛信任。',
        elements: ['地铁通勤', '加班', '外卖', '租房', '同学群', '相亲', '便利店'],
        characterHints: '可以写成同事、房东、隔壁邻居、外卖骑手、老同学；说话生活化，有具体的职业和作息。'
      }
    },
    {
      id: 'wv-palace',
      name: '古代宫廷',
      summary: '宫墙之内礼法森严，一句话可以升人也可以杀人，情爱与权谋都在规矩的缝隙里生长。',
      isBuiltin: true,
      source: 'preset',
      details: {
        era: '架空王朝（类唐宋明的东方古代），皇权至上。',
        place: '皇城、后宫、王府、朝堂、御花园、冷宫。',
        rules: '尊卑礼法高于一切：称呼、行礼、服制、座次皆有定例；后宫不得干政；私通、巫蛊、僭越是死罪。',
        society: '皇帝—后妃—宗室—朝臣—内侍宫女构成层级；家族荣辱与位分绑定，联姻是政治手段。',
        taboos: '直呼上位者名讳、僭越服制、私相授受、巫蛊诅咒、后宫私通。',
        elements: ['请安', '位分', '圣旨', '宫宴', '御膳', '暗卫', '冷宫', '密信', '赏赐'],
        characterHints: '可设为不受宠的妃嫔、权臣之女、贴身宫女、少年帝王或冷面侍卫；说话讲究敬辞与分寸，忌用现代词。'
      }
    },
    {
      id: 'wv-campus',
      name: '校园日常',
      summary: '教室、操场、晚自习与食堂，青春里最重要的事往往只是同桌的一句话。',
      isBuiltin: true,
      source: 'preset',
      details: {
        era: '当代中学／大学在读期间。',
        place: '教室、走廊、操场、图书馆、食堂、宿舍、校门口小卖部。',
        rules: '校园作息与考试制度主导节奏；学生身份有明确边界（不得越级、不得违反校规）；没有超能力，青春期情绪是主要冲突源。',
        society: '班级是基本单位，社团、宿舍、同桌构成小圈层；老师与家长是权威角色。',
        taboos: '早恋被公开、作弊、霸凌、翻看别人日记或手机。',
        elements: ['晚自习', '运动会', '值日', '错题本', '广播站', '小纸条', '社团招新', '高考'],
        characterHints: '可写成学委、同桌、校队主力、转学生；说话有校园口头禅，情绪直接但不过分成熟。'
      }
    },
    {
      id: 'wv-cyberpunk',
      name: '赛博朋克',
      summary: '霓虹与酸雨浸泡的巨型都市，义体与数据比人命值钱，大公司代替了政府。',
      isBuiltin: true,
      source: 'preset',
      details: {
        era: '近未来（21 世纪末），高度技术化、低生活质量。',
        place: '垂直分层的超级城市：上层企业塔、中层商业区、下层贫民窟与黑市。',
        rules: '义体改造与脑机接口普及，但会带来赛博精神病与债务；数据即权力，网络入侵（潜网）是常见手段；法律由公司执行，警察只是外包。',
        society: '巨型企业（财阀）统治，雇佣兵、黑客、义体医生、街头帮派并存；身份与信用评分决定你能去哪。',
        taboos: '未经授权接入企业内网、私自拆解他人义体、在公共频道暴露真实身份、拖欠“义体贷”。',
        elements: ['义体', '霓虹', '酸雨', '黑客', '潜网', '芯片', '义体医生', '信用评分', '企业塔', '黑市'],
        characterHints: '可设为赏金黑客、义体医生、公司叛逃者、街头情报贩子；说话冷硬、夹杂技术黑话与英文缩写。'
      }
    },
    {
      id: 'wv-abo',
      name: 'ABO',
      summary: '第二性别（Alpha / Beta / Omega）写进法律与日常的世界，信息素让亲密关系变成一场权力与本能的双人舞。',
      isBuiltin: true,
      source: 'preset',
      details: {
        era: '现代或近未来，第二性别已纳入社会制度。',
        place: '设有信息素登记处、配对中心与抑制剂药房的城市。',
        rules: '每个人在成年（约 18 岁）前后分化出第二性别：Alpha（少数，体能强、信息素浓、有易感期）、Beta（多数，受信息素影响小，社会中坚）、Omega（少数，有周期性发情期、信息素极易引发 Alpha 反应）。信息素可被抑制剂、抑制贴控制；临时标记靠咬后颈腺体维持数天，永久标记需双方结合并终身绑定；发情期未处理会失控，严重时需就医。',
        society: '第二性别影响求职、婚配与法律权利：部分岗位限制 Omega，标记关系常被视为准婚姻；平权运动与“性别中立”派同时存在。',
        taboos: '在公共场合释放信息素、未经同意标记他人、伪造抑制贴、买卖“强行标记”药物。',
        elements: ['Alpha', 'Beta', 'Omega', '信息素', '抑制剂', '抑制贴', '后颈腺体', '发情期', '易感期', '临时标记', '永久标记', '配对中心'],
        characterHints: 'Alpha 常被写得强势、有领地意识；Omega 可能敏感或刻意伪装柔软；Beta 常是清醒的观察者。注意把生理设定写成关系张力，而不是只堆术语。'
      }
    },
    {
      id: 'wv-doupo',
      name: '斗破苍穹',
      summary: '斗气大陆，强者为尊：杀人夺宝、宗门倾轧，唯有一路斗气攀升可证己身。',
      isBuiltin: true,
      source: 'preset',
      details: {
        era: '异界·斗气大陆，类古代东方玄幻时代。',
        place: '从乌坦城、加玛帝国到中州的辽阔大陆，宗门、坊市、拍卖行、魔兽山脉遍布。',
        rules: '斗气是根本力量，修炼等级由低到高：斗之气 → 斗者 → 斗师 → 大斗师 → 斗灵 → 斗王 → 斗皇 → 斗宗 → 斗尊 → 斗圣 → 斗帝，每一阶都是一道天堑。异火为天地奇火，可炼化提升实力，也会反噬宿主；炼药师以药鼎、火焰与药材炼制丹药，丹药品阶决定身价；斗技、功法、魔核、药材皆可在拍卖行与坊市流通。',
        society: '帝国与宗门并立（如云岚宗、魂殿），家族以出斗气天才为荣；炼药师地位极高，拍卖行与佣兵公会串联各方势力；实力即话语权。',
        taboos: '滥杀同门、抢夺他人异火或宗门传承、在拍卖行赖账、以下犯上辱及师门。',
        elements: ['斗气', '异火', '炼药', '丹药', '药鼎', '宗门', '拍卖行', '魔核', '斗技', '功法', '斗帝传说', '魔兽山脉'],
        characterHints: '可设为落魄家族少年、炼药师学徒、宗门弟子或异火持有者；说话带江湖气与尊卑称呼（前辈、大人、长老），战斗与修炼是日常话题。'
      }
    },
    {
      id: 'wv-none',
      name: '无世界观',
      summary: '不额外套设定，只按角色本身的人设说话，最省心的默认选项。',
      isBuiltin: true,
      source: 'preset',
      details: {
        era: '',
        place: '',
        rules: '',
        society: '',
        taboos: '',
        elements: [],
        characterHints: ''
      }
    }
  ];

  /* ============================================================
   * 二、10 个领域（助手角色用），每个 4-6 个专业；「其他」可自定义
   * ============================================================ */
  App.Data.DOMAINS = [
    {
      id: 'dev',
      name: '编程开发',
      specialties: ['前端开发', '后端开发', '移动开发', '数据与算法', 'DevOps 与运维', '架构设计']
    },
    {
      id: 'law',
      name: '法律',
      specialties: ['合同与民商', '刑事辩护', '劳动与人事', '知识产权', '婚姻家事', '公司合规']
    },
    {
      id: 'health',
      name: '医疗健康',
      specialties: ['内科', '外科', '用药与药理', '营养与减脂', '心理健康', '母婴育儿']
    },
    {
      id: 'edu',
      name: '教育',
      specialties: ['K12 学科辅导', '语言学习', '考试提分', '学习方法', '升学规划', '家庭教育']
    },
    {
      id: 'write',
      name: '写作',
      specialties: ['小说创作', '文案与营销', '公文与报告', '剧本与分镜', '自媒体运营', '诗歌与散文']
    },
    {
      id: 'trans',
      name: '翻译',
      specialties: ['英汉互译', '日汉互译', '商务翻译', '文学翻译', '技术文档翻译', '本地化']
    },
    {
      id: 'biz',
      name: '商业金融',
      specialties: ['创业与融资', '投资理财', '财务与会计', '市场分析', '运营增长', '职场沟通']
    },
    {
      id: 'design',
      name: '设计',
      specialties: ['UI/UX 设计', '视觉与品牌', '平面设计', '动效与交互', '摄影修图', '空间与室内']
    },
    {
      id: 'life',
      name: '生活',
      specialties: ['情感与关系', '家常菜谱', '旅行规划', '健身塑形', '居家整理', '宠物饲养']
    },
    {
      id: 'other',
      name: '其他',
      customizable: true,
      specialties: []
    }
  ];

  // 按名称取领域（找不到返回 null）
  App.Data.domainByName = function (name) {
    var list = App.Data.DOMAINS || [];
    for (var i = 0; i < list.length; i++) {
      if (list[i].name === name) return list[i];
    }
    return null;
  };

  // 按名称取领域 id（找不到返回 ''）
  App.Data.domainId = function (name) {
    var d = App.Data.domainByName(name);
    return d ? d.id : '';
  };

  /* ============================================================
   * 三、其他补充常量
   * ============================================================ */

  // 助手回答风格（创建向导 / 编辑页可选）
  App.Data.ASSISTANT_ANSWER_STYLES = [
    { id: 'conclusion', name: '结论优先', desc: '先给一句话结论，再分点解释' },
    { id: 'steps', name: '分步详解', desc: '按步骤拆解，给出可执行清单' },
    { id: 'teacher', name: '讲解式', desc: '像老师一样讲清原理与来龙去脉' },
    { id: 'socratic', name: '反问引导', desc: '先确认需求与前提，再逐步给建议' }
  ];

  // 两类角色
  App.Data.CHARACTER_TYPES = [
    {
      id: 'companion',
      name: '陪聊角色',
      icon: 'user',
      desc: '有性格、有过去、会主动说话的角色。适合陪伴、闲聊、角色扮演。'
    },
    {
      id: 'assistant',
      name: '领域助手',
      icon: 'bot',
      desc: '选定领域与专业的专家。回答准确、不扮演、不闲聊。'
    }
  ];

  // AI 补全的分步进度（Step4 用）
  App.Data.COMPLETION_STAGES = ['理解人设', '补背景', '写开场白', '校准语气'];

  // 世界观详情字段元信息（预览可点开编辑）
  App.Data.WORLDVIEW_FIELDS = [
    { key: 'era', label: '时代', multiline: false, placeholder: '例如：近未来 / 架空王朝' },
    { key: 'place', label: '地点', multiline: false, placeholder: '主要发生地' },
    { key: 'rules', label: '规则', multiline: true, placeholder: '这个世界特有的物理/力量/制度规则' },
    { key: 'society', label: '社会结构', multiline: true, placeholder: '阶层、势力、组织形式' },
    { key: 'taboos', label: '禁忌', multiline: true, placeholder: '不能触碰的底线' },
    { key: 'elements', label: '常用元素', type: 'list', placeholder: '每行一个，例如：信息素' },
    { key: 'characterHints', label: '角色人设建议', multiline: true, placeholder: '这个世界观里适合写什么样的人' }
  ];

  // 角色卡字段元信息（预览 / 编辑页共用）
  App.Data.COMPANION_FIELDS = [
    { key: 'personality', label: '性格', multiline: true, placeholder: '一句话或几句话描述性格' },
    { key: 'habits', label: '习惯', multiline: false, placeholder: '例如：紧张时会转笔' },
    { key: 'background', label: '背景', multiline: true, placeholder: '成长经历、职业、与用户的关系' },
    { key: 'speechStyle', label: '说话风格', multiline: false, placeholder: '例如：短句，偶尔用反问' },
    { key: 'catchphrases', label: '口头禅', multiline: false, placeholder: '例如：随便啦' },
    { key: 'scenario', label: '场景', multiline: true, placeholder: '对话发生在哪里、什么时刻' },
    { key: 'firstMessage', label: '开场白', multiline: true, placeholder: '角色说出的第一句话' },
    { key: 'exampleDialogues', label: '示例对话', type: 'dialogs', placeholder: '' }
  ];

  App.Data.ASSISTANT_FIELDS = [
    { key: 'domain', label: '领域', multiline: false, placeholder: '例如：法律' },
    { key: 'specialty', label: '专业', type: 'list', placeholder: '每行一个，例如：刑事辩护' },
    { key: 'duties', label: '职责', type: 'list', placeholder: '每行一条，例如：解释程序与风险' },
    { key: 'answerStyle', label: '回答风格', multiline: true, placeholder: '例如：先结论，再分点给步骤' },
    { key: 'knowledgeBoundary', label: '知识边界', multiline: true, placeholder: '哪些问题会说明不确定、需要专业机构' },
    { key: 'refusalPolicy', label: '拒答策略', multiline: true, placeholder: '遇到什么情况会拒绝或转为提醒' },
    { key: 'firstMessage', label: '开场白', multiline: true, placeholder: '助手的第一句话' }
  ];

  // 取某一类型的字段列表（含公共字段）
  App.Data.charFields = function (type) {
    var list = (type === 'assistant' ? App.Data.ASSISTANT_FIELDS : App.Data.COMPANION_FIELDS).slice();
    return list;
  };

  // 创建空角色记录（不含 id / 时间戳）
  App.Data.blankCharacter = function (type) {
    var t = type === 'assistant' ? 'assistant' : 'companion';
    return {
      type: t,
      name: '',
      avatar: '',
      worldviewId: '',
      worldviewSnapshot: '',
      personality: '',
      habits: '',
      background: '',
      speechStyle: '',
      catchphrases: '',
      scenario: '',
      firstMessage: '',
      exampleDialogues: [],
      systemPrompt: '',
      domain: '',
      specialty: [],
      duties: [],
      answerStyle: '',
      knowledgeBoundary: '',
      refusalPolicy: '',
      draft: {},
      fieldOrigin: {},
      generatedAt: 0,
      generationProviderId: '',
      generationModel: '',
      createdAt: 0,
      updatedAt: 0
    };
  };

  /* ============================================================
   * 四、App.CharKit —— 角色模块共用工具
   * ============================================================ */
  var U = App.Util;
  var UI = App.UI;
  var DB = App.DB;
  var Kit = App.CharKit = {};

  /* ---------- 4.1 通用小工具 ---------- */

  Kit.now = function () { return U.now(); };

  // 深层克隆（世界观预设复制成自定义时用，避免污染只读预设）
  Kit.clone = function (obj) {
    if (obj == null) return obj;
    try { return JSON.parse(JSON.stringify(obj)); } catch (e) { return obj; }
  };

  // 文本安全转义（列表一句话等）
  Kit.txt = function (v) {
    if (v == null) return '';
    return String(v);
  };

  // 一行摘要：陪聊取性格，助手取领域·专业
  Kit.charSummary = function (ch) {
    if (!ch) return '';
    if (ch.type === 'assistant') {
      var spec = (ch.specialty || []).filter(Boolean).join(' / ');
      var left = ch.domain || '领域未填';
      return spec ? left + ' · ' + spec : left;
    }
    var line = ch.personality || ch.habits || ch.background || '还没有性格设定';
    return U.truncate(String(line).replace(/\s+/g, ' '), 48);
  };

  // 角色类型标签
  Kit.typeName = function (type) {
    return type === 'assistant' ? '领域助手' : '陪聊角色';
  };

  // 从快照文本里取世界观名（快照格式见 App.Prompts.worldviewSnapshotText）
  Kit.snapshotName = function (snapshot) {
    if (!snapshot) return '';
    var m = /^【([^】]+)】/.exec(String(snapshot));
    return m ? m[1] : '';
  };

  Kit.errorInfo = function (err) {
    if (App.API && App.API.errorInfo) {
      try { return App.API.errorInfo(err); } catch (e) { /* 忽略 */ }
    }
    return {
      code: (err && err.code) || 'unknown',
      title: '调用失败',
      hint: (err && err.message) || '请检查网络与 API 配置后重试。'
    };
  };

  // 给悬浮气泡用的错误摘要（不放 Key / 正文）
  Kit.guideError = function (err) {
    if (!err) return null;
    var info = Kit.errorInfo(err);
    return { code: info.code || 'unknown', message: U.truncate(info.title + '：' + (info.hint || ''), 120) };
  };

  // 读 API 列表（引导 API 优先，其余按创建时间）
  Kit.loadProviders = function () {
    return DB.all('providers').then(function (rows) {
      var list = (rows || []).slice();
      list.sort(function (a, b) {
        var g = (b.role === 'guide' ? 1 : 0) - (a.role === 'guide' ? 1 : 0);
        if (g) return g;
        return (a.createdAt || 0) - (b.createdAt || 0);
      });
      return list;
    }).catch(function (e) {
      console.error('[char] 读取 API 列表失败', e);
      return [];
    });
  };

  Kit.findGuide = function (providers) {
    var list = providers || [];
    for (var i = 0; i < list.length; i++) {
      if (list[i] && list[i].role === 'guide') return list[i];
    }
    return null;
  };

  Kit.findProvider = function (providers, id) {
    var list = providers || [];
    if (!id) return null;
    for (var i = 0; i < list.length; i++) {
      if (list[i] && list[i].id === id) return list[i];
    }
    return null;
  };

  /**
   * 解析「补全使用哪个 API / 哪个模型」。
   * @param {Array} providers 全部 API
   * @param {string} providerId 记忆的 providerId（可空）
   * @param {string} model 记忆的 model（可空）
   * @returns {{provider:Object|null, model:string, ok:boolean, reason:string}}
   *          记录失效时自动回落到引导 API。
   */
  Kit.resolveGen = function (providers, providerId, model) {
    var list = providers || [];
    var provider = Kit.findProvider(list, providerId);
    if (!provider) provider = Kit.findGuide(list) || list[0] || null;
    if (!provider) {
      return { provider: null, model: '', ok: false, reason: '还没有可用的 API，请先到「API 管理」添加一个' };
    }
    var useModel = '';
    if (provider.id === providerId && model) useModel = String(model);
    if (!useModel && provider.defaultModel) useModel = String(provider.defaultModel);
    if (!useModel && provider.models && provider.models.length) useModel = String(provider.models[0]);
    if (!useModel) {
      return { provider: provider, model: '', ok: false, reason: '「' + (provider.name || '该 API') + '」还没有设置模型' };
    }
    return { provider: provider, model: useModel, ok: true, reason: '' };
  };

  /* ---------- 4.2 世界观数据 ---------- */

  // 读全部世界观：{presets:[7 个内置], users:[自定义], all:[内置在前]}
  Kit.loadWorldviews = function () {
    return DB.all('worldviews').then(function (rows) {
      var presets = (App.Data.WORLDVIEW_PRESETS || []).map(function (p) { return Kit.clone(p); });
      var users = (rows || []).filter(function (r) {
        return r && r.source !== 'preset' && !r.isBuiltin;
      });
      users.sort(function (a, b) { return (b.updatedAt || 0) - (a.updatedAt || 0); });
      return { presets: presets, users: users, all: presets.concat(users) };
    }).catch(function (e) {
      console.error('[char] 读取世界观失败', e);
      var preset = (App.Data.WORLDVIEW_PRESETS || []).map(function (p) { return Kit.clone(p); });
      return { presets: preset, users: [], all: preset };
    });
  };

  // 按 id 找世界观（先内置，再 DB）
  Kit.findWorldview = function (id) {
    if (!id) return Promise.resolve(null);
    var presets = App.Data.WORLDVIEW_PRESETS || [];
    for (var i = 0; i < presets.length; i++) {
      if (presets[i].id === id) return Promise.resolve(Kit.clone(presets[i]));
    }
    return DB.get('worldviews', id).catch(function () { return null; });
  };

  // 把内置预设复制成可编辑的自定义世界观
  Kit.copyWorldview = function (wv) {
    var copy = Kit.clone(wv || {});
    copy.id = U.uid('wv');
    copy.name = (copy.name || '未命名世界观') + ' 副本';
    copy.isBuiltin = false;
    copy.source = 'user';
    copy.rawInput = copy.rawInput || '';
    copy.draft = copy.draft || {};
    copy.createdAt = Kit.now();
    copy.updatedAt = copy.createdAt;
    return copy;
  };

  /* ---------- 4.3 UI 小部件 ---------- */

  // 步骤圆点进度（基于 base.css 的 .steps-dots / .dot）
  Kit.progressDots = function (labels, current) {
    var bar = UI.el('div', { class: 'steps-dots' });
    (labels || []).forEach(function (label, i) {
      var cls = 'dot' + (i < current ? ' done' : (i === current ? ' active' : ''));
      bar.appendChild(UI.el('div', { class: cls, attrs: { title: label } }));
    });
    return bar;
  };

  /**
   * AI 补全的分步进度条（带动画）。
   * @param {string[]} stages 阶段名
   * @returns {{node, setActive(idx), done(), fail(), reset()}}
   */
  Kit.aiProgress = function (stages) {
    var list = UI.el('div', { class: 'ck-ai-steps' });
    var rows = [];
    var current = -1;
    (stages || []).forEach(function (label, i) {
      var mark = UI.el('span', { class: 'ck-ai-dot', text: String(i + 1) });
      var txt = UI.el('span', { class: 'ck-ai-label', text: label });
      var row = UI.el('div', { class: 'ck-ai-step' }, mark, txt);
      rows.push({ row: row, mark: mark });
      list.appendChild(row);
    });
    function paint(idx, failed) {
      current = idx;
      rows.forEach(function (r, i) {
        var cls = 'ck-ai-step';
        var text = String(i + 1);
        if (i < idx) { cls += ' done'; text = '✓'; }
        else if (i === idx) { cls += failed ? ' fail' : ' active'; }
        r.row.className = cls;
        r.mark.textContent = text;
      });
    }
    return {
      node: list,
      setActive: function (idx) { paint(idx, false); },
      done: function () { paint(rows.length, false); },
      fail: function () { paint(current < 0 ? 0 : current, true); },
      reset: function () { paint(-1, false); }
    };
  };

  // 分步动画：按真实调用时长循环高亮，返回停止函数
  Kit.animateStages = function (progress, intervalMs) {
    var idx = 0;
    var stopped = false;
    progress.setActive(0);
    var timer = setInterval(function () {
      if (stopped) return;
      idx = Math.min(idx + 1, (App.Data.COMPLETION_STAGES || []).length - 1);
      progress.setActive(idx);
    }, intervalMs || 1400);
    return function stop() {
      stopped = true;
      try { clearInterval(timer); } catch (e) { /* 忽略 */ }
    };
  };

  // 错误提示块（带可选操作按钮）
  Kit.errorBox = function (opts) {
    opts = opts || {};
    var box = UI.el('div', { class: 'error-box' });
    box.appendChild(UI.el('div', { class: 'error-title', text: opts.title || '出错了' }));
    if (opts.hint) box.appendChild(UI.el('div', { class: 'error-hint', text: opts.hint }));
    var actions = opts.actions || [];
    if (actions.length) {
      var bar = UI.el('div', { class: 'error-actions' });
      actions.forEach(function (a) {
        var btn = UI.el('button', {
          class: 'btn small ' + (a.class || 'ghost'),
          type: 'button',
          text: a.text || '确定'
        });
        btn.addEventListener('click', function (ev) {
          ev.preventDefault();
          if (typeof a.onClick === 'function') a.onClick(ev);
        });
        bar.appendChild(btn);
      });
      box.appendChild(bar);
    }
    return box;
  };

  // 分类标题
  Kit.groupTitle = function (text) {
    return UI.el('div', { class: 'group-title', text: text });
  };

  // 字段行（label + 值 + 右侧箭头），点击回调
  Kit.fieldRow = function (opts) {
    opts = opts || {};
    var value = opts.value == null || opts.value === '' ? (opts.placeholder || '未填写') : String(opts.value);
    var cell = UI.el('div', { class: 'cell ck-field' + (opts.ai ? ' ck-ai-field' : ''), attrs: { role: 'button', tabindex: '0' } },
      UI.el('div', { class: 'main' },
        UI.el('div', { class: 'ck-field-label' },
          UI.el('span', { class: 'ck-field-title', text: opts.label || '' }),
          opts.ai ? UI.el('span', { class: 'ck-ai-tag', text: 'AI 补全' }) : null,
          opts.user ? UI.el('span', { class: 'ck-user-tag', text: '你填写' }) : null
        ),
        UI.el('div', { class: 'ck-field-value' + (opts.empty ? ' ck-empty' : ''), text: value })
      ),
      opts.editable === false ? null : UI.el('span', { class: 'chev', html: UI.icon('chev', 17) })
    );
    cell.addEventListener('click', function () {
      if (typeof opts.onClick === 'function') opts.onClick();
    });
    return cell;
  };

  /* ---------- 4.4 浮层封装（全部走 App.UI，硬件返回键才能关掉） ---------- */

  Kit.alert = function (title, message, okText) {
    return new Promise(function (resolve) {
      var h = UI.modal({
        title: title || '提示',
        content: message || '',
        actions: [{ text: okText || '知道了', class: 'primary', onClick: function (close) { close(); } }],
        onClose: function () { resolve(true); }
      });
      return h;
    });
  };

  Kit.confirm = function (opts) {
    opts = opts || {};
    if (UI.confirm) return UI.confirm(opts);
    return Kit.alert(opts.title || '确认', opts.message || '').then(function () { return true; });
  };

  Kit.prompt = function (opts) {
    opts = opts || {};
    if (UI.prompt) return UI.prompt(opts);
    return Promise.resolve(null);
  };

  Kit.sheet = function (opts) {
    opts = opts || {};
    if (UI.sheet) return UI.sheet(opts);
    return Promise.resolve(null);
  };

  // 编辑单个文本字段：Promise<string|null>
  Kit.editField = function (opts) {
    opts = opts || {};
    return Kit.prompt({
      title: '编辑' + (opts.label || ''),
      message: opts.hint || '',
      value: opts.value == null ? '' : String(opts.value),
      placeholder: opts.placeholder || '',
      multiline: !!opts.multiline,
      okText: '确定',
      cancelText: '取消'
    }).then(function (text) {
      if (text === null || text === undefined) return null;
      return String(text);
    });
  };

  // 编辑字符串数组（每行一项）：Promise<string[]|null>
  Kit.editList = function (opts) {
    opts = opts || {};
    var cur = (opts.values || []).join('\n');
    return Kit.prompt({
      title: '编辑' + (opts.label || ''),
      message: '每行一项' + (opts.hint ? '。' + opts.hint : ''),
      value: cur,
      placeholder: opts.placeholder || '',
      multiline: true,
      okText: '确定',
      cancelText: '取消'
    }).then(function (text) {
      if (text === null || text === undefined) return null;
      return String(text).split('\n').map(function (s) { return s.trim(); }).filter(Boolean);
    });
  };

  // 编辑示例对话：Promise<[{user,char}]|null>
  Kit.editDialogs = function (list) {
    var cur = (list || []).map(function (d) {
      return '用户：' + (d && d.user ? d.user : '') + '\n角色：' + (d && d.char ? d.char : '');
    }).join('\n\n');
    return Kit.prompt({
      title: '编辑示例对话',
      message: '每段两行，分别以「用户：」「角色：」开头；段与段之间空一行。',
      value: cur,
      multiline: true,
      placeholder: '用户：今天好累啊\n角色：那就先别想了，靠一会儿。',
      okText: '确定',
      cancelText: '取消'
    }).then(function (text) {
      if (text === null || text === undefined) return null;
      var blocks = String(text).split(/\n\s*\n/);
      var out = [];
      blocks.forEach(function (block) {
        var lines = String(block).split('\n').map(function (s) { return s.trim(); }).filter(Boolean);
        var user = '';
        var char = '';
        lines.forEach(function (line) {
          var mu = /^(用户|user|u)\s*[:：]\s*([\s\S]*)$/i.exec(line);
          if (mu) { user = user ? user + '\n' + mu[2] : mu[2]; return; }
          var mc = /^(角色|char|assistant|a)\s*[:：]\s*([\s\S]*)$/i.exec(line);
          if (mc) { char = char ? char + '\n' + mc[2] : mc[2]; return; }
          char = char ? char + '\n' + line : line;
        });
        if (user || char) out.push({ user: user, char: char });
      });
      return out;
    });
  };

  /**
   * 自定义 API/模型选择器（Step4 用）。
   * @param {Object} opts {providers, providerId, model, title}
   * @returns {Promise<{providerId:string, model:string}|null>}
   */
  Kit.pickProviderModel = function (opts) {
    opts = opts || {};
    return new Promise(function (resolve) {
      var providers = (opts.providers || []).slice();
      var settled = false;
      var current = Kit.findProvider(providers, opts.providerId) || null;
      var body = UI.el('div', { class: 'ck-picker' });
      var head = UI.el('div', { class: 'ck-picker-head' });
      var listBox = UI.el('div', { class: 'ck-picker-list' });
      body.appendChild(head);
      body.appendChild(listBox);

      var handle = UI.modal({
        title: opts.title || '选择补全使用的 API',
        content: body,
        alignLeft: true,
        actions: [{ text: '取消', onClick: function (close) { close(); } }],
        onClose: function () {
          if (!settled) { settled = true; resolve(null); }
        }
      });

      function finish(value) {
        if (settled) return;
        settled = true;
        try { handle.close(); } catch (e) { /* 忽略 */ }
        resolve(value);
      }

      function paint() {
        UI.clear(head);
        UI.clear(listBox);
        if (!current) {
          head.appendChild(UI.el('div', { class: 'ck-pick-label', text: '选择 API' }));
          if (!providers.length) {
            listBox.appendChild(UI.el('div', { class: 'ck-pick-empty', text: '还没有配置任何 API，请先到「API 管理」添加。' }));
            return;
          }
          providers.forEach(function (p) {
            var nameRow = UI.el('div', { class: 'ck-pick-title' },
              UI.el('span', { class: 'grow ellipsis', text: p.name || '未命名 API' }),
              p.role === 'guide' ? UI.el('span', { class: 'badge green', text: '引导' }) : null
            );
            var row = UI.el('div', { class: 'ck-pick-item', attrs: { role: 'button', tabindex: '0' } },
              UI.el('div', { class: 'col grow' },
                nameRow,
                UI.el('div', { class: 'ck-pick-sub ellipsis', text: '默认模型：' + (p.defaultModel || '未设置') })
              ),
              UI.el('span', { class: 'chev', html: UI.icon('chev', 17) })
            );
            row.addEventListener('click', function () { current = p; paint(); });
            listBox.appendChild(row);
          });
          return;
        }

        var back = UI.el('button', { class: 'btn ghost small', type: 'button', text: '换 API' });
        back.addEventListener('click', function () { current = null; paint(); });
        head.appendChild(UI.el('div', { class: 'row ck-pick-back' },
          back,
          UI.el('span', { class: 'muted small ellipsis grow', text: current.name || '' })
        ));

        var models = (current.models || []).slice();
        if (current.defaultModel && models.indexOf(current.defaultModel) < 0) models.unshift(current.defaultModel);
        if (!models.length) {
          listBox.appendChild(UI.el('div', { class: 'ck-pick-empty', text: '这个 API 还没保存模型，可在下方手填模型 id。' }));
        }
        models.forEach(function (md) {
          var row = UI.el('div', { class: 'ck-pick-item', attrs: { role: 'button', tabindex: '0' } },
            UI.el('span', { class: 'grow ellipsis', text: md }),
            (opts.providerId === current.id && opts.model === md) ? UI.el('span', { class: 'ck-check', html: UI.icon('check', 18) }) : null
          );
          row.addEventListener('click', function () {
            finish({ providerId: current.id, model: md });
          });
          listBox.appendChild(row);
        });

        var inp = UI.el('input', {
          class: 'input',
          attrs: { placeholder: '手填模型 id，例如 deepseek-chat', autocomplete: 'off' }
        });
        if (opts.providerId === current.id && opts.model) inp.value = String(opts.model);
        else if (current.defaultModel) inp.value = String(current.defaultModel);
        var okBtn = UI.el('button', { class: 'btn primary small', type: 'button', text: '使用' });
        okBtn.addEventListener('click', function () {
          var v = String(inp.value || '').trim();
          if (!v) { UI.toast('请先填写模型 id'); return; }
          finish({ providerId: current.id, model: v });
        });
        listBox.appendChild(UI.el('div', { class: 'ck-pick-custom' }, inp, okBtn));
      }

      paint();
    });
  };

  /* ---------- 4.5 数据变更通知（tab 页缓存，必须自己刷新） ---------- */
  var DATA_EVENT = 'aichat:data';
  Kit.notifyData = function (table) {
    try {
      document.dispatchEvent(new CustomEvent(DATA_EVENT, { detail: { table: table || '' } }));
    } catch (e) { /* 老 WebView 无 CustomEvent 构造器 */ }
  };
  Kit.onData = function (fn) {
    var handler = function (ev) {
      var table = ev && ev.detail ? ev.detail.table : '';
      try { fn(table); } catch (e) { console.error('[char] 数据变更回调异常', e); }
    };
    document.addEventListener(DATA_EVENT, handler);
    return function off() { document.removeEventListener(DATA_EVENT, handler); };
  };

  /* ---------- 4.6 会话创建（角色 → 聊天） ---------- */

  // 找该角色最近一次会话
  function latestSessionOf(characterId) {
    return DB.byIndex('sessions', 'characterId', characterId).then(function (rows) {
      var list = (rows || []).filter(function (s) { return s && s.characterId === characterId; });
      list.sort(function (a, b) { return (b.updatedAt || 0) - (a.updatedAt || 0); });
      return list[0] || null;
    }).catch(function (e) {
      console.error('[char] 查询角色会话失败', e);
      return null;
    });
  }

  /**
   * 开始与角色聊天：复用最近会话（无则新建），首次进入插入开场白。
   * @returns {Promise<Object|null>} session
   */
  Kit.startChat = function (ch) {
    if (!ch || !ch.id) {
      UI.toast('角色数据不完整，无法开始聊天', 'error');
      return Promise.resolve(null);
    }
    return Kit.loadProviders().then(function (providers) {
      return DB.settings.get('default_chat_provider_id', '').catch(function () { return ''; }).then(function (pid) {
        return { providers: providers, pid: pid || '' };
      });
    }).then(function (ctx) {
      var providers = ctx.providers || [];
      var pick = Kit.findProvider(providers, ctx.pid) || Kit.findGuide(providers) || providers[0] || null;
      return latestSessionOf(ch.id).then(function (existing) {
        var ts = Kit.now();
        if (existing) {
          var patch = { characterId: ch.id, updatedAt: ts };
          if (!existing.title) patch.title = ch.name || '新对话';
          if (pick) { patch.providerId = pick.id; patch.model = pick.defaultModel || existing.model || ''; }
          return DB.put('sessions', Object.assign({}, existing, patch));
        }
        var sess = {
          id: U.uid('s'),
          title: ch.name || '新对话',
          characterId: ch.id,
          personaId: '',
          presetId: '',
          providerId: pick ? pick.id : '',
          model: pick ? (pick.defaultModel || '') : '',
          pinned: false,
          updatedAt: ts,
          createdAt: ts
        };
        return DB.put('sessions', sess);
      });
    }).then(function (sess) {
      if (!sess) return null;
      // 首次进入才插入开场白：会话里一条消息都没有时插入
      return DB.byIndex('messages', 'sessionId', sess.id).catch(function () { return []; }).then(function (msgs) {
        if (msgs && msgs.length) return sess;
        if (!ch.firstMessage) return sess;
        var ts = Kit.now();
        return DB.put('messages', {
          id: U.uid('m'),
          sessionId: sess.id,
          role: 'assistant',
          variantIndex: 0,
          isActive: true,
          status: 'ok',
          errorText: '',
          tokensIn: 0,
          tokensOut: 0,
          createdAt: ts,
          variants: [{ content: String(ch.firstMessage), createdAt: ts }]
        }).then(function () { return sess; });
      });
    }).then(function (sess) {
      if (!sess) return null;
      if (App.Router && App.Router.has && !App.Router.has('chat')) {
        UI.toast('聊天页面暂不可用', 'error');
        return sess;
      }
      return App.Router.push('chat', { sessionId: sess.id, characterId: ch.id }).then(function () {
        return sess;
      });
    }).catch(function (e) {
      console.error('[char] 开始聊天失败', e);
      UI.toast('开始聊天失败：' + (e && e.message ? e.message : '未知错误'), 'error');
      return null;
    });
  };

  /* ---------- 4.7 草稿持久化 ---------- */
  // 草稿写入失败不阻断流程，只提示一次
  var draftWarned = false;
  Kit.saveDraft = function (key, value) {
    return DB.settings.set(key, value).catch(function (e) {
      console.error('[char] 保存草稿失败', key, e);
      if (!draftWarned) {
        draftWarned = true;
        UI.toast('草稿保存失败，重开应用后可能无法恢复', 'error');
      }
      return null;
    });
  };

  Kit.loadDraft = function (key) {
    return DB.settings.get(key, null).catch(function (e) {
      console.error('[char] 读取草稿失败', key, e);
      return null;
    });
  };

  Kit.clearDraft = function (key) {
    return DB.settings.del(key).catch(function (e) {
      console.error('[char] 清除草稿失败', key, e);
      return null;
    });
  };

  /* ---------- 4.8 system prompt 重建 ---------- */
  Kit.rebuildSystemPrompt = function (card) {
    if (!card) return '';
    if (App.Prompts && App.Prompts.buildSystemPrompt) {
      try { return App.Prompts.buildSystemPrompt(card) || ''; } catch (e) {
        console.error('[char] 生成 system prompt 失败', e);
        return card.systemPrompt || '';
      }
    }
    return card.systemPrompt || '';
  };
})();
