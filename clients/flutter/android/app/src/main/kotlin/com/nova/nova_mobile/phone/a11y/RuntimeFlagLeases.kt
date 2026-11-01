package com.nova.nova_mobile.phone.a11y

/**
 * Leases on the runtime accessibility flag [extra] that virtual runs and the self-check need (contract: the main-tier
 * tree stays unchanged outside them). The first lease saves the service flags and adds [extra]; the last release puts
 * the saved flags back, synchronously. Acquiring is transactional: when writing the flags throws, no lease exists and
 * nothing is saved. [reconnect] first tells every lease owner (so an in-flight run stops), then voids the remaining
 * leases and restores the saved flags; a release of a voided lease never touches the new configuration.
 */
class RuntimeFlagLeases(private val store: Store, private val extra: Int) {
    /** The service configuration. [read] is null while the service has none. */
    interface Store {
        fun read(): Int?
        fun write(flags: Int)
    }

    inner class Lease internal constructor(internal val onVoided: () -> Unit) {
        /** Gives the lease back; the last one restores the saved flags. Idempotent. */
        fun release() = release(this)
    }

    private val lock = Any()
    private val leases = LinkedHashSet<Lease>()
    private var saved: Int? = null

    /** Number of live leases. */
    @Volatile var held = 0
        private set

    /** Adds [extra] for the caller; [onVoided] runs (off any lock) when a reconnect voids the lease. Throws when the flags cannot be written. */
    fun acquire(onVoided: () -> Unit): Lease = synchronized(lock) {
        if (leases.isEmpty()) {
            val before = store.read()
            if (before != null && before and extra == 0) store.write(before or extra)
            saved = before
        }
        Lease(onVoided).also { leases += it; held = leases.size }
    }

    private fun release(lease: Lease) = synchronized(lock) {
        if (!leases.remove(lease)) return
        held = leases.size
        if (leases.isEmpty()) restore()
    }

    /**
     * The service connected again: its old configuration may be kept or reset. Owners of the leases taken before are
     * told first (their release runs the normal path); those still leased afterwards are voided, and when no lease is
     * left the saved flags are written back.
     */
    fun reconnect() {
        val owners = synchronized(lock) { leases.toList() }
        owners.forEach { runCatching { it.onVoided() } }
        synchronized(lock) {
            leases.removeAll(owners.toSet())
            held = leases.size
            if (leases.isEmpty()) restore()
        }
    }

    /** Writes the saved flags back. A service that is gone keeps nothing to restore, so a failed write is dropped. */
    private fun restore() {
        val before = saved ?: return
        saved = null
        runCatching { store.write(before) }
    }
}
