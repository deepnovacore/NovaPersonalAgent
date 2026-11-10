package com.nova.nova_mobile

import io.flutter.embedding.android.FlutterActivity
import io.flutter.embedding.engine.FlutterEngine
import io.flutter.plugin.common.MethodChannel
import android.content.Intent
import android.os.Build
import android.provider.Settings
import org.json.JSONObject
import org.json.JSONArray
import android.content.pm.ApplicationInfo
import java.util.concurrent.Executors
import com.nova.nova_mobile.phone.PhoneBridge
import com.nova.nova_mobile.phone.VirtualSelfCheck
import com.nova.nova_mobile.phone.setup.PairingWindowReader

class MainActivity : FlutterActivity() {
    private var controller: LocalAgentController? = null
    private var spacePush: NovaSpacePush? = null
    private var spaceTools: NovaSpaceTools? = null
    private var artifactHost: ArtifactWebHost? = null
    private var linuxWorkspaceHost: LinuxWorkspaceHost? = null
    override fun onResume() {
        super.onResume()
        artifactHost?.resume()
    }
    override fun onPause() {
        artifactHost?.pause()
        super.onPause()
    }
    override fun onDestroy() {
        NovaSpaceScope.removeListener(this)
        closeController()
        spacePush?.close()
        spaceTools?.close()
        artifactHost?.dispose()
        linuxWorkspaceHost?.dispose()
        linuxWorkspaceHost = null
        artifactHost = null
        super.onDestroy()
    }
    private fun closeController() {
        controller?.let { current ->
            PhoneBridge.of(applicationContext).clearRunHooks(current)
            controller = null
            current.close()
        }
    }
    override fun onCreate(savedInstanceState:android.os.Bundle?) {
        super.onCreate(savedInstanceState)
        // The isolated acceptance package stays visible while waiting for consent.
        // Production app and device-wide screen timeout are unaffected.
        if(packageName.endsWith(".autonomy") && applicationInfo.flags and ApplicationInfo.FLAG_DEBUGGABLE != 0) {
            window.addFlags(android.view.WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        }
    }
    override fun onNewIntent(intent: Intent) { super.onNewIntent(intent); setIntent(intent); NovaSpacePush.opened(intent) }
    override fun onRequestPermissionsResult(code: Int, permissions: Array<out String>, grantResults: IntArray) {
        super.onRequestPermissionsResult(code, permissions, grantResults)
        spacePush?.onRequestPermissionsResult(code, grantResults)
        spaceTools?.onRequestPermissionsResult(code, grantResults)
    }
    override fun onActivityResult(code: Int, resultCode: Int, data: Intent?) {
        super.onActivityResult(code, resultCode, data)
        spaceTools?.onActivityResult(code, resultCode, data)
    }
    companion object {
        private val worker=Executors.newSingleThreadExecutor()
    }
    override fun configureFlutterEngine(flutterEngine:FlutterEngine){
        super.configureFlutterEngine(flutterEngine)
        PhoneBridge.register(this, flutterEngine)
        val bridge = PhoneBridge.of(applicationContext)
        bridge.pairingWindowReader = object : PairingWindowReader {
            override val available get() = LocalGuiService.current != null
            override fun settingsWindowTexts() = LocalGuiService.current?.settingsWindowTexts() ?: emptyList()
        }
        NovaScheduleBridge.install(this, flutterEngine)
        spacePush = NovaSpacePush(this, flutterEngine.dartExecutor.binaryMessenger)
        spaceTools = NovaSpaceTools(this, flutterEngine.dartExecutor.binaryMessenger)
        linuxWorkspaceHost?.dispose()
        linuxWorkspaceHost = LinuxWorkspaceHost(this, flutterEngine.dartExecutor.binaryMessenger)
        artifactHost?.dispose()
        artifactHost = ArtifactWebHost(this, flutterEngine.dartExecutor.binaryMessenger)
        NovaSpaceScope.install(flutterEngine.dartExecutor.binaryMessenger)
        val updateScope = {
            closeController()
            try {
                val current = LocalAgentController(applicationContext, NovaSpaceScope.standalone().id, bridge, bridge)
                controller = current
                bridge.takeover = current
                bridge.selfCheck = VirtualSelfCheck(applicationContext, bridge, current)
            } catch (_: Exception) { closeController() }
        }
        NovaSpaceScope.listen(this, updateScope)
        updateScope()
        MethodChannel(flutterEngine.dartExecutor.binaryMessenger,"nova/local_agent/v1").setMethodCallHandler { call,result ->
            try {
                NovaSpaceScope.standalone()
                check(controller != null) { "local_runtime_unavailable" }
                val args=JSONObject(call.arguments as? String?:"{}")
                val current = controller!!
                when(call.method){
                    "capabilities" -> result.success(JSONObject().put("schema_version",1).put("platform","android").put("host_package",packageName).put("android_api",Build.VERSION.SDK_INT).put("accessibility",LocalGuiService.current!=null).put("screenshots",Build.VERSION.SDK_INT>=30).put("model_runtime",true).put("model_configured",current.modelSettings().getBoolean("configured")).toString())
                    "modelSettings" -> result.success(current.modelSettings().toString())
                    "clearChatGptSettings" -> result.success(current.clearChatGptSettings(args.optString("space_id")).toString())
                    "clearModelSettings" -> result.success(current.clearModelSettings(args.getString("space_id")).toString())
                    "saveModelSettings" -> result.success(current.saveModelSettings(args).toString())
                    "run" -> worker.execute {
                        try {
                            val task=current.runModel(args).toString()
                            runOnUiThread { result.success(task) }
                        } catch(error:Throwable) {
                            runOnUiThread { result.error("local_agent_error",error.message,null) }
                        }
                    }
                    "approve" -> result.success(JSONObject().put("accepted",false).toString())
                    "apps" -> worker.execute {
                        try {
                            val rows=JSONArray()
                            packageManager.queryIntentActivities(Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_LAUNCHER),0)
                                .distinctBy {it.activityInfo.packageName}.sortedBy {it.loadLabel(packageManager).toString()}
                                .forEach { rows.put(JSONObject().put("package",it.activityInfo.packageName).put("label",it.loadLabel(packageManager).toString())) }
                            runOnUiThread { result.success(rows.toString()) }
                        } catch(error:Exception) {
                            runOnUiThread { result.error("local_agent_error",error.message,null) }
                        }
                    }
                    "accessibilitySettings" -> {startActivity(Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS));result.success(null)}
                    // Stop bypasses the worker, including a blocked observation.
                    "stop" -> result.success(current.stop(args.getString("id"))?.toString())
                    "start" -> {
                        check(applicationInfo.flags and ApplicationInfo.FLAG_DEBUGGABLE != 0){"debug_command_only"}
                        result.success(current.start(args).toString())
                    }
                    "verify" -> result.success(current.verify(args.getString("id")).toString())
                    "tasks" -> result.success(current.tasks().toString())
                    "observe","execute","finish" -> worker.execute {
                        try {
                            check(applicationInfo.flags and ApplicationInfo.FLAG_DEBUGGABLE != 0){"debug_command_only"}
                            val reply=when(call.method){"observe"->current.observe(args);"execute"->current.execute(args);else->current.finish(args)}
                            runOnUiThread{result.success(reply.toString())}
                        }catch(error:Exception){runOnUiThread{result.error("local_agent_error",error.message,null)}}
                    }
                    else -> result.notImplemented()
                }
            }catch(error:Exception){
                val reason=error.message?.takeIf{it.matches(Regex("[a-z_]{1,80}"))} ?: error.javaClass.simpleName
                android.util.Log.w("NovaLocalAgent","${call.method} failed: $reason")
                result.error("local_agent_error",error.message,null)
            }
        }
    }
}
