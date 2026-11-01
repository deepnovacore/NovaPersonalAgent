package com.nova.nova_mobile.phone.a11y

import com.nova.nova_mobile.LocalToolLoop
import com.nova.nova_mobile.ToolDecision
import com.nova.nova_mobile.phone.PhoneAction
import com.nova.nova_mobile.phone.PhoneSnapshot
import com.nova.nova_mobile.phone.PhoneTier
import com.nova.nova_mobile.phone.RunTakeover
import com.nova.nova_mobile.phone.TakeoverPort
import com.nova.nova_mobile.phone.TakeoverState
import com.nova.nova_mobile.phone.UiElement
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test
import java.util.concurrent.CompletableFuture
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

class VirtualRunHostTest {
    private val target = "com.example.shop"

    private class Device(var foreground: String?) : VirtualDevice {
        var snapshots = 0
        var forgotten = 0
        var prepareError: Exception? = null
        var dispatchError: Exception? = null
        var outcome = "dispatched"
        val dispatched = mutableListOf<String>()
        override fun topPackage() = foreground
        var snapshotError: (() -> Exception)? = null
        override fun snapshot() = snapshotError?.let { error -> snapshotError = null; throw error() } ?: PhoneSnapshot("ph-${++snapshots}", foreground, 1080, 2400,
            listOf(UiElement("@e1", "EditText", "Search", listOf(0, 0, 999, 100), "search", false, true, false, false, false)),
            "YWJj", false, false)
        override fun prepare(action: PhoneAction): PreparedAction {
            prepareError?.let { throw it }
            return when (action) {
                is PhoneAction.TapRef -> PreparedAction("tap", action.ref, "Search")
                is PhoneAction.Type -> PreparedAction("type", action.ref, "Search")
                is PhoneAction.OpenApp -> PreparedAction("open_app", null, action.packageName)
                else -> PreparedAction("back", null, null)
            }
        }
        /** Runs between preparation and the effect (a tree traversal on a device): races are staged here. */
        var beforeEffect: (() -> Unit)? = null
        /** Runs inside the admitted effect. */
        var duringEffect: (() -> Unit)? = null
        override fun dispatch(prepared: PreparedAction, effects: EffectAdmission): DispatchResult {
            beforeEffect?.invoke()
            effects.admit {
                dispatched += prepared.tool
                duringEffect?.invoke()
                dispatchError?.let { throw it }
            }
            return DispatchResult(outcome, true)
        }
        override fun forgetRefs() { forgotten++ }
    }

    private class Gate : VirtualRunGate {
        var active = true
        val approvals = mutableListOf<String>()
        val begun = mutableListOf<Pair<String, String?>>()
        val finished = mutableListOf<Pair<String, String>>()
        var completed: String? = null
        var interruption: String? = null
        override fun active() = active
        override fun approve(action: JSONObject, evidence: String): Boolean { approvals += evidence; return true }
        override fun begin(attemptId: String, action: JSONObject, evidence: String?) { begun += attemptId to evidence }
        override fun finish(attemptId: String, action: JSONObject, outcome: String, evidence: String?) { finished += attemptId to outcome }
        override fun complete(summary: String, evidence: String) { completed = evidence; active = false }
        override fun interrupt(reason: String) { interruption = reason; active = false }
    }

    private class Port(var top: Int = 5, var toMain: Boolean = true) : TakeoverPort {
        val moves = mutableListOf<String>()
        override fun topTask() = top
        override fun moveToMain(taskId: Int): Boolean { moves += "main"; return toMain }
        override fun moveBack(taskId: Int): Boolean { moves += "back"; return true }
        override fun paused(paused: Boolean) {}
    }

    private val events = mutableListOf<JSONObject>()
    private var ids = 0
    private fun host(device: Device, gate: Gate, takeover: RunTakeover) =
        VirtualRunHost("t1", VirtualScope(target, "com.nova.app", "com.example.ime"), device, takeover, gate, { events += it }, { "a${++ids}" })
    private fun takeover(port: Port = Port()) = RunTakeover("t1", port, {}, System::currentTimeMillis)
    private fun decision(action: String) = ToolDecision.parse(JSONObject("""{"kind":"action","summary":"Do it","action":$action}"""), PhoneTier.VIRTUAL)
    private fun steps() = events.filter { it.getString("type") == "step" }.map { "${it.getInt("step")}:${it.getString("tool")}:${it.getString("status")}" }

