# AI 聊天 App · 工程契约（所有成员必读）

> 本文件是唯一接口契约。**只允许修改自己拥有的文件**；`css/base.css`、`index.html`、`js/{util,db,router,ui,bridge,api,main}.js`、`android/**`、`scripts/**` 属于 Lead，禁止改动。需要 base 增补时找 Lead。

## 0. 产品定位（务必对齐）

- Android 优先的 **BYOK 远程 API AI 聊天客户端**：微信式底部 4 Tab（聊天/角色/API/设置），ChatterUI 式角色体系（角色卡/预设/世界书/会话/多版本消息概念）。
- **没有本地推理**：不出现 llama/gguf/本地模型入口；断网只能只读浏览历史，发送必须报错。
- **首次启动强制引导**：必须先配好「引导 API」（`providers.role === 'guide'`，全 App 唯一）并测试连通成功，才进主界面。
- 全部数据只存本机；API Key 通过原生加密存储（`App.Bridge` secure.*），**绝不写入 IndexedDB、导出、日志**。
- 中文 UI、中文注释。视觉走微信式：白/深色列表、圆形头像、细分割线、右侧箭头、消息气泡；**不要 Material 卡片堆**。

## 1. 技术形态

- 原生壳：`android/` 下 Java + WebView（`https://app.local/` 虚拟源，拦截到 `assets/www`）。
- 前端：`android/assets/www/` 纯 HTML/CSS/vanilla JS，无构建步骤、无 npm 运行时依赖。
- 原生桥：`window.AndroidBridge.call(requestId, method, argsJson)`；结果回调 `window.__nativeResult(id, ok, json)`；流式事件 `window.__nativeEvent(id, json)`。
- 数据层：IndexedDB 封装（`App.DB`）。浏览器里 `App.Bridge` 自动降级为 mock，方便无头浏览器截图验证。

## 2. 文件所有权（写作用域）

| 成员 | 文件 |
|---|---|
| Lead | `index.html`、`css/base.css`、`js/{util,db,router,ui,bridge,api,main}.js`、`android/**`、`scripts/**`、`docs/**` |
| A onboarding/api/settings | `js/pages/onboarding.js`、`js/pages/api-list.js`、`js/pages/api-edit.js`、`js/pages/settings.js`、`css/pages-config.css` |
| B chat | `js/pages/chat-list.js`、`js/pages/chat.js`、`js/pages/preset-edit.js`、`css/pages-chat.css` |
| C characters/worldview/prompts | `js/pages/characters.js`、`js/pages/character-create.js`、`js/pages/character-edit.js`、`js/pages/worldviews.js`、`js/prompts.js`、`js/data/*.js`、`css/pages-char.css` |
| D guide/help/bubble | `js/bubble.js`、`js/guide.js`、`js/pages/help.js`、`js/pages/about.js`、`css/pages-guide.css`、`js/data/faq.js` |

**禁止**新建其他 JS/CSS 文件（避免 index.html 未加载）。页面只能通过注册表接入。
所有 JS 必须 `node --check` 通过；用 ES2019（async/await、可选链可选；不要 import/export，全部挂 `window.App`）。不要使用 `innerHTML` 插入未经 `App.Util.esc()` 的用户数据。

## 3. 加载顺序（index.html 已固定）

```
js/bridge.js → js/util.js → js/db.js → js/router.js → js/ui.js → js/api.js
→ js/data/worldviews.js (C) → js/data/presets.js (C) → js/data/faq.js (D)
→ js/prompts.js (C) → js/guide.js (D) → js/pages/*.js → js/bubble.js (D) → js/main.js (Lead)
```
页面文件在加载时调用 `App.Router.register(name, config)` 注册，**不要**在加载时读 DB 或操作 DOM（除注册外）。
`App.Bubble` 在 `main.js` 启动时调用 `App.Bubble.mount()`（D 提供）。

## 4. 设计系统（css/base.css 已提供，直接用类名）

