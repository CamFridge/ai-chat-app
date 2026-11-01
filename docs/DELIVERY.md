# AI 聊天 · 交付说明

按 `prompt-01-需求提示词.md` 实现的 Android 应用，已构建并签名。

## 1. 交付物

| 文件 | 说明 |
| --- | --- |
| `ai-chat-app/build/AI-Chat-1.0.0.apk` | 签名后的安装包（可直接安装） |
| `ai-chat-app/keystore/aichat-release.jks` | 签名密钥库（alias `aichat`，口令 `aichat2026`） |
| `ai-chat-app/scripts/build.ps1` | 一键构建脚本（aapt2 → javac → d8 → zipalign → apksigner） |
| `ai-chat-app/android/` | 原生壳源码 + 前端资源（`assets/www`） |
| `ai-chat-app/scripts/*.js` | 无头 Chrome 冒烟 / E2E 与设备端 E2E 脚本（开发期工具，不进入 APK） |
| `ai-chat-app/docs/CONTRACT.md` | 前端模块契约 |
| `ai-chat-app/docs/DELIVERY.md` | 本文件 |

**APK 指纹（最终正式构建）**

- 大小：257,041 bytes（0.25 MB）
- SHA-256：`F09FDE34899F2EC4ECA7B74BA3F908D971426E885ACC6E6087401B27F42FCC7A`
- 包名：`com.aichat.client`；版本：`1.0.0`（versionCode 1）
- minSdk 26（Android 8.0）/ targetSdk 34 / compileSdk 34
- 签名：APK Signature Scheme v2 + v3（minSdk 26 下 v1/JAR 签名非必需），`zipalign` 4 字节对齐校验通过
- 证书：`CN=AI Chat, OU=Mobile, O=AiChat, L=Shenzhen, ST=Guangdong, C=CN`
- 证书 SHA-256：`04CEAB35D9CBFBBBA6C0CDBBA08CEC62E7622B4E316A690C41D8260A7D6E1B03`
- 发布版未开启 `android:debuggable`，WebView 调试端口只在调试构建中打开

## 2. 安装

```powershell
# USB 调试已开启时
adb install -r ai-chat-app\build\AI-Chat-1.0.0.apk

# 或把 APK 传到手机，在文件管理器里点击安装（允许「安装未知来源应用」）
```

首次启动会强制进入「引导 API」向导，未通过连接测试无法进入主界面。

## 3. 技术架构

- **原生壳**：单 Activity + WebView（`MainActivity`），拦截 `https://app.local/*` 映射到 `assets/www`，因此前端拥有正常 origin，IndexedDB / localStorage 可用。
- **前端**：纯 HTML/CSS/vanilla JS，零第三方依赖，微信式 4 Tab + 二级页栈。
- **网络**：全部经 Java 桥（`HttpURLConnection` + SSE 逐行解析），不走 WebView fetch，规避 CORS；流式输出通过 `window.__nativeEvent` 回传。
- **Key 安全**：AndroidKeyStore（AES-256-GCM）加密后存 SharedPreferences；Key 不写 IndexedDB、不进入导出备份、不出现在气泡上下文中。
- **数据**：IndexedDB（10 张表：providers/worldviews/characters/personas/presets/sessions/messages/helpSessions/helpMessages/settings）。
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
| `scripts/e2e-character.js` | 5 步创建向导 + 校验拦截 + 失败兜底 + 保存落库 + 自动开聊 | 20/20 |
| `scripts/e2e-chat.js` | 历史渲染、流式、停止、落库、重新生成多版本 | 16/16 |
| `scripts/e2e-guide.js` | 气泡上下文、扇形菜单、怎么走步骤、focus/navigate、纯文本兜底 | 14/14 |
| `scripts/e2e-acceptance.js` | AI 补全成功路径、草稿恢复、改稿回滚、助手 prompt、1000 条性能、断网、错误帮助、引导会话隔离 | 32/32 |

截图位于 `ai-chat-app/build/shots/`（浅色/暗色/AMOLED、聊天/角色/引导气泡/错误帮助等）。

### 5.1 Android 设备端验证（API 33 / Android 13 模拟器）

最终安装包已在 Android 13（API 33）模拟器上安装、启动并渲染；另用同签名调试构建通过 `adb forward` + WebView DevTools 协议跑设备端 E2E：

| 项 | 结果 |
| --- | --- |
| `scripts/device-e2e.js`（原生桥 app.info / secure.set+get / ui.toast / ui.statusBar；免引导进主界面；4 Tab 文案；聊天页历史；发消息收流式回复；气泡扇面 4 项、上下文不含 Key/聊天正文；深色主题；角色/API/设置页；无未捕获异常） | **17/17** |
| 系统返回键 | 二级页返回 = 弹栈（depth 2→1，不退出）；Tab 根返回 = 退出 App |
| 发布包（最终 APK）安装启动 | 通过，`adb logcat` 无 FATAL/崩溃，界面与截图正常 |
| Key 加密存储 | `run-as` 被拒（发布包不可调试），Key 仅存 SharedPreferences 密文 |

设备截图：`ai-chat-app/build/device/`（`10-main-chat-list.png`、`11-chat.png`、`12-chat-reply.png`、`13-bubble-fan.png`、`14-chat-dark.png`、`15-settings-area.png`、`result.json`）。
设备渲染图：`build/device-04-onboarding.png`、`build/device-06-release.png`。

> 说明：个别模拟器 ROM（本次 JellyDroid API33 镜像）的 AssetManager 对 `assets/` 子目录返回反斜杠路径，`serveAsset` 已内置 `/`→`\` 双分隔符兜底并在该镜像上验证；标准 Android 设备走正常正斜杠路径，不受影响。

## 6. 已知限制

- 浏览器/E2E 使用 mock 网络层验证交互与数据流；**真实第三方 API 服务（OpenAI/DeepSeek 等）未用真实 Key 做线上联调**，需要用户填入自己的 Key 后使用「测试连接」验证。原生桥（Key 加密存储、系统返回键、状态栏、Toast、导出/导入、图片选择）已在 Android 13 模拟器上验证（见 5.1）。
- 图片选择（角色头像）与文件导入没有做自动化 UI 点击验证，代码路径已实现（`ACTION_GET_CONTENT` / `ACTION_OPEN_DOCUMENT`）。
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
