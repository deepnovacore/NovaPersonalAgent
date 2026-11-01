// Derived from Mika (https://github.com/wangzan101/Mika, Apache-2.0, commit 5f630d9),
// Copyright 2026 wangzan101. Modified by Nova: INovaShell, no coroutines, JPEG preview frames to PhoneEventSink,
// JPEG model screenshots and black-frame (FLAG_SECURE) detection from the same ImageReader.
package com.nova.nova_mobile.phone.display

import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Paint
import android.graphics.PixelFormat
import android.graphics.Rect
import android.media.ImageReader
import android.os.Handler
import android.os.HandlerThread
import android.os.SystemClock
import android.util.Base64
import com.nova.nova_mobile.phone.PHONE_FRAME_JPEG_QUALITY
import com.nova.nova_mobile.phone.PhoneActionErrors
import com.nova.nova_mobile.phone.PhoneEventSink
import com.nova.nova_mobile.phone.shell.INovaShell
import java.io.ByteArrayOutputStream

/**
 * The agent's virtual display. It renders into this process's ImageReader, so screenshots never use the
 * accessibility screenshot API (no rate limit). One reader feeds both the full frame for the model and the
 * JPEG preview frames for [sink]. Frames are processed at most every [FRAME_INTERVAL_MS]; older images are
 * dropped by acquireLatestImage. Preview frames additionally pass [PreviewThrottle] and are only encoded while
 * the sink reports a visible preview and the preview is not [previewPaused] (takeover). Black (secure) frames
 * are never sent. Frames are never logged.
 */
