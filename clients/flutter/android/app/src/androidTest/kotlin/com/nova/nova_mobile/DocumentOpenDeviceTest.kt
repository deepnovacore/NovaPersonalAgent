package com.nova.nova_mobile

import android.app.Activity
import android.content.ActivityNotFoundException
import android.content.Context
import android.content.Intent
import android.net.Uri
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.runner.AndroidJUnit4
import io.flutter.plugin.common.BinaryMessenger
import io.flutter.plugin.common.MethodCall
import io.flutter.plugin.common.StandardMethodCodec
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import java.nio.ByteBuffer

@RunWith(AndroidJUnit4::class)
class DocumentOpenDeviceTest {
    private class DocumentActivity(context: Context, val viewerAvailable: Boolean) : Activity() {
        val launched = mutableListOf<Intent>()
        init { attachBaseContext(context) }
        override fun startActivity(intent: Intent) {
            if (intent.action == Intent.ACTION_VIEW && !viewerAvailable) throw ActivityNotFoundException()
            launched.add(intent)
        }
    }

    private class Messenger : BinaryMessenger {
        lateinit var handler: BinaryMessenger.BinaryMessageHandler
        override fun send(channel: String, message: ByteBuffer?) {}
        override fun send(channel: String, message: ByteBuffer?, callback: BinaryMessenger.BinaryReply?) {}
        override fun setMessageHandler(channel: String, handler: BinaryMessenger.BinaryMessageHandler?) {
            if (handler != null) this.handler = handler
        }
        fun open() {
            val codec = StandardMethodCodec.INSTANCE
            val message = codec.encodeMethodCall(MethodCall("shareFile", mapOf(
                "name" to "阅读100%.docx", "bytes" to byteArrayOf(80, 75, 3, 4)
            )))
            message.flip()
            var replied = false
            handler.onMessage(message) { reply ->
                reply!!.flip()
                assertNull(codec.decodeEnvelope(reply))
                replied = true
            }
            assertTrue(replied)
        }
    }

    @Test fun docxOpensInViewerWithReadOnlySnapshot() = checkOpen(true)
    @Test fun missingViewerFallsBackToSharing() = checkOpen(false)

    private fun checkOpen(viewerAvailable: Boolean) {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val context = instrumentation.targetContext
        instrumentation.runOnMainSync {
            val activity = DocumentActivity(context, viewerAvailable)
            val messenger = Messenger()
            val host = ArtifactWebHost(activity, messenger)
            try {
                host.resume()
                messenger.open()
                assertEquals(1, activity.launched.size)
                val launched = activity.launched.single()
                val fileIntent = if (viewerAvailable) launched else {
                    @Suppress("DEPRECATION")
                    launched.getParcelableExtra<Intent>(Intent.EXTRA_INTENT)!!
                }
                assertEquals(if (viewerAvailable) Intent.ACTION_VIEW else Intent.ACTION_SEND, fileIntent.action)
                assertEquals("application/vnd.openxmlformats-officedocument.wordprocessingml.document", fileIntent.type)
                assertTrue(fileIntent.flags and Intent.FLAG_GRANT_READ_URI_PERMISSION != 0)
                assertEquals(0, fileIntent.flags and Intent.FLAG_GRANT_WRITE_URI_PERMISSION)
                @Suppress("DEPRECATION")
                val uri = if (viewerAvailable) fileIntent.data!! else fileIntent.getParcelableExtra<Uri>(Intent.EXTRA_STREAM)!!
                assertEquals("content", uri.scheme)
                assertEquals(uri, fileIntent.clipData!!.getItemAt(0).uri)
                assertArrayEquals(byteArrayOf(80, 75, 3, 4), context.contentResolver.openInputStream(uri)!!.use { it.readBytes() })
            } finally { host.dispose() }
        }
    }
}
