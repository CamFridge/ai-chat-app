# AI 聊天 · 交付说明

按 `prompt-01-需求提示词.md` 实现的 Android 应用，已构建并签名。

## 1. 交付物

| 文件 | 说明 |
| --- | --- |
| `ai-chat-app/build/AI-Chat-1.3.0.apk` | 签名后的安装包（可直接安装） |
| `ai-chat-app/keystore/aichat-release.jks` | 签名密钥库（alias `aichat`，口令 `aichat2026`） |
| `ai-chat-app/scripts/build.ps1` | 一键构建脚本（aapt2 → javac → d8 → zipalign → apksigner） |
| `ai-chat-app/android/` | 原生壳源码 + 前端资源（`assets/www`） |
| `ai-chat-app/scripts/*.js` | 无头 Chrome 冒烟 / E2E 与设备端 E2E 脚本（开发期工具，不进入 APK） |
| `ai-chat-app/docs/CONTRACT.md` | 前端模块契约 |
| `ai-chat-app/docs/DELIVERY.md` | 本文件 |

**APK 指纹（最终正式构建）**

- 大小：310,565 bytes（0.30 MB）
- SHA-256：`367F070A550B9FE64B386379A642A6C824BF086273EB629F75DB89D88B733151`
- 包名：`com.aichat.client`；版本：`1.3.0`（versionCode 7）
- minSdk 26（Android 8.0）/ targetSdk 34 / compileSdk 34
- 签名：APK Signature Scheme v2 + v3（minSdk 26 下 v1/JAR 签名非必需），`zipalign` 4 字节对齐校验通过
- 证书：`CN=AI Chat, OU=Mobile, O=AiChat, L=Shenzhen, ST=Guangdong, C=CN`
- 证书 SHA-256：`F4AAA0A8AC71DCA67AD95F290F106A44C12D694F8477305FB213828AB92D2590`
- 发布版未开启 `android:debuggable`，WebView 调试端口只在调试构建中打开

> 本版（1.3.0）继续使用同一签名密钥库（证书 SHA-256 不变），versionCode 升到 7；如果手机上装过旧版本，可直接覆盖升级（无需卸载）。v1.3.0 新增：自定义聊天外观（微信 / iMessage / QQ 三种气泡样式、聊天背景图、我的头像）、角色性别、每个角色单独开关上帝模式、角色图片库独立入口（可从角色列表打开）、聊天存档 / 读档 / 以存档开新对话；并修复世界观选择页滚动与点击卡顿、图片库「添加图片」按钮被 toast 遮挡点不动、弹窗/操作菜单不可见、连续操作时 toast 叠成一列等问题。

### 1.7 本版新增功能（v1.3.0 · 聊天外观 / 性别 / 角色级上帝模式 / 独立图片库 / 存档）

- **聊天界面样式**：设置 →「聊天界面 → 聊天界面样式」可选「微信 / iMessage / QQ」：微信保留头像与绿色气泡；iMessage 隐藏头像、对方白色大字气泡、自己蓝色气泡；QQ 为浅蓝气泡 + 小圆角。切换立即生效并持久化（`settings.chat_style`，body[data-chat-style]）。
- **自定义聊天背景 / 我的头像**：设置 →「聊天界面」→「聊天背景」「我的头像」可从相册选图（dataURI，存 IndexedDB settings）。聊天页整页背景图 + 轻微蒙层保证文字可读，「我」的消息旁显示自定义头像；「恢复默认」可清空。深色 / AMOLED 下蒙层自动加深。
- **角色性别**：创建角色 Step3 可选「女 / 男 / 其他 / 不设定」，编辑页可修改；列表显示性别小标签；性别会进入角色资料（`characters.gender`），AI 补全 / 改稿 / 草稿恢复都不会覆盖用户选择。
- **每个角色单独开关上帝模式**：角色编辑页新增「上帝模式」开关（创建向导 Step3 也可开）。聊天时生效规则为「角色开关 || 全局开关」：全局一键全开，单个角色也可独立开；角色信息抽屉会显示只读状态。
- **角色图片库独立入口**：角色列表行「⋯」→「图片库」可直接打开该角色的图片库（标题「角色图片库 · 角色名」），不需要先进入编辑页；编辑页入口保留。添加图片后会**自动关闭弹窗**并在 toast 显示「已添加 1 张…（共 N 张）」，添加中按钮禁用防重；删除角色时图片库级联清理。
- **存档 / 读档 / 以存档开新对话**：聊天页会话菜单新增「存档」与「存档点」：
  - **存档**：给当前会话拍快照（消息、角色、API/模型、预设、人设、开场白索引），可命名/备注；单会话最多 60 个、总量 300 个。
  - **存档点**：列出本会话全部存档，可读档（把会话恢复到该快照，回滚消息与配置）、以存档开新对话（新建会话并复制该快照的消息与配置，便于「聊崩了重开」）、重命名、删除。
  - 生成中禁止存档 / 读档；存档数据存 IndexedDB 新表 `saves`（数据库升级到 v3）。
