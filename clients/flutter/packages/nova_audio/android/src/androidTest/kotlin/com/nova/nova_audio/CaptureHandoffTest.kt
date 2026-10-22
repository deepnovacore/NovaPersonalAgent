package com.nova.nova_audio

import androidx.test.platform.app.InstrumentationRegistry
import io.flutter.plugin.common.BasicMessageChannel
import io.flutter.plugin.common.BinaryCodec
import io.flutter.plugin.common.BinaryMessenger
import java.nio.ByteBuffer
import org.junit.Assert.*
import org.junit.Test

class CaptureHandoffTest {
 @Test fun acknowledgedFrameCannotRemainPendingBehindUiWork() {
  InstrumentationRegistry.getInstrumentation().runOnMainSync {
   val plugin=NovaAudioPlugin()
   val replies=mutableListOf<BinaryMessenger.BinaryReply>()
   val messenger=object:BinaryMessenger {
    override fun send(channel:String,message:ByteBuffer?) {}
    override fun send(channel:String,message:ByteBuffer?,callback:BinaryMessenger.BinaryReply?) {replies.add(callback!!)}
    override fun setMessageHandler(channel:String,handler:BinaryMessenger.BinaryMessageHandler?) {}
   }
   fun field(name:String)=plugin.javaClass.getDeclaredField(name).apply{isAccessible=true}
   field("pcm").set(plugin,BasicMessageChannel(messenger,"nova/audio/pcm",BinaryCodec.INSTANCE))
   field("generation").set(plugin,1L)
   val deliver=plugin.javaClass.getDeclaredMethod("deliverCurrent",ByteArray::class.java,java.lang.Long.TYPE).apply{isAccessible=true}
   try {
    deliver.invoke(plugin,ByteArray(640),1L)
    assertNotNull(field("pending").get(plugin))
    replies[0].reply(null)
    // An overdue capture runnable can execute next, before any newly posted cleanup.
    assertNull("ACK must retire the ticket before yielding the main thread",field("pending").get(plugin))
    field("generation").set(plugin,2L)
    deliver.invoke(plugin,ByteArray(640),2L)
    val current=field("pending").get(plugin)
    replies[0].reply(null)
    assertEquals("Old ACK must not retire a new session",current,field("pending").get(plugin))
    replies[1].reply(null)
    assertNull(field("pending").get(plugin))
   } finally {field("generation").set(plugin,null);field("pending").set(plugin,null)}
  }
 }
}
