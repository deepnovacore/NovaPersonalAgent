package com.nova.nova_mobile.phone

import org.junit.Assert.*
import android.content.SharedPreferences
import java.lang.reflect.Proxy
import com.nova.nova_mobile.phone.a11y.PHONE_EXPERIMENTAL_ACK
import com.nova.nova_mobile.phone.a11y.PHONE_PREFERENCES
import org.junit.Test
import com.nova.phone.core.shell.*

class PhoneBridgeTest {
    private fun status(failure: HelperFailure? = null) = PhoneStatus(
        34, PhoneTier.MAIN, false, false, false, true, PairingState.UNPAIRED, null,
        if (failure == null) HelperState.NOT_PAIRED else HelperState.FAILED, failure,
    )
    @Test fun statusUsesContractKeysAndOmitsAbsentOptionals() {
        val json = PhoneBridge.encodeStatus(status())
        assertEquals(setOf("schema_version", "api_level", "tier", "experimental", "experimental_ack", "accessibility", "overlay",
            "battery_whitelisted", "pairing", "helper", "notifications_allowed", "pairing_stage"), json.keys().asSequence().toSet())
        assertEquals(1, json.getInt("schema_version"))
        assertEquals("main", json.getString("tier"))
        assertEquals("not_paired", json.getString("helper"))
        assertTrue(json.getBoolean("battery_whitelisted"))
    }
    @Test fun experimentalFlagIsApiBasedAndTierRequiresAcknowledgement() {
        for (api in listOf(24, 30, 31, 32, 33, 34, 36)) for (ack in listOf(false, true)) {
            for (alive in listOf(false, true)) for (accessible in listOf(false, true)) {
                val status = PhoneBridge.projectStatus(api, accessible, alive, null, PairingDiscovery.Idle,
                    false, false, false, false, PairingStage.IDLE, ack)
                val json = PhoneBridge.encodeStatus(status)
                assertEquals(api in 31..33, json.getBoolean("experimental"))
                assertEquals(ack, json.getBoolean("experimental_ack"))
                assertEquals(if (api >= 31 && accessible && alive && (api >= 34 || ack)) "virtual" else "main",
                    json.getString("tier"))
            }
        }
    }
    @Test fun experimentalAckRoundTripsTheRunAdmissionPreference() {
        val values = mutableMapOf<String, Boolean>()
        val pending = mutableMapOf<String, Boolean>()
        val editor = Proxy.newProxyInstance(SharedPreferences.Editor::class.java.classLoader,
            arrayOf(SharedPreferences.Editor::class.java)) { proxy, method, args ->
            when (method.name) {
                "putBoolean" -> { pending[args[0] as String] = args[1] as Boolean; proxy }
                "apply" -> { values.putAll(pending); pending.clear(); null }
                else -> error("Unexpected editor method: ${method.name}")
            }
        } as SharedPreferences.Editor
        val prefs = Proxy.newProxyInstance(SharedPreferences::class.java.classLoader,
            arrayOf(SharedPreferences::class.java)) { _, method, args ->
            when (method.name) {
                "edit" -> editor
                "getBoolean" -> values[args[0] as String] ?: args[1]
                else -> error("Unexpected prefs method: ${method.name}")
            }
        } as SharedPreferences
        assertEquals("nova_phone", PHONE_PREFERENCES)
        assertEquals("phone.experimental_ack", PHONE_EXPERIMENTAL_ACK)
        assertFalse(prefs.getBoolean(PHONE_EXPERIMENTAL_ACK, false))
        for (ack in listOf(true, false)) {
            PhoneBridge.setExperimentalAck(prefs, ack)
            val read = prefs.getBoolean(PHONE_EXPERIMENTAL_ACK, false)
            assertEquals(ack, read)
            assertEquals(setOf(PHONE_EXPERIMENTAL_ACK), values.keys)
            val projected = PhoneBridge.projectStatus(33, true, true, null, PairingDiscovery.Idle,
                false, false, false, false, PairingStage.IDLE, read)
            assertEquals(ack, PhoneBridge.encodeStatus(projected).getBoolean("experimental_ack"))
            assertEquals(if (ack) PhoneTier.VIRTUAL else PhoneTier.MAIN, projected.tier)
        }
    }
    @Test fun roundFourErrorsPassThroughWithoutLeakingOtherMessages() {
        listOf("run_active", "task_not_running", "no_takeover", "takeover_on_main_thread", "takeover_unavailable",
            "accessibility_flags_failed", "accessibility_unavailable", "helper_unavailable", "display_unavailable",
            "invalid_acknowledged").forEach { code ->
            assertEquals(code, PhoneBridge.safeError(IllegalStateException(code)))
        }
        assertEquals("unknown", PhoneBridge.safeError(IllegalStateException("private screen content")))
        assertEquals("unknown", PhoneBridge.safeError(IllegalStateException()))
    }
    @Test fun runningHelperSurvivesRepairFailureWithoutHidingFailure() {
        val status = PhoneBridge.projectStatus(34, true, true,
            BuiltinShellStatus.Failed(BuiltinShellFailure.WrongCode), PairingDiscovery.Found(37123),
            true, true, true, false, PairingStage.FAILED)
        val json = PhoneBridge.encodeStatus(status)
        assertEquals("running", json.getString("helper"))
        assertEquals("virtual", json.getString("tier"))
        assertEquals("wrong_code", json.getString("helper_failure"))
        assertEquals("re_pair", json.getString("helper_fix"))
        assertEquals("failed", json.getString("pairing_stage"))
        assertFalse(json.getBoolean("notifications_allowed"))
    }
    @Test fun everyPairingStageEncodes() {
        PairingStage.entries.forEach { stage ->
            assertEquals(stage.wire, PhoneBridge.encodeStatus(status().copy(pairingStage = stage)).getString("pairing_stage"))
        }
    }
    @Test fun everyFailureEncodesItsContractFix() {
        HelperFailure.entries.forEach {
            val json = PhoneBridge.encodeStatus(status(it))
            assertEquals(it.wire, json.getString("helper_failure"))
            assertEquals(it.fix.wire, json.getString("helper_fix"))
        }
    }
    @Test fun experimentalVirtualAndPairingPortArePreserved() {
        val json = PhoneBridge.encodeStatus(status().copy(apiLevel = 31, tier = PhoneTier.VIRTUAL,
            experimental = true, helper = HelperState.RUNNING, pairing = PairingState.SEARCHING, pairingPort = 37123))
        assertEquals("virtual", json.getString("tier"))
        assertTrue(json.getBoolean("experimental"))
        assertEquals(37123, json.getInt("pairing_port"))
    }
    @Test fun experimentalAckArgumentIsABooleanOrInvalid() {
        assertTrue(PhoneBridge.acknowledgedArgument(org.json.JSONObject("{\"acknowledged\":true}")))
        assertFalse(PhoneBridge.acknowledgedArgument(org.json.JSONObject("{\"acknowledged\":false}")))
        for (raw in listOf("{}", "{\"acknowledged\":\"yes\"}", "{\"acknowledged\":null}")) {
            val error = assertThrows(IllegalArgumentException::class.java) { PhoneBridge.acknowledgedArgument(org.json.JSONObject(raw)) }
            assertEquals("invalid_acknowledged", PhoneBridge.safeError(error))
        }
    }
}
