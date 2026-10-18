package com.nova.nova_audio

import android.content.Context
import android.content.res.ColorStateList
import android.graphics.Color
import android.graphics.Typeface
import android.graphics.drawable.RippleDrawable
import android.graphics.PixelFormat
import android.graphics.drawable.GradientDrawable
import android.os.Build
import android.provider.Settings
import android.view.*
import android.widget.Button
import android.widget.LinearLayout
import kotlin.math.abs
import kotlin.math.ceil

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
    private var dockedRight = false
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
            background = GradientDrawable().apply { setColor(Color.WHITE); setStroke(dp(1), Color.rgb(226, 233, 229)); cornerRadius = dp(22).toFloat() }
            elevation = dp(6).toFloat()
        }
        val button = Button(context).apply {
            text = "Nova"; isAllCaps = false; setTextColor(Color.rgb(20, 45, 35)); minWidth = 0; minimumWidth = 0
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
            params.width = dp(56)
            alignDock(); windows.addView(box, params); update(muted); true
        } catch (_: RuntimeException) { view = null; orb = null; false }
    }
    private fun maxX() = (context.resources.displayMetrics.widthPixels - (params.width.takeIf { it > 0 } ?: view?.measuredWidth?.takeIf { it > 0 } ?: dp(56))).coerceAtLeast(0)
    private fun maxY() = (context.resources.displayMetrics.heightPixels - (view?.measuredHeight?.takeIf { it > 0 } ?: dp(56)) - dp(32)).coerceAtLeast(0)
    private fun dock() { dockedRight = params.x > maxX() / 2; alignDock() }
    private fun alignDock() { params.x = if (dockedRight) maxX() else 0; params.y = params.y.coerceIn(0, maxY()) }
    private fun reposition() { view?.let { try { windows.updateViewLayout(it, params) } catch (_: RuntimeException) { hide() } } }
    private fun rebuildControls() {
        val box = view ?: return
        while (box.childCount > 1) box.removeViewAt(1)
        muteButton = null
        if (expanded) {
            fun control(label: String, clicked: () -> Unit) = Button(context).apply {
                text = label; contentDescription = label; isAllCaps = false
                setTextColor(if (label == "结束通话" || label == "End call") Color.rgb(174, 65, 65) else Color.rgb(29, 45, 39))
                textSize = 14f; typeface = Typeface.create("sans-serif-medium", Typeface.NORMAL)
                gravity = Gravity.START or Gravity.CENTER_VERTICAL
                stateListAnimator = null; elevation = 0f
                background = RippleDrawable(ColorStateList.valueOf(Color.rgb(225, 244, 235)), null,
                    GradientDrawable().apply { setColor(Color.WHITE); cornerRadius = dp(12).toFloat() })
                setSingleLine(false)
                minHeight = dp(48); minimumHeight = dp(48)
                setPadding(dp(18), dp(8), dp(18), dp(8))
                setOnClickListener { clicked() }
                box.addView(this, LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT))
            }
            control(if (zh) "返回 Nova" else "Return to Nova", open)
            muteButton = control("", { action("mute") })
            control(if (zh) "结束通话" else "End call", { action("end") })
        }
        update(muted)
    }
    fun relayout() {
        val box = view ?: return
        box.post {
            if (view !== box) return@post
            val button = orb ?: return@post
            // Keep both muted-state lines readable at the user's font scale.
            val orbSize = maxOf(dp(56), ceil(button.paint.measureText("Nova")).toInt() + dp(12), ceil(button.paint.fontSpacing * 2).toInt() + dp(8))
            button.layoutParams = LinearLayout.LayoutParams(orbSize, orbSize)
            val labelWidth = (1 until box.childCount).maxOfOrNull { index ->
                val control = box.getChildAt(index) as Button
                ceil(control.paint.measureText(control.text.toString())).toInt() + control.paddingLeft + control.paddingRight
            } ?: 0
            // MATCH_PARENT controls cannot establish a WRAP_CONTENT window's
            // intrinsic width after it was first measured as the small orb.
            params.width = (if (expanded) maxOf(dp(180), orbSize, labelWidth) else orbSize)
                .coerceAtMost(context.resources.displayMetrics.widthPixels)
            box.measure(View.MeasureSpec.makeMeasureSpec(params.width, View.MeasureSpec.EXACTLY), View.MeasureSpec.makeMeasureSpec(0, View.MeasureSpec.UNSPECIFIED))
            alignDock(); reposition()
        }
    }
    fun update(value: Boolean) {
        muted = value
        orb?.text = if (muted) "Nova\nⅡ" else "Nova"
        orb?.contentDescription = if (zh) "Nova 通话，${if (muted) "已静音" else "麦克风开启"}，${if (expanded) "点按收起" else "点按展开"}" else "Nova call, ${if (muted) "muted" else "microphone active"}, ${if (expanded) "tap to collapse controls" else "tap for controls"}"
        muteButton?.apply {
            text = if (muted) { if (zh) "取消静音" else "Unmute" } else { if (zh) "静音" else "Mute" }
            contentDescription = text
        }
        relayout()
    }
    fun hide() {
        view?.let { try { windows.removeView(it) } catch (_: RuntimeException) {} }
        view = null; orb = null; muteButton = null; expanded = false
    }
}
