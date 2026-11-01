package com.nova.nova_mobile.phone

import org.junit.Assert.*
import org.junit.Test
import com.nova.phone.core.shell.*

class PhoneBridgeTest {
    private fun status(failure: HelperFailure? = null) = PhoneStatus(
        34, PhoneTier.MAIN, false, false, false, true, PairingState.UNPAIRED, null,
        if (failure == null) HelperState.NOT_PAIRED else HelperState.FAILED, failure,
    )
    @Test fun statusUsesContractKeysAndOmitsAbsentOptionals() {
        val json = PhoneBridge.encodeStatus(status())
        assertEquals(setOf("schema_version", "api_level", "tier", "experimental", "accessibility", "overlay",
            "battery_whitelisted", "pairing", "helper", "notifications_allowed", "pairing_stage"), json.keys().asSequence().toSet())
        assertEquals(1, json.getInt("schema_version"))
        assertEquals("main", json.getString("tier"))
        assertEquals("not_paired", json.getString("helper"))
        assertTrue(json.getBoolean("battery_whitelisted"))
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
}
