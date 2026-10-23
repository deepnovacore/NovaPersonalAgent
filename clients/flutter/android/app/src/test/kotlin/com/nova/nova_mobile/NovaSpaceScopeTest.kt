package com.nova.nova_mobile

import org.junit.Assert.*
import org.junit.Test

class NovaSpaceScopeTest {
    @Test fun roleChangesStopOldOwnersBeforeNewScopeMayRun() {
        NovaSpaceScope.select("unselected", "client")
        assertThrows(IllegalStateException::class.java) { NovaSpaceScope.standalone() }
        val owner = Any(); val observed = mutableListOf<NativeSpaceSelection.Selection>()
        NovaSpaceScope.listen(owner) { runCatching { NovaSpaceScope.standalone() }.getOrNull()?.let { observed.add(it) } }
        try {
            NovaSpaceScope.select("space-a", "standalone")
            val a = NovaSpaceScope.standalone()
            NovaSpaceScope.select("space-a", "standalone")
            assertEquals(1, observed.size)
            NovaSpaceScope.select("space-b", "standalone")
            assertFalse(NovaSpaceScope.isCurrent(a))
            assertEquals("space-b", NovaSpaceScope.standalone().id)
            NovaSpaceScope.select("phone-client", "client")
            assertThrows(IllegalStateException::class.java) { NovaSpaceScope.standalone() }
        } finally { NovaSpaceScope.removeListener(owner) }
    }
    @Test fun traversalAndUnknownModeAreRejectedWithoutChangingSelection() {
        NovaSpaceScope.select("space-a", "standalone")
        assertThrows(IllegalArgumentException::class.java) { NovaSpaceScope.select("../space-b", "standalone") }
        assertThrows(IllegalArgumentException::class.java) { NovaSpaceScope.select("space-b", "host") }
        assertEquals("space-a", NovaSpaceScope.standalone().id)
    }
}
