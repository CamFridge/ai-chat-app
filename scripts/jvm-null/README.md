# JVM null 处理单测（不依赖 Android）

`Net.java` 的 `jstr()` / `extractText()` 负责把 SSE chunk 里的增量文本安全取出。
Android 的 `org.json` 在字段值为 JSON `null` 时，`optString()` 会返回字面量 `"null"`，
兼容 API（推理模型、role-only 首包）常发 `{"delta":{"content":null}}`，若不处理就会把
"null" 拼进回复。本目录用桌面版 `org.json` 对**从 Net.java 原样提取的两个方法**做回归。

## 运行

```powershell
cd ai-chat-app\scripts\jvm-null
curl.exe -L -o json.jar https://repo1.maven.org/maven2/org/json/json/20240303/json-20240303.jar
node make-test.js                 # 从 android/src/com/aichat/client/Net.java 提取方法生成 NetNullTest.java
javac -encoding UTF-8 -cp json.jar -d . NetNullTest.java
java -cp ".;json.jar" NetNullTest
```

预期输出：`ALL PASS`（13 项，含 null 增量、reasoning_content 忽略、流式拼接不含 "null"）。
