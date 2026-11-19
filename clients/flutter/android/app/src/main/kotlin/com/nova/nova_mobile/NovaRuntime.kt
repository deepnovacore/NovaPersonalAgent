package com.nova.nova_mobile

import android.app.Activity
import android.content.Context
import android.content.Intent
import android.content.pm.ApplicationInfo
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.provider.Settings
import com.nova.nova_mobile.phone.PhoneBridge
import com.nova.nova_mobile.phone.VirtualSelfCheck
import com.nova.nova_mobile.phone.setup.PairingWindowReader
import io.flutter.embedding.engine.FlutterEngine
import io.flutter.plugin.common.MethodChannel
import java.util.concurrent.Executors
import org.json.JSONArray
import org.json.JSONObject

/** Page recreation must not cancel the engine, native tasks or workspace commands. */
internal class NovaRuntime(context: Context) {
    private val app = context.applicationContext
    val engine = FlutterEngine(app)
    private val main = Handler(Looper.getMainLooper())
    private val worker = Executors.newSingleThreadExecutor()
    private var controller: LocalAgentController? = null
    private val workspace = LinuxWorkspaceHost(app, engine.dartExecutor.binaryMessenger)
    private var push: NovaSpacePush? = null

    fun attachPush(activity: Activity): NovaSpacePush = (push ?: NovaSpacePush(activity, engine.dartExecutor.binaryMessenger).also { push = it })
        .also { it.attach(activity) }

    init {
        NovaSpaceScope.install(engine.dartExecutor.binaryMessenger)
        val bridge = PhoneBridge.of(app)
        bridge.pairingWindowReader = object : PairingWindowReader {
            override val available get() = LocalGuiService.current != null
            override fun settingsWindowTexts() = LocalGuiService.current?.settingsWindowTexts() ?: emptyList()
        }
        val updateScope = {
            closeController()
            try {
                val current = LocalAgentController(app, NovaSpaceScope.standalone().id, bridge, bridge)
                controller = current
                bridge.takeover = current
                bridge.selfCheck = VirtualSelfCheck(app, bridge, current)
            } catch (_: Exception) { closeController() }
        }
        NovaSpaceScope.listen(this, updateScope)
        updateScope()
        MethodChannel(engine.dartExecutor.binaryMessenger,"nova/local_agent/v1").setMethodCallHandler { call,result ->
            try {
                NovaSpaceScope.standalone()
                check(controller != null) { "local_runtime_unavailable" }
                val args=JSONObject(call.arguments as? String?:"{}")
                val current = controller!!
                when(call.method){
                    "capabilities" -> result.success(JSONObject().put("schema_version",1).put("platform","android").put("host_package",app.packageName).put("android_api",Build.VERSION.SDK_INT).put("accessibility",LocalGuiService.current!=null).put("screenshots",Build.VERSION.SDK_INT>=30).put("model_runtime",true).put("model_configured",current.modelSettings().getBoolean("configured")).toString())
                    "modelSettings" -> result.success(current.modelSettings().toString())
                    "clearChatGptSettings" -> result.success(current.clearChatGptSettings(args.optString("space_id")).toString())
                    "clearModelSettings" -> result.success(current.clearModelSettings(args.getString("space_id")).toString())
                    "saveModelSettings" -> result.success(current.saveModelSettings(args).toString())
                    "run" -> worker.execute {
                        try {
                            val task=current.runModel(args).toString()
                            main.post { result.success(task) }
                        } catch(error:Throwable) {
                            main.post { result.error("local_agent_error",error.message,null) }
                        }
                    }
                    "approve" -> result.success(JSONObject().put("accepted",false).toString())
                    "apps" -> worker.execute {
                        try {
                            val rows=JSONArray()
                            app.packageManager.queryIntentActivities(Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_LAUNCHER),0)
                                .distinctBy {it.activityInfo.packageName}.sortedBy {it.loadLabel(app.packageManager).toString()}
                                .forEach { rows.put(JSONObject().put("package",it.activityInfo.packageName).put("label",it.loadLabel(app.packageManager).toString())) }
                            main.post { result.success(rows.toString()) }
                        } catch(error:Exception) {
                            main.post { result.error("local_agent_error",error.message,null) }
                        }
                    }
                    "accessibilitySettings" -> {app.startActivity(Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));result.success(null)}
                    // Stop bypasses the worker, including a blocked observation.
                    "stop" -> result.success(current.stop(args.getString("id"))?.toString())
                    "start" -> {
                        check(app.applicationInfo.flags and ApplicationInfo.FLAG_DEBUGGABLE != 0){"debug_command_only"}
                        result.success(current.start(args).toString())
                    }
                    "verify" -> result.success(current.verify(args.getString("id")).toString())
                    "tasks" -> result.success(current.tasks().toString())
                    "observe","execute","finish" -> worker.execute {
                        try {
                            check(app.applicationInfo.flags and ApplicationInfo.FLAG_DEBUGGABLE != 0){"debug_command_only"}
                            val reply=when(call.method){"observe"->current.observe(args);"execute"->current.execute(args);else->current.finish(args)}
                            main.post {result.success(reply.toString())}
                        }catch(error:Exception){main.post {result.error("local_agent_error",error.message,null)}}
                    }
                    else -> result.notImplemented()
                }
            }catch(error:Exception){
                val reason=error.message?.takeIf{it.matches(Regex("[a-z_]{1,80}"))} ?: error.javaClass.simpleName
                android.util.Log.w("NovaLocalAgent","${call.method} failed: $reason")
                result.error("local_agent_error",error.message,null)
            }
        }

        engine.addEngineLifecycleListener(object : FlutterEngine.EngineLifecycleListener {
            override fun onPreEngineRestart() {}
            override fun onEngineWillDestroy() {
                NovaSpaceScope.removeListener(this@NovaRuntime)
                closeController()
                workspace.dispose()
                push?.close()
                worker.shutdown()
            }
        })
    }
    private fun closeController() {
        controller?.let { current ->
            PhoneBridge.of(app).clearRunHooks(current)
            controller = null
            current.close()
        }
    }
}