    @Test fun launchIsTheFirstJournaledOpenApp() {
        val device = Device(target)
        val gate = Gate()
        assertEquals("dispatched", host(device, gate, takeover()).launch("t1:launch"))
        assertEquals(listOf("t1:launch" to null), gate.begun)
        assertEquals(listOf("t1:launch" to "dispatched"), gate.finished)
        assertEquals(listOf("open_app"), device.dispatched)
        assertEquals(listOf("1:open_app:running", "1:open_app:completed"), steps())
        assertEquals(target, events.last().getString("label"))
        assertEquals("virtual", events.last().getString("tier"))
    }

    @Test fun launchRefusalIsJournaledRejectedAndKeepsItsCode() {
        val device = Device(target).apply { dispatchError = IllegalStateException("app_in_use_on_main") }
        val gate = Gate()
        try { host(device, gate, takeover()).launch("t1:launch"); fail() } catch (e: IllegalStateException) { assertEquals("app_in_use_on_main", e.message) }
        assertEquals(listOf("t1:launch" to "rejected"), gate.finished)
        assertEquals(listOf("1:open_app:running", "1:open_app:failed"), steps())
    }

    @Test fun firstObservationWaitsForTheTargetWithoutATakeover() {
        val port = Port()
        val h = host(Device(null), Gate(), takeover(port))
        try { h.observe(); fail() } catch (e: IllegalStateException) { assertEquals("outside_target_app", e.message) }
        assertTrue(port.moves.isEmpty())
    }

    @Test fun systemMediatorsAndTheImeAreInScope() {
        for (pkg in listOf(target, "com.android.permissioncontroller", "com.example.ime", "android")) {
            val observation = host(Device(pkg), Gate(), takeover()).observe()
            assertEquals("virtual", observation.getString("tier"))
        }
    }

    @Test fun anotherForegroundAppIsHandedToTheUserAndRefsAreForgotten() {
        val device = Device(target)
        val port = Port()
        val t = takeover(port)
        val h = host(device, Gate(), t)
        h.observe()
        device.foreground = "com.other.app"
        val handBack = Thread { while (!t.pending) Thread.sleep(10); device.foreground = target; t.handBack() }.apply { start() }
        val observation = h.observe()
        handBack.join(5000)
        assertEquals(target, observation.getString("package"))
        assertEquals(listOf("main", "back"), port.moves)
        assertEquals(1, device.forgotten)
    }

    @Test fun outOfScopeWithoutTakeoverStopsTheRun() {
        val device = Device(target)
        val h = host(device, Gate(), takeover(Port(top = -1)))
        h.observe()
        device.foreground = "com.nova.app"
        try { h.observe(); fail() } catch (e: IllegalStateException) { assertEquals("outside_target_app", e.message) }
    }

    @Test fun expiredRefHasNoEffectAndNoJournalEntry() {
        val device = Device(target).apply { prepareError = IllegalStateException("ref_expired") }
        val gate = Gate()
        val h = host(device, gate, takeover())
        h.observe()
        try { h.execute(JSONObject("""{"type":"tap","ref":"@e1","snapshot_id":"ph-1"}""")); fail() }
        catch (e: IllegalStateException) { assertEquals("ref_expired", e.message) }
        assertTrue(gate.begun.isEmpty())
        assertTrue(device.dispatched.isEmpty())
        assertTrue(steps().isEmpty())
    }

    @Test fun actionsAreApprovedAndJournaledOnTheSnapshotId() {
        val device = Device(target)
        val gate = Gate()
        val h = host(device, gate, takeover())
        val observation = h.observe()
        val d = decision("""{"type":"tap","ref":"@e1","snapshot_id":"ph-1"}""")
        h.decided(d)
        assertTrue(h.approve(d, observation))
        assertEquals("dispatched", h.execute(d.action!!))
        assertEquals(listOf("ph-1"), gate.approvals)
        assertEquals(listOf("a1" to "ph-1"), gate.begun)
        assertEquals(listOf("1:tap:running", "1:tap:completed"), steps())
        assertEquals("Do it", events.last().getString("label"))
        assertEquals("@e1", events.last().getString("ref"))
        assertTrue(events.last().getBoolean("changed"))
    }

    @Test fun typedTextNeverBecomesAStepLabel() {
        val h = host(Device(target), Gate(), takeover())
        h.observe()
        h.decided(ToolDecision.parse(JSONObject("""{"kind":"action","summary":"Type hunter2 into search","action":{"type":"type","text":"hunter2"}}"""), PhoneTier.VIRTUAL))
        h.execute(JSONObject("""{"type":"type","text":"hunter2"}"""))
        assertTrue(events.none { it.toString().contains("hunter2") })
        // The field's name (here "Search", possibly its earlier contents on a device) is never the label either.
        assertEquals(listOf("输入文字"), events.map { it.getString("label") }.distinct())
    }

