package com.nova.nova_mobile.phone.shell

import org.junit.Assert.*
import org.junit.Test

class NovaShellServiceTest {
    @Test fun takeoverCannotMoveUnrelatedTasksOrTargetForeignDisplays() {
        val own = setOf(8, 9)
        val moved = setOf(100)
        assertTrue(NovaShellService.allowsTaskMove(100, 8, 0, own, emptySet()))
        assertTrue(NovaShellService.allowsTaskMove(100, 0, 8, own, moved))
        assertFalse(NovaShellService.allowsTaskMove(101, 0, 8, own, moved))
        assertFalse(NovaShellService.allowsTaskMove(100, 7, 8, own, moved))
        assertFalse(NovaShellService.allowsTaskMove(100, 8, 7, own, moved))
        assertFalse(NovaShellService.allowsTaskMove(100, 8, 9, own, moved))
        assertFalse(NovaShellService.allowsTaskMove(100, -1, 8, own, moved))
        assertFalse(NovaShellService.allowsTaskMove(100, 0, 8, emptySet(), moved))
    }
    @Test fun onlyNavigationAndEditingKeysAreAllowed() {
        assertEquals(setOf(19, 20, 21, 22, 23, 66, 160, 67, 112, 61, 62, 111, 92, 93, 122, 123, 4, 82), NovaShellService.ALLOWED_KEYS)
        // HOME, volume, power, camera, media, recents, assist.
        listOf(3, 24, 25, 26, 27, 79, 85, 86, 87, 88, 164, 187, 219).forEach {
            assertFalse(it in NovaShellService.ALLOWED_KEYS)
        }
    }
    @Test fun failedDownUsesFallbackWithoutSendingUp() {
        val calls = mutableListOf<String>()
        assertTrue(NovaShellService.injectDownUp({ calls += "down"; false }, { calls += "up"; true }, { calls += "fallback"; true }))
        assertEquals(listOf("down", "fallback"), calls)
    }
    @Test fun successfulDownNeverRepeatsTheWholeTapWhenUpFails() {
        val calls = mutableListOf<String>()
        assertFalse(NovaShellService.injectDownUp({ calls += "down"; true }, { calls += "up"; false }, { calls += "fallback"; true }))
        assertEquals(listOf("down", "up", "up"), calls)
    }
    @Test fun successfulUpIsNotRepeated() {
        var ups = 0
        assertTrue(NovaShellService.injectDownUp({ true }, { ups++; true }, { error("must not repeat") }))
        assertEquals(1, ups)
    }
}
