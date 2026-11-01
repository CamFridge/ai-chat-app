package com.aichat.client;

import android.content.Context;
import android.content.SharedPreferences;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.Base64;
import android.util.Log;

import org.json.JSONObject;

import java.nio.charset.StandardCharsets;
import java.security.KeyStore;

import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

/**
 * API Key 等敏感数据的本地加密存储：
 * AndroidKeyStore 生成不可导出的 AES-256 密钥，AES/GCM/NoPadding 加密，
 * 密文（iv + ciphertext）以 Base64 存 SharedPreferences。
 * 密钥丢失/失效时自动重建（旧密文解密失败返回空，由上层提示重新填写）。
 */
final class SecureStore {

    private static final String TAG = "AiChatSecure";
    private static final String ANDROID_KEYSTORE = "AndroidKeyStore";
    private static final String KEY_ALIAS = "aichat_master_key_v1";
    private static final String PREF = "aichat_secure";
    private static final String TRANSFORMATION = "AES/GCM/NoPadding";
    private static final int GCM_TAG_BITS = 128;

    private SecureStore() { }

    private static SharedPreferences prefs(Context ctx) {
        return ctx.getSharedPreferences(PREF, Context.MODE_PRIVATE);
    }

    private static SecretKey getOrCreateKey() throws Exception {
        KeyStore ks = KeyStore.getInstance(ANDROID_KEYSTORE);
        ks.load(null);
        if (ks.containsAlias(KEY_ALIAS)) {
            java.security.Key k = ks.getKey(KEY_ALIAS, null);
            if (k instanceof SecretKey) return (SecretKey) k;
        }
        KeyGenerator kg = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, ANDROID_KEYSTORE);
        KeyGenParameterSpec spec = new KeyGenParameterSpec.Builder(KEY_ALIAS,
                KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(256)
                .setRandomizedEncryptionRequired(true)
                .build();
        kg.init(spec);
        return kg.generateKey();
    }

    static JSONObject set(Context ctx, String key, String value) {
        JSONObject r = new JSONObject();
        try {
            if (key == null || key.length() == 0) {
                r.put("ok", false);
                return r;
            }
            byte[] plain = (value == null ? "" : value).getBytes(StandardCharsets.UTF_8);
            Cipher cipher = Cipher.getInstance(TRANSFORMATION);
            cipher.init(Cipher.ENCRYPT_MODE, getOrCreateKey());
            byte[] iv = cipher.getIV();
            byte[] ct = cipher.doFinal(plain);
            byte[] packed = new byte[1 + iv.length + ct.length];
            packed[0] = (byte) iv.length;
            System.arraycopy(iv, 0, packed, 1, iv.length);
            System.arraycopy(ct, 0, packed, 1 + iv.length, ct.length);
            String encoded = Base64.encodeToString(packed, Base64.NO_WRAP);
            prefs(ctx).edit().putString(key, encoded).apply();
            r.put("ok", true);
        } catch (Exception e) {
            Log.w(TAG, "secure.set failed", e);
            try {
                r.put("ok", false);
                r.put("message", String.valueOf(e.getMessage()));
            } catch (Exception ignore) { }
        }
        return r;
    }

    static String get(Context ctx, String key) {
        try {
            String encoded = prefs(ctx).getString(key, null);
            if (encoded == null || encoded.length() == 0) return "";
            byte[] packed = Base64.decode(encoded, Base64.NO_WRAP);
            if (packed.length < 2) return "";
            int ivLen = packed[0] & 0xFF;
            if (ivLen <= 0 || packed.length <= 1 + ivLen) return "";
            byte[] iv = new byte[ivLen];
            byte[] ct = new byte[packed.length - 1 - ivLen];
            System.arraycopy(packed, 1, iv, 0, ivLen);
            System.arraycopy(packed, 1 + ivLen, ct, 0, ct.length);
            Cipher cipher = Cipher.getInstance(TRANSFORMATION);
            cipher.init(Cipher.DECRYPT_MODE, getOrCreateKey(), new GCMParameterSpec(GCM_TAG_BITS, iv));
            byte[] plain = cipher.doFinal(ct);
            return new String(plain, StandardCharsets.UTF_8);
        } catch (Exception e) {
            Log.w(TAG, "secure.get failed (密钥可能已失效)", e);
            // 密文无法解密时清掉，避免反复失败
            try { prefs(ctx).edit().remove(key).apply(); } catch (Exception ignore) { }
            return "";
        }
    }

    static JSONObject del(Context ctx, String key) {
        JSONObject r = new JSONObject();
        try {
            prefs(ctx).edit().remove(key).apply();
            r.put("ok", true);
        } catch (Exception e) {
            try { r.put("ok", false); } catch (Exception ignore) { }
        }
        return r;
    }
}
