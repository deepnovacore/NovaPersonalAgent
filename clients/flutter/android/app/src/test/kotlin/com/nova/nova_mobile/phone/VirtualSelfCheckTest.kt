package com.nova.nova_mobile.phone

import com.nova.nova_mobile.phone.a11y.RuntimeFlagLeases
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
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

    @Test fun reconnectCancelsTheSelfCheckBeforeItsNextEffect() {
        val store = object : RuntimeFlagLeases.Store {
            var flags: Int? = 1
            override fun read() = flags
            override fun write(flags: Int) { this.flags = flags }
        }
        val leases = RuntimeFlagLeases(store, 2)
        val cancellation = SelfCheckCancellation()
        val lease = leases.acquire(cancellation::cancel)
        cancellation.before(VirtualSelfCheck.ID_TAP)
        leases.reconnect()
        assertTrue(cancellation.cancelled)
        try { cancellation.before(VirtualSelfCheck.ID_TYPE); fail() } catch (e: SelfCheckCancelled) {
            assertEquals(VirtualSelfCheck.ID_TYPE, e.row)
            assertEquals(SELF_CHECK_CANCELLED, e.message)
        }
        // The voided lease's release in the self-check's cleanup leaves the restored flags alone.
        assertEquals(1, store.flags)
        lease.release()
        assertEquals(1, store.flags)
    }
}
