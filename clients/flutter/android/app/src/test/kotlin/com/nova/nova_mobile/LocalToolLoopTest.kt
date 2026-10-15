package com.nova.nova_mobile

import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

class LocalToolLoopTest {
    private class Host : LocalToolLoop.Host {
        var active = true
        var accept = true
        var effect = "dispatched"
        var writes = 0
        var observed = 0
        var verified = false
        var interruption: String? = null
        override fun active() = active
        override fun observe() = JSONObject().put("fingerprint", "frame-${++observed}")
        override fun approve(decision: ToolDecision, observation: JSONObject) = accept
        override fun execute(action: JSONObject): String { writes++; return effect }
        override fun finish(summary: String) { verified = true; active = false }
        override fun interrupt(reason: String) { interruption = reason; active = false }
    }
    private fun action() = ToolDecision.parse(JSONObject("""{"kind":"action","summary":"Tap fixture","action":{"type":"tap","x":0.5,"y":0.4}}"""))
    @Test fun lateModelReplyAfterStopCannotRequestOrDispatchAnAction() {
        val host = Host()
        LocalToolLoop(host, { _, _ -> host.active = false; action() }).run()
        assertEquals(0, host.writes)
        assertFalse(host.verified)
    }
    @Test fun rejectedApprovalDoesNotProduceAnyDeviceEffect() {
        val host = Host().apply { accept = false }
        LocalToolLoop(host, { _, _ -> action() }).run()
        assertEquals(0, host.writes)
        assertEquals("approval_declined", host.interruption)
    }
    @Test fun unknownEffectNeverGetsRetriedOrReportedComplete() {
        val host = Host().apply { effect = "unknown" }
        LocalToolLoop(host, { _, _ -> action() }).run()
        assertEquals(1, host.writes)
        assertEquals("action_outcome_unknown", host.interruption)
        assertFalse(host.verified)
    }
    @Test fun actionBudgetPreventsAnotherModelDrivenWrite() {
        val host = Host()
        LocalToolLoop(host, { _, _ -> action() }, maxTurns = 2).run()
        assertEquals(2, host.writes)
        assertEquals("step_limit", host.interruption)
    }
    @Test fun completionIsProposedOnlyAfterANewObservation() {
        val host = Host()
        var calls = 0
        LocalToolLoop(host, { _, _ -> if(calls++ == 0) action() else ToolDecision.parse(JSONObject("""{"kind":"complete","summary":"Counter shows one"}""")) }).run()
        assertEquals(1, host.writes)
        assertEquals(2, host.observed)
        assertTrue(host.verified)
    }
    @Test fun malformedOrExpandedModelActionsFailClosed() {
        for (value in listOf(
            """{"kind":"action","summary":"bad","action":{"type":"tap","x":2,"y":0}}""",
            """{"kind":"action","summary":"bad","action":{"type":"type","text":"hello","submit":true}}""",
            """{"kind":"action","summary":"bad","action":{"type":"shell","command":"echo bad"}}""",
            """{"kind":"complete","summary":"bad","action":{"type":"tap","x":0,"y":0}}"""
        )) {
            try { ToolDecision.parse(JSONObject(value)); fail("unsafe decision accepted") }
            catch (_: IllegalArgumentException) { }
        }
    }
    @Test fun networkFailureReportsSafeCategoryWithoutProviderDetails() {
        val host = Host()
        LocalToolLoop(host, { _, _ -> throw java.net.UnknownHostException("private endpoint and secret") }).run()
        assertEquals("model_dns_failed", host.interruption)
        assertEquals(0, host.writes)
    }
    @Test fun unexpectedProviderFailureNeverCopiesItsMessage() {
        val host = Host()
        LocalToolLoop(host, { _, _ -> throw IllegalStateException("private provider response") }).run()
        assertEquals("model_failed", host.interruption)
    }
    @Test fun providerRejectionReportsOnlyHttpStatus() {
        val host = Host()
        LocalToolLoop(host, { _, _ -> throw ModelHttpException(403) }).run()
        assertEquals("model_http_403", host.interruption)
    }
}