### 主题变量
`html[data-theme="light|dark|amoled"]`；切主题：`App.UI.setTheme('dark')`（内部写 settings.theme）。
变量：`--bg --card --card-2 --text --text-2 --text-3 --line --brand(#07c160) --brand-2 --danger --warn --bubble-me --bubble-other --chat-bg --nav-bg --shadow`。

### 布局骨架（router 已生成）
```
#app.shell
  header.navbar [ .nav-back | .nav-title | .nav-actions ]
  main#page-root.page-body
  nav.tabbar [ .tab (data-tab) ]
#overlay-root  (modal/sheet/toast/help drawer/bubble，z-index 分层)
```
- Tab 页由 router 缓存 DOM，切 Tab 不重建（状态不丢）；二级页压栈，带返回。
- 页面内容通过 `page` 提供的根元素渲染。

### 通用类
- 列表：`.list` > `.cell`（内 `.avatar` + `.main` > `.title/.sub` + `.meta` + `.chev`）、`.cell.pinned`、`.cell.active`
- 按钮：`.btn`、`.btn.primary`、`.btn.ghost`、`.btn.danger`、`.btn.block`、`.btn.small`、`.btn:disabled`
- 表单：`.form`、`.field`（`label` + `.input/.textarea/.select` + `.hint`）、`.field.error`、`.field.row`、`.switch`、`.segmented` > `.seg.active`
- 卡片：`.card`、`.card-title`、`.card-body`、`.card-actions`
- 徽标：`.badge`、`.badge.green`、`.badge.gray`、`.tag`
- 空/载/错：`.empty`（`.empty-icon/.empty-title/.empty-desc`）、`.loading`（`.spinner`）、`.error-box`
- 聊天：`.chat-wrap` > `.msg-list` > `.msg.me/.msg.ai`（`.msg-bubble` + `.msg-meta`）、`.composer`（`.composer-input` `.composer-send`）
- 抽屉/弹层：`.modal`、`.sheet`、`.toast`、`.drawer`
- 顶部过滤/分段：`.segmented`
- 工具：`.row`、`.col`、`.grow`、`.muted`、`.small`、`.center`、`.gap-8/.gap-12`、`.mt-*`、`.ellipsis`、`.divider`

## 5. 页面注册契约（核心）

```js
App.Router.register('apiList', {
  tab: true,                       // 底部 Tab 页：true；二级页：false
  title: 'API 管理',               // 字符串或 () => string
  tabLabel: 'API',                 // 仅 tab:true 需要
  tabIcon: 'api',                  // 图标名，见 UI.icon
  build(root, params, page) {}     // 同步或 async；root 为内容容器
});
```
- 底部 Tab 固定 4 个（由 Lead 在 router 中定义）：`chatList`(聊天/chat)、`characters`(角色/character)、`apiList`(API/api)、`settings`(设置/settings)。**页面名必须用这四个名字**。
- `page` 句柄：
  - `page.setTitle(text)`
  - `page.setActions([{icon:'plus', label:'新建', onClick}])` 右上角按钮（最多 2 个）
  - `page.guide({...})` 注册悬浮气泡页面上下文（见 §9）
  - `page.onDestroy(fn)`
  - `page.root`（内容容器）、`page.params`
- 二级页必须 `App.Router.push(name, params)` 进入；`App.Router.pop()` 返回；`page` 自动带返回按钮。
- 错误边界：build 抛错由 router 捕获渲染错误页，不要自己吞异常。

## 6. 全局模块 API

