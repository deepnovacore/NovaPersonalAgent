// Derived from Mika (https://github.com/wangzan101/Mika, Apache-2.0, commit 5f630d9),
// Copyright 2026 wangzan101. Modified by Nova: package names and scoped native phone integration.
package com.nova.nova_mobile.phone.setup

import android.app.NotificationManager
import com.nova.phone.core.shell.BuiltinShellFailure
import com.nova.phone.core.shell.BuiltinShellStatus
import com.nova.phone.core.shell.PairingChannelHealth
import com.nova.phone.core.shell.PairingDiscovery
import com.nova.phone.core.shell.PairingScreen
import com.nova.phone.core.shell.PairingScreenReading
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.Before
import org.junit.After
import java.util.Locale

class PairingNoticeTest {
    private lateinit var originalLocale: Locale
    @Before fun useEnglishCopy() { originalLocale = Locale.getDefault(); Locale.setDefault(Locale.ENGLISH) }
    @After fun restoreLocale() { Locale.setDefault(originalLocale) }


    @Test
    fun codeEntryAppearsOnlyOnceThePairingWindowIsFound() {
        assertNull(PairingNotice.of(BuiltinShellStatus.NotPaired, PairingDiscovery.Searching))
        assertEquals(PairingNotice.EnterCode(37001), PairingNotice.of(BuiltinShellStatus.NotPaired, PairingDiscovery.Found(37001)))
    }

    @Test
    fun enterCodeThenPairingThenSuccess() {
        val found = PairingDiscovery.Found(1)
        assertEquals(PairingNotice.EnterCode(1), PairingNotice.of(BuiltinShellStatus.NotPaired, found))
        assertEquals(PairingNotice.Working, PairingNotice.of(BuiltinShellStatus.Connecting, found))
        assertEquals(PairingNotice.Done, PairingNotice.of(BuiltinShellStatus.Running, PairingDiscovery.Idle))
    }

    @Test
    fun pairingFailuresKeepTheInputWithHowToRetry() {
        assertEquals(
            PairingNotice.EnterCode(5, "Code incorrect or expired. Open a new pairing window and enter the new code."),
            PairingNotice.of(BuiltinShellStatus.Failed(BuiltinShellFailure.WrongCode), PairingDiscovery.Found(5)),
        )
        // 窗口关了(找不到配对窗口)也留着输入框,说同样的办法
        val closed = PairingNotice.of(BuiltinShellStatus.Failed(BuiltinShellFailure.PairingWindowClosed), PairingDiscovery.Searching)
        closed as PairingNotice.EnterCode
        assertNull(closed.port)
        assertTrue(closed.error!!.endsWith("enter the new code."))
        // 配对之后的失败请用户回 Nova
        assertEquals(
            PairingNotice.Problem("Helper could not start"),
            PairingNotice.of(BuiltinShellStatus.Failed(BuiltinShellFailure.HelperStartFailed), PairingDiscovery.Found(5)),
        )
    }

    /** 配对失效:引导页让用户重新配对,找到配对窗口后和没配对时一样给输入框;还没找到时照旧请用户回 Nova。 */
    @Test
    fun revokedPairingGetsTheInputOnceThePairingWindowIsFound() {
        val revoked = BuiltinShellStatus.Failed(BuiltinShellFailure.AuthorizationRevoked)
        assertEquals(PairingNotice.EnterCode(37001), PairingNotice.of(revoked, PairingDiscovery.Found(37001)))
        assertEquals(PairingNotice.Problem("Pairing authorization expired"), PairingNotice.of(revoked, PairingDiscovery.Searching))
        assertEquals(PairingNotice.Problem("Pairing authorization expired"), PairingNotice.of(revoked, PairingDiscovery.Idle))

    }

    /** 找到配对窗口时,通知给不给输入框和无障碍读到码后试不试(PairingScreen.attempt)对每种状态都一致。 */
    @Test
    fun codeInputMatchesWhatAutoReadWouldTry() {
        val reading = PairingScreenReading("123456", null)
        val statuses = listOf(
            BuiltinShellStatus.NotPaired, BuiltinShellStatus.WirelessDebuggingOff, BuiltinShellStatus.Connecting, BuiltinShellStatus.Running,
        ) + BuiltinShellFailure.entries.map { BuiltinShellStatus.Failed(it) }
        statuses.forEach { s ->
            val input = PairingNotice.of(s, PairingDiscovery.Found(5)) is PairingNotice.EnterCode
            assertEquals(s.toString(), PairingScreen.attempt(reading, portFound = true, s, emptySet()) != null, input)
        }
    }

    @Test
    fun codeEntryPopsAtOnceWithoutAccessibilityAndWaitsForAutoRead() {
        val enter = PairingNotice.EnterCode(5)
        assertEquals(0L, PairingNotice.delayBefore(enter, autoRead = false))
        assertEquals(PairingNotice.AUTO_READ_GRACE_MS, PairingNotice.delayBefore(enter, autoRead = true))
        assertEquals(0L, PairingNotice.delayBefore(PairingNotice.Working, autoRead = true))
    }

