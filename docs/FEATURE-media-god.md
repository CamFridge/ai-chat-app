# 功能扩展契约：角色图片库 / 图片文件消息 / 动作斜体 / 上帝模式

本文件是本次迭代的最终契约，四个并行开发模块都必须遵守。写代码前先读它和 `docs/CONTRACT.md`。

## 0. 文件所有权（本次迭代）

| 成员 | 可写文件 |
|---|---|
| Lead | `js/db.js`、`js/media.js`(新增)、`js/api.js`、`index.html`、`android/src/**`、`scripts/**`、`docs/**`、`css/base.css` |
| feat-chat | `js/pages/chat-list.js`、`js/pages/chat.js`、`css/pages-chat.css` |
| feat-char | `js/pages/character-edit.js`、`css/pages-char.css` |
| feat-guide | `js/pages/help.js`、`js/guide.js`、`js/data/faq.js`、`css/pages-guide.css` |
| feat-config | `js/pages/settings.js`、`css/pages-config.css` |

禁止改别人的文件；需要跨文件接口时只依赖本文件写明的 `App.Media` / 消息字段 / 设置键。

## 1. 数据模型新增

### 1.1 `characterImages` 表（DB v2，Lead 已实现）

```js
// 表名 characterImages，keyPath id，index: characterId
{
  id: 'img_<uid>',
  characterId: 'char_xxx',
  kind: 'image',          // 本期只存 image；文件只作为消息附件，不入库
  name: '雨天书店.jpg',    // 展示名，可改
  caption: '下雨天的旧书店', // 可选，给模型看的说明
  mime: 'image/jpeg',
  dataUri: 'data:image/jpeg;base64,...',
  size: 18234,             // 字节
  source: 'user' | 'guide',
  createdAt: 1730000000000
}
```

### 1.2 消息附件（messages 表字段扩展，无需新建表）

```js
{
  // 原有字段不变……
  content: '给你看看这个',            // 文本部分，可为空字符串
  attachments: [                     // 0..1 个（本期只允许 1 个）
    {
      kind: 'image' | 'file',
      name: '雨天.jpg',
      mime: 'image/jpeg',
      size: 18234,
      dataUri: 'data:image/jpeg;base64,...',  // kind=image 才有
      text: '文件文本内容（≤8000 字，kind=file 才有）',
      truncated: false
    }
  ]
}
```

### 1.3 设置键新增

- `god_mode`：boolean，默认 `false`。设置页开关写入；聊天系统提示词读取。

## 2. `App.Media`（Lead 实现，`js/media.js`）

```js
Media.supported()                       // 是否可用（恒 true；内部处理 Bridge mock）
Media.pickImage(opts)                   // → Promise<{kind:'image',name,mime,size,dataUri}|null>
Media.pickFile(opts)                    // → Promise<{kind:'file',name,mime,size,text,truncated}|null>
Media.addImage(characterId, att, meta)  // att 来自 pickImage；meta={caption,source}；→ Promise<record>
Media.list(characterId)                 // → Promise<record[]>（按 createdAt 升序）
Media.get(id)                           // → Promise<record|null>
Media.update(id, patch)                 // patch={name,caption}；→ Promise<record>
Media.remove(id)                        // → Promise<true>
Media.removeByCharacter(characterId)    // → Promise<n>
Media.count(characterId)                // → Promise<number>
Media.promptBlock(list)                 // → 字符串：给系统提示词的图片清单；空数组返回 ''
Media.preview(dataUriOrRecord, opts)    // 打开全屏预览浮层（App.UI.modal 实现，供各处复用）
Media.guessName(fileName)               // 兜底展示名
```

限制：单图 ≤ 3MB dataUri 长度（约 2.2MB 原图）；`pickImage` 走原生压缩（≤320px JPEG），浏览器 mock 用 FileReader；超限返回 `onError('图片太大了…')` 由 `pickImage` reject。

## 3. 角色图片库 UI（feat-char）

