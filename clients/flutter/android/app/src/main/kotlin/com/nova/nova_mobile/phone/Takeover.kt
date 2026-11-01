// Derived from Mika (https://github.com/wangzan101/Mika, Apache-2.0, commit 5f630d9),
// Copyright 2026 wangzan101. Modified by Nova: rewritten single-task, blocking state machine after the idea of
// takeover/Takeover.kt; no queue, web tabs, sound or input watching; states and timeout from the Nova contract.
package com.nova.nova_mobile.phone

import kotlin.math.min

/** Longest time the task may stay on the main display before the run ends with `takeover_timeout`. */
const val TAKEOVER_TIMEOUT_MS = 10 * 60 * 1000L

/** Device side of a takeover for the run's virtual display. Calls may throw; a throw counts as failure. */
interface TakeoverPort {
    /** Task at the top of the run's display, or -1 (no display or nothing shown). */
    fun topTask(): Int
    fun moveToMain(taskId: Int): Boolean
    fun moveBack(taskId: Int): Boolean
    /** True while the task is on the main display: preview frames stop. */
    fun paused(paused: Boolean)
}

/**
 * One run's takeover (contract "Takeover"): [request] → REQUESTED → move the display's top task to the main display →
 * ACTIVE; [handBack] moves it back → RETURNED. A failed move is FAILED; ACTIVE longer than [timeoutMs] is TIMED_OUT.
 * FAILED and TIMED_OUT end the run, so they are final. [request] and [handBack] do the moves on the calling thread
 * (two Binder calls); the agent loop blocks in [await] while a takeover is ACTIVE. Every state change goes to [emit].
 */
class RunTakeover(
    private val taskId: String,
    private val port: TakeoverPort,
    private val emit: (PhoneTakeoverEvent) -> Unit,
    private val now: () -> Long,
    private val timeoutMs: Long = TAKEOVER_TIMEOUT_MS,
) {
    private val lock = Object()
    private var task = -1
    private var byModel = false
    private var reason: String? = null
    private var activeSince = 0L
    private var cancelled = false

    /** Last state, or null before the first takeover. */
    var state: TakeoverState? = null
        private set

    /** Number of completed hand-backs. Refs and observations from before a hand-back are stale. */
    @Volatile var returns = 0
        private set

    val pending: Boolean get() = synchronized(lock) { state == TakeoverState.REQUESTED || state == TakeoverState.ACTIVE }

    /** Starts a takeover; a pending or final one is returned unchanged. */
    fun request(byModel: Boolean, reason: String?): TakeoverState = synchronized(lock) {
        state?.let { if (it != TakeoverState.RETURNED) return it }
        check(!cancelled) { "task_not_running" }
        this.byModel = byModel
        this.reason = reason
        set(TakeoverState.REQUESTED)
        val top = runCatching { port.topTask() }.getOrDefault(-1)
        if (top < 0 || !runCatching { port.moveToMain(top) }.getOrDefault(false)) return set(TakeoverState.FAILED)
        task = top
        activeSince = now()
        runCatching { port.paused(true) }
        set(TakeoverState.ACTIVE)
    }

    /** Moves the task back to the run's display. Only an ACTIVE takeover changes; otherwise the current state is returned. */
    fun handBack(): TakeoverState = synchronized(lock) {
        val current = state ?: throw IllegalStateException("no_takeover")
        if (current != TakeoverState.ACTIVE) return current
        if (expired()) return set(TakeoverState.TIMED_OUT)
        if (!runCatching { port.moveBack(task) }.getOrDefault(false)) return set(TakeoverState.FAILED)
        runCatching { port.paused(false) }
        returns++
        set(TakeoverState.RETURNED)
    }

    /**
     * Blocks while a takeover is ACTIVE and [active] holds. Returns the state afterwards: null when there never was a
     * takeover, else RETURNED, FAILED or TIMED_OUT (or still ACTIVE when [active] turned false or the run was cancelled).
     */
    fun await(active: () -> Boolean): TakeoverState? = synchronized(lock) {
        while (state == TakeoverState.ACTIVE && active() && !cancelled) {
            if (expired()) { set(TakeoverState.TIMED_OUT); break }
            lock.wait(min(POLL_MS, activeSince + timeoutMs - now()).coerceAtLeast(1))
        }
        state
    }

    /** Run ended: wakes [await]. A task already on the main display stays there for the user. */
    fun cancel() = synchronized(lock) {
        cancelled = true
        lock.notifyAll()
    }

    private fun expired() = now() - activeSince >= timeoutMs

    private fun set(next: TakeoverState): TakeoverState {
        state = next
        lock.notifyAll()
        runCatching { emit(PhoneTakeoverEvent(taskId, next, byModel, reason)) }
        return next
    }

    private companion object {
        const val POLL_MS = 1_000L
    }
}
