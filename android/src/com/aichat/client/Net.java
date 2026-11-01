package com.aichat.client;

import android.util.Base64;
import android.util.Log;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.SocketTimeoutException;
import java.net.URL;
import java.net.UnknownHostException;
import java.nio.charset.StandardCharsets;
import java.security.cert.CertificateException;
import java.util.Iterator;

import javax.net.ssl.SSLException;
import javax.net.ssl.SSLHandshakeException;

/** OpenAI 兼容接口的原生实现（HttpURLConnection，支持 SSE 流式）。 */
final class Net {

    private static final String TAG = "AiChatNet";

    interface StreamSink {
        void onDelta(String text);
        void onUsage(JSONObject usage);
        void onDone(JSONObject usage);
        void onError(JSONObject error);
    }

    private Net() { }

    /* ---------------- 工具 ---------------- */
    static String normalizeBase(String baseUrl) {
        String t = baseUrl == null ? "" : baseUrl.trim();
        while (t.endsWith("/")) t = t.substring(0, t.length() - 1);
        if (t.endsWith("/chat/completions")) t = t.substring(0, t.length() - "/chat/completions".length());
        return t;
    }

    static String chatUrl(String baseUrl) {
        String b = normalizeBase(baseUrl);
        return b.length() == 0 ? "" : b + "/chat/completions";
    }

    static String modelsUrl(String baseUrl) {
        String b = normalizeBase(baseUrl);
        return b.length() == 0 ? "" : b + "/models";
    }

    private static JSONObject errorObj(String code, String message) {
        JSONObject o = new JSONObject();
        try {
            o.put("code", code);
            o.put("message", message == null ? "" : message);
        } catch (JSONException ignore) { }
        return o;
    }

    private static JSONObject classify(Throwable e) {
        if (e instanceof SocketTimeoutException) return errorObj("timeout", "请求超时");
        if (e instanceof UnknownHostException) return errorObj("dns", "域名解析失败：" + e.getMessage());
        if (e instanceof SSLHandshakeException || e instanceof CertificateException) return errorObj("tls", "证书校验失败：" + e.getMessage());
        if (e instanceof SSLException) return errorObj("tls", "证书校验失败：" + e.getMessage());
        String msg = e.getMessage() == null ? e.getClass().getSimpleName() : e.getMessage();
        return errorObj("offline", "网络错误：" + msg);
    }

    private static HttpURLConnection open(String url, String apiKey, int connectMs, int readMs) throws IOException {
        HttpURLConnection conn = (HttpURLConnection) new URL(url).openConnection();
        conn.setRequestMethod("GET");
        conn.setConnectTimeout(connectMs);
        conn.setReadTimeout(readMs);
        conn.setRequestProperty("Accept", "application/json");
        conn.setRequestProperty("User-Agent", "AiChat-Android/1.0");
        if (apiKey != null && apiKey.length() > 0) conn.setRequestProperty("Authorization", "Bearer " + apiKey);
        return conn;
    }

    private static String readAll(InputStream is) throws IOException {
        if (is == null) return "";
        ByteArrayOutputStream bos = new ByteArrayOutputStream();
        byte[] buf = new byte[8192];
        int n;
        while ((n = is.read(buf)) > 0) bos.write(buf, 0, n);
        return new String(bos.toByteArray(), StandardCharsets.UTF_8);
    }

    private static String pickMessage(String body, int status) {
        if (body == null || body.length() == 0) return "HTTP " + status;
        try {
            JSONObject o = new JSONObject(body);
            if (o.has("error")) {
                Object err = o.opt("error");
                if (err instanceof JSONObject) {
                    String m = ((JSONObject) err).optString("message", "");
                    if (m.length() > 0) return m;
                } else if (err != null) {
                    return String.valueOf(err);
                }
            }
            if (o.has("message")) return o.optString("message", "HTTP " + status);
        } catch (JSONException ignore) { }
        return body.length() > 300 ? body.substring(0, 300) : body;
    }

    private static JSONObject httpFailure(int status, String body) {
        JSONObject o = new JSONObject();
        try {
            o.put("ok", false);
            o.put("status", status);
            o.put("models", new JSONArray());
            JSONObject err = errorObj(String.valueOf(status), pickMessage(body, status));
            o.put("error", err);
        } catch (JSONException ignore) { }
        return o;
    }

