package com.nova.nova_mobile.phone

import java.util.Collections
import java.util.IdentityHashMap
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.collectLatest
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