- **交互修复**：世界观选择页选中卡片不再整页重建（只原地更新选中态与摘要），长列表可正常滚动、点击不卡；``+ 添加图片``不再被 toast 挡住；弹窗 / 操作菜单恢复可见（入场动画选择器匹配）；连续操作时 toast 只显示最新一条，不再叠成一列。
- **数据模型**：`characters.gender`、`characters.godMode`；settings：`chat_style` / `chat_bg` / `user_avatar`；IndexedDB 升级到 v3 并新增 `saves` 表（索引 sessionId / characterId）。
- **E2E**：新增 `scripts/e2e-v130.js`（16 项：外观切换、背景/头像、聊天页样式、性别、角色级上帝模式进 prompt、独立图片库与添加后自动关闭）与 `scripts/e2e-saves.js`（7/7：快照/读档/新开对话/重命名/菜单入口）；原有 9 套 E2E 全部通过（audit / onboarding 26 / character 28 / chat 16 / greetings 26 / media 46 / proactive / guide / acceptance 32）。截图 `build/shots/{61-settings-chatui,99-saves-menu,100-settings-chatui,101-chat-imessage,102-chat-wechat-avatar,103-character-gender-god}.png`。
- 纯前端改动（原生壳与权限未变）；签名密钥库不变（证书 SHA-256 仍为 `F4AAA0A8…`）。

### 1.6 本版更新（v1.2.2 · 随机间隔可调上下限 + 到点决策 + 怎么走光标高亮）

- **随机间隔改为 0~24 小时、上下限可调**：设置 →「角色主动消息」→「主动消息间隔」选择「随机间隔（0~24 小时，可调上下限）」后，会多出「随机间隔下限」「随机间隔上限」两行（0、0.5、1、2、3、4、6、8、12、18、24 小时可选；默认下限 1 小时、上限 8 小时）。每轮在上次聊天后的 [下限, 上限] 区间内重新随机，不会固定节奏；上限小于下限时自动纠正。
- **到点先读上下文，再决定发不发**：间隔到点后，角色会带着当前会话上下文（最近消息、角色设定、世界观、图片库、上帝模式）让模型判断「现在适合主动发消息吗」——模型只返回 `{"send":true,"message":"…"}` 或 `{"send":false}`。返回 false 时不写入消息、不消耗当日 3 条配额，只更新时间戳；返回 true 才落库并触发未读/列表/toast/通知。兼容旧模型：模型直接返回纯文本时按「发送」处理；解析失败或空回复按失败节流，不会反复打扰。
- **引导「怎么走」改为光标 + 高亮**：点击「怎么走」后不再只是步骤清单——面板打开即自动用黑色手型光标指向第一个可操作目标（输入框/按钮/Tab），目标同时加绿色高亮光环与提示标签（「在这里填写」「点这里」「已到「设置」」）。点步骤也会触发同样效果；navigate 步骤跳转后光标指向目标 Tab；面板关闭、切页或点击其它区域会自动清除光标。
- **E2E 覆盖**：`scripts/e2e-proactive.js` 扩到 **43 项**（随机上下限写入/区间随机/后台排期/到点决策 send=false 不发、send=true 发送、纯文本兜底）；`scripts/e2e-guide.js` 扩到 **18 项**（自动光标、高亮目标、提示标签、跳转后标出目标 Tab）；`e2e-greetings` 26 项与原有 7 套 E2E 全部通过。截图 `97-settings-proactive-random.png`、`52-guide-focus.png`、`53-guide-navigate.png`。
- 纯前端改动，不涉及原生代码与权限；签名密钥库不变（证书 SHA-256 仍为 `F4AAA0A8…`）。