    /* ---------------- 测试连接 / 模型列表 ---------------- */
    static JSONObject models(JSONObject args) {
        String base = args.optString("baseUrl", "");
        String key = args.optString("apiKey", "");
        int timeout = args.optInt("timeoutMs", 20000);
        if (normalizeBase(base).length() == 0) {
            JSONObject o = new JSONObject();
            try {
                o.put("ok", false);
                o.put("models", new JSONArray());
                o.put("error", errorObj("nobase", "缺少 Base URL"));
            } catch (JSONException ignore) { }
            return o;
        }
        HttpURLConnection conn = null;
        try {
            conn = open(modelsUrl(base), key, Math.min(timeout, 15000), timeout);
            int status = conn.getResponseCode();
            InputStream is = status >= 200 && status < 300 ? conn.getInputStream() : conn.getErrorStream();
            String body = readAll(is);
            if (status < 200 || status >= 300) {
                JSONObject f = httpFailure(status, body);
                return f;
            }
            JSONArray models = new JSONArray();
            JSONObject o = new JSONObject(body.length() == 0 ? "{}" : body);
            Object data = o.opt("data");
            if (data instanceof JSONArray) {
                JSONArray arr = (JSONArray) data;
                for (int i = 0; i < arr.length(); i++) {
                    Object item = arr.opt(i);
                    if (item instanceof JSONObject) {
                        String id = ((JSONObject) item).optString("id", "");
                        if (id.length() > 0) models.put(id);
                    } else if (item instanceof String) {
                        models.put(item);
                    }
                }
            }
            JSONObject ok = new JSONObject();
            ok.put("ok", true);
            ok.put("status", status);
            ok.put("models", models);
            return ok;
        } catch (Exception e) {
            JSONObject o = new JSONObject();
            try {
                o.put("ok", false);
                o.put("models", new JSONArray());
                o.put("error", classify(e));
            } catch (JSONException ignore) { }
            return o;
        } finally {
            if (conn != null) conn.disconnect();
        }
    }

    /* ---------------- 请求体 ---------------- */
    private static JSONObject buildBody(JSONObject args, boolean stream) throws JSONException {
        JSONObject body = new JSONObject();
        body.put("model", args.optString("model", ""));
        body.put("messages", args.optJSONArray("messages") == null ? new JSONArray() : args.optJSONArray("messages"));
        body.put("stream", stream);
        JSONObject params = args.optJSONObject("params");
        if (params != null) {
            String[] numeric = new String[]{"temperature", "top_p", "top_k", "max_tokens", "presence_penalty", "frequency_penalty"};
            for (String k : numeric) {
                if (params.has(k) && !params.isNull(k)) {
                    Object v = params.opt(k);
                    if (v instanceof Number) body.put(k, v);
                    else {
                        try { body.put(k, Double.parseDouble(String.valueOf(v))); } catch (Exception ignore) { }
                    }
                }
            }
            Object stop = params.opt("stop");
            if (stop instanceof JSONArray) {
                JSONArray arr = (JSONArray) stop;
                if (arr.length() > 0) body.put("stop", arr);
            } else if (stop instanceof String && ((String) stop).length() > 0) {
                JSONArray arr = new JSONArray();
                arr.put(stop);
                body.put("stop", arr);
            }
        }
        return body;
    }

    /**
     * 安全读取字符串字段。
     * 注意：Android org.json 的 optString() 在值为 JSON null 时会返回字面量 "null"，
     * 兼容 API（推理模型、role-only 首包等）常发送 {"delta":{"content":null}}，
     * 直接用 optString 会把 "null" 当成正文拼进回复。这里只接受真正的字符串。
     */
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

    /* ---------------- 非流式对话 ---------------- */
    static JSONObject chat(JSONObject args) {
        String base = args.optString("baseUrl", "");
        String key = args.optString("apiKey", "");
        int timeout = args.optInt("timeoutMs", 120000);
        HttpURLConnection conn = null;
        try {
            conn = (HttpURLConnection) new URL(chatUrl(base)).openConnection();
            conn.setRequestMethod("POST");
            conn.setConnectTimeout(20000);
            conn.setReadTimeout(timeout);
            conn.setDoOutput(true);
            conn.setRequestProperty("Content-Type", "application/json; charset=utf-8");
            conn.setRequestProperty("Accept", "application/json");
            conn.setRequestProperty("User-Agent", "AiChat-Android/1.0");
            if (key.length() > 0) conn.setRequestProperty("Authorization", "Bearer " + key);
            byte[] payload = buildBody(args, false).toString().getBytes(StandardCharsets.UTF_8);
            OutputStream os = conn.getOutputStream();
            os.write(payload);
            os.flush();
            os.close();
            int status = conn.getResponseCode();
            InputStream is = status >= 200 && status < 300 ? conn.getInputStream() : conn.getErrorStream();
            String body = readAll(is);
            JSONObject out = new JSONObject();
            if (status < 200 || status >= 300) {
                out.put("ok", false);
                out.put("status", status);
                out.put("error", errorObj(String.valueOf(status), pickMessage(body, status)));
                return out;
            }
            JSONObject o = new JSONObject(body.length() == 0 ? "{}" : body);
            String text = extractText(o);
            JSONObject usage = o.optJSONObject("usage");
            out.put("ok", true);
            out.put("text", text);
            if (usage != null) out.put("usage", normalizeUsage(usage));
            return out;
        } catch (Exception e) {
            JSONObject out = new JSONObject();
            try {
                out.put("ok", false);
                out.put("error", classify(e));
            } catch (JSONException ignore) { }
            return out;
        } finally {
            if (conn != null) conn.disconnect();
        }
    }