- 入口：`character-edit` 页表单区新增一行「角色图片库」，副标题显示「N 张 · 可让 TA 在聊天里发给你」。
- 点击打开 `UI.modal`（全屏高度 80vh）：
  - 顶部说明：这些图片角色可以在聊天里「发给你」，点右下角「＋ 添加图片」从相册选；
  - 网格 `.ck-img-grid`：每格 `<img>` 缩略图 + 名称；点开 `Media.preview`；
  - 每格右上角「⋯」→ sheet：重命名 / 修改说明 / 删除（二次确认）；
  - 空态文案：「还没有图片。添加后，聊天时角色可以主动发给你。」
  - 底部按钮：「添加图片」（也可放右下浮动按钮，任选，保证 44px 高度）；
  - 「让引导助手帮我加」：点击跳 `App.Help.open({source:'character_images', page:'characterEdit'})` 并 toast 提示「在帮助抽屉里发图并说『加到<角色名>的图片库』」。
- 数据变化后刷新本页行副标题；`node --check` 通过。
- `data-guide-focus="characterImages"`、`data-guide-tap="addCharacterImage"` 加到入口行与添加按钮，供气泡「怎么走」使用。

## 4. 聊天页：附件发送 / 角色发图 / 动作斜体 / 上帝模式（feat-chat）

### 4.1 用户发送图片或文件

- composer 左侧新增「＋」按钮（`.composer-attach`，data-guide-tap="attach"）：弹出 `UI.sheet`：
  - 「相册图片」→ `Media.pickImage()`；
  - 「文件」→ `Media.pickFile()`（文本类文件，内容截断 8000 字，提示「文件内容会作为文本发给模型」）。
- 选中后输入框上方出现附件 chip（`.composer-attach-chip`：缩略图/文件图标 + 名称 + ×），发送时一并写入 `message.attachments`，发送后清空。
- 空文本但有附件时允许发送；此时气泡只显示附件（图片消息隐藏空文本）。
- 消息渲染：
  - 图片：`.msg-attach-img` 缩略图（最大 220×220，圆角），点击 `Media.preview`；
  - 文件：`.msg-attach-file` 卡片（图标 + 名称 + 大小），点击 `UI.modal` 显示文本内容（≤8000 字）。
- 其他兜底：附件读取失败 toast，不发送。

### 4.2 角色主动发图片

- 系统提示词里加入图片库清单与规则（由 `K.buildSystemPrompt` 生成，feat-chat 实现）：
  - 每条格式：`- ID=<id>｜名称=<name>｜说明=<caption>`
  - 规则：「你可以在回复中给用户发你图片库里的图片：单独一行写 `[[img:图片ID]]`，可前后配一句话。只能使用上面列出的 ID，禁止编造。」
  - 图片数量 ≤ 30 时全部列出，超出取最近 30 张；`caption`/`name` 里可能含换行，需压缩为单行。
- 渲染：assistant 气泡内容按 `\[\[img:([A-Za-z0-9_\-]+)\]\]` 切分：
  - 文本段 → `K.md()` 渲染；
  - 图片段 → 用 `Media.get(id)` 异步取缩略图渲染 `.msg-image`（最大宽 220、圆角、点击预览）；图片不存在/被删 → `.msg-image-missing`「图片已不可用」。
- 流式生成中允许暂时显示未闭合文本；`finalize` 后按完整内容重渲染即可（沿用 replaceMsgEl）。
- 头像、时间、tokens 等原逻辑不变。

### 4.3 动作/神态斜体

- `K.md` 的 `inlineMd` 新增单星号斜体：`*动作*` → `<em class="md-action">动作</em>`（在 `**bold**` 之后匹配；未闭合不转换）。
- 系统提示词追加「表达格式」段：
  ```
  【表达格式】动作、神态、环境描写用 *星号包裹*（例如 *她低头笑了笑*），人物说出的话直接用正文，不要整段加引号。
  ```
- 样式（feat-chat 写 `css/pages-chat.css`）：`.msg-bubble .md-action { font-style: italic; font-weight: 300; color: var(--text-2); font-size: .97em; }`；暗色沿用变量。
- 用户消息不做该转换（纯文本）。

