// Derived from Mika (https://github.com/wangzan101/Mika, Apache-2.0, commit 5f630d9),
// Copyright 2026 wangzan101. Modified by Nova: package names and scoped native phone integration.
package com.nova.phone.core.shell

import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.UnconfinedTestDispatcher
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class HelperLinkTest {
    private val source = MutableStateFlow<String?>(null)
    private val log = mutableListOf<String>()

    private fun TestScope.link() = HelperLink(
        source, backgroundScope,
        release = { log += "release $it" },
        need = { log += "need" },
    )

    @Test
    fun publishesOnlyWhileBound() = runTest {
        val l = link()
        source.value = "A"
        runCurrent()
        assertNull(l.shell.value)
        l.bind()
        runCurrent()
        assertEquals("A", l.shell.value)
        l.unbind()
        assertNull(l.shell.value)
        runCurrent()
        // 解绑让助手撤掉改动,但助手(和它的 Binder)还在
        assertEquals(listOf("release A"), log)
        assertEquals("A", source.value)
    }

    @Test
    fun asksForHelperWhenBoundWithoutOne() = runTest {
        val l = link()
        l.bind()
        runCurrent()
        assertEquals(listOf("need"), log)
        assertFalse(l.dropped.value)
        source.value = "A"
        runCurrent()
        assertEquals("A", l.shell.value)
    }

    @Test
    fun droppedAfterLossThenClearedOnReturn() = runTest {
        val l = link()
        source.value = "A"
        l.bind()
        runCurrent()
        source.value = null
        runCurrent()
        assertNull(l.shell.value)
        assertTrue(l.dropped.value)
        assertEquals(listOf("need"), log)
        source.value = "B"
        runCurrent()
        assertEquals("B", l.shell.value)
        assertFalse(l.dropped.value)
        source.value = null
        runCurrent()
        l.unbind()
        assertFalse(l.dropped.value)
        runCurrent()
        // 断着的时候解绑:没有能撤销的对象
        assertEquals(listOf("need", "need"), log)
    }

    @Test
    fun releaseOfPreviousBindingRunsBeforeTheNextPublish() = runTest {
        val l = link()
        source.value = "A"
        l.bind()
        runCurrent()
        l.unbind()
        l.bind()
        backgroundScope.launch(UnconfinedTestDispatcher(testScheduler)) {
            l.shell.collect { if (it != null) log += "publish $it" }
        }
        runCurrent()
        assertEquals(listOf("release A", "publish A"), log)
    }

    @Test
    fun reconnectOnlyWhenBoundAndMissing() = runTest {
        val l = link()
        l.reconnect()
        assertTrue(log.isEmpty())
        source.value = "A"
        l.bind()
        runCurrent()
        l.reconnect()
        assertTrue(log.isEmpty())
        source.value = null
        runCurrent()
        log.clear()
        l.reconnect()
        assertEquals(listOf("need"), log)
    }
}
