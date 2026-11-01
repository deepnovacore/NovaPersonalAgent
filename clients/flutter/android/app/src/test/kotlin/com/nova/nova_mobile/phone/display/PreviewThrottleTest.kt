package com.nova.nova_mobile.phone.display

import com.nova.nova_mobile.phone.PHONE_FRAME_MAX_FPS
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class PreviewThrottleTest {
    private fun grid(value: Int) = IntArray(FrameMath.GRID_W * FrameMath.GRID_H) { value }

    @Test fun neverMoreThanEightFramesPerSecond() {
        val throttle = PreviewThrottle()
        var sent = 0
        // A new, different frame every 10 ms for one second.
        for (t in 0 until 1000 step 10) if (throttle.admit(t.toLong(), grid(t))) sent++
        assertEquals(PHONE_FRAME_MAX_FPS, sent)
    }

    @Test fun identicalFramesAreSkippedEvenWhenDue() {
        val throttle = PreviewThrottle()
        assertTrue(throttle.admit(0, grid(1)))
        assertFalse(throttle.admit(500, grid(1)))
        assertTrue(throttle.admit(1000, grid(2)))
    }

    @Test fun dueIsACheapCheckBeforeEncoding() {
        val throttle = PreviewThrottle()
        assertTrue(throttle.due(0))
        throttle.admit(0, grid(1))
        assertFalse(throttle.due(100))
        assertTrue(throttle.due(125))
    }

    @Test fun resetAfterHidingSendsTheNextVisibleFrame() {
        val throttle = PreviewThrottle()
        assertTrue(throttle.admit(0, grid(1)))
        throttle.reset()
        assertTrue(throttle.admit(1, grid(1)))
    }
}
