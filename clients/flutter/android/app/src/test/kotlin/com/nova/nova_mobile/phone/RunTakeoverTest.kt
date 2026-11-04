package com.nova.nova_mobile.phone

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.util.concurrent.CompletableFuture
import java.util.concurrent.TimeUnit

class RunTakeoverTest {
    private class Port(var top: Int = 7, var toMain: Boolean = true, var back: Boolean = true) : TakeoverPort {
        val moves = mutableListOf<String>()
        var pausedNow = false
        override fun topTask() = top
        override fun moveToMain(taskId: Int): Boolean { moves += "main:$taskId"; return toMain }
        override fun moveBack(taskId: Int): Boolean { moves += "back:$taskId"; return back }
        override fun paused(paused: Boolean) { pausedNow = paused }
    }
    private var clock = 0L
    private val events = mutableListOf<PhoneTakeoverEvent>()
    private fun takeover(port: Port, timeout: Long = TAKEOVER_TIMEOUT_MS) = RunTakeover("t1", port, { events += it }, { clock }, { false }, timeout)

    @Test fun modelTakeoverWaitsForTheUserBeforeMovingTheTopTask() {
        val port = Port()
        val t = takeover(port)
        assertEquals(TakeoverState.REQUESTED, t.request(byModel = true, reason = "Login required"))
        assertTrue(port.moves.isEmpty())
        assertTrue(!port.pausedNow)
        assertEquals(TakeoverState.ACTIVE, t.request(byModel = false, reason = null))
        assertTrue(port.pausedNow)
        assertEquals(TakeoverState.RETURNED, t.handBack())
        assertEquals(listOf("main:7", "back:7"), port.moves)
        assertEquals(1, t.returns)
        assertEquals(false, port.pausedNow)
        assertEquals(listOf(TakeoverState.REQUESTED, TakeoverState.ACTIVE, TakeoverState.RETURNED), events.map { it.state })
        assertEquals(listOf(true, false, false), events.map { it.byModel })
        assertTrue(events.all { it.reason == "Login required" && it.taskId == "t1" })
    }

    @Test fun aPendingTakeoverIsNotStartedTwice() {
        val port = Port()
        val t = takeover(port)
        t.request(byModel = false, reason = null)
        assertEquals(TakeoverState.ACTIVE, t.request(byModel = true, reason = "again"))
        assertEquals(listOf("main:7"), port.moves)
        assertTrue(events.none { it.byModel })
    }

    @Test fun anotherTakeoverMayFollowAHandBack() {
        val port = Port()
        val t = takeover(port)
        t.request(false, "a"); t.handBack()
        port.top = 9
        assertEquals(TakeoverState.ACTIVE, t.request(false, null))
        assertEquals(TakeoverState.RETURNED, t.handBack())
        assertEquals(listOf("main:7", "back:7", "main:9", "back:9"), port.moves)
        assertEquals(2, t.returns)
    }

    @Test fun failedMovesAreFinal() {
        val none = takeover(Port(top = -1))
        assertEquals(TakeoverState.FAILED, none.request(true, "x"))
        assertEquals(TakeoverState.FAILED, none.request(true, "x"))
        val refused = Port(toMain = false)
        assertEquals(TakeoverState.FAILED, takeover(refused).request(false, null))
        val stuck = Port(back = false)
        val t = takeover(stuck)
        t.request(false, null)
        assertEquals(TakeoverState.FAILED, t.handBack())
        assertEquals(0, t.returns)
        assertEquals(TakeoverState.FAILED, t.request(false, null))
    }

    @Test fun throwingPortCountsAsFailure() {
        val port = object : TakeoverPort {
            override fun topTask(): Int = throw IllegalStateException("binder died")
            override fun moveToMain(taskId: Int) = true
            override fun moveBack(taskId: Int) = true
            override fun paused(paused: Boolean) {}
        }
        assertEquals(TakeoverState.FAILED, RunTakeover("t", port, {}, { 0L }, { false }).request(true, null))
    }

