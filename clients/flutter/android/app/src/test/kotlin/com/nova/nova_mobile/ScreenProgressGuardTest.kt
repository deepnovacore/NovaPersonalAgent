package com.nova.nova_mobile

import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

class ScreenProgressGuardTest {
    private fun screen(name: String, serial: Int = 0) = JSONObject().put("package", "test.app")
        .put("snapshot_id", "ph-$serial").put("image", "frame-$serial")
        .put("elements", JSONArray().put(JSONObject().put("name", name).put("ref", "@e${serial + 1}")))

    @Test fun backEnterOscillationWarnsThenInterruptsDespiteFreshFramesAndRefs() {
        val guard = ScreenProgressGuard()
        for (i in 0..3) assertEquals("", guard.observe(screen(if (i % 2 == 0) "list" else "video", i), if (i % 2 == 0) "back" else "tap").note)
        val warning = guard.observe(screen("list", 4), "back")
        assertTrue(warning.note.contains("3 times"))
        assertFalse(warning.interrupt)
        assertFalse(guard.observe(screen("video", 5), "tap").interrupt)
        assertTrue(guard.observe(screen("list", 6), "back").interrupt)
    }

    @Test fun unchangedScreenHasBoundedGraceAndNewScreenResetsWarning() {
        val guard = ScreenProgressGuard()
        repeat(6) { assertEquals("", guard.observe(screen("video", it), "tap").note) }
        assertTrue(guard.observe(screen("video", 6), "tap").note.isNotEmpty())
        assertFalse(guard.observe(screen("video", 7), "tap").interrupt)
        assertTrue(guard.observe(screen("video", 8), "tap").interrupt)
        assertEquals(ScreenProgressGuard.Result(), guard.observe(screen("new approach"), "back"))
    }

    @Test fun progressingScreensAndChangedToggleStatesDoNotTrigger() {
        val guard = ScreenProgressGuard()
        repeat(30) { assertEquals(ScreenProgressGuard.Result(), guard.observe(screen("result $it"), "scroll")) }
        val state = screen("like")
        assertEquals(ScreenProgressGuard.Result(), guard.observe(state, "tap"))
        state.getJSONArray("elements").getJSONObject(0).put("checked", true)
        assertEquals(ScreenProgressGuard.Result(), guard.observe(state, "tap"))
    }

    @Test fun mainTreeIsSupportedAndUnstableOrMissingTreesAreIgnored() {
        val guard = ScreenProgressGuard()
        repeat(20) { assertEquals(ScreenProgressGuard.Result(), guard.observe(JSONObject().put("image", "black"), "back")) }
        repeat(20) { assertEquals(ScreenProgressGuard.Result(), guard.observe(screen("loading").put("changed_during_read", true), "back")) }
        val main = JSONObject().put("package", "test.app").put("tree", "Button|Like|checked=true")
        repeat(6) { assertEquals("", guard.observe(main, "tap").note) }
        assertTrue(guard.observe(main, "tap").note.isNotEmpty())
    }
}
