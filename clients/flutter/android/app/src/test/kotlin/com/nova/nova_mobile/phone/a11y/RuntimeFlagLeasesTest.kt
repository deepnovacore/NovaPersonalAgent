package com.nova.nova_mobile.phone.a11y

import org.junit.Assert.assertEquals
import org.junit.Assert.fail
import org.junit.Test

class RuntimeFlagLeasesTest {
    private val extra = 2

    private class Store(var flags: Int? = 1) : RuntimeFlagLeases.Store {
        var failWrites = false
        val writes = mutableListOf<Int>()
        override fun read() = flags
        override fun write(flags: Int) {
            if (failWrites) throw IllegalStateException("binder")
            writes += flags
            this.flags = flags
        }
    }

    @Test fun firstLeaseAddsTheFlagAndTheLastReleaseRestoresIt() {
        val store = Store()
        val leases = RuntimeFlagLeases(store, extra)
        val a = leases.acquire {}
        val b = leases.acquire {}
        assertEquals(3, store.flags)
        a.release()
        a.release()
        assertEquals(3, store.flags)
        assertEquals(1, leases.held)
        b.release()
        assertEquals(1, store.flags)
        assertEquals(0, leases.held)
        assertEquals(listOf(3, 1), store.writes)
    }

    @Test fun failedAcquisitionLeavesNoLeaseAndNoSavedFlags() {
        val store = Store()
        val leases = RuntimeFlagLeases(store, extra)
        store.failWrites = true
        try { leases.acquire {}; fail() } catch (e: IllegalStateException) { assertEquals("binder", e.message) }
        assertEquals(0, leases.held)
        store.failWrites = false
        store.flags = 5
        val lease = leases.acquire {}
        assertEquals(7, store.flags)
        lease.release()
        assertEquals(5, store.flags)
    }

    @Test fun reconnectStopsOwnersFirstThenRestoresTheSavedFlags() {
        val store = Store()
        val leases = RuntimeFlagLeases(store, extra)
        val order = mutableListOf<String>()
        lateinit var run: RuntimeFlagLeases.Lease
        run = leases.acquire { order += "run stopped flags=${store.flags}"; run.release() }
        val selfCheck = leases.acquire { order += "self-check told flags=${store.flags}" }
        leases.reconnect()
        // Both owners heard of the reconnect while the old configuration was still in place.
        assertEquals(listOf("run stopped flags=3", "self-check told flags=3"), order)
        assertEquals(1, store.flags)
        assertEquals(0, leases.held)
        // A release from before the reconnect never touches a lease taken after it.
        val next = leases.acquire {}
        assertEquals(3, store.flags)
        selfCheck.release()
        assertEquals(3, store.flags)
        assertEquals(1, leases.held)
        next.release()
        assertEquals(1, store.flags)
    }

    @Test fun reconnectWithoutLeasesWritesNothing() {
        val store = Store()
        RuntimeFlagLeases(store, extra).reconnect()
        assertEquals(emptyList<Int>(), store.writes)
    }

    @Test fun flagAlreadySetIsKeptAfterTheLastRelease() {
        val store = Store(flags = 3)
        val leases = RuntimeFlagLeases(store, extra)
        leases.acquire {}.release()
        assertEquals(3, store.flags)
    }
}
