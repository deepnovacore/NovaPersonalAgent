package com.nova.nova_audio

import android.app.Activity
import android.app.Application
import android.content.Context
import android.content.Intent
import android.os.Bundle
import android.os.Handler
import android.os.Looper

/** One window shared by the microphone service and the independent phone-task service. */
internal object VoicePetHost : Application.ActivityLifecycleCallbacks {
    val state = VoicePetState()
    private var overlay: VoiceCallOverlay? = null
    private val started = mutableSetOf<Activity>()
    private val main = Handler(Looper.getMainLooper())
    var callAction: ((String) -> Unit)? = null
    var taskAction: ((String) -> Unit)? = null
    var taskGone: ((String, String) -> Unit)? = null
    var previewWanted: ((String, Boolean) -> Unit)? = null
    private var muted = false
    private val background = Runnable { state.appVisible = started.isNotEmpty(); renderAndCheck() }

    fun initialize(context: Context) {
        if (overlay != null) return
        val app = context.applicationContext as Application
        app.registerActivityLifecycleCallbacks(this)
        overlay = VoiceCallOverlay(app, { value ->
            if (value.startsWith("task_")) taskAction?.invoke(value) else callAction?.invoke(value)
        }, {
            if (state.task != null) taskAction?.invoke("open") else callAction?.invoke("open")
            app.packageManager.getLaunchIntentForPackage(app.packageName)?.let {
                app.startActivity(it.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP))
            }
        }, ::reportPreview, { dismiss(if (android.provider.Settings.canDrawOverlays(app)) "overlay_blocked" else "overlay_permission") })
    }
    // Plugin attachment can happen after onStart; seed instead of waiting for the next lifecycle event.
    fun attach(activity: Activity) { onActivityStarted(activity) }
    fun call(active: Boolean, value: Boolean = muted) {
        state.callActive = active; muted = value; renderAndCheck()
    }
    fun task(value: VoicePetTask?): Boolean {
        val previous = state.task
        state.task = value
        if (previous?.id != value?.id || value?.status != "running") overlay?.clearFrame()
        val shown = render()
        if (value?.terminal == true) main.postDelayed({
            if (state.task === value) dismiss("expired")
        }, 3000)
        return shown
    }
    fun dismiss(reason: String) {
        val id = state.task?.id ?: return
        taskGone?.invoke(id, reason)
    }
    fun avatar(bytes: ByteArray?, path: String?) { overlay?.setAvatar(bytes, path) }
    fun frame(bytes: ByteArray) {
        if (state.acceptsFrame(overlay?.isExpanded == true)) overlay?.frame(bytes)
    }
    fun probe(): Boolean {
        val shown = overlay?.show() == true
        render()
        return shown
    }
    private fun reportPreview() {
        state.task?.let { previewWanted?.invoke(it.id, state.acceptsFrame(overlay?.isExpanded == true)) }
    }
    private fun render(): Boolean {
        overlay?.setMode(state.callActive, state.task, muted)
        val shown = if (state.visible) overlay?.show() == true else { overlay?.hide(); true }
        reportPreview()
        return shown
    }
    private fun renderAndCheck() {
        if (!render()) dismiss(if (overlayPermission()) "overlay_blocked" else "overlay_permission")
    }
    private fun overlayPermission() = VoicePetService.current?.let(android.provider.Settings::canDrawOverlays) == true
    fun relayout() { overlay?.relayout() }
    override fun onActivityStarted(activity: Activity) {
        main.removeCallbacks(background)
        started.add(activity); state.appVisible = true; renderAndCheck()
    }
    override fun onActivityStopped(activity: Activity) {
        started.remove(activity)
        main.removeCallbacks(background)
        main.postDelayed(background, 150) // Avoid flashes between activities/configuration instances.
    }
    override fun onActivityDestroyed(activity: Activity) { if (started.contains(activity)) onActivityStopped(activity) }
    override fun onActivityCreated(activity: Activity, state: Bundle?) {}
    override fun onActivityResumed(activity: Activity) {}
    override fun onActivityPaused(activity: Activity) {}
    override fun onActivitySaveInstanceState(activity: Activity, state: Bundle) {}
}
