package com.nova.nova_audio

/** Coalesces startup replies: every show awaiting the same service sees its final outcome. */
internal class VoicePetRequests {
    var task: VoicePetTask? = null
        private set
    var generation = 0
        private set
    private val pending = mutableListOf<(String?) -> Unit>()
    val starting get() = pending.isNotEmpty()

    fun show(value: VoicePetTask, reply: (String?) -> Unit) {
        task = value
        pending.add(reply)
    }
    fun complete(error: String? = null) {
        val replies = pending.toList()
        pending.clear()
        replies.forEach { it(error) }
    }
    fun hide(taskId: String? = null, error: String = "overlay_blocked"): Boolean {
        if (taskId != null && task?.id != taskId) return false
        task = null
        generation++
        complete(error)
        return true
    }
}

internal object VoicePetControls {
    // Step/label/status updates retain the actual buttons and scroll view during a gesture.
    fun needsRebuild(call: Boolean, task: VoicePetTask?, nextCall: Boolean, nextTask: VoicePetTask?) =
        call != nextCall || task?.id != nextTask?.id || task?.terminal != nextTask?.terminal
}

internal object VoicePetImages {
    fun sampleSize(longest: Int, cap: Int = 256): Int {
        var sample = 1
        while (longest / (sample * 2) >= cap) sample *= 2
        return sample
    }
}
