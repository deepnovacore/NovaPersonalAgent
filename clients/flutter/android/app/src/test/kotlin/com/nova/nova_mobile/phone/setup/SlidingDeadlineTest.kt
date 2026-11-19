// Derived from Mika (https://github.com/wangzan101/Mika, Apache-2.0, commit 5f630d9),
// Copyright 2026 wangzan101. Modified by Nova: package names and scoped native phone integration.
package com.nova.nova_mobile.phone.setup

import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.async
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class SlidingDeadlineTest {
    private fun TestScope.deadline() = SlidingDeadline(10_000L) { testScheduler.currentTime }

    @Test
    fun endsAfterTheLengthWhenNotExtended() = runTest {
        val d = deadline()
        val never = CompletableDeferred<Unit>()
        d.extend()
        val result = async { d.await(never) }
        testScheduler.advanceTimeBy(9_999L)
        testScheduler.runCurrent()
        assertFalse(result.isCompleted)
        testScheduler.advanceTimeBy(1L)
        testScheduler.runCurrent()
        assertFalse(result.await())
    }

    /** 引导页开着放了九分多钟才去系统设置:从这时起再看 10 分钟,不按第一次开始的时候收工。 */
    @Test
    fun extendingWhileWaitingCountsFromThen() = runTest {
        val d = deadline()
        val never = CompletableDeferred<Unit>()
        d.extend()
        val result = async { d.await(never) }
        testScheduler.advanceTimeBy(9_000L)
        d.extend()
        testScheduler.advanceTimeBy(9_000L)
        testScheduler.runCurrent()
        assertFalse(result.isCompleted)
        testScheduler.advanceTimeBy(1_000L)
        testScheduler.runCurrent()
        assertFalse(result.await())
        assertEquals(19_000L, testScheduler.currentTime)
    }

    @Test
    fun finishingInTimeIsTrue() = runTest {
        val d = deadline()
        d.extend()
        val job = launch { delay(3_000L) }
        assertTrue(d.await(job))
        assertEquals(3_000L, testScheduler.currentTime)
    }

    @Test
    fun neverExtendedEndsAtOnce() = runTest {
        assertFalse(deadline().await(CompletableDeferred<Unit>()))
    }
}
