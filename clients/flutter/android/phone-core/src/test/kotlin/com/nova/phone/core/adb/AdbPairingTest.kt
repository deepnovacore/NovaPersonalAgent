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
import java.math.BigInteger
import java.net.ServerSocket
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.nio.file.Files
import java.util.Base64
import javax.crypto.KeyGenerator

class AdbPairingTest {
    private val client = TestTls.tls(TestTls.client)

    @Test
    fun pairsWithFakeServer() {
        FakePairingServer("123456").use { server ->
            val peer = AdbPairing(client).pair("127.0.0.1", server.port, "123456")
            server.join()
            assertNull(server.error)
            assertEquals(1, peer.type)
            assertEquals("adb-FAKE0001-abc123", peer.data)
            assertEquals(TestTls.client.adbPublicKey, server.receivedKey)
            assertArrayEquals(TestTls.client.publicKey.encoded, server.clientCertKey)
        }
    }

    @Test
    fun wrongCodeIsReported() {
        FakePairingServer("123456").use { server ->
            val e = assertThrows(AdbPairingException::class.java) { AdbPairing(client).pair("127.0.0.1", server.port, "654321") }
            assertEquals(AdbPairingException.Reason.WRONG_CODE, e.reason)
            server.join()
            assertNull(server.receivedKey)
        }
    }

    @Test
    fun deviceClosingAfterOurPeerInfoMeansWrongCode() {
        FakePairingServer("1", FakePairingServer.Behavior.CLOSE_AFTER_SPAKE).use { server ->
            val e = assertThrows(AdbPairingException::class.java) { AdbPairing(client).pair("127.0.0.1", server.port, "1") }
            assertEquals(AdbPairingException.Reason.WRONG_CODE, e.reason)
        }
    }

    @Test
    fun protocolViolationsAreRejected() {
        for (b in listOf(FakePairingServer.Behavior.BAD_HEADER_VERSION, FakePairingServer.Behavior.WRONG_TYPE)) {
            FakePairingServer("1", b).use { server ->
                val e = assertThrows(AdbPairingException::class.java) { AdbPairing(client).pair("127.0.0.1", server.port, "1") }
                assertEquals(b.name, AdbPairingException.Reason.PROTOCOL, e.reason)
            }
        }
    }

    @Test
    fun connectFailureIsReported() {
        val port = ServerSocket(0).use { it.localPort }
        val e = assertThrows(AdbPairingException::class.java) { AdbPairing(client).pair("127.0.0.1", port, "1", timeoutMs = 2000) }
        assertEquals(AdbPairingException.Reason.CONNECT_FAILED, e.reason)
    }

    /** 两端导出一致,且空 context 与不带 context 相同(Android 端传空数组)。 */
    @Test
    fun tls13ExporterAgreesAndIgnoresEmptyContext() {
        ServerSocket(0, 1, java.net.InetAddress.getLoopbackAddress()).use { ss ->
            val serverTls = TestTls.tls(TestTls.device)
            var serverSide: ByteArray? = null
            val t = kotlin.concurrent.thread {
                ss.accept().use { p ->
                    val s = serverTls.wrap(p, "127.0.0.1", ss.localPort, client = false)
                    serverSide = org.conscrypt.Conscrypt.exportKeyingMaterial(s, AdbPairing.EXPORT_LABEL, null, 64)
                    s.inputStream.read()
                }
            }
            client.connect("127.0.0.1", ss.localPort, 5000).use { s ->
                assertEquals("TLSv1.3", s.session.protocol)
                val a = org.conscrypt.Conscrypt.exportKeyingMaterial(s, AdbPairing.EXPORT_LABEL, null, 64)
                val b = org.conscrypt.Conscrypt.exportKeyingMaterial(s, AdbPairing.EXPORT_LABEL, ByteArray(0), 64)
                assertArrayEquals(a, b)
                assertTrue(!a.contentEquals(org.conscrypt.Conscrypt.exportKeyingMaterial(s, "adb-label", null, 64)))
                s.outputStream.write(0)
                t.join(5000)
                assertArrayEquals(a, serverSide)
            }
        }
    }

    @Test
    fun packetFraming() {
        val out = ByteArrayOutputStream()
        AdbPairing.writePacket(out, AdbPairing.TYPE_PEER_INFO, ByteArray(0x1234) { 7 })
        val bytes = out.toByteArray()
        assertArrayEquals(byteArrayOf(1, 1, 0, 0, 0x12, 0x34), bytes.copyOf(6))
        assertEquals(0x1234 + 6, bytes.size)
        val back = AdbPairing.readPacket(DataInputStream(bytes.inputStream()), AdbPairing.TYPE_PEER_INFO)!!
        assertEquals(0x1234, back.size)
        assertNull(AdbPairing.readPacket(DataInputStream(ByteArray(0).inputStream()), 0))
        val tooBig = byteArrayOf(1, 0, 0, 0, 0x40, 0x01)
        assertThrows(AdbPairingException::class.java) { AdbPairing.readPacket(DataInputStream(tooBig.inputStream()), 0) }
    }
}

