package com.nova.nova_mobile.phone.a11y

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Assert.assertNull
import org.junit.Test

class SnapshotReaderTest {
    @Test fun normalizeMapsPixelsToTheSnapshotRange() {
        assertEquals(0, normalize(0, 1080))
        assertEquals(999, normalize(1079, 1080))
        assertEquals(999, normalize(5000, 1080))
        assertEquals(0, normalize(-3, 1080))
        assertEquals(0, normalize(10, 1))
    }

    @Test fun fieldsAreNeverNamedByTheirContents() {
        assertEquals("Search", nodeName("hunter2", "hunter2", "Search", field = true) { "Query" })
        assertEquals("Query", nodeName("hunter2", "hunter2", null, field = true) { "Query" })
        assertNull(nodeName("hunter2", "hunter2", " ", field = true) { null })
    }

    @Test fun secureFrameNeedsABlackFrameAndReadableElements() {
        assertTrue(isSecureFrame(black = true, hasAppWindow = true, visibleElements = 3))
        assertFalse(isSecureFrame(black = true, hasAppWindow = true, visibleElements = 0))
        assertFalse(isSecureFrame(black = true, hasAppWindow = false, visibleElements = 3))
        assertFalse(isSecureFrame(black = false, hasAppWindow = true, visibleElements = 3))
    }

    @Test fun otherNodesAreNamedByTextThenDescriptionThenHint() {
        assertEquals("Buy", nodeName(" Buy ", "Purchase", "hint", field = false) { "label" })
        assertEquals("Purchase", nodeName("", "Purchase", "hint", field = false) { "label" })
        assertEquals("hint", nodeName(null, null, "hint", field = false) { "label" })
        assertNull(nodeName(null, null, null, field = false) { "label" })
    }
}