### 6.1 App.Util
`esc(s)`、`uid(prefix)`、`now()`、`fmtTime(ts)`（今天 HH:mm / 昨天 / MM-DD）、`fmtDateTime(ts)`、`clamp`、`debounce`、`throttle`、`sleep`、`parseJSONLoose(text)`（剥 ``` 围栏/取首尾括号解析，失败 null）、`copyText(s)`、`initial(name)`、`pct`、`fmtTokens(n)`、`hasChinese`、`estimateTokens(text)`。

### 6.2 App.DB（全部返回 Promise）
`DB.ready()`；`get(table,id)` `put(table,record)`（无 id 自动生成，返回 record）`del(table,id)` `all(table)` `clear(table)` `clearAll()` `byIndex(table,index,value)`；`DB.settings.get(key,def)` `DB.settings.set(key,val)` `DB.settings.all()`。
表（keyPath=`id`，settings keyPath=`key`）：`providers, worldviews, characters, personas, presets, sessions, messages, helpSessions, helpMessages, settings`。
索引：`messages.sessionId`、`helpMessages.sessionId`。

**数据模型（字段名固定，按第八章）**
```js
providers: {id, role:'chat'|'guide', name, baseUrl, defaultModel, models:[], lastStatus:'ok'|'error'|'unknown', lastError, lastCheckedAt, createdAt, updatedAt}
worldviews: {id, name, summary, details:{era,place,rules,society,taboos,elements,characterHints}, isBuiltin, source:'preset'|'user', rawInput, draft, createdAt, updatedAt}
characters: {id, type:'companion'|'assistant', name, avatar, worldviewId, worldviewSnapshot,
  personality, habits, background, speechStyle, catchphrases, scenario, firstMessage, exampleDialogues:[{user,char}], systemPrompt,
  domain, specialty:[], duties:[], answerStyle, knowledgeBoundary, refusalPolicy,
  draft:{...Step3原始输入}, fieldOrigin:{字段:user|ai}, generatedAt, generationProviderId, generationModel, createdAt, updatedAt}
