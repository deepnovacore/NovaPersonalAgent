package com.nova.nova_audio

import org.junit.Assert.*
import org.junit.Test

class VoicePetStateTest {
    private fun task(status: String = "running", id: String = "task-1") = VoicePetTask(id, status, "Open app", 2)

    @Test fun taskWithoutCallIsVisibleOnlyInBackground() {
        val state = VoicePetState()
        assertFalse(state.visible)
        state.task = task()
        assertTrue(state.visible)
        state.resumed = true
        assertFalse(state.visible)
        state.resumed = false
        assertTrue(state.visible)
    }

    @Test fun endingCallDoesNotEndTaskAndHidingTaskDoesNotEndCall() {
        val state = VoicePetState()
        state.callActive = true; state.task = task()
        state.callActive = false
        assertTrue(state.visible)
        state.callActive = true; state.task = null
        assertTrue(state.visible)
        state.resumed = true
        assertFalse(state.visible)
    }

    @Test fun framesRequireExpandedBackgroundRunningTask() {
        val state = VoicePetState()
        state.callActive = true
        assertFalse(state.acceptsFrame(true))
        state.task = task()
        assertTrue(state.acceptsFrame(true))
        assertFalse(state.acceptsFrame(false))
        state.resumed = true
        assertFalse(state.acceptsFrame(true))
        state.resumed = false
        for (status in listOf("needs_user", "done", "failed")) {
            state.task = task(status)
            assertFalse(state.acceptsFrame(true))
        }
    }

    @Test fun terminalTimeoutCannotHideReplacementOrUpdatedTask() {
        val state = VoicePetState()
        val done = task("done")
        state.task = done
        state.task = task("running", "task-2")
        assertFalse(state.expire(done))
        state.task = task("done")
        assertFalse(state.expire(done))
        state.task = done; state.callActive = true
        assertTrue(state.expire(done))
        assertNull(state.task)
        assertTrue(state.visible)
    }

    @Test fun runningTaskCannotExpire() {
        val state = VoicePetState()
        val running = task()
        state.task = running
        assertFalse(state.expire(running))
    }

    @Test fun invalidTaskStateIsRejected() {
        for (invalid in listOf({ task("completed") }, { task(id = " ") }, { VoicePetTask("id", "running", "", -1) })) {
            try { invalid(); fail("Expected invalid task") } catch (_: IllegalArgumentException) {}
        }
    }

    @Test fun dockingClampsToAvailableScreen() {
        assertEquals(0, VoicePetDock.edge(49, 100))
        assertEquals(100, VoicePetDock.edge(51, 100))
        assertEquals(0, VoicePetDock.edge(10, -20))
        assertEquals(0, VoicePetDock.clamp(-5, 100))
        assertEquals(100, VoicePetDock.clamp(150, 100))
        assertEquals(0, VoicePetDock.clamp(50, -20))
    }

    @Test fun taskOwnershipIsIndependentAndForeignEngineCannotReleaseIt() {
        val call = VoiceCallOwnership()
        val task = VoiceCallOwnership()
        assertTrue(call.claim("call-engine"))
        assertTrue(task.claim("task-engine"))
        assertFalse(task.claim("headless-engine"))
        assertFalse(task.release("headless-engine"))
        assertTrue(call.release("call-engine"))
        assertTrue(task.owns("task-engine"))
        assertTrue(task.release("task-engine"))
        assertTrue(task.claim("next-engine"))
    }
}
