// Derived from Mika (https://github.com/wangzan101/Mika, Apache-2.0, commit 5f630d9),
// Copyright 2026 wangzan101. Modified by Nova: package names and scoped native phone integration.
package com.nova.nova_mobile.phone.setup

import android.annotation.SuppressLint
import android.content.Context
import android.content.pm.PackageManager
import android.database.ContentObserver
import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkRequest
import android.net.NetworkCapabilities
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.provider.Settings
import com.nova.phone.core.adb.AdbConnectPort
import com.nova.phone.core.adb.AdbConnection
import com.nova.phone.core.adb.ConnectCandidates
import com.nova.phone.core.adb.AdbPairing
import com.nova.phone.core.adb.AdbServiceTypes
import com.nova.phone.core.adb.AdbTls
import com.nova.phone.core.adb.LocalPortScan
import com.nova.phone.core.adb.NioPortScanner
import com.nova.phone.core.adb.PortCache
import com.nova.phone.core.shell.BuiltinShellEngine
import com.nova.phone.core.shell.BuiltinShellPlatform
import com.nova.phone.core.shell.HelperHandoff
import com.nova.nova_mobile.phone.shell.HelperHub
import com.nova.nova_mobile.phone.shell.adb.AndroidAdb
import com.nova.nova_mobile.phone.shell.adb.NsdAdbServiceFinder
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.withTimeoutOrNull
import java.io.File
import java.net.Inet4Address
import java.util.concurrent.atomic.AtomicReference

/** Process-owned pairing transport and watchdog; secure settings are never written. */
class BuiltinShellManager(context: Context, private val hub: HelperHub) {
    private val app = context.applicationContext
    private var started = false
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private var observer: ContentObserver? = null
    private var networkCallback: ConnectivityManager.NetworkCallback? = null

    private val _scanningPorts = MutableStateFlow(false)
    /** 正在扫本机找无线调试端口(引导页显示「正在本机查找…」)。 */
    val scanningPorts: StateFlow<Boolean> = _scanningPorts.asStateFlow()

    private val platform: AndroidPlatform by lazy {
        AndroidPlatform(app, hub, { lastConnectCandidates = it }, { _scanningPorts.value = it }, ::stopObserving)
    }

    /** 最近一次找连接端口时各来源给了几个候选(诊断信息用);这次进程里还没连过为 null。 */
    @Volatile var lastConnectCandidates: ConnectCandidates? = null
        private set

    /** 配对客户端 + 看门狗。 */
    val engine: BuiltinShellEngine by lazy {
        BuiltinShellEngine(
            platform, hub.shell, CoroutineScope(SupervisorJob() + Dispatchers.Default), Dispatchers.IO,
        )
    }

    fun need() { if (Build.VERSION.SDK_INT >= MIN_SDK) engine.need() }

    /** 用户在引导页填了无线调试的端口:下一次连接带上它(只用这一次,连上了就记作缓存),然后重试。 */
    suspend fun connectWithPort(port: Int) {
        platform.manualPort.set(port)
        engine.retry()
    }

