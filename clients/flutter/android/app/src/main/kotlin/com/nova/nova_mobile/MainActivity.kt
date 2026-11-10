package com.nova.nova_mobile

import io.flutter.embedding.android.FlutterActivity
import io.flutter.embedding.engine.FlutterEngine
import android.content.Context
import android.content.Intent
import android.content.pm.ApplicationInfo
import com.nova.nova_mobile.phone.PhoneBridge

class MainActivity : FlutterActivity() {
    private val runtime get() = (application as NovaPushApplication).runtime
    private var spacePush: NovaSpacePush? = null
    private var spaceTools: NovaSpaceTools? = null
    private var artifactHost: ArtifactWebHost? = null
    override fun provideFlutterEngine(context: Context): FlutterEngine = runtime.engine
    override fun shouldDestroyEngineWithHost() = false
    override fun onResume() {
        super.onResume()
        artifactHost?.resume()
    }
    override fun onPause() {
        artifactHost?.pause()
        super.onPause()
    }
    override fun onDestroy() {
        spacePush?.detach(this)
        spaceTools?.close()
        artifactHost?.dispose()
        artifactHost = null
        super.onDestroy()
        android.util.Log.i("NovaRuntime", "Activity detached; engine retained")
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
    override fun configureFlutterEngine(flutterEngine: FlutterEngine) {
        super.configureFlutterEngine(flutterEngine)
        PhoneBridge.register(this, flutterEngine)
        NovaScheduleBridge.install(this, flutterEngine)
        spacePush = runtime.attachPush(this)
        spaceTools = NovaSpaceTools(this, flutterEngine.dartExecutor.binaryMessenger)
        artifactHost = ArtifactWebHost(this, flutterEngine.dartExecutor.binaryMessenger)
        android.util.Log.i("NovaRuntime", "Activity attached to retained engine")
    }
}
