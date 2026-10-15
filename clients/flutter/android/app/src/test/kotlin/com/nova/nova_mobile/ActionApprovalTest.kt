package com.nova.nova_mobile

import org.junit.Assert.*
import org.junit.Test

class ActionApprovalTest {
    @Test fun aStaleOrReusedApprovalCannotAuthorizeAnotherAction() {
        val approval = ActionApproval("one", "tap-one", "screen-one", 100)
        assertFalse(approval.resolve("other", true, 10))
        assertTrue(approval.resolve("one", true, 10))
        assertFalse(approval.consume("tap-two", "screen-one", 11))
        assertFalse(approval.consume("tap-one", "screen-two", 11))
        assertTrue(approval.consume("tap-one", "screen-one", 11))
        assertFalse(approval.consume("tap-one", "screen-one", 11))
    }
    @Test fun cancellationWinsOverAnAlreadyReceivedApproval() {
        val approval = ActionApproval("one", "tap", "screen", 100)
        approval.resolve("one",true,1)
        approval.cancel()
        assertFalse(approval.consume("tap","screen",2))
    }
    @Test fun expirationDoesNotBecomePermission() {
        val approval = ActionApproval("one", "tap", "screen", 100)
        assertFalse(approval.resolve("one",true,100))
        assertFalse(approval.consume("tap","screen",100))
    }
}
