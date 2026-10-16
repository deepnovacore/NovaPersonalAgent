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

class MainActivity : FlutterActivity() {
    override fun onCreate(savedInstanceState:android.os.Bundle?) {
        super.onCreate(savedInstanceState)
        // The isolated acceptance package stays visible while waiting for consent.
        // Production app and device-wide screen timeout are unaffected.
        if(packageName.endsWith(".autonomy") && applicationInfo.flags and ApplicationInfo.FLAG_DEBUGGABLE != 0) {
            window.addFlags(android.view.WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        }
    }
    companion object {
        private var controller:LocalAgentController?=null
        private val worker=Executors.newSingleThreadExecutor()
    }
    override fun configureFlutterEngine(flutterEngine:FlutterEngine){
        super.configureFlutterEngine(flutterEngine)
        if(controller==null)controller=LocalAgentController(applicationContext)
        MethodChannel(flutterEngine.dartExecutor.binaryMessenger,"nova/local_agent/v1").setMethodCallHandler { call,result ->
            try {
                val args=JSONObject(call.arguments as? String?:"{}")
                when(call.method){
                    "capabilities" -> result.success(JSONObject().put("schema_version",1).put("platform","android").put("host_package",packageName).put("android_api",Build.VERSION.SDK_INT).put("accessibility",LocalGuiService.current!=null).put("screenshots",Build.VERSION.SDK_INT>=30).put("model_runtime",true).put("model_configured",controller!!.modelSettings().getBoolean("configured")).toString())
                    "modelSettings" -> result.success(controller!!.modelSettings().toString())
                    "saveModelSettings" -> result.success(controller!!.saveModelSettings(args).toString())
                    "run" -> result.success(controller!!.runModel(args).toString())
                    "approve" -> result.success(JSONObject().put("accepted",controller!!.approve(args.getString("id"),args.getString("proposal_id"),args.getBoolean("allow"))).toString())
                    "apps" -> {
                        val rows=JSONArray()
                        packageManager.queryIntentActivities(Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_LAUNCHER),0)
                            .distinctBy {it.activityInfo.packageName}.sortedBy {it.loadLabel(packageManager).toString()}
                            .forEach { rows.put(JSONObject().put("package",it.activityInfo.packageName).put("label",it.loadLabel(packageManager).toString())) }
                        result.success(rows.toString())
                    }
                    "accessibilitySettings" -> {startActivity(Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS));result.success(null)}
                    // Stop bypasses the worker, including a blocked observation.
                    "stop" -> result.success(controller!!.stop(args.getString("id"))?.toString())
                    "start" -> {
                        check(applicationInfo.flags and ApplicationInfo.FLAG_DEBUGGABLE != 0){"debug_command_only"}
                        result.success(controller!!.start(args).toString())
                    }
                    "verify" -> result.success(controller!!.verify(args.getString("id")).toString())
                    "tasks" -> result.success(controller!!.tasks().toString())
                    "observe","execute","finish" -> worker.execute {
                        try {
                            check(applicationInfo.flags and ApplicationInfo.FLAG_DEBUGGABLE != 0){"debug_command_only"}
                            val reply=when(call.method){"observe"->controller!!.observe(args);"execute"->controller!!.execute(args);else->controller!!.finish(args)}
                            runOnUiThread{result.success(reply.toString())}
                        }catch(error:Exception){runOnUiThread{result.error("local_agent_error",error.message,null)}}
                    }
                    else -> result.notImplemented()
                }
            }catch(error:Exception){result.error("local_agent_error",error.message,null)}
        }
    }
}