personas: {id, name, description, avatar}
presets: {id, name, params:{temperature,top_p,top_k,max_tokens,presence_penalty,frequency_penalty,stop[]}, instructTemplate, mode:'chat'|'text', appliesTo:'companion'|'assistant'|'both', isBuiltin}
sessions: {id, title, characterId, personaId, presetId, model, providerId, pinned, updatedAt, createdAt}
messages: {id, sessionId, role:'user'|'assistant'|'system', content, variantIndex, isActive, status:'ok'|'streaming'|'error', errorText, tokensIn, tokensOut, createdAt, variants?:[{content,createdAt}]}
helpSessions: {id, context:'guide_wizard'|'settings_help'|'bubble_next_step'|'bubble_error'|'bubble_help'|'error_hint', pageId, createdAt, updatedAt}
helpMessages: {id, sessionId, role, content, createdAt}
settings: 见 §12
```
- 引导 API 唯一性：设 guide 时把原 guide 降为 chat；删除 guide 需先指定/降级并提示引导流程会重置。
- API Key **不存 DB**：`Bridge.secure.set('key:'+providerId, key)`；DB 里只有 provider 元数据。

### 6.3 App.UI
`el(tag, attrs, ...children)`（attrs: `class,text,html,style,dataset,on:{click},attrs:{...},value`；children 支持字符串/节点/数组/null）
`frag(...nodes)`、`icon(name)`（svg 字符串）、`toast(text,type)`、`confirm(opts)->Promise<bool>`、`prompt(opts)->Promise<string|null>`、`modal(opts)->{close}`、`sheet(opts)->Promise<item|null>`、`loading(container,text)`、`empty(opts)->el`、`errorState(opts)->el`、`avatar(name,uri,size)`（`size`: 'sm'|'md'|'lg'）、`setTheme(name)`、`theme()`、`statusPill(text,type)`、`pageError(err)`、`spinnerEl()`。
图标名：`chat, character, api, settings, plus, back, search, more, send, stop, refresh, edit, copy, delete, pin, check, chev, world, help, close, warning, guide, arrow, star, key, link, trash, play, pause, user, bot, globe, download, upload, lock, info, time, spark`。

### 6.4 App.Router
`register(name,cfg)`、`push(name,params)`、`pop()`、`tab(name)`、`current()->{name,params,page}`、`page(name)`、`onChange(fn)`、`goChatList()`。`window.__handleBack()` 由 router 定义（Android 返回键调用）。

### 6.5 App.Bridge
`Bridge.available`（bool）、`Bridge.call(method, args, {onEvent}) -> Promise<result>`、`Bridge.stream(args, onEvent) -> {id, done:Promise, abort()}`。
原生方法（args → result）：
- `net.test {baseUrl, apiKey, timeoutMs}` → `{ok, status, models, error:{code,message}}`
- `net.models {baseUrl, apiKey}` → `{ok, models, error}`
- `net.chat {baseUrl, apiKey, model, messages, params, timeoutMs}` → `{ok, text, usage, error}`
- `net.stream {baseUrl, apiKey, model, messages, params, timeoutMs}` → 事件 `{type:'delta', text}` / `{type:'done', usage}` / `{type:'error', error}`；`Bridge.stream` 返回句柄
- `secure.set/get/del {key, value}` → `{value}` / `{ok}`
- `ui.toast {text}`、`ui.copy {text}`、`ui.pickImage {}` → `{dataUri,name}`、`ui.statusBar {dark,color}`、`ui.vibrate {ms}`
- `file.export {name, mime, data(text)}` → `{ok}`；`file.import {}` → `{name, data}`
- `app.info {}` → `{version, platform, apiLevel}`
- `app.setBackGuard {enabled}`（可选，Lead 处理）
- 浏览器 mock：`Bridge.available=false`，上述均有假实现（net.stream 吐示例文本，secure 用 localStorage，file.export 触发下载）。**页面不要判断 available，直接用**。

### 6.6 App.API
```js
API.errorInfo(err) -> {code, title, hint}       // 401/403/404/429/timeout/offline/dns/tls/5xx/unknown
API.testProvider(provider) -> {ok, models, error}
API.chatStream({provider, model, messages, params, onDelta, onDone, onError}) -> {abort()}
API.chatOnce({provider, model, messages, params}) -> {ok, text, usage, error}
API.completion({provider, model, system, user, timeoutMs}) -> {ok, text, error}
API.checkProviderReady(provider) -> {ok, reason} // 缺 key/baseUrl 时提示
```
- 真实 key 通过 `Bridge.secure.get('key:'+provider.id)` 取；`API` 内部负责取 key，页面不碰 key 明文。
- `messages` 结构：`[{role:'system'|'user'|'assistant', content}]`；`params` 见 presets.params。
- 错误统一返回 `{ok:false, error:{code,message}}`，UI 用 `API.errorInfo` 转中文。

### 6.7 App.Help（D 提供，A/B/C 调用）
`App.Help.open({source, page, error})`：打开引导助手底部抽屉，复用聊天组件，独立 help 会话；`error` 形如 `{code, message}` 时自动带上下文。

### 6.8 App.Bubble（D 提供，Lead 挂载）
`App.Bubble.mount()`；`App.Bubble.getContext()`（当前页 guide 上下文）；`App.Bubble.refresh()`。

### 6.9 App.Guide（D 提供）
`Guide.buildNextStepPrompt(ctx) -> {system,user}`、`Guide.parseNextStep(raw) -> {summary, steps:[{text, action:{type,target}}]} | null`、`Guide.handleAction(action)`（navigate/focus/tap）。

### 6.10 App.Prompts / App.Data（C、D 提供）
C：`Prompts.characterCompletion({type, domain, specialty, worldview, draft})`、`Prompts.characterRewrite({card, instruction, type})`、`Prompts.parseCharacter(raw, ctx)`、`Prompts.worldviewCompletion({name, rawInput})`、`Prompts.parseWorldview(raw)`、`Prompts.companionSystemPrompt(card, worldviewSnapshot)`、`Prompts.assistantSystemPrompt(card)`。
`Data.WORLDVIEW_PRESETS`（恰好 7 个：现代都市/古代宫廷/校园日常/赛博朋克/ABO/斗破苍穹/无）、`Data.DOMAINS`（10 领域→专业映射）、`Data.BUILTIN_PRESETS`（陪聊/助手默认预设）。
D：`App.Data.FAQ`（静态 FAQ 列表 `{q,a,category}`）、`Guide` 的「怎么走」prompt。

## 7. 引导（onboarding）状态机（A 实现）

`welcome → provider → key → test → model → done`，可回退且不丢数据；`settings.onboarding_completed` 只在 test 成功后置 true；主界面入口由 `main.js` 判断：未完成 → 强制 `Router.push('onboarding')`，且不可返回。
- 供应商快捷预设：OpenAI `https://api.openai.com/v1` / DeepSeek `https://api.deepseek.com/v1` / OpenRouter `https://openrouter.ai/api/v1` / 硅基流动 `https://api.siliconflow.cn/v1` / 自定义。
- 测试连接：`API.testProvider`，失败展示可读原因 +「这是什么意思？」；成功后展示 model 列表，可选/手填。
- 完成页勾选「同时用作默认聊天 API」（默认勾选）→ 写 providers(role=guide) + settings。
- 每步右上角「?」→ `App.Help.open({source:'guide_wizard', page:'...'})`。

