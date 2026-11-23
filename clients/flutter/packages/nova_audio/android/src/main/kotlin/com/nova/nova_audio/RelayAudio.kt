package com.nova.nova_audio

import android.content.Context
import android.media.*
import android.media.audiofx.AcousticEchoCanceler
import android.os.Build
import android.os.Handler
import android.os.HandlerThread
import java.util.concurrent.FutureTask
import java.util.concurrent.TimeUnit
import java.util.concurrent.ExecutionException
import android.os.Looper
import android.os.SystemClock
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.util.ArrayDeque
import java.util.concurrent.atomic.AtomicBoolean
import kotlin.math.sqrt

/** Playback and control state belong to one audio handler, independent of UI work. */
@Suppress("DEPRECATION")
class RelayAudio(private val context:Context, private val emit:(String,Map<String,Any>)->Unit, private val onPCM:(ByteArray)->Unit) {
 private val worker=HandlerThread("nova-audio",android.os.Process.THREAD_PRIORITY_AUDIO).apply{start()}
 private val audioHandler=Handler(worker.looper)
 private fun onAudio(run:()->Unit) {
  if(Looper.myLooper()==audioHandler.looper){run();return}
  val task=FutureTask{run()}
  check(audioHandler.post(task)){"Audio thread closed"}
  try {task.get(5,TimeUnit.SECONDS)}
  catch(error:ExecutionException){throw error.cause ?: error}
  catch(error:Exception){task.cancel(false);throw error}
 }
 fun dispose(){try{disconnect()}finally{worker.quitSafely()}}
 private val manager=context.getSystemService(Context.AUDIO_SERVICE) as AudioManager
 private val live=AtomicBoolean(false)
 private var recorder:AudioRecord?=null
 private var player:AudioTrack?=null
 private var reader:Thread?=null
 private var aec:AcousticEchoCanceler?=null
 private var ledger=PlaybackLedger()
 private data class Chunk(val bytes:ByteArray,var offset:Int=0)
 private val queue=ArrayDeque<Chunk>()
 private var started=false
 private var capture=false
 private var recordingCompatible=false
 @Volatile private var muted=false
 @Volatile private var captureEpoch=0L
 private var threshold=0.045
 private var attack=0.0; private var silence=0.0; private var speaking=false
 private var timestamp=AudioTimestamp()
 private var routeReady=false
 private var ownsRouting=false
 private var focus:AudioFocusRequest?=null
 private var terminalAt:Long?=null
 private val posted=AtomicBoolean(false)
 private var postedAt=0L
 // Other apps (e.g. a video the phone agent opens) take transient focus; only
 // permanent loss, a phone call or a long hold ends the voice session. While
 // held, capture is silenced and playback paused, so Nova neither hears the
 // other app nor talks over it (VoIP calls also use IN_COMMUNICATION).
 @Volatile private var focusHeld=true
 private var holdAt=0L
 private var focusSession=0L
 private var focusListener:AudioManager.OnAudioFocusChangeListener?=null
 private fun onFocus(value:Int){if(live.get())when(focusDecision(value,manager.mode)){
  FocusDecision.END->fail("Audio focus interrupted")
  FocusDecision.HOLD->if(focusHeld){
   focusHeld=false;holdAt=SystemClock.elapsedRealtime()
   attack=0.0;silence=0.0;speaking=false;emit("level",mapOf("level" to 0.0))
   player?.pause();audioHandler.postDelayed(callWatch,500)
   // Tell Dart: a Space call must not hold and resume silently.
   focusControl(FocusDecision.HOLD)?.let{control(it)}
   android.util.Log.i("NovaAudio","Focus: transient_loss")
  }
  FocusDecision.RESUME->if(!focusHeld){
   focusHeld=true;audioHandler.removeCallbacks(callWatch)
   // The pause is not presentation time; keep the 65 s verification honest.
   terminalAt=terminalAt?.plus(SystemClock.elapsedRealtime()-holdAt)
   if(ledger.current!=null)player?.play()
   focusControl(FocusDecision.RESUME)?.let{control(it)}
   android.util.Log.i("NovaAudio","Focus: regained")
  }
 }}
 private val callWatch=object:Runnable{
  override fun run(){if(!live.get()||focusHeld)return
   if(callMode(manager.mode)){fail("Audio focus interrupted");return}
   if(SystemClock.elapsedRealtime()-holdAt>FOCUS_HOLD_LIMIT_MS){fail("Audio focus not regained");return}
   audioHandler.postDelayed(this,500)
  }
 }
 private val routes=object:AudioDeviceCallback(){
  override fun onAudioDevicesAdded(added:Array<out AudioDeviceInfo>){if(routeReady && live.get())fail("Audio route changed")}
  override fun onAudioDevicesRemoved(removed:Array<out AudioDeviceInfo>){if(routeReady && live.get())fail("Audio route changed")}
 }
 val running get()=live.get()
 fun start(capture:Boolean,threshold:Double,recordingCompatible:Boolean=false)=onAudio {
  stop();this.capture=capture;this.threshold=threshold;this.recordingCompatible=capture && recordingCompatible
  try {
   ownsRouting=true
   manager.mode=if(capture && !this.recordingCompatible)AudioManager.MODE_IN_COMMUNICATION else AudioManager.MODE_NORMAL
   // Communication usage is excluded from Android playback capture, even when capture is allowed.
   val attrs=AudioAttributes.Builder().setUsage(if(capture && !this.recordingCompatible)AudioAttributes.USAGE_VOICE_COMMUNICATION else AudioAttributes.USAGE_MEDIA).setContentType(AudioAttributes.CONTENT_TYPE_SPEECH).apply{
    if(Build.VERSION.SDK_INT>=29 && this@RelayAudio.recordingCompatible)setAllowedCapturePolicy(AudioAttributes.ALLOW_CAPTURE_BY_ALL)
   }.build()
   val min=AudioTrack.getMinBufferSize(24000,AudioFormat.CHANNEL_OUT_MONO,AudioFormat.ENCODING_PCM_16BIT)
   require(min>0){"24 kHz playback unsupported"}
   player=AudioTrack.Builder().setAudioAttributes(attrs).setAudioFormat(AudioFormat.Builder().setSampleRate(24000).setChannelMask(AudioFormat.CHANNEL_OUT_MONO).setEncoding(AudioFormat.ENCODING_PCM_16BIT).build()).setBufferSizeInBytes(maxOf(min,4800)).setTransferMode(AudioTrack.MODE_STREAM).build()
   check(player!!.state==AudioTrack.STATE_INITIALIZED){"Playback initialization failed"}
   val session=++focusSession
   // API < 26 gives no handler guarantee; a stale session's callbacks are dropped.
   val listener=AudioManager.OnAudioFocusChangeListener{value -> audioHandler.post{if(session==focusSession)onFocus(value)}}
   focusListener=listener
   if(this.recordingCompatible){
    val speaker=manager.getDevices(AudioManager.GET_DEVICES_OUTPUTS).firstOrNull{it.type==AudioDeviceInfo.TYPE_BUILTIN_SPEAKER} ?: error("Speaker unavailable")
    check(player!!.setPreferredDevice(speaker)){"Speaker unavailable"}
   }
   val granted=if(Build.VERSION.SDK_INT>=26){
    focus=AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN_TRANSIENT).setAudioAttributes(attrs).setOnAudioFocusChangeListener(listener,audioHandler).build()
    manager.requestAudioFocus(focus!!)
   }else{manager.requestAudioFocus(listener,if(this.recordingCompatible)AudioManager.STREAM_MUSIC else AudioManager.STREAM_VOICE_CALL,AudioManager.AUDIOFOCUS_GAIN_TRANSIENT)}
   check(granted==AudioManager.AUDIOFOCUS_REQUEST_GRANTED){"Audio focus unavailable"}
   if(capture){
    val minimum=AudioRecord.getMinBufferSize(16000,AudioFormat.CHANNEL_IN_MONO,AudioFormat.ENCODING_PCM_16BIT)
    require(minimum>0){"16 kHz microphone capture unsupported"}
    recorder=AudioRecord.Builder().setAudioSource(MediaRecorder.AudioSource.VOICE_COMMUNICATION).setAudioFormat(AudioFormat.Builder().setSampleRate(16000).setChannelMask(AudioFormat.CHANNEL_IN_MONO).setEncoding(AudioFormat.ENCODING_PCM_16BIT).build()).setBufferSizeInBytes(maxOf(minimum,6400)).apply{
     // Keep voice processing/AEC while permitting supported system recorders to share input.
     if(Build.VERSION.SDK_INT>=30 && this@RelayAudio.recordingCompatible)setPrivacySensitive(false)
    }.build()
    check(recorder!!.state==AudioRecord.STATE_INITIALIZED){"Capture initialization failed"}
    aec=AcousticEchoCanceler.create(recorder!!.audioSessionId)
    if(aec?.hasControl()==true)aec?.enabled=true
    emit("aec",mapOf("available" to AcousticEchoCanceler.isAvailable(),"enabled" to (aec?.enabled==true),"has_control" to (aec?.hasControl()==true)))
   }
   live.set(true);muted=false;captureEpoch++;val epoch=captureEpoch
   manager.registerAudioDeviceCallback(routes,audioHandler)
   audioHandler.postDelayed({if(captureEpoch==epoch && live.get())routeReady=true},300)
   recorder?.startRecording()
   if(capture){reader=Thread({readCapture(epoch)},"nova-capture").also{it.start()}}
   audioHandler.post(tick)
  }catch(e:Exception){stop();throw e}
 }
 private fun readCapture(epoch:Long){
  val input=recorder ?: return
  while(live.get() && captureEpoch==epoch){
   val buffer=ByteArray(640)
   val size=try{input.read(buffer,0,buffer.size,AudioRecord.READ_BLOCKING)}catch(_:Exception){-1}
   if(!live.get() || captureEpoch!=epoch)return
   if(size<=0){audioHandler.post{if(live.get() && captureEpoch==epoch)fail("Microphone read failed")};return}
   val now=SystemClock.elapsedRealtime()
   if(!posted.compareAndSet(false,true)){
    if(now-postedAt>1000){audioHandler.post{if(captureEpoch==epoch)fail("Capture handoff stalled")};return}
    continue
   }
   postedAt=now
   val read=if(muted)ByteArray(size)else buffer.copyOf(size)
   audioHandler.post{
    try{
     if(!live.get() || captureEpoch!=epoch)return@post
     // Re-check here: focus may have been lost after this frame was read.
     val silent=muted||!focusHeld
     val data=if(silent)ByteArray(read.size)else read
     if(!silent){
      val values=ByteBuffer.wrap(data).order(ByteOrder.LITTLE_ENDIAN).asShortBuffer();var sum=0.0
      while(values.hasRemaining()){val n=values.get()/32768.0;sum+=n*n}
      val rms=sqrt(sum/(data.size/2));val duration=data.size/32.0
      if(rms>=threshold){silence=0.0;if(!speaking){attack+=duration;if(attack>=50){speaking=true;attack=0.0;clearCurrent("playback.stopped");control(mapOf("type" to "speech.onset","speech_id" to java.util.UUID.randomUUID().toString(),"t_render_ms" to renderMS()))}}}
      else{attack=0.0;silence+=duration;if(silence>=180)speaking=false}
      emit("level",mapOf("level" to minOf(1.0,rms*8)))
     }
     onPCM(data)
    }finally{if(captureEpoch==epoch)posted.set(false)}
   }
  }
 }
 private val tick=object:Runnable{
  override fun run(){if(!live.get())return
   if(!focusHeld){audioHandler.postDelayed(this,20);return}
   try{
    val track=player ?: return
    var writes=0
    while(queue.isNotEmpty() && writes++<4){
     val chunk=queue.first
     val count=track.write(chunk.bytes,chunk.offset,chunk.bytes.size-chunk.offset,AudioTrack.WRITE_NON_BLOCKING)
     if(count<0){fail("Playback write failed");return}
     if(count==0)break
     chunk.offset+=count;if(chunk.offset==chunk.bytes.size)queue.removeFirst()
    }
    updateRendered()
    // Missing native timestamps must not be replaced with queued-time guesses.
    if(terminalAt!=null && queue.isEmpty() && SystemClock.elapsedRealtime()-terminalAt!!>65000 && !ledger.finished){fail("Playback presentation could not be verified");return}
   }catch(_:Exception){fail("Playback failed");return}
   audioHandler.postDelayed(this,20)
  }
 }
 fun receive(frame:AudioFrame)=onAudio {
  updateRendered()
  if(!live.get()){if(ledger.accept(frame))clearCurrent("playback.stopped");return@onAudio}
  if(!ledger.accept(frame)){if(ledger.current==frame.identity)clearCurrent("playback.stopped");return@onAudio}
  queue.add(Chunk(frame.pcm));if(focusHeld)player?.play()
 }
 fun terminal(identity:PlaybackIdentity)=onAudio {ledger.terminal(identity);terminalAt=SystemClock.elapsedRealtime();updateRendered()}
 private var lastProgressMS = 0L
 private fun updateRendered(){
  val id=ledger.current ?: return;val track=player ?: return
  if(track.getTimestamp(timestamp) && timestamp.nanoTime<=System.nanoTime())ledger.rendered(timestamp.framePosition,ledger.ticket)
  if(!started && ledger.renderedSamples>0){started=true;report("playback.started",id)}
  if(ledger.playedMS-lastProgressMS>=100){lastProgressMS=ledger.playedMS;report("playback.progress",id,ledger.playedMS)}
  if(ledger.finished && queue.isEmpty()){report("playback.done",id,ledger.playedMS);ledger.clear(id);resetPlayer()}
 }
 fun clear(identity:PlaybackIdentity)=onAudio {
  if(ledger.current!=null && ledger.current!=identity)return@onAudio
  if(ledger.current!=null)clearCurrent("playback.cleared") else {ledger.clear(identity);report("playback.cleared",identity,0)}
 }
 private fun clearCurrent(type:String){updateRendered();val id=ledger.current ?: return;val played=ledger.playedMS;ledger.clear(id);resetPlayer();report(type,id,played)}
 private fun resetPlayer(){player?.pause();player?.flush();queue.clear();started=false;lastProgressMS=0L;terminalAt=null;timestamp=AudioTimestamp()}
 private fun report(type:String,id:PlaybackIdentity,played:Long?=null){val event=mutableMapOf<String,Any>("type" to type,"utterance_id" to id.utteranceId,"generation_epoch" to id.epoch,"t_render_ms" to renderMS());if(played!=null)event["played_ms"]=played;control(event)}
 private fun control(value:Map<String,Any>)=emit("control",mapOf("control" to value))
 private fun renderMS()=SystemClock.elapsedRealtimeNanos()/1e6
 fun mute(value:Boolean)=onAudio {muted=value;attack=0.0;silence=0.0;speaking=false;emit("level",mapOf("level" to 0.0))}
 fun speaker(enabled:Boolean)=onAudio {
  if(recordingCompatible){check(enabled){"Recording compatibility requires speakerphone"};return@onAudio}
  if(Build.VERSION.SDK_INT>=31){
   val type=if(enabled)AudioDeviceInfo.TYPE_BUILTIN_SPEAKER else AudioDeviceInfo.TYPE_BUILTIN_EARPIECE
   val device=manager.availableCommunicationDevices.firstOrNull{it.type==type}
   if(device!=null)check(manager.setCommunicationDevice(device)){"Audio route unavailable"}else if(!enabled)manager.clearCommunicationDevice()else error("Speaker unavailable")
  }else{manager.isSpeakerphoneOn=enabled}
 }
 fun stop()=onAudio {
  live.set(false);captureEpoch++;routeReady=false;audioHandler.removeCallbacks(tick);audioHandler.removeCallbacks(callWatch);focusHeld=true;focusSession++
  try{recorder?.stop()}catch(_:Exception){}
  reader?.join(200);reader=null;recorder?.release();recorder=null;aec?.release();aec=null
  try{clearCurrent("playback.stopped");player?.stop()}catch(_:Exception){}
  player?.release();player=null;queue.clear();posted.set(false)
  if(ownsRouting){
   ownsRouting=false
   manager.unregisterAudioDeviceCallback(routes)
   if(Build.VERSION.SDK_INT>=26){focus?.let{manager.abandonAudioFocusRequest(it)};focus=null}else{focusListener?.let{manager.abandonAudioFocus(it)}}
   focusListener=null
   if(Build.VERSION.SDK_INT>=31)manager.clearCommunicationDevice()
   manager.mode=AudioManager.MODE_NORMAL
  }
  muted=false
 }
 fun disconnect()=onAudio {stop();ledger.disconnect()}
 private fun fail(reason:String){if(!live.get())return;android.util.Log.w("NovaAudio","Stopped: $reason");disconnect();emit("stopped",mapOf("reason" to reason))}
}

internal const val FOCUS_HOLD_LIMIT_MS=120_000L

internal enum class FocusDecision { END, HOLD, RESUME }

internal fun callMode(mode:Int)=mode==AudioManager.MODE_RINGTONE||mode==AudioManager.MODE_IN_CALL||mode==AudioManager.MODE_CALL_SCREENING

/** Control event for a held or regained focus; END already emits `stopped`. */
internal fun focusControl(decision:FocusDecision):Map<String,Any>?=when(decision){
 FocusDecision.HOLD->mapOf("type" to "audio.focus","state" to "hold")
 FocusDecision.RESUME->mapOf("type" to "audio.focus","state" to "resumed")
 FocusDecision.END->null
}

internal fun focusDecision(change:Int,mode:Int)=when{
 change>0->FocusDecision.RESUME
 change==AudioManager.AUDIOFOCUS_LOSS_TRANSIENT||change==AudioManager.AUDIOFOCUS_LOSS_TRANSIENT_CAN_DUCK->if(callMode(mode))FocusDecision.END else FocusDecision.HOLD
 else->FocusDecision.END
}
