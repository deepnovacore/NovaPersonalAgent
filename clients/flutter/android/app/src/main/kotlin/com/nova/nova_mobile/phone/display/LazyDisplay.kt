// Derived from Mika (https://github.com/wangzan101/Mika, Apache-2.0, commit 5f630d9),
// Copyright 2026 wangzan101. Modified by Nova: blocking lock instead of a coroutine Mutex, close() for run end.
package com.nova.nova_mobile.phone.display

import com.nova.nova_mobile.phone.PhoneActionErrors

/**
 * A display created on first use: the run's first `open_app` calls [get]; it stays the same display until [close].
 * [width] and [height] are the size the display will have. Generic only so unit tests can use a fake;
 * the product type is [LazyAgentDisplay].
 */
class LazyDisplay<T : Any>(val width: Int, val height: Int, private val create: () -> T) {
    private val lock = Any()
    @Volatile private var made: T? = null
    @Volatile private var closed = false

    /** The display if it was created; never creates one. */
    val current: T? get() = made

    /** Returns the display, creating it on the first call. A failed creation throws and is retried by the next call. */
    fun get(): T = made ?: synchronized(lock) {
        check(!closed) { PhoneActionErrors.DISPLAY_UNAVAILABLE }
        made ?: create().also { made = it }
    }

    /** Ends this display's life: later [get] calls fail. Returns the created display, if any, for the caller to release. */
    fun close(): T? = synchronized(lock) {
        closed = true
        made.also { made = null }
    }
}

typealias LazyAgentDisplay = LazyDisplay<AgentDisplay>