### 1.5 本版更新（v1.2.1 · 主动消息随机间隔）

- **随机间隔**：设置 →「角色主动消息」→「主动消息间隔」新增「随机间隔（15~120 分钟）」。选中后，每轮在上次聊天之后随机等待 15–120 分钟再判定是否主动发消息，且每轮生成结束都会重新抽取，不会固定在同一时间点打扰。（v1.2.2 已把随机模式扩展为 0~24 小时可调上下限，见 §1.6；固定档位 15 / 30 / 60 / 120 分钟仍保留，默认 60。）
- 随机模式下，前台判定与后台通知排期都使用「本轮实际间隔」（`App.Proactive.activeIntervalMin`）；设置行与状态文案显示「随机 N 分钟」。
- **开场白可选为空**：聊天页会话菜单「换个开场白」新增「不使用开场白（空对话）」；选中后会话从空白开始（删除尚未聊天时的开场白消息，`sessions.greetingIndex = -1`），之后可随时再切回首选/备选。角色首选与备选都为空时，新会话也直接以空对话开始。
- 纯前端改动，不涉及原生代码与权限；签名密钥库不变（证书 SHA-256 仍为 `F4AAA0A8…`）。
- E2E：`scripts/e2e-proactive.js` 从 18 项扩到 26 项（v1.2.2 起进一步扩到 43 项，见 §1.6）；`scripts/e2e-greetings.js` 从 20 项扩到 **26 项**（新增空对话选项、空对话状态、切回首选），两者与原有 7 套 E2E 全部通过。

### 1.4 本版新增功能（v1.2.0 · 角色主动消息 + 问候语）

- **角色主动消息**：设置 →「角色主动消息」分组可开关（默认关闭），并选择间隔（15 / 30 / 60 / 120 分钟，默认 60）。开启后，距上次聊天超过间隔时角色可能主动发来一条消息：前台由 30 秒轮询 + 页面回到前台补查触发，生成结果写入会话（未读数 +1，列表显示「X 发来一条消息」toast）；切到后台/锁屏时用系统通知提醒（AlarmManager setAndAllowWhileIdle，每天最多 3 条）。
- **问候语（首选 + 备选）**：角色编辑页新增「问候语」入口：首选问候语（新建会话默认开场白）+ 最多 10 条备选（每条 ≤200 字）；自 v1.2.1 起也可在聊天页选择「不使用开场白（空对话）」。聊天页会话菜单新增「换个开场白」：在会话还没有用户消息时可随时换成任意首选/备选；首选为空时新会话自动退回第一条备选。创建角色流程（AI 补全、草稿恢复、改稿、保存）完整保留备选问候语。
- **通知权限**：Android 13+ 首次使用主动消息时申请通知权限；未授权只影响锁屏/后台提醒，前台主动消息照常。
- **数据模型**：characters.alternateGreetings: string[]、sessions.greetingIndex；settings 新增 proactive_enabled / proactive_interval_min / proactive_last_at / proactive_day / proactive_day_count。数据库无需升级表结构（IndexedDB 仍是 v2）。
- 新增 E2E：scripts/e2e-proactive.js（18 项；v1.2.2 起扩到 43 项，见 §1.6）与 scripts/e2e-greetings.js（20 项；v1.2.1 起 26 项）全部通过；原有 E2E（audit / onboarding 26 / character 28 / chat 16 / guide 18 / media 46 / acceptance 32）全部通过。

### 1.3 本版修复（v1.1.1 · 针对「一卡一卡 / 点好几遍没反应」）

