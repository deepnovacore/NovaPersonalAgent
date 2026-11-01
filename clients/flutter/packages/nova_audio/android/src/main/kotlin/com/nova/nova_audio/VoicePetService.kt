package com.nova.nova_audio

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder

/** Task-only keepalive: specialUse never acquires microphone permission or a call wake lock.
 * Kept separate from VoiceCallService so ending either lifetime cannot stop the other.
 * The overlay itself is shared by VoicePetHost. Never restores a task after process death.
 */
class VoicePetService : Service() {
    companion object {
        internal val ownership = VoiceCallOwnership()
        internal var current: VoicePetService? = null
        internal var onReady: ((Boolean) -> Unit)? = null
        private const val CHANNEL = "nova_phone_task"
        private const val NOTIFICATION = 19745
    }
    private var owner: String? = null
    override fun onBind(intent: Intent?): IBinder? = null
    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        val id = intent?.getStringExtra("owner")
        if (!ownership.owns(id) || onReady == null) {
            if (current !== this) stopSelf()
            return START_NOT_STICKY
        }
        owner = id
        val zh = resources.configuration.locales[0].language == "zh"
        val manager = getSystemService(NotificationManager::class.java)
        if (Build.VERSION.SDK_INT >= 26) manager.createNotificationChannel(
            NotificationChannel(CHANNEL, "Nova tasks", NotificationManager.IMPORTANCE_LOW))
        val builder = if (Build.VERSION.SDK_INT >= 26) Notification.Builder(this, CHANNEL) else Notification.Builder(this)
        val open = packageManager.getLaunchIntentForPackage(packageName)?.let {
            PendingIntent.getActivity(this, NOTIFICATION, it, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
        }
        val notification = builder.setSmallIcon(android.R.drawable.ic_menu_view)
            .setContentTitle(if (zh) "Nova 手机任务" else "Nova phone task")
            .setContentText(if (zh) "点按打开 Nova" else "Tap to open Nova")
            .setContentIntent(open).setOngoing(true).setOnlyAlertOnce(true)
            .setVisibility(Notification.VISIBILITY_PRIVATE).build()
        try {
            if (Build.VERSION.SDK_INT >= 34) startForeground(NOTIFICATION, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE)
            else startForeground(NOTIFICATION, notification)
            current = this
            onReady?.invoke(true)
        } catch (_: RuntimeException) { onReady?.invoke(false); finish() }
        return START_NOT_STICKY
    }
    fun finish() {
        if (current === this) current = null
        stopForeground(STOP_FOREGROUND_REMOVE); stopSelf()
    }
    override fun onDestroy() {
        if (current === this) {
            current = null
            if (ownership.owns(owner)) VoicePetHost.task(null)
        }
        super.onDestroy()
    }
}