## 8. 功能清单（按成员）

**A**：onboarding（§7）、API 管理（列表含引导徽标、增删改、测试、设为默认聊天/设为引导、模型与最近状态）、API 编辑页、设置页（主题浅/深/AMOLED、默认预设、补全设置、使用帮助、数据导入/导出、清空数据、关于、悬浮气泡开关/重置位置、引导 API 状态）。
**B**：聊天列表（排序/搜索/置顶/长按删除/新建选角色/未读与生成中标记）、聊天页（流式、停止、重发、编辑、复制、删除、继续生成、上滑加载更早、多版本 variants、token 统计、断网只读提示）、预设编辑页（采样参数 + system prompt，两类角色默认预设不同）。
**C**：角色列表（陪聊/助手分段、编辑/复制/删除/开始聊天）、创建向导 5 步（类型/领域专业→世界观→粗略 4 输入→选补全 API + 流式进度 → 预览/保存/让 API 改/手动改/回滚）、角色编辑、世界观库（7 预设只读 + 复制自定义 + 引导 API 补全 + 草稿 + 保存）、`prompts.js` 与 JSON schema 校验重试、`data/worldviews.js` `data/presets.js`。
**D**：引导助手抽屉（独立 help 会话、上下文注入、静态 FAQ 兜底、清空）、使用帮助页、关于页、悬浮引导气泡（52dp 小球、拖动吸附左右、位置记忆、点击扇形 3-4 气泡、长按直接「怎么走」、双击收起、20% 遮罩、3s 降透明度、键盘上移、聊天输入聚焦淡出、首次引导提示、无障碍标签、减弱动效）、`guide.js` 的「怎么走」prompt/JSON 解析/action 执行（navigate/focus/tap 高亮）。

## 9. 悬浮气泡上下文结构（D 定稿，A/B/C 在 build 里用 page.guide 注册）

```js
page.guide({
  pageId: 'characterCreate',      // 稳定英文 id
  title: '创建角色 · 第 3 步 粗略填写', // 中文页面名（注入用）
  stage: 3, totalSteps: 5,
  filledFields: { name: true, personality: false },  // 只放字段名与是否已填
  missingFields: ['personality'],
  error: { code: '401', message: 'Unauthorized' } | null
});
```
**禁止**注入 Key、聊天正文、备份内容、设备标识。

## 10. 错误码 → 中文（API.errorInfo & UI.errorText 统一）

401 Key 无效/未授权；403 无权限；404 路径不对；429 限流；5xx 服务端错误；timeout 超时；offline 网络不可用；dns 域名解析失败；tls 证书错误；cancel 已取消；unknown 未知错误。
错误提示下方提供「这是什么意思？」→ `App.Help.open({source:'error_hint', error})`。

## 11. 微信式 UI 硬性要求

