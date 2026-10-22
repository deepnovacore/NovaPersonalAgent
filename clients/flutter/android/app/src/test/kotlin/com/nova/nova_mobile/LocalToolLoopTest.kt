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
        var captureAttempts = 0
        var transientAfterWrite = false
        var stopDuringCapture = false
        var observeError: Exception? = null
        var launchPendingCaptures = 0
        var throttledCaptures = 0
        var executeError: Exception? = null
        var stopDuringExecute = false
        val attemptedActions = mutableListOf<String>()
        var verified = false
        var interruption: String? = null
        override fun active() = active
        override fun observe(): JSONObject {
            captureAttempts++
            if(captureAttempts <= throttledCaptures) throw IllegalStateException("screenshot_unavailable_3")
            if(captureAttempts <= launchPendingCaptures) throw IllegalStateException("outside_target_app")
            if (transientAfterWrite && writes == 1 && observed == 1) {
                transientAfterWrite = false
                if (stopDuringCapture) active = false
                throw java.util.concurrent.ExecutionException(IllegalStateException("screen_changed_during_capture"))
            }
            observeError?.let { throw it }; return JSONObject().put("fingerprint", "frame-${++observed}") }
        override fun approve(decision: ToolDecision, observation: JSONObject) = accept
        override fun execute(action: JSONObject): String { attemptedActions.add(action.toString()); if(stopDuringExecute) active=false; executeError?.let { throw it }; writes++; return effect }
        override fun finish(summary: String) { verified = true; active = false }
        override fun interrupt(reason: String) { interruption = reason; active = false }
    }
    private fun action() = ToolDecision.parse(JSONObject("""{"kind":"action","summary":"Tap fixture","action":{"type":"tap","x":0.5,"y":0.4}}"""))
    @Test fun platformScreenshotThrottleRetriesOnlyObservation() {
        val host = Host().apply { throttledCaptures=1 }
        LocalToolLoop(host, { _, _ -> ToolDecision.parse(JSONObject("""{"kind":"complete","summary":"Target visible"}""")) }).run()
        assertEquals(2, host.captureAttempts)
        assertEquals(0, host.writes)
        assertTrue(host.verified)
    }
    @Test fun platformScreenshotThrottleHasABoundedBudget() {
        val host = Host().apply { throttledCaptures=99 }
        LocalToolLoop(host, { _, _ -> action() }).run()
        assertEquals(3, host.captureAttempts)
        assertEquals(0, host.writes)
        assertEquals("observation_screenshot_unavailable_3", host.interruption)
    }
    @Test fun initialLaunchWaitsForTargetWithoutSendingAnotherAppToModel() {
        val host = Host().apply { launchPendingCaptures=2 }
        var modelCalls=0
        LocalToolLoop(host, { _, _ -> modelCalls++; ToolDecision.parse(JSONObject("""{"kind":"complete","summary":"Target visible"}""")) }, initialLaunchGrace=true).run()
        assertEquals(3, host.captureAttempts)
        assertEquals(1, modelCalls)
        assertTrue(host.verified)
    }
    @Test fun launchWaitIsBoundedAndDoesNotPerformAnyAction() {
        val host = Host().apply { launchPendingCaptures=99 }
        LocalToolLoop(host, { _, _ -> action() }, initialLaunchGrace=true).run()
        assertEquals(6, host.captureAttempts)
        assertEquals(0, host.writes)
        assertEquals("observation_outside_target_app", host.interruption)
    }
    @Test fun leavingTargetAfterLaunchNeverGetsGraceRetries() {
        val host = Host()
        LocalToolLoop(host, { _, _ -> host.observeError=IllegalStateException("outside_target_app"); action() }, initialLaunchGrace=true).run()
        assertEquals(2, host.captureAttempts)
        assertEquals(1, host.writes)
        assertEquals("observation_outside_target_app", host.interruption)
    }
    private fun observeAgain() = ToolDecision.parse(JSONObject("""{"kind":"observe","summary":"Results are still loading"}"""))
    @Test fun loadingReobservesWithoutRepeatingTheSubmittedAction() {
        val host = Host()
        LocalToolLoop(host, { _, turn -> when(turn) {
            0 -> action()
            1 -> observeAgain()
            else -> ToolDecision.parse(JSONObject("""{"kind":"complete","summary":"Results visible"}"""))
        } }).run()
        assertEquals(1, host.writes)
        assertEquals(3, host.observed)
        assertTrue(host.verified)
    }
    @Test fun loadingObservationBudgetIsBounded() {
        val host = Host()
        LocalToolLoop(host, { _, _ -> observeAgain() }).run()
        assertEquals(4, host.observed)
        assertEquals(0, host.writes)
        assertEquals("model_observation_limit", host.interruption)
    }
    @Test fun userInputRequestStillPausesImmediately() {
        val host = Host()
        LocalToolLoop(host, { _, _ -> ToolDecision.parse(JSONObject("""{"kind":"wait","summary":"User login required"}""")) }).run()
        assertEquals(1, host.observed)
        assertEquals(0, host.writes)
        assertEquals("model_needs_user", host.interruption)
    }
    @Test fun stopWhileRequestingAnotherObservationCannotReadOrWriteAgain() {
        val host = Host()
        LocalToolLoop(host, { _, _ -> host.active=false; observeAgain() }).run()
        assertEquals(1, host.observed)
        assertEquals(0, host.writes)
        assertFalse(host.verified)
    }
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
    @Test fun authorizedTaskContinuesAcrossMultipleFreshObservations() {
        val host = Host()
        LocalToolLoop(host, { _, turn ->
            if (turn < 3) action() else ToolDecision.parse(JSONObject("""{"kind":"complete","summary":"Counter shows three"}"""))
        }).run()
        assertEquals(3, host.writes)
        assertEquals(4, host.observed)
        assertTrue(host.verified)
        assertNull(host.interruption)
    }
    @Test fun stalePreDispatchPlanIsReplacedUsingANewObservation() {
        val host = Host()
        val frames = mutableListOf<String>()
        LocalToolLoop(host, { observation, turn ->
            frames.add(observation.getString("fingerprint"))
            host.executeError = if(turn == 0) IllegalStateException("screen_changed") else null
            when(turn) {
                0 -> action()
                1 -> ToolDecision.parse(JSONObject("""{"kind":"action","summary":"Tap moved fixture","action":{"type":"tap","x":0.7,"y":0.6}}"""))
                else -> ToolDecision.parse(JSONObject("""{"kind":"complete","summary":"Visible result"}"""))
            }
        }).run()
        assertEquals(listOf("frame-1", "frame-2", "frame-3"), frames)
        assertEquals(1, host.writes)
        assertEquals(2, host.attemptedActions.size)
        assertNotEquals(host.attemptedActions[0], host.attemptedActions[1])
        assertTrue(host.verified)
    }
    @Test fun captureTransitionBeforeDispatchReplansWithoutReplayingAnAction() {
        val host = Host()
        val frames = mutableListOf<String>()
        LocalToolLoop(host, { observation, turn ->
            frames.add(observation.getString("fingerprint"))
            host.executeError = if(turn == 0) IllegalStateException("screen_changed_during_capture") else null
            when(turn) {
                0 -> action()
                1 -> ToolDecision.parse(JSONObject("""{"kind":"action","summary":"Tap moved fixture","action":{"type":"tap","x":0.7,"y":0.6}}"""))
                else -> ToolDecision.parse(JSONObject("""{"kind":"complete","summary":"Visible result"}"""))
            }
        }).run()
        assertEquals(listOf("frame-1", "frame-2", "frame-3"), frames)
        assertEquals(1, host.writes)
        assertEquals(2, host.attemptedActions.size)
        assertNotEquals(host.attemptedActions[0], host.attemptedActions[1])
        assertTrue(host.verified)
    }
    @Test fun successfulDispatchResetsConsecutiveStalePlanBudget() {
        val host = Host()
        LocalToolLoop(host, { _, turn ->
            host.executeError = if(turn in listOf(0,1,2,4,5,6)) IllegalStateException("screen_changed") else null
            if(turn < 8) action() else ToolDecision.parse(JSONObject("""{"kind":"complete","summary":"Two effects observed"}"""))
        }).run()
        assertEquals(2, host.writes)
        assertEquals(9, host.observed)
        assertTrue(host.verified)
    }
    @Test fun stopDuringStalePlanCannotTriggerReplanning() {
        val host = Host().apply { executeError=IllegalStateException("screen_changed");stopDuringExecute=true }
        LocalToolLoop(host, { _, _ -> action() }).run()
        assertEquals(1, host.observed)
        assertEquals(0, host.writes)
        assertFalse(host.verified)
    }
    @Test fun errorsAfterAttemptBoundaryNeverReplan() {
        val host = Host().apply { executeError=IllegalStateException("screen_changed_before_dispatch") }
        LocalToolLoop(host, { _, _ -> action() }).run()
        assertEquals(1, host.observed)
        assertEquals(0, host.writes)
        assertEquals("tool_screen_changed_before_dispatch", host.interruption)
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
    @Test fun transitionCaptureRetriesOnlyTheReadNeverTheDispatchedAction() {
        val host = Host().apply { transientAfterWrite = true }
        var calls = 0
        LocalToolLoop(host, { _, _ -> if(calls++ == 0) action() else ToolDecision.parse(JSONObject("""{"kind":"complete","summary":"New page observed"}""")) }).run()
        assertTrue(host.verified)
        assertEquals(1, host.writes)
        assertEquals(3, host.captureAttempts)
        assertEquals(2, calls)
    }
    @Test fun unstableCaptureIsBoundedAndCannotDispatch() {
        val host = Host().apply { observeError = IllegalStateException("screen_changed_during_capture") }
        LocalToolLoop(host, { _, _ -> action() }).run()
        assertEquals(3, host.captureAttempts)
        assertEquals(0, host.writes)
        assertFalse(host.verified)
    }
    @Test fun stopDuringCaptureCannotTriggerAnotherReadOrWrite() {
        val host = Host().apply { transientAfterWrite = true; stopDuringCapture = true }
        LocalToolLoop(host, { _, _ -> action() }).run()
        assertEquals(2, host.captureAttempts)
        assertEquals(1, host.writes)
        assertFalse(host.verified)
    }
    @Test fun unrelatedObservationFailureIsNeverRetried() {
        val host = Host().apply { observeError = IllegalStateException("screen_unavailable") }
        LocalToolLoop(host, { _, _ -> action() }).run()
        assertEquals(1, host.captureAttempts)
        assertEquals(0, host.writes)
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
    @Test fun repeatedPreDispatchScreenChangesStopAfterBoundedReplanning() {
        val host = Host().apply { executeError = java.util.concurrent.ExecutionException(IllegalStateException("screen_changed")) }
        LocalToolLoop(host, { _, _ -> action() }).run()
        assertEquals("tool_screen_changed", host.interruption)
        assertEquals(0, host.writes)
        assertEquals(4, host.observed)
        assertFalse(host.verified)
    }
    @Test fun screenshotFailureExposesOnlyTheNumericSystemCode() {
        for (message in listOf("screenshot_unavailable_3", "screenshot_unavailable_6", "screenshot_unavailable_3 private data")) {
            val host = Host().apply { observeError=IllegalStateException(message) }
            LocalToolLoop(host, { _, _ -> action() }).run()
            assertEquals(if(message.contains("private")) "observation_failed" else "observation_$message", host.interruption)
        }
    }
    @Test fun observationTimeoutIsReportedWithoutExceptionDetails() {
        val host = Host().apply { observeError=java.util.concurrent.TimeoutException("private content") }
        LocalToolLoop(host, { _, _ -> action() }).run()
        assertEquals("observation_timeout", host.interruption)
    }
    @Test fun observationFailureReportsOnlyAnAllowlistedCode() {
        val host = Host().apply { observeError = java.util.concurrent.ExecutionException(IllegalStateException("screen_changed_during_capture")) }
        LocalToolLoop(host, { _, _ -> action() }).run()
        assertEquals("observation_screen_changed_during_capture", host.interruption)
        assertEquals(0, host.writes)
    }
    @Test fun malformedModelJsonDoesNotExposeProviderResponse() {
        val host = Host()
        LocalToolLoop(host, { _, _ -> throw org.json.JSONException("secret provider output") }).run()
        assertEquals("model_invalid_response", host.interruption)
        assertEquals(0, host.writes)
    }
    @Test fun malformedDecisionReportsExactSafeCodeButNeverArbitraryText() {
        for (reason in listOf("unexpected_action", "invalid_coordinate", "invalid_coordinate secret")) {
            val host = Host()
            LocalToolLoop(host, { _, _ -> throw IllegalArgumentException(reason) }).run()
            assertEquals(if (reason.endsWith("secret")) "model_failed" else "model_$reason", host.interruption)
            assertEquals(0, host.writes)
        }
    }
    @Test fun unknownWrappedFailureNeverLeaksItsMessage() {
        val host = Host().apply { executeError = java.util.concurrent.ExecutionException(IllegalStateException("screen_changed secret content")) }
        LocalToolLoop(host, { _, _ -> action() }).run()
        assertEquals("tool_failed", host.interruption)
        assertEquals(0, host.writes)
    }

}
