// Derived from Mika (https://github.com/wangzan101/Mika, Apache-2.0, commit 5f630d9),
// Copyright 2026 wangzan101. Modified by Nova: package rename only.
package com.nova.phone.core.adb

import com.nova.phone.core.adb.AdbConnectionException.Reason
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

class AdbConnectPortTest {
    private class Cache(var port: Int? = null) : PortCache {
        override fun load() = port
        override fun save(port: Int) { this.port = port }
    }

    private val attempts = mutableListOf<Int>()
    private var mdnsAsked = 0

    private fun chain(prop: Int?, mdns: Int?, cache: Cache, propThrows: Boolean = false, mdnsAll: List<Int>? = null) = AdbConnectPort(
        property = { if (propThrows) throw SecurityException("denied") else prop },
        finder = { _, _ -> mdnsAsked++; mdnsAll ?: listOfNotNull(mdns) },
        cache = cache,
    )

    private fun opener(vararg ok: Int, unauthorized: Int? = null): (String, Int) -> String = { _, port ->
        attempts += port
        when (port) {
            unauthorized -> throw AdbConnectionException(Reason.UNAUTHORIZED, "no")
            in ok -> "conn@$port"
            else -> throw AdbConnectionException(Reason.CONNECT_FAILED, "closed")
        }
    }

    @Test
    fun cachedFirstThenPropertyAndMdnsNotAskedWhenItWorks() = runTest {
        // 缓存的旧端口被拒得很快,接着试属性
        val cache = Cache(1111)
        assertEquals("conn@4000", chain(4000, 5000, cache).connect(opener(4000)))
        assertEquals(listOf(1111, 4000), attempts)
        assertEquals(0, mdnsAsked)
        assertEquals(4000, cache.port)
        attempts.clear()
        assertEquals("conn@4000", chain(4000, 5000, cache).connect(opener(4000)))
        assertEquals(listOf(4000), attempts)
    }

    @Test
    fun unreadableOrZeroPropertyFallsToMdnsThenCache() = runTest {
        val cache = Cache(1111)
        assertEquals("conn@5000", chain(0, 5000, cache).connect(opener(5000)))
        assertEquals(5000, cache.port)
        attempts.clear()
        assertEquals("conn@5000", chain(null, null, Cache(5000), propThrows = true).connect(opener(5000)))
        assertEquals(listOf(5000), attempts)
    }

    @Test
    fun stalePortsAreSkippedAndDuplicatesTriedOnce() = runTest {
        // 缓存、属性都是旧端口(都连不上),mDNS 又给了同一个旧端口,最后一个才对
        val cache = Cache(4000)
        assertEquals("conn@6000", chain(4000, null, cache, mdnsAll = listOf(4000, 6000)).connect(opener(6000)))
        assertEquals(listOf(4000, 6000), attempts)
    }

    /** 前 [rejectFirst] 次连 [port] 时 TLS 被拒([reason]),之后连得上;别的端口照 [rest]。 */
    private fun flaky(port: Int, rejectFirst: Int, rest: (String, Int) -> String, reason: Reason = Reason.UNAUTHORIZED): (String, Int) -> String {
        var left = rejectFirst
        return { host, p ->
            if (p == port && left > 0) {
                attempts += p
                left--
                throw AdbConnectionException(reason, "tls")
            }
            rest(host, p)
        }
    }

    @Test
    fun tlsRejectionOnceIsRetriedOnTheSamePort() = runTest {
        // 有的系统让另一个服务先接住第一次 TLS 握手、对谁的证书都拒;紧接着再连就落到 adbd
        val cache = Cache()
        assertEquals("conn@4000", chain(4000, 5000, cache).connect(flaky(4000, 1, opener(4000))))
        assertEquals(listOf(4000, 4000), attempts)
        assertEquals(4000, cache.port)
        attempts.clear()
        assertEquals("conn@4000", chain(4000, null, Cache()).connect(flaky(4000, 1, opener(4000), Reason.TLS_FAILED)))
        assertEquals(listOf(4000, 4000), attempts)
    }

    @Test
    fun aCandidateThatKeepsRejectingDoesNotStopTheOthers() = runTest {
        val cache = Cache()
        assertEquals("conn@5001", chain(null, null, cache, mdnsAll = listOf(5000, 5001)).connect(opener(5001, unauthorized = 5000)))
        assertEquals(listOf(5000, 5000, 5001), attempts)
        assertEquals(5001, cache.port)
    }

