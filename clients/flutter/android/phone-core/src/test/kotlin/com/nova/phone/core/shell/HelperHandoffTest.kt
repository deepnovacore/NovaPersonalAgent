// Derived from Mika (https://github.com/wangzan101/Mika, Apache-2.0, commit 5f630d9),
// Copyright 2026 wangzan101. Modified by Nova: package names and scoped native phone integration.
package com.nova.phone.core.shell

import com.nova.phone.core.shell.HelperHandoff.Reject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class HelperHandoffTest {
    private class MemStore : NonceStore {
        var slots = NonceSlots()
        override fun load() = slots
        override fun save(slots: NonceSlots) { this.slots = slots }
    }

    private var now = 1_000L

    private fun nonces(store: NonceStore = MemStore()): HandoffNonces {
        var n = 0
        return HandoffNonces(store, clock = { now }) { "n${++n}" }
    }

    @Test
    fun onlyShellWithMatchingIdsAndCurrentApkPasses() {
        fun check(uid: Int = 2000, pid: Int = 77, rUid: Int = uid, rPid: Int = pid, apk: String? = "/a.apk", binder: Boolean = true) =
            HelperHandoff.check(uid, pid, rUid, rPid, apk, "/a.apk", binder)
        assertNull(check())
        assertEquals(Reject.NotShell, check(uid = 10123))
        assertEquals(Reject.NotShell, check(uid = 0))
        assertEquals(Reject.IdMismatch, check(rPid = 78))
        assertEquals(Reject.IdMismatch, check(rUid = 0))
        assertEquals(Reject.StaleApk, check(apk = "/old.apk"))
        assertEquals(Reject.StaleApk, check(apk = null))
        assertEquals(Reject.NoBinder, check(binder = false))
    }

    @Test
    fun launchNonceIsSingleUseAndRotates() {
        val g = nonces()
        val launch = g.issueLaunch()
        assertFalse(g.matches("nope"))
        assertFalse(g.matches(null))
        assertTrue(g.matches(launch))
        val next = g.accept(launch)
        assertNotNull(next)
        assertNotEquals(launch, next)
        // 用过就不认了
        assertNull(g.accept(launch))
        // 换发的口令也只能用一次
        val after = g.accept(next)
        assertNotNull(after)
        assertNull(g.accept(next))
    }

    @Test
    fun acceptingEitherSlotVoidsTheOther() {
        val g = nonces()
        val resume = g.accept(g.issueLaunch())!!
        val launch = g.issueLaunch()
        // 旧助手先交接:新起的那个口令作废,它会被拒绝并自己退出
        assertNotNull(g.accept(resume))
        assertNull(g.accept(launch))

        val resume2 = g.accept(g.issueLaunch())!!
        val launch2 = g.issueLaunch()
        assertNotNull(g.accept(launch2))
        assertNull(g.accept(resume2))
    }

    @Test
    fun resumeNonceSurvivesProcessRestart() {
        val store = MemStore()
        val resume = nonces(store).accept(nonces(store).issueLaunch())
        // 新进程:新对象读同一份存储
        assertNotNull(nonces(store).accept(resume))
    }

    @Test
    fun clearVoidsEverything() {
        val g = nonces()
        val launch = g.issueLaunch()
        g.clear()
        assertNull(g.accept(launch))
    }

    @Test
    fun randomNoncesAreLongAndDistinct() {
        val a = HandoffNonces.randomNonce()
        assertEquals(64, a.length)
        assertNotEquals(a, HandoffNonces.randomNonce())
    }

    @Test
    fun unusedLaunchNonceExpires() {
        val g = nonces()
        val launch = g.issueLaunch()
        now += HandoffNonces.LAUNCH_TTL_MS
        assertTrue(g.matches(launch))
        now += 1
        assertFalse(g.matches(launch))
        assertNull(g.accept(launch))
    }

    @Test
    fun launchNonceFromTheFutureIsNotTrusted() {
        // 记录的签发时间晚于现在(比如重启后时钟从零开始):当作过期
        val store = MemStore()
        val launch = nonces(store).issueLaunch()
        now -= 1
        assertFalse(nonces(store).matches(launch))
    }

    @Test
    fun resumeNonceDoesNotExpire() {
        val g = nonces()
        val resume = g.accept(g.issueLaunch())
        now += 10 * HandoffNonces.LAUNCH_TTL_MS
        assertNotNull(g.accept(resume))
    }

    @Test
    fun commandRunsHelperDetachedAndFeedsNonceThroughStdin() {
        val cmd = HelperHandoff.command("/data/app/~~x/com.nova.nova_mobile.autonomy-y/base.apk", "com.nova.nova_mobile.autonomy", 10234, "ab'cd")
        assertEquals(
            "read n; (echo \"\$n\" | CLASSPATH='/data/app/~~x/com.nova.nova_mobile.autonomy-y/base.apk' setsid app_process /system/bin " +
                "--nice-name='com.nova.nova_mobile.autonomy:helper' com.nova.nova_mobile.phone.shell.HelperMain " +
                "'com.nova.nova_mobile.autonomy' 10234 'ab'\\''cd' >/dev/null 2>&1 &); read _",
            cmd,
        )
        assertEquals("com.nova.nova_mobile.autonomy.helper", HelperHandoff.authority("com.nova.nova_mobile.autonomy"))
    }

    @Test
    fun nonceGoesOnItsOwnLine() {
        assertEquals("abc\n", String(HelperHandoff.stdinLine("abc"), Charsets.UTF_8))
    }

    @Test
    fun certPinIsSha256HexAndIgnoresSignerOrder() {
        val a = "abc".toByteArray()
        val b = "xyz".toByteArray()
        assertEquals("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad", HelperHandoff.certPin(listOf(a)))
        assertEquals(HelperHandoff.certPin(listOf(a, b)), HelperHandoff.certPin(listOf(b, a)))
        assertNotEquals(HelperHandoff.certPin(listOf(a)), HelperHandoff.certPin(listOf(a, b)))
        assertNull(HelperHandoff.certPin(emptyList()))
        assertNull(HelperHandoff.certPin(null))
    }

}
