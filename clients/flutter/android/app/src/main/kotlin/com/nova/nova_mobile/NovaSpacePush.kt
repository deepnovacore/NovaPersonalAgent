package com.nova.nova_mobile

import android.Manifest
import android.app.Activity
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.os.Handler
import android.os.Looper
import com.google.firebase.FirebaseApp
import com.google.firebase.FirebaseOptions
import com.google.firebase.messaging.FirebaseMessaging
import io.flutter.plugin.common.BinaryMessenger
import io.flutter.plugin.common.EventChannel
import io.flutter.plugin.common.MethodChannel

class NovaSpacePush(private val activity: Activity, messenger: BinaryMessenger) : EventChannel.StreamHandler {
    private var permissionReply: MethodChannel.Result? = null
    init {
        initialize(activity)
        MethodChannel(messenger, "nova/space_push").setMethodCallHandler { call, reply ->
            val args = call.arguments as? Map<*, *> ?: emptyMap<Any, Any>()
            when (call.method) {
                "requestPermission" -> {
                    if (Build.VERSION.SDK_INT >= 33 && activity.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
                        if (permissionReply != null) { reply.error("permission_pending", null, null) }
                        else { permissionReply = reply; activity.requestPermissions(arrayOf(Manifest.permission.POST_NOTIFICATIONS), permissionCode) }
                    } else reply.success(activity.getSystemService(NotificationManager::class.java).areNotificationsEnabled())
                }
                "getToken" -> {
                    if (BuildConfig.NOVA_PUSH_PROVIDER == "mipush") {
                        val token = activity.getSharedPreferences("nova_push", Context.MODE_PRIVATE).getString("mipush_token", null)
                        reply.success(token?.let { mapOf("provider" to "mipush", "token" to it) })
                    } else if (FirebaseApp.getApps(activity).isEmpty()) reply.success(null)
                    else FirebaseMessaging.getInstance().token.addOnCompleteListener { task ->
                        reply.success(if (task.isSuccessful) mapOf("provider" to "fcm", "token" to task.result) else null)
                    }
                }
                "configureSpace" -> {
                    try {
                        val handle = args["handle"] as? String ?: error("invalid_config")
                        (args["notificationKey"] as? String)?.let { NovaPushCrypto.save(activity, handle, it) }
                        reply.success(null)
                    } catch (_: Exception) { reply.error("push_key_unavailable", null, null) }
                }
                "removeSpace" -> { (args["handle"] as? String)?.let { NovaPushCrypto.remove(activity, it) }; reply.success(null) }
                else -> reply.notImplemented()
            }
        }
        EventChannel(messenger, "nova/space_push/events").setStreamHandler(this)
        opened(activity.intent)
    }
    fun onRequestPermissionsResult(code: Int, grants: IntArray) {
        if (code != permissionCode) return
        permissionReply?.success(grants.firstOrNull() == PackageManager.PERMISSION_GRANTED); permissionReply = null
    }
    override fun onListen(arguments: Any?, eventSink: EventChannel.EventSink) {
        sink = eventSink
        synchronized(pending) { pending.forEach { sink?.success(it) }; pending.clear() }
        val prefs = activity.getSharedPreferences("nova_push", Context.MODE_PRIVATE)
        if (prefs.getBoolean("sync_required", false)) { emit(mapOf("type" to "syncRequired")); prefs.edit().remove("sync_required").apply() }
    }
    override fun onCancel(arguments: Any?) { sink = null }
    fun close() { permissionReply?.error("activity_closed", null, null); permissionReply = null; sink = null }
    companion object {
        private const val permissionCode = 7430
        private var sink: EventChannel.EventSink? = null
        private val pending = mutableListOf<Map<String, String>>()
        private val main = Handler(Looper.getMainLooper())
        private var initialized = false
        @Synchronized fun initialize(context: Context) {
            if (initialized) return
            initialized = true
            if (BuildConfig.NOVA_PUSH_PROVIDER == "mipush") {
                try { Class.forName("com.nova.nova_mobile.NovaMiPush").getMethod("register", Context::class.java).invoke(null, context.applicationContext) } catch (_: Exception) { /* Unsupported build: app still pulls its mailbox. */ }
                return
            }
            if (FirebaseApp.getApps(context).isEmpty() && BuildConfig.NOVA_FCM_APPLICATION_ID.isNotEmpty()) {
                try { FirebaseApp.initializeApp(context, FirebaseOptions.Builder().setApplicationId(BuildConfig.NOVA_FCM_APPLICATION_ID)
                    .setApiKey(BuildConfig.NOVA_FCM_API_KEY).setProjectId(BuildConfig.NOVA_FCM_PROJECT_ID).setGcmSenderId(BuildConfig.NOVA_FCM_SENDER_ID).build()) } catch (_: Exception) { }
            }
        }
        fun emit(event: Map<String, String>) { main.post { val current = sink; if (current != null) current.success(event) else synchronized(pending) { pending.add(event); if (pending.size > 32) pending.removeAt(0) } } }
        fun token(context: Context, provider: String, token: String) {
            context.getSharedPreferences("nova_push", Context.MODE_PRIVATE).edit().putString("${provider}_token", token).apply()
            emit(mapOf("type" to "token", "provider" to provider, "token" to token))
        }
        fun opened(intent: Intent?) {
            if (intent == null) return
            val vendor = if (intent.hasExtra("nova_notification_id")) null else try {
                Class.forName("com.nova.nova_mobile.NovaMiPush").getMethod("readOpen", Intent::class.java).invoke(null, intent) as? Map<*, *>
            } catch (_: Exception) { null }
            val id = intent.getStringExtra("nova_notification_id") ?: vendor?.get("notificationId") as? String ?: return
            val event = mutableMapOf("type" to "open", "notificationId" to id)
            (vendor?.get("handle") as? String)?.let { event["handle"] = it }
            intent.getStringExtra("nova_push_handle")?.let { event["handle"] = it }
            intent.removeExtra("nova_notification_id"); intent.removeExtra("nova_push_handle"); emit(event)
        }
        fun notify(context: Context, data: Map<String, String>) {
            val id = data["notificationId"]?.takeIf { it.length <= 128 } ?: return
            val handle = data["handle"]?.takeIf { it.length <= 128 } ?: return
            val decoded = try { NovaPushCrypto.decrypt(context, handle, data["ciphertext"] ?: "") } catch (_: Exception) { Pair("Nova", "Open Nova to view new updates.") }
            val manager = context.getSystemService(NotificationManager::class.java)
            if (!manager.areNotificationsEnabled()) return
            val channel = "nova_space_updates"
            if (Build.VERSION.SDK_INT >= 26) manager.createNotificationChannel(NotificationChannel(channel, "Space updates", NotificationManager.IMPORTANCE_DEFAULT))
            val intent = Intent(context, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP)
                .putExtra("nova_notification_id", id).putExtra("nova_push_handle", handle)
            // Extras are not part of PendingIntent identity: use an opaque URI to keep distinct notifications distinct.
            intent.data = android.net.Uri.parse("nova-push://open/" + android.net.Uri.encode(handle) + "/" + android.net.Uri.encode(id))
            val pending = PendingIntent.getActivity(context, 0, intent, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
            val builder = if (Build.VERSION.SDK_INT >= 26) android.app.Notification.Builder(context, channel) else android.app.Notification.Builder(context)
            try { manager.notify("$handle:$id", 0, builder.setSmallIcon(com.nova.nova_mobile.R.mipmap.ic_launcher).setContentTitle(decoded.first).setContentText(decoded.second).setContentIntent(pending).setAutoCancel(true).build()) } catch (_: SecurityException) { }
        }
    }
}
