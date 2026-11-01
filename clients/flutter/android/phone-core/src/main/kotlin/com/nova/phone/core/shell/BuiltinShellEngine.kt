// Derived from Mika (https://github.com/wangzan101/Mika, Apache-2.0, commit 5f630d9),
// Copyright 2026 wangzan101. Modified by Nova: package names and scoped native phone integration.
package com.nova.phone.core.shell

import com.nova.phone.core.adb.AdbConnectionException
import com.nova.phone.core.adb.AdbKeyUnreadableException
import com.nova.phone.core.adb.AdbPairingException
import com.nova.phone.core.adb.AdbServiceTypes
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeoutOrNull

/** 引擎要的平台能力。阻塞调用都在 IO 调度器上执行。 */
interface BuiltinShellPlatform {
    fun paired(): Boolean
    fun setPaired(paired: Boolean)
    /** 无线调试开关;读不到为 null(不拦着往下走)。 */
    fun wirelessDebugging(): Boolean?
    fun wifiConnected(): Boolean
    suspend fun findPairingPort(timeoutMs: Long): Int?
    /** 用配对码配对;失败抛 [AdbPairingException]。 */
    fun pair(port: Int, code: String)
    /** 连本机 adbd 并起助手(不等交接);失败抛 [AdbConnectionException],存着的钥匙读不出抛 [AdbKeyUnreadableException]。 */
    suspend fun launchHelper()
    /** 让正在跑的助手撤掉改动并退出;没有就什么都不做。 */
    fun stopHelper()
    /** 删掉配对钥匙和交接口令。 */
    fun forget()

}

/** 看门狗重起助手的间隔:第 n 次失败后等 base·2^(n-1),封顶 [maxMs];连续失败 [maxAttempts] 次后停下等人或等开关变化。 */
data class Backoff(val baseMs: Long = 2_000, val maxMs: Long = 30_000, val maxAttempts: Int = 5) {
    fun delayAfter(failures: Int): Long? {
        if (failures >= maxAttempts) return null
        return (baseMs shl (failures - 1).coerceIn(0, 20)).coerceAtMost(maxMs)
    }
}

object BuiltinShellFailures {
    fun ofPairing(reason: AdbPairingException.Reason) = when (reason) {
        AdbPairingException.Reason.WRONG_CODE -> BuiltinShellFailure.WrongCode
        // 配对端口连不上:配对窗口已经关了(端口随窗口一起消失)
        AdbPairingException.Reason.CONNECT_FAILED -> BuiltinShellFailure.PairingWindowClosed
        AdbPairingException.Reason.TLS_FAILED, AdbPairingException.Reason.PROTOCOL -> BuiltinShellFailure.Unknown
    }

    fun ofConnection(reason: AdbConnectionException.Reason) = when (reason) {
        AdbConnectionException.Reason.UNAUTHORIZED -> BuiltinShellFailure.AuthorizationRevoked
        AdbConnectionException.Reason.CONNECT_FAILED,
        AdbConnectionException.Reason.TLS_FAILED,
        AdbConnectionException.Reason.PROTOCOL -> BuiltinShellFailure.ConnectFailed
    }

    /** 看门狗自己再试有没有用:钥匙被撤销、没 Wi-Fi 要等用户或开关变化。 */
    fun retryable(f: BuiltinShellFailure) = f == BuiltinShellFailure.ConnectFailed ||
        f == BuiltinShellFailure.HelperStartFailed || f == BuiltinShellFailure.Unknown
}

/**
 * 内置助手的状态与看门狗。[helper] 有值就是助手的 Binder 在手(Running);
 * 没有时:配过对就先等 [graceMs](还活着的助手会在 Nova 进程起来后自己交接),再经 adbd 起一个,失败按 [backoff] 重试。
 */