    @Synchronized
    fun start() {
        if (started || Build.VERSION.SDK_INT < MIN_SDK) return
        started = true
        val e = engine
        val settingsObserver = object : ContentObserver(Handler(Looper.getMainLooper())) {
            override fun onChange(selfChange: Boolean) { scope.launch { e.wirelessDebuggingChanged() } }
        }
        app.contentResolver.registerContentObserver(DeveloperSettings.wirelessDebuggingUri, false, settingsObserver)
        observer = settingsObserver
        val callback = object : ConnectivityManager.NetworkCallback() {
            override fun onAvailable(network: Network) { scope.launch { e.wifiAvailable() } }
        }
        runCatching {
            app.getSystemService(ConnectivityManager::class.java).registerNetworkCallback(
                NetworkRequest.Builder().addTransportType(NetworkCapabilities.TRANSPORT_WIFI)
                    .removeCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET).build(), callback,
            )
            networkCallback = callback
        }
        e.start()
    }

    /** Forget/unpair releases process observers; a subsequent explicit start registers them again. */
    @Synchronized
    private fun stopObserving() {
        observer?.let { app.contentResolver.unregisterContentObserver(it) }
        observer = null
        networkCallback?.let { app.getSystemService(ConnectivityManager::class.java).unregisterNetworkCallback(it) }
        networkCallback = null
        started = false
    }

    private class AndroidPlatform(
        private val app: Context,
        private val hub: HelperHub,
        private val candidates: (ConnectCandidates) -> Unit,
        private val scanning: (Boolean) -> Unit,
        private val stopObserving: () -> Unit,
    ) : BuiltinShellPlatform {
        /** 用户填的端口,下一次连接取走。 */
        val manualPort = AtomicReference<Int?>(null)
        private val scan = LocalPortScan(NioPortScanner(), ::localHosts, { LocalPortScan.parseRange(portRangeText()) })
        private val prefs = app.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        private val finder = NsdAdbServiceFinder(app)
        private val portCache = object : PortCache {
            override fun load() = prefs.getInt("port", 0).takeIf { it > 0 }
            override fun save(port: Int) { prefs.edit().putInt("port", port).apply() }
        }

        override fun paired() = Build.VERSION.SDK_INT >= MIN_SDK && prefs.getBoolean("paired", false)

        override fun setPaired(paired: Boolean) {
            prefs.edit().putBoolean("paired", paired).apply()
        }

        // 这一项没写过时读出 null:看不清就不拦着
        override fun wirelessDebugging(): Boolean? =
            Settings.Global.getString(app.contentResolver, DeveloperSettings.ADB_WIFI_ENABLED)?.let { it == "1" }

        override fun wifiConnected(): Boolean = runCatching {
            val cm = app.getSystemService(ConnectivityManager::class.java)
            @Suppress("DEPRECATION")
            cm.allNetworks.any { cm.getNetworkCapabilities(it)?.hasTransport(NetworkCapabilities.TRANSPORT_WIFI) == true }
        }.getOrDefault(true)

        override suspend fun findPairingPort(timeoutMs: Long): Int? = finder.findPorts(AdbServiceTypes.PAIRING, timeoutMs).firstOrNull()

        override fun pair(port: Int, code: String) {
            AdbPairing(AndroidAdb.tls(AndroidAdb.pairingIdentity(app))).pair(LOCALHOST, port, code)
        }

        override suspend fun launchHelper() {
            val tls = AndroidAdb.tls(AndroidAdb.identity(app))
            // 助手每次交接前都核对 Nova 的签名
            val command = HelperHandoff.command(app.applicationInfo.sourceDir, app.packageName, app.applicationInfo.uid, ownCertPin(app))
            val connection = connect(tls)
            // 流开着 sh 就一直等;交接到了(或超时)再关,交接结果仍由引擎从 HelperHub 判断
            val before = hub.shell.value
            connection.use {
                val stream = it.exec(command)
                stream.write(HelperHandoff.stdinLine(hub.issueLaunchNonce()))
                withTimeoutOrNull(HANDOFF_WAIT_MS) { hub.shell.first { s -> s != null && s !== before } }
            }
        }

        suspend fun connect(tls: AdbTls = AndroidAdb.tls(AndroidAdb.identity(app))): AdbConnection =
            AdbConnectPort(
                ::tlsPort, finder, portCache, report = candidates, scan = scan, manual = { manualPort.getAndSet(null) }, scanning = scanning,
            ).connect { host, port -> AdbConnection.open(host, port, tls) }

        /** 扫端口时只扫本机自己:127.0.0.1 和 Wi-Fi 上的 IPv4 地址。 */
        private fun localHosts(): List<String> = listOf(LOCALHOST) + runCatching {
            val cm = app.getSystemService(ConnectivityManager::class.java)
            @Suppress("DEPRECATION")
            cm.allNetworks.filter { cm.getNetworkCapabilities(it)?.hasTransport(NetworkCapabilities.TRANSPORT_WIFI) == true }
                .flatMap { cm.getLinkProperties(it)?.linkAddresses.orEmpty() }
                .mapNotNull { (it.address as? Inet4Address)?.hostAddress }
        }.getOrDefault(emptyList())

        /** 系统分配临时端口的范围;有的系统不让 App 读,读不到就扫默认的一段。 */
        private fun portRangeText(): String? = runCatching { File(PORT_RANGE_FILE).readText() }.getOrNull()

        override fun stopHelper() {
            // destroy 会让助手进程当场退出,这一调用多半以 DeadObjectException 结束
            runCatching { hub.shell.value?.destroy() }
        }

        override fun forget() {
            stopObserving()
            hub.forget()
            AndroidAdb.forget(app)
            prefs.edit().remove("port").apply()
        }

        @SuppressLint("PrivateApi")
        private fun tlsPort(): Int? = runCatching {
            Class.forName("android.os.SystemProperties").getMethod("get", String::class.java)
                .invoke(null, TLS_PORT_PROPERTY) as String?
        }.getOrNull()?.trim()?.toIntOrNull()
    }

    companion object {
        /** 内置助手从安卓 12 起启用;旧系统使用不带较新屏幕标志的兼容路径。 */
        const val MIN_SDK = Build.VERSION_CODES.S
        private const val PREFS = "builtin_shell"
        /** 安卓原版 adbd 把无线调试的连接端口写在这个系统属性里;读不到时靠缓存、mDNS、扫本机端口和用户填的端口。 */
        private const val TLS_PORT_PROPERTY = "service.adb.tls.port"
        private const val LOCALHOST = AdbConnectPort.LOCALHOST
        private const val PORT_RANGE_FILE = "/proc/sys/net/ipv4/ip_local_port_range"
        private const val HANDOFF_WAIT_MS = 15_000L
    }
}

internal fun ownCertPin(context: Context): String {
    val info = context.packageManager.getPackageInfo(context.packageName, PackageManager.GET_SIGNING_CERTIFICATES)
    return checkNotNull(HelperHandoff.certPin(info.signingInfo?.apkContentsSigners?.map { it.toByteArray() }))
}
