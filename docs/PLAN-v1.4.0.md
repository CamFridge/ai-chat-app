# v1.4.0 迭代契约（世界书 / 群聊 / 角色卡 V2 / 多 persona / 消息分支 / 预设文本模式）

> 本文件是本次迭代**唯一接口契约**，先读完再动手。冲突时以本文件为准，其次 `docs/CONTRACT.md`。
> 目标版本：**1.4.0 / versionCode 13**；构建与签名由 Lead 统一做（keystore 不变，证书 SHA-256 `F4AAA0A8…`）。
> 当前 APK 基线：1.3.5 已构建验证通过。**不要跑模拟器、不要跑无头 Chrome、不要跑 E2E**（机器负载要求）；每题写完跑 `node --check <文件>`。

## 0. 本轮 6 项需求（用户原话编号）

| # | 需求 | 负责人 |
|---|---|---|
| 1 | **世界书 Lorebook**：触发词注入、优先级、token 预算、世界观一键生成条目 | L（lorebook） |
| 2 | **群聊**：多角色参与同一会话，模型/规则决定谁发言 | G（group） |
| 3 | **TavernAI / SillyTavern V2 角色卡导入导出**（仅陪聊角色） | T（tavern） |
| 4 | **多 persona 管理与切换** | P（persona） |
| 6 | **从某条消息分支对话** | Lead（chat.js） |
| 7 | **预设 `mode='text'` 行为**（纯文本输出模式） | Lead（preset-edit.js / prompts / chat.js） |

## 1. 数据层：DB 版本升到 **4**（Lead 在 `js/db.js` 实现，其他人只通过 `App.DB` 读写）

新增表（keyPath 均为 `id`）：

```js
// 世界书（挂在角色或世界观上；本轮以角色为主）
lorebooks: { id, name, characterId:'', worldviewId:'', enabled:true, tokenBudget:400, createdAt, updatedAt }
// 世界书条目
loreEntries: { id, lorebookId, keys:['艾琳','队长'], secondaryKeys:[], content:'条目正文（≤800字）',
               name:'条目名（可选，用于展示）', priority:100, enabled:true, caseSensitive:false,
               alwaysOn:false, createdAt, updatedAt }
// 群聊定义（会话里存 members 快照，改群成员不影响历史会话的显示名）
groups: { id, name, characterIds:[], avatar:'', createdAt, updatedAt }
```

索引：`loreEntries.lorebookId`、`lorebooks.characterId`、`groups`（无）。

既有表**只加字段、不改旧字段语义**：

```js
sessions: kind:'single'|'group'（缺省 single）, characterIds:[], groupId:'', personaId（已存在）,
          presetId（已存在）, scene（已存在）, lorebookIds:[]（可选：参与注入的世界书 id）
messages: characterId:''（群聊发言人角色 id）, speakerName:''（渲染用名字快照）
presets:  mode:'chat'|'text'（已存在，本轮让 text 真正生效）
characters: tavern?:{creator, characterVersion, tags:[], creatorNotes, systemPrompt, postHistoryInstructions}
            —— 导入 V2 角色卡时保存原始扩展信息（可选字段，导出时优先用它们还原）
```

备份导出（`DB.exportAll`）会自动包含新表（Lead 已处理）。

## 2. 新增全局模块（只允许这 4 个新全局，其余一律不加）

### 2.1 `App.Lorebook`（L 实现，文件 `js/lorebook.js`）
```js
Lorebook.buildInjection(opts) -> Promise<string>
// opts: { text:string,            // 用于关键词匹配的最近上下文纯文本（chat.js 已拼好）
//         characterId:string,
//         lorebookIds?:string[],  // 不给则用该角色关联、enabled 的 world book
//         tokenBudget?:number }
// 行为：读 lorebooks/loreEntries → 启用条目中 keys 任一命中 text（caseSensitive=false 时忽略大小写；
//      有 secondaryKeys 时要求至少一个命中；alwaysOn 条目直接命中）→ 按 priority 降序累加，
//      估算 token（App.Util.estimateTokens）相加超过 tokenBudget 即停止 →
//      返回纯文本块："【世界书】\n- 条目名：内容\n- …"，无命中返回 ''。
//      任何异常必须 catch 并返回 ''（绝不能阻断聊天）。
Lorebook.ensureForCharacter(characterId) -> Promise<lorebook>   // 无则创建（name 取角色名+'的世界书'）
Lorebook.listForCharacter(characterId) -> Promise<lorebook[]>
Lorebook.generateEntries({ lorebookId, worldText, provider, model }) -> Promise<{created:number}>
// 用 App.API.chatOnce 让模型按 JSON 生成 3~6 条条目（keys/content/name/priority），严格解析、失败重试 1 次；
// 失败抛错由页面展示。worldText 取角色卡（personality/habits/background/scenario/worldviewSnapshot）。
```

