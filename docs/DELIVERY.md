# AI 聊天 · 交付说明

按 `prompt-01-需求提示词.md` 实现的 Android 应用，已构建并签名。

## 1. 交付物

| 文件 | 说明 |
| --- | --- |
| `ai-chat-app/build/AI-Chat-1.1.0.apk` | 签名后的安装包（可直接安装） |
| `ai-chat-app/keystore/aichat-release.jks` | 签名密钥库（alias `aichat`，口令 `aichat2026`） |
| `ai-chat-app/scripts/build.ps1` | 一键构建脚本（aapt2 → javac → d8 → zipalign → apksigner） |
| `ai-chat-app/android/` | 原生壳源码 + 前端资源（`assets/www`） |
| `ai-chat-app/scripts/*.js` | 无头 Chrome 冒烟 / E2E 与设备端 E2E 脚本（开发期工具，不进入 APK） |
| `ai-chat-app/docs/CONTRACT.md` | 前端模块契约 |
| `ai-chat-app/docs/DELIVERY.md` | 本文件 |

**APK 指纹（最终正式构建）**

- 大小：277,589 bytes（0.26 MB）
- SHA-256：`DC7F19738F901E2C5CDABC7CD22356478A489C082AB028B14F7A585FEA9D5577`
- 包名：`com.aichat.client`；版本：`1.1.0`（versionCode 2）
- minSdk 26（Android 8.0）/ targetSdk 34 / compileSdk 34
- 签名：APK Signature Scheme v2 + v3（minSdk 26 下 v1/JAR 签名非必需），`zipalign` 4 字节对齐校验通过
- 证书：`CN=AI Chat, OU=Mobile, O=AiChat, L=Shenzhen, ST=Guangdong, C=CN`
- 证书 SHA-256：`F4AAA0A8AC71DCA67AD95F290F106A44C12D694F8477305FB213828AB92D2590`
- 发布版未开启 `android:debuggable`，WebView 调试端口只在调试构建中打开

> 本版（1.1.0）沿用上一次重建后的签名密钥库（证书 SHA-256 不变），versionCode 升到 2；如果手机上装过 1.0.0，可直接覆盖升级（无需卸载）。工程此前被外部清理，已用 DSH 会话日志逐文件重放恢复并通过全部 E2E 回归；构建完成后在 Android 13 模拟器上完成设备端复验（见 §5.1）。

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
adb install -r ai-chat-app\build\AI-Chat-1.1.0.apk

# 或把 APK 传到手机，在文件管理器里点击安装（允许「安装未知来源应用」）
```

首次启动会强制进入「引导 API」向导，未通过连接测试无法进入主界面。

## 3. 技术架构

- **原生壳**：单 Activity + WebView（`MainActivity`），拦截 `https://app.local/*` 映射到 `assets/www`，因此前端拥有正常 origin，IndexedDB / localStorage 可用。
- **前端**：纯 HTML/CSS/vanilla JS，零第三方依赖，微信式 4 Tab + 二级页栈。
- **网络**：全部经 Java 桥（`HttpURLConnection` + SSE 逐行解析），不走 WebView fetch，规避 CORS；流式输出通过 `window.__nativeEvent` 回传。
- **Key 安全**：AndroidKeyStore（AES-256-GCM）加密后存 SharedPreferences；Key 不写 IndexedDB、不进入导出备份、不出现在气泡上下文中。
- **数据**：IndexedDB（11 张表：providers/worldviews/characters/characterImages/personas/presets/sessions/messages/helpSessions/helpMessages/settings）。角色图片以 data URI 存储（单张压缩后 ≤320px，单角色 ≤60 张），聊天附件随消息保存在 `messages.attachments`，不写入导出备份以外的任何外部位置。
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

在 Chrome 155 无头实例（390×844 @2x，移动端 UA）上，连本地静态服务器逐项跑通：

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

> **复验状态**：本版（1.1.0）构建已在 Windows 本机的 Android 13（API 33，x86_64）模拟器上完成安装、启动与设备端自动化验证（AEHD 2.2 加速驱动经用户授权后安装，emulator 37.2.13 + `system-images;android-33;google_apis;x86_64`）。设备端验证覆盖原生桥、Key 加密、流式回复、气泡、主题与返回键，并额外专项验证「null 修复」与 v1.1.0 新增功能。

| 项 | 结果 |
| --- | --- |
| `scripts/device-e2e.js`（原生桥 app.info 返回 version=1.1.0 / secure.set+get / ui.toast / ui.statusBar；免引导进主界面；4 Tab 文案；聊天页历史；发消息收流式回复并落库；气泡扇面、上下文不含 Key/聊天正文；深色主题；角色/API/设置页；无未捕获异常） | **17/17** |
| `scripts/device-null.js`（设备端 null 回归：mock SSE 的 `delta.content` 混入 JSON null / reasoning_content null，校验桥接层增量、UI 气泡与落库消息均不含 "null"） | **3/3** |
| `scripts/device-media-smoke.js`（v1.1.0 新增：角色图片库写入、动作斜体渲染、角色发图 `[[img:ID]]` 渲染为图片且不泄漏标记、上帝模式 system prompt 注入与否） | **7/7** |
| 系统返回键 | 二级页返回 = 弹栈（depth 2→1，不退出）；Tab 根返回 = 退出 App |
| 发布包安装启动 | 通过，`adb logcat` 无 FATAL/崩溃，界面与截图正常 |
| Key 加密存储 | `run-as` 被拒（发布包不可调试），Key 仅存 SharedPreferences 密文 |

设备截图位于 `ai-chat-app/build/device/`：`10-main-chat-list.png`、`11-chat.png`、`12-chat-reply.png`（mock SSE 流式回复「你好，这是设备端测试回复。」，含 8 tokens 用量）、`13-bubble-fan.png`、`14-chat-dark.png`、`15-settings-area.png`、`20-null-regression.png`、`21-media-god.png`（v1.1.0：角色斜体动作 + 角色发图 + 图片名）、`result.json`。设备测试用 mock SSE 服务通过 `adb reverse tcp:8899 tcp:8899` 暴露到设备 `127.0.0.1:8899`（脚本：`scripts/mock-sse-server.js`、`scripts/device-e2e.js`、`scripts/device-null.js`、`scripts/device-media-smoke.js`）。

> 说明：个别模拟器 ROM（本次 JellyDroid API33 镜像）的 AssetManager 对 `assets/` 子目录返回反斜杠路径，`serveAsset` 已内置 `/`→`\` 双分隔符兜底并在该镜像上验证；标准 Android 设备走正常正斜杠路径，不受影响。

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

要求：JDK 17+、`tools/android-sdk`（build-tools 34.0.0 + platform android-34，可用 `scripts/setup-sdk.ps1` 安装）。密钥库已存在则复用，不会覆盖。输出 `build/AI-Chat-1.0.0.apk`。

调试构建（开启 `android:debuggable` 与 WebView DevTools，便于 `scripts/device-e2e.js` 联调）：

```powershell
pwsh -NoProfile -ExecutionPolicy Bypass -File scripts\build.ps1 -DebugMode
# 输出 build/AI-Chat-1.0.0-debug.apk
adb install -r build\AI-Chat-1.0.0-debug.apk
adb forward tcp:9333 localabstract:webview_devtools_remote_<app pid>
node scripts\device-e2e.js 9333
```

设备端返回键验证：`node scripts\device-back-test.js 9333 push` → `adb shell input keyevent 4` → `node scripts\device-back-test.js 9333 check`。
