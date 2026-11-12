package com.nova.nova_mobile.phone

/**
 * Whether a run's accessibility stop button is shown. A main-tier run always shows it. A virtual-tier run's stop lives
 * on the floating pet: its button waits [GRACE_MS] for the pet to cover the run and appears whenever the pet reports
 * it no longer does. A cover is a lease of [LEASE_MS] that the pet renews; if Flutter dies the lease lapses and the
 * button returns, so native never depends on Flutter for a kill switch.
 */
class StopCover(private val tier: PhoneTier) {
    var covered = false
        private set
    /** Changes on every cover change; an expiry check scheduled under an older value is stale. */
    var generation = 0L
        private set
    private var leaseUntil = 0L
    val showAtStart get() = tier == PhoneTier.MAIN
    /** After the grace period: show unless the pet covers the run. */
    fun showAfterGrace() = tier == PhoneTier.VIRTUAL && !covered
    /** `true` show, `false` hide, `null` ignore (a main-tier run is never covered). Covering grants or renews a lease. */
    fun cover(covered: Boolean, now: Long): Boolean? {
        if (tier != PhoneTier.VIRTUAL) return null
        this.covered = covered
        generation++
        leaseUntil = if (covered) now + LEASE_MS else 0L
        return !covered
    }
    /** The expiry check scheduled at [generation]: `true` when the lease lapsed and the button must show. */
    fun expire(generation: Long, now: Long): Boolean {
        if (!covered || generation != this.generation || now < leaseUntil) return false
        covered = false
        this.generation++
        return true
    }
    companion object {
        const val GRACE_MS = 2000L
        const val LEASE_MS = 8000L
    }
}
