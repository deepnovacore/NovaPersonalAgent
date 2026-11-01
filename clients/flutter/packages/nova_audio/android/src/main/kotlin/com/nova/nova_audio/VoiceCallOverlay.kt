package com.nova.nova_audio

import android.animation.ValueAnimator
import android.content.Context
import android.content.res.ColorStateList
import android.graphics.Bitmap
import android.graphics.BitmapFactory
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
import android.view.animation.AccelerateDecelerateInterpolator
import android.widget.Button
import android.widget.ScrollView
import android.widget.TextView
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
    private var pulse: ValueAnimator? = null
    private var muted = false
    private var callActive = false
    private var task: VoicePetTask? = null
    private var portrait: Bitmap? = null
    private var portraitView: ImageView? = null
    private var preview: ImageView? = null
    private var latestFrame: Bitmap? = null
    private var progress: View? = null
    val isExpanded get() = view != null && expanded
    private var expanded = false
    private var dockedRight = false
    private val zh get() = context.resources.configuration.locales[0].language == "zh"
    private val boxWidth get() = dp(ORB + 2 * PAD)
    private val params = WindowManager.LayoutParams(
        WindowManager.LayoutParams.WRAP_CONTENT, WindowManager.LayoutParams.WRAP_CONTENT,
        if (Build.VERSION.SDK_INT >= 26) WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY else WindowManager.LayoutParams.TYPE_PHONE,
        WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE or WindowManager.LayoutParams.FLAG_NOT_TOUCH_MODAL, PixelFormat.TRANSLUCENT,
    ).apply { gravity = Gravity.TOP or Gravity.LEFT; y = dp(180) }

    fun show(): Boolean {
        if (!Settings.canDrawOverlays(context)) { hide(); return false }
        if (view != null) return true
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
        val progressRing = object : View(context) {
            private val paint = Paint(Paint.ANTI_ALIAS_FLAG).apply { style = Paint.Style.STROKE; strokeWidth = dp(3).toFloat(); color = LIVE_RING; strokeCap = Paint.Cap.ROUND }
            override fun onDraw(canvas: Canvas) {
                if (task?.status == "running") {
                    val inset = dp(2).toFloat()
                    val angle = (android.os.SystemClock.uptimeMillis() % 1800) * 360f / 1800
                    canvas.drawArc(inset, inset, width - inset, height - inset, angle, 110f, false, paint)
                    postInvalidateDelayed(32)
                }
            }
        }
        bubble.addView(progressRing, FrameLayout.LayoutParams(-1, -1)); progress = progressRing
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
            alignDock(); windows.addView(box, params); rebuildControls(); true
        } catch (_: RuntimeException) { stopPulse(); view = null; orb = null; orbRing = null; mutedBadge = null; false }
    }

    private fun avatarView(): ImageView = ImageView(context).apply {
        background = GradientDrawable().apply { shape = GradientDrawable.OVAL; setColor(Color.rgb(190, 232, 212)) }
        outlineProvider = ViewOutlineProvider.BACKGROUND
        clipToOutline = true
        importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_NO
        scaleType = ImageView.ScaleType.CENTER_CROP
        if (portrait != null) setImageBitmap(portrait) else setImageResource(R.drawable.nova_orb_avatar)
        portraitView = this
    }

    private fun maxX() = (context.resources.displayMetrics.widthPixels - (params.width.takeIf { it > 0 } ?: boxWidth)).coerceAtLeast(0)
    private fun maxY() = (context.resources.displayMetrics.heightPixels - (view?.measuredHeight?.takeIf { it > 0 } ?: dp(ORB)) - dp(32)).coerceAtLeast(0)
    private fun dock() { dockedRight = VoicePetDock.edge(params.x, maxX()) > 0; alignDock() }
    private fun alignDock() { params.x = if (dockedRight) maxX() else 0; params.y = VoicePetDock.clamp(params.y, maxY()) }
    private fun reposition() { view?.let { try { windows.updateViewLayout(it, params) } catch (_: RuntimeException) { hide() } } }

    private fun rebuildControls() {
        val box = view ?: return
        while (box.childCount > 1) box.removeViewAt(1)
        muteButton = null
        preview = null
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
            task?.let { current ->
                preview = ImageView(context).apply {
                    scaleType = ImageView.ScaleType.FIT_CENTER
                    contentDescription = if (zh) "虚拟屏预览" else "Virtual screen preview"
                    setImageBitmap(latestFrame)
                    setBackgroundColor(Color.rgb(240, 244, 242))
                    box.addView(this, LinearLayout.LayoutParams(-1, dp(160)))
                }
                box.addView(TextView(context).apply {
                    text = listOfNotNull(current.step?.let { if (zh) "第 $it 步" else "Step $it" }, current.label).joinToString(" · ")
                    setTextColor(INK); textSize = 14f; maxLines = 3
                    setPadding(dp(8), dp(8), dp(8), dp(8))
                }, LinearLayout.LayoutParams(-1, -2))
                fun taskButton(label: String, value: String) {
                    box.addView(Button(context).apply {
                        text = label; contentDescription = label; minHeight = dp(48)
                        isEnabled = !current.terminal
                        setOnClickListener { action(value) }
                    }, LinearLayout.LayoutParams(-1, dp(48)))
                }
                taskButton(if (zh) "停止" else "Stop", "task_stop")
                taskButton(if (zh) "我来" else "Take over", "task_takeover")
                box.addView(Button(context).apply {
                    text = if (zh) "打开 Nova" else "Open Nova"; contentDescription = text; minHeight = dp(48)
                    setOnClickListener { open() }
                }, LinearLayout.LayoutParams(-1, dp(48)))
            } ?: control(Icon.BACK, INK, null, if (zh) "返回 Nova" else "Return to Nova", open)
            if (callActive) {
                val row = LinearLayout(context).apply { gravity = Gravity.CENTER }
                muteButton = control(Icon.MIC, INK, null, "") { action("mute") }
                val end = control(Icon.END, Color.WHITE, END_RED, if (zh) "结束通话" else "End call") { action("end") }
                if (task != null) {
                    box.removeView(muteButton); box.removeView(end)
                    row.addView(muteButton, LinearLayout.LayoutParams(dp(CONTROL), dp(CONTROL)))
                    row.addView(end, LinearLayout.LayoutParams(dp(CONTROL), dp(CONTROL)))
                    box.addView(row)
                }
            }
        }
        if (expanded && task != null) {
            val controls = LinearLayout(context).apply { orientation = LinearLayout.VERTICAL; gravity = Gravity.CENTER_HORIZONTAL }
            while (box.childCount > 1) {
                val child = box.getChildAt(1)
                box.removeViewAt(1); controls.addView(child)
            }
            box.addView(ScrollView(context).apply { addView(controls) }, LinearLayout.LayoutParams(-1, -2))
        }
        update(muted)
    }

    fun relayout() {
        val box = view ?: return
        box.post {
            if (view !== box) return@post
            // Keep all controls reachable on short/landscape screens without growing the touch window.
            val scroll = box.getChildAt(1) as? ScrollView
            scroll?.layoutParams?.height = -2
            params.width = (if (expanded && task != null) dp(240) else boxWidth).coerceAtMost(context.resources.displayMetrics.widthPixels)
            box.measure(View.MeasureSpec.makeMeasureSpec(params.width, View.MeasureSpec.EXACTLY), View.MeasureSpec.makeMeasureSpec(0, View.MeasureSpec.UNSPECIFIED))
            if (scroll != null) {
                val available = (context.resources.displayMetrics.heightPixels - dp(ORB + 2 * PAD + 64)).coerceAtLeast(dp(48))
                scroll.layoutParams.height = minOf(scroll.measuredHeight, available)
                box.measure(View.MeasureSpec.makeMeasureSpec(params.width, View.MeasureSpec.EXACTLY), View.MeasureSpec.makeMeasureSpec(0, View.MeasureSpec.UNSPECIFIED))
            }
            alignDock(); reposition()
        }
    }

    fun update(value: Boolean) {
        muted = value
        stopPulse()
        when (task?.status) {
            "running" -> { orbRing?.setStroke(0, Color.TRANSPARENT); progress?.invalidate() }
            "needs_user" -> startPulse(Color.rgb(235, 145, 45))
            "done" -> orbRing?.setStroke(dp(3), LIVE_RING)
            "failed" -> orbRing?.setStroke(dp(3), END_RED)
            else -> if (muted) orbRing?.setStroke(dp(3), MUTED_RING) else startPulse()
        }
        mutedBadge?.visibility = if (callActive && muted) View.VISIBLE else View.GONE
        orb?.contentDescription = if (zh) "Nova 通话，${if (muted) "已静音" else "麦克风开启"}，${if (expanded) "点按收起" else "点按展开"}" else "Nova call, ${if (muted) "muted" else "microphone active"}, ${if (expanded) "tap to collapse controls" else "tap for controls"}"
        task?.let {
            val status = if (zh) when (it.status) { "running" -> "运行中"; "needs_user" -> "需要你接管"; "done" -> "已完成"; else -> "失败" } else it.status.replace('_', ' ')
            orb?.contentDescription = "Nova, $status, ${it.label}, " + if (zh) "点按展开或收起" else "tap to expand or collapse"
        }
        muteButton?.apply {
            val label = if (muted) { if (zh) "取消静音" else "Unmute" } else { if (zh) "静音" else "Mute" }
            contentDescription = label
            setImageDrawable(IconDrawable(if (muted) Icon.MIC_OFF else Icon.MIC, if (muted) MUTED_RED else INK, dp(2).toFloat() * 0.85f, inset = dp(11)))
        }
        relayout()
    }

    /** Live ring breathes while the microphone is open; it holds still when muted. */
    private fun startPulse(color: Int = LIVE_RING) {
        val ring = orbRing ?: return
        if (pulse?.isRunning == true) return
        pulse = ValueAnimator.ofFloat(0f, 1f).apply {
            duration = 1800; repeatMode = ValueAnimator.REVERSE; repeatCount = ValueAnimator.INFINITE
            interpolator = AccelerateDecelerateInterpolator()
            addUpdateListener {
                val t = it.animatedValue as Float
                val alpha = (255 * (1f - 0.55f * t)).toInt()
                ring.setStroke(dp(3) + (dp(1) * t).toInt(), Color.argb(alpha, Color.red(color), Color.green(color), Color.blue(color)))
            }
            start()
        }
    }

    private fun stopPulse() { pulse?.cancel(); pulse = null }

    fun hide() {
        stopPulse()
        view?.let { try { windows.removeView(it) } catch (_: RuntimeException) {} }
        view = null; orb = null; orbRing = null; mutedBadge = null; muteButton = null; portraitView = null; preview = null; progress = null; expanded = false
        clearFrame()
    }

    fun setMode(active: Boolean, value: VoicePetTask?, mute: Boolean) {
        val changed = callActive != active || task != value
        callActive = active; task = value; muted = mute
        if (changed) rebuildControls() else update(mute)
    }

    /** Bound allocations even if a caller supplies a full-size portrait or screenshot. */
    private fun decode(bytes: ByteArray): Bitmap? {
        if (bytes.size > 4 * 1024 * 1024) return null
        val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
        BitmapFactory.decodeByteArray(bytes, 0, bytes.size, bounds)
        if (bounds.outWidth <= 0 || bounds.outHeight <= 0) return null
        val options = BitmapFactory.Options()
        while (maxOf(bounds.outWidth, bounds.outHeight) / options.inSampleSize > 512) options.inSampleSize *= 2
        return BitmapFactory.decodeByteArray(bytes, 0, bytes.size, options)
    }
    fun setAvatar(bytes: ByteArray?, path: String?) {
        portrait = try {
            val data = bytes ?: path?.let { java.io.File(it).takeIf { file -> file.length() in 1..4 * 1024 * 1024 }?.readBytes() }
            data?.let(::decode)
        } catch (_: Exception) { null }
        if (portrait != null) portraitView?.setImageBitmap(portrait) else portraitView?.setImageResource(R.drawable.nova_orb_avatar)
    }
    fun frame(bytes: ByteArray) {
        if (!isExpanded || task == null) return
        val bitmap = decode(bytes) ?: return
        latestFrame = bitmap; preview?.setImageBitmap(bitmap)
    }
    fun clearFrame() { latestFrame = null; preview?.setImageDrawable(null) }

    private enum class Icon { BACK, MIC, MIC_OFF, END }

    /** Stroked line glyphs on a 24-unit grid, so the overlay needs no bitmap or XML resources. */
    private class IconDrawable(private val icon: Icon, color: Int, private val strokePx: Float, private val inset: Int) : Drawable() {
        private val paint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
            this.color = color; style = if (icon == Icon.END) Paint.Style.FILL else Paint.Style.STROKE; strokeCap = Paint.Cap.ROUND; strokeJoin = Paint.Join.ROUND
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
                // Filled handset (Material call_end), laid flat with both ear tips pointing down.
                Icon.END -> {
                    p.moveTo(12f, 9f)
                    p.rCubicTo(-1.6f, 0f, -3.15f, .25f, -4.6f, .72f); p.rLineTo(0f, 3.1f)
                    p.rCubicTo(0f, .39f, -.23f, .74f, -.56f, .9f)
                    p.rCubicTo(-.98f, .49f, -1.87f, 1.12f, -2.66f, 1.85f)
                    p.rCubicTo(-.18f, .18f, -.43f, .28f, -.7f, .28f)
                    p.rCubicTo(-.28f, 0f, -.53f, -.11f, -.71f, -.29f)
                    p.lineTo(.29f, 13.08f)
                    p.rCubicTo(-.18f, -.17f, -.29f, -.42f, -.29f, -.7f)
                    p.rCubicTo(0f, -.28f, .11f, -.53f, .29f, -.71f)
                    p.cubicTo(3.34f, 8.78f, 7.46f, 7f, 12f, 7f)
                    p.rCubicTo(4.54f, 0f, 8.66f, 1.78f, 11.71f, 4.67f)
                    p.rCubicTo(.18f, .18f, .29f, .43f, .29f, .71f)
                    p.rCubicTo(0f, .28f, -.11f, .53f, -.29f, .71f)
                    p.rLineTo(-2.48f, 2.48f)
                    p.rCubicTo(-.18f, .18f, -.43f, .29f, -.71f, .29f)
                    p.rCubicTo(-.27f, 0f, -.52f, -.11f, -.7f, -.28f)
                    p.rCubicTo(-.79f, -.74f, -1.69f, -1.36f, -2.67f, -1.85f)
                    p.rCubicTo(-.33f, -.16f, -.56f, -.5f, -.56f, -.9f)
                    p.rLineTo(0f, -3.1f)
                    p.cubicTo(15.15f, 9.25f, 13.6f, 9f, 12f, 9f)
                    p.close()
                }
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
