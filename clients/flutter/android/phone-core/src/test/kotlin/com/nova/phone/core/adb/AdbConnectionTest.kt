// Derived from Mika (https://github.com/wangzan101/Mika, Apache-2.0, commit 5f630d9),
// Copyright 2026 wangzan101. Modified by Nova: package rename only.
package com.nova.phone.core.adb

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.ByteArrayOutputStream
import java.io.DataInputStream
import java.io.IOException
import java.io.OutputStream
import java.net.InetAddress
import java.net.ServerSocket
import java.net.Socket
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.TimeUnit
import kotlin.concurrent.thread

/**
 * 进程内的假 adbd:CNXN → STLS → TLS(要求客户端证书,只认 [authorized] 里的公钥)→ CNXN,
 * 然后提供几个 exec 服务。单线程事件循环,发出的每个 WRTE 都等客户端 OKAY 再发下一个。
 */
class FakeAdbd(
    private val authorized: List<AdbIdentity>,
    private val mode: Mode = Mode.TLS,
    private val maxData: Int = 4096,
) : AutoCloseable {
    enum class Mode { TLS, PLAIN, LEGACY_AUTH }

    private val server = ServerSocket(0, 4, InetAddress.getLoopbackAddress())
    val port: Int get() = server.localPort
    val received = CopyOnWriteArrayList<AdbMessage>()
    @Volatile var error: Throwable? = null
    @Volatile private var current: Socket? = null
    private val sessionsEnded = LinkedBlockingQueue<Unit>()
    private val tls = TestTls.tls(TestTls.device)

    private class Stream(val local: Int, val remote: Int, val service: String) {
        val pending = ArrayDeque<ByteArray>()
        var awaitingAck = false
        var closeWhenDrained = false
    }

    private val worker = thread(isDaemon = true, name = "fake-adbd") {
        try {
            while (!server.isClosed) {
                val s = server.accept()
                current = s
                try { serve(s) } catch (e: IOException) { /* 客户端断开 */ } finally { s.close(); sessionsEnded.put(Unit) }
            }
        } catch (_: IOException) {
        } catch (t: Throwable) {
            error = t
        }
    }

    private fun readMsg(input: DataInputStream) = AdbMessage.read(input, 1 shl 20, verifyChecksum = true)?.also { received += it }

    private fun serve(plain: Socket) {
        var input = DataInputStream(plain.getInputStream())
        var out: OutputStream = plain.getOutputStream()
        val cnxn = readMsg(input) ?: return
        check(cnxn.command == AdbMessage.CNXN && cnxn.arg0 == AdbMessage.VERSION && cnxn.data.toString(Charsets.US_ASCII) == "host::\u0000")
        when (mode) {
            Mode.LEGACY_AUTH -> { out.write(AdbMessage(AdbMessage.AUTH, 1, 0, ByteArray(20)).encode()); out.flush(); input.read(); return }
            Mode.PLAIN -> Unit
            Mode.TLS -> {
                out.write(AdbMessage(AdbMessage.STLS, AdbMessage.STLS_VERSION, 0).encode()); out.flush()
                val stls = readMsg(input) ?: return
                check(stls.command == AdbMessage.STLS && stls.arg0 == AdbMessage.STLS_VERSION)
                val ssl = tls.wrap(plain, "127.0.0.1", port, client = false)
                val key = ssl.session.peerCertificates[0].publicKey.encoded
                if (authorized.none { it.publicKey.encoded.contentEquals(key) }) { ssl.close(); return }
                input = DataInputStream(ssl.inputStream)
                out = ssl.outputStream
            }
        }
        fun send(m: AdbMessage) { out.write(m.encode()); out.flush() }
        send(AdbMessage(AdbMessage.CNXN, AdbMessage.VERSION, maxData, "device::ro.product.name=fake;features=shell_v2\u0000".toByteArray()))

        val streams = HashMap<Int, Stream>()
        var nextId = 100
        fun pump(st: Stream) {
            if (st.awaitingAck) return
            val chunk = st.pending.removeFirstOrNull()
            if (chunk != null) {
                send(AdbMessage(AdbMessage.WRTE, st.local, st.remote, chunk)); st.awaitingAck = true
            } else if (st.closeWhenDrained) {
                send(AdbMessage(AdbMessage.CLSE, st.local, st.remote)); streams.remove(st.local)
            }
        }
        while (true) {
            val m = readMsg(input) ?: return
            check(m.data.size <= maxData) { "client ignored maxdata" }
            when (m.command) {
                AdbMessage.OPEN -> {
                    check(m.arg1 == 0)
                    val dest = m.data.toString(Charsets.UTF_8)
                    check(dest.endsWith("\u0000"))
                    val cmd = dest.removeSuffix("\u0000").removePrefix("exec:")
                    if (!dest.startsWith("exec:") || cmd !in setOf("cat", "big") && !cmd.startsWith("echo ")) {
                        send(AdbMessage(AdbMessage.CLSE, 0, m.arg0)); continue
                    }
                    val st = Stream(nextId++, m.arg0, cmd)
                    streams[st.local] = st
                    send(AdbMessage(AdbMessage.OKAY, st.local, st.remote))
                    when {
                        cmd.startsWith("echo ") -> { st.pending += (cmd.removePrefix("echo ") + "\n").toByteArray(); st.closeWhenDrained = true }
                        cmd == "big" -> { repeat(3) { i -> st.pending += ByteArray(maxData) { (i + 1).toByte() } }; st.closeWhenDrained = true }
                    }
                    pump(st)
                }
                AdbMessage.OKAY -> streams[m.arg1]?.let { it.awaitingAck = false; pump(it) }
                AdbMessage.WRTE -> streams[m.arg1]?.let { st ->
                    send(AdbMessage(AdbMessage.OKAY, st.local, st.remote))
                    if (st.service == "cat") { st.pending += m.data; pump(st) }
                }
                AdbMessage.CLSE -> streams.remove(m.arg1)?.let { send(AdbMessage(AdbMessage.CLSE, it.local, it.remote)) }
            }
        }
    }

    /** 等这个客户端的会话在设备端处理完;客户端断开后再看 [received] 要先调用,否则最后几条消息可能还没记下。 */
    fun awaitSessionEnd() {
        check(sessionsEnded.poll(5, TimeUnit.SECONDS) != null) { "fake adbd session did not end" }
    }

    /** 模拟设备那头断开(关掉无线调试、adbd 重启)。 */
    fun dropClients() {
        current?.close()
    }

    override fun close() {
        server.close()
        dropClients()
        worker.join(5000)
    }
}