    @Test
    fun rejectedEverywhereIsUnauthorized() = runTest {
        // 唯一一个回话的端口试两次都拒,其余是旧端口:钥匙确实不被认,要重新配对;不再扫本机端口
        val scanner = FakeScanner(mapOf("127.0.0.1" to listOf(41000)), setOf(AdbEndpoint("127.0.0.1", 41000)))
        val port = AdbConnectPort(
            { 4000 }, { _, _ -> listOf(5000) }, Cache(3000),
            scan = LocalPortScan(scanner, { listOf("127.0.0.1") }),
        )
        try {
            port.connect(opener(41000, unauthorized = 4000))
            fail("expected UNAUTHORIZED")
        } catch (e: AdbConnectionException) {
            assertEquals(Reason.UNAUTHORIZED, e.reason)
        }
        assertEquals(listOf(3000, 4000, 4000, 5000), attempts)
        assertTrue(scanner.swept.isEmpty())
    }

    @Test
    fun nothingFoundIsConnectFailed() = runTest {
        val cache = Cache()
        try {
            chain(null, null, cache).connect(opener())
            fail("expected CONNECT_FAILED")
        } catch (e: AdbConnectionException) {
            assertEquals(Reason.CONNECT_FAILED, e.reason)
        }
        assertNull(cache.port)
        try {
            chain(4000, null, cache).connect(opener())
            fail("expected CONNECT_FAILED")
        } catch (e: AdbConnectionException) {
            assertEquals(Reason.CONNECT_FAILED, e.reason)
        }
        assertNull(cache.port)
    }

    @Test
    fun everyMdnsPortIsTriedWhenAStaleRecordComesFirst() = runTest {
        // 关了又开无线调试:旧端口的记录还在,新的和它一起回来
        val cache = Cache(4000)
        assertEquals("conn@5000", chain(null, null, cache, mdnsAll = listOf(4000, 5000)).connect(opener(5000)))
        assertEquals(listOf(4000, 5000), attempts)
        assertEquals(5000, cache.port)
    }

    /** 每次连接结束都报一次各来源给了几个候选:连上的、全失败的都报。 */
    @Test
    fun reportsCandidateCounts() = runTest {
        val seen = mutableListOf<ConnectCandidates>()
        val ok = AdbConnectPort({ null }, { _, _ -> listOf(5000, 5001) }, Cache(4999), report = { seen += it })
        assertEquals("conn@5001", ok.connect(opener(5001)))
        assertEquals(ConnectCandidates(property = 0, mdns = 2, cache = 1, connected = true), seen.single())
        seen.clear()
        val none = AdbConnectPort({ null }, { _, _ -> emptyList() }, Cache(), report = { seen += it })
        try {
            none.connect(opener())
            fail()
        } catch (e: AdbConnectionException) {
            assertEquals(Reason.CONNECT_FAILED, e.reason)
        }
        assertEquals(ConnectCandidates(0, 0, 0, connected = false), seen.single())
    }

    /** 假扫描:[open] 是各地址上开着的端口,[adb] 里的才回 STLS;记下扫了哪些地址、跳过了哪些端口。 */
    private class FakeScanner(val open: Map<String, List<Int>>, val adb: Set<AdbEndpoint>) : LocalPortScanner {
        val swept = mutableListOf<String>()
        var skipped: Set<Int> = emptySet()
        override suspend fun openPorts(host: String, ports: IntRange, skip: Set<Int>, budgetMs: Long): List<Int> {
            swept += host
            skipped = skip
            return open[host].orEmpty().filter { it in ports && it !in skip }
        }
        override fun speaksAdbTls(host: String, port: Int, timeoutMs: Int) = AdbEndpoint(host, port) in adb
    }

    private val wifi = "192.0.2.10"