class BuiltinShellEngine(
    private val platform: BuiltinShellPlatform,
    private val helper: StateFlow<Any?>,
    private val scope: CoroutineScope,
    private val io: CoroutineDispatcher,
    private val backoff: Backoff = Backoff(),
    private val graceMs: Long = 3_000,
    private val handoffTimeoutMs: Long = 15_000,
    private val discoveryTimeoutMs: Long = 10 * 60_000L,
    private val pairingPortTimeoutMs: Long = 5_000,
) : BuiltinShellControl {
    private val _status = MutableStateFlow(initialStatus())
    override val status: StateFlow<BuiltinShellStatus> = _status.asStateFlow()
    private val _discovery = MutableStateFlow<PairingDiscovery>(PairingDiscovery.Idle)
    override val pairingDiscovery: StateFlow<PairingDiscovery> = _discovery.asStateFlow()

    private val _exchangingCode = MutableStateFlow(false)
    val exchangingCode: StateFlow<Boolean> = _exchangingCode.asStateFlow()

    /** 最近一次配对或连接失败的异常类别和说明(诊断信息用,原文未脱敏);连上后清空。 */
    @Volatile var lastError: String? = null
        private set

    private val launchLock = Mutex()
    private val pairingLock = Mutex()
    private var failures = 0
    private var retryJob: Job? = null
    private var discoveryJob: Job? = null
    private var started = false

    override val paired: Boolean get() = platform.paired()

    private fun initialStatus(): BuiltinShellStatus = when {
        helper.value != null -> BuiltinShellStatus.Running
        !platform.paired() -> BuiltinShellStatus.NotPaired
        else -> BuiltinShellStatus.Connecting
    }

    /** 开始看着助手:掉线就重起。只在功能打开时调。 */
    @Synchronized
    fun start() {
        if (started) return
        started = true
        var first = true
        scope.launch {
            helper.collect { h ->
                if (h != null) {
                    synchronized(this@BuiltinShellEngine) { failures = 0; retryJob?.cancel() }
                    _status.value = BuiltinShellStatus.Running
                } else if (!platform.paired()) {
                    _status.value = BuiltinShellStatus.NotPaired
                } else {
                    if (_status.value == BuiltinShellStatus.Running) _status.value = BuiltinShellStatus.Connecting
                    schedule(if (first) graceMs else backoff.baseMs)
                }
                first = false
            }
        }
    }

    /** 有人要用助手却没有:没在起、也没排着重试就马上起一次。 */
    fun need() {
        if (helper.value != null || !platform.paired()) return
        synchronized(this) { if (retryJob?.isActive == true) return }
        if (launchLock.isLocked) return
        schedule(0)
    }

    /**
     * Retry when wireless debugging is enabled; never override a user-disabled switch.
     */
    fun wirelessDebuggingChanged() {
        if (helper.value != null || !platform.paired()) return
        if (platform.wirelessDebugging() == false) {
            _status.value = BuiltinShellStatus.WirelessDebuggingOff
            return
        }
        synchronized(this) { failures = 0 }
        schedule(0)
    }

    /** Retry a failed connection when Wi-Fi becomes available; never write secure settings. */
    fun wifiAvailable() {
        if (_status.value != BuiltinShellStatus.Failed(BuiltinShellFailure.NoWifi)) return
        synchronized(this) { failures = 0 }
        schedule(0)
    }

    @Synchronized
    private fun schedule(delayMs: Long) {
        retryJob?.cancel()
        retryJob = scope.launch {
            delay(delayMs)
            launchOnce()
        }
    }

    private suspend fun launchOnce(): Unit = launchLock.withLock {
        if (helper.value != null) return@withLock
        if (!platform.paired()) {
            _status.value = BuiltinShellStatus.NotPaired
            return@withLock
        }
        if (platform.wirelessDebugging() == false) {
            _status.value = BuiltinShellStatus.WirelessDebuggingOff
            return@withLock
        }
        _status.value = BuiltinShellStatus.Connecting
        val failure = attempt()
        if (failure == null) {
            lastError = null
            _status.value = BuiltinShellStatus.Running
            return@withLock
        }
        _status.value = BuiltinShellStatus.Failed(failure)
        val next = synchronized(this) { ++failures }
        if (BuiltinShellFailures.retryable(failure)) backoff.delayAfter(next)?.let { d ->
            synchronized(this) {
                retryJob = scope.launch {
                    delay(d)
                    launchOnce()
                }
            }
        }
    }

    private suspend fun attempt(): BuiltinShellFailure? = try {
        withContext(io) { platform.launchHelper() }
        if (withTimeoutOrNull(handoffTimeoutMs) { helper.first { it != null } } != null) null
        else BuiltinShellFailure.HelperStartFailed.also { lastError = "helper handoff timed out" }
    } catch (e: CancellationException) {
        throw e
    } catch (e: AdbConnectionException) {
        lastError = describe(e)
        val f = BuiltinShellFailures.ofConnection(e.reason)
        if (f == BuiltinShellFailure.ConnectFailed && !platform.wifiConnected()) BuiltinShellFailure.NoWifi else f
    } catch (e: AdbKeyUnreadableException) {
        lastError = describe(e)
        BuiltinShellFailure.KeyUnreadable
    } catch (e: Exception) {
        lastError = describe(e)
        BuiltinShellFailure.Unknown
    }

    private fun describe(e: Exception): String =
        e.javaClass.simpleName + ((e as? AdbConnectionException)?.reason?.let { "($it)" } ?: (e as? AdbPairingException)?.reason?.let { "($it)" } ?: "") +
            (e.message?.let { ": " + it.take(200) } ?: "")

    override fun startDiscovery() {
        synchronized(this) {
            // 还在找也重新开始:用户又回到配对这件事上了,找的时限从现在算
            discoveryJob?.cancel()
            _discovery.value = PairingDiscovery.Searching
            discoveryJob = scope.launch {
                val port = withContext(io) { platform.findPairingPort(discoveryTimeoutMs) }
                _discovery.value = port?.let { PairingDiscovery.Found(it) } ?: PairingDiscovery.Idle
            }
        }
    }

    override fun stopDiscovery() {
        synchronized(this) {
            discoveryJob?.cancel()
            discoveryJob = null
        }
        _discovery.value = PairingDiscovery.Idle
    }

    override suspend fun startPairing(code: String, port: Int?) = pairingLock.withLock {
        _exchangingCode.value = true
        try { pair(code, port) } finally { _exchangingCode.value = false }
    }

    private suspend fun pair(code: String, port: Int?) {
        _status.value = BuiltinShellStatus.Connecting
        val target = port ?: (_discovery.value as? PairingDiscovery.Found)?.port
            ?: withContext(io) { platform.findPairingPort(pairingPortTimeoutMs) }
        if (target == null) {
            lastError = "pairing port not found"
            _status.value = BuiltinShellStatus.Failed(BuiltinShellFailure.PairingWindowClosed)
            return
        }
        val failure = try {
            withContext(io) { platform.pair(target, code) }
            null
        } catch (e: CancellationException) {
            throw e
        } catch (e: AdbPairingException) {
            lastError = describe(e)
            BuiltinShellFailures.ofPairing(e.reason)
        } catch (e: Exception) {
            lastError = describe(e)
            BuiltinShellFailure.Unknown
        }
        if (failure != null) {
            _status.value = BuiltinShellStatus.Failed(failure)
            return
        }
        platform.setPaired(true)
        _exchangingCode.value = false
        stopDiscovery()
        retry()
    }

    override suspend fun retry() {
        synchronized(this) {
            failures = 0
            retryJob?.cancel()
        }
        if (helper.value != null) {
            _status.value = BuiltinShellStatus.Running
            return
        }
        launchOnce()
    }

    override suspend fun unpair() = pairingLock.withLock {
        stopDiscovery()
        synchronized(this) { retryJob?.cancel() }
        launchLock.withLock {
            withContext(io) {
                runCatching { platform.stopHelper() }
                platform.forget()
            }
            platform.setPaired(false)
            _status.value = BuiltinShellStatus.NotPaired
        }
    }
}
