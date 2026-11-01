package com.nova.nova_mobile.phone

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class VirtualSelfCheckTest {
    @Test fun freePointAvoidsEveryClickableRectangle() {
        val rows = (0 until 20).map { intArrayOf(0, it * 100, 1080, it * 100 + 90) }
        val point = VirtualSelfCheck.freePoint(1080, 2400, rows)!!
        assertTrue(rows.none { point.first >= it[0] && point.first < it[2] && point.second >= it[1] && point.second < it[3] })
        assertTrue(point.second >= 240)
    }

    @Test fun freePointPrefersTheBottomCentre() {
        assertEquals(540 to 2376, VirtualSelfCheck.freePoint(1080, 2400, emptyList()))
    }

    @Test fun fullyClickableScreenHasNoFreePoint() {
        assertNull(VirtualSelfCheck.freePoint(1080, 2400, listOf(intArrayOf(0, 0, 1080, 2400))))
    }

    @Test fun rowsFollowTheContractIds() {
        assertEquals(listOf("helper", "create_display", "start_app", "read_tree", "tap", "type", "back", "main_focus"), VirtualSelfCheck.IDS)
    }
}
