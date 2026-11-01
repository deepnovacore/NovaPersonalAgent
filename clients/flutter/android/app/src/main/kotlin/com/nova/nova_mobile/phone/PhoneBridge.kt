package com.nova.nova_mobile.phone

import android.app.Activity
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.os.PowerManager
import android.provider.Settings
import com.nova.nova_mobile.LocalGuiService
import com.nova.nova_mobile.phone.setup.*
import com.nova.nova_mobile.phone.shell.HelperHub
import com.nova.nova_mobile.phone.shell.INovaShell
import com.nova.phone.core.shell.*
import io.flutter.embedding.engine.FlutterEngine
import io.flutter.plugin.common.EventChannel
import io.flutter.plugin.common.MethodChannel
import kotlinx.coroutines.*
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import org.json.JSONArray
import org.json.JSONObject
import java.lang.ref.WeakReference

/** Process-owned channels and helper seam. Provider handoff does not depend on a Flutter engine. */
class PhoneBridge private constructor(context: Context) : ShellProvider, PhoneEventSink {
    private val app = context.applicationContext
    private val main = Handler(Looper.getMainLooper())
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
    private val operations = Mutex()
    private val hub = HelperHub.of(app)
    private val manager by lazy { BuiltinShellManager(app, hub) }
    val pairing by lazy { PairingCoordinator(app, manager.engine) { pairingWindowReader } }
    @Volatile var pairingWindowReader: PairingWindowReader? = null
    @Volatile var takeover: PhoneTakeover? = null
    @Volatile var selfCheck: PhoneSelfCheck? = null
    @Volatile private var events: EventChannel.EventSink? = null
    @Volatile private var frames: EventChannel.EventSink? = null
    @Volatile private var visible = false
    private var statusWatch: Job? = null
    private var detach: (() -> Unit)? = null
    override val shell: INovaShell? get() = hub.shell.value
    override val previewVisible: Boolean get() = visible && frames != null
    override fun need() { runCatching { if (supported) { manager.start(); manager.need() } } }
    private val supported get() = Build.VERSION.SDK_INT >= PHONE_VIRTUAL_MIN_API

    override fun emit(event: JSONObject) {
        val encoded = event.toString()
        val sink = events ?: return
        main.post { if (events === sink) sink.success(encoded) }
    }
    override fun frame(jpeg: ByteArray) {
        if (!previewVisible) return
        val sink = frames ?: return
        val bytes = jpeg.copyOf()
        main.post { if (previewVisible && frames === sink) sink.success(bytes) }
    }

    fun status(): PhoneStatus {
        val accessibility = LocalGuiService.current != null
        val state = if (supported) manager.engine.status.value else null
        val helper = when {
            !supported -> HelperState.UNSUPPORTED
            state is BuiltinShellStatus.Failed -> HelperState.FAILED
            state == BuiltinShellStatus.Connecting -> HelperState.CONNECTING
            shell != null -> HelperState.RUNNING
            state == BuiltinShellStatus.WirelessDebuggingOff -> HelperState.WIRELESS_DEBUGGING_OFF
            else -> HelperState.NOT_PAIRED
        }
        val discovery = if (supported) manager.engine.pairingDiscovery.value else PairingDiscovery.Idle
        val tier = if (supported && accessibility && helper == HelperState.RUNNING) PhoneTier.VIRTUAL else PhoneTier.MAIN
        val failure = (state as? BuiltinShellStatus.Failed)?.reason?.let { reason ->
            when (reason) {
                BuiltinShellFailure.WrongCode -> HelperFailure.WRONG_CODE
                BuiltinShellFailure.PairingWindowClosed -> HelperFailure.PAIRING_WINDOW_CLOSED
                BuiltinShellFailure.NoWifi -> HelperFailure.NO_WIFI
                BuiltinShellFailure.WifiNotAllowed -> HelperFailure.WIFI_NOT_ALLOWED
                BuiltinShellFailure.ConnectFailed -> HelperFailure.CONNECT_FAILED
                BuiltinShellFailure.AuthorizationRevoked -> HelperFailure.AUTHORIZATION_REVOKED
                BuiltinShellFailure.KeyUnreadable -> HelperFailure.KEY_UNREADABLE
                BuiltinShellFailure.HelperStartFailed -> HelperFailure.HELPER_START_FAILED
                else -> HelperFailure.UNKNOWN
            }
        }
        return PhoneStatus(Build.VERSION.SDK_INT, tier, tier == PhoneTier.VIRTUAL && Build.VERSION.SDK_INT < PHONE_VIRTUAL_STABLE_API,
            accessibility, Settings.canDrawOverlays(app), app.getSystemService(PowerManager::class.java).isIgnoringBatteryOptimizations(app.packageName),
            when {
                discovery != PairingDiscovery.Idle -> PairingState.SEARCHING
                supported && manager.engine.paired -> PairingState.PAIRED
                else -> PairingState.UNPAIRED
            }, (discovery as? PairingDiscovery.Found)?.port, helper, failure.takeIf { helper == HelperState.FAILED })
    }