### 2.2 `App.Group`（G 实现，文件 `js/group.js`）
```js
Group.membersOf(session) -> Promise<Array<{id, name, avatar, character}>>  // 按 session.characterIds 顺序，缺失角色跳过
Group.buildContext(opts) -> { messages, usedTokens, systemTokens, dropped }
// opts: { session, members:[{id,name,character}], persona, preset, messages:[原始消息],
//         godMode:boolean, scene:string, lore:string, tokenBudget?:number }
// 规则：
//  - system 里写明：这是多角色群聊，成员名单（名字+一句人设）；每次只由**一位**成员发言；
//    回复第一行必须是 "【角色名】"，否则视为当前默认发言者；
//  - 历史 assistant 消息按 msg.speakerName 前缀为 "角色名：内容"，user 消息前缀 "用户名："；
//  - 复用 App.ChatKit.TOKEN_BUDGET 做裁剪（system 不丢、保留最近一轮）；
//  - preset.instructTemplate / persona 设定 / 世界书 lore / 上帝模式 都要拼进 system（可参考
//    App.ChatKit.buildSystemPrompt 的拼接顺序，但**不要改 chat-list.js**）。
Group.decideSpeaker(opts) -> Promise<{ characterId, name }>
// opts:{ session, members, messages, provider, model }
// 用 App.API.chatOnce 发一个小 JSON 请求（最近 6 条对话 + 成员名单），
// 期望 {"characterId":"...","why":"..."}；非法/失败/未配置 provider 时退回"轮换"：上一条 assistant
// 的发言人之后的那个成员（没有则第一个）。永不 reject（内部兜底）。
Group.parseSpeakerReply(text, members, fallback) -> { characterId, name, content }
// 解析模型回复首行 "【名字】"：命中成员名 → 返回去掉首行的正文；未命中 → fallback 发言人 + 原文。
Group.create({ name, characterIds }) -> Promise<group>   // 建群 + 建群聊会话（kind:'group'、characterIds、providerId/model/presetId 取默认，
//   title=群名、greetingIndex:-1、scene:''）；返回 { group, session }
Group.addMembers(session, characterIds) -> Promise<session>
Group.removeMember(session, characterId) -> Promise<session>  // 至少保留 2 人，否则报错
```

### 2.3 `App.Persona`（P 实现，文件 `js/persona.js`）
```js
Persona.list() -> Promise<persona[]>                     // 全部（按 updatedAt 倒序）
Persona.getDefaultId() -> Promise<string>                // settings.default_persona_id
Persona.setDefault(id) -> Promise<void>
Persona.ensureDefault() -> Promise<persona>              // 无默认且无任何 persona 时创建「我」
Persona.resolve(personaId) -> Promise<persona|null>      // 取不到返回 null
Persona.promptLine(persona) -> string                    // '【用户设定】用户扮演：…'（空返回 ''）
Persona.pickForSession(sessionId) -> Promise<persona|null>
// 弹 App.UI.sheet：所有 persona + 「不设定身份」；选中后写 sessions.personaId 并返回该 persona
// （选「不设定」返回 null 并把 session.personaId 置 ''）。取消返回 undefined。
```