class AdbConnectionTest {
    private val tls = TestTls.tls(TestTls.client)

    @Test
    fun execReadsOutputUntilClose() {
        FakeAdbd(listOf(TestTls.client)).use { d ->
            AdbConnection.open("127.0.0.1", d.port, tls).use { c ->
                assertTrue(c.banner.startsWith("device::ro.product.name=fake"))
                assertEquals("hello world\n", c.exec("echo hello world").readText())
                // 同一连接上可以再开流
                assertEquals("again\n", c.exec("echo again").readText())
            }
            d.awaitSessionEnd()
            assertNull(d.error)
            val opens = d.received.filter { it.command == AdbMessage.OPEN }
            assertEquals(listOf("exec:echo hello world\u0000", "exec:echo again\u0000"), opens.map { it.data.toString(Charsets.UTF_8) })
        }
    }

    @Test
    fun largeOutputIsAcknowledgedPerPacket() {
        FakeAdbd(listOf(TestTls.client)).use { d ->
            AdbConnection.open("127.0.0.1", d.port, tls).use { c ->
                val out = c.exec("big").readAll()
                assertEquals(3 * 4096, out.size)
                assertEquals(3.toByte(), out.last())
            }
            d.awaitSessionEnd()
            assertTrue(d.received.count { it.command == AdbMessage.OKAY } >= 3)
        }
    }

    @Test
    fun writeIsChunkedByDeviceMaxDataAndEchoed() {
        FakeAdbd(listOf(TestTls.client), maxData = 1000).use { d ->
            AdbConnection.open("127.0.0.1", d.port, tls).use { c ->
                val s = c.exec("cat")
                val data = ByteArray(2500) { it.toByte() }
                s.write(data)
                val got = ByteArrayOutputStream()
                while (got.size() < data.size) got.write(s.read()!!)
                assertArrayEquals(data, got.toByteArray())
                s.close()
                assertNull(s.read())
            }
            d.awaitSessionEnd()
            assertNull(d.error)
            val wrtes = d.received.filter { it.command == AdbMessage.WRTE }.map { it.data.size }
            assertEquals(listOf(1000, 1000, 500), wrtes)
            assertTrue(d.received.any { it.command == AdbMessage.CLSE })
        }
    }

    @Test
    fun inputStreamView() {
        FakeAdbd(listOf(TestTls.client)).use { d ->
            AdbConnection.open("127.0.0.1", d.port, tls).use { c ->
                assertEquals("abc\n", c.exec("echo abc").inputStream.bufferedReader().readText())
            }
        }
    }

