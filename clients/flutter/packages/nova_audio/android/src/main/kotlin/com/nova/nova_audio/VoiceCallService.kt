package com.nova.nova_audio

import android.app.*
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder

/** Lifetime is explicitly acquired in the foreground; never resurrect a call. */
class VoiceCallService : Service() {
    companion object {
        var current: VoiceCallService? = null
            private set
        internal val ownership = VoiceCallOwnership()
        var onReady: (() -> Unit)? = null
        var onAction: ((String) -> Unit)? = null
        const val START = "nova.voice.START"
        const val END = "nova.voice.END"
        const val MUTE = "nova.voice.MUTE"
        private const val CHANNEL = "nova_voice_call"
        private const val NOTIFICATION = 19744
    }
    private var wakeLock: android.os.PowerManager.WakeLock? = null
    private var muted = false
    private var finished = false
    private var destroyed = false
    private var callId: String? = null
    private val stopped = mutableListOf<() -> Unit>()
    private var foreground = false
    private var overlay: VoiceCallOverlay? = null
    override fun onBind(intent: Intent?): IBinder? = null
    override fun onCreate() {
        super.onCreate()
        current = this
        if (Build.VERSION.SDK_INT >= 26) {
            getSystemService(NotificationManager::class.java).createNotificationChannel(
                NotificationChannel(CHANNEL, "Nova calls", NotificationManager.IMPORTANCE_LOW))
        }
        overlay = VoiceCallOverlay(this, ::action, ::openApp)
    }
    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        val requestedId = intent?.getStringExtra("call_id")
        if (!ownership.owns(requestedId)) {
            if (!foreground) finish()
            return START_NOT_STICKY
        }
        when (intent?.action) {
            START -> {
                if (finished) { onAction?.invoke("end"); return START_NOT_STICKY }
                if (foreground && callId == requestedId) { onReady?.invoke(); return START_NOT_STICKY }
                // A missing in-process owner means the engine/call no longer exists.
                if (onReady == null || onAction == null) { finish(); return START_NOT_STICKY }
                callId = requestedId
                try {
                    if (Build.VERSION.SDK_INT >= 30) {
                        startForeground(NOTIFICATION, notification(), ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE)
                    } else startForeground(NOTIFICATION, notification())
                    foreground = true
                    wakeLock = getSystemService(android.os.PowerManager::class.java)
                        .newWakeLock(android.os.PowerManager.PARTIAL_WAKE_LOCK, "nova:voice-call").apply {
                            setReferenceCounted(false); acquire()
                        }
                    onReady?.invoke()
                } catch (_: RuntimeException) { action("end") }
            }
            END -> action("end")
            MUTE -> if (foreground) action("mute") else finish()
            else -> finish()
        }
        return START_NOT_STICKY
    }
    private fun action(value: String) {
        if (ownership.owns(callId)) onAction?.invoke(value)
        if (value == "end") finish()
    }
    fun update(value: Boolean) {
        muted = value
        if (foreground && !finished) getSystemService(NotificationManager::class.java).notify(NOTIFICATION, notification())
        overlay?.update(value)
    }
    fun showOrb() = overlay?.show() ?: false
    fun hideOrb() { overlay?.hide() }
    private fun openIntent(): Intent? = packageManager.getLaunchIntentForPackage(packageName)?.apply {
        addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP)
    }
    private fun openApp() { openIntent()?.let { startActivity(it) }; hideOrb() }
    private fun notification(): Notification {
        val open = openIntent()?.let { PendingIntent.getActivity(this, 1, it, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE) }
        fun command(action: String, id: Int) = PendingIntent.getService(this, (callId?.hashCode() ?: 0) + id,
            Intent(this, VoiceCallService::class.java).setAction(action).putExtra("call_id", callId), PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
        val builder = if (Build.VERSION.SDK_INT >= 26) Notification.Builder(this, CHANNEL) else Notification.Builder(this)
        val zh = resources.configuration.locales[0].language == "zh"
        return builder.setSmallIcon(android.R.drawable.ic_btn_speak_now)
            .setContentTitle(if (zh) "Nova 实时通话" else "Nova call")
            .setContentText(if (muted) { if (zh) "麦克风已静音" else "Microphone muted" } else { if (zh) "正在使用麦克风" else "Microphone active" })
            .setCategory(Notification.CATEGORY_CALL).setOngoing(true).setOnlyAlertOnce(true)
            .setVisibility(Notification.VISIBILITY_PUBLIC).setContentIntent(open)
            .addAction(Notification.Action.Builder(null, if (muted) { if (zh) "取消静音" else "Unmute" } else { if (zh) "静音" else "Mute" }, command(MUTE, 2)).build())
            .addAction(Notification.Action.Builder(null, if (zh) "结束通话" else "End call", command(END, 3)).build())
            .build()
    }
    fun finish(onStopped: (() -> Unit)? = null) {
        if (destroyed) { onStopped?.invoke(); return }
        onStopped?.let { stopped.add(it) }
        if (finished) return
        finished = true
        hideOrb()
        wakeLock?.let { if (it.isHeld) it.release() }; wakeLock = null
        stopForeground(STOP_FOREGROUND_REMOVE)
        stopSelf()
    }
    override fun onConfigurationChanged(newConfig: android.content.res.Configuration) {
        super.onConfigurationChanged(newConfig)
        overlay?.relayout()
    }
    override fun onTaskRemoved(rootIntent: Intent?) { action("end") }
    override fun onDestroy() {
        hideOrb()
        wakeLock?.let { if (it.isHeld) it.release() }; wakeLock = null
        destroyed = true
        if (!finished && ownership.owns(callId)) onAction?.invoke("end")
        if (current === this) current = null
        stopped.toList().forEach { it() }; stopped.clear()
        super.onDestroy()
    }
}
