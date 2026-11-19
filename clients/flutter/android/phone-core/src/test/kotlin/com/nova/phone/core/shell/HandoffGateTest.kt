// Derived from Mika (https://github.com/wangzan101/Mika, Apache-2.0, commit 5f630d9),
// Copyright 2026 wangzan101. Modified by Nova: extract and test ordered credential handoff.
package com.nova.phone.core.shell

import org.junit.Assert.*
import org.junit.Test

class HandoffGateTest {
    private val calls = mutableListOf<String>()
    private fun offer(reject: HelperHandoff.Reject? = null, matches: Boolean = true, identity: Boolean = true, next: String? = "next") =
        HandoffGate.offer(
            check = { calls += "check"; reject },
            matches = { calls += "matches"; matches },
            identity = { calls += "identity"; identity },
            accept = { calls += "accept"; next },
        )
    @Test fun identityPrecedesCredentialConsumption() {
        assertEquals(HandoffGate.Result.Accepted("next"), offer())
        assertEquals(listOf("check", "matches", "identity", "accept"), calls)
    }
    @Test fun binderElsewhereCannotConsumeCredential() {
        assertEquals(HandoffGate.Result.Rejected(HelperHandoff.Reject.BinderElsewhere), offer(identity = false))
        assertEquals(listOf("check", "matches", "identity"), calls)
    }
    @Test fun badNonceCannotContactBinder() {
        assertEquals(HandoffGate.Result.Rejected(HelperHandoff.Reject.BadNonce), offer(matches = false))
        assertEquals(listOf("check", "matches"), calls)
    }
    @Test fun rejectedCallerCannotCheckNonceOrContactBinder() {
        for (reason in listOf(HelperHandoff.Reject.NotShell, HelperHandoff.Reject.IdMismatch, HelperHandoff.Reject.StaleApk, HelperHandoff.Reject.NoBinder)) {
            calls.clear()
            assertEquals(HandoffGate.Result.Rejected(reason), offer(reject = reason))
            assertEquals(listOf("check"), calls)
        }
    }
    @Test fun failedRotationCannotAccept() {
        assertEquals(HandoffGate.Result.Rejected(HelperHandoff.Reject.BadNonce), offer(next = null))
    }
}
