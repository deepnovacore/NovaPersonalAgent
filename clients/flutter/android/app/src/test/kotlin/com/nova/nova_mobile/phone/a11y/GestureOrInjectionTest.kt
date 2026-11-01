package com.nova.nova_mobile.phone.a11y

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

class GestureOrInjectionTest {
    /** Admits while [open]; counts admissions. */
    private class Effects(var open: Boolean = true) : EffectAdmission {
        var admitted = 0
        override fun <T> admit(effect: () -> T): T {
            if (!open) throw EffectRefused(EXECUTION_STOPPED)
            admitted++
            return effect()
        }
    }

    @Test fun completedGestureIsNotInjected() {
        var injected = 0
        assertTrue(gestureOrInjection(Effects(), { GestureOutcome.COMPLETED }, { injected++; true }))
        assertEquals(0, injected)
    }

    @Test fun uncertainGestureIsUnknownAndNeverInjected() {
        var injected = 0
        try { gestureOrInjection(Effects(), { GestureOutcome.UNCERTAIN }, { injected++; true }); fail() }
        catch (e: IllegalStateException) { assertEquals(EFFECT_UNKNOWN, e.message); assertTrue(e !is EffectRefused) }
        assertEquals(0, injected)
    }

    @Test fun refusedGestureFallsBackThroughItsOwnAdmission() {
        val effects = Effects()
        var injected = 0
        assertTrue(gestureOrInjection(effects, { GestureOutcome.REFUSED }, { injected++; true }))
        assertEquals(1, injected)
        assertEquals(2, effects.admitted)
    }

    @Test fun stopAfterARefusedGestureBlocksTheFallback() {
        val effects = Effects()
        var injected = 0
        try {
            gestureOrInjection(effects, { effects.open = false; GestureOutcome.REFUSED }, { injected++; true })
            fail()
        } catch (e: EffectRefused) { assertEquals(EXECUTION_STOPPED, e.message) }
        assertEquals(0, injected)
    }
}
