package com.nova.nova_mobile

import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

class AttemptSafetyTest {
    private fun replayAllowed(task:JSONObject)=!task.getBoolean("action_in_flight") &&
        task.getInt("unresolved_actions")==0 && task.getInt("dispatched_actions")==0

    @Test fun everyTerminalPhaseIncludesLaunchAttemptsEvenWithoutActionRows() {
        for(phase in listOf("completed","cancelled","failed","interrupted","verifying")) {
            val task=JSONObject().put("phase",phase).put("actions",JSONArray())
            attemptSafety(task,listOf("dispatched")) // launch is journaled outside actions[]
            assertEquals(phase,task.getString("phase"))
            assertEquals(1,task.getInt("dispatched_actions"))
            assertEquals(0,task.getInt("unresolved_actions"))
            assertFalse(task.getBoolean("action_in_flight"))
            assertFalse(replayAllowed(task))
        }
    }
    @Test fun lateCompletionRefreshesRatherThanPreservingTheTerminalSnapshot() {
        val task=JSONObject().put("phase","cancelled")
        attemptSafety(task,listOf("dispatching"))
        assertTrue(task.getBoolean("action_in_flight"))
        assertEquals(1,task.getInt("unresolved_actions"))
        attemptSafety(task,listOf("dispatched"))
        assertFalse(task.getBoolean("action_in_flight"))
        assertEquals(0,task.getInt("unresolved_actions"))
        assertEquals(1,task.getInt("dispatched_actions"))
        assertFalse(replayAllowed(task))
    }
    @Test fun recoveredUnknownAttemptsRemainBlockedWithoutALiveWorker() {
        val task=attemptSafety(JSONObject(),listOf("unknown","rejected","dispatched","unrecognized_outcome"))
        assertFalse(task.getBoolean("action_in_flight"))
        assertEquals(2,task.getInt("unresolved_actions"))
        assertEquals(1,task.getInt("dispatched_actions"))
        assertFalse(replayAllowed(task))
    }
    @Test fun onlyNoAttemptsOrConfirmedRefusalsCanReleaseReplay() {
        assertTrue(replayAllowed(attemptSafety(JSONObject(),emptyList())))
        val task=attemptSafety(JSONObject(),listOf("dispatching"))
        assertFalse(replayAllowed(task))
        assertTrue(replayAllowed(attemptSafety(task,listOf("rejected"))))
    }
}
