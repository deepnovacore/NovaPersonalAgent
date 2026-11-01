// Derived from Mika (https://github.com/wangzan101/Mika, Apache-2.0, commit 5f630d9),
// Copyright 2026 wangzan101. Modified by Nova: restricted Binder subset and own-display enforcement.
package com.nova.nova_mobile.phone.shell

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 建虚拟屏的标志:有可信屏权限时和原来完全一样;没有时(有的系统里 shell 没有 ADD_TRUSTED_DISPLAY)
 * 只去掉依赖它的那几项,其余照旧。只有 SecurityException 才值得退回。
 */
class DisplayFlagsTest {
    // DisplayManager.VIRTUAL_DISPLAY_FLAG_*
    private val public = 1 shl 0
    private val ownContentOnly = 1 shl 3
    private val supportsTouch = 1 shl 6
    private val rotatesWithContent = 1 shl 7
    private val destroyContentOnRemoval = 1 shl 8
    private val trusted = 1 shl 10
    private val ownDisplayGroup = 1 shl 11
    private val alwaysUnlocked = 1 shl 12
    private val touchFeedbackDisabled = 1 shl 13
    private val ownFocus = 1 shl 14
    private val stealTopFocusDisabled = 1 shl 16

    private val base = public or ownContentOnly or supportsTouch or rotatesWithContent or destroyContentOnRemoval

    @Test fun trustedFlagsOnAndroid14AreUnchanged() {
        assertEquals(
            base or touchFeedbackDisabled or trusted or ownDisplayGroup or alwaysUnlocked or ownFocus or stealTopFocusDisabled,
            NovaShellService.displayFlags(sdk = 34, trusted = true),
        )
    }

    @Test fun untrustedFlagsOnAndroid14DropOnlyTheTrustedOnes() {
        val flags = NovaShellService.displayFlags(sdk = 34, trusted = false)
        assertEquals(base or touchFeedbackDisabled, flags)
        // 不能带上的几项
        for (bit in listOf(trusted, ownDisplayGroup, alwaysUnlocked, ownFocus, stealTopFocusDisabled)) {
            assertEquals("flag $bit must be dropped", 0, flags and bit)
        }
        // 不依赖可信屏的照旧留下
        for (bit in listOf(public, ownContentOnly, supportsTouch, rotatesWithContent, destroyContentOnRemoval, touchFeedbackDisabled)) {
            assertEquals("flag $bit must stay", bit, flags and bit)
        }
    }

    @Test fun untrustedFlagsOnAndroid13KeepOnlyTouchFeedbackFromTheVersionSpecificOnes() {
        assertEquals(
            base or touchFeedbackDisabled or trusted or ownDisplayGroup or alwaysUnlocked,
            NovaShellService.displayFlags(sdk = 33, trusted = true),
        )
        assertEquals(base or touchFeedbackDisabled, NovaShellService.displayFlags(sdk = 33, trusted = false))
    }

    @Test fun olderSystemsKeepTheBaseFlagsEitherWay() {
        assertEquals(base, NovaShellService.displayFlags(sdk = 32, trusted = true))
        assertEquals(base, NovaShellService.displayFlags(sdk = 32, trusted = false))
    }

    @Test fun onlySecurityExceptionGetsTheFallback() {
        assertTrue(NovaShellService.retryWithoutTrust(SecurityException("no ADD_TRUSTED_DISPLAY")))
        assertFalse(NovaShellService.retryWithoutTrust(IllegalStateException("create failed")))
        assertFalse(NovaShellService.retryWithoutTrust(RuntimeException("other")))
        assertFalse(NovaShellService.retryWithoutTrust(Throwable("other")))
    }
}
