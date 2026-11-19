// Derived from Mika (https://github.com/wangzan101/Mika, Apache-2.0, commit 5f630d9),
// Copyright 2026 wangzan101. Modified by Nova: threads instead of coroutines, close() tests.
package com.nova.nova_mobile.phone.display

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger

class LazyDisplayTest {
    private class Screen

    @Test fun notCreatedUntilAsked() {
        var made = 0
        val d = LazyDisplay(720, 1600) { made++; Screen() }
        assertNull(d.current)
        assertEquals(0, made)
        assertEquals(720, d.width)
        assertEquals(1600, d.height)
    }

    @Test fun createdOnceOnFirstGetAcrossThreads() {
        val made = AtomicInteger()
        val d = LazyDisplay(720, 1600) { made.incrementAndGet(); Thread.sleep(10); Screen() }
        val start = CountDownLatch(1)
        val pool = Executors.newFixedThreadPool(5)
        val got = (1..5).map { pool.submit<Screen> { start.await(); d.get() } }
        start.countDown()
        val screens = got.map { it.get(5, TimeUnit.SECONDS) }
        pool.shutdown()
        assertEquals(1, made.get())
        assertTrue(screens.all { it === screens[0] })
        assertSame(screens[0], d.current)
        assertSame(screens[0], d.get())
        assertEquals(1, made.get())
    }

    @Test fun failedCreationIsRetried() {
        var tries = 0
        val d = LazyDisplay(720, 1600) { if (++tries == 1) throw IllegalStateException("display_unavailable"); Screen() }
        runCatching { d.get() }
        assertNull(d.current)
        d.get()
        assertEquals(2, tries)
    }

    @Test fun closeHandsBackTheDisplayOnceAndBlocksRecreation() {
        var made = 0
        val d = LazyDisplay(720, 1600) { made++; Screen() }
        val screen = d.get()
        assertSame(screen, d.close())
        assertNull(d.current)
        assertNull(d.close())
        try { d.get(); fail("display recreated after the run ended") } catch (e: IllegalStateException) {
            assertEquals("display_unavailable", e.message)
        }
        assertEquals(1, made)
    }

    @Test fun closeBeforeCreationNeverCreates() {
        var made = 0
        val d = LazyDisplay(720, 1600) { made++; Screen() }
        assertNull(d.close())
        runCatching { d.get() }
        assertEquals(0, made)
    }
}
