// Derived from Mika (https://github.com/wangzan101/Mika, Apache-2.0, commit 5f630d9),
// Copyright 2026 wangzan101. Modified by Nova: rewritten single-task, blocking state machine after the idea of
// takeover/Takeover.kt; no queue, web tabs, sound or input watching; states and timeout from the Nova contract.
package com.nova.nova_mobile.phone

import android.os.Looper
import kotlin.math.min

/** Longest time a takeover may stay REQUESTED or ACTIVE (waiting for, or on, the main display) before the run ends with `takeover_timeout`. */
const val TAKEOVER_TIMEOUT_MS = 10 * 60 * 1000L
/** [RunTakeover.request] was called on the main thread, which must stay free to deliver gesture results. */
const val TAKEOVER_ON_MAIN_THREAD = "takeover_on_main_thread"

/** The calling thread is the main Looper's thread. */
val onMainLooper: () -> Boolean = { Looper.myLooper() == Looper.getMainLooper() }

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
 * One run's takeover (contract "Takeover"): a model [request] → REQUESTED (no move); a user [request] → move the display's top task to the main display →
 * ACTIVE; [handBack] moves it back → RETURNED. A failed move is FAILED; REQUESTED or ACTIVE longer than [timeoutMs] is TIMED_OUT.
 * FAILED and TIMED_OUT end the run, so they are final. [request] and [handBack] do the moves on the calling thread
 * (two Binder calls); the agent loop blocks in [await] while a takeover is REQUESTED or ACTIVE. Every state change goes to [emit].
 * [request] is serialized against effects run through [withoutMoves]: it waits for an effect in progress and bumps
 * [generation] before it moves anything, so an effect admitted later can see that its plan is stale.
 * An effect can be a gesture whose result Android delivers through the main thread (even with a callback handler), so
 * [request] fails fast with [TAKEOVER_ON_MAIN_THREAD] when [onMainThread] holds instead of stalling that gesture.
 */
class RunTakeover(
    private val taskId: String,
    private val port: TakeoverPort,
    private val emit: (PhoneTakeoverEvent) -> Unit,
    private val now: () -> Long,
    private val onMainThread: () -> Boolean,
    private val timeoutMs: Long = TAKEOVER_TIMEOUT_MS,
) {
    private val lock = Object()
    /** Held by [request] around its move and by [withoutMoves] around an effect; always taken before [lock]. */
    private val moveLock = Any()
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

    /** Number of takeovers started (each [request] that left RETURNED or no state). Plans from an older generation are stale. */
    @Volatile var generation = 0
        private set

    val pending: Boolean get() = synchronized(lock) { state == TakeoverState.REQUESTED || state == TakeoverState.ACTIVE }

    /** Runs [block] (one effect on the run's display) while no takeover move can start. */
    fun <T> withoutMoves(block: () -> T): T = synchronized(moveLock, block)

    /**
     * Starts a takeover; a pending or final one is returned unchanged. Waits for an effect in progress first, so it
     * must run off the main thread (throws IllegalStateException([TAKEOVER_ON_MAIN_THREAD]) there, changing nothing).
     */
    fun request(byModel: Boolean, reason: String?): TakeoverState {
        check(!onMainThread()) { TAKEOVER_ON_MAIN_THREAD }
        return requestOffMain(byModel, reason)
    }

    private fun requestOffMain(byModel: Boolean, reason: String?): TakeoverState = synchronized(moveLock) { synchronized(lock) {
        state?.let { if (it != TakeoverState.RETURNED && !(it == TakeoverState.REQUESTED && !byModel)) return it }
        check(!cancelled) { "task_not_running" }
        if (state != TakeoverState.REQUESTED) {
            this.byModel = byModel
            this.reason = reason
            generation++
            activeSince = now()
            set(TakeoverState.REQUESTED)
        } else {
            // The user answers the model's request: the move is theirs; the reason stays for the UI.
            this.byModel = false
        }
        val top = runCatching { port.topTask() }.getOrDefault(-1)
        if (top < 0) return set(TakeoverState.FAILED)
        // A model can ask for help; only the user's Take over command may move the app to the main screen.
        if (byModel) return TakeoverState.REQUESTED
        if (!runCatching { port.moveToMain(top) }.getOrDefault(false)) return set(TakeoverState.FAILED)
        task = top
        activeSince = now()
        runCatching { port.paused(true) }
        set(TakeoverState.ACTIVE)
    } }

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
     * Blocks while a takeover is REQUESTED or ACTIVE and [active] holds. Returns the state afterwards: null when there never was a
     * takeover, else RETURNED, FAILED or TIMED_OUT (or still REQUESTED/ACTIVE when [active] turned false or the run was cancelled).
     */
    fun await(active: () -> Boolean): TakeoverState? = synchronized(lock) {
        while ((state == TakeoverState.REQUESTED || state == TakeoverState.ACTIVE) && active() && !cancelled) {
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
