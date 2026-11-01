package com.nova.nova_mobile.phone

import com.nova.nova_mobile.taskWithTier
import com.nova.phone.core.shell.PairingStage
import java.io.File
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Native half of the shared wire fixture `clients/flutter/test/fixtures/phone_wire_contract.json`; the Dart half is
 * `test/phone_wire_contract_test.dart`. Both sides are checked against the same file.
 */
class PhoneWireContractTest {
    private val fixture: JSONObject by lazy {
        var dir: File? = File(".").absoluteFile
        while (dir != null) {
            val candidate = File(dir, "test/fixtures/phone_wire_contract.json")
            if (candidate.isFile) return@lazy JSONObject(candidate.readText())
            dir = dir.parentFile
        }
        error("phone_wire_contract.json not found above ${File(".").absolutePath}")
    }

    // android.jar's org.json (the compile classpath) has no similar().
    private fun same(expected: Any?, actual: Any?): Boolean = when (expected) {
        is JSONObject -> actual is JSONObject && expected.keys().asSequence().toSet() == actual.keys().asSequence().toSet() &&
            expected.keys().asSequence().all { same(expected.get(it), actual.get(it)) }
        is JSONArray -> actual is JSONArray && expected.length() == actual.length() &&
            (0 until expected.length()).all { same(expected.get(it), actual.get(it)) }
        is Number -> actual is Number && expected.toDouble() == actual.toDouble()
        else -> expected == actual
    }

    private fun assertSameJson(expected: JSONObject, actual: JSONObject) =
        assertTrue("expected $expected\n  actual $actual", same(expected, actual))

    private fun strings(array: JSONArray) = (0 until array.length()).map { array.getString(it) }.toSet()
    private fun enum(name: String) = strings(fixture.getJSONObject("enums").getJSONArray(name))

    @Test fun statusEncodingMatchesTheFixture() {
        val status = PhoneStatus(33, PhoneTier.VIRTUAL, true, true, false, true, PairingState.PAIRED, 37123,
            HelperState.RUNNING, HelperFailure.WRONG_CODE, notificationsAllowed = true, pairingStage = PairingStage.DONE,
            experimentalAck = true)
        assertSameJson(fixture.getJSONObject("status"), PhoneBridge.encodeStatus(status))
    }

    @Test fun eventEncodingMatchesTheFixture() {
        val events = fixture.getJSONObject("events")
        assertSameJson(events.getJSONObject("step"),
            PhoneStepEvent("task-1", 2, "tap", "Open search", StepStatus.COMPLETED, true, "@e4", PhoneTier.VIRTUAL).toJson())
        assertSameJson(events.getJSONObject("takeover"),
            PhoneTakeoverEvent("task-1", TakeoverState.TIMED_OUT, byModel = false, reason = "secure_page").toJson())
        assertSameJson(events.getJSONObject("done"),
            PhoneDoneEvent("task-1", DoneOutcome.INTERRUPTED, "tool_ref_expired", "Stopped", 5, 1234).toJson())
        assertEquals(events.getJSONObject("status").getString("type"), PhoneEventType.STATUS.wire)
    }

    @Test fun selfCheckEncodingAndIdsMatchTheFixture() {
        assertSameJson(fixture.getJSONObject("self_check"), PhoneBridge.encodeSelfCheck(listOf(
            SelfCheckItem("helper", true, null), SelfCheckItem("main_focus", false, "shared_focus"))))
        assertEquals(fixture.getJSONArray("self_check_ids").let { a -> (0 until a.length()).map { a.getString(it) } },
            VirtualSelfCheck.IDS)
    }

    @Test fun enumWiresMatchTheFixture() {
        assertEquals(enum("tier"), PhoneTier.entries.map { it.wire }.toSet())
        assertEquals(enum("pairing"), PairingState.entries.map { it.wire }.toSet())
        assertEquals(enum("pairing_stage"), PairingStage.entries.map { it.wire }.toSet())
        assertEquals(enum("helper"), HelperState.entries.map { it.wire }.toSet())
        assertEquals(enum("helper_failure"), HelperFailure.entries.map { it.wire }.toSet())
        assertEquals(enum("helper_fix"), HelperFix.entries.map { it.wire }.toSet())
        assertEquals(enum("settings_kind"), SettingsKind.entries.map { it.wire }.toSet())
        assertEquals(enum("takeover_state"), TakeoverState.entries.map { it.wire }.toSet())
        assertEquals(enum("step_status"), StepStatus.entries.map { it.wire }.toSet())
        assertEquals(enum("done_outcome"), DoneOutcome.entries.map { it.wire }.toSet())
    }

    @Test fun safeErrorsMatchTheFixture() {
        assertEquals(strings(fixture.getJSONArray("safe_errors")), PhoneBridge.SAFE_ERRORS)
    }

    @Test fun methodArgumentsParseAsTheDartClientSendsThem() {
        val methods = fixture.getJSONObject("methods")
        for (kind in enum("settings_kind")) assertEquals(kind, PhoneBridge.settingsKind(kind).wire)
        assertEquals(SettingsKind.WIRELESS_DEBUGGING, PhoneBridge.settingsKind(methods.getJSONObject("openSettings").getString("kind")))
        assertTrue(PhoneBridge.acknowledgedArgument(methods.getJSONObject("setExperimentalAck")))
        assertEquals("task-1", methods.getJSONObject("takeover").getString("task_id"))
        assertEquals("task-1", methods.getJSONObject("handBack").getString("task_id"))
        assertEquals("task-1", methods.getJSONObject("stop").getString("id"))
        assertEquals(true, methods.getJSONObject("setPreview").opt("visible"))
        assertEquals("invalid_settings", PhoneBridge.safeError(
            runCatching { PhoneBridge.settingsKind("") }.exceptionOrNull() as Exception))
    }

    @Test fun tasksCarryTheirTierAndLegacyRecordsAreMain() {
        val tasks = fixture.getJSONArray("tasks")
        for (i in 0 until tasks.length()) {
            val task = tasks.getJSONObject(i)
            assertEquals(task.getString("tier"), taskWithTier(JSONObject(task.toString())).getString("tier"))
        }
        assertEquals("main", taskWithTier(JSONObject().put("id", "legacy").put("phase", "running")).getString("tier"))
        assertEquals("virtual", taskWithTier(JSONObject().put("id", "new"), PhoneTier.VIRTUAL).getString("tier"))
    }
}