    private fun attach(activity: Activity, engine: FlutterEngine) {
        detach?.invoke()
        if (supported) manager.start()
        val owner = WeakReference(activity)
        val methods = MethodChannel(engine.dartExecutor.binaryMessenger, PHONE_METHOD_CHANNEL)
        val eventChannel = EventChannel(engine.dartExecutor.binaryMessenger, PHONE_EVENT_CHANNEL)
        val frameChannel = EventChannel(engine.dartExecutor.binaryMessenger, PHONE_FRAME_CHANNEL)
        val calls = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
        methods.setMethodCallHandler { call, result ->
            calls.launch {
                try {
                    val args = JSONObject(call.arguments as? String ?: "{}")
                    val answer = when (call.method) {
                        "status" -> encodeStatus(status())
                        "openSettings" -> JSONObject().put("opened", openSettings(owner.get(), args.getString("kind")))
                        "startPairing" -> {
                            requireSupported()
                            PairingService.start(app)
                            pairing.startRepair(); pairing.begin()
                            encodeStatus(status())
                        }
                        "submitCode" -> {
                            requireSupported()
                            val code = PairingCode.normalize(args.getString("code")) ?: throw IllegalArgumentException("invalid_code")
                            val port = if (args.has("port")) (args.get("port") as? Number)?.let {
                                it.toInt().takeIf { p -> p in 1..65535 && it.toDouble() == p.toDouble() }
                            } ?: throw IllegalArgumentException("invalid_port") else null
                            operations.withLock { pairing.pair(code, port) }
                            encodeStatus(status())
                        }
                        "ensureHelper" -> { need(); encodeStatus(status()) }
                        "unpair" -> {
                            if (supported) operations.withLock { pairing.end(); manager.engine.unpair() }
                            encodeStatus(status())
                        }
                        "selfCheck" -> {
                            val checks = withContext(Dispatchers.IO) { selfCheck?.run() ?: listOf(SelfCheckItem("helper", shell != null, null)) }
                            JSONObject().put("checks", JSONArray().apply { checks.forEach { c ->
                                put(JSONObject().put("id", c.id).put("ok", c.ok).apply { c.detail?.let { put("detail", it) } })
                            } })
                        }
                        "setPreview" -> { visible = args.get("visible") as? Boolean ?: throw IllegalArgumentException("invalid_preview"); JSONObject() }
                        "takeover", "handBack" -> {
                            val taskId = args.getString("task_id").takeIf { it.isNotBlank() } ?: throw IllegalArgumentException("invalid_task")
                            val state = withContext(Dispatchers.IO) {
                                if (call.method == "takeover") takeover?.takeover(taskId) else takeover?.handBack(taskId)
                            } ?: TakeoverState.FAILED
                            JSONObject().put("state", state.wire)
                        }
                        else -> { result.notImplemented(); return@launch }
                    }
                    result.success(answer.toString())
                } catch (e: CancellationException) { throw e }
                catch (e: Exception) {
                    val code = e.message?.takeIf { it in SAFE_ERRORS } ?: "unknown"
                    result.error("phone_error", code, null)
                }
            }
        }
        eventChannel.setStreamHandler(object : EventChannel.StreamHandler {
            override fun onListen(arguments: Any?, sink: EventChannel.EventSink) {
                events = sink
                statusWatch?.cancel()
                statusWatch = scope.launch {
                    var previous: String? = null
                    while (isActive) {
                        val encoded = encodeStatus(status()).toString()
                        if (encoded != previous) { emit(JSONObject().put("type", "status").put("status", JSONObject(encoded))); previous = encoded }
                        delay(500)
                    }
                }
            }
            override fun onCancel(arguments: Any?) { events = null; statusWatch?.cancel() }
        })
        frameChannel.setStreamHandler(object : EventChannel.StreamHandler {
            override fun onListen(arguments: Any?, sink: EventChannel.EventSink) { frames = sink }
            override fun onCancel(arguments: Any?) { frames = null }
        })
        val listener = object : FlutterEngine.EngineLifecycleListener {
            override fun onPreEngineRestart() { events = null; frames = null; visible = false; statusWatch?.cancel() }
            override fun onEngineWillDestroy() { detach?.invoke() }
        }
        engine.addEngineLifecycleListener(listener)
        detach = {
            calls.cancel(); statusWatch?.cancel(); events = null; frames = null; visible = false
            methods.setMethodCallHandler(null); eventChannel.setStreamHandler(null); frameChannel.setStreamHandler(null)
            engine.removeEngineLifecycleListener(listener)
            detach = null
        }
    }

