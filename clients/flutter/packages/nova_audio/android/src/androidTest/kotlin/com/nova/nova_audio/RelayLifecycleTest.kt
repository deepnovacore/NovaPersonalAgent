package com.nova.nova_audio
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
@RunWith(AndroidJUnit4::class)
class RelayLifecycleTest {
 @Test fun queuedPlaybackSurvivesBriefUiWork() {
  val instrumentation=InstrumentationRegistry.getInstrumentation()
  val done=java.util.concurrent.CountDownLatch(1)
  val audio=RelayAudio(instrumentation.targetContext,{kind,fields ->
   if(kind=="control" && (fields["control"] as? Map<*,*>)?.get("type")=="playback.done")done.countDown()
  },{})
  var underruns=0
  var beforeUiWork=0
  try {
   instrumentation.runOnMainSync {
    audio.start(false,0.045)
    val id=PlaybackIdentity("ui-contention",1)
    repeat(3){audio.receive(AudioFrame(id,it.toLong(),ByteArray(48000)))}
    audio.terminal(id)
   }
   // Real UI/semantics work must not stop an already queued audio stream.
   Thread.sleep(300)
   instrumentation.runOnMainSync {
    val track=RelayAudio::class.java.getDeclaredField("player").apply{isAccessible=true}.get(audio) as android.media.AudioTrack
    beforeUiWork=track.underrunCount
    Thread.sleep(350)
   }
   instrumentation.runOnMainSync {
    val track=RelayAudio::class.java.getDeclaredField("player").apply{isAccessible=true}.get(audio) as android.media.AudioTrack
    underruns=track.underrunCount
   }
   assertEquals("UI work must not starve native playback",beforeUiWork,underruns)
   assertTrue("Queued three seconds must finish",done.await(6,java.util.concurrent.TimeUnit.SECONDS))
  } finally {instrumentation.runOnMainSync{audio.dispose()}}
 }

 @Test fun unusedHeadlessAudioCannotResetCommunicationRouting() {
  val instrumentation=InstrumentationRegistry.getInstrumentation()
  instrumentation.runOnMainSync {
   val manager=instrumentation.targetContext.getSystemService(android.media.AudioManager::class.java)
   val previous=manager.mode
   try {
    manager.mode=android.media.AudioManager.MODE_IN_COMMUNICATION
    val unrelated=RelayAudio(instrumentation.targetContext,{_,_->},{})
    unrelated.dispose()
    assertEquals(android.media.AudioManager.MODE_IN_COMMUNICATION,manager.mode)
   } finally {manager.mode=previous}
  }
 }

 @Test fun playbackOnlyCanStopAndRestartWithoutMicrophone() {
  val instrumentation=InstrumentationRegistry.getInstrumentation()
  instrumentation.runOnMainSync {
   val audio=RelayAudio(instrumentation.targetContext,{_,_->},{})
   try {
    repeat(3){audio.start(false,0.045);assertTrue(audio.running);audio.stop();assertFalse(audio.running)}
   } finally { audio.dispose() }
  }
 }
 @Test fun oversizedAoqCallbackDoesNotMakeBacklogNegative() {
  val instrumentation=InstrumentationRegistry.getInstrumentation()
  instrumentation.runOnMainSync {
   val audio=AoqAudio(instrumentation.targetContext){_,_->}
   val method=audio.javaClass.methods.firstOrNull { it.name=="onDataMsg" } ?: return@runOnMainSync
   val message=method.parameterTypes.single().getDeclaredConstructor().newInstance()
   message.javaClass.getField("data").set(message,ByteArray(65537))
   val counter=audio.javaClass.getDeclaredField("callbackBytes").apply { isAccessible=true }.get(audio) as java.util.concurrent.atomic.AtomicInteger
   repeat(3) { method.invoke(audio,message);assertEquals(0,counter.get()) }
  }
 }
}
