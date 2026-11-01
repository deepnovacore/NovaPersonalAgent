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
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.UnconfinedTestDispatcher
import kotlinx.coroutines.test.runTest
import org.junit.Test

class HelperHandoffTest {
    private class MemStore : NonceStore {
        var slots = NonceSlots()
        override fun load() = slots
        override fun save(slots: NonceSlots) { this.slots = slots }
    }

    private var now = 1_000L
    private var wall = 1_700_000_000_000L

    private fun nonces(store: NonceStore = MemStore()): HandoffNonces {
        var n = 0
        return HandoffNonces(store, clock = { now }, wallClock = { wall }) { "n${++n}" }
    }

    @OptIn(ExperimentalCoroutinesApi::class)
    @Test
    fun usbScriptIsRewrittenWithAFreshNonceWhenNoncesAreClearedWhileNoHelperIsConnected() = runTest {
        var n = 0
        val gate = HandoffNonces(MemStore(), clock = { now }, wallClock = { wall }) { "f00d%04d".format(++n) }
        val helper = MutableStateFlow<Any?>(null)
        val written = mutableListOf<String>()
        backgroundScope.launch(UnconfinedTestDispatcher(testScheduler)) {
            HelperHandoff.usbScriptWrites(helper, gate.resets).collect { connected ->
                written += HelperHandoff.usbFile(connected, "/a.apk", "p", 1, { "pin" }, gate::usbNonce, "/s.sh")
            }
        }
        assertEquals(1, written.size)
        val stale = gate.usbNonce()
        assertTrue(written[0].contains(stale))
        // 解除配对:助手一直不在,也要重写,新脚本里是新口令,旧的不再认
        gate.clear()
        assertEquals(2, written.size)
        assertFalse(written[1].contains(stale))
        assertFalse(gate.matches(stale))
        assertTrue(gate.matches(gate.usbNonce()))
        assertTrue(written[1].contains(gate.usbNonce()))
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

    // ---------- 用电脑经 USB 启动 ----------

    private val apk = "/data/app/~~x/com.nova.nova_mobile.autonomy-y/base.apk"
    private val scriptPath = "/storage/emulated/0/Android/data/com.nova.nova_mobile.autonomy/files/usb-start.sh"

    @Test
    fun usbCommandUsesTheShortSdcardPathForTheMainUser() {
        assertEquals("adb shell sh /sdcard/Android/data/com.nova.nova_mobile.autonomy/files/usb-start.sh", HelperHandoff.usbCommand(scriptPath))
        // 别的用户的存储照实际路径写
        assertEquals(
            "adb shell sh /storage/emulated/10/Android/data/com.nova.nova_mobile.autonomy/files/usb-start.sh",
            HelperHandoff.usbCommand("/storage/emulated/10/Android/data/com.nova.nova_mobile.autonomy/files/usb-start.sh"),
        )
    }

    @Test
    fun usbScriptStartsTheSameHelperDetachedWithTheNonceOnStdin() {
        val script = HelperHandoff.usbScript(apk, "com.nova.nova_mobile.autonomy", 10234, "ab'cd", "f00d", scriptPath)
        assertTrue(script.startsWith("#!/system/bin/sh\n"))
        // 和无线调试同一个入口、同样的参数;指纹里的单引号转义好;忽略挂断信号、另起会话、放到后台、输出丢掉
        assertTrue(
            script,
            script.contains(
                "(echo \"\$n\" | CLASSPATH='$apk' nohup setsid app_process /system/bin --nice-name='com.nova.nova_mobile.autonomy:helper' " +
                    "com.nova.nova_mobile.phone.shell.HelperMain 'com.nova.nova_mobile.autonomy' 10234 'ab'\\''cd' >/dev/null 2>&1 &)",
            ),
        )
        // 口令只在变量里,经内建 echo 走管道,不进命令行参数
        assertTrue(script.contains("\nn='f00d'\n"))
        assertEquals(1, script.split("f00d").size - 1)
        // 只有 shell 身份才起;APK 不在(更新过)就请用户先打开 Nova
        assertTrue(script.contains("if [ \"\$(id -u)\" != \"2000\" ]; then"))
        assertTrue(script.contains("if [ ! -f '$apk' ]; then"))
        // 等 setsid 生效再返回,并说清结果和怎么确认
        assertTrue(script.contains("\nsleep 2\n"))
        assertTrue(script.contains("if pidof 'com.nova.nova_mobile.autonomy:helper' >/dev/null 2>&1; then"))
        assertTrue(script.contains("Nova helper starting... Open Nova to confirm"))
        assertTrue(script.contains("adb shell sh /sdcard/Android/data/com.nova.nova_mobile.autonomy/files/usb-start.sh"))
        assertTrue(script.endsWith("fi\n"))
    }

    @Test
    fun usbScriptQuotesEverythingItInterpolates() {
        val script = HelperHandoff.usbScript("/a b/it's.apk", "p", 1, "pin", "n'; rm -rf /; '", scriptPath)
        assertTrue(script.contains("CLASSPATH='/a b/it'\\''s.apk'"))
        assertTrue(script.contains("n='n'\\''; rm -rf /; '\\'''"))
        assertFalse(script.contains("n='n'; rm"))
    }

    @Test
    fun connectedGetsAStubWithoutANonce() {
        var asked = 0
        val stub = HelperHandoff.usbFile(true, apk, "com.nova.nova_mobile.autonomy", 10234, { asked++; "pin" }, { asked++; "secret" }, scriptPath)
        assertEquals(0, asked)
        assertFalse(stub.contains("secret"))
        assertFalse(stub.contains("app_process"))
        assertTrue(stub.contains("already running"))
        assertTrue(stub.contains("pidof 'com.nova.nova_mobile.autonomy:helper'"))
        val live = HelperHandoff.usbFile(false, apk, "com.nova.nova_mobile.autonomy", 10234, { "pin" }, { "secret" }, scriptPath)
        assertTrue(live.contains("n='secret'"))
        assertTrue(live.contains("app_process"))
    }

    @Test
    fun usbNonceIsReusedWhileFreshAndHandsOffOnce() {
        val g = nonces()
        val usb = g.usbNonce()
        // 重写脚本时还新:沿用,电脑正在跑的那份不作废
        wall += HandoffNonces.USB_TTL_MS / 2
        assertEquals(usb, g.usbNonce())
        assertTrue(g.matches(usb))
        assertNotNull(g.accept(usb))
        // 用过就作废;下一份脚本是新口令
        assertNull(g.accept(usb))
        assertNotEquals(usb, g.usbNonce())
    }

    @Test
    fun usbNonceRotatesWhenHalfUsedAndExpires() {
        val g = nonces()
        val usb = g.usbNonce()
        wall += HandoffNonces.USB_TTL_MS / 2 + 1
        val fresh = g.usbNonce()
        assertNotEquals(usb, fresh)
        assertFalse(g.matches(usb))
        wall += HandoffNonces.USB_TTL_MS
        assertTrue(g.matches(fresh))
        wall += 1
        assertFalse(g.matches(fresh))
        assertNull(g.accept(fresh))
    }

    @Test
    fun usbNonceFromTheFutureIsNotTrusted() {
        val g = nonces()
        val usb = g.usbNonce()
        wall -= 1
        assertFalse(g.matches(usb))
    }

    @Test
    fun usbNonceSurvivesARebootButNotAnotherHandoff() {
        val store = MemStore()
        val usb = nonces(store).usbNonce()
        // 重启后开机计时归零,墙上时钟照走:脚本照样能用
        now = 0
        val g = nonces(store)
        assertTrue(g.matches(usb))
        // 无线调试那边起的助手先被收下:脚本里的口令作废
        assertNotNull(g.accept(g.issueLaunch()))
        assertFalse(g.matches(usb))
        assertNull(store.slots.usb)
    }

    @Test
    fun clearVoidsTheUsbNonce() {
        val g = nonces()
        val usb = g.usbNonce()
        g.clear()
        assertFalse(g.matches(usb))
    }
}
