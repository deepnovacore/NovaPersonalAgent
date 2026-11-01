package com.nova.nova_mobile.phone.setup

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import com.nova.nova_mobile.MainActivity

/** Keeps an explicitly user-started pairing window alive while Settings is in front. */
class PairingService : Service() {
    private val handler = Handler(Looper.getMainLooper())
    private val timeout = Runnable { stopSelf() }
    override fun onBind(intent: Intent?): IBinder? = null
    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        val nm = getSystemService(NotificationManager::class.java)
        nm.createNotificationChannel(NotificationChannel(CHANNEL, "Phone connection", NotificationManager.IMPORTANCE_LOW))
        val open = PendingIntent.getActivity(this, 0, Intent(this, MainActivity::class.java), PendingIntent.FLAG_IMMUTABLE)
        val notification = Notification.Builder(this, CHANNEL).setSmallIcon(android.R.drawable.stat_sys_data_bluetooth)
            .setContentTitle("Nova phone pairing").setContentText("Waiting for wireless debugging pairing. Return to Nova to cancel.")
            .setContentIntent(open).setOngoing(true).build()
        if (Build.VERSION.SDK_INT >= 34) startForeground(ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE)
        else startForeground(ID, notification)
        handler.removeCallbacks(timeout)
        handler.postDelayed(timeout, 10 * 60_000L)
        return START_NOT_STICKY
    }
    override fun onDestroy() { handler.removeCallbacksAndMessages(null); super.onDestroy() }
    companion object {
        private const val CHANNEL = "phone_connection"
        private const val ID = 4402
        fun start(context: Context) { context.startForegroundService(Intent(context, PairingService::class.java)) }
        fun stop(context: Context) { context.stopService(Intent(context, PairingService::class.java)) }
    }
}
