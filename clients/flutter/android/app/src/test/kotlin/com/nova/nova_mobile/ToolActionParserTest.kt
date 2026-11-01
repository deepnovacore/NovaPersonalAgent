package com.nova.nova_mobile

import com.nova.nova_mobile.phone.PhoneAction
import com.nova.nova_mobile.phone.PhoneTier
import com.nova.nova_mobile.phone.ScrollDirection
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.fail
import org.junit.Test

class ToolActionParserTest {
    private fun virtual(json: String) = ToolActionParser.parse(JSONObject(json), PhoneTier.VIRTUAL)
    private fun main(json: String) = ToolActionParser.parse(JSONObject(json), PhoneTier.MAIN)
    private fun rejects(code: String, tier: PhoneTier, json: String) {
        try { ToolActionParser.parse(JSONObject(json), tier); fail("accepted $json") }
        catch (error: IllegalArgumentException) { assertEquals(json, code, error.message) }
    }

    @Test fun virtualTierParsesEveryContractAction() {
        assertEquals(PhoneAction.TapRef("@e12", "ph-abc"), virtual("""{"type":"tap","ref":"@e12","snapshot_id":"ph-abc"}"""))
        assertEquals(PhoneAction.TapPoint(0.5, 1.0), virtual("""{"type":"tap","x":0.5,"y":1}"""))
        assertEquals(PhoneAction.Swipe(0.1, 0.9, 0.1, 0.2), virtual("""{"type":"swipe","x":0.1,"y":0.9,"to_x":0.1,"to_y":0.2}"""))
        assertEquals(PhoneAction.Type("hi", null, null), virtual("""{"type":"type","text":"hi"}"""))
        assertEquals(PhoneAction.Type("hi", "@e2", "ph-1"), virtual("""{"type":"type","text":"hi","ref":"@e2","snapshot_id":"ph-1"}"""))
        assertEquals(PhoneAction.Scroll(ScrollDirection.DOWN, null, null), virtual("""{"type":"scroll","direction":"down"}"""))
        assertEquals(PhoneAction.Scroll(ScrollDirection.LEFT, "@e9", "ph-1"), virtual("""{"type":"scroll","direction":"left","ref":"@e9","snapshot_id":"ph-1"}"""))
        assertEquals(PhoneAction.OpenApp("com.example.app"), virtual("""{"type":"open_app","package":"com.example.app"}"""))
        assertEquals(PhoneAction.Back, virtual("""{"type":"back"}"""))
        assertEquals(PhoneAction.HandToUser("Login needed"), virtual("""{"type":"hand_to_user","reason":"  Login needed "}"""))
    }

    @Test fun virtualTierRejectsMalformedFieldsWithExactCodes() {
        val v = PhoneTier.VIRTUAL
        rejects("unsupported_action", v, """{"type":"shell","command":"id"}""")
        rejects("invalid_action_fields", v, """{"type":"tap","ref":"@e1"}""")
        rejects("invalid_action_fields", v, """{"type":"tap","ref":"@e1","snapshot_id":"ph-1","x":0.1}""")
        rejects("invalid_action_fields", v, """{"type":"type","text":"a","ref":"@e1"}""")
        rejects("invalid_action_fields", v, """{"type":"scroll","direction":"up","snapshot_id":"ph-1"}""")
        rejects("invalid_action_fields", v, """{"type":"back","extra":1}""")
        rejects("invalid_action_fields", v, """{"type":"open_app"}""")
        rejects("invalid_ref", v, """{"type":"tap","ref":"@e0","snapshot_id":"ph-1"}""")
        rejects("invalid_ref", v, """{"type":"tap","ref":"@e12345","snapshot_id":"ph-1"}""")
        rejects("invalid_ref", v, """{"type":"tap","ref":3,"snapshot_id":"ph-1"}""")
        rejects("invalid_snapshot_id", v, """{"type":"tap","ref":"@e1","snapshot_id":"snap-1"}""")
        rejects("invalid_snapshot_id", v, """{"type":"tap","ref":"@e1","snapshot_id":"ph-${"x".repeat(62)}"}""")
        rejects("invalid_coordinate", v, """{"type":"tap","x":1.5,"y":0}""")
        rejects("invalid_coordinate", v, """{"type":"swipe","x":0,"y":0,"to_x":"0.5","to_y":0}""")
        rejects("invalid_input", v, """{"type":"type","text":"${"a".repeat(4001)}"}""")
        rejects("invalid_direction", v, """{"type":"scroll","direction":"forward"}""")
        rejects("invalid_package", v, """{"type":"open_app","package":"not a package"}""")
        rejects("invalid_package", v, """{"type":"open_app","package":"single"}""")
        rejects("invalid_reason", v, """{"type":"hand_to_user","reason":"   "}""")
        rejects("invalid_reason", v, """{"type":"hand_to_user","reason":"${"r".repeat(501)}"}""")
    }

    @Test fun mainTierKeepsTheLegacyActionSet() {
        assertEquals(PhoneAction.TapPoint(0.5, 0.4), main("""{"type":"tap","x":0.5,"y":0.4}"""))
        assertEquals(PhoneAction.Type("hello", null, null), main("""{"type":"type","text":"hello"}"""))
        assertEquals(PhoneAction.Back, main("""{"type":"back"}"""))
        val m = PhoneTier.MAIN
        for (type in listOf("scroll", "open_app", "hand_to_user", "launch", "home")) rejects("unsupported_action", m, """{"type":"$type"}""")
        rejects("invalid_action_fields", m, """{"type":"tap","ref":"@e1","snapshot_id":"ph-1"}""")
        rejects("invalid_action_fields", m, """{"type":"type","text":"a","ref":"@e1","snapshot_id":"ph-1"}""")
        rejects("invalid_coordinate", m, """{"type":"tap","x":true,"y":0}""")
        rejects("invalid_input", m, """{"type":"type","text":5}""")
    }

    @Test fun decisionsCarryTheirTierAndParsedAction() {
        val decision = ToolDecision.parse(JSONObject("""{"kind":"action","summary":"Open","action":{"type":"open_app","package":"com.example.app"}}"""), PhoneTier.VIRTUAL)
        assertEquals(PhoneTier.VIRTUAL, decision.tier)
        assertEquals(PhoneAction.OpenApp("com.example.app"), decision.phoneAction)
        try { ToolDecision.parse(JSONObject("""{"kind":"action","summary":"Open","action":{"type":"open_app","package":"com.example.app"}}""")); fail() }
        catch (error: IllegalArgumentException) { assertEquals("unsupported_action", error.message) }
    }
}
