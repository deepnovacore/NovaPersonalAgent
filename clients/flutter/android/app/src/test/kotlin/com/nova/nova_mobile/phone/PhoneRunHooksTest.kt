package com.nova.nova_mobile.phone

import org.junit.Assert.*
import org.junit.Test

class PhoneRunHooksTest {
    private class Controller : PhoneTakeover {
        override fun takeover(taskId: String) = TakeoverState.ACTIVE
        override fun handBack(taskId: String) = TakeoverState.RETURNED
    }
    private class SelfCheck : PhoneSelfCheck {
        override fun run() = emptyList<SelfCheckItem>()
    }

    @Test fun spaceSwitchReplacesBothHooksAndCloseClearsThem() {
        val hooks = PhoneRunHooks()
        val old = Controller()
        hooks.takeover = old
        hooks.selfCheck = SelfCheck()
        hooks.clear(old)
        assertNull(hooks.takeover)
        assertNull(hooks.selfCheck)
        val current = Controller()
        val check = SelfCheck()
        hooks.takeover = current
        hooks.selfCheck = check
        hooks.clear(old) // Destruction of the previous activity is not allowed to detach the new Space.
        assertSame(current, hooks.takeover)
        assertSame(check, hooks.selfCheck)
        hooks.clear(current)
        assertNull(hooks.takeover)
        assertNull(hooks.selfCheck)
    }

}