### 2.4 `App.Tavern`（T 实现，文件 `js/tavern.js`）
```js
Tavern.parseV2(input) -> { ok, card, warnings:[], error }   // input 为 JSON 字符串或对象
// 兼容 spec:'chara_card_v2' 与 v1（无 spec 的简单 {name, description, personality, scenario, first_mes}）；
// 字段映射：name→name, description→background, personality→personality, scenario→scenario,
//          first_mes→firstMessage, alternate_greetings→alternateGreetings, mes_example→exampleDialogues,
//          system_prompt/post_history_instructions/tags/creator/character_version→characters.tavern;
// 校验：name 必填、type 固定 'companion'；不支持的消息：warnings 里逐条中文说明。
Tavern.toV2(character) -> object                            // 生成完整 V2 JSON（spec:'chara_card_v2', spec_version:'2.0'）
Tavern.importCard(card) -> Promise<character>               // 落库（type:'companion'、字段按映射、systemPrompt 用 App.Prompts.buildSystemPrompt 重建）
Tavern.exportCard(character) -> Promise<{ok, error}>        // 走 App.Bridge.call('file.export', {name:'<名字>.json', mime:'application/json', data:json})；
                                                            // 浏览器 mock 会触发下载，不要直接 a.href 下载（统一走 Bridge）
Tavern.openImport()                                         // 选文件（Bridge file.import）→ 预览卡片 → 确认导入 → 成功后 Router.push('characterEdit',{id})
Tavern.openExport(character)                                // 弹确认 → exportCard → toast
```

## 3. 页面注册（新页面名不得与现有冲突）

现有：`onboarding, apiList, apiEdit, settings, chatList, chat, presetEdit, characters, characterCreate, characterEdit, worldviews, help, about`。

| 页面名 | 文件 | 负责人 | 说明 |
|---|---|---|---|
| `lorebook` | `js/pages/lorebook.js` | L | 某角色的世界书条目列表（增删改排序启用）；`params:{characterId}` |
| `lorebookEdit` | `js/pages/lorebook-edit.js` | L | 条目编辑（keys/secondaryKeys/content/priority/alwaysOn） |
| `lorebookGen` | `js/pages/lorebook-gen.js` | L | 「根据角色卡一键生成条目」预览页（生成结果可勾选批量保存） |
| `groupCreate` | `js/pages/group-create.js` | G | 建群：群名 + 勾选 ≥2 个角色 → `App.Group.create` → Router.pop 后进聊天 |
| `groupManage` | `js/pages/group-manage.js` | G | 群成员管理（加/减成员、改名、解散） |
| `personas` | `js/pages/personas.js` | P | 我的身份列表（默认标记、增删改） |
| `personaEdit` | `js/pages/persona-edit.js` | P | 身份编辑（名字/设定/头像） |
| `tavern` 无需页面 | `js/tavern.js` | T | 用 `App.UI.modal` 做导入预览与导出确认即可 |

`js/pages/*.js` 仍按 `App.Router.register(name, {tab:false, title, build(root, params, page)})` 注册；`build` 内自行处理加载/空态/错误态。

## 4. 聊天页（Lead 写死的钩子，其他人**不要**改 chat.js）

Lead 在 `js/pages/chat.js` 里加以下行为，其他模块按上面签名实现即可被调用：

1. **世界书**：每次生成前 `App.Lorebook.buildInjection({text, characterId, lorebookIds})`，结果作为 `lore` 传给 `buildContext`（`App.ChatKit.buildSystemPrompt` 第 4 参 `lore`）；`text` = 最近 8 条消息正文 + 用户本次输入拼接。
2. **群聊**：`session.kind==='group'` 时走 `App.Group.membersOf` / `App.Group.decideSpeaker` / `App.Group.buildContext`；回复落库时写 `characterId`、`speakerName`；气泡上方渲染发言人名字+小头像；会话菜单加「群成员」→ `Router.push('groupManage',{sessionId})`。
3. **persona**：会话菜单加「我的身份」→ `App.Persona.pickForSession(sessionId)`，返回 persona 写回 `st.persona`，返回 null 用匿名「我」。
4. **消息分支**：消息菜单加「从这里分支」→ 复制该消息（含）之前的全部消息到新会话（同角色/预设/provider/场景），新会话标题加「（分支）」，当前会话不动，然后 `Router.push('chat',{sessionId:新id})`。
5. **预设文本模式**：`preset.mode==='text'` 时 `App.ChatKit.buildSystemPrompt` 追加文本模式约束（纯文本输出、不用对话格式与 `*动作*`、不用 `[[img:]]`），聊天页对该会话关闭动作斜体渲染与图片标记渲染。

