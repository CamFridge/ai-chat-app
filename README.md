# AI 聊天（ai-chat-app）

原生 Android（Java 壳 + WebView 纯 HTML/CSS/vanilla JS，**零第三方依赖**、不依赖 Gradle）实现的微信式 AI 聊天应用：多 API 提供商、角色卡、世界观、流式回复、图片/文件消息、引导向导与悬浮引导气泡。

- 包名：`com.aichat.client`
- 系统要求：Android 8.0+（minSdk 26，targetSdk 34）
- 签名：v2 + v3，证书 `CN=AI Chat`，SHA-256 `F4AAA0A8AC71DCA67AD95F290F106A44C12D694F8477305FB213828AB92D2590`

## 版本与下载

| 版本 | versionCode | APK | 大小 | SHA-256 |
| --- | --- | --- | --- | --- |
| **v1.1.0** | 2 | [AI-Chat-1.1.0.apk](https://github.com/CamFridge/ai-chat-app/releases/download/v1.1.0/AI-Chat-1.1.0.apk) | 277,589 bytes | `dc7f19738f901e2c5cdabc7cd22356478a489c082ab028b14f7a585fea9d5577` |
| **v1.0.0** | 1 | [AI-Chat-1.0.0.apk](https://github.com/CamFridge/ai-chat-app/releases/download/v1.0.0/AI-Chat-1.0.0.apk) | 261,137 bytes | `e1ccb36074dd5378d719e9da83ebb3aa6071bd0e584e8aabfc853b6249e7b339` |

两版使用同一签名密钥，`versionCode` 递增，**v1.1.0 可直接覆盖安装 v1.0.0**（会话数据保留）。

```powershell
adb install -r AI-Chat-1.1.0.apk
```

也可以把 APK 传到手机点击安装（需允许「安装未知来源应用」）。首次启动会强制进入「引导 API」向导，测试连接不通过无法进入主界面。

源码快照按版本打了 tag：`v1.0.0` / `v1.1.0`；`releases/` 目录同样存放这两个 APK。

> v1.0.0 的 APK 由该版本源码重新构建，产物大小与最初交付文件一致（261,137 bytes）；因构建时间戳不同，SHA-256 与当初那一份不同。v1.1.0 的 APK 即原始交付文件。

## 本版更新（v1.1.0）

- **角色图片库**：上传、预览、选择角色图片。
- **聊天收发图片与文件**：附件 chip、图片预览、文件消息。
- **动作描写斜体**：消息内 `*动作*` 渲染。
- **上帝模式**：绕过角色设定直接对话（设置项）。
- **修复「一串 null」**：Android `org.json` 的 `optString` 在字段值为 JSON `null` 时返回字面量 `"null"`，部分兼容服务会发 `{"delta":{"content":null}}`（推理模型、首包 role-only）。原生层改为 `jstr()` 严格取值，前端三层再防御非字符串增量。
- **「AI 补全」生成页重做**（角色创建第 4 步 / 世界观补全）：实时流式显示、真实耗时与「已接收 N 字 / 第 N 次尝试」、可随时停止且保留已收内容、失败可继续生成，不再从头重来。

v1.0.0 已包含：4 Tab（聊天 / 角色 / API / 设置）、浅色·深色·AMOLED 三主题、流式输出与停止/重新生成/多版本切换、5 步角色创建向导、世界观库与 AI 补全、API 管理与连接测试、Key 经 AndroidKeyStore AES-256-GCM 加密、引导助手与悬浮引导气泡（52dp 小球、拖动吸附、扇形菜单、步骤高亮）。

## 截图

| 会话 | 聊天列表 | 世界观 |
| --- | --- | --- |
| ![chat](docs/screenshots/chat.png) | ![chat-list](docs/screenshots/chat-list.png) | ![worldviews](docs/screenshots/worldviews.png) |

| 图片库 | 聊天附件 | 动作斜体 |
| --- | --- | --- |
| ![media-library](docs/screenshots/media-library.png) | ![attachments](docs/screenshots/attachments.png) | ![image-italic](docs/screenshots/image-italic.png) |

更多截图见 `docs/screenshots/`。

## 目录结构

```
android/
  AndroidManifest.xml
  src/com/aichat/client/        Java 原生壳（MainActivity / Bridge / Net / SecureStore）
  assets/www/                   前端（原生 JS，无框架）
    index.html
    css/                        base / pages-chat / pages-char / pages-guide / pages-config
    js/                         app 内核 + pages/ + data/（角色预设、FAQ、世界观）
  res/                          图标与资源
scripts/                        构建与自动化
  build.ps1                     aapt2 + javac + d8 + zipalign + apksigner 一键打包
  setup-sdk.ps1                 下载最小 Android SDK
  preview-server.js             本地预览（浏览器 mock 模式）
  mock-sse-server.js            本地 SSE mock（流式联调）
  e2e-*.js                      无头 Chrome E2E（引导、聊天、角色、媒体…）
  device-e2e.js / device-null.js 真机·模拟器端到端与 null 回归
  audit.js                      引用/资源审计
  shots-*.js                    批量截图
docs/
  CONTRACT.md                   前端模块契约
  DELIVERY.md                   交付说明（指纹、验收对照、验证结果）
  FEATURE-media-god.md          v1.1 媒体 / 上帝模式设计
  screenshots/                  截图
releases/
  v1.0.0/AI-Chat-1.0.0.apk
  v1.1.0/AI-Chat-1.1.0.apk
```

## 构建

前置：JDK 17 + PowerShell 7；Android SDK 由脚本下载。

```powershell
# 首次：安装最小 SDK（cmdline-tools + platforms;android-34 + build-tools;34.0.0）
pwsh -NoProfile -ExecutionPolicy Bypass -File scripts\setup-sdk.ps1

# 发布包（build/AI-Chat-<版本>.apk，自动签名 + 校验 v2/v3）
pwsh -NoProfile -ExecutionPolicy Bypass -File scripts\build.ps1 -Clean

# 调试包（WebView 可调试）
pwsh -NoProfile -ExecutionPolicy Bypass -File scripts\build.ps1 -DebugMode
```

版本号维护在 `scripts/build.ps1` 顶部（`$VersionCode` / `$VersionName`）与 `android/AndroidManifest.xml`。构建脚本在缺少密钥库时会自动生成 `keystore/aichat-release.jks`。

> 本仓库**不包含**签名密钥库与 Android SDK（见 `.gitignore`）。发布用 APK 由维护者私有 keystore 签名；自行构建的 APK 会用你自己的密钥签名，功能一致但签名不同，不能覆盖安装官方包。

## 开发与测试

```powershell
node scripts/preview-server.js                               # 本地预览（浏览器 mock 模式）
node scripts/mock-sse-server.js 8899                         # 本地 SSE mock
node scripts/e2e-acceptance.js 9222 http://127.0.0.1:8321    # E2E（Chrome DevTools Protocol）
node scripts/audit.js                                        # 资源/引用审计
```

E2E 通过 CDP 驱动无头 Chrome（`scripts/cdp.js`），移动端视口，覆盖首次引导、API 配置与测试、会话与流式、角色创建向导、世界观生成、媒体消息、null 回归等；结果见 `docs/DELIVERY.md`。

## 已知限制

- 仅 Android（无 iOS / 桌面端）
- 未上架应用商店，需自行侧载
- 前端无构建步骤：直接改 `android/assets/www` 即可生效
