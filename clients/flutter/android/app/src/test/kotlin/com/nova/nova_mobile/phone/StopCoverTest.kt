package com.nova.nova_mobile.phone

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class StopCoverTest {
    @Test fun mainRunShowsAtOnceAndIgnoresCover() {
        val cover = StopCover(PhoneTier.MAIN)
        assertTrue(cover.showAtStart)
        assertFalse(cover.showAfterGrace())
        assertNull(cover.cover(true, 0))
        assertFalse(cover.covered)
        assertFalse(cover.expire(cover.generation, StopCover.LEASE_MS))
    }

    @Test fun virtualRunShowsAfterGraceUnlessCovered() {
        val cover = StopCover(PhoneTier.VIRTUAL)
        assertFalse(cover.showAtStart)
        assertTrue(cover.showAfterGrace())
        assertEquals(false, cover.cover(true, 0))
        assertFalse(cover.showAfterGrace())
        assertEquals(true, cover.cover(false, 1))
        assertTrue(cover.showAfterGrace())
    }

    @Test fun anUnrenewedCoverLapses() {
        val cover = StopCover(PhoneTier.VIRTUAL)
        cover.cover(true, 1000)
        val generation = cover.generation
        assertFalse(cover.expire(generation, 1000 + StopCover.LEASE_MS - 1))
        assertTrue(cover.covered)
        assertTrue(cover.expire(generation, 1000 + StopCover.LEASE_MS))
        assertFalse(cover.covered)
        assertTrue(cover.showAfterGrace())
        assertFalse("an uncovered run has no lease", cover.expire(cover.generation, 1000 + 2 * StopCover.LEASE_MS))
    }

    @Test fun renewalAndUncoverMakeOlderChecksStale() {
        val cover = StopCover(PhoneTier.VIRTUAL)
        cover.cover(true, 0)
        val first = cover.generation
        cover.cover(true, 3000)
        assertFalse(cover.expire(first, StopCover.LEASE_MS))
        assertTrue(cover.covered)
        val renewed = cover.generation
        cover.cover(false, 4000)
        cover.cover(true, 5000)
        assertFalse(cover.expire(renewed, 3000 + StopCover.LEASE_MS))
        assertTrue(cover.expire(cover.generation, 5000 + StopCover.LEASE_MS))
    }
}
