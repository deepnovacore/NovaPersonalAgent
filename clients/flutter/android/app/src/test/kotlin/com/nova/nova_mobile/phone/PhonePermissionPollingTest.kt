package com.nova.nova_mobile.phone

import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.async
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.take
import kotlinx.coroutines.flow.toList
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

    @Test fun statusFlagsReadOnceBeforeTheFirstPollInsteadOfReportingAllOff() = runTest {
        val flags = MutableStateFlow<Boolean?>(null)
        var reads = 0
        assertEquals(true, readPermissionFlags(flags) { reads++; true }.first())
        assertEquals(1, reads)
        assertEquals(true, flags.value)
    }

    @Test fun statusFlagsFollowPollsWithoutRereading() = runTest {
        val flags = MutableStateFlow<Boolean?>(false)
        var reads = 0
        val seen = async { readPermissionFlags(flags) { reads++; true }.take(2).toList() }
        testScheduler.runCurrent()
        flags.value = true
        assertEquals(listOf(false, true), seen.await())
        assertEquals(0, reads)
    }
}
