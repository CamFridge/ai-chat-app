# 功能契约 · v1.2.0 主动消息 + 问候语（首选/备选）

> 本迭代在 v1.1.1 基础上新增两项功能，并保持**签名一致**（必须复用现有 `keystore/aichat-release.jks`，构建后证书 SHA-256 仍为
> `F4AAA0A8AC71DCA67AD95F290F106A44C12D694F8477305FB213828AB92D2590`）。
> 版本：`versionName=1.2.0`、`versionCode=4`。

## 1. 数据模型（不新增表）

### characters（新增字段）
| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `firstMessage` | string | **首选问候语**（沿用旧字段，聊天开场白） |
| `alternateGreetings` | string[] | **备选问候语**，0~10 条，每条 1~200 字；默认 `[]`（旧数据缺省视为空） |

### sessions（新增字段）
| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `greetingIndex` | number | 当前使用的问候语序号：`0`=首选，`1..N`=第 N 条备选；缺省视为 0 |

### settings（新增键）
| 键 | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| `proactive_enabled` | boolean | `false` | 角色主动消息总开关 |
| `proactive_interval_min` | number | `60` | 空闲判定与后台通知间隔（15/30/60/120 分钟） |
| `proactive_last_at` | number | `0` | 上次尝试主动消息的时间戳（无论成败），用于节流 |
| `proactive_day` | string | `''` | 计数日期 `YYYY-MM-DD` |
| `proactive_day_count` | number | `0` | 当日已发送条数（上限 3 条） |

## 2. 问候语（首选 / 备选）

- 新建会话（聊天列表「＋」→ 选角色）默认使用**首选** `firstMessage`；角色有备选时，创建会话后**聊天页顶部菜单**提供「换个开场白」。
- 聊天页顶部「…」菜单新增项 `greeting`「换个开场白」，仅当会话**还没有用户消息**时可用（有用户消息后置灰或 toast「已经聊起来了，不能换开场白」）。
- 选择面板（`UI.sheet`）：列出「首选」+ 每条备选（内容截断 24 字作为 label）；选中后：
  - 若会话首条 assistant 消息存在且仍是问候语（无任何 user 消息）→ 替换其 `content`；
  - 若会话没有任何消息 → 插入一条 assistant 消息；
  - 写回 `session.greetingIndex`、`session.lastText/lastAt/updatedAt` 并刷新聊天页与列表。
- 问候语也参与 system prompt（已有实现：`firstMessage` 作为「第一句话」约束）；换备选后**不需要**改 system prompt 约束，仅替换首条消息文本。
- 角色编辑页「问候语」入口：
  - 行标题「问候语」，副标题 `首选 + N 条备选`，点击打开 `UI.modal`（复用 `character-edit.js` 既有弹窗风格，最大高度 `min(80vh, calc(100vh - 150px))`）。
  - 弹窗内：「首选问候语」多行输入（= `firstMessage`）+「备选问候语」列表（每条一个多行输入或列表行，含编辑/删除）+「＋ 添加备选」按钮（上限 10 条）。
  - 保存时写入 `alternateGreetings`（去空白、过滤空串、每条截断 200 字）与 `firstMessage`；`character-create.js` 的创建/保存逻辑需保证 `alternateGreetings` 不丢（新建时可为空数组）。
  - 引导气泡上下文：`page.guide({... filledFields:{greetings: hasAny}})` 可选，不强制。

## 3. 主动消息

### 3.1 前端行为（`js/proactive.js`，Lead 实现）
- `App.Proactive.init()`（main.js 启动时调用）：读取 settings，注册 `visibilitychange`，启动 30s 轮询。
- 开关打开且前台：若「最近一条消息距现在 ≥ `proactive_interval_min`」且今天未超过 3 条，则挑选 **`updatedAt` 最新、未在生成中、且角色存在** 的会话，生成一条主动消息：
  1. 读取 character/persona/preset/最近消息/图片库，`App.ChatKit.buildContext(...)` 得到 messages；
  2. 在 messages 末尾追加一条 `role:'user'` 的指令：「（系统提示）现在用户没有发消息，请你主动发一条消息… 1~3 句、符合当前情境、可用 *动作* 格式、可发图片」；
  3. `App.API.chatOnce`（timeout 90s）生成；成功后把 assistant 消息落库、更新 session 的 `lastText/lastRole/lastAt/updatedAt/unread`，`unread += 1`（如果当前不在该会话页），`App.UI.toast('「角色名」发来一条消息')`；失败只写 `proactive_last_at`，不打扰用户；
  4. 成功后 `proactive_day_count += 1`。
