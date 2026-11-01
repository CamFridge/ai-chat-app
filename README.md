# AI 聊天 · Android App

按 [`prompt-01-需求提示词.md`](prompt-01-需求提示词.md) 实现的微信式 AI 聊天应用：远程 OpenAI 兼容 API、角色/世界观体系、强制首次引导、应用内悬浮引导气泡。**零第三方依赖**（原生 Java 壳 + 纯 HTML/CSS/vanilla JS），手工构建管线（aapt2 → javac → d8 → zipalign → apksigner），不依赖 Gradle。

## 安装包

| 项 | 值 |
| --- | --- |
| 文件 | [`build/AI-Chat-1.1.0.apk`](build/AI-Chat-1.1.0.apk) |
| 大小 | 281,685 bytes（0.27 MB） |
| SHA-256 | `978A9A1969BF04FA23720DE67BF6D4BDC04A7C41F0BA975C9FC93453E6DBF932` |
| 包名 / 版本 | `com.aichat.client` / 1.1.1（versionCode 3） |
| 系统要求 | Android 8.0+（minSdk 26，targetSdk 34） |
| 签名 | v2 + v3，证书 `CN=AI Chat`，SHA-256 `F4AAA0A8AC71DCA67AD95F290F106A44C12D694F8477305FB213828AB92D2590` |

```powershell
adb install -r build\AI-Chat-1.1.0.apk
```

也可以把 APK 传到手机点击安装（允许「安装未知来源应用」）。首次启动会强制进入 6 步「引导 API」向导，测试连接不通过无法进入主界面。

签名密钥库：[`keystore/aichat-release.jks`](keystore/aichat-release.jks)（alias `aichat`，口令 `aichat2026`）。

## 本版更新

- **流畅度修复（v1.1.1，针对「一卡一卡 / 点好几遍没反应」）**：移除悬浮引导球常驻的 `backdrop-filter` 背景模糊（Android WebView 上会强制整页重绘）；原生桥把 SSE 流式增量按约 55ms 合并后再回传，避免大量 `evaluateJavascript` 挤占 UI 线程；聊天流式渲染限制为最多每 90ms 一次完整 Markdown/图片渲染；修复 `Router.onChange` 无法退订导致的监听累积泄漏；按钮/Tab/列表行统一 `touch-action: manipulation`。
- **角色图片库**：每个角色独立图片库（最多 60 张），编辑角色页可添加/预览/重命名/删除；引导助手发图后可一键「加到角色图片库」。
- **聊天收发图片与文件**：输入框「＋」可发相册图片（多模态发送）或文本文件；角色会根据图片库用 `[[img:ID]]` 主动发图。
- **动作/神态斜体**：模型用 `*动作*` 表示动作神态，渲染为斜体细字，台词保持正文字体。
- **上帝模式**：设置中开启后角色知道自己只是虚拟角色，可以和你聊这件事。
- **修复弹窗/操作菜单不可见**：入场动画类与 CSS 选择器不匹配导致 modal/sheet 透明，已修复。
- **修复助手/角色回复出现「一串 null」**：Android `org.json` 的 `optString` 在字段值为 JSON `null` 时返回字面量 `"null"`，部分兼容服务会发 `{"delta":{"content":null}}`（推理模型、首包 role-only）。原生层改为 `jstr()` 严格取值（跳过 null/非字符串、忽略 `reasoning_content`），前端三层再防御非字符串增量。
- **「AI 补全」生成页重做**（角色创建第 4 步 / 世界观补全）：实时流式显示生成内容、真实耗时与「已接收 N 字 / 第 N 次尝试」、可随时「停止生成」且保留已收内容、失败不再从头重来（可继续生成 / 换 API / 手动填写）、按钮精简为最多两个主操作。

## 功能

- **4 Tab**：聊天 / 角色 / API / 设置（微信式布局，浅色 / 深色 / AMOLED 三种主题）。
- **聊天**：会话列表（置顶、搜索、未读）、流式输出、停止保留内容、重新生成、多版本切换、继续生成、编辑/复制/删除、上下文裁剪、会话内切换 API/模型。
- **角色**：陪聊角色 / 领域助手（10 大领域 → 专业映射）；5 步创建向导，AI 补全严格 JSON（失败重试 1 次 + 手动兜底）、草稿持久化、预览标注「AI 补全 / 你填写」、「让 AI 改」多版本回滚。
- **世界观**：现代都市 / 古代宫廷 / 校园日常 / 赛博朋克 / ABO / 斗破苍穹 / 无，支持自定义 + AI 补全。
- **API 管理**：任意 OpenAI 兼容端点、连接测试、模型列表、引导 API 与默认聊天 API、Key 经 AndroidKeyStore AES-256-GCM 加密后存 SharedPreferences（不写库、不进导出备份）。
- **引导助手**：独立 help 会话、静态 FAQ 兜底、错误提示带上下文提问。
- **悬浮引导气泡**：52dp 小球、拖动吸附左右、位置记忆、扇形 3~4 项、「怎么走」返回可点击步骤并高亮/跳转目标控件。

## 验证

- 无头 Chrome E2E：`scripts/audit.js`、`scripts/e2e-onboarding.js`(26)、`scripts/e2e-character.js`(28)、`scripts/e2e-chat.js`(16)、`scripts/e2e-guide.js`(14)、`scripts/e2e-acceptance.js`(32)、`scripts/e2e-media.js`(46) 全部通过。
- 「一串 null」修复单测（桌面 JVM + 真实 `org.json`，从 `Net.java` 原样提取方法）：`scripts/jvm-null/` **13/13 ALL PASS**（null 增量、reasoning_content 忽略、流式拼接不含 "null"）。
- 设备端验证（v1.1.1 发布包，Android 13 / API 33 模拟器，AEHD 加速）：`scripts/device-e2e.js` **17/17**（原生桥、主界面、聊天流式回复并落库、气泡扇面、暗色主题、无 JS 异常）、`scripts/device-null.js` **3/3**、`scripts/device-media-smoke.js` **7/7**（图片库、动作斜体、角色发图、上帝模式 prompt）；触摸实测：Tab 切换 103–360ms、流式中点「停止」357ms 响应；系统返回键行为正确；截图见 `build/device/`（含 `21-media-god.png`）。
- 截图：`build/shots/`、`build/shots-extra/`、`build/device/`（`80-81` 图片库与预览、`82-84` 附件与发图/斜体、`85` 上帝模式、`86` 帮助加图）。

## 构建

```powershell
pwsh -NoProfile -ExecutionPolicy Bypass -File scripts\build.ps1 -Clean        # 发布包
pwsh -NoProfile -ExecutionPolicy Bypass -File scripts\build.ps1 -DebugMode    # 调试包（WebView 可调试）
```

需要 JDK 17 与 `tools/android-sdk`（build-tools 34.0.0 + android-34；可用 `scripts/setup-sdk.ps1` 安装）。

## 目录

```
android/            原生壳（Java）+ 前端资源 assets/www（13 个页面 + 7 个核心模块）
scripts/            构建、SDK 安装、预览服务器、E2E 验证脚本
keystore/           发布签名密钥库
docs/CONTRACT.md    前端模块契约
docs/DELIVERY.md    交付说明（指纹、27 条验收对照、验证结果、已知限制）
build/              构建产物与截图
```

详细交付说明见 [`docs/DELIVERY.md`](docs/DELIVERY.md)。