    static JSONObject normalizeUsage(JSONObject usage) {
        JSONObject u = new JSONObject();
        try {
            u.put("prompt_tokens", usage.optInt("prompt_tokens", usage.optInt("input_tokens", 0)));
            u.put("completion_tokens", usage.optInt("completion_tokens", usage.optInt("output_tokens", 0)));
            int total = usage.optInt("total_tokens", 0);
            if (total == 0) total = u.optInt("prompt_tokens", 0) + u.optInt("completion_tokens", 0);
            u.put("total_tokens", total);
        } catch (JSONException ignore) { }
        return u;
    }

    /* ---------------- 流式对话（阻塞，由调用线程执行；通过 cancel 取消） ---------------- */
    static void stream(JSONObject args, StreamSink sink, CancelToken token) {
        String base = args.optString("baseUrl", "");
        String key = args.optString("apiKey", "");
        int timeout = args.optInt("timeoutMs", 180000);
        HttpURLConnection conn = null;
        try {
            conn = (HttpURLConnection) new URL(chatUrl(base)).openConnection();
            conn.setRequestMethod("POST");
            conn.setConnectTimeout(20000);
            conn.setReadTimeout(timeout);
            conn.setDoOutput(true);
            conn.setRequestProperty("Content-Type", "application/json; charset=utf-8");
            conn.setRequestProperty("Accept", "text/event-stream");
            conn.setRequestProperty("Cache-Control", "no-cache");
            conn.setRequestProperty("User-Agent", "AiChat-Android/1.0");
            if (key.length() > 0) conn.setRequestProperty("Authorization", "Bearer " + key);
            byte[] payload = buildBody(args, true).toString().getBytes(StandardCharsets.UTF_8);
            if (token != null) token.connection = conn;
            OutputStream os = conn.getOutputStream();
            os.write(payload);
            os.flush();
            os.close();

            int status = conn.getResponseCode();
            if (status < 200 || status >= 300) {
                String body = readAll(conn.getErrorStream());
                sink.onError(errorObj(String.valueOf(status), pickMessage(body, status)));
                return;
            }

            String contentType = conn.getContentType() == null ? "" : conn.getContentType().toLowerCase();
            InputStream is = conn.getInputStream();

            if (contentType.contains("text/event-stream") || contentType.contains("stream")) {
                BufferedReader reader = new BufferedReader(new InputStreamReader(is, StandardCharsets.UTF_8));
                String line;
                JSONObject usage = null;
                StringBuilder lineBuf = new StringBuilder();
                while ((line = reader.readLine()) != null) {
                    if (token != null && token.cancelled) break;
                    if (line.length() == 0) continue;
                    if (!line.startsWith("data:")) {
                        // 某些服务端会在 SSE 中夹杂注释/心跳
                        continue;
                    }
                    String data = line.substring(5).trim();
                    if (data.length() == 0) continue;
                    if ("[DONE]".equals(data)) break;
                    if (data.startsWith("{")) {
                        try {
                            JSONObject chunk = new JSONObject(data);
                            String text = extractText(chunk);
                            if (text.length() > 0) sink.onDelta(text);
                            JSONObject u = chunk.optJSONObject("usage");
                            if (u != null) { usage = normalizeUsage(u); sink.onUsage(usage); }
                            JSONObject err = chunk.optJSONObject("error");
                            if (err != null) {
                                sink.onError(errorObj(err.optString("code", "stream"), err.optString("message", "生成失败")));
                                return;
                            }
                        } catch (JSONException e) {
                            // 非完整 JSON（可能被拆分），先缓冲
                            lineBuf.append(data);
                            try {
                                JSONObject chunk = new JSONObject(lineBuf.toString());
                                String text = extractText(chunk);
                                if (text.length() > 0) sink.onDelta(text);
                                lineBuf.setLength(0);
                            } catch (JSONException ignore) { }
                        }
                    }
                }
                reader.close();
                if (token != null && token.cancelled) {
                    sink.onError(errorObj("cancel", "已取消"));
                    return;
                }
                sink.onDone(usage);
            } else {
                // 服务端忽略了 stream=true，直接返回完整 JSON
                String body = readAll(is);
                JSONObject o = new JSONObject(body.length() == 0 ? "{}" : body);
                String text = extractText(o);
                if (text.length() > 0) sink.onDelta(text);
                JSONObject usage = o.optJSONObject("usage");
                sink.onDone(usage == null ? null : normalizeUsage(usage));
            }
        } catch (Exception e) {
            if (token != null && token.cancelled) {
                sink.onError(errorObj("cancel", "已取消"));
            } else {
                sink.onError(classify(e));
            }
        } finally {
            if (token != null) token.connection = null;
            if (conn != null) conn.disconnect();
        }
    }

    static final class CancelToken {
        volatile boolean cancelled = false;
        volatile HttpURLConnection connection;

        void cancel() {
            cancelled = true;
            HttpURLConnection c = connection;
            if (c != null) {
                try { c.disconnect(); } catch (Exception ignore) { }
            }
        }
    }
}