### 4.4 上帝模式

- `chat.js` 加载时读 `DB.settings.get('god_mode', false)`，值变化（页面重建）后生效。
- 传给 `K.buildContext({..., godMode:true})`；`K.buildSystemPrompt` 末尾追加：
  ```
  【上帝模式】你清楚自己只是这个 App 里的虚拟角色，由 AI 扮演，不是真实的人。用户可以随时和你聊这件事；
  承认这一点时保持角色口吻，不要破坏设定，也不要假装自己是真人或声称有真实身体/现实经历。
  ```
- 设置页开关的副标题写「角色知道自己只是虚拟角色，可和你聊这件事」。

### 4.5 buildContext / attachments

- `K.buildContext` 保留消息 `attachments` 字段并传给 `App.API.toApiMessages`（Lead 在 api.js 里按附件拼多模态 content 数组）；`estimateTokens` 对图片附件按 85 tokens/图估算，文件文本按实际字数。
- `K.buildSystemPrompt(character, persona, preset, opts)`：`opts={godMode, images}`；`images` 为 `Media.list(character.id)` 结果（chat.js 在 buildContext 前异步取好传入；不改变现有调用签名兼容性——第 4 参可选）。

## 5. 引导助手：帮我给角色加图（feat-guide）

- `help.js` 抽屉输入区新增「＋」附件按钮（`.help-attach`）→ `Media.pickImage()`。
- 选中后在输入框上方显示 chip；发送时用户消息带 `attachments`（helpMessages 允许存 dataUri）。
- 发送后若本条消息**带图片附件**：助手回复末尾（或气泡下方）渲染操作按钮 `.help-img-action`「加到角色图片库」。
  - 点击 → `UI.sheet` 列出所有角色（`DB.all('characters')`，最多 30，显示头像/名字/类型）→ 选角色 → `Media.addImage(charId, attachment, {source:'guide', caption: 用户消息文本前 40 字})` → toast「已加入 <角色名> 的图片库，聊天时可以发给你」。
  - 该操作不依赖模型回复内容（模型可能不返回 JSON），是本地确定性能力。
- 文本里出现「图片库/加图/能发的图片」等关键词且最近有图片附件时，助手回复可提示该按钮（静态文案兜底即可）。
- `data/faq.js` 增加 2 条 FAQ：「怎么让角色给我发图片」「上帝模式是什么」。
- `guide.js` 仅在必要时加 `PAGE_LABELS`；不要引入新的模型动作 JSON 类型。

## 6. 设置页：上帝模式（feat-config）

- `settings.js` 在「角色与聊天」相关分区新增开关行：「上帝模式」，副标题「开启后角色知道自己只是虚拟角色，可以和你聊这件事」。
- 读写 `DB.settings.get/set('god_mode', bool)`；切换后 toast「已开启上帝模式」/「已关闭上帝模式」。
- 页面上加一行说明：「图片库与发图：在角色编辑页管理图片；聊天/帮助里可发图片和文件」。
- `data-guide-focus="godMode"` 加到行上。

## 7. 验收点（E2E 会覆盖）

1. 角色编辑页可添加/查看/删除图片，数据落在 `characterImages` 表，删除角色时图片一并清理（Lead 处理角色删除级联？feat-char 不处理；由 C 的删除逻辑扩展，Lead 兜底）。
2. 聊天页可发送图片与文本文件，消息落库后重进聊天仍能显示；图片可点开预览。
3. 助手回复 `[[img:id]]` 渲染为图片，删除库中图片后显示「图片已不可用」而不是报错。
4. `*动作*` 渲染为斜体细字体，普通对话不变；`**加粗**`、代码块、列表不回归。
5. 设置→上帝模式开启后，系统提示词包含【上帝模式】段；关闭后不含。
6. 帮助抽屉发图后可一键加入某角色图片库。
7. 现有 6 套 E2E 脚本全部保持通过（改选择器/文案需同步）。
