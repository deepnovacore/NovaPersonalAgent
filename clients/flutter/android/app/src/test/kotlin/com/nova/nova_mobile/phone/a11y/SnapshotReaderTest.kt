package com.nova.nova_mobile.phone.a11y

import org.junit.Assert.assertEquals
import org.junit.Test

class SnapshotReaderTest {
    @Test fun normalizeMapsPixelsToTheSnapshotRange() {
        assertEquals(0, normalize(0, 1080))
        assertEquals(999, normalize(1079, 1080))
        assertEquals(999, normalize(5000, 1080))
        assertEquals(0, normalize(-3, 1080))
        assertEquals(0, normalize(10, 1))
    }
}