    private fun requireSupported() { check(supported) { "unsupported" } }
    private fun openSettings(activity: Activity?, kind: String): Boolean {
        val packageUri = Uri.parse("package:${app.packageName}")
        val intents = when (kind) {
            "accessibility" -> listOf(Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS))
            "overlay" -> listOf(Intent(Settings.ACTION_MANAGE_OVERLAY_PERMISSION, packageUri))
            "battery" -> listOf(Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS))
            "developer" -> DeveloperSettings.developerOptionsPage()
            "wireless_debugging" -> DeveloperSettings.wirelessDebuggingPage()
            "wifi" -> DeveloperSettings.wifiPage()
            else -> throw IllegalArgumentException("invalid_settings")
        }
        return intents.any { runCatching {
            if (activity != null) activity.startActivity(it) else app.startActivity(it.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
            true
        }.getOrDefault(false) }
    }

    companion object {
        @Volatile private var instance: PhoneBridge? = null
        fun of(context: Context): PhoneBridge = instance ?: synchronized(this) {
            instance ?: PhoneBridge(context.applicationContext).also { instance = it }
        }
        fun register(activity: Activity, engine: FlutterEngine) = of(activity).attach(activity, engine)
        private val SAFE_ERRORS = setOf("unsupported", "invalid_code", "invalid_port", "invalid_preview", "invalid_task", "invalid_settings")
        fun encodeStatus(s: PhoneStatus): JSONObject = JSONObject()
            .put("schema_version", PHONE_SCHEMA_VERSION).put("api_level", s.apiLevel).put("tier", s.tier.wire)
            .put("experimental", s.experimental).put("accessibility", s.accessibility).put("overlay", s.overlay)
            .put("battery_whitelisted", s.batteryWhitelisted).put("pairing", s.pairing.wire).put("helper", s.helper.wire)
            .apply {
                s.pairingPort?.let { put("pairing_port", it) }
                s.helperFailure?.let { put("helper_failure", it.wire); put("helper_fix", it.fix.wire) }
            }
    }
}
