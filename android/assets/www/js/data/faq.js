/* =========================================================================
   data/faq.js —— 静态 FAQ + 常见错误码对照表（成员 D）
   · 纯数据模块：加载时不读 DB、不碰 DOM，断网也能用
   · App.Data.FAQ           = [{ q, a, category }]
   · App.Data.ERROR_TABLE   = { [code]: { code, title, meaning, fix } }
   · App.Data.matchFaq(q,n) 关键词匹配（帮助抽屉 / 气泡兜底用）
   ========================================================================= */
(function () {
  'use strict';
  var App = window.App = window.App || {};
  App.Data = App.Data || {};

  /* ---------------------------- 分类（顺序即展示顺序） ---------------------------- */
  var CATEGORIES = ['入门使用', 'API 配置', '错误排查', '功能使用', '数据与隐私', '费用与模型'];

  /* ---------------------------- 静态 FAQ（离线可读） ---------------------------- */
  var FAQ = [
    /* ===== 入门使用 ===== */
    {
      q: '这个 App 是做什么的？',
      a: '它是一个「自带 API Key」的 AI 聊天客户端：你自己在 API 管理里填一个 OpenAI 兼容的接口地址和 Key，就能和 AI 角色聊天、让 AI 帮你补全角色卡。App 本身不卖模型、没有账号系统，所有数据只存在这台手机上。',
      category: '入门使用'
    },
    {
      q: '第一次打开 App 应该怎么用？',
      a: '首次启动必须先完成引导：选择供应商（OpenAI / DeepSeek / OpenRouter / 硅基流动 / 自定义）→ 填入 API Key → 点「测试连接」→ 选择模型 → 完成。测试不通过就无法进入主界面，这是刻意设计的，保证你至少有一个能用的 API。',
      category: '入门使用'
    },
    {
      q: '为什么必须先配置「引导 API」？',
      a: '引导 API 是这个 App 内置的「说明书 + 客服」：引导助手问答、创建角色时的默认补全、世界观补全、「让 API 修改」都靠它。全 App 有且只有一条引导 API，配置好后可在「API 管理」里随时更换。',
      category: '入门使用'
    },
    {
      q: '主界面有哪几个 Tab？',
      a: '底部固定 4 个：聊天（会话列表，默认首屏）、角色（角色管理）、API（API 管理）、设置。二级页（聊天页、创建角色、世界观库、使用帮助、关于等）压栈打开，左上角返回。',
      category: '入门使用'
    },
    {
      q: '悬浮小球是什么？怎么用？',
      a: '是应用内的「随手问」入口，浮在页面右边缘。点一下展开快捷项：怎么走（当前页面下一步该做什么）、问引导、这啥意思（仅出错时出现）、帮助。长按小球可直接执行「怎么走」；拖动小球会吸附到左侧或右侧边缘并记住位置；双击收起。设置里可以关闭它或重置位置。它只是应用内浮层，不会出现在其他 App 上面。',
      category: '入门使用'
    },
    {
      q: '怎么换引导 API？',
      a: '进入「API 管理」，点开要使用的那条供应商，选择「设为引导 API」。换完立即生效：引导助手、角色补全、「让 API 修改」都会改用新的端点，不需要重启 App。',
      category: '入门使用'
    },

    /* ===== API 配置 ===== */
    {
      q: 'API Key 去哪里申请？',
      a: '常见几家：OpenAI 到 platform.openai.com/api-keys；DeepSeek 到 platform.deepseek.com/api_keys；OpenRouter 到 openrouter.ai/keys；硅基流动到 cloud.siliconflow.cn/account/ak。都需要先注册账号，是否有免费额度、如何充值以各家官网为准。',
      category: 'API 配置'
    },
    {
      q: 'Base URL 应该填什么？',
      a: '填到 /v1 为止，不要带 /chat/completions：OpenAI 填 https://api.openai.com/v1；DeepSeek 填 https://api.deepseek.com/v1；OpenRouter 填 https://openrouter.ai/api/v1；硅基流动填 https://api.siliconflow.cn/v1；自定义服务填它文档里给出的 OpenAI 兼容地址。',
      category: 'API 配置'
    },
    {
      q: '模型（model）填什么？',
      a: '填服务商文档里的模型 id，例如 deepseek-chat、gpt-4o-mini。点「测试连接」成功后 App 会尝试拉取 /models 列表，可以直接从列表里选；拉不到也可以手填。模型名写错通常表现为 404 或「模型不存在」。',
      category: 'API 配置'
    },
    {
      q: 'API Key 安全吗？会存在哪里？',
      a: 'Key 通过原生加密存储保存，不写进数据库、不写进导出备份、不写进日志。App 只在你发起请求时把 Key 交给对应的 API 服务商。注意：你的聊天内容会按服务商规则发送到该服务商。',
      category: 'API 配置'
    },
    {
      q: '可以配置多个 API 吗？',
      a: '可以。「API 管理」里能添加多条：一条设为引导 API（全 App 唯一），一条设为默认聊天 API，其他备用。创建角色时第 4 步可以选任意一条已配置的 API 来做补全，并会记住你上次的选择。',
      category: 'API 配置'
    },
    {
      q: '测试连接失败怎么办？',
      a: '先看错误码：401 是 Key 不对，403 是没权限，404 是地址或模型不对，429 是限流/额度问题，超时和 DNS/证书是网络问题。逐项检查 Key 有没有多余空格、Base URL 是否以 /v1 结尾、网络或代理是否可用、账户是否还有余额。错误提示下方的「这是什么意思？」可以让引导助手解释。',
      category: 'API 配置'
    },
    {
      q: 'OpenAI 兼容是什么意思？',
      a: '指服务商提供与 OpenAI 相同的 /v1/chat/completions 和 /v1/models 接口。只要协议兼容，就可以把 OpenAI 的 SDK/客户端指向它的 Base URL 使用；本 App 的供应商配置同理。',
      category: 'API 配置'
    },
    {
      q: '可以用中转/代理地址吗？',
      a: '可以。把中转服务提供的 OpenAI 兼容地址填进 Base URL，Key 填中转服务发给你的 Key。注意确认中转要求的路径前缀（有的要求 /v1，有的不带）以及是否需要额外的请求头，否则容易出现 404/401。',
      category: 'API 配置'
    },

    /* ===== 错误排查 ===== */
    {
      q: '401 是什么意思，怎么修？',
      a: '401 Unauthorized：Key 无效、过期、被删除，或没有带上鉴权。重新复制一遍 Key（注意不要有空格/换行）、确认填的是同一家服务商的 Key、确认 Key 没有被停用，然后重新测试连接。',
      category: '错误排查'
    },
    {
      q: '403 是什么意思，怎么修？',
      a: '403 Forbidden：Key 有效但没权限。常见原因是所在地区不支持、账号没有该模型权限、Key 被限制了 IP 或用途。换一个模型或换一条供应商试试，仍不行就联系服务商。',
      category: '错误排查'
    },
    {
      q: '404 是什么意思，怎么修？',
      a: '404 Not Found：请求路径或模型不存在。检查 Base URL 是否少了/多了 /v1、是否误填了 /chat/completions；检查模型名是否拼错或该账号没有这个模型。',
      category: '错误排查'
    },
    {
      q: '429 是什么意思，怎么修？',
      a: '429 Too Many Requests：请求太快或额度用尽。等几十秒再试，降低连续发送频率；如果持续出现，检查账户余额、免费额度是否用完、是否触发了并发限制。',
      category: '错误排查'
    },
    {
      q: '提示超时怎么办？',
      a: '超时表示在限定时间内没收到响应：可能是网络慢、服务商排队、上下文太长或模型太慢。可以重试、换更快的模型、缩短对话，或检查网络/代理。角色补全默认 60 秒超时，失败会保留你已填的内容。',
      category: '错误排查'
    },
    {
      q: 'DNS 解析失败怎么办？',
      a: '表示域名解析不到：检查网络是否正常、是否开了代理或 VPN、Base URL 有没有拼写错误（例如把 .com 写成 .co）。切换网络（Wi-Fi / 移动数据）后重试。',
      category: '错误排查'
    },
    {
      q: '证书错误怎么办？',
      a: '表示 TLS 证书校验失败：常见于抓包工具/自签证书代理、系统时间不对、网络被劫持。关闭抓包代理、校准系统时间、换网络重试；不要为了绕过它去信任来路不明的证书。',
      category: '错误排查'
    },
    {
      q: '断网了还能用吗？',
      a: '能看不能发：断网时可以打开 App 浏览已有的聊天记录、角色、世界观和这份离线 FAQ；发送消息、AI 补全、引导助手都会提示网络不可用。App 不支持离线推理，也不会偷偷用本地模型顶替。',
      category: '错误排查'
    },
    {
      q: '错误提示在哪看解释？',
      a: '所有错误提示下方都有「这是什么意思？」：点它会打开引导助手，并自动带上错误码、原始报错文案和当前页面，让引导 API 解释原因和修复步骤。',
      category: '错误排查'
    },

    /* ===== 功能使用 ===== */
    {
      q: '怎么创建一个角色？',
      a: '进入「角色」Tab，点右上角＋新建角色：① 选类型（陪聊 / 助手，助手还要选领域和专业）；② 选世界观；③ 粗略填写（名称必填，性格一句话，习惯和其他补充可空）；④ 选补全 API 并点「AI 补全」；⑤ 预览完整角色卡，可保存、让 API 改或自己改。',
      category: '功能使用'
    },
    {
      q: 'AI 补全失败怎么办？会丢内容吗？',
      a: '不会丢。补全失败会提示具体原因，你可以「换一个 API 重试」，也可以跳过 AI 补全、手动把表单填完整后保存；已填的内容和草稿都在本机，杀进程重开也能回到草稿。',
      category: '功能使用'
    },
    {
      q: '怎么开始聊天？',
      a: '两种方式：在「聊天」Tab 点右上角＋选择角色新建会话；或在「角色」列表里点某个角色的「开始聊天」。新建会话会把角色的开场白作为第一条消息插入。',
      category: '功能使用'
    },
    {
      q: '聊天记录存在哪里？',
      a: '存在本机的数据库中（IndexedDB），按会话保存；杀进程、重启手机都不会丢，卸载 App 或清空数据会丢。没有云同步，也不会上传到任何服务器。',
      category: '功能使用'
    },
    {
      q: '怎么导出/备份聊天记录？',
      a: '进入「设置」→「数据导入/导出」→ 导出备份，会生成一个 JSON 备份文件。换手机时在新机同一入口导入即可。注意：备份里不含 API Key，导入后需要在「API 管理」重新填 Key。',
      category: '功能使用'
    },
    {
      q: '怎么清空数据、重新走引导？',
      a: '「设置」→「清空数据」会删除本机全部聊天、角色、世界观、API 配置与引导标记，不可恢复。清空后下次启动会重新进入首次引导。建议先导出备份。',
      category: '功能使用'
    },
    {
      q: '引导助手和普通聊天角色有什么区别？',
      a: '引导助手用的是独立会话，不进聊天列表，不参与角色卡/人设/世界观；它只知道本 App 的功能和 API 配置知识，用来回答「怎么用」「这报错什么意」。普通聊天角色才是你创建的角色。',
      category: '功能使用'
    },
    {
      q: '引导助手的记录怎么清空？',
      a: '打开引导助手抽屉，点右上角「清空」，只清空引导会话记录，不影响「已完成引导」标记，也不影响角色聊天记录。',
      category: '功能使用'
    },
    {
      q: '世界观怎么选？预设有哪些？',
      a: '创建角色的第 2 步选择世界观：内置 7 个预设（现代都市 / 古代宫廷 / 校园日常 / 赛博朋克 / ABO / 斗破苍穹 / 无世界观），预设只读，可「复制并自定义」。也可以在「世界观库」里写一句粗略设定，让引导 API 补全成完整世界观后保存。',
      category: '功能使用'
    },
    {
      q: '「补全使用」这个选择器是干嘛的？',
      a: '创建角色第 4 步顶部可以选择用哪条 API 做首次 AI 补全（默认引导 API，可切换任意已配置的 API），选择结果会被记住。注意：预览页的「让 API 修改」固定使用当前引导 API，不跟随这个选择；想换模型请去 API 管理更换引导 API。',
      category: '功能使用'
    },
    {
      q: '助手角色和陪聊角色有什么不同？',
      a: '陪聊角色是「一个人」：性格、习惯、背景、说话方式、开场白，适合闲聊和角色扮演；助手角色是「一个专家」：选领域与专业，回答结构化、可执行，不扮演人格、不加戏。两者默认预设和补全字段都不同。',
      category: '功能使用'
    },

    /* ===== 数据与隐私 ===== */
    {
      q: '我的数据会被上传吗？',
      a: 'App 没有自建后端、没有账号、没有遥测：聊天记录、角色、世界观、预设、引导会话都只存在本机。只有你主动发消息或让 AI 补全时，相关文本才会发送到你配置的 API 服务商。',
      category: '数据与隐私'
    },
    {
      q: 'API Key 会出现在导出文件或日志里吗？',
      a: '不会。Key 走原生加密存储，备份导出、日志、引导助手上下文都不包含 Key 明文。分享备份或截图时不用担心 Key 泄露；但仍不建议把 Key 发给任何人。',
      category: '数据与隐私'
    },
    {
      q: '换手机怎么迁移数据？',
      a: '旧机：设置 → 数据导入/导出 → 导出备份，把 JSON 文件传到新机；新机：同一入口导入备份 → 到「API 管理」重新填写 API Key（Key 不会随备份迁移）。',
      category: '数据与隐私'
    },
    {
      q: '卸载 App 会怎样？',
      a: '卸载或清除应用数据会删除本机的全部数据（聊天、角色、世界观、API 配置、引导标记），且无法恢复。卸载前请先导出备份。',
      category: '数据与隐私'
    },

    /* ===== 费用与模型 ===== */
    {
      q: '这个 App 收费吗？调用费用怎么算？',
      a: 'App 本身不收费、也不代扣任何费用。调用模型产生的费用由你选择的 API 服务商按 token 计费，账单在服务商控制台查看。具体单价、免费额度以服务商官网为准。',
      category: '费用与模型'
    },
    {
      q: '什么模型适合陪聊角色？',
      a: '陪聊更看重文笔、长上下文和角色扮演能力，例如 DeepSeek 的 deepseek-chat、OpenAI 的 gpt-4o / gpt-4o-mini，或经 OpenRouter 提供的同类模型。最终效果和价格以你能用的服务商为准，建议先用便宜模型试手感。',
      category: '费用与模型'
    },
    {
      q: '什么模型适合助手角色？',
      a: '助手更看重准确性和结构化输出，建议选推理能力较强、支持较长上下文的模型（如 deepseek-chat、gpt-4o 系列），并把预设温度调低。模型能力决定回答质量，客户端不做质量兜底，只做格式与连通性校验。',
      category: '费用与模型'
    },
    {
      q: '为什么没有本地模型 / 离线聊天？',
      a: '这个 App 只做远程 API 调用，不做端侧推理：没有模型下载、没有本地模式，断网时只能浏览历史。这样安装包小、不挑设备，也不需要下载几 GB 模型；代价是发送消息必须联网。',
      category: '费用与模型'
    },
    {
      q: '为什么 AI 会答错或编造内容？',
      a: '大模型存在「幻觉」，可能自信地给出错误信息。可以在角色卡里写清知识边界与拒答策略，提问时要求「不确定就说不确定」。医疗、法律、金融类回答仅供参考，不构成专业意见。',
      category: '费用与模型'
    },
    {
      q: 'token 是什么？用量在哪看？',
      a: 'token 是模型计费和上下文长度的单位，中文大致 1 个字≈1 个 token，英文约 4 个字符≈1 个 token。聊天页会显示每条回复的 token 用量；上下文越长越贵，也可能触发服务商的最大上下文限制。',
      category: '费用与模型'
    }
  ];

  /* ---------------------------- 错误码 → 中文对照 ---------------------------- */
  var ERROR_TABLE = {
    '401': {
      code: '401',
      title: 'Key 无效或未授权',
      meaning: '服务端不认识你提供的 API Key：可能是 Key 抄错、已过期、已被删除，或请求没带上鉴权。',
      fix: '重新复制 Key（不要有空格或换行）→ 确认 Key 属于这家服务商 → 确认 Key 未被停用 → 重新点「测试连接」。'
    },
    '403': {
      code: '403',
      title: '没有权限',
      meaning: 'Key 能识别，但这个账号没有访问该模型/接口的权限，或所在地区、IP 被限制。',
      fix: '换一个可用模型或另一条供应商；确认账号已完成实名/付费；仍不行联系服务商。'
    },
    '404': {
      code: '404',
      title: '路径或模型不存在',
      meaning: '请求的地址不对，或模型名不存在。常见于 Base URL 少了/多了 /v1，或误把 /chat/completions 填进 Base URL。',
      fix: '把 Base URL 改成以 /v1 结尾的根地址；核对模型 id 拼写；确认该模型对该账号开放。'
    },
    '429': {
      code: '429',
      title: '请求过多或额度不足',
      meaning: '触发了服务商的频率限制/并发限制，或账户余额、免费额度已经用完。',
      fix: '等几十秒再试、降低发送频率；到服务商控制台检查余额与限额；必要时升级套餐。'
    },
    '5xx': {
      code: '5xx',
      title: '服务端错误',
      meaning: '服务商内部故障（500/502/503/504 等），通常与你的 Key 和配置无关。',
      fix: '稍等几分钟重试；查看服务商状态页；持续报错就换一条供应商。'
    },
    timeout: {
      code: 'timeout',
      title: '请求超时',
      meaning: '规定时间内没收到响应：网络慢、服务商排队、上下文太长或模型太慢。',
      fix: '重试；换更快的模型或更短的对话；检查网络/代理；角色补全会保留已填内容，可重新生成。'
    },
    offline: {
      code: 'offline',
      title: '网络不可用',
      meaning: '设备当前没有可用网络，请求没有真正发出去。',
      fix: '检查 Wi-Fi/移动数据是否打开；断网时只能浏览本地历史，发送与 AI 补全需要联网。'
    },
    dns: {
      code: 'dns',
      title: '域名解析失败',
      meaning: '找不到服务商域名：可能是网络/代理问题，或 Base URL 拼错了。',
      fix: '核对 Base URL 拼写；切换网络后重试；检查代理/DNS 设置。'
    },
    tls: {
      code: 'tls',
      title: '证书错误',
      meaning: 'HTTPS 证书校验失败：常见于抓包代理、自签证书、系统时间错误或网络劫持。',
      fix: '关闭抓包代理、校准系统时间、换网络重试；不要信任来路不明的证书。'
    },
    cancel: {
      code: 'cancel',
      title: '已取消',
      meaning: '本次请求被主动停止（例如点了「停止生成」或离开了页面）。',
      fix: '需要的话重新发送即可；已生成的内容会保留。'
    },
    unknown: {
      code: 'unknown',
      title: '未知错误',
      meaning: '没有识别出具体原因的错误。',
      fix: '重试一次；仍失败就查看引导助手，或检查服务商控制台。'
    }
  };
  var ERROR_CODES = ['401', '403', '404', '429', '5xx', 'timeout', 'offline', 'dns', 'tls', 'cancel', 'unknown'];

  /* ---------------------------- 对外导出 ---------------------------- */
  App.Data.FAQ = FAQ;
  App.Data.FAQ_CATEGORIES = CATEGORIES;
  App.Data.ERROR_TABLE = ERROR_TABLE;
  App.Data.ERROR_CODES = ERROR_CODES;

  /* 归一化错误码：'HTTP 401' / 401 / 'unauthorized' → '401' 等 */
  App.Data.normalizeErrorCode = function (code) {
    var raw = String(code === undefined || code === null ? '' : code).trim().toLowerCase();
    if (!raw) return 'unknown';
    if (ERROR_TABLE[raw]) return raw;
    var m = raw.match(/\b(\d{3})\b/);
    if (m) {
      var n = m[1];
      if (ERROR_TABLE[n]) return n;
      if (n.charAt(0) === '5') return '5xx';
      return 'unknown';
    }
    if (/timeout|timed\s*out|超时/.test(raw)) return 'timeout';
    if (/offline|network|unreachable|断网|网络/.test(raw)) return 'offline';
    if (/dns|resolve|解析/.test(raw)) return 'dns';
    if (/tls|ssl|certificate|cert|证书/.test(raw)) return 'tls';
    if (/cancel|abort/.test(raw)) return 'cancel';
    return 'unknown';
  };

  /* 取错误码对照条目（找不到返回 unknown 条目） */
  App.Data.errorInfo = function (code) {
    var key = App.Data.normalizeErrorCode(code);
    return ERROR_TABLE[key] || ERROR_TABLE.unknown;
  };

  /* 关键词匹配 FAQ：优先错误码，其次问题/答案里出现的词；最多 limit 条 */
  App.Data.matchFaq = function (query, limit) {
    limit = limit || 3;
    var q = String(query === undefined || query === null ? '' : query).trim();
    if (!q) return FAQ.slice(0, limit);
    var low = q.toLowerCase();
    var code = App.Data.normalizeErrorCode(q);
    var codeHit = code !== 'unknown' && /(\d{3}|timeout|offline|dns|tls)/.test(low) ? code : '';
    var tokens = low.split(/[\s,，。.、;；:：!！?？()（）"'“”‘’/\\|]+/).filter(function (t) { return t.length >= 2; });
    var scored = [];
    FAQ.forEach(function (item, idx) {
      var text = (item.q + ' ' + item.a + ' ' + item.category).toLowerCase();
      var score = 0;
      if (codeHit && text.indexOf(codeHit) >= 0) score += 6;
      if (text.indexOf(low) >= 0) score += 5;
      tokens.forEach(function (t) { if (text.indexOf(t) >= 0) score += 2; });
      /* 单字兜底：中文问题里抽取 2~3 字的片段做弱匹配 */
      if (!tokens.length && low.length >= 2) {
        if (text.indexOf(low.slice(0, 2)) >= 0) score += 1;
      }
      if (score > 0) scored.push({ item: item, score: score, idx: idx });
    });
    scored.sort(function (a, b) { return b.score - a.score || a.idx - b.idx; });
    return scored.slice(0, limit).map(function (x) { return x.item; });
  };

  /* 按分类分组（保持 CATEGORIES 顺序，未知分类归到「其他」） */
  App.Data.faqGroups = function () {
    var groups = [];
    var map = {};
    CATEGORIES.forEach(function (c) {
      map[c] = { category: c, items: [] };
      groups.push(map[c]);
    });
    var other = { category: '其他', items: [] };
    FAQ.forEach(function (item) {
      if (map[item.category]) map[item.category].items.push(item);
      else other.items.push(item);
    });
    if (other.items.length) groups.push(other);
    return groups.filter(function (g) { return g.items.length > 0; });
  };
})();
