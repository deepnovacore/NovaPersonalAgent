package com.nova.nova_audio

internal data class VoicePetTask(val id: String, val status: String, val label: String, val step: Int?) {
    init {
        require(id.isNotBlank())
        require(status in setOf("running", "needs_user", "done", "failed"))
        require(step == null || step >= 0)
    }
    val terminal get() = status == "done" || status == "failed"
}

/** Call and task lifetimes are independent; a resumed Nova activity always wins. */
internal class VoicePetState {
    var callActive = false
    var task: VoicePetTask? = null
    var resumed = false
    val visible get() = !resumed && (callActive || task != null)
    fun acceptsFrame(expanded: Boolean) = visible && expanded && task?.status == "running"
    fun expire(expected: VoicePetTask): Boolean {
        if (task !== expected || !expected.terminal) return false
        task = null
        return true
    }
}

internal object VoicePetDock {
    fun edge(x: Int, availableWidth: Int): Int = if (x > availableWidth.coerceAtLeast(0) / 2) availableWidth.coerceAtLeast(0) else 0
    fun clamp(value: Int, available: Int) = value.coerceIn(0, available.coerceAtLeast(0))
}