## 5. 文件所有权（本迭代，覆盖 CONTRACT.md）

| 成员 | 只允许写 |
|---|---|
| Lead | `index.html`、`css/base.css`、`js/db.js`、`js/prompts.js`、`js/pages/chat.js`、`js/pages/preset-edit.js`、`scripts/**`、`docs/**`、`build.ps1` 版本号 |
| L lorebook | `js/lorebook.js`、`js/pages/lorebook.js`、`js/pages/lorebook-edit.js`、`js/pages/lorebook-gen.js`、`css/pages-lorebook.css`、`js/pages/character-edit.js`（只加「世界书」入口）、`js/pages/worldviews.js`（只加「生成世界书」入口） |
| G group | `js/group.js`、`js/pages/group-create.js`、`js/pages/group-manage.js`、`css/pages-group.css`、`js/pages/chat-list.js`（新建菜单加「新建群聊」、列表群聊标识、删除群聊会话级联 `groups` 记录） |
| P persona | `js/persona.js`、`js/pages/personas.js`、`js/pages/persona-edit.js`、`css/pages-persona.css`、`js/pages/settings.js`（只加「我的身份」入口） |
| T tavern | `js/tavern.js`、`css/pages-tavern.css`、`js/pages/characters.js`（角色列表「⋯」加「导入角色卡 / 导出角色卡」）、`js/pages/character-create.js`（第 1 步加「导入角色卡」入口，复用 App.Tavern） |

**禁止**互改文件；需要别人文件里的入口请在本文件 §7 里记录，最终由 Lead 或该文件 owner 统一检查。

## 6. 新增文件加载（Lead 负责改 `index.html`，顺序如下，其他人不要动 index.html）

```
js/db.js → js/lorebook.js → js/group.js → js/persona.js → js/tavern.js
→ js/router.js → js/ui.js → js/api.js → js/data/* → js/prompts.js
→ js/pages/*（新增页面文件放在 worldviews.js 之后、help.js 之前）
```
CSS 追加：`css/pages-lorebook.css`、`css/pages-group.css`、`css/pages-persona.css`、`css/pages-tavern.css`。

## 7. 入口清单（谁在哪个文件加）

- 角色编辑页「世界书」入口 → L（`js/pages/character-edit.js`，push `lorebook`）
- 世界观页「生成世界书条目」→ L（`js/pages/worldviews.js`）
- 聊天列表「新建」sheet 增加「新建群聊」；会话行渲染群聊头像/标题 → G（`js/pages/chat-list.js`）
- 聊天页「群成员」入口 → Lead（`chat.js`）
- 设置页「我的身份」→ P（`js/pages/settings.js`）
- 聊天页「我的身份」切换 → Lead（`chat.js`）
- 角色列表「⋯：导入角色卡 / 导出角色卡」、创建向导第 1 步「导入角色卡」→ T（`characters.js`、`character-create.js`）
- 聊天页「从这里分支」→ Lead（`chat.js`）
- 预设编辑页「文本模式」说明与生效提示 → Lead（`preset-edit.js`）

## 8. 编码硬性要求

1. 每个文件写完 `node --check <file>`，必须 0 退出。
2. ES5+（可选链 `/` 模板字符串可用，但不要 import/export）；全局只挂 `window.App`。
3. 用户数据插入 DOM 一律 `App.Util.esc()` / `App.UI.el`，**禁止**用 `innerHTML` 拼用户内容（静态图标 HTML 除外）。
4. 不用 `alert/confirm/prompt`，用 `App.UI.toast/confirm/prompt/sheet/modal`。
5. 所有异步 `catch`；页面必须有空态/加载/错误态。
6. 调用别人的模块一律**防御式**：`if (App.X && typeof App.X.f === 'function')`，失败给出可读提示，不要 throw 到页面外。
7. 所有新 UI 文案中文；风格对齐微信式（列表 `.cell`、底部 `.btn`、`.card`、`.empty`）。不要引入第三方库、不要新增图片资源。
8. 不要改 `js/db.js` 表结构（Lead 已定稿）；不要改 `android/**`、`scripts/**`、`index.html`、`css/base.css`。
9. 不要跑模拟器/无头浏览器/E2E；不要构建 APK（Lead 统一构建）。
