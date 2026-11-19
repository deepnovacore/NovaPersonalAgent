// Derived from Mika (https://github.com/wangzan101/Mika, Apache-2.0, commit 5f630d9),
// Copyright 2026 wangzan101. Modified by Nova: test only production setup projections.
package com.nova.phone.core.shell

import org.junit.Assert.assertEquals
import org.junit.Test

class PhoneSetupFlowTest {
    @Test fun stagesCoverTheWireContract() {
        fun stage(s: BuiltinShellStatus, d: PairingDiscovery = PairingDiscovery.Idle, repair: Boolean = false, exchange: Boolean = false) =
            PhoneSetupFlow.stage(s, d, repair, exchange)
        assertEquals(PairingStage.IDLE, stage(BuiltinShellStatus.NotPaired))
        assertEquals(PairingStage.WAITING_CODE, stage(BuiltinShellStatus.NotPaired, PairingDiscovery.Searching))
        assertEquals(PairingStage.WAITING_CODE, stage(BuiltinShellStatus.Running, repair = true))
        assertEquals(PairingStage.PAIRING, stage(BuiltinShellStatus.Connecting, repair = true, exchange = true))
        assertEquals(PairingStage.CONNECTING, stage(BuiltinShellStatus.Connecting))
        assertEquals(PairingStage.DONE, stage(BuiltinShellStatus.Running))
        assertEquals(PairingStage.FAILED, stage(BuiltinShellStatus.Failed(BuiltinShellFailure.WrongCode)))
    }
    @Test fun repairDoesNotTreatTheOldHelperAsSuccess() {
        assertEquals(BuiltinShellStatus.NotPaired, PhoneSetupFlow.effectiveStatus(BuiltinShellStatus.Running, true))
        assertEquals(BuiltinShellStatus.Connecting, PhoneSetupFlow.effectiveStatus(BuiltinShellStatus.Connecting, true))
        assertEquals(BuiltinShellStatus.Running, PhoneSetupFlow.effectiveStatus(BuiltinShellStatus.Running, false))
    }
}
