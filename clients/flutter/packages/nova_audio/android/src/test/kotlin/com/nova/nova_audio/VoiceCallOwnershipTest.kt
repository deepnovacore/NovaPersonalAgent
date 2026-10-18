package com.nova.nova_audio

import org.junit.Assert.*
import org.junit.Test

class VoiceCallOwnershipTest {
    @Test fun scheduledEngineCannotReleaseAnActiveUiCall() {
        val owner = VoiceCallOwnership()
        assertTrue(owner.claim("ui-call"))
        assertFalse(owner.release(null))
        assertFalse(owner.release("headless-engine"))
        assertTrue(owner.owns("ui-call"))
        assertFalse(owner.claim("second-engine"))
        assertTrue(owner.release("ui-call"))
        assertTrue(owner.claim("next-call"))
        assertFalse(owner.release("ui-call"))
        assertTrue(owner.owns("next-call"))
    }
}