class AgentDisplay(
    val shell: INovaShell,
    val width: Int,
    val height: Int,
    dpi: Int,
    private val sink: PhoneEventSink?,
) {
    private val thread = HandlerThread("nova-agent-display").apply { start() }
    private val handler = Handler(thread.looper)
    private val reader = ImageReader.newInstance(width, height, PixelFormat.RGBA_8888, 2)

    val displayId: Int

    private val frameLock = Any()
    private var fullFrame: Bitmap? = null // whole frame with row padding: width = rowStride / pixelStride
    private var hasFrame = false
    private var lastProcessedAt = 0L
    private var pending = false
    @Volatile private var released = false

    /** True while the task is on the main display (takeover): no preview frames are sent. */
    @Volatile var previewPaused = false

    private val paint = Paint(Paint.FILTER_BITMAP_FLAG)
    private val previewSize = FrameMath.previewSize(width, height)
    private val throttle = PreviewThrottle()

    private val process = Runnable {
        pending = false
        lastProcessedAt = SystemClock.uptimeMillis()
        processLatest()
    }

    init {
        reader.setOnImageAvailableListener({ schedule() }, handler)
        val id = try {
            shell.createDisplay(reader.surface, width, height, dpi)
        } catch (t: Throwable) {
            closeLocal()
            throw t
        }
        if (id < 0) {
            closeLocal()
            throw IllegalStateException(PhoneActionErrors.DISPLAY_UNAVAILABLE)
        }
        displayId = id
    }

    private fun schedule() {
        if (pending || released) return
        pending = true
        val wait = lastProcessedAt + FRAME_INTERVAL_MS - SystemClock.uptimeMillis()
        if (wait > 0) handler.postDelayed(process, wait) else handler.post(process)
    }

    private fun processLatest() {
        if (released) return
        val image = runCatching { reader.acquireLatestImage() }.getOrNull() ?: return
        try {
            val plane = image.planes[0]
            val strideWidth = plane.rowStride / plane.pixelStride
            synchronized(frameLock) {
                var bmp = fullFrame
                if (bmp == null || bmp.width != strideWidth) {
                    bmp?.recycle()
                    bmp = Bitmap.createBitmap(strideWidth, height, Bitmap.Config.ARGB_8888)
                    fullFrame = bmp
                }
                bmp.copyPixelsFromBuffer(plane.buffer.rewind())
                hasFrame = true
            }
        } finally {
            image.close()
        }
        sendPreview()
    }

    /** Runs on the frame thread only. */
    private fun sendPreview() {
        val target = sink ?: return
        if (previewPaused || !target.previewVisible) {
            throttle.reset()
            return
        }
        val now = SystemClock.uptimeMillis()
        if (!throttle.due(now)) return
        val (pw, ph) = previewSize
        val preview = Bitmap.createBitmap(pw, ph, Bitmap.Config.ARGB_8888)
        try {
            synchronized(frameLock) {
                val bmp = fullFrame ?: return
                Canvas(preview).drawBitmap(bmp, Rect(0, 0, width, height), Rect(0, 0, pw, ph), paint)
            }
            if (FrameMath.isBlack(pw, ph, preview::getPixel)) return
            if (!throttle.admit(now, FrameMath.lumaGrid(pw, ph, preview::getPixel))) return
            val out = ByteArrayOutputStream()
            preview.compress(Bitmap.CompressFormat.JPEG, PHONE_FRAME_JPEG_QUALITY, out)
            target.frame(out.toByteArray())
        } finally {
            preview.recycle()
        }
    }

    /** Copy of the latest whole frame at display size, or null before the first frame. The caller recycles it. */
    fun latestFrameBitmap(): Bitmap? = synchronized(frameLock) {
        val bmp = fullFrame
        if (!hasFrame || bmp == null) null else Bitmap.createBitmap(bmp, 0, 0, width, height)
    }

    /** Waits up to [timeoutMs] for the first frame; returns whether one exists. Call off the main thread. */
    fun awaitFrame(timeoutMs: Long): Boolean {
        val deadline = SystemClock.uptimeMillis() + timeoutMs
        while (true) {
            if (synchronized(frameLock) { hasFrame }) return true
            if (released || SystemClock.uptimeMillis() >= deadline) return false
            Thread.sleep(FRAME_POLL_MS)
        }
    }

    /** Model screenshot: latest frame scaled to [FrameMath.MODEL_MAX_SIDE], base64 JPEG; null before the first frame. */
    fun modelImage(): ModelImage? {
        val frame = latestFrameBitmap() ?: return null
        try {
            val black = FrameMath.isBlack(frame.width, frame.height, frame::getPixel)
            val (mw, mh) = FrameMath.modelSize(frame.width, frame.height)
            val scaled = if (mw != frame.width || mh != frame.height) Bitmap.createScaledBitmap(frame, mw, mh, true) else frame
            try {
                val out = ByteArrayOutputStream()
                scaled.compress(Bitmap.CompressFormat.JPEG, MODEL_JPEG_QUALITY, out)
                return ModelImage(Base64.encodeToString(out.toByteArray(), Base64.NO_WRAP), black)
            } finally {
                if (scaled !== frame) scaled.recycle()
            }
        } finally {
            frame.recycle()
        }
    }

    /** Latest frame as a luma grid (see [FrameMath.lumaGrid]); null before the first frame. Samples in place, no copy. */
    fun frameGrid(): IntArray? = synchronized(frameLock) {
        val bmp = fullFrame
        if (!hasFrame || bmp == null) null else FrameMath.lumaGrid(width, height, bmp::getPixel)
    }

    fun release() {
        if (released) return
        released = true
        runCatching { shell.releaseDisplay(displayId) }
        closeLocal()
    }

    private fun closeLocal() {
        released = true
        handler.removeCallbacksAndMessages(null)
        // Finish on the frame thread so a frame being processed is never closed underneath it.
        handler.post {
            reader.close()
            synchronized(frameLock) {
                fullFrame?.recycle()
                fullFrame = null
                hasFrame = false
            }
        }
        thread.quitSafely()
    }

    /** [jpegBase64] is the encoded frame; [black] is true for a FLAG_SECURE (all black) frame. */
    class ModelImage(val jpegBase64: String, val black: Boolean)

    private companion object {
        const val FRAME_INTERVAL_MS = 100L
        const val FRAME_POLL_MS = 50L
        /** Same quality as the main-tier screenshot. */
        const val MODEL_JPEG_QUALITY = 75
    }
}
