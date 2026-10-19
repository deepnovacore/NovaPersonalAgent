package com.nova.nova_mobile

import android.accessibilityservice.AccessibilityService
import android.accessibilityservice.GestureDescription
import android.graphics.Bitmap
import android.graphics.Path
import android.graphics.Rect
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.util.Base64
import android.view.Display
import android.view.Gravity
import android.view.WindowManager
import android.view.accessibility.AccessibilityEvent
import android.view.accessibility.AccessibilityNodeInfo
import android.widget.Button
import org.json.JSONObject
import java.io.ByteArrayOutputStream
import java.security.MessageDigest
import java.util.concurrent.CompletableFuture
import java.util.concurrent.TimeUnit

/** Android owns observation and input; no ADB, host process or Hub is used. */
class LocalGuiService : AccessibilityService() {
    companion object { @Volatile var current: LocalGuiService?=null }
    private val main=Handler(Looper.getMainLooper())
    private var stopButton: Button?=null
    private var nextScreenshotAt=0L
    var onStop: (() -> Unit)?=null
    var onUnavailable: (() -> Unit)?=null
    override fun onServiceConnected(){ current=this }
    override fun onAccessibilityEvent(event: AccessibilityEvent?) {}
    override fun onInterrupt(){onUnavailable?.invoke()}
    override fun onDestroy(){onUnavailable?.invoke();hideStop();current=null;super.onDestroy()}

