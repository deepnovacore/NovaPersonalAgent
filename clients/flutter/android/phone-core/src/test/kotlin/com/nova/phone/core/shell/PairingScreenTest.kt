// Derived from Mika (https://github.com/wangzan101/Mika, Apache-2.0, commit 5f630d9),
// Copyright 2026 wangzan101. Modified by Nova: package names and scoped native phone integration.
package com.nova.phone.core.shell

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class PairingScreenTest {
    private fun read(vararg texts: String) = PairingScreen.read(texts.toList())

    @Test
    fun readsCodeAndPortFromATypicalPairingWindow() {
        val r = read("Pair with device", "Wi-Fi pairing code", "482 913", "IP address & Port", "192.168.1.23:37145", "Cancel")
        assertEquals(PairingScreenReading("482913", 37145), r)
    }

    @Test
    fun codeMustBeTheWholeTextExactlySixDigits() {
        assertEquals("123456", read("123456").code)
        assertEquals("123456", read("  12 34 56 ").code)
        assertEquals("123456", read("123 456").code)
        assertNull(read("12345").code)
        assertNull(read("1234567").code)
        assertNull(read("代码 123456").code)
        assertNull(read("123-456").code)
        assertNull(read("20241024").code)
        assertNull(read("12:30").code)
        assertNull(read("13").code)
    }

    @Test
    fun ignoresVersionNumbersTimesAndOtherNumbers() {
        val r = read("Android 13", "12:30", "Version 13.0.1", "100%", "482913", "Build 1234567", "10.0.0.5:5555")
        assertEquals(PairingScreenReading("482913", 5555), r)
    }

    @Test
    fun twoDifferentCodesOnOneWindowAreAmbiguous() {
        assertNull(read("111111", "222222", "10.0.0.2:40000").code)
        // 同一个码出现两次(比如标题和正文)不算歧义
        assertEquals("111111", read("111111", "111 111").code)
    }

    @Test
    fun portPatterns() {
        assertEquals(37000, read("192.168.0.4:37000").port)
        assertEquals(37000, read("IP 地址和端口\n192.168.0.4:37000").port)
        assertEquals(41001, read("[fe80::1c2d:3eff:fe4f:5a6b]:41001").port)
        assertEquals(41001, read("[fe80::1%wlan0]:41001").port)
        assertEquals(1, read("10.0.0.1:1").port)
        assertEquals(65535, read("10.0.0.1:65535").port)
        assertNull(read("10.0.0.1:0").port)
        assertNull(read("10.0.0.1:65536").port)
        assertNull(read("10.0.0.1:123456").port)
        assertNull(read("300.1.1.1:4000").port)
        assertNull(read("12:30").port)
        assertNull(read("1.2.3:4000").port)
        assertNull(read("fe80::1:4000").port)
        assertNull(read("v1.2.3.4:5000a").port)
    }

    @Test
    fun twoDifferentPortsOnOneWindowAreAmbiguous() {
        assertNull(read("192.168.0.4:37000", "192.168.0.4:41000").port)
        assertEquals(37000, read("192.168.0.4:37000", "192.168.0.4:37000").port)
    }

    @Test
    fun nothingToRead() {
        assertEquals(PairingScreenReading(null, null), read())
        assertEquals(PairingScreenReading(null, null), read("", "  ", "Wireless debugging"))
    }

    @Test
    fun attemptsOnlyWithAPortAndANewCode() {
        val both = PairingScreenReading("482913", 37145)
        val codeOnly = PairingScreenReading("482913", null)
        val idle = BuiltinShellStatus.NotPaired
        assertEquals(PairingAttempt("482913", 37145), PairingScreen.attempt(both, portFound = false, status = idle, tried = emptySet()))
        // 屏上没读到端口:已经找到配对窗口时用找到的那个
        assertEquals(PairingAttempt("482913", null), PairingScreen.attempt(codeOnly, portFound = true, status = idle, tried = emptySet()))
        assertNull(PairingScreen.attempt(codeOnly, portFound = false, status = idle, tried = emptySet()))
        assertNull(PairingScreen.attempt(PairingScreenReading(null, 37145), portFound = true, status = idle, tried = emptySet()))
        // 试过的码(比如码不对)不再试,换了新码才试
        val wrong = BuiltinShellStatus.Failed(BuiltinShellFailure.WrongCode)
        assertNull(PairingScreen.attempt(both, portFound = true, status = wrong, tried = setOf("482913")))
        assertEquals(
            PairingAttempt("555666", 37145),
            PairingScreen.attempt(both.copy(code = "555666"), portFound = true, status = wrong, tried = setOf("482913")),
        )
    }

    @Test
    fun noAttemptWhilePairingOrDone() {
        val both = PairingScreenReading("482913", 37145)
        listOf(BuiltinShellStatus.Connecting, BuiltinShellStatus.Running, BuiltinShellStatus.Failed(BuiltinShellFailure.HelperStartFailed))
            .forEach { assertNull(it.toString(), PairingScreen.attempt(both, portFound = true, status = it, tried = emptySet())) }
        assertEquals(
            PairingAttempt("482913", 37145),
            PairingScreen.attempt(both, portFound = true, status = BuiltinShellStatus.Failed(BuiltinShellFailure.AuthorizationRevoked), tried = emptySet()),
        )
    }
}
