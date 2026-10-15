package com.nova.nova_mobile

import java.util.concurrent.CompletableFuture
import java.util.concurrent.TimeUnit

/** One approval of one observed action. The task fence is checked separately. */
class ActionApproval(val id: String, private val action: String, private val observation: String, val deadline: Long) {
    private val response = CompletableFuture<Boolean>()
    private var accepted = false
    private var closed = false
    @Synchronized fun resolve(proposalId: String, allow: Boolean, now: Long): Boolean {
        if(proposalId != id || closed || response.isDone || now >= deadline) return false
        accepted = allow
        response.complete(allow)
        return true
    }
    fun await(timeoutMs: Long): Boolean = try { response.get(timeoutMs.coerceAtLeast(1), TimeUnit.MILLISECONDS) } catch(_: Exception) { false }
    @Synchronized fun consume(action: String, observation: String, now: Long): Boolean {
        if(closed || !accepted || now >= deadline || this.action != action || this.observation != observation) return false
        closed = true
        return true
    }
    @Synchronized fun cancel() { closed = true; response.complete(false) }
}