    @Test fun stopDuringPreparationRefusesTheEffect() {
        val device = Device(target)
        val gate = Gate()
        val h = host(device, gate, takeover())
        h.observe()
        val reached = CountDownLatch(1)
        val stopped = CountDownLatch(1)
        device.beforeEffect = { reached.countDown(); stopped.await(5, TimeUnit.SECONDS) }
        val result = CompletableFuture<String>()
        Thread { result.complete(runCatching { h.execute(JSONObject("""{"type":"back"}""")) }.exceptionOrNull()?.message) }.start()
        assertTrue(reached.await(5, TimeUnit.SECONDS))
        gate.active = false
        stopped.countDown()
        assertEquals("execution_stopped", result.get(5, TimeUnit.SECONDS))
        assertTrue(device.dispatched.isEmpty())
        assertEquals(listOf("a1" to "rejected"), gate.finished)
    }

    @Test fun takeoverAfterPreparationInvalidatesThePreparedAction() {
        val device = Device(target)
        val gate = Gate()
        val port = Port()
        val t = takeover(port)
        val h = host(device, gate, t)
        h.observe()
        val reached = CountDownLatch(1)
        val tookOver = CountDownLatch(1)
        device.beforeEffect = { reached.countDown(); tookOver.await(5, TimeUnit.SECONDS) }
        val result = CompletableFuture<String>()
        Thread { result.complete(runCatching { h.execute(JSONObject("""{"type":"tap","ref":"@e1","snapshot_id":"ph-1"}""")) }.exceptionOrNull()?.message) }.start()
        assertTrue(reached.await(5, TimeUnit.SECONDS))
        assertEquals(TakeoverState.ACTIVE, t.request(byModel = false, reason = null))
        tookOver.countDown()
        assertEquals("screen_changed", result.get(5, TimeUnit.SECONDS))
        assertTrue(device.dispatched.isEmpty())
        assertEquals(listOf("a1" to "rejected"), gate.finished)
        assertEquals(listOf("main"), port.moves)
    }

    @Test fun takeoverWaitsForAnEffectInProgress() {
        val device = Device(target)
        val port = Port()
        val t = takeover(port)
        val h = host(device, Gate(), t)
        h.observe()
        val inEffect = CountDownLatch(1)
        val finishEffect = CountDownLatch(1)
        device.duringEffect = { inEffect.countDown(); finishEffect.await(5, TimeUnit.SECONDS) }
        val result = CompletableFuture<String>()
        Thread { result.complete(h.execute(JSONObject("""{"type":"back"}"""))) }.start()
        assertTrue(inEffect.await(5, TimeUnit.SECONDS))
        val requested = CompletableFuture<TakeoverState>()
        Thread { requested.complete(t.request(byModel = false, reason = null)) }.start()
        Thread.sleep(100)
        assertFalse(requested.isDone)
        assertTrue(port.moves.isEmpty())
        finishEffect.countDown()
        assertEquals("dispatched", result.get(5, TimeUnit.SECONDS))
        assertEquals(TakeoverState.ACTIVE, requested.get(5, TimeUnit.SECONDS))
        assertEquals(listOf("main"), port.moves)
    }

    @Test fun uncertainGestureIsJournaledUnknownAndNeverInjected() {
        var injections = 0
        val device = object : VirtualDevice by Device(target) {
            override fun dispatch(prepared: PreparedAction, effects: EffectAdmission): DispatchResult {
                val done = try { gestureOrInjection(effects, { GestureOutcome.UNCERTAIN }, { injections++; true }) }
                catch (e: EffectRefused) { throw e } catch (e: IllegalStateException) { throw IllegalStateException(e.message) }
                return DispatchResult(if (done) "dispatched" else "rejected", true)
            }
        }
        val gate = Gate()
        val h = VirtualRunHost("t1", VirtualScope(target, "com.nova.app", null), device, takeover(), gate, { events += it }, { "a1" })
        h.observe()
        assertEquals("unknown", h.execute(JSONObject("""{"type":"tap","x":0.5,"y":0.5}""")))
        assertEquals(0, injections)
        assertEquals(listOf("a1" to "unknown"), gate.finished)
    }

    @Test fun failureInsideAnEffectIsUnknownNeverRetried() {
        val device = Device(target).apply { dispatchError = RuntimeException("binder") }
        val gate = Gate()
        val h = host(device, gate, takeover())
        h.observe()
        assertEquals("unknown", h.execute(JSONObject("""{"type":"back"}""")))
        assertEquals(listOf("a1" to "unknown"), gate.finished)
        assertEquals(listOf("1:back:running", "1:back:unknown"), steps())
    }

