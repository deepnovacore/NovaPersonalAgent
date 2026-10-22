package com.nova.nova_audio

import android.Manifest
import android.app.Activity
import android.app.Application
import android.content.pm.PackageManager
import android.media.audiofx.AcousticEchoCanceler
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import io.flutter.embedding.engine.plugins.FlutterPlugin
import io.flutter.embedding.engine.plugins.activity.ActivityAware
import io.flutter.embedding.engine.plugins.activity.ActivityPluginBinding
import io.flutter.plugin.common.*
import java.nio.ByteBuffer
import java.nio.ByteOrder

class NovaAudioPlugin:FlutterPlugin,MethodChannel.MethodCallHandler,ActivityAware,PluginRegistry.RequestPermissionsResultListener,Application.ActivityLifecycleCallbacks {
 private lateinit var companion:MethodChannel
 private var backgroundCall=false
 private var companionStart:MethodChannel.Result?=null
 private var companionId:String?=null
 private fun stopCompanion(onStopped:(()->Unit)?=null){
  backgroundCall=false
  companionStart?.error("call_stopped","Call stopped before background service was ready",null);companionStart=null
  val id=companionId
  if(!VoiceCallService.ownership.owns(id)){onStopped?.invoke();return}
  VoiceCallService.onReady=null;VoiceCallService.onAction=null
  val completed={
   VoiceCallService.ownership.release(id)
   if(companionId==id)companionId=null
   onStopped?.invoke()
   Unit
  }
  val service=VoiceCallService.current
  if(service!=null)service.finish(completed) else {
   context.stopService(android.content.Intent(context,VoiceCallService::class.java))
   completed()
  }
 }
 private fun companionCall(call:MethodCall,result:MethodChannel.Result){
  try {
   when(call.method){
    "start"->{
     val host=activity ?: error("Application is not active")
     check(host.checkSelfPermission(Manifest.permission.RECORD_AUDIO)==PackageManager.PERMISSION_GRANTED)
     check(!backgroundCall && companionStart==null){"Call already started"}
     val callId=java.util.UUID.randomUUID().toString()
     check(VoiceCallService.ownership.claim(callId)){"Another engine owns the call"}
     companionId=callId;companionStart=result;backgroundCall=true
     VoiceCallService.onReady={companionStart?.success(null);companionStart=null}
     VoiceCallService.onAction={action->
      if(action=="end")fail("Call ended")
      companion.invokeMethod("action",action)
     }
     val intent=android.content.Intent(context,VoiceCallService::class.java).setAction(VoiceCallService.START).putExtra("call_id",callId)
     if(android.os.Build.VERSION.SDK_INT>=26)context.startForegroundService(intent) else context.startService(intent)
     main.postDelayed({if(companionStart===result){stopCompanion();companion.invokeMethod("action","end")}},4500)
    }
    "update"->{check(VoiceCallService.ownership.owns(companionId));VoiceCallService.current?.update(call.argument<Boolean>("muted")==true);result.success(null)}
    "minimize"->{
     check(backgroundCall && VoiceCallService.ownership.owns(companionId)){"No active background call"}
     val host=activity ?: error("Application is not active")
     if(!android.provider.Settings.canDrawOverlays(context)){
      host.startActivity(android.content.Intent(android.provider.Settings.ACTION_MANAGE_OVERLAY_PERMISSION,android.net.Uri.parse("package:${context.packageName}")))
      result.success(false)
     }else{
      val shown=VoiceCallService.current?.showOrb()==true
      if(shown)host.moveTaskToBack(true)
      result.success(shown)
     }
    }
    "stop"->{stopCompanion{result.success(null)}}
    else->result.notImplemented()
   }
  }catch(e:Exception){
   if(call.method=="start"){
    companionStart=null;stopCompanion()
   }
   result.error("call_controls_failed",e.message,null)
  }
 }
 private lateinit var channel:MethodChannel
 private lateinit var pcm:BasicMessageChannel<ByteBuffer>
 private lateinit var audio:RelayAudio
 private lateinit var context:android.content.Context
 private var aoq:AoqAudio?=null
 private val main=Handler(Looper.getMainLooper())
 @Volatile private var generation:Long?=null
 private var activity:Activity?=null
 private var binding:ActivityPluginBinding?=null
 private var permission:MethodChannel.Result?=null
 private var serial=0L
 private var pending:Long?=null
 private var pendingAt=0L
 private val requestCode=19743
 override fun onAttachedToEngine(engine:FlutterPlugin.FlutterPluginBinding){
  channel=MethodChannel(engine.binaryMessenger,"nova/audio");channel.setMethodCallHandler(this)
  companion=MethodChannel(engine.binaryMessenger,"nova/voice_companion");companion.setMethodCallHandler(::companionCall)
  pcm=BasicMessageChannel(engine.binaryMessenger,"nova/audio/pcm",BinaryCodec.INSTANCE)
  context=engine.applicationContext
  audio=RelayAudio(context,::event,::deliver)
 }
 private fun event(kind:String,fields:Map<String,Any>){
  val id=generation ?: return
  val report=Runnable{if(generation==id)channel.invokeMethod("event",fields+mapOf("kind" to kind,"generation" to id))}
  if(Looper.myLooper()==main.looper)report.run() else main.post(report)
 }
 private fun resetHandoff(){serial++;pending=null}
 private fun deliver(data:ByteArray){
  val id=generation ?: return
  main.post {if(generation==id)deliverCurrent(data,id)}
 }
 private fun deliverCurrent(data:ByteArray,id:Long){
  if(pending!=null){if(SystemClock.elapsedRealtime()-pendingAt>=1000)fail("Capture handoff stalled");return}
  val ticket=++serial;pending=ticket;pendingAt=SystemClock.elapsedRealtime()
  val buffer=ByteBuffer.allocateDirect(8+data.size).order(ByteOrder.BIG_ENDIAN)
  buffer.putLong(id);buffer.put(data)
  // Replies run on the platform thread; posting cleanup can let overdue capture checks win.
  pcm.send(buffer){if(generation==id && pending==ticket)pending=null}
  main.postDelayed({if(generation==id && pending==ticket)fail("Capture handoff stalled")},1100)
 }
 private fun fail(reason:String){android.util.Log.w("NovaAudio","Stopped: $reason");aoq?.stop();aoq=null;audio.disconnect();stopCompanion();resetHandoff();event("stopped",mapOf("reason" to reason));generation=null}
 override fun onMethodCall(call:MethodCall,result:MethodChannel.Result){
  try {
   when(call.method){
    "capabilities"->{result.success(mapOf("relay" to true,"aoq" to AoqAudio.available,"aec_available" to AcousticEchoCanceler.isAvailable()));return}
    "requestMicrophone"->{
     val host=activity
     if(host==null){result.success(false);return}
     if(host.checkSelfPermission(Manifest.permission.RECORD_AUDIO)==PackageManager.PERMISSION_GRANTED){result.success(true);return}
     if(permission!=null){result.error("permission_busy","A microphone request is already pending",null);return}
     permission=result;host.requestPermissions(arrayOf(Manifest.permission.RECORD_AUDIO),requestCode);return
    }
    "startAoq"->{
     check(activity!=null && activity!!.checkSelfPermission(Manifest.permission.RECORD_AUDIO)==PackageManager.PERMISSION_GRANTED)
     val id=AudioWire.integer(call.argument<Any>("generation"))
     aoq?.stop();audio.disconnect();resetHandoff();generation=id
     val owner=AoqAudio(context){kind,fields->if(generation==id)event(kind,fields)}
     aoq=owner
     owner.start(call.argument<Map<String,Any>>("payload") ?: error("Missing AOQ payload"),call.argument<Boolean>("runtime")==true)
     result.success(null);return
    }
    "startRelay"->{
     check(activity!=null){"Application is not active"}
     val id=AudioWire.integer(call.argument<Any>("generation"))
     val capture=call.argument<Boolean>("capture") ?: error("Capture flag required")
     val threshold=call.argument<Double>("threshold") ?: error("Threshold required")
     require(threshold.isFinite() && threshold in 0.0..1.0)
     aoq?.stop();aoq=null;audio.disconnect();resetHandoff();generation=id
     audio.start(capture,threshold);result.success(null);return
    }
    "disconnect"->{aoq?.stop();aoq=null;audio.disconnect();resetHandoff();generation=null;result.success(null);return}
   }
   val args=call.arguments as? Map<*,*> ?: emptyMap<Any,Any>()
   if(generation==null || (args["generation"] as? Number)?.toLong()!=generation){result.success(null);return}
   when(call.method){
    "aoqCommand"->aoq?.command(args["event"] as? Map<*,*> ?: error("Missing event"))
    "aoqClear"->aoq?.clear()
    "enqueue"->audio.receive(AudioWire.decode(args["frame"] as? ByteArray ?: error("Audio frame missing")))
    "terminal"->audio.terminal(AudioWire.identity(args))
    "clear"->audio.clear(AudioWire.identity(args))
    "mute"->{val value=args["muted"] as? Boolean ?: error("Mute flag missing");if(aoq!=null)aoq?.mute(value) else audio.mute(value)}
    "speaker"->{val value=args["enabled"] as? Boolean ?: error("Speaker flag missing");if(aoq!=null)aoq?.speaker(value) else audio.speaker(value)}
    "stop"->{aoq?.stop();aoq=null;audio.stop();resetHandoff();generation=null}
    else->{result.notImplemented();return}
   }
   result.success(null)
  }catch(e:Throwable){aoq?.stop();aoq=null;audio.disconnect();resetHandoff();generation=null;result.error("audio_failed",e.message,null)}
 }
 override fun onRequestPermissionsResult(code:Int,permissions:Array<out String>,results:IntArray):Boolean {
  if(code!=requestCode)return false
  permission?.success(results.isNotEmpty() && results[0]==PackageManager.PERMISSION_GRANTED);permission=null;return true
 }
 override fun onAttachedToActivity(value:ActivityPluginBinding){binding=value;activity=value.activity;value.addRequestPermissionsResultListener(this);value.activity.application.registerActivityLifecycleCallbacks(this)}
 override fun onDetachedFromActivityForConfigChanges(){detachActivity()}
 override fun onReattachedToActivityForConfigChanges(value:ActivityPluginBinding){onAttachedToActivity(value)}
 override fun onDetachedFromActivity(){detachActivity()}
 private fun detachActivity(){if(backgroundCall)fail("Activity detached");binding?.removeRequestPermissionsResultListener(this);activity?.application?.unregisterActivityLifecycleCallbacks(this);binding=null;activity=null;permission?.success(false);permission=null;if(audio.running || aoq?.running==true)fail("Activity detached")}
 override fun onDetachedFromEngine(engine:FlutterPlugin.FlutterPluginBinding){stopCompanion();companion.setMethodCallHandler(null);detachActivity();audio.dispose();channel.setMethodCallHandler(null);generation=null;resetHandoff()}
 override fun onActivityStopped(value:Activity){
  if(value!=activity)return
  if(backgroundCall && audio.running)VoiceCallService.current?.showOrb()
  else if(!backgroundCall && (audio.running || aoq?.running==true))fail("Application backgrounded")
 }
 override fun onActivityCreated(a:Activity,state:Bundle?){}
 override fun onActivityStarted(a:Activity){}
 override fun onActivityResumed(a:Activity){if(a==activity && VoiceCallService.ownership.owns(companionId))VoiceCallService.current?.hideOrb()}
 override fun onActivityPaused(a:Activity){}
 override fun onActivitySaveInstanceState(a:Activity,state:Bundle){}
 override fun onActivityDestroyed(a:Activity){}
}
