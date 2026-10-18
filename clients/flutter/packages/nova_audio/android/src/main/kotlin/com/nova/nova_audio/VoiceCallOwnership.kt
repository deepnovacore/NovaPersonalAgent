package com.nova.nova_audio

/** Process-wide service ownership; a headless engine must not release a UI call. */
internal class VoiceCallOwnership {
    private var owner: String? = null
    @Synchronized fun owns(id: String?): Boolean = id != null && owner == id
    @Synchronized fun claim(id: String): Boolean {
        if (owner != null) return false
        owner = id
        return true
    }
    @Synchronized fun release(id: String?): Boolean {
        if (!owns(id)) return false
        owner = null
        return true
    }
}
