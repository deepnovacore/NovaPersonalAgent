package com.nova.nova_mobile.phone

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Test

class PhoneEventJsonTest {
    private fun keys(o: JSONObject) = o.keys().asSequence().toSet()

    @Test fun stepEventsUseContractKeysAndOmitAbsentOptionals() {
        val running = PhoneStepEvent("t1", 3, "tap", "Open search", StepStatus.RUNNING, null, "@e4", PhoneTier.VIRTUAL).toJson()
        assertEquals(setOf("type", "task_id", "step", "tool", "label", "status", "ref", "tier"), keys(running))
        assertEquals("step", running.getString("type"))
        assertEquals("running", running.getString("status"))
        assertEquals("virtual", running.getString("tier"))
        val done = PhoneStepEvent("t1", 3, "back", "Back", StepStatus.UNKNOWN, true, null, PhoneTier.VIRTUAL).toJson()
        assertEquals(true, done.getBoolean("changed"))
        assertFalse(done.has("ref"))
        assertEquals("unknown", done.getString("status"))
    }

    @Test fun takeoverAndDoneEvents() {
        val takeover = PhoneTakeoverEvent("t1", TakeoverState.TIMED_OUT, byModel = false, reason = null).toJson()
        assertEquals(setOf("type", "task_id", "state", "by"), keys(takeover))
        assertEquals("user", takeover.getString("by"))
        assertEquals("timed_out", takeover.getString("state"))
        assertEquals("model", PhoneTakeoverEvent("t1", TakeoverState.ACTIVE, true, "outside_target_app").toJson().getString("by"))
        val done = PhoneDoneEvent("t1", DoneOutcome.INTERRUPTED, "tool_ref_expired", null, 5, 1234).toJson()
        assertEquals(setOf("type", "task_id", "outcome", "reason", "steps", "duration_ms"), keys(done))
        assertEquals("interrupted", done.getString("outcome"))
        assertEquals(1234L, done.getLong("duration_ms"))
    }
}