- **去掉悬浮引导球的高开销背景模糊**：`.bubble-ball` 原先使用 `backdrop-filter: blur(9px)`。它是常驻 fixed 元素，Android WebView 在滚动/打字/动画时会因它强制整页重绘，是低端机掉帧与输入迟滞的主要来源；改为不透明渐层背景 + 阴影，观感基本不变、开销显著降低。
- **原生层合并流式增量**：`Bridge` 之前收到每个 SSE 分片就调用一次 `evaluateJavascript` 回传；部分服务每秒推送几十上百个分片，会把 WebView UI 线程挤满，导致点击/滚动发卡。现在增量在原生层聚合（约 55ms 一批）后再回传，JS 侧收到的回调数量降到原来的十分之一量级。
- **聊天流式渲染节流**：AI 回复生成期间最多每 90ms 做一次完整 Markdown / 图片渲染，其余帧只更新纯文本；生成结束时再完整渲染一次，长回复不再逐帧 `innerHTML` 重建。
- **修复路由监听泄漏**：`Router.onChange` 之前返回 Router 自身、无法退订，聊天页每次进入都会累积一个监听回调，用久了会让路由切换越来越慢。现在返回退订函数，聊天页销毁时注销；其余页面的已有注销逻辑也随之真正生效。
- **触摸响应优化**：按钮 / Tab / 列表行统一 `touch-action: manipulation`，减少 WebView 点按判定延迟。
- 全量 E2E 回归通过（audit、onboarding 26、character 28、chat 16、guide 14、media 46、acceptance 32），并重新在 Android 13 模拟器上做设备端冒烟。

### 1.2 本版新增功能（v1.1.0）

- **角色图片库**：每个角色有独立图片库（新表 `characterImages`，单角色最多 60 张）。入口在「编辑角色 → 角色图片库」：可添加相册图片、查看大图、重命名 / 修改说明 / 删除；删除角色时图片库级联清理。图片存为 data URI（WebView 压缩后 ≤320px JPEG），不经过网络。
- **角色主动发图**：聊天时把角色图片库清单注入 system prompt（`- ID=…｜名称=…｜说明=…`），模型在回复里用 `[[img:图片ID]]` 指定要发的图，前端渲染为图片消息；图片已删除时显示「图片已不可用」，不会漏出原始标记。
- **给角色发图片 / 文件**：聊天输入框左侧「＋」→ 相册图片 / 文件。图片消息按 OpenAI 多模态格式（`content:[{type:'text'},{type:'image_url'}]`）发给模型；文本类文件读取内容（≤2MB / 8000 字）作为文本附带发送，界面显示文件卡片、点击可查看文本。用户消息渲染缩略图 / 文件卡，空文本可只发附件。
- **引导助手帮忙加图**：帮助抽屉可发图片（附件 chip），发送后本地立即出现「加到角色图片库」按钮 → 选角色 → 写入该角色图片库（`source='guide'`），离线可用，不依赖模型输出；FAQ 新增「怎么让角色给我发图片？」「上帝模式是什么？」。
- **动作 / 神态斜体**：system prompt 约定动作与神态用 `*…*` 包裹、说的话用正文；前端 Markdown 渲染把单星号转成 `<em class="md-action">`（斜体、更细字重、次要色），台词保持正文字体。只对 assistant 消息生效，用户消息不做转换。
- **上帝模式**：设置 →「角色与聊天 → 上帝模式」开关（持久化 `settings.god_mode`）。开启后 system prompt 追加一段说明，让角色知道自己只是应用里的虚拟角色、可以自然地聊这件事；关闭即恢复沉浸。
- **数据库升级**：IndexedDB 版本 1→2，新增 `characterImages` 表与 `characterId` 索引；旧数据自动保留。
- **修复弹窗 / 操作菜单不可见**：`UI.modal` / `UI.sheet` 的入场动画类之前加在包裹层，CSS 却匹配在弹窗本体，导致遮罩透明、弹窗 opacity 停留 0（内容存在但看不见）。已在 `base.css` 增加 `.modal-wrap.show .modal` / `.sheet-wrap.show .sheet` 等匹配规则，所有确认框、菜单、图片库弹窗恢复可见。

### 1.1 本版修复与改进

