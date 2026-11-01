// Derived from Mika (https://github.com/wangzan101/Mika, Apache-2.0, commit 5f630d9),
// Copyright 2026 wangzan101. Modified by Nova: notification copy and narrow accessibility reader seam.
package com.nova.nova_mobile.phone.setup

import android.app.RemoteInput
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.os.SystemClock
import com.nova.nova_mobile.phone.PhoneBridge
import com.nova.phone.core.shell.BuiltinShellControl
import com.nova.phone.core.shell.PairingCode
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.Job
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.collectLatest
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.transformWhile
import kotlinx.coroutines.launch

/**
 * 一次配对的全过程:找配对窗口、无障碍开着时自己读配对码([PairingCodeReader])、
 * 读不到就弹带输入框的通知、把码交给内置助手 [control]、显示结果。
 * 跟着进程走,不跟界面(用户在系统设置里看配对码时 Nova 的界面已经不在前台):由 [com.nova.nova_mobile.phone.PhoneBridge] 建一份。
 */
class PairingCoordinator(context: Context, private val control: BuiltinShellControl, val windowReader: () -> PairingWindowReader?) {
    private val app = context.applicationContext
    /** 配对、重试、解除配对这类动作也放这里跑:界面关了也要做完。 */
    val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
    private var watch: Job? = null
    private val deadline = SlidingDeadline(WINDOW_MS) { SystemClock.elapsedRealtime() }
    /** 通知上此刻显示的;再次提醒前对一下,已经换成别的(比如刚填了码)就不再弹旧的。 */
    @Volatile private var shown: PairingNotice? = null
    private val _repairing = MutableStateFlow(false)
    /** 用户点了「重新配对」且新的配对还没开始:助手即便在运行也要等新配对。 */
    val repairing: StateFlow<Boolean> = _repairing
    /**
     * 填了码、配对还没开始([submit] 起,到 [pair] 把状态改成「正在配对」为止):这段时间通知一律是「正在配对」。
     * [submit] 里的 [begin] 让找窗口的状态当场回到「在找」,不这样的话通知会按填码前的状态再算一条
     * (配对失效时是「配对失效了」,填错码后重填时是又响一次的输入框)。跟着状态更新通知也不在这时结束,见 [PairingNotice.follow]。
     */
    @Volatile private var submitted = false

    fun startRepair() { _repairing.value = true }

    fun cancelRepair() { _repairing.value = false }

    /** 开始一次配对:状态一变成「正在配对」就结束重新配对的等待(免得被运行中的旧状态抢先判成已完成)和填码后的等待([submitted])。 */
    suspend fun pair(code: String, port: Int?) = coroutineScope {
        val job = launch(start = CoroutineStart.UNDISPATCHED) { control.startPairing(code, port) }
        _repairing.value = false
        submitted = false
        job.join()
    }

    /** 开始看着配对;已经在看就把时限从现在起重新算 [WINDOW_MS],不重来一遍(免得通知又从头弹)。 */
    @Synchronized
    fun begin() {
        deadline.extend()
        control.startDiscovery()
        if (watch?.isActive == true) return
        watch = scope.launch {
            val reader = launch { PairingCodeReader.run(app, control, this@PairingCoordinator) }
            val notices = launch {
                // 三样各由一个协程送进 combine,送到的先后不一定是改的先后(先改的「正在配对」可能后到):每次都按此刻的值算。
                // 按写入的反序读,读到后写的值时先写的也一定读得到:submit 先写 submitted 再让找窗口的状态回到「在找」,
                // pair 先写「正在配对」再清 repairing 和 submitted
                combine(control.status, control.pairingDiscovery, _repairing) { _, _, _ ->
                    val d = control.pairingDiscovery.value
                    val pending = submitted
                    val r = _repairing.value
                    PairingNotice.follow(control.status.value, d, r, pending)
                }
                    .distinctUntilChanged()
                    .transformWhile { emit(it.first); !it.second }
                    // 状态一变就丢掉还没到点的弹出和再次提醒
                    .collectLatest { notice -> notice?.let { post(it) } }
            }
            if (!deadline.await(notices)) {
                notices.cancel()
                cancelNotice()
            }
            reader.cancel()
            control.stopDiscovery()
            PairingService.stop(app)
        }
    }

    /** 发出 [notice];没人理就隔一阵再弹,次数有上限。 */
    private suspend fun post(notice: PairingNotice) {
        delay(PairingNotice.delayBefore(notice, autoRead = windowReader()?.available == true))
        show(notice)
        var sent = 0
        while (true) {
            delay(PairingNotice.realertAfter(notice, sent) ?: return)
            if (shown != notice) return
            show(notice)
            sent++
        }
    }

    private fun show(notice: PairingNotice) {
        shown = notice
        PairingNotifier.show(app, notice)
    }

    private fun cancelNotice() {
        shown = null
        PairingNotifier.cancel(app)
    }

    @Synchronized
    fun end() {
        watch?.cancel()
        watch = null
        _repairing.value = false
        control.stopDiscovery()
        cancelNotice()
        PairingService.stop(app)
    }

    /** 通知或引导页里填的码。不是 6 位数字就原地提示重填、不去试;对的话马上换成「正在配对」,免得输入框一直转圈。 */
    fun submit(raw: String, port: Int?): Boolean {
        val code = PairingCode.normalize(raw)
        if (code == null) {
            show(PairingNotice.EnterCode(port, PhoneSetupCopy.NOTIFY_CODE_INVALID))
            return false
        }
        submitted = true
        begin()
        show(PairingNotice.Working)
        scope.launch { pair(code, port) }
        return true
    }

    private companion object {
        /** 配对窗口开着的时间有限;从最后一次 [begin] 起超过这么久没配上就不再找,下次 [begin] 再开始。 */
        const val WINDOW_MS = 10 * 60_000L
    }
}

/** 通知输入框的落点。 */
open class PairingCodeInput : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        val code = RemoteInput.getResultsFromIntent(intent)?.getCharSequence(PairingNotifier.KEY_CODE)?.toString() ?: return
        val port = intent.getIntExtra(PairingNotifier.EXTRA_PORT, -1).takeIf { it > 0 }
        PhoneBridge.of(context).pairing.submit(code, port)
    }
}
