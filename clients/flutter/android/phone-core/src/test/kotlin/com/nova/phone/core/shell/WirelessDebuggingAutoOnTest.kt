// Derived from Mika (https://github.com/wangzan101/Mika, Apache-2.0, commit 5f630d9),
// Copyright 2026 wangzan101. Modified by Nova: package names and scoped native phone integration.
package com.nova.phone.core.shell

import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class WirelessDebuggingAutoOnTest {
    /** 假的系统开关:[revert] 为 true 时写了打开过一会儿又被系统拨回关着(不允许的 Wi-Fi)。 */
    private inner class FakeSwitch {
        var on: Boolean? = false
        var revert = false
        var refuse = false
        var throws = false
        var writes = 0
        private var readsSinceWrite = 0

        fun read(): Boolean? {
            // 原版收到设置变化后才拨回:写完先读到打开,随后读到关着
            if (revert && on == true && ++readsSinceWrite > 1) on = false
            return on
        }

        fun write(): Boolean {
            writes++
            if (throws) throw SecurityException("denied")
            if (refuse) return false
            on = true
            readsSinceWrite = 0
            return true
        }
    }

    private val switch = FakeSwitch()
    private var wants = true
    private var canWrite = true
    private var clock = 0L

    private fun TestScope.autoOn() = WirelessDebuggingAutoOn(
        wants = { wants }, canWrite = { canWrite }, read = switch::read, write = switch::write,
        now = { clock + testScheduler.currentTime },
    )

    @Test
    fun decideNeedsConsentPermissionAndWifi() {
        fun d(wants: Boolean = true, canWrite: Boolean = true, wifi: Boolean = true, blocked: AutoOnBlock? = null, writes: Int = 0, since: Long = Long.MAX_VALUE) =
            WirelessDebuggingAutoOn.decide(wants, canWrite, wifi, blocked, writes, since)

        assertEquals(AutoOnGate.Act, d())
        // 用户关掉了这一项:不管别的,一律不写
        assertEquals(AutoOnGate.Skip(AutoOnSkip.Declined), d(wants = false, blocked = AutoOnBlock.NotAllowedHere, wifi = false))
        assertEquals(AutoOnGate.Skip(AutoOnSkip.NoPermission), d(canWrite = false))
        assertEquals(AutoOnGate.Skip(AutoOnSkip.NoWifi), d(wifi = false))
        AutoOnBlock.entries.forEach { assertEquals(AutoOnGate.Skip(AutoOnSkip.Blocked), d(blocked = it)) }
        assertEquals(AutoOnGate.Skip(AutoOnSkip.Blocked), d(writes = WirelessDebuggingAutoOn.MAX_WRITES))
    }

    @Test
    fun writesAreSpacedOutWithBackoff() {
        assertEquals(
            listOf(0L, 10_000L, 20_000L, 40_000L),
            (0..3).map(WirelessDebuggingAutoOn::gapAfter),
        )
        assertEquals(WirelessDebuggingAutoOn.MAX_GAP_MS, WirelessDebuggingAutoOn.gapAfter(30))
        assertEquals(AutoOnGate.Wait(6_000), WirelessDebuggingAutoOn.decide(true, true, true, null, 1, 4_000))
        assertEquals(AutoOnGate.Act, WirelessDebuggingAutoOn.decide(true, true, true, null, 1, 10_000))
    }

    @Test
    fun turnsOnAndStaysOnOnAnAllowedNetwork() = runTest {
        val a = autoOn()
        assertEquals(AutoOnGate.Act, a.gate(wifi = true))
        assertTrue(a.turnOn())
        assertEquals(true, switch.on)
        assertNull(a.blocked.value)
        assertFalse(a.writing)
        // 紧接着又要写:按退避等
        assertTrue(a.gate(wifi = true) is AutoOnGate.Wait)
    }

    @Test
    fun revertedBySystemStopsUntilReset() = runTest {
        switch.revert = true
        val a = autoOn()
        assertFalse(a.turnOn())
        assertEquals(AutoOnBlock.NotAllowedHere, a.blocked.value)
        assertEquals(false, switch.on)
        // 停下后过多久都不再写(每写一次系统就弹一次框)
        clock += 3_600_000
        assertEquals(AutoOnGate.Skip(AutoOnSkip.Blocked), a.gate(wifi = true))
        assertEquals(1, switch.writes)

        // 换了 Wi-Fi、用户亲手打开或点了重试:从头算
        a.reset()
        assertNull(a.blocked.value)
        assertEquals(AutoOnGate.Act, a.gate(wifi = true))
    }

    @Test
    fun refusedWriteStops() = runTest {
        switch.refuse = true
        val a = autoOn()
        assertFalse(a.turnOn())
        assertEquals(AutoOnBlock.Refused, a.blocked.value)

        a.reset()
        switch.refuse = false
        switch.throws = true
        assertFalse(a.turnOn())
        assertEquals(AutoOnBlock.Refused, a.blocked.value)
        assertFalse(a.writing)
    }

    @Test
    fun givesUpAfterTooManyWritesWithoutTheHelper() = runTest {
        val a = autoOn()
        repeat(WirelessDebuggingAutoOn.MAX_WRITES) {
            clock += 3_600_000
            assertEquals(AutoOnGate.Act, a.gate(wifi = true))
            assertTrue(a.turnOn())
            // 系统(或别的原因)又把它关了,助手没起来
            switch.on = false
        }
        clock += 3_600_000
        assertEquals(AutoOnGate.Skip(AutoOnSkip.Blocked), a.gate(wifi = true))
        assertEquals(AutoOnBlock.GaveUp, a.blocked.value)
        // 助手起来了(引擎调 reset):重新计数
        a.reset()
        assertEquals(AutoOnGate.Act, a.gate(wifi = true))
    }

    @Test
    fun consentOffNeverWrites() = runTest {
        wants = false
        val a = autoOn()
        assertEquals(AutoOnGate.Skip(AutoOnSkip.Declined), a.gate(wifi = true))
        assertEquals(0, switch.writes)
    }
}