class AdbIdentityTest {
    @Test
    fun publicKeyStructure() {
        val id = TestTls.client
        val raw = AdbPublicKey.encode(id.publicKey)
        assertEquals(524, raw.size)
        val bb = ByteBuffer.wrap(raw).order(ByteOrder.LITTLE_ENDIAN)
        assertEquals(64, bb.getInt())
        val n0inv = bb.getInt().toLong() and 0xffffffffL
        val n = EdPoint.fromLe(raw.copyOfRange(8, 264))
        val rr = EdPoint.fromLe(raw.copyOfRange(264, 520))
        bb.position(520)
        assertEquals(65537, bb.getInt())
        assertEquals(id.publicKey.modulus, n)
        // n0inv · n ≡ −1 (mod 2^32)
        val r32 = BigInteger.ONE.shiftLeft(32)
        assertEquals(r32 - BigInteger.ONE, (BigInteger.valueOf(n0inv) * n).mod(r32))
        assertEquals(BigInteger.ONE.shiftLeft(4096).mod(n), rr)

        val (b64, name) = id.adbPublicKey.split(" ", limit = 2)
        assertArrayEquals(raw, Base64.getDecoder().decode(b64))
        assertEquals("nova@test", name)
    }

    @Test
    fun adbKeyNameHasNoWhitespace() {
        val id = AdbIdentity(TestTls.client.keyPair, "nova@Pixel 4\tXL")
        assertEquals("nova@Pixel_4_XL", id.adbPublicKey.substringAfter(' '))
    }

    @Test
    fun selfSignedCertificateParsesAndVerifies() {
        val cert = TestTls.client.certificate
        assertEquals(3, cert.version)
        assertEquals("CN=Nova", cert.subjectX500Principal.name)
        assertEquals(cert.subjectX500Principal, cert.issuerX500Principal)
        assertEquals("SHA256withRSA", cert.sigAlgName)
        assertArrayEquals(TestTls.client.publicKey.encoded, cert.publicKey.encoded)
        cert.verify(TestTls.client.publicKey)
        cert.checkValidity()
        assertEquals(0L, cert.notBefore.time)
    }

    @Test
    fun derLongLengths() {
        assertArrayEquals(byteArrayOf(4, 0x81.toByte(), 0x80.toByte()), SelfSignedCertificate.tlv(4, ByteArray(0x80)).copyOf(3))
        assertArrayEquals(byteArrayOf(4, 0x82.toByte(), 1, 0), SelfSignedCertificate.tlv(4, ByteArray(0x100)).copyOf(4))
    }

    @Test
    fun wrappedKeyFileRoundTripAndIdentitySource() {
        val dir = Files.createTempDirectory("adbkey").toFile()
        val aes = KeyGenerator.getInstance("AES").apply { init(256) }.generateKey()
        val file = java.io.File(dir, "k.bin")
        val store = WrappedKeyFile(file) { aes }
        assertNull(store.read())
        val a = AdbIdentitySource(store, { "nova@x" }).forConnect()
        val raw = file.readBytes()
        assertTrue("not stored in clear", !String(raw, Charsets.ISO_8859_1).contains(String(a.keyPair.private.encoded.copyOfRange(30, 60), Charsets.ISO_8859_1)))
        // 另一个进程(新的来源)读回同一把
        val b = AdbIdentitySource(store, { "nova@x" }).forConnect()
        assertEquals(a.publicKey, b.publicKey)
        assertEquals(a.adbPublicKey, b.adbPublicKey)

        // 换了包装密钥(如 Keystore 被清)就读不出:报出来,不换钥匙、不动文件
        val other = KeyGenerator.getInstance("AES").apply { init(256) }.generateKey()
        val otherStore = WrappedKeyFile(file) { other }
        assertThrows(AdbKeyUnreadableException::class.java) { otherStore.read() }
        val src = AdbIdentitySource(otherStore, { "nova@x" })
        assertThrows(AdbKeyUnreadableException::class.java) { src.forConnect() }
        assertEquals(AdbKeyState.Unreadable, src.state)
        assertArrayEquals(raw, file.readBytes())
        store.clear()
        assertNull(store.read())
    }

    @Test
    fun wrappedKeyFileThatIsEmptyOrTruncatedIsUnreadableNotAbsent() {
        val dir = Files.createTempDirectory("adbkey").toFile()
        val aes = KeyGenerator.getInstance("AES").apply { init(256) }.generateKey()
        val file = java.io.File(dir, "k.bin")
        val store = WrappedKeyFile(file) { aes }
        file.writeBytes(ByteArray(0))
        assertThrows(AdbKeyUnreadableException::class.java) { store.read() }
        file.writeBytes(byteArrayOf(12, 1, 2, 3))
        assertThrows(AdbKeyUnreadableException::class.java) { store.read() }
    }
}
