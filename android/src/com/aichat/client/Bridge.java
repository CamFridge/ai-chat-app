package com.aichat.client;

import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.Context;
import android.os.Build;
import android.os.Vibrator;
import android.util.Log;
import android.webkit.JavascriptInterface;
import android.webkit.WebView;
import android.widget.Toast;

import org.json.JSONObject;

import java.util.HashMap;
import java.util.Map;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * JS <-> Java 桥。每个调用带唯一 id，结果通过 window.__nativeResult(id, ok, jsonString) 回传；
 * 流式事件通过 window.__nativeEvent(id, jsonString) 回传。
 * 所有 net.* 都在后台线程执行，安全相关方法同步执行（体积小）。
 */
public class Bridge {

    private static final String TAG = "AiChatBridge";

    private final MainActivity activity;
    private final WebView webView;
    private final ExecutorService io = Executors.newCachedThreadPool();
    private final Map<String, Net.CancelToken> streams = new HashMap<>();

    Bridge(MainActivity activity, WebView webView) {
        this.activity = activity;
        this.webView = webView;
    }

    /* ---------------- 入口 ---------------- */
    @JavascriptInterface
    public void call(final String id, final String method, final String argsJson) {
        JSONObject args;
        try {
            args = new JSONObject(argsJson == null || argsJson.length() == 0 ? "{}" : argsJson);
        } catch (Exception e) {
            deliverError(id, "unknown", "参数不是合法 JSON");
            return;
        }
        try {
            dispatch(id, method == null ? "" : method, args);
        } catch (Throwable t) {
            Log.e(TAG, "bridge dispatch failed: " + method, t);
            deliverError(id, "unknown", String.valueOf(t.getMessage()));
        }
    }

    private void dispatch(final String id, final String method, final JSONObject args) {
        switch (method) {
            case "app.info":
                deliver(id, true, appInfo());
                return;
            case "app.setBackGuard":
                deliverOk(id);
                return;

            /* ---- 安全存储 ---- */
            case "secure.set":
                deliver(id, true, SecureStore.set(activity, args.optString("key", ""), args.optString("value", "")));
                return;
            case "secure.get": {
                JSONObject o = new JSONObject();
                try {
                    o.put("value", SecureStore.get(activity, args.optString("key", "")));
                } catch (Exception e) {
                    try { o.put("value", ""); } catch (Exception ignore) { }
                }
                deliver(id, true, o);
                return;
            }
            case "secure.del":
                deliver(id, true, SecureStore.del(activity, args.optString("key", "")));
                return;

            /* ---- UI ---- */
            case "ui.toast":
                toast(args.optString("text", ""), args.optString("type", "info"));
                deliverOk(id);
                return;
            case "ui.copy": {
                final String text = args.optString("text", "");
                activity.runOnUiThread(new Runnable() {
                    @Override
                    public void run() {
                        try {
                            ClipboardManager cm = (ClipboardManager) activity.getSystemService(Context.CLIPBOARD_SERVICE);
                            if (cm != null) {
                                cm.setPrimaryClip(ClipData.newPlainText("AI 聊天", text));
                                deliverOk(id);
                                return;
                            }
                        } catch (Exception ignore) { }
                        JSONObject r = new JSONObject();
                        try { r.put("ok", false); } catch (Exception ignore) { }
                        deliver(id, true, r);
                    }
                });
                return;
            }
            case "ui.vibrate": {
                try {
                    Vibrator v = (Vibrator) activity.getSystemService(Context.VIBRATOR_SERVICE);
                    if (v != null && v.hasVibrator()) v.vibrate(Math.max(5, Math.min(120, args.optInt("ms", 15))));
                } catch (Exception ignore) { }
                deliverOk(id);
                return;
            }
            case "ui.statusBar": {
                activity.setStatusBarStyle(args.optString("color", "#EDEDED"), args.optBoolean("dark", true));
                deliverOk(id);
                return;
            }
            case "ui.pickImage":
                activity.pickImage(id);
                return;

            /* ---- 文件 ---- */
            case "file.import":
                activity.pickImport(id);
                return;
            case "file.export":
                activity.exportFile(id, args.optString("name", "aichat-export.json"), args.optString("data", ""));
                return;

            /* ---- 网络 ---- */
            case "net.test":
            case "net.models":
                io.execute(new Runnable() {
                    @Override
                    public void run() {
                        deliver(id, true, Net.models(args));
                    }
                });
                return;
            case "net.chat":
                io.execute(new Runnable() {
                    @Override
                    public void run() {
                        deliver(id, true, Net.chat(args));
                    }
                });
                return;
            case "net.stream":
                startStream(id, args);
                return;
            case "net.abort": {
                final String sid = args.optString("id", "");
                Net.CancelToken token;
                synchronized (streams) {
                    token = streams.remove(sid);
                }
                if (token != null) token.cancel();
                deliverOk(id);
                return;
            }
            default:
                deliverOk(id);
        }
    }

