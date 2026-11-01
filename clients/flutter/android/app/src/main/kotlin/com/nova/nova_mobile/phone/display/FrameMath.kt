// Derived from Mika (https://github.com/wangzan101/Mika, Apache-2.0, commit 5f630d9),
// Copyright 2026 wangzan101. Modified by Nova: package, English comments, preview/model frame sizing helpers.
package com.nova.nova_mobile.phone.display

import com.nova.nova_mobile.phone.PHONE_FRAME_MAX_WIDTH
import com.nova.nova_mobile.phone.PHONE_FRAME_MIN_WIDTH
import kotlin.math.abs
import kotlin.math.max
import kotlin.math.roundToInt

/**
 * Coarse frame checks that only use a pixel reader, so they run on the JVM without Android classes.
 * [pixel] returns the ARGB colour at (x, y).
 */
object FrameMath {
    const val GRID_W = 12
    const val GRID_H = 24
    private const val CELL_SAMPLES = 4
    private const val CELL_DELTA = 16
    private const val MIN_CELLS = 3
    private const val PAGE_SHARE = 0.25
    private const val BLACK_SAMPLES = 24
    private const val BLACK_LEVEL = 8
    /** Longest side of the model screenshot (contract: `image` longest side <= 1280). */
    const val MODEL_MAX_SIDE = 1280

    /** Splits the frame into [GRID_W] x [GRID_H] cells and averages the luma of 4 x 4 samples per cell. */
    fun lumaGrid(width: Int, height: Int, pixel: (Int, Int) -> Int): IntArray {
        val out = IntArray(GRID_W * GRID_H)
        val cw = width / GRID_W
        val ch = height / GRID_H
        if (cw == 0 || ch == 0) return out
        for (gy in 0 until GRID_H) for (gx in 0 until GRID_W) {
            var sum = 0L
            for (sy in 0 until CELL_SAMPLES) for (sx in 0 until CELL_SAMPLES) {
                sum += luma(pixel(gx * cw + sx * cw / CELL_SAMPLES, gy * ch + sy * ch / CELL_SAMPLES))
            }
            out[gy * GRID_W + gx] = (sum / (CELL_SAMPLES * CELL_SAMPLES)).toInt()
        }
        return out
    }

    /** The frame changed only when enough cells got clearly brighter or darker; a blinking cursor does not count. */
    fun differs(a: IntArray?, b: IntArray?): Boolean {
        if (a == null || b == null || a.size != b.size) return false
        return a.indices.count { abs(a[it] - b[it]) > CELL_DELTA } >= MIN_CELLS
    }

    /** At least [PAGE_SHARE] of the cells changed: a new page (or the whole screen moving), not a local animation. */
    fun pageChanged(a: IntArray?, b: IntArray?): Boolean {
        if (a == null || b == null || a.size != b.size) return false
        return a.indices.count { abs(a[it] - b[it]) > CELL_DELTA } >= a.size * PAGE_SHARE
    }

    /** Black (FLAG_SECURE) when at least 99.5% of evenly spread samples are <= [BLACK_LEVEL] on every channel. */
    fun isBlack(width: Int, height: Int, pixel: (Int, Int) -> Int): Boolean {
        if (width <= 1 || height <= 1) return false
        var dark = 0
        val total = BLACK_SAMPLES * BLACK_SAMPLES
        for (gy in 0 until BLACK_SAMPLES) for (gx in 0 until BLACK_SAMPLES) {
            val p = pixel(gx * (width - 1) / (BLACK_SAMPLES - 1), gy * (height - 1) / (BLACK_SAMPLES - 1))
            if ((p shr 16 and 0xff) <= BLACK_LEVEL && (p shr 8 and 0xff) <= BLACK_LEVEL && (p and 0xff) <= BLACK_LEVEL) dark++
        }
        return dark * 1000 >= total * 995
    }

    /**
     * Preview frame size for `nova/phone/frames`: width in [PHONE_FRAME_MIN_WIDTH]..[PHONE_FRAME_MAX_WIDTH]
     * (a display narrower than the minimum keeps its own width), height keeps the aspect ratio.
     */
    fun previewSize(width: Int, height: Int): Pair<Int, Int> {
        require(width > 0 && height > 0)
        val w = if (width <= PHONE_FRAME_MIN_WIDTH) width else width.coerceAtMost(PHONE_FRAME_MAX_WIDTH)
        return w to max(1, (height.toLong() * w / width).toInt())
    }

    /** Model screenshot size: the full frame scaled down so its longest side is at most [MODEL_MAX_SIDE]. */
    fun modelSize(width: Int, height: Int): Pair<Int, Int> {
        require(width > 0 && height > 0)
        val longest = max(width, height)
        if (longest <= MODEL_MAX_SIDE) return width to height
        val scale = MODEL_MAX_SIDE.toDouble() / longest
        return max(1, (width * scale).roundToInt()) to max(1, (height * scale).roundToInt())
    }

    private fun luma(p: Int) = ((p shr 16 and 0xff) * 3 + (p shr 8 and 0xff) * 6 + (p and 0xff)) / 10
}
