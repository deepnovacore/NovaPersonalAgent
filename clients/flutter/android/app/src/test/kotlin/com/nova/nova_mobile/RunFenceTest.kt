package com.nova.nova_mobile

import org.junit.Assert.*
import org.junit.Test

class RunFenceTest {
    @Test fun stopWinsOverLateModelAndActionCallbacks() {
        val fence = RunFence("task", 1000, 10)
        val original = fence.token()
        assertTrue(fence.allows(original, 999))
        fence.stop()
        assertFalse(fence.allows(original, 999))
        assertFalse(fence.allows(fence.token(), 999))
    }
    @Test fun timeAndStepBudgetsPreventAnotherAction() {
        val fence = RunFence("task", 1000, 2)
        val token = fence.token()
        assertTrue(fence.claim(token, 900))
        assertTrue(fence.claim(token, 901))
        assertFalse(fence.claim(token, 902))
        assertFalse(RunFence("another", 1000, 2).allows(token, 900))
        assertFalse(RunFence("task", 1000, 2).allows(token, 1000))
    }
    @Test fun aNewExecutorCannotAcceptAnOldTokenForTheSameTask() {
        val old=RunFence("task",1000,2).token()
        assertFalse(RunFence("task",1000,2).allows(old,900))
    }
}
