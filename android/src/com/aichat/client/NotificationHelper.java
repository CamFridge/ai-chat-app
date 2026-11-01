package com.aichat.client;

import android.app.AlarmManager;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.os.Build;

/**
 * 角色主动消息的本地通知（v1.2.0）。
 * 设计：不上后台服务，App 切后台时由 JS 调用 notify.schedule 用 AlarmManager 排期；
 * 到点由 ProactiveReceiver 发一条普通本地通知；点开回到 App。
 * 不申请精确闹钟权限（SCHEDULE_EXACT_ALARM），统一用 setAndAllowWhileIdle。
 */
public final class NotificationHelper {

    public static final String CHANNEL_ID = "aichat_proactive";
    public static final String EXTRA_TITLE = "title";
    public static final String EXTRA_BODY = "body";
    public static final int NOTIFY_ID = 42001;

    private NotificationHelper() {}

    public static void ensureChannel(Context ctx) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
        try {
            NotificationManager nm = (NotificationManager) ctx.getSystemService(Context.NOTIFICATION_SERVICE);
            if (nm == null || nm.getNotificationChannel(CHANNEL_ID) != null) return;
            NotificationChannel ch = new NotificationChannel(CHANNEL_ID, "角色主动消息", NotificationManager.IMPORTANCE_DEFAULT);
            ch.setDescription("角色在空闲时主动发来消息的提醒");
            ch.setShowBadge(true);
            nm.createNotificationChannel(ch);
        } catch (Throwable t) {
            // 忽略：渠道创建失败不影响主流程
        }
    }

    public static void schedule(Context ctx, long delayMs, String title, String body) {
        try {
            ensureChannel(ctx);
            AlarmManager am = (AlarmManager) ctx.getSystemService(Context.ALARM_SERVICE);
            if (am == null) return;
            Intent intent = new Intent(ctx, ProactiveReceiver.class);
            intent.putExtra(EXTRA_TITLE, title == null ? "AI 聊天" : title);
            intent.putExtra(EXTRA_BODY, body == null ? "" : body);
            PendingIntent pi = PendingIntent.getBroadcast(
                    ctx, NOTIFY_ID, intent,
                    PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
            long at = System.currentTimeMillis() + Math.max(1000L, delayMs);
            am.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, at, pi);
        } catch (Throwable t) {
            // 忽略：排期失败（如厂商限制）只影响后台提醒
        }
    }

    public static void cancel(Context ctx) {
        try {
            AlarmManager am = (AlarmManager) ctx.getSystemService(Context.ALARM_SERVICE);
            if (am != null) {
                Intent intent = new Intent(ctx, ProactiveReceiver.class);
                PendingIntent pi = PendingIntent.getBroadcast(
                        ctx, NOTIFY_ID, intent,
                        PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
                am.cancel(pi);
            }
            NotificationManager nm = (NotificationManager) ctx.getSystemService(Context.NOTIFICATION_SERVICE);
            if (nm != null) nm.cancel(NOTIFY_ID);
        } catch (Throwable t) {
            // 忽略
        }
    }

    /** granted | denied | unsupported */
    public static String permission(Context ctx) {
        if (Build.VERSION.SDK_INT < 33) return "granted";
        try {
            int r = ctx.checkSelfPermission("android.permission.POST_NOTIFICATIONS");
            return r == PackageManager.PERMISSION_GRANTED ? "granted" : "denied";
        } catch (Throwable t) {
            return "unknown";
        }
    }

    public static void show(Context ctx, String title, String body) {
        try {
            ensureChannel(ctx);
            NotificationManager nm = (NotificationManager) ctx.getSystemService(Context.NOTIFICATION_SERVICE);
            if (nm == null) return;
            Intent open = new Intent(ctx, MainActivity.class);
            open.setFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP);
            PendingIntent contentIntent = PendingIntent.getActivity(
                    ctx, NOTIFY_ID, open,
                    PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);

            Notification.Builder b;
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                b = new Notification.Builder(ctx, CHANNEL_ID);
            } else {
                b = new Notification.Builder(ctx);
            }
            b.setSmallIcon(android.R.drawable.ic_dialog_info)
                    .setContentTitle(title == null || title.length() == 0 ? "AI 聊天" : title)
                    .setContentText(body == null ? "" : body)
                    .setStyle(new Notification.BigTextStyle().bigText(body == null ? "" : body))
                    .setAutoCancel(true)
                    .setContentIntent(contentIntent);
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP) {
                b.setCategory(Notification.CATEGORY_MESSAGE);
            }
            nm.notify(NOTIFY_ID, b.build());
        } catch (Throwable t) {
            // 忽略
        }
    }
}