- **修复助手/角色回复出现「一串 null」**：Android `org.json` 的 `optString` 在字段值为 JSON `null` 时返回字面量 `"null"`，部分 OpenAI 兼容服务会发送 `{"delta":{"content":null}}`（推理模型、首包 role-only 等），旧实现把每个 null 分片当正文拼接。现在原生层 `Net.extractText` 用 `jstr()` 严格取值（跳过 null 与非字符串、忽略 `reasoning_content`），前端 `chat.js`/`api.js`/`prompts.js` 三层再防御非字符串增量，并新增 E2E 回归断言「null 增量被忽略：累计文本不含 "null"」。
- **AI 补全生成页可用性改造**（角色创建 Step4 / 世界观自定义补全）：
  - 生成中**实时显示**模型输出与「正在生成… 0.xs」「已接收 N 字 · 第 N 次尝试」，不再是假进度条，避免「像卡住」。
  - **真实计时与阶段**：连接中 → 生成中 → 解析中 → 重试中，重试次数可见。
  - **可随时停止**：停止后保留已生成内容，底部提供「继续生成 / 手动填写」，失败时一键「重试 / 换个 API 再试」，不用从头再来。
  - 生成中底部只保留「停止生成」一个按钮，减少拥挤；错误态提供「查看模型原始输出」帮助手动填写。
- 新增 `scripts/shots-worldview.js`（世界观生成态截图）与新版角色生成态截图（`build/shots/33a/33b/70-73`）。

## 2. 安装

```powershell
# USB 调试已开启时
adb install -r ai-chat-app\build\AI-Chat-1.3.0.apk

# 或把 APK 传到手机，在文件管理器里点击安装（允许「安装未知来源应用」）
```

首次启动会强制进入「引导 API」向导，未通过连接测试无法进入主界面。

## 3. 技术架构

- **原生壳**：单 Activity + WebView（`MainActivity`），拦截 `https://app.local/*` 映射到 `assets/www`，因此前端拥有正常 origin，IndexedDB / localStorage 可用。
- **前端**：纯 HTML/CSS/vanilla JS，零第三方依赖，微信式 4 Tab + 二级页栈。
- **网络**：全部经 Java 桥（`HttpURLConnection` + SSE 逐行解析），不走 WebView fetch，规避 CORS；流式输出通过 `window.__nativeEvent` 回传。
- **Key 安全**：AndroidKeyStore（AES-256-GCM）加密后存 SharedPreferences；Key 不写 IndexedDB、不进入导出备份、不出现在气泡上下文中。
- **数据**：IndexedDB（12 张表：providers/worldviews/characters/characterImages/personas/presets/sessions/messages/helpSessions/helpMessages/settings/saves）。角色图片以 data URI 存储（单张压缩后 ≤320px，单角色 ≤60 张），聊天附件随消息保存在 `messages.attachments`；聊天存档（v1.3.0）保存消息与配置快照到 `saves` 表。
- **构建**：不依赖 Gradle，`scripts/build.ps1` 手工串 aapt2/javac/d8/zipalign/apksigner，结果确定、可离线复现。

## 4. 功能清单（对应需求 §十一 验收标准）

