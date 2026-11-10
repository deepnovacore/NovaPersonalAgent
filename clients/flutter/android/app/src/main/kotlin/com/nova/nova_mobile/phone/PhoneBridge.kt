package com.nova.nova_mobile.phone

import android.app.Activity
import android.app.Application
import android.app.NotificationManager
import android.content.Context
import android.content.Intent
import android.content.SharedPreferences
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.os.PowerManager
import android.provider.Settings
import androidx.core.app.NotificationManagerCompat
import com.nova.nova_mobile.LocalGuiService
import com.nova.nova_mobile.phone.a11y.PHONE_PREFERENCES
import com.nova.nova_mobile.phone.a11y.PHONE_EXPERIMENTAL_ACK
import com.nova.nova_mobile.phone.a11y.phoneTierFor
import com.nova.nova_mobile.phone.setup.*
import com.nova.nova_mobile.phone.shell.HelperHub
import com.nova.nova_mobile.phone.shell.INovaShell
import com.nova.phone.core.shell.*
import io.flutter.embedding.engine.FlutterEngine
import io.flutter.plugin.common.EventChannel
import io.flutter.plugin.common.MethodChannel
import kotlinx.coroutines.*
import kotlinx.coroutines.flow.*
import java.util.concurrent.ConcurrentHashMap
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
    /** MainActivity installs a dynamic reader of LocalGuiService.current (never a captured service). */
    @Volatile var pairingWindowReader: PairingWindowReader? = null
    private val runHooks = PhoneRunHooks()
    var takeover: PhoneTakeover?
        get() = runHooks.takeover
        set(value) { runHooks.takeover = value }
    var selfCheck: PhoneSelfCheck?
        get() = runHooks.selfCheck
        set(value) { runHooks.selfCheck = value }
    fun clearRunHooks(owner: PhoneTakeover) = runHooks.clear(owner)
    private val preferences by lazy { app.getSharedPreferences(PHONE_PREFERENCES, Context.MODE_PRIVATE) }
    private val preferenceChanges = MutableStateFlow(0L)
    private class Registration(var activity: WeakReference<Activity>) {
        @Volatile var events: EventChannel.EventSink? = null
        @Volatile var frames: EventChannel.EventSink? = null
        @Volatile var visible = false
        var statusWatch: Job? = null
        lateinit var detach: () -> Unit
        fun clearStreams() {
            statusWatch?.cancel()
            events = null; frames = null; visible = false
        }
    }
    private val registrations = ConcurrentHashMap<FlutterEngine, Registration>()
    override val shell: INovaShell? get() = hub.shell.value
    override val previewVisible: Boolean get() = registrations.values.any { it.visible && it.frames != null }
    override fun need() {
        scope.launch(Dispatchers.IO) { runCatching { if (supported) { manager.start(); manager.need() } } }
    }
    private val supported get() = Build.VERSION.SDK_INT >= PHONE_VIRTUAL_MIN_API

    override fun emit(event: JSONObject) {
        val encoded = event.toString()
        registrations.values.forEach { registration ->
            val sink = registration.events ?: return@forEach
            main.post { if (registration.events === sink) sink.success(encoded) }
        }
    }
    override fun frame(jpeg: ByteArray) {
        if (!previewVisible) return
        val bytes = jpeg.copyOf()
        registrations.values.forEach { registration ->
            val sink = registration.frames?.takeIf { registration.visible } ?: return@forEach
            main.post { if (registration.visible && registration.frames === sink) sink.success(bytes) }
        }
    }

    private data class Permissions(val accessibility: Boolean, val overlay: Boolean, val battery: Boolean, val notifications: Boolean)

    /** Null until the first read, so no status is ever projected from unread (all-false) flags. */
    private val permissionFlags = MutableStateFlow<Permissions?>(null)
    private val activities = ResumedPhoneActivities()

    init {
        (app as Application).registerActivityLifecycleCallbacks(object : Application.ActivityLifecycleCallbacks {
            override fun onActivityResumed(activity: Activity) { activities.resume(activity) }
            override fun onActivityPaused(activity: Activity) { activities.pause(activity) }
            override fun onActivityDestroyed(activity: Activity) { activities.pause(activity) }
            override fun onActivityCreated(activity: Activity, state: Bundle?) = Unit
            override fun onActivityStarted(activity: Activity) = Unit
            override fun onActivityStopped(activity: Activity) = Unit
            override fun onActivitySaveInstanceState(activity: Activity, state: Bundle) = Unit
        })
        scope.launch { pollPhonePermissions(activities.resumed) { permissionFlags.value = permissions() } }
    }

    private suspend fun permissions(): Permissions = withContext(Dispatchers.IO) {
        Permissions(LocalGuiService.current != null, Settings.canDrawOverlays(app),
            app.getSystemService(PowerManager::class.java).isIgnoringBatteryOptimizations(app.packageName),
            PairingNotifier.notificationsAllowed(app))
    }

    /** All system queries and the first preferences/engine load stay off Flutter's main thread. */
    suspend fun status(): PhoneStatus = status(permissions().also { permissionFlags.value = it })

    private suspend fun status(permissions: Permissions): PhoneStatus = withContext(Dispatchers.IO) {
        // A static field read, so it stays live in the background where the other flags are only polled on resume.
        val accessibility = LocalGuiService.current != null
        val state = if (supported) manager.engine.status.value else null
        val discovery = if (supported) manager.engine.pairingDiscovery.value else PairingDiscovery.Idle
        projectStatus(Build.VERSION.SDK_INT, accessibility, shell != null, state, discovery,
            supported && manager.engine.paired, permissions.overlay, permissions.battery, permissions.notifications,
            if (supported) PhoneSetupFlow.stage(state!!, discovery, pairing.repairing.value, manager.engine.exchangingCode.value) else PairingStage.IDLE,
            preferences.getBoolean(PHONE_EXPERIMENTAL_ACK, false))
    }

    /** Helper events remain live in the background, combined with the last foreground permission refresh. */
    private fun statuses(): Flow<PhoneStatus> = flow {
        val changes = if (supported) {
            val e = withContext(Dispatchers.IO) { manager.engine }
            combine(e.status, hub.shell, e.pairingDiscovery, e.exchangingCode, pairing.repairing) { _, _, _, _, _ -> Unit }
        } else flowOf(Unit)
        emitAll(combine(changes, readPermissionFlags(permissionFlags, ::permissions), preferenceChanges) { _, flags, _ -> status(flags) })
    }.distinctUntilChanged()

    private fun attach(activity: Activity, engine: FlutterEngine) {
        registrations[engine]?.let { it.activity = WeakReference(activity); return }
        scope.launch(Dispatchers.IO) { if (supported) manager.start() }
        val methods = MethodChannel(engine.dartExecutor.binaryMessenger, PHONE_METHOD_CHANNEL)
        val eventChannel = EventChannel(engine.dartExecutor.binaryMessenger, PHONE_EVENT_CHANNEL)
        val frameChannel = EventChannel(engine.dartExecutor.binaryMessenger, PHONE_FRAME_CHANNEL)
        val calls = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
        val registration = Registration(WeakReference(activity))
        registrations[engine] = registration
        methods.setMethodCallHandler { call, result ->
            calls.launch(start = CoroutineStart.UNDISPATCHED) {
                try {
                    val args = JSONObject(call.arguments as? String ?: "{}")
                    val answer = when (call.method) {
                        "status" -> encodeStatus(status())
                        "openSettings" -> JSONObject().put("opened", openSettings(registration.activity.get(), args.optString("kind")))
                        "setExperimentalAck" -> {
                            val acknowledged = acknowledgedArgument(args)
                            withContext(Dispatchers.IO) { setExperimentalAck(preferences, acknowledged) }
                            preferenceChanges.value++
                            encodeStatus(status())
                        }
                        "startPairing" -> {
                            requireSupported()
                            PairingService.start(app)
                            withContext(Dispatchers.IO) { manager.start(); pairing.startRepair(); pairing.begin() }
                            encodeStatus(status())
                        }
                        "submitCode" -> {
                            requireSupported()
                            val code = PairingCode.normalize(args.getString("code")) ?: throw IllegalArgumentException("invalid_code")
                            val port = if (args.has("port")) (args.get("port") as? Number)?.let {
                                it.toInt().takeIf { p -> p in 1..65535 && it.toDouble() == p.toDouble() }
                            } ?: throw IllegalArgumentException("invalid_port") else null
                            operations.withLock { withContext(Dispatchers.IO) { pairing.pair(code, port) } }
                            encodeStatus(status())
                        }
                        "ensureHelper" -> { need(); encodeStatus(status()) }
                        "unpair" -> {
                            if (supported) operations.withLock { withContext(Dispatchers.IO) { pairing.end(); manager.engine.unpair() } }
                            encodeStatus(status())
                        }
                        "selfCheck" -> {
                            val checks = withContext(Dispatchers.IO) { selfCheck?.run() ?: throw IllegalStateException("accessibility_unavailable") }
                            encodeSelfCheck(checks)
                        }
                        "setPreview" -> { registration.visible = args.opt("visible") as? Boolean ?: throw IllegalArgumentException("invalid_preview"); JSONObject() }
                        "takeover", "handBack" -> {
                            val taskId = args.optString("task_id").takeIf { it.isNotBlank() } ?: throw IllegalArgumentException("invalid_task")
                            val state = withContext(Dispatchers.IO) {
                                if (call.method == "takeover") takeover?.takeover(taskId) else takeover?.handBack(taskId)
                            } ?: throw IllegalStateException("task_not_running")
                            JSONObject().put("state", state.wire)
                        }
                        else -> { result.notImplemented(); return@launch }
                    }
                    result.success(answer.toString())
                } catch (e: CancellationException) { result.error("phone_error", "unknown", null); throw e }
                catch (e: Exception) {
                    val code = safeError(e)
                    result.error("phone_error", code, null)
                }
            }
        }
        eventChannel.setStreamHandler(object : EventChannel.StreamHandler {
            override fun onListen(arguments: Any?, sink: EventChannel.EventSink) {
                registration.events = sink
                registration.statusWatch?.cancel()
                registration.statusWatch = calls.launch {
                    statuses().collect { status ->
                        if (registration.events === sink) sink.success(JSONObject().put("type", "status")
                            .put("status", encodeStatus(status)).toString())
                    }
                }
            }
            override fun onCancel(arguments: Any?) {
                registration.events = null; registration.statusWatch?.cancel()
            }
        })
        frameChannel.setStreamHandler(object : EventChannel.StreamHandler {
            override fun onListen(arguments: Any?, sink: EventChannel.EventSink) { registration.frames = sink }
            override fun onCancel(arguments: Any?) { registration.frames = null }
        })
        val listener = object : FlutterEngine.EngineLifecycleListener {
            override fun onPreEngineRestart() { calls.coroutineContext.cancelChildren(); registration.clearStreams() }
            override fun onEngineWillDestroy() { registration.detach() }
        }
        engine.addEngineLifecycleListener(listener)
        registration.detach = {
            calls.cancel(); registration.clearStreams()
            methods.setMethodCallHandler(null); eventChannel.setStreamHandler(null); frameChannel.setStreamHandler(null)
            registrations.remove(engine, registration)
        }
    }

    private fun requireSupported() { check(supported) { "unsupported" } }
    private suspend fun openSettings(activity: Activity?, kind: String): Boolean {
        val packageUri = Uri.parse("package:${app.packageName}")
        // Exhaustive over the contract kinds, so a kind added to SettingsKind cannot go unhandled.
        val intents = when (settingsKind(kind)) {
            SettingsKind.ACCESSIBILITY -> listOf(Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS))
            SettingsKind.OVERLAY -> listOf(Intent(Settings.ACTION_MANAGE_OVERLAY_PERMISSION, packageUri))
            SettingsKind.BATTERY -> listOf(Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS))
            SettingsKind.DEVELOPER -> DeveloperSettings.developerOptionsPage()
            SettingsKind.WIRELESS_DEBUGGING -> DeveloperSettings.wirelessDebuggingPage()
            SettingsKind.WIFI -> DeveloperSettings.wifiPage()
            SettingsKind.NOTIFICATIONS, SettingsKind.APP_INFO -> {
                val blockedChannel = if (kind == SettingsKind.NOTIFICATIONS.wire && Build.VERSION.SDK_INT >= 26) withContext(Dispatchers.IO) {
                    if (!NotificationManagerCompat.from(app).areNotificationsEnabled()) null else {
                        val nm = app.getSystemService(NotificationManager::class.java)
                        PairingChannel.IDS.mapNotNull { nm.getNotificationChannel(it) }.lastOrNull()
                            ?.takeIf { it.importance == NotificationManager.IMPORTANCE_NONE }?.id
                    }
                } else null
                phoneAppSettingsIntents(kind, app.packageName, Build.VERSION.SDK_INT, blockedChannel).map { it.toIntent() }
            }
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
        internal val SAFE_ERRORS = setOf("unsupported", "invalid_code", "invalid_port", "invalid_preview", "invalid_task", "invalid_settings",
            "invalid_acknowledged", "run_active", "task_not_running", "no_takeover", "takeover_on_main_thread",
            "takeover_unavailable", "accessibility_flags_failed", "accessibility_unavailable", "helper_unavailable", "display_unavailable")
        internal fun settingsKind(wire: String): SettingsKind =
            SettingsKind.entries.firstOrNull { it.wire == wire } ?: throw IllegalArgumentException("invalid_settings")
        internal fun safeError(error: Exception): String = error.message?.takeIf { it in SAFE_ERRORS } ?: "unknown"
        /** `setExperimentalAck` argument; a missing or non-boolean value is `invalid_acknowledged`, never `unknown`. */
        internal fun acknowledgedArgument(args: JSONObject): Boolean =
            args.opt("acknowledged") as? Boolean ?: throw IllegalArgumentException("invalid_acknowledged")
        internal fun setExperimentalAck(preferences: SharedPreferences, acknowledged: Boolean) {
            preferences.edit().putBoolean(PHONE_EXPERIMENTAL_ACK, acknowledged).apply()
        }
        internal fun projectStatus(
            apiLevel: Int, accessibility: Boolean, helperAlive: Boolean, state: BuiltinShellStatus?,
            discovery: PairingDiscovery, paired: Boolean, overlay: Boolean, battery: Boolean,
            notifications: Boolean, stage: PairingStage, experimentalAcknowledged: Boolean = false,
        ): PhoneStatus {
            val helper = when {
                apiLevel < PHONE_VIRTUAL_MIN_API -> HelperState.UNSUPPORTED
                helperAlive -> HelperState.RUNNING
                state is BuiltinShellStatus.Failed -> HelperState.FAILED
                state == BuiltinShellStatus.Connecting -> HelperState.CONNECTING
                state == BuiltinShellStatus.WirelessDebuggingOff -> HelperState.WIRELESS_DEBUGGING_OFF
                else -> HelperState.NOT_PAIRED
            }
            val tier = phoneTierFor(apiLevel, accessibility, helper == HelperState.RUNNING, experimentalAcknowledged)
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
            return PhoneStatus(apiLevel, tier, apiLevel in PHONE_VIRTUAL_MIN_API until PHONE_VIRTUAL_STABLE_API,
                accessibility, overlay, battery,
                when { discovery != PairingDiscovery.Idle -> PairingState.SEARCHING
                    paired -> PairingState.PAIRED
                    else -> PairingState.UNPAIRED },
                (discovery as? PairingDiscovery.Found)?.port, helper, failure, notifications, stage, experimentalAcknowledged)
        }

        internal fun encodeSelfCheck(checks: List<SelfCheckItem>): JSONObject = JSONObject().put("checks", JSONArray().apply {
            checks.forEach { c -> put(JSONObject().put("id", c.id).put("ok", c.ok).apply { c.detail?.let { put("detail", it) } }) }
        })

        fun encodeStatus(s: PhoneStatus): JSONObject = JSONObject()
            .put("schema_version", PHONE_SCHEMA_VERSION).put("api_level", s.apiLevel).put("tier", s.tier.wire)
            .put("experimental_ack", s.experimentalAck).put("experimental", s.experimental).put("accessibility", s.accessibility).put("overlay", s.overlay)
            .put("notifications_allowed", s.notificationsAllowed).put("pairing_stage", s.pairingStage.wire)
            .put("battery_whitelisted", s.batteryWhitelisted).put("pairing", s.pairing.wire).put("helper", s.helper.wire)
            .apply {
                s.pairingPort?.let { put("pairing_port", it) }
                s.helperFailure?.let { put("helper_failure", it.wire); put("helper_fix", it.fix.wire) }
            }
    }
}
