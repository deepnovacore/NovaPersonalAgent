package com.nova.nova_audio

import org.junit.Assert.*
import org.junit.Test

class VoicePetRequestsTest {
    private fun task(id: String = "one", status: String = "running") = VoicePetTask(id, status, "Open", 1)

    @Test fun doubleShowCompletesBothWithFinalOutcome() {
        for (error in listOf(null, "foreground_blocked", "timeout", "overlay_blocked")) {
            val requests = VoicePetRequests()
            val results = mutableListOf<String?>()
            requests.show(task()) { results.add(it) }
            requests.show(task(status = "needs_user")) { results.add(it) }
            assertEquals("needs_user", requests.task?.status)
            assertTrue(results.isEmpty())
            requests.complete(error)
            requests.complete("timeout")
            assertEquals(listOf(error, error), results)
            assertFalse(requests.starting)
        }
    }

    @Test fun hideBeforeReadyCompletesOnceAndInvalidatesTimeout() {
        val requests = VoicePetRequests()
        val results = mutableListOf<String?>()
        requests.show(task()) { results.add(it) }
        val generation = requests.generation
        assertTrue(requests.hide("one"))
        requests.complete()
        assertEquals(listOf("overlay_blocked"), results)
        assertNotEquals(generation, requests.generation)
        assertNull(requests.task)
        requests.show(task("two")) { results.add(it) }
        assertFalse(requests.hide("one"))
        assertEquals("two", requests.task?.id)
        requests.complete()
        assertEquals(listOf("overlay_blocked", null), results)
    }

    @Test fun hideBeforeShowDoesNotPoisonNextRequest() {
        val requests = VoicePetRequests()
        requests.hide()
        val results = mutableListOf<String?>()
        requests.show(task()) { results.add(it) }
        requests.complete()
        assertEquals(listOf<String?>(null), results)
        assertEquals("one", requests.task?.id)
    }

    @Test fun labelsAndStepsDoNotRebuildGestureTargets() {
        val old = task()
        assertFalse(VoicePetControls.needsRebuild(true, old, true, old.copy(label = "New", step = 9)))
        assertFalse(VoicePetControls.needsRebuild(true, old, true, old.copy(status = "needs_user")))
        assertTrue(VoicePetControls.needsRebuild(true, old, false, old))
        assertTrue(VoicePetControls.needsRebuild(true, old, true, old.copy(status = "done")))
        assertTrue(VoicePetControls.needsRebuild(true, old, true, task("two")))
    }

    @Test fun decodeSamplingDoesNotUndershootBeforeFinalSizeCap() {
        assertEquals(1, VoicePetImages.sampleSize(256))
        assertEquals(1, VoicePetImages.sampleSize(511))
        assertEquals(2, VoicePetImages.sampleSize(512))
        assertEquals(8, VoicePetImages.sampleSize(2400)) // 300px, then scale to 256; not 150px upscaled.
    }
}