| # | 验收项 | 状态 |
| --- | --- | --- |
| 1 | 底部 4 Tab（聊天/角色/API/设置），页面标题用全称 | ✅ |
| 2 | 首次启动强制引导，测试不通过不能继续 | ✅ E2E |
| 3 | 错误 Key 给出具体原因（401/403/404/超时等中文提示） | ✅ E2E |
| 4 | 引导完成后重启免引导 | ✅ E2E |
| 5 | 陪聊角色 AI 补全 ≥6 字段，预览页标注「AI 补全 / 你填写」 | ✅ E2E |
| 6 | 助手角色按领域（法律→刑事辩护等）生成专业设定，system prompt 无「扮演」话术 | ✅ 断言 |
| 7 | 7 套内置世界观（现代都市/古代宫廷/校园日常/赛博朋克/ABO/斗破苍穹/无） | ✅ |
| 8 | 自定义世界观支持 AI 补全 | ✅ |
| 9 | 创建角色 Step4 可切换任意 API，生成走所选 API | ✅ E2E |
| 10 | 草稿持久化、绝不自动保存、杀进程可恢复 | ✅ E2E |
| 11 | 「让 AI 改」产生新版本，可切回旧版回滚 | ✅ E2E |
| 12 | 改稿固定使用引导 API，预览页无 API 入口 | ✅ E2E |
| 13 | AI 补全失败有重试 1 次 + 手动填写兜底 | ✅ E2E |
| 14 | 错误气泡「这是什么意思？」打开带上下文的帮助抽屉 + FAQ 兜底 | ✅ E2E |
| 15 | 引导会话独立存储，不进入聊天列表 | ✅ E2E |
| 16 | 从启动到开始聊天 ≤10 步 | ✅ |
| 17 | 流式输出、停止保留内容、可重试 | ✅ E2E |
| 18 | 聊天记录/角色/API 重启后仍在 | ✅ E2E |
| 19 | 无本地推理（无 llama/gguf 代码或依赖） | ✅ 检索 |
| 20 | 断网可看历史，发送给出明确中文错误 | ✅ E2E |
| 21 | 1000 条消息会话只渲染最近约 40 条，打开 ~20ms | ✅ E2E |
| 22 | 会话内切换 API/模型即时生效并落库 | ✅ |
| 23 | 悬浮球显示/拖动吸附/位置记忆/设置开关 | ✅ |
| 24 | 扇形 3~4 项快捷，可点步骤直达目标控件 | ✅ E2E |
| 25 | 「怎么走」发起前附带当前页上下文（步骤/已填/缺失/错误） | ✅ |
| 26 | 键盘弹起/输入聚焦时小球让位，不挡 Tab 与输入框 | ✅ |
| 27 | 上下文绝不含 API Key / 聊天正文 | ✅ E2E |

## 5. 验证结果

在无头 Chrome 实例（390×844 @2x，移动端 UA）上，连本地静态服务器逐项跑通：

| 脚本 | 覆盖 | 结果 |
| --- | --- | --- |
| `scripts/audit.js` | 首次引导、4 Tab、6 个二级页、气泡挂载、控制台无错误 | 全部通过 |
| `scripts/e2e-onboarding.js` | 6 步引导全流程 + 错误 Key + 不写库 + 重启免引导 | 26/26 |
| `scripts/e2e-character.js` | 5 步创建向导 + 校验拦截 + 生成中实时输出/停止/继续 + 失败兜底 + 保存落库 + 自动开聊 | 28/28 |
| `scripts/e2e-chat.js` | 历史渲染、流式、停止、落库、重新生成多版本 | 16/16 |
| `scripts/e2e-guide.js` | 气泡上下文、扇形菜单、怎么走步骤、focus/navigate、纯文本兜底 | 14/14 |
| `scripts/e2e-acceptance.js` | AI 补全成功路径、草稿恢复、改稿回滚、助手 prompt、1000 条性能、断网、错误帮助、引导会话隔离 | 32/32 |
| `scripts/e2e-media.js`（v1.1.0 新增） | 角色图片库增删/预览/菜单、聊天发图片与文件附件并落库、assistant 发图 `[[img:ID]]`、动作斜体 `*…*`、上帝模式开关与 system prompt、帮助抽屉发图→加入图片库 | 46/46 |

截图位于 `ai-chat-app/build/shots/`（浅色/暗色/AMOLED、聊天/角色/引导气泡/错误帮助等）。

### 5.1 Android 设备端验证（API 33 / Android 13 模拟器）

> **v1.2.2 验证说明**：v1.2.2 仅改动前端（随机间隔上下限、到点决策、引导光标）与引导样式，已通过浏览器 E2E（`e2e-proactive` 43 项、`e2e-guide` 18 项）与全量回归验证，未再启动模拟器。
>
> **v1.2.0 设备端验证说明**：本版新增的原生通知代码（POST_NOTIFICATIONS、`ProactiveReceiver`、AlarmManager 排期）已随构建产物做静态校验（`aapt2 dump badging` 含权限、`aapt2 dump xmltree` 含 receiver、`zipalign`/`apksigner` 通过），主动消息的业务逻辑由浏览器 E2E（`e2e-proactive` 18 项、`e2e-greetings` 20 项）覆盖。按用户要求避免再次占用大量内存启动模拟器，本版未重复设备端自动化验证；建议真机首次开启「角色主动消息」时确认系统通知权限弹窗，若通知未出现请在系统设置中允许通知。