    @Test
    fun refusedServiceThrows() {
        FakeAdbd(listOf(TestTls.client)).use { d ->
            AdbConnection.open("127.0.0.1", d.port, tls).use { c ->
                assertThrows(IOException::class.java) { c.open("shell:nope") }
                assertEquals("ok\n", c.exec("echo ok").readText())
            }
        }
    }

    @Test
    fun unpairedKeyIsUnauthorized() {
        FakeAdbd(emptyList()).use { d ->
            val e = assertThrows(AdbConnectionException::class.java) { AdbConnection.open("127.0.0.1", d.port, tls) }
            assertEquals(AdbConnectionException.Reason.UNAUTHORIZED, e.reason)
        }
    }

    @Test
    fun legacyAuthPortIsUnauthorized() {
        FakeAdbd(listOf(TestTls.client), FakeAdbd.Mode.LEGACY_AUTH).use { d ->
            val e = assertThrows(AdbConnectionException::class.java) { AdbConnection.open("127.0.0.1", d.port, tls) }
            assertEquals(AdbConnectionException.Reason.UNAUTHORIZED, e.reason)
        }
    }

    @Test
    fun deviceWithoutAuthSkipsTls() {
        FakeAdbd(emptyList(), FakeAdbd.Mode.PLAIN).use { d ->
            AdbConnection.open("127.0.0.1", d.port, tls).use { c -> assertEquals("p\n", c.exec("echo p").readText()) }
        }
    }

    @Test
    fun connectFailure() {
        val port = ServerSocket(0).use { it.localPort }
        val e = assertThrows(AdbConnectionException::class.java) { AdbConnection.open("127.0.0.1", port, tls, 2000) }
        assertEquals(AdbConnectionException.Reason.CONNECT_FAILED, e.reason)
    }

    @Test
    fun connectionLossEndsStreams() {
        FakeAdbd(listOf(TestTls.client)).use { d ->
            val c = AdbConnection.open("127.0.0.1", d.port, tls)
            val s = c.exec("cat")
            d.dropClients()
            assertNull(s.read())
            assertThrows(IOException::class.java) { s.write(byteArrayOf(1)) }
            assertThrows(IOException::class.java) { c.exec("echo x") }
            assertTrue(c.isClosed)
        }
    }
}

class AdbMessageTest {
    @Test
    fun encodesHeaderLittleEndianWithChecksumAndMagic() {
        val m = AdbMessage(AdbMessage.OPEN, 1, 0, "exec:id\u0000".toByteArray())
        val b = m.encode()
        assertEquals(24 + 8, b.size)
        assertArrayEquals("OPEN".toByteArray(), b.copyOf(4))
        assertArrayEquals(byteArrayOf(1, 0, 0, 0), b.copyOfRange(4, 8))
        assertArrayEquals(byteArrayOf(8, 0, 0, 0), b.copyOfRange(12, 16))
        val sum = "exec:id".sumOf { it.code }
        assertEquals(sum, (b[16].toInt() and 0xff) or ((b[17].toInt() and 0xff) shl 8))
        assertArrayEquals(byteArrayOf(0xb0.toByte(), 0xaf.toByte(), 0xba.toByte(), 0xb1.toByte()), b.copyOfRange(20, 24))
        val back = AdbMessage.read(DataInputStream(b.inputStream()), verifyChecksum = true)!!
        assertEquals(AdbMessage.OPEN, back.command)
        assertArrayEquals(m.data, back.data)
        assertEquals("OPEN", AdbMessage.name(AdbMessage.OPEN))
        assertEquals("STLS", AdbMessage.name(AdbMessage.STLS))
        assertEquals("CNXN", AdbMessage.name(AdbMessage.CNXN))
    }

    @Test
    fun rejectsCorruptPackets() {
        val b = AdbMessage(AdbMessage.WRTE, 1, 2, byteArrayOf(1, 2, 3)).encode()
        val badMagic = b.copyOf().also { it[20] = 0 }
        assertThrows(IOException::class.java) { AdbMessage.read(DataInputStream(badMagic.inputStream())) }
        val badSum = b.copyOf().also { it[24] = 9 }
        assertThrows(IOException::class.java) { AdbMessage.read(DataInputStream(badSum.inputStream()), verifyChecksum = true) }
        AdbMessage.read(DataInputStream(badSum.inputStream()), verifyChecksum = false)!!
        val tooBig = AdbMessage(AdbMessage.WRTE, 1, 2, ByteArray(10)).encode()
        assertThrows(IOException::class.java) { AdbMessage.read(DataInputStream(tooBig.inputStream()), maxData = 5) }
        assertNull(AdbMessage.read(DataInputStream(ByteArray(0).inputStream())))
    }
}