    private fun <T> onMain(run: () -> T): T {
        check(Looper.myLooper()!=Looper.getMainLooper()) { "blocking_gui_call_on_main" }
        val result=CompletableFuture<T>()
        main.post { try { result.complete(run()) }catch(error:Exception){result.completeExceptionally(error)} }
        return result.get(10,TimeUnit.SECONDS)
    }
    private fun screen():JSONObject {
        val root=rootInActiveWindow?:throw IllegalStateException("screen_unavailable")
        val tree=StringBuilder();var count=0
        fun visit(node: AccessibilityNodeInfo?, depth: Int) {
            if(node==null||depth>15||count++>250||tree.length>12000)return
            val bounds=Rect();node.getBoundsInScreen(bounds)
            val text=if(node.isPassword)"[private input]" else node.text?.toString()?.take(300).orEmpty()
            val description=if(node.isPassword)"" else node.contentDescription?.toString()?.take(200).orEmpty()
            tree.append("${node.className}|${node.viewIdResourceName}|${bounds.toShortString()}|$text|$description\n")
            for(i in 0 until node.childCount)visit(node.getChild(i),depth+1)
        }
        visit(root,0)
        val pkg=root.packageName?.toString().orEmpty()
        val fingerprint=MessageDigest.getInstance("SHA-256").digest((pkg+tree).toByteArray()).joinToString(""){"%02x".format(it)}
        return JSONObject().put("package",pkg).put("tree",tree.toString()).put("fingerprint",fingerprint)
    }
    fun observe(expectedPackage:String?=null): JSONObject {
        check(Looper.myLooper()!=Looper.getMainLooper()) { "blocking_gui_call_on_main" }
        check(Build.VERSION.SDK_INT>=30) { "Android 11 or newer is required for screenshots" }
        // Android rejects back-to-back screenshots (error 3). Space observations
        // on the worker; the main thread and native Stop remain responsive.
        val delay=synchronized(this) {
            val now=SystemClock.elapsedRealtime()
            val scheduled=maxOf(now,nextScreenshotAt)
            nextScreenshotAt=scheduled+500
            scheduled-now
        }
        if(delay>0)Thread.sleep(delay)
        val result=CompletableFuture<JSONObject>()
        main.post {
            try {
                val observed=screen()
                check(expectedPackage==null||observed.getString("package")==expectedPackage){"outside_target_app"}
                takeScreenshot(Display.DEFAULT_DISPLAY,mainExecutor,object:TakeScreenshotCallback {
                    override fun onFailure(errorCode: Int){result.completeExceptionally(IllegalStateException("screenshot_unavailable_$errorCode"))}
                    override fun onSuccess(screenshot: ScreenshotResult){
                        val hardware=screenshot.hardwareBuffer
                        try {
                            if(screen().getString("fingerprint")!=observed.getString("fingerprint")){
                                throw IllegalStateException("screen_changed_during_capture")
                            }
                            val wrapped=Bitmap.wrapHardwareBuffer(hardware,screenshot.colorSpace)?:throw IllegalStateException("screenshot_unavailable")
                            val bitmap=try { wrapped.copy(Bitmap.Config.ARGB_8888,false) } finally { wrapped.recycle() }
                            val width=bitmap.width;val height=bitmap.height
                            val scaled=if(maxOf(width,height)>1280)Bitmap.createScaledBitmap(bitmap,(width*1280.0/maxOf(width,height)).toInt(),(height*1280.0/maxOf(width,height)).toInt(),true)else bitmap
                            val bytes=ByteArrayOutputStream();scaled.compress(Bitmap.CompressFormat.JPEG,75,bytes)
                            if(scaled!==bitmap)scaled.recycle();bitmap.recycle()
                            result.complete(observed.put("width",width).put("height",height).put("image",Base64.encodeToString(bytes.toByteArray(),Base64.NO_WRAP)))
                        }catch(error:Exception){result.completeExceptionally(error)}finally{hardware.close()}
                    }
                })
            }catch(error:Exception){result.completeExceptionally(error)}
        }
        return result.get(10,TimeUnit.SECONDS)
    }
    fun launch(packageName: String) = onMain {
        val intent=packageManager.getLaunchIntentForPackage(packageName)?:throw IllegalArgumentException("app_not_launchable")
        startActivity(intent.addFlags(android.content.Intent.FLAG_ACTIVITY_NEW_TASK));true
    }
    fun perform(action: JSONObject, observation: JSONObject, allowed: () -> Boolean): String {
        val future=CompletableFuture<String>()
        main.post {
            try {
                check(allowed()) { "execution_stopped" }
                if(action.getString("type")!="launch") {
                    check(screen().getString("fingerprint")==observation.getString("fingerprint")){"screen_changed_before_dispatch"}
                }
                when(action.getString("type")){
                    "tap","swipe" -> {
                        fun coordinate(key: String,size: Int):Float { val n=action.getDouble(key);require(n.isFinite()&&n>=0&&n<=1){"invalid_coordinate"};return (n*(size-1)).toFloat() }
                        val width=observation.getInt("width");val height=observation.getInt("height")
                        val path=Path().apply { moveTo(coordinate("x",width),coordinate("y",height));if(action.getString("type")=="swipe")lineTo(coordinate("to_x",width),coordinate("to_y",height)) }
                        val gesture=GestureDescription.Builder().addStroke(GestureDescription.StrokeDescription(path,0,if(action.getString("type")=="tap")80 else 450)).build()
                        val accepted=dispatchGesture(gesture,object:GestureResultCallback(){
                            override fun onCompleted(gestureDescription:GestureDescription?){future.complete("dispatched")}
                            override fun onCancelled(gestureDescription:GestureDescription?){future.complete("unknown")}
                        },main)
                        if(!accepted)future.complete("rejected")
                    }
                    "type" -> {
                        val text=action.getString("text");require(text.length<=4000){"text_too_long"}
                        val node=rootInActiveWindow?.findFocus(AccessibilityNodeInfo.FOCUS_INPUT)?:throw IllegalStateException("no_focused_input")
                        check(!node.isPassword){"private_input_requires_user"}
                        val args=Bundle().apply { putCharSequence(AccessibilityNodeInfo.ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE,text) }
                        future.complete(if(node.performAction(AccessibilityNodeInfo.ACTION_SET_TEXT,args))"dispatched" else "rejected")
                    }
                    "back" -> future.complete(if(performGlobalAction(GLOBAL_ACTION_BACK))"dispatched" else "rejected")
                    "home" -> future.complete(if(performGlobalAction(GLOBAL_ACTION_HOME))"dispatched" else "rejected")
                    "launch" -> {
                        val intent=packageManager.getLaunchIntentForPackage(action.getString("package"))?:throw IllegalArgumentException("app_not_launchable")
                        startActivity(intent.addFlags(android.content.Intent.FLAG_ACTIVITY_NEW_TASK));future.complete("dispatched")
                    }
                    else -> throw IllegalArgumentException("unsupported_action")
                }
            }catch(error:Exception){future.completeExceptionally(error)}
        }
        val outcome=future.get(10,TimeUnit.SECONDS)
        // Dispatch acknowledgement can precede the app transition. Space the
        // next observation from dispatch too, not only from the last capture.
        synchronized(this) { nextScreenshotAt=maxOf(nextScreenshotAt,SystemClock.elapsedRealtime()+500) }
        return outcome
    }
    fun showStop(){
        main.post {
            if(stopButton!=null)return@post
            val button=Button(this).apply { text="停止 Nova";setOnClickListener{onStop?.invoke()} }
            val params=WindowManager.LayoutParams(WindowManager.LayoutParams.WRAP_CONTENT,WindowManager.LayoutParams.WRAP_CONTENT,WindowManager.LayoutParams.TYPE_ACCESSIBILITY_OVERLAY,WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE,android.graphics.PixelFormat.TRANSLUCENT)
            // Keep the user stop control away from app search/back navigation.
            params.gravity=Gravity.CENTER_VERTICAL or Gravity.END
            getSystemService(WindowManager::class.java).addView(button,params);stopButton=button
        }
    }
    fun hideStop(){main.post{stopButton?.let { getSystemService(WindowManager::class.java).removeView(it) };stopButton=null}}
}
