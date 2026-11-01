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
    private val resumed = mutableSetOf<Activity>()
    private val main = Handler(Looper.getMainLooper())
    var callAction: ((String) -> Unit)? = null
    var taskAction: ((String) -> Unit)? = null
    private var muted = false

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
        })
    }
    fun call(active: Boolean, value: Boolean = muted) {
        state.callActive = active; muted = value; render()
    }
    fun task(value: VoicePetTask?) {
        val previous = state.task
        state.task = value
        if (previous?.id != value?.id || value?.terminal == true || value?.status == "needs_user") overlay?.clearFrame()
        render()
        if (value?.terminal == true) main.postDelayed({
            if (state.expire(value)) { render(); VoicePetService.current?.finish() }
        }, 3000)
    }
    fun avatar(bytes: ByteArray?, path: String?) { overlay?.setAvatar(bytes, path) }
    fun frame(bytes: ByteArray) {
        if (state.acceptsFrame(overlay?.isExpanded == true)) overlay?.frame(bytes)
    }
    private fun render() {
        overlay?.setMode(state.callActive, state.task, muted)
        if (state.visible) overlay?.show() else overlay?.hide()
    }
    fun relayout() { overlay?.relayout() }
    override fun onActivityResumed(activity: Activity) { resumed.add(activity); state.resumed = true; render() }
    override fun onActivityPaused(activity: Activity) { resumed.remove(activity); state.resumed = resumed.isNotEmpty(); render() }
    override fun onActivityDestroyed(activity: Activity) { resumed.remove(activity); state.resumed = resumed.isNotEmpty(); render() }
    override fun onActivityCreated(activity: Activity, state: Bundle?) {}
    override fun onActivityStarted(activity: Activity) {}
    override fun onActivityStopped(activity: Activity) {}
    override fun onActivitySaveInstanceState(activity: Activity, state: Bundle) {}
}
