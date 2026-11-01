package com.aichat.client;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

/** 主动消息通知的 Alarm 接收器（v1.2.0）。 */
public class ProactiveReceiver extends BroadcastReceiver {
    @Override
    public void onReceive(Context context, Intent intent) {
        if (intent == null) return;
        String title = intent.getStringExtra(NotificationHelper.EXTRA_TITLE);
        String body = intent.getStringExtra(NotificationHelper.EXTRA_BODY);
        NotificationHelper.show(context, title, body);
    }
}
