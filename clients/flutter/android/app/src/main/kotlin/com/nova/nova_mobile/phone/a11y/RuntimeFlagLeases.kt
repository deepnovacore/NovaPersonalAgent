package com.nova.nova_mobile.phone.a11y

/**
 * Leases on the runtime accessibility flag [extra] that virtual runs and the self-check need (contract: the main-tier
 * tree stays unchanged outside them). The first lease saves the service flags and adds [extra]; the last release puts
 * the saved flags back, synchronously. Acquiring is transactional: when writing the flags throws, no lease exists and
 * nothing is saved. [reconnect] first tells every lease owner (so an in-flight run stops), then voids the remaining
 * leases and restores the saved flags; a release of a voided lease never touches the new configuration.
 * A restoration that throws keeps the saved flags as a debt ([restorationOwed]): [restore] and the next [acquire] retry
 * it, and until it succeeds no lease is granted and no run of either tier may start.
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

    /** The last restoration failed: the service may still carry [extra] while no lease is held. */
    @Volatile var restorationOwed = false
        private set

    /**
     * Adds [extra] for the caller; [onVoided] runs (off any lock) when a reconnect voids the lease. Throws when the flags
     * cannot be written, and IllegalStateException([ACCESSIBILITY_FLAGS_FAILED]) while an owed restoration still fails.
     */
    fun acquire(onVoided: () -> Unit): Lease = synchronized(lock) {
        if (leases.isEmpty()) {
            writeBack()
            check(!restorationOwed) { ACCESSIBILITY_FLAGS_FAILED }
            val before = store.read()
            if (before != null && before and extra == 0) store.write(before or extra)
            saved = before
        }
        Lease(onVoided).also { leases += it; held = leases.size }
    }

    private fun release(lease: Lease) = synchronized(lock) {
        if (!leases.remove(lease)) return
        held = leases.size
        if (leases.isEmpty()) writeBack()
    }

    /** Retries an owed restoration while no lease is held. True when nothing is owed afterwards. */
    fun restore(): Boolean = synchronized(lock) {
        if (leases.isEmpty()) writeBack()
        !restorationOwed
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
            if (leases.isEmpty()) writeBack()
        }
    }

    /** Writes the saved flags back; when the write throws they stay saved and the restoration is owed. */
    private fun writeBack() {
        val before = saved ?: return
        restorationOwed = try {
            store.write(before)
            saved = null
            false
        } catch (_: Exception) {
            true
        }
    }

    companion object {
        /** The runtime flags could not be set, or a failed restoration still leaves them changed. */
        const val ACCESSIBILITY_FLAGS_FAILED = "accessibility_flags_failed"
    }
}
