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
import android.widget.ScrollView
import android.widget.FrameLayout
import android.widget.ImageButton
import android.widget.ImageView
import android.widget.LinearLayout
import kotlin.math.abs
import kotlin.math.roundToInt

/** Small touch target: it never intercepts touches outside its own bounds. */
internal class VoiceCallOverlay(
    baseContext: Context,
    private val action: (String) -> Unit,
    private val open: () -> Unit,
    private val visibilityChanged: () -> Unit,
    private val windowLost: () -> Unit,
) {
    // Explicit light/dark surfaces and text avoid application/OEM theme mismatches.
    private val context = ContextThemeWrapper(baseContext, if (baseContext.resources.configuration.uiMode and
        android.content.res.Configuration.UI_MODE_NIGHT_MASK == android.content.res.Configuration.UI_MODE_NIGHT_YES)
        android.R.style.Theme_DeviceDefault_NoActionBar else android.R.style.Theme_DeviceDefault_Light_NoActionBar)
    private val dark get() = context.resources.configuration.uiMode and android.content.res.Configuration.UI_MODE_NIGHT_MASK == android.content.res.Configuration.UI_MODE_NIGHT_YES
    private val surface get() = if (dark) Color.rgb(30, 39, 35) else Color.WHITE
    private val ink get() = if (dark) Color.rgb(237, 245, 240) else INK
    private val controlFill get() = if (dark) Color.rgb(52, 65, 58) else Color.rgb(230, 240, 234)
    private val windows = context.getSystemService(WindowManager::class.java)
    private val density get() = context.resources.displayMetrics.density
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
    private var progressAnimator: ValueAnimator? = null
    private var progressAngle = 0f
    private var muteGlyph = 0
    // Virtual display aspect (width/height); the first decoded frame replaces the portrait default.
    private var frameAspect = DISPLAY_ASPECT
    private val decoder = java.util.concurrent.Executors.newSingleThreadExecutor()
    private val main = android.os.Handler(android.os.Looper.getMainLooper())
    private var frameRevision = 0L
    private var avatarRevision = 0L
    private var frameDecoding = false
    val isExpanded get() = view != null && expanded
    private var expanded = false
    private var dockedRight = false
    private var dragging = false
    private var dragStartX = 0
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
            setOnClickListener { expanded = !expanded; if (!expanded) clearFrame(); rebuildControls(); visibilityChanged() }
            accessibilityLiveRegion = View.ACCESSIBILITY_LIVE_REGION_POLITE
        }
        bubble.addView(avatarView(), FrameLayout.LayoutParams(dp(ORB - 8), dp(ORB - 8), Gravity.CENTER))
        val progressRing = object : View(context) {
            private val paint = Paint(Paint.ANTI_ALIAS_FLAG).apply { style = Paint.Style.STROKE; strokeWidth = dp(3).toFloat(); color = LIVE_RING; strokeCap = Paint.Cap.ROUND }
            override fun onDraw(canvas: Canvas) {
                if (task?.status == "running") {
                    val inset = dp(2).toFloat()
                    val angle = progressAngle
                    canvas.drawArc(inset + dp(4), inset + dp(4), width - inset - dp(4), height - inset - dp(4), angle, 110f, false, paint)
                }
            }
        }
        bubble.addView(progressRing, FrameLayout.LayoutParams(-1, -1)); progress = progressRing
        val badge = View(context).apply {
            background = GradientDrawable().apply { shape = GradientDrawable.OVAL; setColor(MUTED_RED); setStroke(dp(2), Color.WHITE) }
            foreground = IconDrawable(Icon.MIC_OFF, Color.WHITE, dp(2).toFloat() * 0.8f, glyph = dp(14))
            visibility = View.GONE
        }
        bubble.addView(badge, FrameLayout.LayoutParams(dp(20), dp(20), Gravity.BOTTOM or Gravity.END))
        box.addView(bubble, LinearLayout.LayoutParams(dp(ORB), dp(ORB)))
        orb = bubble; orbRing = ring; mutedBadge = badge; view = box
        box.addOnAttachStateChangeListener(object : View.OnAttachStateChangeListener {
            override fun onViewAttachedToWindow(v: View) {}
            override fun onViewDetachedFromWindow(v: View) {
                if (view === v) { hide(); windowLost() }
            }
        })
        var downX = 0f; var downY = 0f; var startY = 0
        bubble.setOnTouchListener { target, event ->
            when (event.actionMasked) {
                MotionEvent.ACTION_DOWN -> {
                    downX = event.rawX; downY = event.rawY; dragStartX = params.x; startY = params.y; dragging = false; true
                }
                MotionEvent.ACTION_MOVE -> {
                    val dx = event.rawX - downX; val dy = event.rawY - downY
                    if (abs(dx) + abs(dy) > dp(8)) dragging = true
                    if (dragging) {
                        params.x = (dragStartX + dx.toInt()).coerceIn(0, maxX())
                        params.y = (startY + dy.toInt()).coerceIn(0, maxY())
                        reposition()
                    }; true
                }
                MotionEvent.ACTION_UP -> {
                    if (dragging) { dragging = false; dock(); reposition() } else target.performClick()
                    true
                }
                MotionEvent.ACTION_CANCEL -> { dragging = false; dock(); reposition(); true }
                else -> false
            }
        }
        return try {
            params.width = boxWidth
            alignDock(); windows.addView(box, params); rebuildControls(); visibilityChanged(); true
        } catch (_: RuntimeException) { hide(); false }
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
    private fun alignDock() {
        params.x = if (dockedRight) maxX() else 0; params.y = VoicePetDock.clamp(params.y, maxY())
        // The orb stays on the docked edge, so expanding the wider card does not move it under the finger.
        (orb?.layoutParams as? LinearLayout.LayoutParams)?.let {
            val side = if (dockedRight) Gravity.END else Gravity.START
            if (it.gravity != side) { it.gravity = side; orb?.layoutParams = it }
        }
    }
    private val card get() = expanded && task != null
    private val rowCount get() = if (callActive) 4 else 2
    /** Fixed-height portrait preview; wide frames are capped by width instead. */
    private fun previewSize(aspect: Float = frameAspect): Pair<Int, Int> {
        val width = minOf(dp(PREVIEW) * aspect, dp(PREVIEW_MAX).toFloat())
        return width.roundToInt().coerceAtLeast(1) to (width / aspect).roundToInt().coerceAtLeast(1)
    }
    private fun cardWidth() = maxOf(previewSize().first + dp(2 * PAD), dp(rowCount * ROW_PITCH + 2 * PAD), boxWidth)
    private fun applyAspect(aspect: Float) {
        if (!aspect.isFinite() || aspect <= 0f) return
        val (oldW, oldH) = previewSize(); val (w, h) = previewSize(aspect)
        if (abs(w - oldW) <= 2 && abs(h - oldH) <= 2) return
        frameAspect = aspect
        // Resize in place: a rebuild would drop gestures and the scroll position.
        preview?.let { it.layoutParams = it.layoutParams.apply { width = w; height = h } }
        if (card) setWidth(cardWidth())
        relayout()
    }
    /** Mid-drag the window is not docked; an END-aligned orb stays under the finger as the width changes. */
    private fun setWidth(width: Int) {
        val next = width.coerceAtMost(context.resources.displayMetrics.widthPixels)
        val delta = next - params.width
        params.width = next
        if (dragging && delta != 0) {
            if (dockedRight) { params.x -= delta; dragStartX -= delta }
            params.x = params.x.coerceIn(0, maxX())
        }
    }
    private fun reposition() { view?.let { try { windows.updateViewLayout(it, params) } catch (_: RuntimeException) { hide(); windowLost() } } }

    private fun iconButton(icon: Icon, tint: Int, fill: Int?, label: String, visual: Int, clicked: () -> Unit) = ImageButton(context).apply {
        contentDescription = label; setImageDrawable(IconDrawable(icon, tint, dp(2).toFloat() * 0.85f, glyph = visual * 13 / 24))
        scaleType = ImageView.ScaleType.FIT_CENTER; stateListAnimator = null; elevation = 0f
        // IconDrawable owns its size; theme padding would shrink the glyph twice.
        setPadding(0, 0, 0, 0)
        // The circle is drawn at its visual size while the view (touch target) may be larger.
        background = RippleDrawable(ColorStateList.valueOf(Color.argb(40, 40, 80, 60)),
            fill?.let { CircleDrawable(it, visual) }, CircleDrawable(Color.WHITE, visual))
        setOnClickListener { clicked() }
    }

    private fun rebuildControls() {
        val box = view ?: return
        while (box.childCount > 1) box.removeViewAt(1)
        muteButton = null
        preview = null
        val current = task
        // Collapsed it is only the floating portrait; the capsule appears with the controls.
        box.background = if (expanded) GradientDrawable().apply { setColor(surface); setStroke(dp(1), Color.rgb(226, 233, 229))
            cornerRadius = dp(if (current != null) CARD_RADIUS else (ORB + 2 * PAD) / 2).toFloat() } else null
        box.elevation = if (expanded) dp(6).toFloat() else 0f
        if (expanded && current != null) {
            val controls = LinearLayout(context).apply { orientation = LinearLayout.VERTICAL; gravity = Gravity.CENTER_HORIZONTAL }
            val (width, height) = previewSize()
            preview = ImageView(context).apply {
                scaleType = ImageView.ScaleType.CENTER_CROP
                contentDescription = if (zh) "虚拟屏预览" else "Virtual screen preview"
                background = GradientDrawable().apply { setColor(controlFill); cornerRadius = dp(PREVIEW_RADIUS).toFloat() }
                outlineProvider = ViewOutlineProvider.BACKGROUND; clipToOutline = true
                setImageBitmap(latestFrame)
                controls.addView(this, LinearLayout.LayoutParams(width, height).apply { topMargin = dp(PAD) })
            }
            val row = LinearLayout(context).apply { orientation = LinearLayout.HORIZONTAL; gravity = Gravity.CENTER }
            val visual = dp(if (callActive) ROW_SMALL else ROW_LARGE)
            fun rowControl(icon: Icon, tint: Int, fill: Int?, label: String, clicked: () -> Unit) =
                iconButton(icon, tint, fill, label, visual, clicked).also { row.addView(it, LinearLayout.LayoutParams(0, dp(TOUCH), 1f)) }
            rowControl(Icon.STOP, END_RED, controlFill, if (zh) "停止" else "Stop") { action("task_stop") }.apply {
                isEnabled = !current.terminal; alpha = if (current.terminal) 0.4f else 1f
            }
            rowControl(Icon.OPEN, ink, controlFill, if (zh) "打开 Nova" else "Open Nova", open)
            if (callActive) {
                muteButton = rowControl(Icon.MIC, ink, controlFill, "") { action("mute") }; muteGlyph = visual * 13 / 24
                rowControl(Icon.END, Color.WHITE, END_RED, if (zh) "结束通话" else "End call") { action("end") }
            }
            controls.addView(row, LinearLayout.LayoutParams(-1, -2))
            box.addView(ScrollView(context).apply { addView(controls) }, LinearLayout.LayoutParams(-1, -2))
        } else if (expanded) {
            fun control(icon: Icon, tint: Int, fill: Int?, label: String, clicked: () -> Unit) = iconButton(icon, tint, fill, label, dp(CONTROL), clicked)
                .also { box.addView(it, LinearLayout.LayoutParams(dp(CONTROL), dp(CONTROL)).apply { topMargin = dp(4) }) }
            control(Icon.BACK, ink, null, if (zh) "返回 Nova" else "Return to Nova", open)
            if (callActive) {
                muteButton = control(Icon.MIC, ink, null, "") { action("mute") }; muteGlyph = dp(CONTROL) * 13 / 24
                control(Icon.END, Color.WHITE, END_RED, if (zh) "结束通话" else "End call") { action("end") }
            }
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
            setWidth(if (card) cardWidth() else boxWidth)
            box.measure(View.MeasureSpec.makeMeasureSpec(params.width, View.MeasureSpec.EXACTLY), View.MeasureSpec.makeMeasureSpec(0, View.MeasureSpec.UNSPECIFIED))
            if (scroll != null) {
                val available = (context.resources.displayMetrics.heightPixels - dp(ORB + 2 * PAD + 64)).coerceAtLeast(dp(48))
                scroll.layoutParams.height = minOf(scroll.measuredHeight, available)
                box.measure(View.MeasureSpec.makeMeasureSpec(params.width, View.MeasureSpec.EXACTLY), View.MeasureSpec.makeMeasureSpec(0, View.MeasureSpec.UNSPECIFIED))
            }
            // Docking mid-drag would snap the window away from the finger; release docks instead.
            if (!dragging) alignDock()
            reposition()
        }
    }

    fun update(value: Boolean) {
        muted = value
        stopPulse()
        if (task?.status == "running" && view != null) {
            if (progressAnimator == null) progressAnimator = ValueAnimator.ofFloat(0f, 360f).apply {
                duration = 1800; repeatCount = ValueAnimator.INFINITE
                interpolator = android.view.animation.LinearInterpolator()
                addUpdateListener { progressAngle = it.animatedValue as Float; progress?.invalidate() }
                start()
            }
        } else { progressAnimator?.cancel(); progressAnimator = null; progress?.invalidate() }
        when {
            callActive && !muted -> startPulse() // Privacy indicator must survive task status changes.
            task?.status == "needs_user" -> startPulse(Color.rgb(235, 145, 45))
            task?.status == "done" -> orbRing?.setStroke(dp(3), LIVE_RING)
            task?.status == "failed" -> orbRing?.setStroke(dp(3), END_RED)
            callActive -> orbRing?.setStroke(dp(3), MUTED_RING)
            else -> orbRing?.setStroke(0, Color.TRANSPARENT)
        }
        mutedBadge?.visibility = if (callActive && muted) View.VISIBLE else View.GONE
        val descriptions = mutableListOf("Nova")
        if (callActive) descriptions.add(if (muted) { if (zh) "麦克风已静音" else "microphone muted" }
            else { if (zh) "麦克风开启" else "microphone active" })
        task?.let {
            descriptions.add(when (it.status) {
                "running" -> if (zh) "运行中" else "running"
                "needs_user" -> if (zh) "需要你接管" else "Your help is needed"
                "done" -> if (zh) "已完成" else "completed"
                else -> if (zh) "失败" else "failed"
            })
            // The card shows no step text; the orb's polite live region announces it instead.
            it.step?.let { step -> descriptions.add(if (zh) "第 $step 步" else "Step $step") }
            if (it.label.isNotBlank()) descriptions.add(it.label)
        }
        descriptions.add(if (expanded) { if (zh) "点按收起" else "tap to collapse controls" }
            else { if (zh) "点按展开" else "tap for controls" })
        orb?.contentDescription = descriptions.joinToString(", ")
        muteButton?.apply {
            val label = if (muted) { if (zh) "取消静音" else "Unmute" } else { if (zh) "静音" else "Mute" }
            contentDescription = label
            setImageDrawable(IconDrawable(if (muted) Icon.MIC_OFF else Icon.MIC, if (muted) MUTED_RED else ink, dp(2).toFloat() * 0.85f, glyph = muteGlyph))
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
        progressAnimator?.cancel(); progressAnimator = null
        val removed = view
        view = null // Detach callbacks must distinguish our hide from permission/OEM removal.
        // Detach bitmaps from the dying window before they can be recycled.
        clearFrame()
        portraitView?.setImageDrawable(null)
        removed?.let { try { windows.removeView(it) } catch (_: RuntimeException) {} }
        view = null; orb = null; orbRing = null; mutedBadge = null; muteButton = null; portraitView = null; preview = null; progress = null; expanded = false; dragging = false
        visibilityChanged()
    }

    fun setMode(active: Boolean, value: VoicePetTask?, mute: Boolean) {
        val changed = VoicePetControls.needsRebuild(callActive, task, active, value)
        callActive = active; task = value; muted = mute
        if (changed) rebuildControls() else update(mute)
    }

    /** Decode off the UI thread; sample without undershooting, then cap the longest edge. */
    private fun decode(bytes: ByteArray, cap: Int = AVATAR_CAP): Bitmap? {
        if (bytes.size > 4 * 1024 * 1024) return null
        val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
        BitmapFactory.decodeByteArray(bytes, 0, bytes.size, bounds)
        if (bounds.outWidth <= 0 || bounds.outHeight <= 0) return null
        val options = BitmapFactory.Options().apply {
            inSampleSize = VoicePetImages.sampleSize(maxOf(bounds.outWidth, bounds.outHeight), cap)
        }
        val decoded = BitmapFactory.decodeByteArray(bytes, 0, bytes.size, options) ?: return null
        val longest = maxOf(decoded.width, decoded.height)
        if (longest <= cap) return decoded
        return Bitmap.createScaledBitmap(decoded, (decoded.width * cap / longest).coerceAtLeast(1),
            (decoded.height * cap / longest).coerceAtLeast(1), true).also { if (it !== decoded) decoded.recycle() }
    }
    fun setAvatar(bytes: ByteArray?, path: String?) {
        val revision = ++avatarRevision
        decoder.execute {
            val bitmap = try {
                val data = bytes ?: path?.let { java.io.File(it).takeIf { file -> file.length() in 1..4 * 1024 * 1024 }?.readBytes() }
                data?.let(::decode)
            } catch (_: Exception) { null } catch (_: OutOfMemoryError) { null }
            main.post {
                if (avatarRevision != revision) { bitmap?.recycle(); return@post }
                val previous = portrait
                portrait = bitmap
                if (bitmap != null) portraitView?.setImageBitmap(bitmap) else portraitView?.setImageResource(R.drawable.nova_orb_avatar)
                previous?.recycle()
            }
        }
    }
    fun frame(bytes: ByteArray) {
        if (!isExpanded || task?.status != "running" || frameDecoding) return
        frameDecoding = true
        val revision = ++frameRevision
        decoder.execute {
            // OutOfMemoryError must not leave frameDecoding stuck, or the preview freezes.
            val bitmap = try { decode(bytes, FRAME_CAP) } catch (_: Exception) { null } catch (_: OutOfMemoryError) { null }
            main.post {
                frameDecoding = false
                if (frameRevision != revision || !isExpanded) { bitmap?.recycle(); return@post }
                if (bitmap != null) {
                    val previous = latestFrame
                    latestFrame = bitmap; preview?.setImageBitmap(bitmap)
                    previous?.recycle()
                    applyAspect(bitmap.width.toFloat() / bitmap.height)
                }
            }
        }
    }
    fun clearFrame() {
        frameRevision++
        preview?.setImageDrawable(null)
        latestFrame?.recycle(); latestFrame = null
    }

    private enum class Icon { BACK, MIC, MIC_OFF, END, STOP, OPEN }

    /** Centred circle of a fixed diameter, so a button's touch bounds can exceed its visual. */
    private class CircleDrawable(color: Int, private val diameter: Int) : Drawable() {
        private val paint = Paint(Paint.ANTI_ALIAS_FLAG).apply { this.color = color }
        override fun draw(canvas: Canvas) {
            canvas.drawCircle(bounds.exactCenterX(), bounds.exactCenterY(), minOf(diameter, bounds.width(), bounds.height()) / 2f, paint)
        }
        override fun setAlpha(alpha: Int) { paint.alpha = alpha }
        override fun setColorFilter(colorFilter: ColorFilter?) { paint.colorFilter = colorFilter }
        @Deprecated("Deprecated in Java") override fun getOpacity() = PixelFormat.TRANSLUCENT
    }

    /** Line glyphs on a 24-unit grid, centred at [glyph] px, so the overlay needs no bitmap or XML resources. */
    private class IconDrawable(private val icon: Icon, color: Int, private val strokePx: Float, private val glyph: Int) : Drawable() {
        private val paint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
            this.color = color; style = if (icon == Icon.END || icon == Icon.STOP) Paint.Style.FILL else Paint.Style.STROKE; strokeCap = Paint.Cap.ROUND; strokeJoin = Paint.Join.ROUND
        }
        override fun draw(canvas: Canvas) {
            val b = bounds
            val size = minOf(glyph, b.width(), b.height())
            if (size <= 0) return
            val s = size / 24f
            canvas.save()
            canvas.translate(b.exactCenterX() - size / 2f, b.exactCenterY() - size / 2f)
            canvas.scale(s, s)
            paint.strokeWidth = (strokePx / s).coerceAtLeast(1.6f)
            val p = Path()
            when (icon) {
                Icon.BACK -> { p.moveTo(19f, 12f); p.lineTo(5f, 12f); p.moveTo(11f, 6f); p.lineTo(5f, 12f); p.lineTo(11f, 18f) }
                Icon.STOP -> p.addRoundRect(RectF(6f, 6f, 18f, 18f), 2f, 2f, Path.Direction.CW)
                Icon.OPEN -> {
                    p.moveTo(11f, 5f); p.lineTo(5f, 5f); p.lineTo(5f, 19f); p.lineTo(19f, 19f); p.lineTo(19f, 13f)
                    p.moveTo(14f, 4f); p.lineTo(20f, 4f); p.lineTo(20f, 10f); p.moveTo(20f, 4f); p.lineTo(11f, 13f)
                }
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
        const val PREVIEW = 288
        const val PREVIEW_MAX = 240
        const val PREVIEW_RADIUS = 14
        const val CARD_RADIUS = 20
        const val ROW_SMALL = 30
        const val ROW_LARGE = 40
        const val ROW_PITCH = 32
        const val TOUCH = 44
        const val AVATAR_CAP = 256
        const val FRAME_CAP = 512
        const val DISPLAY_ASPECT = 1200f / 2670f
        val INK = Color.rgb(29, 45, 39)
        val LIVE_RING = Color.rgb(76, 175, 125)
        val MUTED_RING = Color.rgb(176, 181, 186)
        val MUTED_RED = Color.rgb(200, 84, 80)
        val END_RED = Color.rgb(214, 69, 65)
    }
}
