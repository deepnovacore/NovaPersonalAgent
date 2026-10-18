package com.nova.nova_audio

import android.content.Context
import android.graphics.Color
import android.graphics.PixelFormat
import android.graphics.drawable.GradientDrawable
import android.os.Build
import android.provider.Settings
import android.view.*
import android.widget.Button
import android.widget.LinearLayout
import kotlin.math.abs

/** Small touch target: it never intercepts touches outside its own bounds. */
internal class VoiceCallOverlay(
    private val context: Context,
    private val action: (String) -> Unit,
    private val open: () -> Unit,
) {
    private val windows = context.getSystemService(WindowManager::class.java)
    private val density = context.resources.displayMetrics.density
    private fun dp(n: Int) = (n * density).toInt()
    private var view: LinearLayout? = null
    private var muteButton: Button? = null
    private var orb: Button? = null
    private var muted = false
    private var expanded = false
    private val zh get() = context.resources.configuration.locales[0].language == "zh"
    private val params = WindowManager.LayoutParams(
        WindowManager.LayoutParams.WRAP_CONTENT, WindowManager.LayoutParams.WRAP_CONTENT,
        if (Build.VERSION.SDK_INT >= 26) WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY else WindowManager.LayoutParams.TYPE_PHONE,
        WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE, PixelFormat.TRANSLUCENT,
    ).apply { gravity = Gravity.TOP or Gravity.LEFT; y = dp(180) }
    fun show(): Boolean {
        if (view != null) return true
        if (!Settings.canDrawOverlays(context)) return false
        val box = LinearLayout(context).apply {
            orientation = LinearLayout.VERTICAL
            background = GradientDrawable().apply { setColor(Color.rgb(225, 244, 235)); cornerRadius = dp(26).toFloat() }
            elevation = dp(6).toFloat()
        }
        val button = Button(context).apply {
            text = "Nova"; setTextColor(Color.rgb(20, 45, 35)); minWidth = 0; minimumWidth = 0
            setPadding(0, 0, 0, 0)
            background = GradientDrawable().apply { setColor(Color.rgb(190, 232, 212)); cornerRadius = dp(28).toFloat() }
            setOnClickListener { expanded = !expanded; rebuildControls() }
        }
        box.addView(button, LinearLayout.LayoutParams(dp(56), dp(56)))
        orb = button; view = box
        var downX = 0f; var downY = 0f; var startX = 0; var startY = 0; var dragging = false
        button.setOnTouchListener { target, event ->
            when (event.actionMasked) {
                MotionEvent.ACTION_DOWN -> {
                    downX = event.rawX; downY = event.rawY; startX = params.x; startY = params.y; dragging = false; true
                }
                MotionEvent.ACTION_MOVE -> {
                    val dx = event.rawX - downX; val dy = event.rawY - downY
                    if (abs(dx) + abs(dy) > dp(8)) dragging = true
                    if (dragging) {
                        params.x = (startX + dx.toInt()).coerceIn(0, maxX())
                        params.y = (startY + dy.toInt()).coerceIn(0, maxY())
                        reposition()
                    }; true
                }
                MotionEvent.ACTION_UP -> {
                    if (dragging) { dock(); reposition() } else target.performClick()
                    true
                }
                MotionEvent.ACTION_CANCEL -> { dock(); reposition(); true }
                else -> false
            }
        }
        return try {
            dock(); windows.addView(box, params); update(muted); true
        } catch (_: RuntimeException) { view = null; orb = null; false }
    }
    private fun maxX() = (context.resources.displayMetrics.widthPixels - (view?.width?.takeIf { it > 0 } ?: dp(56))).coerceAtLeast(0)
    private fun maxY() = (context.resources.displayMetrics.heightPixels - (view?.height?.takeIf { it > 0 } ?: dp(56)) - dp(32)).coerceAtLeast(0)
    private fun dock() { params.x = if (params.x > maxX() / 2) maxX() else 0; params.y = params.y.coerceIn(0, maxY()) }
    private fun reposition() { view?.let { try { windows.updateViewLayout(it, params) } catch (_: RuntimeException) { hide() } } }
    private fun rebuildControls() {
        val box = view ?: return
        while (box.childCount > 1) box.removeViewAt(1)
        muteButton = null
        if (expanded) {
            fun control(label: String, clicked: () -> Unit) = Button(context).apply {
                text = label; setOnClickListener { clicked() }; box.addView(this)
            }
            control(if (zh) "返回 Nova" else "Return to Nova", open)
            muteButton = control("", { action("mute") })
            control(if (zh) "结束通话" else "End call", { action("end") })
        }
        update(muted)
        box.post { dock(); reposition() }
    }
    fun relayout() { view?.post { dock(); reposition() } }
    fun update(value: Boolean) {
        muted = value
        orb?.text = if (muted) "Nova\nⅡ" else "Nova"
        orb?.contentDescription = if (zh) "Nova 通话，${if (muted) "已静音" else "麦克风开启"}，点按展开" else "Nova call, ${if (muted) "muted" else "microphone active"}, tap for controls"
        muteButton?.text = if (muted) { if (zh) "取消静音" else "Unmute" } else { if (zh) "静音" else "Mute" }
    }
    fun hide() {
        view?.let { try { windows.removeView(it) } catch (_: RuntimeException) {} }
        view = null; orb = null; muteButton = null; expanded = false
    }
}
