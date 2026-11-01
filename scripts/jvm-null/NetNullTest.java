import org.json.JSONObject;
import org.json.JSONArray;

public class NetNullTest {
    // ==== 以下两个方法从 ai-chat-app/android/src/com/aichat/client/Net.java 原样提取 ====
private static String jstr(JSONObject o, String key) {
        if (o == null || key == null) return "";
        try {
            if (!o.has(key) || o.isNull(key)) return "";
            Object v = o.opt(key);
            if (v instanceof String) return (String) v;
            if (v instanceof Number || v instanceof Boolean) return String.valueOf(v);
            return "";
        } catch (Exception e) {
            return "";
        }
    }

private static String extractText(JSONObject chunk) {
        try {
            JSONArray choices = chunk.optJSONArray("choices");
            if (choices == null || choices.length() == 0) return "";
            JSONObject c = choices.optJSONObject(0);
            if (c == null) return "";
            JSONObject delta = c.optJSONObject("delta");
            if (delta != null) {
                String s = jstr(delta, "content");
                if (s.length() > 0) return s;
                // 少数兼容实现把增量放在 delta.text
                String t = jstr(delta, "text");
                if (t.length() > 0) return t;
                // reasoning_content / reasoning 是思考过程，不属于正文，忽略
                return "";
            }
            JSONObject msg = c.optJSONObject("message");
            if (msg != null) return jstr(msg, "content");
            return jstr(c, "text");
        } catch (Exception e) {
            return "";
        }
    }
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
        check("delta.content=null", "{\"choices\":[{\"delta\":{\"content\":null}}]}", "");
        check("delta.content=null+reasoning", "{\"choices\":[{\"delta\":{\"content\":null,\"reasoning_content\":\"思考中\"}}]}", "");
        check("delta.content=hello", "{\"choices\":[{\"delta\":{\"content\":\"你好\"}}]}", "你好");
        check("delta.content=null,delta.text=hi", "{\"choices\":[{\"delta\":{\"content\":null,\"text\":\"hi\"}}]}", "hi");
        check("delta.role only", "{\"choices\":[{\"delta\":{\"role\":\"assistant\",\"content\":\"\"}}]}", "");
        check("message.content=null", "{\"choices\":[{\"message\":{\"content\":null}}]}", "");
        check("message.content=abc", "{\"choices\":[{\"message\":{\"content\":\"abc\"}}]}", "abc");
        check("text field null", "{\"choices\":[{\"text\":null}]}", "");
        check("text field hi", "{\"choices\":[{\"text\":\"hi\"}]}", "hi");
        check("number content", "{\"choices\":[{\"delta\":{\"content\":42}}]}", "42");
        check("no choices", "{}", "");
        check("empty choices", "{\"choices\":[]}", "");

        // 流式拼接回归：null 增量不得拼进正文
        StringBuilder acc = new StringBuilder();
        String[] chunks = {
            "{\"choices\":[{\"delta\":{\"content\":null}}]}",
            "{\"choices\":[{\"delta\":{\"content\":\"你好\"}}]}",
            "{\"choices\":[{\"delta\":{\"content\":null,\"reasoning_content\":null}}]}",
            "{\"choices\":[{\"delta\":{\"content\":\"，设备端测试回复。\"}}]}"
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
