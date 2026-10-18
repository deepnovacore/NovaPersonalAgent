package com.nova.nova_mobile

import android.app.job.JobInfo
import android.app.job.JobParameters
import android.app.job.JobScheduler
import android.app.job.JobService
import android.app.KeyguardManager
import android.app.Activity
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.Notification
import android.app.PendingIntent
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.content.ComponentName
import android.content.Context
import android.os.Handler
import android.os.Looper
import io.flutter.embedding.engine.FlutterEngine
import io.flutter.embedding.engine.dart.DartExecutor
import io.flutter.FlutterInjector
import io.flutter.plugin.common.MethodChannel
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.TimeZone

/** One process-wide engine owns the scheduler store, including cold job starts. */
object NovaScheduleBridge {
    private const val JOB = 48271
    private val handler = Handler(Looper.getMainLooper())
    private var owner: FlutterEngine? = null
    private var channel: MethodChannel? = null
    private var headless: FlutterEngine? = null
    private var ready = false
    private var completion: ((Boolean) -> Unit)? = null
    private var pendingOwner: (() -> Unit)? = null
    private var context: Context? = null
    private var wakeGeneration = 0L

    fun install(app: Context, engine: FlutterEngine) {
        context = app.applicationContext
        val candidate = MethodChannel(engine.dartExecutor.binaryMessenger, "nova/schedule/v1")
        candidate.setMethodCallHandler { call, result ->
            try {
                val args = call.arguments as? Map<*, *> ?: emptyMap<Any, Any>()
                when (call.method) {
                    "localDay" -> result.success(NovaScheduleCalendar.format(args["timezone"] as String).format(Date((args["instant"] as Number).toLong())).take(10))
                    "resolve" -> result.success(NovaScheduleCalendar.resolve(args["timezone"] as String, args["date"] as String, args["time"] as String))
                    "acquire" -> {
                        val acquire = { owner = engine; channel = candidate; ready = false; result.success(true) }
                        if (owner == null || owner === engine) acquire()
                        else if (owner === headless && pendingOwner == null) pendingOwner = acquire
                        else result.success(false)
                    }
                    "ready" -> { check(owner === engine); ready = true; result.success(null); if (completion != null) dispatch() }
                    "configure" -> {
                        check(owner === engine)
                        val enabled = args["enabled"] == true
                        app.getSharedPreferences("nova-schedule-wake", 0).edit().putBoolean("enabled", enabled).apply()
                        configure(app, enabled); result.success(null)
                    }
                    "release" -> { if (owner === engine) release(); result.success(null) }
                    "requestNotifications" -> {
                        if (Build.VERSION.SDK_INT >= 33 && app is Activity && app.checkSelfPermission("android.permission.POST_NOTIFICATIONS") != PackageManager.PERMISSION_GRANTED) app.requestPermissions(arrayOf("android.permission.POST_NOTIFICATIONS"), 48271)
                        result.success(null)
                    }
                    "notifyWaiting" -> { notifyWaiting(app); result.success(null) }
                    else -> result.notImplemented()
                }
            } catch (_: Exception) { result.error("schedule_unavailable", "Schedule operation unavailable", null) }
        }
    }
    private fun notifyWaiting(app: Context) {
        if (Build.VERSION.SDK_INT >= 33 && app.checkSelfPermission("android.permission.POST_NOTIFICATIONS") != PackageManager.PERMISSION_GRANTED) return
        val manager = app.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        if (Build.VERSION.SDK_INT >= 26) manager.createNotificationChannel(NotificationChannel("nova-schedules", "Nova 定时任务", NotificationManager.IMPORTANCE_DEFAULT))
        val intent = PendingIntent.getActivity(app, JOB, Intent(app, MainActivity::class.java), PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
        val builder = if (Build.VERSION.SDK_INT >= 26) Notification.Builder(app, "nova-schedules") else Notification.Builder(app)
        manager.notify(JOB, builder.setSmallIcon(app.applicationInfo.icon).setContentTitle("Nova 定时任务需要确认").setContentText("打开应用查看当前状态，未自动批准操作。").setContentIntent(intent).setAutoCancel(true).build())
    }
    private fun configure(app: Context, enabled: Boolean) {
        val scheduler = app.getSystemService(Context.JOB_SCHEDULER_SERVICE) as JobScheduler
        if (!enabled) { scheduler.cancel(JOB); return }
        if (scheduler.getPendingJob(JOB) != null) return
        val job = JobInfo.Builder(JOB, ComponentName(app, NovaScheduleJob::class.java))
            .setPeriodic(15 * 60 * 1000L).setRequiredNetworkType(JobInfo.NETWORK_TYPE_ANY)
            .setPersisted(true).setBackoffCriteria(30_000, JobInfo.BACKOFF_POLICY_EXPONENTIAL)
        check(scheduler.schedule(job.build()) == JobScheduler.RESULT_SUCCESS)
    }
    fun wake(app: Context, done: (Boolean) -> Unit) {
        if (completion != null) { done(false); return }
        if ((app.getSystemService(Context.KEYGUARD_SERVICE) as KeyguardManager).isDeviceLocked) {
            app.getSharedPreferences("nova-schedule-wake", 0).edit().putString("last_status", "foreground_unlock_required").apply()
            done(false); return
        }
        completion = done
        wakeGeneration++
        if (owner == null) {
            try {
                val loader = FlutterInjector.instance().flutterLoader()
                loader.startInitialization(app); loader.ensureInitializationComplete(app, null)
                val engine = FlutterEngine(app)
                headless = engine
                install(app, engine)
                engine.dartExecutor.executeDartEntrypoint(DartExecutor.DartEntrypoint(loader.findAppBundlePath(), "novaScheduleMain"))
            } catch (_: Exception) { finish(false) }
        } else if (ready) dispatch()
        // Bounds engine bootstrap too. Expiry never starts a replacement run.
        handler.postDelayed({ if (completion === done) expire() }, 8 * 60 * 1000L)
    }
    private fun dispatch() {
        val generation = wakeGeneration
        fun complete(success: Boolean) { if (generation == wakeGeneration) finish(success) }
        channel?.invokeMethod("wake", null, object : MethodChannel.Result {
            override fun success(value: Any?) = complete((value as? Map<*, *>)?.get("finished") == true)
            override fun error(code: String, message: String?, details: Any?) = complete(false)
            override fun notImplemented() = complete(false)
        })
    }
    fun expire() {
        val generation = wakeGeneration
        channel?.invokeMethod("expired", null)
        handler.postDelayed({ if (generation == wakeGeneration) finish(false) }, 1500)
    }
    private fun finish(success: Boolean) {
        val done = completion ?: return
        completion = null
        context?.getSharedPreferences("nova-schedule-wake", 0)?.edit()?.putString("last_status", if (success) "wake_returned" else "interrupted")?.apply()
        done(success)
        if (owner === headless || owner == null) {
            val engine = headless; headless = null; engine?.destroy(); release()
        }
    }
    private fun release() {
        owner = null; channel = null; ready = false
        val waiting = pendingOwner; pendingOwner = null; waiting?.invoke()
    }

}

class NovaScheduleJob : JobService() {
    private var active: JobParameters? = null
    override fun onStartJob(params: JobParameters): Boolean {
        active = params
        NovaScheduleBridge.wake(applicationContext) { success ->
            if (active === params) { active = null; jobFinished(params, !success) }
        }
        return true
    }
    override fun onStopJob(params: JobParameters): Boolean {
        if (active === params) { active = null; NovaScheduleBridge.expire() }
        return true
    }
}
