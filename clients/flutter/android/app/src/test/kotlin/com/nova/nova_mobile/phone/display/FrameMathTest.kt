// Derived from Mika (https://github.com/wangzan101/Mika, Apache-2.0, commit 5f630d9),
// Copyright 2026 wangzan101. Modified by Nova: package, English comments, preview/model size tests.
package com.nova.nova_mobile.phone.display

import com.nova.nova_mobile.phone.PHONE_FRAME_MAX_WIDTH
import com.nova.nova_mobile.phone.PHONE_FRAME_MIN_WIDTH
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class FrameMathTest {
    private val w = 360
    private val h = 800
    private val black = 0xff000000.toInt()
    private val white = 0xffffffff.toInt()

    @Test fun allBlackIsBlack() {
        assertTrue(FrameMath.isBlack(w, h) { _, _ -> black })
        assertTrue(FrameMath.isBlack(w, h) { _, _ -> 0xff070707.toInt() })
    }

    @Test fun darkThemeWithTextIsNotBlack() {
        // One line of white text on black.
        assertFalse(FrameMath.isBlack(w, h) { _, y -> if (y in 300..340) white else black })
        assertFalse(FrameMath.isBlack(w, h) { _, _ -> 0xff202020.toInt() })
    }

    @Test fun pageChangeDiffers() {
        val a = FrameMath.lumaGrid(w, h) { _, _ -> white }
        val b = FrameMath.lumaGrid(w, h) { _, y -> if (y < h / 2) black else white }
        assertTrue(FrameMath.differs(a, b))
        assertTrue(FrameMath.pageChanged(a, b))
    }

    @Test fun cursorBlinkDoesNotDiffer() {
        val a = FrameMath.lumaGrid(w, h) { _, _ -> white }
        // A 2 px wide cursor.
        val b = FrameMath.lumaGrid(w, h) { x, y -> if (x in 100..101 && y in 200..240) black else white }
        assertFalse(FrameMath.differs(a, b))
        assertFalse(FrameMath.differs(a, null))
    }

    @Test fun previewWidthStaysInTheContractRangeAndKeepsAspect() {
        assertEquals(PHONE_FRAME_MAX_WIDTH to 1066, FrameMath.previewSize(1080, 2400))
        assertEquals(400 to 800, FrameMath.previewSize(400, 800))
        assertEquals(PHONE_FRAME_MIN_WIDTH to 800, FrameMath.previewSize(PHONE_FRAME_MIN_WIDTH, 800))
        // A display narrower than the minimum is never upscaled.
        assertEquals(320 to 640, FrameMath.previewSize(320, 640))
        // Landscape keeps the ratio as well.
        assertEquals(480 to 216, FrameMath.previewSize(2400, 1080))
    }

    @Test fun modelImageLongestSideIsAtMost1280() {
        assertEquals(576 to 1280, FrameMath.modelSize(1080, 2400))
        assertEquals(720 to 1280, FrameMath.modelSize(720, 1280))
        assertEquals(1280 to 576, FrameMath.modelSize(2400, 1080))
        assertEquals(360 to 800, FrameMath.modelSize(360, 800))
    }
}