> **复验状态**：本版（1.1.1）构建已在 Windows 本机的 Android 13（API 33，x86_64）模拟器上完成安装、启动与设备端自动化验证（AEHD 2.2 加速驱动经用户授权后安装，emulator 37.2.13 + `system-images;android-33;google_apis;x86_64`）。设备端验证覆盖原生桥、Key 加密、流式回复、气泡、主题与返回键，并额外专项验证「null 修复」、v1.1.0 新增功能与 v1.1.1 流畅度修复（触摸 Tab 切换与「流式中点停止」响应）。

| 项 | 结果 |
| --- | --- |
| `scripts/device-e2e.js`（原生桥 app.info 返回 version=1.1.1 / secure.set+get / ui.toast / ui.statusBar；免引导进主界面；4 Tab 文案；聊天页历史；发消息收流式回复并落库；气泡扇面、上下文不含 Key/聊天正文；深色主题；角色/API/设置页；无未捕获异常） | **17/17** |
| `scripts/device-null.js`（设备端 null 回归：mock SSE 的 `delta.content` 混入 JSON null / reasoning_content null，校验桥接层增量、UI 气泡与落库消息均不含 "null"） | **3/3** |
| `scripts/device-media-smoke.js`（角色图片库写入、动作斜体渲染、角色发图 `[[img:ID]]` 渲染为图片且不泄漏标记、上帝模式 system prompt 注入与否） | **7/7** |
| v1.1.1 触摸响应实测（CDP `Input.dispatchTouchEvent`，设备视口 393×778 @dpr 2.75） | 4 个 Tab 切换 103–360ms（含测试轮询开销）；发送消息 350ms 进入流式；**流式生成中点「停止」357ms 内响应**，不再出现「点好几遍没反应」 |
| 系统返回键 | 二级页返回 = 弹栈（depth 2→1，不退出）；Tab 根返回 = 退出 App |
| 发布包安装启动 | 通过，`adb logcat` 无 FATAL/崩溃，界面与截图正常 |
| Key 加密存储 | `run-as` 被拒（发布包不可调试），Key 仅存 SharedPreferences 密文 |

设备截图位于 `ai-chat-app/build/device/`：`10-main-chat-list.png`、`11-chat.png`、`12-chat-reply.png`（mock SSE 流式回复「你好，这是设备端测试回复。」，含 8 tokens 用量）、`13-bubble-fan.png`、`14-chat-dark.png`、`15-settings-area.png`、`20-null-regression.png`、`21-media-god.png`（v1.1.0：角色斜体动作 + 角色发图 + 图片名）、`result.json`。设备测试用 mock SSE 服务通过 `adb reverse tcp:8899 tcp:8899` 暴露到设备 `127.0.0.1:8899`（脚本：`scripts/mock-sse-server.js`、`scripts/device-e2e.js`、`scripts/device-null.js`、`scripts/device-media-smoke.js`）。

