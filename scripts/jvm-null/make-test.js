const fs = require('fs');
const path = require('path');
const net = fs.readFileSync(path.join(__dirname, '..', '..', 'ai-chat-app', 'android', 'src', 'com', 'aichat', 'client', 'Net.java'), 'utf8');

function grab(startMarker) {
  const i = net.indexOf(startMarker);
  if (i < 0) throw new Error('not found: ' + startMarker);
  // find method body start
  const brace = net.indexOf('{', i);
  let depth = 0, j = brace;
  for (; j < net.length; j++) {
    const ch = net[j];
    if (ch === '{') depth++;
    else if (ch === '}') { depth--; if (depth === 0) { j++; break; } }
  }
  return net.slice(i, j);
}

const jstrMarker = 'private static String jstr(';
const extractMarker = 'private static String extractText(';
const jstrSrc = grab(jstrMarker);
const extractSrc = grab(extractMarker);

const test = `import org.json.JSONObject;
import org.json.JSONArray;

public class NetNullTest {
    // ==== 以下两个方法从 ai-chat-app/android/src/com/aichat/client/Net.java 原样提取 ====
${jstrSrc}

${extractSrc}
    // ==== 提取结束 ====

    static int fail = 0;
    static void check(String name, String json, String expect) {
        try {
            String got = extractText(new JSONObject(json));
            boolean ok = got.equals(expect) && !got.contains("null");
            if (!ok) { fail++; System.out.println("FAIL " + name + " -> [" + got + "] expect [" + expect + "]"); }
            else System.out.println("ok   " + name + " -> [" + got + "]");
        } catch (Exception e) {
            fail++;
            System.out.println("FAIL " + name + " exception " + e);
        }
    }

    public static void main(String[] args) {
        check("delta.content=null", "{\\"choices\\":[{\\"delta\\":{\\"content\\":null}}]}", "");
        check("delta.content=null+reasoning", "{\\"choices\\":[{\\"delta\\":{\\"content\\":null,\\"reasoning_content\\":\\"思考中\\"}}]}", "");
        check("delta.content=hello", "{\\"choices\\":[{\\"delta\\":{\\"content\\":\\"你好\\"}}]}", "你好");
        check("delta.content=null,delta.text=hi", "{\\"choices\\":[{\\"delta\\":{\\"content\\":null,\\"text\\":\\"hi\\"}}]}", "hi");
        check("delta.role only", "{\\"choices\\":[{\\"delta\\":{\\"role\\":\\"assistant\\",\\"content\\":\\"\\"}}]}", "");
        check("message.content=null", "{\\"choices\\":[{\\"message\\":{\\"content\\":null}}]}", "");
        check("message.content=abc", "{\\"choices\\":[{\\"message\\":{\\"content\\":\\"abc\\"}}]}", "abc");
        check("text field null", "{\\"choices\\":[{\\"text\\":null}]}", "");
        check("text field hi", "{\\"choices\\":[{\\"text\\":\\"hi\\"}]}", "hi");
        check("number content", "{\\"choices\\":[{\\"delta\\":{\\"content\\":42}}]}", "42");
        check("no choices", "{}", "");
        check("empty choices", "{\\"choices\\":[]}", "");

        // 流式拼接回归：null 增量不得拼进正文
        StringBuilder acc = new StringBuilder();
        String[] chunks = {
            "{\\"choices\\":[{\\"delta\\":{\\"content\\":null}}]}",
            "{\\"choices\\":[{\\"delta\\":{\\"content\\":\\"你好\\"}}]}",
            "{\\"choices\\":[{\\"delta\\":{\\"content\\":null,\\"reasoning_content\\":null}}]}",
            "{\\"choices\\":[{\\"delta\\":{\\"content\\":\\"，设备端测试回复。\\"}}]}"
        };
        for (String c : chunks) acc.append(extractText(new JSONObject(c)));
        String out = acc.toString();
        boolean ok = out.equals("你好，设备端测试回复。") && !out.contains("null");
        System.out.println((ok ? "ok   " : "FAIL ") + "stream concat -> [" + out + "]");
        if (!ok) fail++;

        System.out.println(fail == 0 ? "ALL PASS" : ("FAILURES: " + fail));
        if (fail != 0) System.exit(1);
    }
}
`;
fs.writeFileSync(path.join(__dirname, 'NetNullTest.java'), test, 'utf8');
console.log('written NetNullTest.java, jstr ' + jstrSrc.length + ' chars, extract ' + extractSrc.length + ' chars');

