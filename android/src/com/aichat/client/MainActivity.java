package com.aichat.client;

import android.Manifest;
import android.app.Activity;
import android.content.Intent;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.graphics.Color;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.util.Base64;
import android.util.Log;
import android.view.View;
import android.view.ViewGroup;
import android.webkit.ConsoleMessage;
import android.webkit.JavascriptInterface;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;
import android.widget.Toast;

import org.json.JSONObject;

import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.util.HashMap;
import java.util.Locale;
import java.util.Map;

/**
 * 单 Activity + WebView 壳。
 * 前端资源通过拦截 https://app.local/* 从 assets/www 读取，保证是正常 https origin
 * （IndexedDB / localStorage 可用）。网络请求全部走原生 Bridge（规避 CORS）。
 */
public class MainActivity extends Activity {

    private static final String TAG = "AiChat";
    private static final String HOST = "app.local";
    private static final int REQ_IMAGE = 1001;
    private static final int REQ_IMPORT = 1002;

    private WebView webView;
    private Bridge bridge;
    private String pendingImageId;
    private String pendingImportId;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP) {
            getWindow().setStatusBarColor(Color.parseColor("#EDEDED"));
            getWindow().setNavigationBarColor(Color.parseColor("#F7F7F7"));
            getWindow().getDecorView().setSystemUiVisibility(View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR);
        }

        FrameLayout root = new FrameLayout(this);
        root.setLayoutParams(new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        webView = new WebView(this);
        webView.setLayoutParams(new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        webView.setBackgroundColor(Color.parseColor("#F2F2F2"));
        root.addView(webView);
        setContentView(root);

        setupWebView();
        // 仅调试构建开放 chrome://inspect；发布版不暴露 WebView 调试端口。
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.KITKAT
                && (getApplicationInfo().flags & android.content.pm.ApplicationInfo.FLAG_DEBUGGABLE) != 0) {
            WebView.setWebContentsDebuggingEnabled(true);
        }
        bridge = new Bridge(this, webView);
        webView.addJavascriptInterface(bridge, "AndroidBridge");
        webView.loadUrl("https://" + HOST + "/index.html");
    }

    private void setupWebView() {
        WebSettings s = webView.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setDatabaseEnabled(true);
        s.setAllowFileAccess(false);
        s.setAllowContentAccess(false);
        s.setSupportZoom(false);
        s.setBuiltInZoomControls(false);
        s.setTextZoom(100);
        s.setMediaPlaybackRequiresUserGesture(true);
        s.setCacheMode(WebSettings.LOAD_DEFAULT);
        s.setJavaScriptCanOpenWindowsAutomatically(false);
        s.setMixedContentMode(WebSettings.MIXED_CONTENT_COMPATIBILITY_MODE);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP) {
            s.setOffscreenPreRaster(false);
        }

        webView.setWebViewClient(new WebViewClient() {
            @Override
            public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
                return serveAsset(request.getUrl());
            }

            @Override
            public WebResourceResponse shouldInterceptRequest(WebView view, String url) {
                return serveAsset(Uri.parse(url));
            }

            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                Uri uri = request.getUrl();
                if (uri != null && HOST.equals(uri.getHost())) return false;
                try {
                    Intent i = new Intent(Intent.ACTION_VIEW, uri);
                    i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                    startActivity(i);
                } catch (Exception e) {
                    Toast.makeText(MainActivity.this, "无法打开链接", Toast.LENGTH_SHORT).show();
                }
                return true;
            }
        });

        webView.setWebChromeClient(new WebChromeClient() {
            @Override
            public boolean onConsoleMessage(ConsoleMessage cm) {
                if (cm != null) {
                    Log.d(TAG, "console: " + cm.message() + " @" + cm.sourceId() + ":" + cm.lineNumber());
                }
                return true;
            }
        });
    }

    private WebResourceResponse serveAsset(Uri uri) {
        if (uri == null) return null;
        if (!HOST.equals(uri.getHost())) return null;
        String path = uri.getPath();
        if (path == null || path.length() == 0 || "/".equals(path)) path = "/index.html";
        if (path.contains("..")) return notFound();
        String assetPath = "www" + path;
        InputStream is = null;
        try {
            try {
                is = getAssets().open(assetPath);
            } catch (IOException e1) {
                // 部分 Windows 上 aapt2 生成的 APK 里资产路径用反斜杠（www\js\x.js），
                // Android 的 AssetManager 会按字面名匹配，需要再试一次反斜杠形式。
                String alt = assetPath.replace('/', '\\');
                if (alt.equals(assetPath)) throw e1;
                Log.w(TAG, "asset retry backslash: " + alt);
                is = getAssets().open(alt);
            }
            String mime = guessMime(path);
            String encoding = isTextMime(mime) ? "UTF-8" : null;
            Map<String, String> headers = new HashMap<>();
            headers.put("Cache-Control", "no-cache");
            return new WebResourceResponse(mime, encoding, 200, "OK", headers, is);
        } catch (IOException e) {
            Log.w(TAG, "asset miss: " + assetPath + " (" + e.getMessage() + ")");
            return notFound();
        }
    }

    private WebResourceResponse notFound() {
        Map<String, String> headers = new HashMap<>();
        headers.put("Content-Type", "text/plain; charset=utf-8");
        return new WebResourceResponse("text/plain", "UTF-8", 404, "Not Found", headers,
                new ByteArrayInputStream("404 Not Found".getBytes(StandardCharsets.UTF_8)));
    }

    private static boolean isTextMime(String mime) {
        return mime.startsWith("text/") || mime.contains("javascript") || mime.contains("json") || mime.contains("svg") || mime.contains("xml");
    }

    private static String guessMime(String path) {
        String p = path.toLowerCase(Locale.US);
        String mime = android.webkit.MimeTypeMap.getSingleton().getMimeTypeFromExtension(ext(p));
        if (mime != null && mime.length() > 0) return mime;
        if (p.endsWith(".js")) return "application/javascript";
        if (p.endsWith(".css")) return "text/css";
        if (p.endsWith(".json")) return "application/json";
        if (p.endsWith(".html")) return "text/html";
        if (p.endsWith(".svg")) return "image/svg+xml";
        if (p.endsWith(".webp")) return "image/webp";
        if (p.endsWith(".png")) return "image/png";
        if (p.endsWith(".jpg") || p.endsWith(".jpeg")) return "image/jpeg";
        return "application/octet-stream";
    }

    private static String ext(String path) {
        int i = path.lastIndexOf('.');
        return i >= 0 ? path.substring(i + 1) : "";
    }

    /* ---------------- 图片选择（头像） ---------------- */
    void pickImage(final String requestId) {
        runOnUiThread(new Runnable() {
            @Override
            public void run() {
                if (pendingImageId != null) {
                    bridge.deliverError(pendingImageId, "cancel", "上一次选择尚未结束");
                }
                pendingImageId = requestId;
                Intent intent = new Intent(Intent.ACTION_GET_CONTENT);
                intent.setType("image/*");
                intent.addCategory(Intent.CATEGORY_OPENABLE);
                try {
                    startActivityForResult(Intent.createChooser(intent, "选择头像"), REQ_IMAGE);
                } catch (Exception e) {
                    pendingImageId = null;
                    bridge.deliverError(requestId, "unknown", "无法打开图片选择器");
                }
            }
        });
    }

    /* ---------------- 文件导入（备份） ---------------- */
    void pickImport(final String requestId) {
        runOnUiThread(new Runnable() {
            @Override
            public void run() {
                pendingImportId = requestId;
                Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT);
                intent.setType("*/*");
                intent.addCategory(Intent.CATEGORY_OPENABLE);
                try {
                    startActivityForResult(intent, REQ_IMPORT);
                } catch (Exception e) {
                    pendingImportId = null;
                    bridge.deliverError(requestId, "unknown", "无法打开文件选择器");
                }
            }
        });
    }

    /* ---------------- 文件导出 ---------------- */
    void exportFile(final String requestId, final String name, final String data) {
        runOnUiThread(new Runnable() {
            @Override
            public void run() {
                try {
                    File dir = getExternalFilesDir(null);
                    if (dir == null) dir = getFilesDir();
                    File out = new File(dir, name == null || name.length() == 0 ? "aichat-export.json" : name);
                    FileOutputStream fos = new FileOutputStream(out);
                    fos.write(data == null ? new byte[0] : data.getBytes(StandardCharsets.UTF_8));
                    fos.close();
                    JSONObject r = new JSONObject();
                    r.put("ok", true);
                    r.put("path", out.getAbsolutePath());
                    bridge.deliver(requestId, true, r);
                    Toast.makeText(MainActivity.this, "已导出到 " + out.getAbsolutePath(), Toast.LENGTH_LONG).show();
                } catch (Exception e) {
                    bridge.deliverError(requestId, "unknown", "导出失败：" + e.getMessage());
                }
            }
        });
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode == REQ_IMAGE) {
            String id = pendingImageId;
            pendingImageId = null;
            if (id == null) return;
            if (resultCode != RESULT_OK || data == null || data.getData() == null) {
                bridge.deliverError(id, "cancel", "已取消选择");
                return;
            }
            handleImageResult(id, data.getData());
        } else if (requestCode == REQ_IMPORT) {
            String id = pendingImportId;
            pendingImportId = null;
            if (id == null) return;
            if (resultCode != RESULT_OK || data == null || data.getData() == null) {
                bridge.deliverError(id, "cancel", "已取消导入");
                return;
            }
            handleImportResult(id, data.getData());
        }
    }

    private void handleImageResult(final String id, final Uri uri) {
        new Thread(new Runnable() {
            @Override
            public void run() {
                try {
                    InputStream is = getContentResolver().openInputStream(uri);
                    BitmapFactory.Options opts = new BitmapFactory.Options();
                    opts.inJustDecodeBounds = true;
                    BitmapFactory.decodeStream(is, null, opts);
                    if (is != null) is.close();

                    int sample = 1;
                    int maxSide = Math.max(opts.outWidth, opts.outHeight);
                    while (maxSide / sample > 480) sample *= 2;

                    BitmapFactory.Options opts2 = new BitmapFactory.Options();
                    opts2.inSampleSize = sample;
                    is = getContentResolver().openInputStream(uri);
                    Bitmap bmp = BitmapFactory.decodeStream(is, null, opts2);
                    if (is != null) is.close();
                    if (bmp == null) {
                        bridge.deliverError(id, "unknown", "图片读取失败");
                        return;
                    }
                    int w = bmp.getWidth(), h = bmp.getHeight();
                    int target = 320;
                    if (Math.max(w, h) > target) {
                        float scale = target / (float) Math.max(w, h);
                        Bitmap scaled = Bitmap.createScaledBitmap(bmp, Math.max(1, Math.round(w * scale)), Math.max(1, Math.round(h * scale)), true);
                        if (scaled != bmp) bmp.recycle();
                        bmp = scaled;
                    }
                    ByteArrayOutputStream bos = new ByteArrayOutputStream();
                    bmp.compress(Bitmap.CompressFormat.JPEG, 82, bos);
                    bmp.recycle();
                    String b64 = Base64.encodeToString(bos.toByteArray(), Base64.NO_WRAP);
                    JSONObject r = new JSONObject();
                    r.put("dataUri", "data:image/jpeg;base64," + b64);
                    r.put("name", "avatar.jpg");
                    bridge.deliver(id, true, r);
                } catch (Exception e) {
                    bridge.deliverError(id, "unknown", "图片处理失败：" + e.getMessage());
                }
            }
        }).start();
    }

    private void handleImportResult(final String id, final Uri uri) {
        new Thread(new Runnable() {
            @Override
            public void run() {
                try {
                    String name = "backup.json";
                    try {
                        android.database.Cursor c = getContentResolver().query(uri, null, null, null, null);
                        if (c != null) {
                            int idx = c.getColumnIndex(android.provider.OpenableColumns.DISPLAY_NAME);
                            if (idx >= 0 && c.moveToFirst()) name = c.getString(idx);
                            c.close();
                        }
                    } catch (Exception ignore) { }
                    InputStream is = getContentResolver().openInputStream(uri);
                    ByteArrayOutputStream bos = new ByteArrayOutputStream();
                    byte[] buf = new byte[8192];
                    int n;
                    int total = 0;
                    while ((n = is.read(buf)) > 0) {
                        bos.write(buf, 0, n);
                        total += n;
                        if (total > 8 * 1024 * 1024) throw new IOException("文件过大（超过 8MB）");
                    }
                    is.close();
                    JSONObject r = new JSONObject();
                    r.put("name", name);
                    r.put("data", new String(bos.toByteArray(), StandardCharsets.UTF_8));
                    bridge.deliver(id, true, r);
                } catch (Exception e) {
                    bridge.deliverError(id, "unknown", "读取文件失败：" + e.getMessage());
                }
            }
        }).start();
    }

    /* ---------------- 状态栏 ---------------- */
    void setStatusBarStyle(final String colorHex, final boolean darkTheme) {
        runOnUiThread(new Runnable() {
            @Override
            public void run() {
                try {
                    int color = Color.parseColor(colorHex);
                    getWindow().setStatusBarColor(color);
                    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                        getWindow().setNavigationBarColor(darkTheme ? Color.parseColor("#1c1c1e") : Color.parseColor("#F7F7F7"));
                    }
                    View decor = getWindow().getDecorView();
                    int flags = decor.getSystemUiVisibility();
                    if (!darkTheme) {
                        flags |= View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR;
                    } else {
                        flags &= ~View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR;
                    }
                    decor.setSystemUiVisibility(flags);
                } catch (Exception ignore) { }
            }
        });
    }

    /* ---------------- 返回键 ---------------- */
    @Override
    public void onBackPressed() {
        if (webView == null) { super.onBackPressed(); return; }
        webView.evaluateJavascript("(function(){try{return window.__handleBack?window.__handleBack():false}catch(e){return false}})()", new ValueCallback<String>() {
            @Override
            public void onReceiveValue(String value) {
                boolean handled = value != null && value.contains("true");
                if (!handled) finish();
            }
        });
    }

    @Override
    protected void onPause() {
        super.onPause();
        if (webView != null) webView.onPause();
    }

    @Override
    protected void onResume() {
        super.onResume();
        if (webView != null) webView.onResume();
    }

    @Override
    protected void onDestroy() {
        if (bridge != null) bridge.shutdown();
        if (webView != null) {
            try {
                webView.removeJavascriptInterface("AndroidBridge");
                webView.destroy();
            } catch (Exception ignore) { }
            webView = null;
        }
        super.onDestroy();
    }
}