> 说明：个别模拟器 ROM（本次 JellyDroid API33 镜像）的 AssetManager 对 `assets/` 子目录返回反斜杠路径，`serveAsset` 已内置 `/`→`\` 双分隔符兜底并在该镜像上验证；标准 Android 设备走正常正斜杠路径，不受影响。

> **v1.3.0 验证说明**：v1.3.0 为纯前端改动（聊天外观、性别、角色级上帝模式、独立图片库、存档、世界观滚动修复），原生壳与权限未变，未再次启动高内存 Android 模拟器；已通过 11 个浏览器 E2E 脚本串行全量回归（含新增 `e2e-v130` 16 项与 `e2e-saves` 7 项），并对发布包做签名 / 对齐 / badging / assets 完整性校验。

### 5.2 「一串 null」修复的验证方式

用三层独立验证覆盖原生、设备与前端交互：

1. **设备端真机回归**（`scripts/device-null.js`，Android 13 模拟器）：mock SSE 服务在 `delta.content` 中混入 JSON `null` 并附带 `reasoning_content:null`，设备上运行结果——桥接层累计增量「你好，这是设备端测试回复。」无 "null"，聊天 UI 气泡与落库消息同样无 "null"（3/3 通过，截图 `build/device/20-null-regression.png`）；`scripts/device-e2e.js` 的聊天流式用例（`build/device/12-chat-reply.png`）同样基于该 mock SSE。
2. **原生层 JVM 单测**（`scripts/jvm-null/`）：`make-test.js` 从 `android/src/com/aichat/client/Net.java` 原样提取 `jstr()` / `extractText()`，用桌面版 `org.json`（`json-20240303`）编译运行，13 项断言全部通过——`{"delta":{"content":null}}`、`message.content:null`、`text:null` 均返回空串；`reasoning_content` 被忽略；null 增量拼接后正文不含 "null"。
3. **前端 E2E 回归**（`scripts/e2e-acceptance.js`）：mock 流式先吐 null/undefined/空串再吐正文，断言累计文本不含 "null" 且正常完成（32/32 通过）。

## 6. 已知限制

- 浏览器/E2E 使用 mock 网络层验证交互与数据流；**真实第三方 API 服务（OpenAI/DeepSeek 等）未用真实 Key 做线上联调**，需要用户填入自己的 Key 后使用「测试连接」验证。原生桥（Key 加密存储、流式回复、系统返回键、状态栏、Toast）已在本版构建的 Android 13 模拟器上验证（见 5.1），其中网络请求同样走真实 Java 桥与真实 SSE 解析（对本地 mock SSE 服务）。
- 图片选择（头像 / 角色图片库 / 聊天附件）走 Android 系统选择器（`ui.pickImage` / `file.import`），浏览器 E2E 用测试钩子（`window.__AICHAT_MOCK_IMAGE__` / `__AICHAT_MOCK_FILE__`）覆盖了「选到图之后」的全部逻辑，**原生系统选择器的真实点击未做自动化**；真机上首次使用需授权访问相册/文件。
- 图片以 base64 存储，单角色 60 张、聊天附件随消息保存，会占用应用私有存储；导入备份不包含图片库与聊天附件（仅含数据表字段，图片随表导出，体积会变大，谨慎使用）。
- 参考图/多模态发送依赖所选 API 支持图片输入（`image_url`）；不支持时模型可能只看到文本占位提示。
- 签名只输出 v2/v3 方案（minSdk 26 下现代设备可正常安装）；如需兼容 Android 7 以下需降低 minSdk 并让 apksigner 生成 v1 签名。
- 聊天页未实现「右滑打开角色抽屉」手势（避免与系统返回手势冲突），入口在角色名/顶部菜单。
- 「生成中」为内存态标记，进程被杀后由列表加载时纠正。
- 引导助手在未配置引导 API 时使用静态 FAQ 兜底；「怎么走」的 AI 解析结果依赖模型输出 JSON，解析失败会降级为原文展示。

## 7. 重新构建

```powershell
cd ai-chat-app
pwsh -NoProfile -ExecutionPolicy Bypass -File scripts\build.ps1 -Clean
```

要求：JDK 17+、`tools/android-sdk`（build-tools 34.0.0 + platform android-34，可用 `scripts/setup-sdk.ps1` 安装）。密钥库已存在则复用，不会覆盖。输出 `build/AI-Chat-1.3.0.apk`。

调试构建（开启 `android:debuggable` 与 WebView DevTools，便于 `scripts/device-e2e.js` 联调）：

```powershell
pwsh -NoProfile -ExecutionPolicy Bypass -File scripts\build.ps1 -DebugMode
# 输出 build/AI-Chat-1.3.0-debug.apk
adb install -r build\AI-Chat-1.3.0-debug.apk
adb forward tcp:9333 localabstract:webview_devtools_remote_<app pid>
node scripts\device-e2e.js 9333
```

设备端返回键验证：`node scripts\device-back-test.js 9333 push` → `adb shell input keyevent 4` → `node scripts\device-back-test.js 9333 check`。



