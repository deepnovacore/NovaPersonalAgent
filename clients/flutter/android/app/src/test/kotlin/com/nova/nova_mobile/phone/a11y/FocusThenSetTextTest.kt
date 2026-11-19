package com.nova.nova_mobile.phone.a11y

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

class FocusThenSetTextTest {
    /** Admits until [refuseWith] is set; then refuses with that code. Counts admissions. */
    private class Effects : EffectAdmission {
        var refuseWith: String? = null
        var admitted = 0
        override fun <T> admit(effect: () -> T): T {
            refuseWith?.let { throw EffectRefused(it) }
            admitted++
            return effect()
        }
    }

    @Test fun focusAndSetTextAreAdmittedSeparately() {
        val effects = Effects()
        val done = mutableListOf<String>()
        assertTrue(focusThenSetText(effects, needsFocus = true, { done += "focus" }, { done += "set"; true }))
        assertEquals(listOf("focus", "set"), done)
        assertEquals(2, effects.admitted)
    }

    @Test fun stopAfterFocusRefusesSetTextAndIsUncertain() {
        val effects = Effects()
        var set = 0
        try {
            focusThenSetText(effects, needsFocus = true, { effects.refuseWith = EXECUTION_STOPPED }, { set++; true })
            fail()
        } catch (e: IllegalStateException) {
            assertEquals(EFFECT_UNKNOWN, e.message)
            assertTrue(e !is EffectRefused)
        }
        assertEquals(0, set)
    }

    @Test fun takeoverAfterFocusRefusesSetTextAndIsUncertain() {
        val effects = Effects()
        var set = 0
        try {
            focusThenSetText(effects, needsFocus = true, { effects.refuseWith = SCREEN_CHANGED }, { set++; true })
            fail()
        } catch (e: IllegalStateException) {
            assertEquals(EFFECT_UNKNOWN, e.message)
            assertTrue(e !is EffectRefused)
        }
        assertEquals(0, set)
    }

    @Test fun refusalWithoutAFocusCallDispatchedNothing() {
        val effects = Effects().apply { refuseWith = EXECUTION_STOPPED }
        var set = 0
        try { focusThenSetText(effects, needsFocus = false, { fail() }, { set++; true }); fail() }
        catch (e: EffectRefused) { assertEquals(EXECUTION_STOPPED, e.message) }
        assertEquals(0, set)
    }

    @Test fun refusedFocusDispatchedNothing() {
        val effects = Effects().apply { refuseWith = SCREEN_CHANGED }
        var focused = 0
        var set = 0
        try { focusThenSetText(effects, needsFocus = true, { focused++ }, { set++; true }); fail() }
        catch (e: EffectRefused) { assertEquals(SCREEN_CHANGED, e.message) }
        assertEquals(0, focused)
        assertEquals(0, set)
    }
}