    @Test
    fun realertsAreCappedAtThree() {
        val enter = PairingNotice.EnterCode(5)
        val waits = generateSequence(0) { it + 1 }.map { PairingNotice.realertAfter(enter, it) }.takeWhile { it != null }.toList()
        assertEquals(3, waits.size)
        assertEquals(PairingNotice.MAX_REALERTS, waits.size)
        // 越往后隔得越久
        assertEquals(waits.filterNotNull().sorted(), waits)
        // 填错后的提示也会再提醒;别的状态不提醒
        assertEquals(PairingNotice.REALERT_MS[0], PairingNotice.realertAfter(PairingNotice.EnterCode(5, "x"), 0))
        listOf(PairingNotice.Working, PairingNotice.Done, PairingNotice.Problem("x")).forEach { assertNull(PairingNotice.realertAfter(it, 0)) }
    }

    @Test
    fun aSubmittedCodeShowsPairingUntilThePairingStarts() {
        val revoked = BuiltinShellStatus.Failed(BuiltinShellFailure.AuthorizationRevoked)
        // 填了码、配对还没开始:不按填码前的状态算,也不结束(助手原本在运行时也一样,配对开始后状态还会变)
        assertEquals(PairingNotice.Working to false, PairingNotice.follow(revoked, PairingDiscovery.Searching, repairing = false, submitted = true))
        assertEquals(PairingNotice.Working to false, PairingNotice.follow(BuiltinShellStatus.Running, PairingDiscovery.Searching, repairing = false, submitted = true))
        // 没填码时照常按状态算
        assertEquals(PairingNotice.Problem("Pairing authorization expired") to false, PairingNotice.follow(revoked, PairingDiscovery.Searching, repairing = false, submitted = false))
    }

    @Test
    fun followingEndsOnlyWhenRunningOutsideARepair() {
        // 重新配对时运行中的旧状态不算配好:不发、不结束
        assertEquals(null to false, PairingNotice.follow(BuiltinShellStatus.Running, PairingDiscovery.Searching, repairing = true, submitted = false))
        assertEquals(PairingNotice.Done to true, PairingNotice.follow(BuiltinShellStatus.Running, PairingDiscovery.Idle, repairing = false, submitted = false))
    }

    @Test
    fun channelIsCreatedHighWhenMissing() {
        assertEquals(ChannelPlan.Create(PairingChannel.IDS.last()), PairingChannel.plan(emptyList()))
        assertEquals(PairingChannelHealth.Ready, PairingChannel.plan(emptyList()).health)
    }

    @Test
    fun channelKeepsWhatWorksMigratesOldOnesAndRespectsTheUser() {
        val old = PairingChannel.IDS.first()
        val new = PairingChannel.IDS.last()
        // 旧版本建的、够高:接着用,不换 id
        assertEquals(
            ChannelPlan.Use(old, PairingChannelHealth.Ready),
            PairingChannel.plan(listOf(ChannelSnapshot(old, NotificationManager.IMPORTANCE_HIGH, userSet = false))),
        )
        // 旧版本建得不够高、用户没动过:换新 id 重建
        assertEquals(
            ChannelPlan.Create(new),
            PairingChannel.plan(listOf(ChannelSnapshot(old, NotificationManager.IMPORTANCE_DEFAULT, userSet = false))),
        )
        // 用户自己调低:不改回去,提示
        assertEquals(
            ChannelPlan.Use(old, PairingChannelHealth.Lowered),
            PairingChannel.plan(listOf(ChannelSnapshot(old, NotificationManager.IMPORTANCE_DEFAULT, userSet = true))),
        )
        // 用户关掉:发不出来
        assertEquals(
            ChannelPlan.Use(new, PairingChannelHealth.Off),
            PairingChannel.plan(listOf(ChannelSnapshot(new, NotificationManager.IMPORTANCE_NONE, userSet = true))),
        )
        // 最新的 id 也不够高、又没有更新的可换:只能提示
        assertEquals(
            ChannelPlan.Use(new, PairingChannelHealth.Lowered),
            PairingChannel.plan(listOf(ChannelSnapshot(new, NotificationManager.IMPORTANCE_LOW, userSet = false))),
        )
        // 新旧都在时看新的
        assertEquals(
            ChannelPlan.Use(new, PairingChannelHealth.Ready),
            PairingChannel.plan(
                listOf(
                    ChannelSnapshot(old, NotificationManager.IMPORTANCE_LOW, userSet = true),
                    ChannelSnapshot(new, NotificationManager.IMPORTANCE_HIGH, userSet = false),
                ),
            ),
        )
    }
}
