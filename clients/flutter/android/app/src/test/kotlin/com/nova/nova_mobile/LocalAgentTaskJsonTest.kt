package com.nova.nova_mobile

import com.nova.nova_mobile.phone.*
import java.io.File
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

class LocalAgentTaskJsonTest {
    @Test fun runRepliesAndTaskListsKeepTheirAdmittedTier() {
        for (tier in PhoneTier.entries) {
            val reply = taskWithTier(JSONObject().put("id", "request-id"), tier)
            assertEquals(tier.wire, JSONObject(reply.toString()).getString("tier"))
            val stored = JSONObject(reply.toString())
            val tasks = JSONArray(listOf(taskWithTier(stored)))
            assertEquals(tier.wire, tasks.getJSONObject(0).getString("tier"))
            assertEquals("request-id", tasks.getJSONObject(0).getString("id"))
        }
    }

    @Test fun legacyRunReplayAndTaskListDefaultToMain() {
        val legacy = "{\"id\":\"old\",\"phase\":\"completed\"}"
        assertEquals("main", taskWithTier(JSONObject(legacy)).getString("tier"))
        val tasks = JSONArray(listOf(taskWithTier(JSONObject(legacy))))
        assertEquals("main", tasks.getJSONObject(0).getString("tier"))
        assertEquals("completed", tasks.getJSONObject(0).getString("phase"))
    }

    @Test fun phoneEventsUseTheRunRequestIdWithoutRewritingIt() {
        val request = JSONObject().put("id", "dart-request:123")
        val id = request.getString("id")
        val events = listOf(
            PhoneStepEvent(id, 1, "observe", "Check", StepStatus.COMPLETED, null, null, PhoneTier.VIRTUAL).toJson(),
            PhoneTakeoverEvent(id, TakeoverState.ACTIVE, false, null).toJson(),
            PhoneDoneEvent(id, DoneOutcome.COMPLETED, null, null, 1, 10).toJson(),
        )
        events.forEach { assertEquals(request.getString("id"), it.getString("task_id")) }
        // Pin the Android controller seam as well as the pure encoders: no generated id in between.
        val source = File("src/main/kotlin/com/nova/nova_mobile/LocalAgentController.kt").readText()
        assertTrue(source.contains("val id=request.getString(\"id\")"))
        assertTrue(source.contains("val run=Active(id,"))
        assertTrue(source.contains("RunTakeover(run.id,"))
        assertTrue(source.contains("VirtualRunHost(run.id,"))
        assertTrue(source.contains("PhoneDoneEvent(run.id,"))
        assertTrue(source.contains("return taskWithTier(previous)"))
        assertTrue(source.contains("fun tasks()=JSONArray(journal.tasks().map { taskWithTier(it) })"))
    }
}
