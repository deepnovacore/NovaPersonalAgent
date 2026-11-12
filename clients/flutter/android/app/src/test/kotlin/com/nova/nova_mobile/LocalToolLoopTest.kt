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
        var missingCaptures = 0
        var executeError: Exception? = null
        var afterDispatchError: Exception? = null
        var stopDuringExecute = false
        val attemptedActions = mutableListOf<String>()
        var verified = false
        var screenForObservation: ((Int) -> JSONObject)? = null
        var interruption: String? = null
        override fun active() = active
        override fun observe(): JSONObject {
            captureAttempts++
            if(captureAttempts <= missingCaptures) throw java.util.concurrent.ExecutionException(IllegalStateException("screen_unavailable"))
            if(captureAttempts <= throttledCaptures) throw IllegalStateException("screenshot_unavailable_3")
            if(captureAttempts <= launchPendingCaptures) throw IllegalStateException("outside_target_app")
            if (transientAfterWrite && writes == 1 && observed == 1) {
                transientAfterWrite = false
                if (stopDuringCapture) active = false
                throw java.util.concurrent.ExecutionException(IllegalStateException("screen_changed_during_capture"))
            }
            observeError?.let { throw it }; observed++; return screenForObservation?.invoke(observed) ?: JSONObject().put("fingerprint", "frame-$observed") }
        override fun approve(decision: ToolDecision, observation: JSONObject) = accept
        override fun execute(action: JSONObject): String { attemptedActions.add(action.toString()); if(stopDuringExecute) active=false; executeError?.let { throw it }; writes++; afterDispatchError?.let { throw it }; return effect }
        override fun finish(summary: String) { verified = true; active = false }
        override fun interrupt(reason: String) { interruption = reason; active = false }
    }
    private fun action() = ToolDecision.parse(JSONObject("""{"kind":"action","summary":"Tap fixture","action":{"type":"tap","x":0.5,"y":0.4}}"""))
    private fun invalidAction(): ToolDecision = ToolDecision.parse(JSONObject("""{"kind":"action","summary":"Bad fields","action":{"type":"back","text":"extra"}}"""))

    @Test fun traceCarriesOnlyEnumsCountersAndFlags() {
        val host = Host()
        host.screenForObservation = { JSONObject().put("package", "private.app").put("secure_frame", true)
            .put("elements", org.json.JSONArray().put(JSONObject().put("name", "private text").put("bounds", org.json.JSONArray(listOf(0, 0, 10, 10))))) }
        val lines = mutableListOf<String>()
        LocalToolLoop(host, { _, _ -> action() }, maxTurns = 1) { lines.add(it) }.run()
        assertEquals(listOf("step=0 kind=action action=tap elements=1 secure_frame=true dark_region=false progress_warned=false repairs=0"), lines)
    }

    @Test fun repairUsesSameObservationAndTurnWithoutExtraDispatchOrBudget() {
        val host = Host()
        val observations = mutableListOf<JSONObject>()
        val turns = mutableListOf<Int>()
        LocalToolLoop(host, { observation, turn ->
            observations.add(observation)
            turns.add(turn)
            if(observations.size == 1) invalidAction() else {
                assertTrue(observation.getString("previous_error").contains("invalid_action_fields"))
                action()
            }
        }, maxTurns = 1).run()
        assertEquals(listOf(0, 0), turns)
        assertSame(observations[0], observations[1])
        assertEquals(1, host.observed)
        assertEquals(1, host.writes)
        assertEquals(1, host.attemptedActions.size)
        assertEquals("step_limit", host.interruption)
    }

    @Test fun threeInvalidDecisionsKeepExistingFailureCode() {
        val host = Host()
        var calls = 0
        LocalToolLoop(host, { _, _ -> calls++; invalidAction() }).run()
        assertEquals(3, calls)
        assertEquals(1, host.observed)
        assertEquals(0, host.writes)
        assertEquals("model_invalid_action_fields", host.interruption)
    }

    @Test fun repairBudgetIsSharedAcrossStepsAndNeverRepeatsPriorEffects() {
        val host = Host()
        val calls = mutableMapOf<Int, Int>()
        LocalToolLoop(host, { observation, turn ->
            val attempt = calls.getOrDefault(turn, 0) + 1
            calls[turn] = attempt
            if(attempt == 1) assertFalse(observation.has("previous_error"))
            if(attempt < 3) invalidAction() else action()
        }).run()
        assertEquals(mapOf(0 to 3, 1 to 3, 2 to 3, 3 to 1), calls)
        assertEquals(4, host.observed)
        assertEquals(3, host.writes)
        assertEquals(3, host.attemptedActions.size)
        assertEquals("model_invalid_action_fields", host.interruption)
    }

    @Test fun modelShapedErrorFromExecutionNeverRetries() {
        val host = Host().apply { afterDispatchError = IllegalArgumentException("invalid_action_fields") }
        var calls = 0
        LocalToolLoop(host, { _, _ -> calls++; action() }).run()
        assertEquals(1, calls)
        assertEquals(1, host.attemptedActions.size)
        assertEquals(1, host.writes)
        assertEquals("tool_failed", host.interruption)
    }

    @Test fun cancellationDuringRejectedDecisionDoesNotRepair() {
        val host = Host()
        var calls = 0
        LocalToolLoop(host, { _, _ -> calls++; host.active = false; invalidAction() }).run()
        assertEquals(1, calls)
        assertEquals(0, host.writes)
        assertNull(host.interruption)
    }

    @Test fun jsonAndBoundedResponseErrorsCanBeRepairedWithoutLeakingDetails() {
        for(error in listOf(org.json.JSONException("secret response"), IllegalStateException("invalid_model_response"))) {
            val host = Host()
            var calls = 0
            LocalToolLoop(host, { observation, _ ->
                if(calls++ == 0) throw java.util.concurrent.ExecutionException(error)
                assertFalse(observation.getString("previous_error").contains("secret"))
                ToolDecision.parse(JSONObject("""{"kind":"complete","summary":"Target visible"}"""))
            }).run()
            assertEquals(2, calls)
            assertEquals(1, host.observed)
            assertTrue(host.verified)
        }
    }
    @Test fun oscillationNoteReachesModelBeforeGuardStopsFurtherEffects() {
        val host = Host().apply { screenForObservation = { n -> JSONObject().put("package", "test.app").put("tree", if(n % 2 == 1) "list" else "video") } }
        val notes = mutableListOf<String>()
        LocalToolLoop(host, { observation, turn ->
            notes.add(observation.getString("progress_note"))
            if(turn % 2 == 0) action() else ToolDecision.parse(JSONObject("""{"kind":"action","summary":"Return","action":{"type":"back"}}"""))
        }).run()
        assertTrue(notes.take(4).all { it.isEmpty() })
        assertTrue(notes[4].contains("3 times"))
        assertEquals(6, host.writes)
        assertEquals(6, notes.size)
        assertEquals("no_progress", host.interruption)
        assertFalse(host.verified)
    }
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
    @Test fun missingScreenRetriesAreBoundedWithoutEffects() {
        val host = Host().apply { observeError = IllegalStateException("screen_unavailable") }
        LocalToolLoop(host, { _, _ -> action() }).run()
        assertEquals(4, host.captureAttempts)
        assertEquals(0, host.writes)
        assertEquals("observation_screen_unavailable", host.interruption)
    }
    @Test fun missingFirstFrameRecoversBeforePlanningAnyEffect() {
        val host = Host().apply { missingCaptures = 2 }
        LocalToolLoop(host, { _, _ -> ToolDecision.parse(JSONObject("""{"kind":"complete","summary":"Target visible"}""")) }).run()
        assertEquals(3, host.captureAttempts)
        assertEquals(0, host.writes)
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
    @Test fun modelFailureAfterDispatchDoesNotProveTheRunWasReadOnly() {
        val host = Host()
        LocalToolLoop(host, { _, turn -> if(turn == 0) action() else throw java.net.SocketTimeoutException("after effect") }).run()
        assertEquals(1, host.writes)
        assertEquals("model_timeout", host.interruption)
        assertFalse(host.verified)
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
    private fun tapRef(ref: String) = ToolDecision.parse(JSONObject("""{"kind":"action","summary":"Tap result","action":{"type":"tap","ref":"$ref","snapshot_id":"ph-1"}}"""), com.nova.nova_mobile.phone.PhoneTier.VIRTUAL)
    @Test fun expiredRefReobservesAndAsksTheModelWithoutRetryingTheAction() {
        val host = Host()
        val frames = mutableListOf<String>()
        LocalToolLoop(host, { observation, turn ->
            frames.add(observation.getString("fingerprint"))
            host.executeError = if(turn == 0) IllegalStateException("ref_expired") else null
            when(turn) {
                0 -> tapRef("@e3")
                1 -> tapRef("@e4")
                else -> ToolDecision.parse(JSONObject("""{"kind":"complete","summary":"Visible result"}"""))
            }
        }).run()
        assertEquals(listOf("frame-1", "frame-2", "frame-3"), frames)
        assertEquals(1, host.writes)
        assertEquals(2, host.attemptedActions.size)
        assertTrue(host.attemptedActions[0].contains("@e3") && host.attemptedActions[1].contains("@e4"))
        assertTrue(host.verified)
    }
    @Test fun expiredRefsShareTheStalePlanBudget() {
        val host = Host()
        LocalToolLoop(host, { _, turn ->
            host.executeError = IllegalStateException(if(turn == 1) "screen_changed" else "ref_expired")
            tapRef("@e1")
        }).run()
        assertEquals("tool_ref_expired", host.interruption)
        assertEquals(0, host.writes)
        assertEquals(4, host.observed)
    }
    @Test fun virtualExecutionCodesAreReportedWithTheirStage() {
        for (code in listOf("ref_not_editable", "ref_not_scrollable", "app_not_allowed", "app_in_use_on_main", "display_unavailable",
            "helper_unavailable", "takeover_unavailable", "takeover_timeout", "private_input_requires_user", "no_focused_input")) {
            val host = Host().apply { executeError = IllegalStateException(code) }
            LocalToolLoop(host, { _, _ -> tapRef("@e1") }).run()
            assertEquals("tool_$code", host.interruption)
            assertEquals(0, host.writes)
        }
        val host = Host().apply { observeError = IllegalStateException("helper_unavailable") }
        LocalToolLoop(host, { _, _ -> tapRef("@e1") }).run()
        assertEquals("observation_helper_unavailable", host.interruption)
    }
    @Test fun virtualParseCodesAreReportedAsModelCodes() {
        for (code in listOf("invalid_ref", "invalid_snapshot_id", "invalid_direction", "invalid_package", "invalid_reason")) {
            val host = Host()
            LocalToolLoop(host, { _, _ -> throw IllegalArgumentException(code) }).run()
            assertEquals("model_$code", host.interruption)
        }
    }
}
