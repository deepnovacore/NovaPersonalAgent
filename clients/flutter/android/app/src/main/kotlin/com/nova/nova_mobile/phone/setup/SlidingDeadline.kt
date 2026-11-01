// Derived from Mika (https://github.com/wangzan101/Mika, Apache-2.0, commit 5f630d9),
// Copyright 2026 wangzan101. Modified by Nova: package names and scoped native phone integration.
package com.nova.nova_mobile.phone.setup

import kotlinx.coroutines.Job
import kotlinx.coroutines.withTimeoutOrNull

/**
 * 能往后推的时限:从最后一次 [extend] 起算 [lengthMs]。[PairingCoordinator] 用它定看着配对多久,
 * 用户每次回到配对这件事上(点「去无线调试」、从停在配对一步的引导页离开)都从那时重新算。
 */
internal class SlidingDeadline(private val lengthMs: Long, private val now: () -> Long) {
    @Volatile private var until = 0L

    fun extend() {
        until = now() + lengthMs
    }

    /** 等 [job] 做完;等的时候时限可以被推后。做完为 true,时限先到为 false。 */
    suspend fun await(job: Job): Boolean {
        while (true) {
            val left = until - now()
            if (left <= 0) return false
            if (withTimeoutOrNull(left) { job.join() } != null) return true
        }
    }
}
