package com.nova.nova_mobile

import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

class TapGuardTest {
    private fun element(name: String = "Control 12", left: Int = 100) = JSONObject()
        .put("ref", "@e1").put("name", name).put("class", "Button").put("resource_id", "app:id/control")
        .put("clickable", true).put("checked", false).put("bounds", JSONArray(listOf(left, 100, left + 100, 200)))
    private fun screen(vararg elements: JSONObject) = JSONObject().put("package", "test.app")
        .put("snapshot_id", "ph-1").put("elements", JSONArray(elements.toList()))
    private fun tap() = JSONObject("""{"type":"tap","ref":"@e1","snapshot_id":"ph-1"}""")
    private fun refused(guard: TapGuard, target: TapGuard.Target?) {
        try { guard.check(target); fail("repeat accepted") } catch (e: IllegalArgumentException) { assertEquals(TapGuard.CODE, e.message) }
    }

    @Test fun digitsDoNotChangeIdentityButStateEvidenceDoes() {
        val guard = TapGuard()
        val target = guard.target(tap(), screen(element()))
        guard.check(target)
        guard.dispatched(tap(), target)
        val after = screen(element("Control 13"))
        guard.observe(after)
        refused(guard, guard.target(tap(), after))
        assertTrue(after.getJSONObject("last_tap_effect").getBoolean("changed"))
        assertEquals("Control 12", after.getJSONObject("last_tap_effect").getJSONObject("before").getString("name"))
    }

    @Test fun differentItemMissingElementAndNavigationAllowTaps() {
        val guard = TapGuard()
        val original = screen(element())
        guard.dispatched(tap(), guard.target(tap(), original))
        guard.check(guard.target(tap(), screen(element(left = 400))))
        guard.observe(screen())
        guard.check(guard.target(tap(), original))
        for (action in listOf("back", "open_app")) {
            guard.dispatched(tap(), guard.target(tap(), original))
            guard.dispatched(JSONObject().put("type", action), null)
            guard.check(guard.target(tap(), original))
        }
    }

    @Test fun pointUsesSmallestClickableElementAndUnresolvedPointsAreUnguarded() {
        val guard = TapGuard()
        val parent = element("Container").put("bounds", JSONArray(listOf(0, 0, 999, 999)))
        val observation = screen(parent, element())
        val point = JSONObject("""{"type":"tap","x":0.15,"y":0.15}""")
        val target = guard.target(point, observation)
        assertEquals("Control 12", target!!.element.getString("name"))
        guard.dispatched(point, target)
        refused(guard, guard.target(tap(), screen(element())))
        assertNull(guard.target(point, screen()))
        val after = screen(element())
        guard.observe(after)
        assertFalse(after.getJSONObject("last_tap_effect").getBoolean("changed"))
    }

    @Test fun repeatIsRepairedBeforeApprovalOrDispatchAndExhaustsStepBudget() {
        var writes = 0
        var approvals = 0
        var calls = 0
        var reason = ""
        val host = object : LocalToolLoop.Host {
            override fun active() = reason.isEmpty()
            override fun observe() = screen(element())
            override fun approve(decision: ToolDecision, observation: JSONObject): Boolean { approvals++; return true }
            override fun execute(action: JSONObject): String { writes++; return "dispatched" }
            override fun finish(summary: String) { fail("unexpected finish") }
            override fun interrupt(value: String) { reason = value }
        }
        LocalToolLoop(host, { observation, turn ->
            calls++
            if (calls > 2) assertTrue(observation.getString("previous_error").contains(TapGuard.CODE))
            ToolDecision.parse(JSONObject().put("kind", "action").put("summary", "Tap control")
                .put("action", tap()), com.nova.nova_mobile.phone.PhoneTier.VIRTUAL)
        }).run()
        assertEquals(4, calls)
        assertEquals(1, writes)
        assertEquals(1, approvals)
        assertEquals("model_repeat_tap_same_element", reason)
    }
}