- 底部 4 Tab 短标签：聊天/角色/API/设置；页面标题用全称（聊天/角色管理/API 管理/设置）。
- 聊天为默认首屏；Top navbar；列表细分割线左缩进；圆形头像；消息气泡微信配色（me `--bubble-me` 绿、ai 白/深灰）。
- 状态齐全：空态/加载/错误/断网/生成中；禁 TODO、假数据、空函数。
- 悬浮小球浮在 Tab 与二级页之上，不遮挡 Tab 栏、输入框、发送按钮。

## 12. settings 键

`onboarding_completed, onboarding_version, theme, default_chat_provider_id, guide_provider_id, character_gen_provider_id, character_gen_model, bubble_enabled, bubble_position:{edge:'left'|'right',y:0..1}, bubble_hint_shown, help_cleared_at, last_tab, draft_character:{...}, draft_worldview:{...}`

## 13. 协作规则

1. 只写自己文件；不新建文件；不改 base/index.html/android/scripts。
2. 每写完一个 JS 跑 `node --check <file>`；标题/按钮文案用中文。
3. 页面必须处理空态/加载/错误态；所有异步 catch。
4. 不要 `alert/prompt/confirm`；用 `UI.*`。
5. 不确定接口先读本契约；再不确定找 Lead，不要臆造。

## 14. 本次迭代（图片库 / 附件 / 动作斜体 / 上帝模式）

详细契约见 `docs/FEATURE-media-god.md`。此处只列与其他模块相关的硬性约定：

- DB 版本升至 2，新增表 `characterImages`（keyPath `id`，index `characterId`）：`{id, characterId, kind:'image', name, caption, mime, dataUri, size, source:'user'|'guide', createdAt}`。导出备份会自动包含该表。
- 消息附件字段：`messages.attachments = [{kind:'image'|'file', name, mime, size, dataUri?, text?, truncated?}]`，本期每条消息最多 1 个。
- settings 新键：`god_mode:boolean`（默认 false）。
- 新全局模块 `App.Media`（`js/media.js`，加载顺序在 db.js 之后）：`pickImage/pickFile/addImage/list/get/update/remove/removeByCharacter/count/promptBlock/preview/fileSizeText`，接口与限制见功能契约 §2。
- 系统提示词图片库规则：`App.Media.promptBlock(images)` 返回整段文本（含 `[[img:ID]]` 规则），`K.buildSystemPrompt` 直接追加；回复中 `[[img:<id>]]` 由聊天页渲染成图片。
- 表达格式：动作/神态用 `*星号*`，`K.md` 渲染为 `<em class="md-action">`；人物说的话用正文。
- 删除角色时由 `characters.js` 调 `App.Media.removeByCharacter` 级联清理图片库。

## 15. v1.2.0 迭代（主动消息 + 问候语）

> 完整契约见 `docs/FEATURE-proactive-greetings.md`（实现前必读）。要点：

- `characters.alternateGreetings: string[]`（备选问候语，0~10 条，每条 ≤200 字）；`firstMessage` 即**首选问候语**。
- `sessions.greetingIndex: number`（0=首选，1..N=第 N 条备选，缺省 0）；换开场白仅允许在会话无用户消息时。
- settings 新键：`proactive_enabled`(bool) / `proactive_interval_min`(15|30|60|120) / `proactive_last_at`(ts) / `proactive_day`(YYYY-MM-DD) / `proactive_day_count`(0~3)。
- 前端模块 `App.Proactive`（`js/proactive.js`，Lead 所有）：`init()/setEnabled(bool)/getEnabled()/getIntervalMin()/setIntervalMin(n)/status()/checkNow()`；原生桥方法 `notify.schedule/notify.cancel/notify.status/notify.requestPermission`。
- 聊天页「…」菜单新增 `greeting`「换个开场白」；设置页新增分组「角色主动消息」；角色编辑页新增「问候语」入口。
- 本迭代禁止修改 `keystore/`；构建必须复用现有签名库（证书 SHA-256 `F4AAA0A8…`），版本 `1.2.0`/`versionCode 4`。