    @Test fun foregroundOutsideScopeAtExecutionReplans() {
        val device = Device(target)
        val gate = Gate()
        val h = host(device, gate, takeover())
        h.observe()
        device.foreground = "com.other.app"
        try { h.execute(JSONObject("""{"type":"back"}""")); fail() } catch (e: IllegalStateException) { assertEquals("screen_changed", e.message) }
        assertTrue(gate.begun.isEmpty())
    }

    @Test fun handToUserNeedsNoApprovalAndPausesTheNextObservation() {
        val device = Device(target)
        val gate = Gate()
        val t = takeover()
        val h = host(device, gate, t)
        val observation = h.observe()
        val d = decision("""{"type":"hand_to_user","reason":"Payment needs the user"}""")
        assertTrue(h.approve(d, observation))
        assertTrue(gate.approvals.isEmpty())
        assertEquals("dispatched", h.execute(d.action!!))
        assertEquals(TakeoverState.ACTIVE, t.state)
        assertEquals(listOf("a1" to null), gate.begun)
        assertEquals(listOf("1:hand_to_user:running", "1:hand_to_user:completed"), steps())
        Thread { Thread.sleep(100); t.handBack() }.start()
        val after = h.observe()
        assertEquals("ph-2", after.getString("snapshot_id"))
        assertEquals(1, device.forgotten)
    }

    @Test fun failedHandToUserEndsWithTakeoverUnavailable() {
        val gate = Gate()
        val h = host(Device(target), gate, takeover(Port(toMain = false)))
        h.observe()
        try { h.execute(JSONObject("""{"type":"hand_to_user","reason":"Login"}""")); fail() }
        catch (e: IllegalStateException) { assertEquals("takeover_unavailable", e.message) }
        assertEquals(listOf("a1" to "rejected"), gate.finished)
    }

    @Test fun userTakeoverBetweenObservationAndActionDiscardsThePlan() {
        val device = Device(target)
        val gate = Gate()
        val t = takeover()
        val h = host(device, gate, t)
        h.observe()
        t.request(byModel = false, reason = null)
        Thread { Thread.sleep(100); t.handBack() }.start()
        try { h.execute(JSONObject("""{"type":"back"}""")); fail() } catch (e: IllegalStateException) { assertEquals("screen_changed", e.message) }
        assertTrue(device.dispatched.isEmpty())
        assertTrue(gate.begun.isEmpty())
    }

    @Test fun takeoverTimeoutStopsTheRun() {
        var clock = 0L
        val t = RunTakeover("t1", Port(), {}, { clock }, timeoutMs = 1000)
        val h = host(Device(target), Gate(), t)
        h.observe()
        t.request(byModel = false, reason = null)
        clock = 1000
        try { h.observe(); fail() } catch (e: IllegalStateException) { assertEquals("takeover_timeout", e.message) }
    }

    @Test fun fullLoopTapsByRefThenCompletesOnAFreshSnapshot() {
        val device = Device(target)
        val gate = Gate()
        val h = host(device, gate, takeover())
        var turns = 0
        LocalToolLoop(h, { observation, turn ->
            turns++
            h.decided(if (turn == 0) decision("""{"type":"tap","ref":"@e1","snapshot_id":"${observation.getString("snapshot_id")}"}""")
            else ToolDecision.parse(JSONObject("""{"kind":"complete","summary":"Results visible"}"""), PhoneTier.VIRTUAL))
        }, initialLaunchGrace = true).run()
        assertEquals(2, turns)
        assertEquals(listOf("tap"), device.dispatched)
        assertEquals("ph-2", gate.completed)
        assertNull(gate.interruption)
    }

    @Test fun appLeavingForTheMainDisplayStopsTheRunUnlessTheUserTookOver() {
        val device = Device(target).apply { snapshotError = { IllegalStateException("display_unavailable") } }
        try { host(device, Gate(), takeover()).observe(); fail() } catch (e: IllegalStateException) { assertEquals("display_unavailable", e.message) }
        val t = takeover()
        val raced = Device(target)
        val h = host(raced, Gate(), t)
        h.observe()
        raced.snapshotError = { t.request(byModel = false, reason = null); Thread { Thread.sleep(50); t.handBack() }.start(); IllegalStateException("display_unavailable") }
        assertEquals("ph-2", h.observe().getString("snapshot_id"))
    }
    @Test fun observeDecisionIsReportedAsAStep() {
        val h = host(Device(target), Gate(), takeover())
        h.decided(ToolDecision.parse(JSONObject("""{"kind":"observe","summary":"Loading"}"""), PhoneTier.VIRTUAL))
        assertEquals(listOf("1:observe:running", "1:observe:completed"), steps())
        assertFalse(events.any { it.has("ref") })
    }
}