    /* ---------------- 流式 ---------------- */
    private void startStream(final String id, final JSONObject args) {
        final Net.CancelToken token = new Net.CancelToken();
        synchronized (streams) {
            streams.put(id, token);
        }
        io.execute(new Runnable() {
            @Override
            public void run() {
                Net.stream(args, new Net.StreamSink() {
                    @Override
                    public void onDelta(String text) {
                        event(id, "delta", "text", text);
                    }

                    @Override
                    public void onUsage(JSONObject usage) {
                        JSONObject ev = baseEvent("usage");
                        try { ev.put("usage", usage); } catch (Exception ignore) { }
                        postEvent(id, ev);
                    }

                    @Override
                    public void onDone(JSONObject usage) {
                        cleanup(id);
                        JSONObject ev = baseEvent("done");
                        try { ev.put("usage", usage == null ? new JSONObject() : usage); } catch (Exception ignore) { }
                        postEvent(id, ev);
                    }

                    @Override
                    public void onError(JSONObject error) {
                        cleanup(id);
                        JSONObject ev = baseEvent("error");
                        try { ev.put("error", error == null ? new JSONObject() : error); } catch (Exception ignore) { }
                        postEvent(id, ev);
                    }
                }, token);
            }
        });
    }

    private void cleanup(String id) {
        synchronized (streams) {
            streams.remove(id);
        }
    }

    private JSONObject baseEvent(String type) {
        JSONObject ev = new JSONObject();
        try { ev.put("type", type); } catch (Exception ignore) { }
        return ev;
    }

    private void event(String id, String type, String key, String value) {
        JSONObject ev = baseEvent(type);
        try { ev.put(key, value); } catch (Exception ignore) { }
        postEvent(id, ev);
    }

    private void postEvent(final String id, final JSONObject ev) {
        webView.post(new Runnable() {
            @Override
            public void run() {
                eval("window.__nativeEvent(" + JSONObject.quote(id) + "," + JSONObject.quote(ev.toString()) + ");");
            }
        });
    }

    /* ---------------- 回传 ---------------- */
    void deliver(final String id, final boolean ok, final JSONObject payload) {
        final String json = payload == null ? "{}" : payload.toString();
        webView.post(new Runnable() {
            @Override
            public void run() {
                eval("window.__nativeResult(" + JSONObject.quote(id) + "," + (ok ? "true" : "false") + "," + JSONObject.quote(json) + ");");
            }
        });
    }

    void deliverError(String id, String code, String message) {
        JSONObject o = new JSONObject();
        try {
            o.put("code", code);
            o.put("message", message == null ? "" : message);
        } catch (Exception ignore) { }
        deliver(id, false, o);
    }

    void deliverOk(String id) {
        JSONObject o = new JSONObject();
        try { o.put("ok", true); } catch (Exception ignore) { }
        deliver(id, true, o);
    }

    private void eval(final String js) {
        try {
            webView.evaluateJavascript(js, null);
        } catch (Exception e) {
            Log.w(TAG, "evaluateJavascript failed", e);
        }
    }

    /* ---------------- 杂项 ---------------- */
    private JSONObject appInfo() {
        JSONObject o = new JSONObject();
        try {
            o.put("version", activity.getPackageManager().getPackageInfo(activity.getPackageName(), 0).versionName);
            o.put("package", activity.getPackageName());
            o.put("platform", "android");
            o.put("apiLevel", Build.VERSION.SDK_INT);
            o.put("device", Build.MANUFACTURER + " " + Build.MODEL);
            o.put("webview", Build.VERSION.SDK_INT >= 26 ? "modern" : "legacy");
        } catch (Exception ignore) { }
        return o;
    }

    private void toast(final String text, final String type) {
        activity.runOnUiThread(new Runnable() {
            @Override
            public void run() {
                try {
                    Toast.makeText(activity, text, "error".equals(type) ? Toast.LENGTH_LONG : Toast.LENGTH_SHORT).show();
                } catch (Exception ignore) { }
            }
        });
    }

    void shutdown() {
        synchronized (streams) {
            for (Net.CancelToken t : streams.values()) {
                if (t != null) t.cancel();
            }
            streams.clear();
        }
        io.shutdownNow();
    }
}
