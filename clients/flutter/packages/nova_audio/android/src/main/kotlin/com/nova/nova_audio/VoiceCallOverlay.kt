package com.nova.nova_audio

import android.content.Context
import android.content.res.ColorStateList
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.ColorFilter
import android.graphics.Paint
import android.graphics.Path
import android.graphics.PixelFormat
import android.graphics.RectF
import android.graphics.drawable.Drawable
import android.graphics.drawable.GradientDrawable
import android.graphics.drawable.RippleDrawable
import android.os.Build
import android.provider.Settings
import android.view.*
import android.widget.FrameLayout
import android.widget.ImageButton
import android.widget.ImageView
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
    private var muteButton: ImageButton? = null
    private var orb: FrameLayout? = null
    private var orbRing: GradientDrawable? = null
    private var mutedBadge: View? = null
    private var muted = false
    private var expanded = false
    private var dockedRight = false
    private val zh get() = context.resources.configuration.locales[0].language == "zh"
    private val boxWidth get() = dp(ORB + 2 * PAD)
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
            gravity = Gravity.CENTER_HORIZONTAL
            setPadding(dp(PAD), dp(PAD), dp(PAD), dp(PAD))
        }
        val ring = GradientDrawable().apply { shape = GradientDrawable.OVAL; setColor(Color.WHITE) }
        val bubble = FrameLayout(context).apply {
            background = ring
            elevation = dp(6).toFloat()
            outlineProvider = ViewOutlineProvider.BACKGROUND
            isClickable = true
            setOnClickListener { expanded = !expanded; rebuildControls() }
        }
        bubble.addView(avatarView(), FrameLayout.LayoutParams(dp(ORB - 8), dp(ORB - 8), Gravity.CENTER))
        val badge = View(context).apply {
            background = GradientDrawable().apply { shape = GradientDrawable.OVAL; setColor(MUTED_RED); setStroke(dp(2), Color.WHITE) }
            foreground = IconDrawable(Icon.MIC_OFF, Color.WHITE, dp(2).toFloat() * 0.8f, inset = dp(3))
            visibility = View.GONE
        }
        bubble.addView(badge, FrameLayout.LayoutParams(dp(20), dp(20), Gravity.BOTTOM or Gravity.END))
        box.addView(bubble, LinearLayout.LayoutParams(dp(ORB), dp(ORB)))
        orb = bubble; orbRing = ring; mutedBadge = badge; view = box
        var downX = 0f; var downY = 0f; var startX = 0; var startY = 0; var dragging = false
        bubble.setOnTouchListener { target, event ->
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
            params.width = boxWidth
            alignDock(); windows.addView(box, params); update(muted); true
        } catch (_: RuntimeException) { view = null; orb = null; orbRing = null; mutedBadge = null; false }
    }

    private fun avatarView(): ImageView = ImageView(context).apply {
        background = GradientDrawable().apply { shape = GradientDrawable.OVAL; setColor(Color.rgb(190, 232, 212)) }
        outlineProvider = ViewOutlineProvider.BACKGROUND
        clipToOutline = true
        importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_NO
        scaleType = ImageView.ScaleType.CENTER_CROP
        setImageResource(R.drawable.nova_orb_avatar)
    }

    private fun maxX() = (context.resources.displayMetrics.widthPixels - (params.width.takeIf { it > 0 } ?: boxWidth)).coerceAtLeast(0)
    private fun maxY() = (context.resources.displayMetrics.heightPixels - (view?.measuredHeight?.takeIf { it > 0 } ?: dp(ORB)) - dp(32)).coerceAtLeast(0)
    private fun dock() { dockedRight = params.x > maxX() / 2; alignDock() }
    private fun alignDock() { params.x = if (dockedRight) maxX() else 0; params.y = params.y.coerceIn(0, maxY()) }
    private fun reposition() { view?.let { try { windows.updateViewLayout(it, params) } catch (_: RuntimeException) { hide() } } }

    private fun rebuildControls() {
        val box = view ?: return
        while (box.childCount > 1) box.removeViewAt(1)
        muteButton = null
        // Collapsed it is only the floating portrait; the capsule appears with the controls.
        box.background = if (expanded) GradientDrawable().apply { setColor(Color.WHITE); setStroke(dp(1), Color.rgb(226, 233, 229)); cornerRadius = dp((ORB + 2 * PAD) / 2).toFloat() } else null
        box.elevation = if (expanded) dp(6).toFloat() else 0f
        if (expanded) {
            fun control(icon: Icon, tint: Int, fill: Int?, label: String, clicked: () -> Unit) = ImageButton(context).apply {
                contentDescription = label; setImageDrawable(IconDrawable(icon, tint, dp(2).toFloat() * 0.85f, inset = dp(11)))
                scaleType = ImageView.ScaleType.FIT_CENTER; stateListAnimator = null; elevation = 0f
                // IconDrawable owns its inset; theme padding would shrink the glyph twice.
                setPadding(0, 0, 0, 0)
                background = RippleDrawable(ColorStateList.valueOf(Color.argb(40, 40, 80, 60)),
                    fill?.let { color -> GradientDrawable().apply { shape = GradientDrawable.OVAL; setColor(color) } },
                    GradientDrawable().apply { shape = GradientDrawable.OVAL; setColor(Color.WHITE) })
                setOnClickListener { clicked() }
                box.addView(this, LinearLayout.LayoutParams(dp(CONTROL), dp(CONTROL)).apply { topMargin = dp(4) })
            }
            control(Icon.BACK, INK, null, if (zh) "返回 Nova" else "Return to Nova", open)
            muteButton = control(Icon.MIC, INK, null, "") { action("mute") }
            control(Icon.END, Color.WHITE, END_RED, if (zh) "结束通话" else "End call") { action("end") }
        }
        update(muted)
    }

    fun relayout() {
        val box = view ?: return
        box.post {
            if (view !== box) return@post
            // Fixed-size icon controls: the window width no longer depends on label text or font scale.
            params.width = boxWidth.coerceAtMost(context.resources.displayMetrics.widthPixels)
            box.measure(View.MeasureSpec.makeMeasureSpec(params.width, View.MeasureSpec.EXACTLY), View.MeasureSpec.makeMeasureSpec(0, View.MeasureSpec.UNSPECIFIED))
            alignDock(); reposition()
        }
    }

    fun update(value: Boolean) {
        muted = value
        orbRing?.setStroke(dp(3), if (muted) MUTED_RING else LIVE_RING)
        mutedBadge?.visibility = if (muted) View.VISIBLE else View.GONE
        orb?.contentDescription = if (zh) "Nova 通话，${if (muted) "已静音" else "麦克风开启"}，${if (expanded) "点按收起" else "点按展开"}" else "Nova call, ${if (muted) "muted" else "microphone active"}, ${if (expanded) "tap to collapse controls" else "tap for controls"}"
        muteButton?.apply {
            val label = if (muted) { if (zh) "取消静音" else "Unmute" } else { if (zh) "静音" else "Mute" }
            contentDescription = label
            setImageDrawable(IconDrawable(if (muted) Icon.MIC_OFF else Icon.MIC, if (muted) MUTED_RED else INK, dp(2).toFloat() * 0.85f, inset = dp(11)))
        }
        relayout()
    }

    fun hide() {
        view?.let { try { windows.removeView(it) } catch (_: RuntimeException) {} }
        view = null; orb = null; orbRing = null; mutedBadge = null; muteButton = null; expanded = false
    }

    private enum class Icon { BACK, MIC, MIC_OFF, END }

    /** Stroked line glyphs on a 24-unit grid, so the overlay needs no bitmap or XML resources. */
    private class IconDrawable(private val icon: Icon, color: Int, private val strokePx: Float, private val inset: Int) : Drawable() {
        private val paint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
            this.color = color; style = Paint.Style.STROKE; strokeCap = Paint.Cap.ROUND; strokeJoin = Paint.Join.ROUND
        }
        override fun draw(canvas: Canvas) {
            val b = bounds
            val size = minOf(b.width(), b.height()) - 2 * inset
            if (size <= 0) return
            val s = size / 24f
            canvas.save()
            canvas.translate(b.exactCenterX() - size / 2f, b.exactCenterY() - size / 2f)
            canvas.scale(s, s)
            paint.strokeWidth = (strokePx / s).coerceAtLeast(1.6f)
            val p = Path()
            when (icon) {
                Icon.BACK -> { p.moveTo(19f, 12f); p.lineTo(5f, 12f); p.moveTo(11f, 6f); p.lineTo(5f, 12f); p.lineTo(11f, 18f) }
                Icon.MIC, Icon.MIC_OFF -> {
                    p.addRoundRect(RectF(9f, 3f, 15f, 14f), 3f, 3f, Path.Direction.CW)
                    p.moveTo(6f, 11f); p.arcTo(RectF(6f, 5f, 18f, 17f), 180f, -180f); p.moveTo(12f, 17f); p.lineTo(12f, 21f)
                    if (icon == Icon.MIC_OFF) { p.moveTo(4f, 4f); p.lineTo(20f, 20f) }
                }
                // A handset drawn as a flat arch with short ear tips, the usual hang-up glyph.
                Icon.END -> { p.moveTo(3f, 16f); p.quadTo(12f, 7f, 21f, 16f); p.moveTo(3f, 16f); p.lineTo(3f, 13.5f); p.moveTo(21f, 16f); p.lineTo(21f, 13.5f) }
            }
            canvas.drawPath(p, paint)
            canvas.restore()
        }
        override fun setAlpha(alpha: Int) { paint.alpha = alpha }
        override fun setColorFilter(colorFilter: ColorFilter?) { paint.colorFilter = colorFilter }
        @Deprecated("Deprecated in Java") override fun getOpacity() = PixelFormat.TRANSLUCENT
    }

    private companion object {
        const val ORB = 56
        const val PAD = 4
        const val CONTROL = 48
        val INK = Color.rgb(29, 45, 39)
        val LIVE_RING = Color.rgb(76, 175, 125)
        val MUTED_RING = Color.rgb(176, 181, 186)
        val MUTED_RED = Color.rgb(200, 84, 80)
        val END_RED = Color.rgb(214, 69, 65)
    }
}
