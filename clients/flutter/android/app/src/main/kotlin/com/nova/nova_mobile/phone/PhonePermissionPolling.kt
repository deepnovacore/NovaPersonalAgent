package com.nova.nova_mobile.phone

import java.util.Collections
import java.util.IdentityHashMap
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.collectLatest
import kotlinx.coroutines.flow.emitAll
import kotlinx.coroutines.flow.filterNotNull
import kotlinx.coroutines.flow.flow
import kotlinx.coroutines.isActive

/** Identity-based tracking handles overlapping activities and duplicate pause/destroy callbacks. Main-thread only. */
internal class ResumedPhoneActivities {
    private val activities = Collections.newSetFromMap(IdentityHashMap<Any, Boolean>())
    val resumed = MutableStateFlow(false)
    fun resume(activity: Any) { activities.add(activity); resumed.value = activities.isNotEmpty() }
    fun pause(activity: Any) { activities.remove(activity); resumed.value = activities.isNotEmpty() }
}

/** Cancels the timer (and any suspended refresh) on backgrounding; resume refreshes immediately. */
internal suspend fun pollPhonePermissions(resumed: Flow<Boolean>, refresh: suspend () -> Unit) {
    resumed.collectLatest { active ->
        if (active) while (currentCoroutineContext().isActive) {
            refresh()
            delay(2_000)
        }
    }
}

/**
 * Permission flags as status input: never the unread placeholder. A subscriber that arrives before the first poll
 * (background, or right after an engine restart) reads the flags once instead of reporting every permission as off.
 */
internal fun <T : Any> readPermissionFlags(flags: MutableStateFlow<T?>, read: suspend () -> T): Flow<T> = flow {
    if (flags.value == null) {
        val first = read()
        flags.compareAndSet(null, first)
    }
    emitAll(flags.filterNotNull())
}
