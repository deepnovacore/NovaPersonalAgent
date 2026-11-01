package com.nova.nova_audio

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Intent
import android.content.pm.ServiceInfo
import android.content.res.Configuration
import android.os.Build
import android.os.IBinder

/** Independent task keepalive: no microphone permission/type or call wake lock. */
class VoicePetService : Service() {
    companion object {
        internal val ownership = VoiceCallOwnership()
        internal var current: VoicePetService? = null
        internal var onReady: ((Boolean) -> Unit)? = null
        internal const val STOP = "nova.task.STOP"
        private const val CHANNEL = "nova_phone_task"
        private const val NOTIFICATION = 19745
    }
    private var owner: String? = null
    override fun onBind(intent: Intent?): IBinder? = null
    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        // Even a cancelled/stale start must satisfy the startForegroundService contract.
        try {
            val notification = notification()
            if (Build.VERSION.SDK_INT >= 34) startForeground(NOTIFICATION, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE)
            else startForeground(NOTIFICATION, notification)
        } catch (_: RuntimeException) {
            onReady?.invoke(false); VoicePetHost.dismiss("foreground_blocked"); finish()
            return START_NOT_STICKY
        }
        val id = intent?.getStringExtra("owner")
        if (intent?.action == STOP) {
            if (ownership.owns(id) && VoicePetHost.state.task?.id == intent.getStringExtra("taskId")) {
                VoicePetHost.taskAction?.invoke("task_stop")
                VoicePetHost.dismiss("notification_stop")
                finish()
            } else if (current !== this) finish()
            return START_NOT_STICKY
        }
        if (!ownership.owns(id) || onReady == null) {
            if (current !== this) finish()
            return START_NOT_STICKY
        }
        owner = id
        current = this
        onReady?.invoke(true)
        return START_NOT_STICKY
    }
    private fun notification(): Notification {
        val zh = resources.configuration.locales[0].language == "zh"
        val manager = getSystemService(NotificationManager::class.java)
        if (Build.VERSION.SDK_INT >= 26) manager.createNotificationChannel(
            NotificationChannel(CHANNEL, "Nova tasks", NotificationManager.IMPORTANCE_LOW))
        val builder = if (Build.VERSION.SDK_INT >= 26) Notification.Builder(this, CHANNEL) else Notification.Builder(this)
        val open = packageManager.getLaunchIntentForPackage(packageName)?.let {
            PendingIntent.getActivity(this, NOTIFICATION, it, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
        }
        builder.setSmallIcon(android.R.drawable.ic_menu_view)
            .setContentTitle(if (zh) "Nova 手机任务" else "Nova phone task")
            .setContentText(if (zh) "点按打开 Nova" else "Tap to open Nova")
            .setContentIntent(open).setOngoing(true).setOnlyAlertOnce(true)
            .setVisibility(Notification.VISIBILITY_PRIVATE)
        VoicePetHost.state.task?.let { task ->
            val stop = PendingIntent.getService(this, NOTIFICATION, Intent(this, VoicePetService::class.java)
                .setAction(STOP).setData(android.net.Uri.parse("nova-task:${android.net.Uri.encode(task.id)}"))
                .putExtra("owner", owner).putExtra("taskId", task.id),
                PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
            builder.addAction(Notification.Action.Builder(null, if (zh) "停止" else "Stop", stop).build())
        }
        return builder.build()
    }
    internal fun refreshNotification() {
        getSystemService(NotificationManager::class.java).notify(NOTIFICATION, notification())
    }
    fun finish() {
        if (current === this) current = null
        stopForeground(STOP_FOREGROUND_REMOVE); stopSelf()
    }
    override fun onConfigurationChanged(newConfig: Configuration) {
        super.onConfigurationChanged(newConfig)
        VoicePetHost.relayout()
    }
    override fun onTaskRemoved(rootIntent: Intent?) { VoicePetHost.dismiss("task_removed"); finish() }
    override fun onDestroy() {
        if (current === this) {
            current = null
            if (ownership.owns(owner)) VoicePetHost.dismiss("service_destroyed")
        }
        super.onDestroy()
    }
}