- 前端**不做**复杂配置：间隔选择在设置页，值来自 `proactive_interval_min`。

### 3.2 后台通知（原生 + `App.Proactive`）
- App 切到后台（`document.hidden`）且开关开启：调用 `App.Bridge.call('notify.schedule', {delayMs: interval*60000, title:'AI 聊天', body: '「角色名」想你了，回来聊聊吧'})`；
- 回到前台：`notify.cancel`。
- 原生用 `AlarmManager.setAndAllowWhileIdle`（免特殊权限），到点发本地通知；点击通知打开 App（回到聊天列表即可，不做深链）。
- Android 13+ 需要 `POST_NOTIFICATIONS` 运行时权限：设置页打开开关时调用 `App.Bridge.call('notify.requestPermission')`；`notify.status` 返回 `{permission:'granted'|'denied'|'unknown', supported:boolean}`。
- 通知渠道：id `aichat_proactive`、名称「角色主动消息」、importance DEFAULT。

### 3.3 设置页（feat-config）
「角色与聊天」分组之下新增分组「角色主动消息」：
- 开关行「允许角色主动发消息」副标题「空闲时角色可能主动找你聊天；后台会以通知提醒（每天最多 3 条）」；`data-guide-focus="proactive"`。
- 行「主动消息间隔」显示当前值（15/30/60/120 分钟），点击 `UI.sheet` 选择，写 `proactive_interval_min`。
- 开关打开时若 `App.Proactive` 存在调用 `App.Proactive.setEnabled(true)`（内部负责权限与调度）；关闭时 `setEnabled(false)` 并取消通知。
- 若通知权限被拒：toast「已开启，但通知权限未授予；仅 App 打开时生效」并不回滚开关。

## 4. 文件所有权（本迭代）

| 文件 | 负责人 |
| --- | --- |
| `docs/FEATURE-proactive-greetings.md`、`docs/CONTRACT.md` §15 | Lead |
| `android/**`（Java/manifest/res）、`js/proactive.js`、`index.html`（加 `js/proactive.js`）、`js/main.js`（`App.Proactive.init()`）、`scripts/**`、`build/**`、`docs/DELIVERY.md`、`README.md` | Lead |
| `js/pages/chat.js`、`js/pages/chat-list.js`、`css/pages-chat.css`（换开场白 + 主动消息 unread 刷新兼容） | feat-chat |
| `js/pages/character-edit.js`、`js/pages/character-create.js`、`css/pages-char.css`（问候语编辑） | feat-char |
| `js/pages/settings.js`、`css/pages-config.css`（主动消息设置组） | feat-config |
| `js/pages/help.js`、`js/data/faq.js`、`css/pages-guide.css`（FAQ/帮助入口） | feat-guide |

## 5. 验收点
1. 角色编辑页可维护首选 + 0~10 条备选问候语，保存后重进仍在；AI 补全/创建流程不丢 `alternateGreetings`。
2. 新建会话默认使用首选；聊天页「换个开场白」可切换为备选并替换首条消息；有用户消息后不可换。
3. 设置页开「允许角色主动发消息」→ 打开间隔选择；把间隔设为 15 分钟、用测试脚本把 `proactive_last_at`/消息时间调旧后，30s 内收到一条主动消息（角色口吻、1~3 句、落库、列表 unread+1）。
4. 后台通知：切后台后按间隔排期（测试用 `delayMs` 覆盖为 3s 验证通知出现）；点通知回 App；回前台取消。
5. Android 13 通知权限申请不崩溃；拒绝后开关仍可用（仅前台生效）。
6. 签名一致：`apksigner verify --print-certs` 证书 SHA-256 不变；versionName 1.2.0 / versionCode 4。
7. 全量 E2E 无回归；新增 `e2e-greetings.js` 与 `e2e-proactive.js` 通过。
