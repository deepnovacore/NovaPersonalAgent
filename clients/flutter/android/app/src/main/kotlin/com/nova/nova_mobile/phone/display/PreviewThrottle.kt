package com.nova.nova_mobile.phone.display

import com.nova.nova_mobile.phone.PHONE_FRAME_MAX_FPS

/**
 * Gate for `nova/phone/frames`: at most [PHONE_FRAME_MAX_FPS] frames per second and no frame whose luma grid
 * equals the last one sent. Used from the single frame thread of [AgentDisplay]; not thread-safe.
 */
class PreviewThrottle(private val minIntervalMs: Long = 1000L / PHONE_FRAME_MAX_FPS) {
    private var lastSentAt: Long? = null
    private var lastGrid: IntArray? = null

    /** True when enough time has passed since the last sent frame; cheap check before encoding anything. */
    fun due(nowMs: Long): Boolean = lastSentAt.let { it == null || nowMs - it >= minIntervalMs }

    /** Records and admits the frame when it is [due] and differs from the last sent frame. */
    fun admit(nowMs: Long, grid: IntArray): Boolean {
        if (!due(nowMs)) return false
        if (lastGrid?.contentEquals(grid) == true) return false
        lastGrid = grid
        lastSentAt = nowMs
        return true
    }

    /** Forget the last frame, e.g. after the preview was hidden, so the next visible frame is always sent. */
    fun reset() {
        lastSentAt = null
        lastGrid = null
    }
}