    @Test fun requestOnTheMainThreadFailsFastWithoutWaitingForAnEffect() {
        val port = Port()
        var onMain = true
        val t = RunTakeover("t1", port, { events += it }, { clock }, { onMain })
        // A gesture holds off moves; its result would need the main thread that a waiting request blocks.
        val effectStarted = CompletableFuture<Unit>()
        val effectMayEnd = CompletableFuture<Unit>()
        val effect = Thread { t.withoutMoves { effectStarted.complete(Unit); effectMayEnd.get(5, TimeUnit.SECONDS) } }.apply { start() }
        effectStarted.get(5, TimeUnit.SECONDS)
        val refused = CompletableFuture<String?>()
        Thread { refused.complete(runCatching { t.request(byModel = false, reason = null) }.exceptionOrNull()?.message) }.start()
        assertEquals(TAKEOVER_ON_MAIN_THREAD, refused.get(1, TimeUnit.SECONDS))
        effectMayEnd.complete(Unit)
        effect.join(5000)
        assertNull(t.state)
        assertEquals(0, t.generation)
        assertTrue(port.moves.isEmpty() && events.isEmpty())
        onMain = false
        assertEquals(TakeoverState.ACTIVE, t.request(byModel = false, reason = null))
    }

    @Test fun handBackWithoutTakeoverIsRejected() {
        try { takeover(Port()).handBack(); throw AssertionError("accepted") } catch (e: IllegalStateException) { assertEquals("no_takeover", e.message) }
    }

    @Test fun activeLongerThanTheLimitTimesOutAndLeavesTheAppWithTheUser() {
        val port = Port()
        val t = takeover(port)
        t.request(false, "pay")
        clock = TAKEOVER_TIMEOUT_MS
        assertEquals(TakeoverState.TIMED_OUT, t.await { true })
        assertEquals(TakeoverState.TIMED_OUT, t.handBack())
        assertEquals(listOf("main:7"), port.moves)
        assertEquals(TakeoverState.TIMED_OUT, events.last().state)
    }

    @Test fun pendingModelRequestTimesOutWithoutMovingTheApp() {
        val port = Port()
        val t = takeover(port)
        t.request(true, "Login")
        clock = TAKEOVER_TIMEOUT_MS
        assertEquals(TakeoverState.TIMED_OUT, t.await { true })
        assertTrue(port.moves.isEmpty())
    }

    @Test fun awaitBlocksWhileTheModelWaitsForUserConsent() {
        val port = Port()
        val t = RunTakeover("t1", port, {}, System::currentTimeMillis, { false })
        t.request(true, "Login")
        val result = CompletableFuture<TakeoverState?>()
        Thread { result.complete(t.await { true }) }.start()
        Thread.sleep(50)
        assertTrue(!result.isDone && port.moves.isEmpty())
        t.cancel()
        assertEquals(TakeoverState.REQUESTED, result.get(5, TimeUnit.SECONDS))
        try { t.request(false, null); throw AssertionError("accepted") }
        catch (e: IllegalStateException) { assertEquals("task_not_running", e.message) }
        assertTrue(port.moves.isEmpty())
    }

    @Test fun awaitReturnsImmediatelyWithoutATakeover() {
        assertNull(takeover(Port()).await { true })
    }

    @Test fun awaitBlocksUntilTheUserHandsBack() {
        val t = RunTakeover("t1", Port(), {}, System::currentTimeMillis, { false })
        t.request(false, null)
        val result = CompletableFuture<TakeoverState?>()
        val loop = Thread { result.complete(t.await { true }) }.apply { start() }
        Thread.sleep(100)
        assertTrue(!result.isDone)
        assertEquals(TakeoverState.RETURNED, t.handBack())
        assertEquals(TakeoverState.RETURNED, result.get(5, TimeUnit.SECONDS))
        loop.join(5000)
    }

    @Test fun cancelWakesTheLoopAndBlocksNewTakeovers() {
        val t = RunTakeover("t1", Port(), {}, System::currentTimeMillis, { false })
        t.request(false, null)
        val result = CompletableFuture<TakeoverState?>()
        Thread { result.complete(t.await { true }) }.start()
        Thread.sleep(50)
        t.cancel()
        assertEquals(TakeoverState.ACTIVE, result.get(5, TimeUnit.SECONDS))
        assertEquals(TakeoverState.RETURNED, t.handBack())
        try { t.request(true, null); throw AssertionError("accepted") } catch (e: IllegalStateException) { assertEquals("task_not_running", e.message) }
    }
}
