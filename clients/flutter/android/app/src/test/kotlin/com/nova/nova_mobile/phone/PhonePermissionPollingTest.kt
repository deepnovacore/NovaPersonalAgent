package com.nova.nova_mobile.phone

import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.runTest
import org.junit.Assert.*
import org.junit.Test

@OptIn(kotlinx.coroutines.ExperimentalCoroutinesApi::class)
class PhonePermissionPollingTest {
    @Test fun pollingStopsInBackgroundAndRefreshesImmediatelyOnResume() = runTest {
        val activities = ResumedPhoneActivities()
        val first = Any()
        val second = Any()
        var reads = 0
        val job = launch { pollPhonePermissions(activities.resumed) { reads++ } }
        testScheduler.runCurrent()
        testScheduler.advanceTimeBy(5_000)
        assertEquals(0, reads)
        activities.resume(first)
        testScheduler.runCurrent()
        assertEquals(1, reads)
        testScheduler.advanceTimeBy(2_000)
        testScheduler.runCurrent()
        assertEquals(2, reads)
        activities.resume(second)
        activities.pause(first)
        testScheduler.runCurrent()
        assertTrue(activities.resumed.value)
        testScheduler.advanceTimeBy(2_000)
        testScheduler.runCurrent()
        assertEquals(3, reads)
        activities.pause(second)
        activities.pause(first) // onDestroy after onPause must not underflow.
        testScheduler.runCurrent()
        testScheduler.advanceTimeBy(10_000)
        assertEquals(3, reads)
        assertTrue(job.isActive) // The subscription remains open in the background.
        activities.resume(first)
        activities.resume(first)
        testScheduler.runCurrent()
        assertEquals(4, reads)
        activities.pause(first)
        testScheduler.runCurrent()
        assertFalse(activities.resumed.value)
        job.cancel()
    }

    @Test fun backgroundingCancelsAnInFlightRefresh() = runTest {
        val activities = ResumedPhoneActivities()
        val activity = Any()
        val never = CompletableDeferred<Unit>()
        var cancelled = false
        val job = launch { pollPhonePermissions(activities.resumed) {
            try { never.await() } finally { cancelled = true }
        } }
        activities.resume(activity)
        testScheduler.runCurrent()
        activities.pause(activity)
        testScheduler.runCurrent()
        assertTrue(cancelled)
        job.cancel()
    }
}
