// Derived from Mika (https://github.com/wangzan101/Mika, Apache-2.0, commit 5f630d9),
// Copyright 2026 wangzan101. Modified by Nova: package names and scoped native phone integration.
package com.nova.phone.core.shell

import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class PhoneSetupFlowTest {
    private val fresh = SetupInputs(developerOptions = false, wirelessDebugging = false, status = BuiltinShellStatus.NotPaired, usbDebugging = false, accessibility = false)
    private val switchesOn = fresh.copy(developerOptions = true, usbDebugging = true, accessibility = true, wirelessDebugging = true)

    private fun SetupView.markList() = SetupStep.entries.map { marks.getValue(it) }

    @Test
    fun walksTheStepsInOrderAsSettingsChange() {
        val v1 = PhoneSetupFlow.view(fresh)
        assertEquals(SetupPhase.Guide, v1.phase)
        assertEquals(SetupStep.DeveloperOptions, v1.current)
        assertEquals(listOf(StepMark.Current, StepMark.Todo, StepMark.Todo, StepMark.Todo, StepMark.Todo, StepMark.Todo), v1.markList())

        val v2 = PhoneSetupFlow.view(fresh.copy(developerOptions = true))
        assertEquals(SetupStep.UsbDebugging, v2.current)
        assertEquals(listOf(StepMark.Done, StepMark.Current, StepMark.Todo, StepMark.Todo, StepMark.Todo, StepMark.Todo), v2.markList())

        val v2a = PhoneSetupFlow.view(fresh.copy(developerOptions = true, usbDebugging = true))
        assertEquals(SetupStep.Accessibility, v2a.current)
        assertEquals(listOf(StepMark.Done, StepMark.Done, StepMark.Current, StepMark.Todo, StepMark.Todo, StepMark.Todo), v2a.markList())

        val v2b = PhoneSetupFlow.view(fresh.copy(developerOptions = true, usbDebugging = true, accessibility = true))
        assertEquals(SetupStep.WirelessDebugging, v2b.current)
        assertEquals(listOf(StepMark.Done, StepMark.Done, StepMark.Done, StepMark.Current, StepMark.Todo, StepMark.Todo), v2b.markList())

        val v3 = PhoneSetupFlow.view(switchesOn)
        assertEquals(SetupStep.PairingCode, v3.current)
        assertTrue(v3.autoRead)
        assertFalse(v3.portFound)
        assertTrue(PhoneSetupFlow.view(switchesOn.copy(discovery = PairingDiscovery.Found(37000))).portFound)

        val v4 = PhoneSetupFlow.view(switchesOn.copy(status = BuiltinShellStatus.Connecting))
        assertEquals(SetupPhase.Working, v4.phase)
        assertNull(v4.current)
        assertEquals(listOf(StepMark.Done, StepMark.Done, StepMark.Done, StepMark.Done, StepMark.Done, StepMark.Current), v4.markList())

        val v5 = PhoneSetupFlow.view(switchesOn.copy(status = BuiltinShellStatus.Running))
        assertEquals(SetupPhase.Success, v5.phase)
        assertTrue(v5.markList().all { it == StepMark.Done })
    }

    @Test
    fun everyStepCanBePassedByHandWhenDetectionReadsOff() {
        // 这台手机什么都读成关着:用户一步步点「我已经打开了,下一步」,照样走到配对
        var i = fresh
        assertEquals(SetupStep.DeveloperOptions, PhoneSetupFlow.view(i).current)
        i = i.copy(confirmed = i.confirmed + SetupStep.DeveloperOptions)
        assertEquals(SetupStep.UsbDebugging, PhoneSetupFlow.view(i).current)
        i = i.copy(confirmed = i.confirmed + SetupStep.UsbDebugging)
        assertEquals(SetupStep.Accessibility, PhoneSetupFlow.view(i).current)
        i = i.copy(accessibilitySkipped = true)
        assertEquals(SetupStep.WirelessDebugging, PhoneSetupFlow.view(i).current)
        i = i.copy(confirmed = i.confirmed + SetupStep.WirelessDebugging)
        val pairing = PhoneSetupFlow.view(i)
        assertEquals(SetupStep.PairingCode, pairing.current)
        assertEquals(SetupPhase.Guide, pairing.phase)
        assertEquals(listOf(StepMark.Done, StepMark.Done, StepMark.Skipped, StepMark.Done, StepMark.Current, StepMark.Todo), pairing.markList())
        // 连上了就算成功,不管前面读到什么
        assertEquals(SetupPhase.Success, PhoneSetupFlow.view(i.copy(status = BuiltinShellStatus.Running)).phase)
        assertEquals(SetupPhase.Working, PhoneSetupFlow.view(i.copy(status = BuiltinShellStatus.Connecting)).phase)
        // 确认过的几步都有「下一步」;无障碍靠跳过,配对和连接要真的做成
        assertEquals(setOf(SetupStep.DeveloperOptions, SetupStep.UsbDebugging, SetupStep.WirelessDebugging), PhoneSetupFlow.CONFIRMABLE)
    }

    @Test
    fun confirmedStepStaysPassedAndDetectionStillTicksTheRest() {
        // 只确认了开发者选项:USB 调试读到开着就自动打勾,不用再点
        val v = PhoneSetupFlow.view(switchesOn.copy(developerOptions = false, confirmed = setOf(SetupStep.DeveloperOptions)))
        assertEquals(SetupStep.PairingCode, v.current)
        assertEquals(StepMark.Done, v.marks[SetupStep.DeveloperOptions])
        assertEquals(StepMark.Done, v.marks[SetupStep.UsbDebugging])
        // 没确认的那一步读到被关掉,照样退回去
        assertEquals(SetupStep.UsbDebugging, PhoneSetupFlow.view(switchesOn.copy(usbDebugging = false, confirmed = setOf(SetupStep.DeveloperOptions))).current)
        assertEquals(true, PhoneSetupFlow.detected(SetupStep.UsbDebugging, switchesOn))
        assertNull(PhoneSetupFlow.detected(SetupStep.WirelessDebugging, switchesOn.copy(wirelessDebugging = null)))
        assertNull(PhoneSetupFlow.detected(SetupStep.PairingCode, switchesOn))
    }

    @Test
    fun confirmedWirelessButHelperReadsItOffPointsBackInsteadOfSpinning() {
        val i = SetupInputs(true, false, BuiltinShellStatus.WirelessDebuggingOff, confirmed = setOf(SetupStep.WirelessDebugging))
        val v = PhoneSetupFlow.view(i)
        assertEquals(SetupPhase.Failed, v.phase)
        assertEquals(SetupStep.Connect, v.current)
        assertEquals(StepMark.Failed, v.marks[SetupStep.Connect])
        assertNull(v.failure)
        assertEquals(SetupSuspect(SetupStep.WirelessDebugging, unreadable = false), v.suspect)
        // 读到开着而状态还没跟上:照旧是正在连接
        assertEquals(SetupPhase.Working, PhoneSetupFlow.view(i.copy(wirelessDebugging = true)).phase)
        // 读不到的手机也照实说「读不到」
        assertEquals(SetupSuspect(SetupStep.WirelessDebugging, unreadable = true), PhoneSetupFlow.view(i.copy(wirelessDebugging = null)).suspect)
    }

    @Test
    fun connectionFailurePointsAtTheMostLikelyEarlierStep() {
        val connect = BuiltinShellStatus.Failed(BuiltinShellFailure.ConnectFailed)
        // 开发者选项读到关着(用户确认过才走到这里)
        val dev = PhoneSetupFlow.view(switchesOn.copy(developerOptions = false, confirmed = setOf(SetupStep.DeveloperOptions), status = connect))
        assertEquals(SetupPhase.Failed, dev.phase)
        assertEquals(SetupSuspect(SetupStep.DeveloperOptions, unreadable = false), dev.suspect)
        // 无线调试读到关着
        val off = PhoneSetupFlow.view(switchesOn.copy(wirelessDebugging = false, confirmed = setOf(SetupStep.WirelessDebugging), status = connect))
        assertEquals(SetupSuspect(SetupStep.WirelessDebugging, unreadable = false), off.suspect)
        // 无线调试读不到
        assertEquals(SetupSuspect(SetupStep.WirelessDebugging, unreadable = true), PhoneSetupFlow.view(switchesOn.copy(wirelessDebugging = null, status = connect)).suspect)
        // 配对窗口关掉也可能是开关的事
        val closed = BuiltinShellStatus.Failed(BuiltinShellFailure.PairingWindowClosed)
        assertEquals(SetupStep.WirelessDebugging, PhoneSetupFlow.view(switchesOn.copy(wirelessDebugging = null, status = closed)).suspect?.step)
        // 都读到开着,或是配对码不对、助手起不来:不乱指
        assertNull(PhoneSetupFlow.view(switchesOn.copy(status = connect)).suspect)
        assertNull(PhoneSetupFlow.view(switchesOn.copy(wirelessDebugging = null, status = BuiltinShellStatus.Failed(BuiltinShellFailure.WrongCode))).suspect)
        assertNull(PhoneSetupFlow.view(switchesOn.copy(wirelessDebugging = null, status = BuiltinShellStatus.Failed(BuiltinShellFailure.HelperStartFailed))).suspect)
    }

    @Test
    fun anyEarlierStepCanBeRevisited() {
        val atPairing = switchesOn
        val back = PhoneSetupFlow.view(atPairing.copy(revisit = SetupStep.UsbDebugging))
        assertEquals(SetupPhase.Guide, back.phase)
        assertEquals(SetupStep.UsbDebugging, back.current)
        assertTrue(back.revisiting)
        assertEquals(listOf(StepMark.Done, StepMark.Current, StepMark.Done, StepMark.Done, StepMark.Todo, StepMark.Todo), back.markList())
        assertFalse(PhoneSetupFlow.view(atPairing).revisiting)
        // 失败后也能回去,失败的那一步仍标着
        val failed = PhoneSetupFlow.view(atPairing.copy(status = BuiltinShellStatus.Failed(BuiltinShellFailure.HelperStartFailed), revisit = SetupStep.WirelessDebugging))
        assertEquals(SetupStep.WirelessDebugging, failed.current)
        assertNull(failed.failure)
        assertEquals(StepMark.Failed, failed.marks[SetupStep.Connect])
        // 也能回去重新配对
        assertEquals(SetupStep.PairingCode, PhoneSetupFlow.view(atPairing.copy(status = BuiltinShellStatus.Failed(BuiltinShellFailure.HelperStartFailed), revisit = SetupStep.PairingCode)).current)
        // 自动连接那一步不能点;正在连接、已经成功时以助手为准
        assertEquals(SetupStep.PairingCode, PhoneSetupFlow.view(atPairing.copy(revisit = SetupStep.Connect)).current)
        assertEquals(SetupPhase.Working, PhoneSetupFlow.view(atPairing.copy(status = BuiltinShellStatus.Connecting, revisit = SetupStep.DeveloperOptions)).phase)
        assertEquals(SetupPhase.Success, PhoneSetupFlow.view(atPairing.copy(status = BuiltinShellStatus.Running, revisit = SetupStep.DeveloperOptions)).phase)
        // 读到更前面的一步被关掉:先回那一步
        assertEquals(SetupStep.DeveloperOptions, PhoneSetupFlow.view(atPairing.copy(developerOptions = false, revisit = SetupStep.WirelessDebugging)).current)
    }

    @Test
    fun accessibilityCanBeSkippedAndPairingFallsBackToTheNotification() {
        val off = switchesOn.copy(accessibility = false)
        assertEquals(SetupStep.Accessibility, PhoneSetupFlow.view(off).current)
        val skipped = PhoneSetupFlow.view(off.copy(accessibilitySkipped = true))
        assertEquals(SetupStep.PairingCode, skipped.current)
        assertFalse(skipped.autoRead)
        assertEquals(StepMark.Skipped, skipped.marks[SetupStep.Accessibility])
        // 跳过后又在系统里打开了:照样自动读
        val laterOn = PhoneSetupFlow.view(switchesOn.copy(accessibilitySkipped = true))
        assertTrue(laterOn.autoRead)
        assertEquals(StepMark.Done, laterOn.marks[SetupStep.Accessibility])
        // 码不对重填时也看无障碍
        assertTrue(PhoneSetupFlow.view(switchesOn.copy(status = BuiltinShellStatus.Failed(BuiltinShellFailure.WrongCode))).autoRead)
    }

    @Test
    fun restrictedSettingsHintOnlyAtTheAccessibilityStep() {
        val off = switchesOn.copy(accessibility = false, restrictedSettings = true)
        assertTrue(PhoneSetupFlow.view(off).showAppInfo)
        assertFalse(PhoneSetupFlow.view(off.copy(restrictedSettings = false)).showAppInfo)
        assertFalse(PhoneSetupFlow.view(off.copy(accessibility = true)).showAppInfo)
        assertFalse(PhoneSetupFlow.view(off.copy(developerOptions = false)).showAppInfo)
    }

    @Test
    fun usbDebuggingOffBlocksSetupButNotARunningHelper() {
        // USB 调试关着:配对过、无线调试开着也停在这一步
        val v = PhoneSetupFlow.view(switchesOn.copy(usbDebugging = false, status = BuiltinShellStatus.Connecting))
        assertEquals(SetupStep.UsbDebugging, v.current)
        assertEquals(SetupPhase.Guide, v.phase)
        // 已经在运行就算设置好了(设置页另有提示)
        assertEquals(SetupPhase.Success, PhoneSetupFlow.view(switchesOn.copy(usbDebugging = false, status = BuiltinShellStatus.Running)).phase)
    }

    @Test
    fun turningASwitchOffGoesBackToThatStep() {
        // 配对过、无线调试被关掉:回到那一步,不要求重新配对
        val v = PhoneSetupFlow.view(SetupInputs(true, false, BuiltinShellStatus.WirelessDebuggingOff))
        assertEquals(SetupStep.WirelessDebugging, v.current)
        // 开发者选项被关:哪怕之前失败过,也先回第一步
        val f = PhoneSetupFlow.view(SetupInputs(false, true, BuiltinShellStatus.Failed(BuiltinShellFailure.ConnectFailed)))
        assertEquals(SetupStep.DeveloperOptions, f.current)
        assertEquals(SetupPhase.Guide, f.phase)
    }

    @Test
    fun pairedAndSwitchOnMeansConnectingEvenIfStatusLags() {
        val v = PhoneSetupFlow.view(SetupInputs(true, true, BuiltinShellStatus.WirelessDebuggingOff))
        assertEquals(SetupPhase.Working, v.phase)
    }

    @Test
    fun unreadableWirelessSwitchDoesNotBlock() {
        // 读不到开关的手机:不卡在无线调试一步,按助手的状态走
        assertEquals(SetupStep.PairingCode, PhoneSetupFlow.view(SetupInputs(true, null, BuiltinShellStatus.NotPaired)).current)
        assertEquals(SetupStep.WirelessDebugging, PhoneSetupFlow.view(SetupInputs(true, null, BuiltinShellStatus.WirelessDebuggingOff)).current)
        assertEquals(SetupPhase.Success, PhoneSetupFlow.view(SetupInputs(true, null, BuiltinShellStatus.Running)).phase)
    }

    @Test
    fun failuresLandOnTheStepTheUserMustRedo() {
        val wrong = PhoneSetupFlow.view(SetupInputs(true, true, BuiltinShellStatus.Failed(BuiltinShellFailure.WrongCode)))
        assertEquals(SetupPhase.Failed, wrong.phase)
        assertEquals(SetupStep.PairingCode, wrong.current)
        assertEquals(StepMark.Failed, wrong.marks[SetupStep.PairingCode])
        assertEquals(BuiltinShellFix.RePair, wrong.failure?.fix)

        val revoked = PhoneSetupFlow.view(SetupInputs(true, true, BuiltinShellStatus.Failed(BuiltinShellFailure.AuthorizationRevoked)))
        assertEquals(SetupStep.PairingCode, revoked.current)

        val helper = PhoneSetupFlow.view(SetupInputs(true, true, BuiltinShellStatus.Failed(BuiltinShellFailure.HelperStartFailed)))
        assertEquals(SetupStep.Connect, helper.current)
        assertEquals(StepMark.Done, helper.marks[SetupStep.PairingCode])
        assertEquals(BuiltinShellFix.Retry, helper.failure?.fix)

        assertEquals(BuiltinShellFix.OpenWifi, BuiltinShellStatus.Failed(BuiltinShellFailure.NoWifi).fix)
    }

    @Test
    fun repairShowsPairingStepUntilNewPairingStarts() {
        val running = SetupInputs(true, true, BuiltinShellStatus.Running, repair = true)
        assertEquals(SetupStep.PairingCode, PhoneSetupFlow.view(running).current)
        assertEquals(SetupPhase.Working, PhoneSetupFlow.view(running.copy(status = BuiltinShellStatus.Connecting)).phase)
    }

    @Test
    fun repairWhileRunningStaysOnPairingStepAndFinishesAfterNewPairing() {
        val running = SetupInputs(true, true, BuiltinShellStatus.Running, repair = true, discovery = PairingDiscovery.Found(4000))
        val waiting = PhoneSetupFlow.view(running)
        assertEquals(SetupPhase.Guide, waiting.phase)
        assertEquals(SetupStep.PairingCode, waiting.current)
        assertTrue(waiting.portFound)
        assertTrue(waiting.autoRead)
        assertEquals(BuiltinShellStatus.NotPaired, PhoneSetupFlow.effectiveStatus(BuiltinShellStatus.Running, repair = true))
        assertEquals(BuiltinShellStatus.Connecting, PhoneSetupFlow.effectiveStatus(BuiltinShellStatus.Connecting, repair = true))
        // 新配对开始后重新配对结束,助手继续运行即成功
        assertEquals(SetupPhase.Working, PhoneSetupFlow.view(running.copy(status = BuiltinShellStatus.Connecting)).phase)
        assertEquals(SetupPhase.Success, PhoneSetupFlow.view(running.copy(repair = false)).phase)
        assertEquals(BuiltinShellStatus.Running, PhoneSetupFlow.effectiveStatus(BuiltinShellStatus.Running, repair = false))
    }

    @Test
    fun asksForNotificationsOnlyAtThePairingStep() {
        val off = fresh.copy(notificationsAllowed = false)
        assertFalse(PhoneSetupFlow.view(off).needsNotifications)
        assertTrue(PhoneSetupFlow.view(off.copy(developerOptions = true, usbDebugging = true, accessibility = true, wirelessDebugging = true)).needsNotifications)
    }

    @Test
    fun pairingStepSaysWhatIsWrongWithTheNotification() {
        val pairing = fresh.copy(developerOptions = true, usbDebugging = true, accessibility = false, accessibilitySkipped = true, wirelessDebugging = true)
        assertEquals(SetupStep.PairingCode, PhoneSetupFlow.view(pairing).current)
        assertNull(PhoneSetupFlow.view(pairing).notifyIssue)
        // 没允许通知最要紧;其次「配对」通知被关;被调成不弹出只提醒,不算发不出来
        val off = PhoneSetupFlow.view(pairing.copy(notificationsAllowed = false, pairingChannel = PairingChannelHealth.Off))
        assertEquals(PairingNotifyIssue.NotificationsOff, off.notifyIssue)
        val channelOff = PhoneSetupFlow.view(pairing.copy(pairingChannel = PairingChannelHealth.Off))
        assertEquals(PairingNotifyIssue.ChannelOff, channelOff.notifyIssue)
        assertTrue(channelOff.needsNotifications)
        val lowered = PhoneSetupFlow.view(pairing.copy(pairingChannel = PairingChannelHealth.Lowered))
        assertEquals(PairingNotifyIssue.NotHeadsUp, lowered.notifyIssue)
        assertFalse(lowered.needsNotifications)
        // 别的步骤不管通知
        assertNull(PhoneSetupFlow.view(fresh.copy(pairingChannel = PairingChannelHealth.Off)).notifyIssue)
        // 配对失败停在配对一步时照样提醒
        val failed = PhoneSetupFlow.view(pairing.copy(status = BuiltinShellStatus.Failed(BuiltinShellFailure.WrongCode), pairingChannel = PairingChannelHealth.Off))
        assertEquals(PairingNotifyIssue.ChannelOff, failed.notifyIssue)
    }

    @Test
    fun pairingCodeNormalization() {
        assertEquals("123456", PairingCode.normalize("123456"))
        assertEquals("123456", PairingCode.normalize(" 123 456 "))
        assertEquals("123456", PairingCode.normalize("123-456"))
        assertEquals("123456", PairingCode.normalize("１２３４５６"))
        // 全角空格、全角横线、输入法的长短横线
        assertEquals("123456", PairingCode.normalize("１２３\u3000４５６"))
        assertEquals("123456", PairingCode.normalize("123－456"))
        assertEquals("123456", PairingCode.normalize("12–34—56"))
        assertNull(PairingCode.normalize(""))
        assertNull(PairingCode.normalize("123 45"))
        assertNull(PairingCode.normalize("12345"))
        assertNull(PairingCode.normalize("1234567"))
        assertNull(PairingCode.normalize("12a456"))
        assertEquals(37123, PairingCode.port(" 37123 "))
        assertNull(PairingCode.port("0"))
        assertNull(PairingCode.port("70000"))
    }

    @Test
    fun fakeControlDrivesStatus() = runTest {
        val fake = FakeBuiltinShellControl(pairingResult = BuiltinShellStatus.Failed(BuiltinShellFailure.WrongCode))
        fake.startDiscovery()
        assertEquals(PairingDiscovery.Searching, fake.pairingDiscovery.value)
        fake.startPairing("123456", 40000)
        assertEquals(BuiltinShellStatus.Failed(BuiltinShellFailure.WrongCode), fake.status.value)
        fake.retry()
        assertEquals(BuiltinShellStatus.Running, fake.status.value)
        fake.unpair()
        assertEquals(BuiltinShellStatus.NotPaired, fake.status.value)
        assertEquals(listOf("discover", "pair 123456 40000", "retry", "unpair"), fake.calls)
    }

    // ---------- 「改用电脑启动」只在需要时给 ----------

    private val atWireless = switchesOn.copy(wirelessDebugging = false)

    @Test
    fun usbFallbackIsHiddenInTheNormalFlow() {
        // 正常一路走下来:每一步、正在连接、成功,都不给
        listOf(
            fresh, fresh.copy(developerOptions = true), atWireless, switchesOn,
            switchesOn.copy(discovery = PairingDiscovery.Found(37000)),
            switchesOn.copy(status = BuiltinShellStatus.Connecting),
            switchesOn.copy(status = BuiltinShellStatus.Running),
            switchesOn.copy(status = BuiltinShellStatus.Failed(BuiltinShellFailure.WrongCode)),
            switchesOn.copy(status = BuiltinShellStatus.Failed(BuiltinShellFailure.NoWifi)),
        ).forEach { assertFalse(it.toString(), PhoneSetupFlow.view(it).usbFallback) }
        // 停了一会儿但没到时限也不给
        assertFalse(PhoneSetupFlow.view(atWireless.copy(stalledMs = PhoneSetupFlow.STALL_MS - 1)).usbFallback)
    }

    @Test
    fun usbFallbackWhenTheSystemHasNoWirelessDebugging() {
        assertTrue(PhoneSetupFlow.view(atWireless.copy(wirelessMissing = true)).usbFallback)
        // 前两步(开发者选项、USB 调试)电脑启动也要用,没做完时先不给
        assertFalse(PhoneSetupFlow.view(fresh.copy(wirelessMissing = true)).usbFallback)
        // 成功了就不给
        assertFalse(PhoneSetupFlow.view(switchesOn.copy(wirelessMissing = true, status = BuiltinShellStatus.Running)).usbFallback)
    }

    @Test
    fun usbFallbackWhenTheUserCannotFindIt() {
        assertTrue(PhoneSetupFlow.view(atWireless.copy(usbAsked = true)).usbFallback)
        // 出现过就留着:之后开始连接也还在
        assertTrue(PhoneSetupFlow.view(switchesOn.copy(usbAsked = true, status = BuiltinShellStatus.Connecting)).usbFallback)
        // 点回第一步重做时不给
        assertFalse(PhoneSetupFlow.view(atWireless.copy(usbAsked = true, revisit = SetupStep.DeveloperOptions)).usbFallback)
    }

    @Test
    fun usbFallbackAfterStallingWhereTheSystemShouldAnswer() {
        val stalled = PhoneSetupFlow.STALL_MS
        assertEquals(SetupStep.WirelessDebugging, PhoneSetupFlow.stallPoint(PhoneSetupFlow.view(atWireless)))
        assertTrue(PhoneSetupFlow.view(atWireless.copy(stalledMs = stalled)).usbFallback)
        // 配对一步一直找不到配对窗口(系统没有配对服务)
        assertEquals(SetupStep.PairingCode, PhoneSetupFlow.stallPoint(PhoneSetupFlow.view(switchesOn)))
        assertTrue(PhoneSetupFlow.view(switchesOn.copy(stalledMs = stalled)).usbFallback)
        // 找到配对窗口后是在等用户填码,不算卡住
        val found = switchesOn.copy(discovery = PairingDiscovery.Found(37000))
        assertNull(PhoneSetupFlow.stallPoint(PhoneSetupFlow.view(found)))
        assertFalse(PhoneSetupFlow.view(found.copy(stalledMs = stalled)).usbFallback)
        // 一直在自动连接
        val connecting = switchesOn.copy(status = BuiltinShellStatus.Connecting)
        assertEquals(SetupStep.Connect, PhoneSetupFlow.stallPoint(PhoneSetupFlow.view(connecting)))
        assertTrue(PhoneSetupFlow.view(connecting.copy(stalledMs = stalled)).usbFallback)
        // 前面几步要用户自己去找,花多久都不算
        assertNull(PhoneSetupFlow.stallPoint(PhoneSetupFlow.view(fresh)))
        assertFalse(PhoneSetupFlow.view(fresh.copy(stalledMs = stalled * 10)).usbFallback)
    }

    @Test
    fun usbFallbackAfterFailuresThatMeanWirelessDoesNotWork() {
        listOf(BuiltinShellFailure.PairingWindowClosed, BuiltinShellFailure.ConnectFailed, BuiltinShellFailure.UsbHelperStopped).forEach { f ->
            val v = PhoneSetupFlow.view(switchesOn.copy(status = BuiltinShellStatus.Failed(f)))
            assertEquals(SetupPhase.Failed, v.phase)
            assertTrue(f.name, v.usbFallback)
        }
        // 用户说开了无线调试,助手却读到关着、不去连
        val claimed = atWireless.copy(confirmed = setOf(SetupStep.WirelessDebugging), wirelessDebugging = null, status = BuiltinShellStatus.WirelessDebuggingOff)
        val v = PhoneSetupFlow.view(claimed)
        assertEquals(SetupStep.WirelessDebugging, v.suspect?.step)
        assertTrue(v.usbFallback)
    }

    /** 只用 USB 命令起过的助手(这台手机可能根本没有能用的无线调试),无线调试读到关着。 */
    private val usbOnly = switchesOn.copy(wirelessDebugging = false, restart = HelperRestart.UsbCommand)

    /** 助手在运行:成功,无线调试和配对两步记作跳过,哪儿都不提无线调试。 */
    @Test
    fun usbStartedHelperRunningIsSuccessWithWirelessStepsSkipped() {
        val v = PhoneSetupFlow.view(usbOnly.copy(status = BuiltinShellStatus.Running))
        assertEquals(SetupPhase.Success, v.phase)
        assertEquals(StepMark.Skipped, v.marks[SetupStep.WirelessDebugging])
        assertEquals(StepMark.Skipped, v.marks[SetupStep.PairingCode])
        assertEquals(StepMark.Done, v.marks[SetupStep.Connect])
        assertEquals(HelperRestart.UsbCommand, v.restart)
        assertFalse(v.usbFallback)
    }

    /** 正在交接(助手换手、App 刚起来等它来):显示正在连接,不因为无线调试关着退回那一步。 */
    @Test
    fun handoverDoesNotFlipBackToWirelessStep() {
        val v = PhoneSetupFlow.view(usbOnly.copy(status = BuiltinShellStatus.Connecting))
        assertEquals(SetupPhase.Working, v.phase)
        assertNull(v.current)
        // 配对过的手机正在替用户打开无线调试、正在连时也一样
        assertEquals(SetupPhase.Working, PhoneSetupFlow.view(atWireless.copy(status = BuiltinShellStatus.Connecting)).phase)
        // 前面的开关真被关掉时照旧回那一步
        assertEquals(SetupStep.UsbDebugging, PhoneSetupFlow.view(usbOnly.copy(usbDebugging = false, status = BuiltinShellStatus.Connecting)).current)
    }

    /** 助手停了:停在连接一步说它停了、给 USB 命令,不引去无线调试;想配对的人仍可以点回配对那一步。 */
    @Test
    fun usbHelperStoppedShowsTheCommandNotWirelessDebugging() {
        val stopped = BuiltinShellStatus.Failed(BuiltinShellFailure.UsbHelperStopped)
        val v = PhoneSetupFlow.view(usbOnly.copy(status = stopped))
        assertEquals(SetupPhase.Failed, v.phase)
        assertEquals(SetupStep.Connect, v.current)
        assertEquals(stopped, v.failure)
        assertEquals(BuiltinShellFix.RunUsbCommand, v.failure?.fix)
        assertTrue(v.usbFallback)
        assertNull(v.suspect)
        assertEquals(StepMark.Skipped, v.marks[SetupStep.WirelessDebugging])
        assertEquals(StepMark.Skipped, v.marks[SetupStep.PairingCode])
        // 系统里根本没有无线调试一项时也一样
        assertEquals(SetupStep.Connect, PhoneSetupFlow.view(usbOnly.copy(wirelessDebugging = null, wirelessMissing = true, status = stopped)).current)
        // 点回配对一步:照常给配对
        val back = PhoneSetupFlow.view(usbOnly.copy(wirelessDebugging = true, status = stopped, revisit = SetupStep.PairingCode))
        assertEquals(SetupStep.PairingCode, back.current)
        assertTrue(back.revisiting)
    }

    /** 配对过、能用无线调试的手机不受影响:无线调试关着、助手不在时照旧回到那一步(打开后自动连上)。 */
    @Test
    fun pairedPhoneStillGoesBackToWirelessStep() {
        val v = PhoneSetupFlow.view(atWireless.copy(status = BuiltinShellStatus.WirelessDebuggingOff, restart = HelperRestart.Wireless))
        assertEquals(SetupStep.WirelessDebugging, v.current)
        assertEquals(SetupPhase.Guide, v.phase)
        val ok = PhoneSetupFlow.view(switchesOn.copy(status = BuiltinShellStatus.Running, restart = HelperRestart.Wireless))
        assertTrue(ok.markList().all { it == StepMark.Done })
    }
}