    @Test
    fun scanRunsOnlyAfterEarlierSourcesFailAndTheHitIsCached() = runTest {
        val scanner = FakeScanner(mapOf("127.0.0.1" to listOf(40000, 41235)), setOf(AdbEndpoint("127.0.0.1", 41235)))
        val cache = Cache(39000)
        val seen = mutableListOf<ConnectCandidates>()
        val progress = mutableListOf<Boolean>()
        val port = AdbConnectPort(
            { null }, { _, _ -> emptyList() }, cache, report = { seen += it },
            scan = LocalPortScan(scanner, { listOf("127.0.0.1", wifi) }), scanning = { progress += it },
        )
        assertEquals("conn@41235", port.connect(opener(41235)))
        assertEquals(listOf(39000, 41235), attempts)
        assertEquals(41235, cache.port)
        // 已经试过的缓存端口不再扫;本机地址上找到了,不再扫 Wi-Fi 地址
        assertTrue(39000 in scanner.skipped)
        assertEquals(listOf("127.0.0.1"), scanner.swept)
        assertEquals(listOf(true, false), progress)
        assertEquals(ConnectCandidates(0, 0, 1, connected = true, scanned = true, scanOpen = 2, scanAdb = 1), seen.single())
        // 下次缓存直接连上,不再扫
        attempts.clear()
        assertEquals("conn@41235", port.connect(opener(41235)))
        assertEquals(listOf(41235), attempts)
        assertEquals(listOf("127.0.0.1"), scanner.swept)
    }

    @Test
    fun scanNotRunWhenAnEarlierSourceConnects() = runTest {
        val scanner = FakeScanner(emptyMap(), emptySet())
        val port = AdbConnectPort({ 4000 }, { _, _ -> emptyList() }, Cache(), scan = LocalPortScan(scanner, { listOf("127.0.0.1") }))
        assertEquals("conn@4000", port.connect(opener(4000)))
        assertTrue(scanner.swept.isEmpty())
    }

    @Test
    fun scanFallsToWifiAddressAndConnectsThere() = runTest {
        val scanner = FakeScanner(mapOf("127.0.0.1" to listOf(40000), wifi to listOf(40000, 45000)), setOf(AdbEndpoint(wifi, 45000)))
        val hosts = mutableListOf<String>()
        val port = AdbConnectPort({ null }, { _, _ -> emptyList() }, Cache(), scan = LocalPortScan(scanner, { listOf("127.0.0.1", wifi) }))
        assertEquals("conn@45000", port.connect { host, p -> hosts += host; opener(45000)(host, p) })
        assertEquals(listOf("127.0.0.1", wifi), scanner.swept)
        assertEquals(listOf(wifi), hosts)
    }

    @Test
    fun firstVerifiedScanHitWinsAndLaterOnesAreNotTried() = runTest {
        val hits = setOf(AdbEndpoint("127.0.0.1", 41000), AdbEndpoint("127.0.0.1", 42000))
        val scanner = FakeScanner(mapOf("127.0.0.1" to listOf(41000, 42000)), hits)
        val port = AdbConnectPort({ null }, { _, _ -> emptyList() }, Cache(), scan = LocalPortScan(scanner, { listOf("127.0.0.1") }))
        assertEquals("conn@41000", port.connect(opener(41000, 42000)))
        assertEquals(listOf(41000), attempts)
        // 第一个握手失败就试下一个
        attempts.clear()
        assertEquals("conn@42000", port.connect(opener(42000)))
        assertEquals(listOf(41000, 42000), attempts)
    }

    @Test
    fun manualPortIsTriedLastWithoutScanningAndCachedOnSuccess() = runTest {
        val scanner = FakeScanner(mapOf("127.0.0.1" to listOf(41235)), setOf(AdbEndpoint("127.0.0.1", 41235)))
        val cache = Cache()
        val seen = mutableListOf<ConnectCandidates>()
        val port = AdbConnectPort(
            { null }, { _, _ -> emptyList() }, cache, report = { seen += it },
            scan = LocalPortScan(scanner, { listOf("127.0.0.1") }), manual = { 43000 },
        )
        assertEquals("conn@43000", port.connect(opener(43000)))
        assertTrue(scanner.swept.isEmpty())
        assertEquals(43000, cache.port)
        assertEquals(ConnectCandidates(0, 0, 0, connected = true, manual = true), seen.single())
    }

    @Test
    fun scanAndManualBothFailingIsConnectFailed() = runTest {
        val scanner = FakeScanner(mapOf("127.0.0.1" to listOf(40000)), emptySet())
        val seen = mutableListOf<ConnectCandidates>()
        val port = AdbConnectPort({ null }, { _, _ -> emptyList() }, Cache(), report = { seen += it }, scan = LocalPortScan(scanner, { listOf("127.0.0.1") }))
        try {
            port.connect(opener())
            fail()
        } catch (e: AdbConnectionException) {
            assertEquals(Reason.CONNECT_FAILED, e.reason)
        }
        assertEquals(ConnectCandidates(0, 0, 0, connected = false, scanned = true, scanOpen = 1, scanAdb = 0), seen.single())
    }
}
