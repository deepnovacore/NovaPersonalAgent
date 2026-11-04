package com.nova.nova_mobile

import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

class LocalGuiModelTest {
    @Test fun officialDeepSeekFlashDisablesThinkingForForcedToolCalls() {
        val task = JSONObject().put("goal", "Search").put("acceptance", "Results visible")
        val screen = JSONObject().put("image", "YWJj").put("package", "test.app").put("tree", "Search").put("width", 100).put("height", 200)
        val body = LocalGuiModel.requestBody("deepseek-flash", task, screen, 0, endpoint = "https://api.deepseek.com/v1/chat/completions")
        assertEquals("disabled", body.getJSONObject("thinking").getString("type"))
        assertEquals("next_step", body.getJSONObject("tool_choice").getJSONObject("function").getString("name"))
        assertEquals("image_url", body.getJSONArray("messages").getJSONObject(1).getJSONArray("content").getJSONObject(1).getString("type"))
    }
    @Test fun deepSeekProviderOptionDoesNotLeakIntoOtherProvidersOrProtocols() {
        val task = JSONObject().put("goal", "Search").put("acceptance", "Results visible")
        val screen = JSONObject().put("image", "YWJj").put("package", "test.app").put("tree", "Search").put("width", 100).put("height", 200)
        for(endpoint in listOf("", "https://api.deepseek.com.example.com/v1", "https://example.com/v1")) {
            assertFalse(LocalGuiModel.requestBody("deepseek-flash", task, screen, 0, endpoint = endpoint).has("thinking"))
        }
        assertFalse(LocalGuiModel.requestBody("qwen3-vl-plus", task, screen, 0, endpoint = "https://api.deepseek.com/v1").has("thinking"))
        assertFalse(LocalGuiModel.requestBody("deepseek-flash", task, screen, 0, "responses", endpoint = "https://api.deepseek.com/v1").has("thinking"))
    }
    @Test fun startedTaskAuthorizesStepsWithoutAskingForApproval() {
        val task = JSONObject().put("goal", "Toggle twice").put("acceptance", "Count is 2")
        val screen = JSONObject().put("image", "YWJj").put("package", "test.app").put("tree", "Counter 0").put("width", 100).put("height", 200)
        for (protocol in listOf("chatCompletions", "responses", "chatgptResponses")) {
            val body = LocalGuiModel.requestBody("m", task, screen, 0, protocol)
            val messages = body.getJSONArray(if (protocol == "chatCompletions") "messages" else "input")
            val instructions = messages.getJSONObject(0).getString("content")
            assertTrue(instructions.contains("automatically authorized"))
            assertFalse(instructions.contains("every action needs user approval"))
            assertTrue(instructions.contains("leave the selected app"))
        }
    }

    @Test fun responsesPreservesScreenAndExplicitToolContract() {
        val task = JSONObject().put("goal", "Toggle once").put("acceptance", "Count is 1")
        val screen = JSONObject().put("image","YWJj").put("package","test.app").put("tree","Counter 0").put("width",100).put("height",200)
        val body = LocalGuiModel.requestBody("m", task, screen, 0, "responses")
        assertFalse(body.getBoolean("store"))
        assertFalse(body.has("messages"))
        assertEquals("input_image",body.getJSONArray("input").getJSONObject(1).getJSONArray("content").getJSONObject(1).getString("type"))
        assertEquals("next_step",body.getJSONObject("tool_choice").getString("name"))
        assertEquals("https://example.com/v1/responses",ModelConfiguration("https://example.com/v1","m","k","responses").requestEndpoint)
        val response = JSONObject().put("status","completed").put("output",org.json.JSONArray().put(JSONObject().put("type","function_call").put("name","next_step").put("arguments","{\"kind\":\"wait\",\"summary\":\"need input\"}")))
        LocalGuiModel.parseResponse(response,"responses")
        response.put("status","incomplete")
        try { LocalGuiModel.parseResponse(response,"responses"); fail("incomplete accepted") } catch(_: IllegalArgumentException) { }
    }

    private fun virtualScreen() = JSONObject().put("snapshot_id", "ph-1").put("tier", "virtual").put("package", "test.app")
        .put("width", 1080).put("height", 2400).put("image", "YWJj").put("changed_during_read", false).put("secure_frame", true)
        .put("elements", org.json.JSONArray().put(JSONObject().put("ref", "@e1").put("role", "Button").put("name", "Search")))
    @Test fun virtualTierPromptsWithRefsSnapshotAndHandToUser() {
        val task = JSONObject().put("goal", "Search").put("acceptance", "Results visible").put("target_package", "test.app")
        for (protocol in listOf("chatCompletions", "responses", "chatgptResponses")) {
            val body = LocalGuiModel.requestBody("m", task, virtualScreen(), 2, protocol, tier = com.nova.nova_mobile.phone.PhoneTier.VIRTUAL)
            val messages = body.getJSONArray(if (protocol == "chatCompletions") "messages" else "input")
            val instructions = messages.getJSONObject(0).getString("content")
            assertTrue(instructions.contains("only after the user taps Take over"))
            assertTrue(instructions.contains("snapshot_id") && instructions.contains("hand_to_user(reason)") && instructions.contains("automatically authorized"))
            assertTrue(instructions.contains("changed_during_read is true") && instructions.contains("belong to the selected app"))
            assertTrue(instructions.contains("secure_frame true") && instructions.contains("only submit does"))
            val part = messages.getJSONObject(1).getJSONArray("content").getJSONObject(0)
            val context = JSONObject(part.getString("text"))
            assertEquals("ph-1", context.getString("snapshot_id"))
            assertEquals("test.app", context.getString("target_package"))
            assertEquals("@e1", context.getJSONArray("untrusted_elements").getJSONObject(0).getString("ref"))
            assertTrue(context.getBoolean("secure_frame"))
            assertFalse(context.has("untrusted_screen_tree"))
        }
        val schema = LocalGuiModel.requestBody("m", task, virtualScreen(), 0, tier = com.nova.nova_mobile.phone.PhoneTier.VIRTUAL)
            .getJSONArray("tools").getJSONObject(0).getJSONObject("function").getJSONObject("parameters")
            .getJSONObject("properties").getJSONObject("action").getJSONObject("properties")
        val types = schema.getJSONObject("type").getJSONArray("enum").let { a -> (0 until a.length()).map { a.getString(it) }.toSet() }
        assertEquals(setOf("tap", "type", "scroll", "swipe", "open_app", "back", "submit", "hand_to_user"), types)
        for (key in listOf("ref", "snapshot_id", "direction", "package", "reason")) assertTrue(schema.has(key))
    }
    @Test fun mainTierPromptIsUnchangedByTheVirtualTier() {
        val task = JSONObject().put("goal", "Search").put("acceptance", "Results visible")
        val screen = JSONObject().put("image", "YWJj").put("package", "test.app").put("tree", "Search").put("width", 100).put("height", 200)
        val body = LocalGuiModel.requestBody("m", task, screen, 0)
        val types = body.getJSONArray("tools").getJSONObject(0).getJSONObject("function").getJSONObject("parameters")
            .getJSONObject("properties").getJSONObject("action").getJSONObject("properties").getJSONObject("type").getJSONArray("enum")
        assertEquals(listOf("tap", "swipe", "type", "back"), (0 until types.length()).map { types.getString(it) })
        assertTrue(body.getJSONArray("messages").getJSONObject(0).getString("content").contains("Never tap the floating Nova stop control"))
    }
    @Test fun virtualResponsesParseTheVirtualActionSet() {
        val call = """{"type":"function","function":{"name":"next_step","arguments":"{\"kind\":\"action\",\"summary\":\"Login\",\"action\":{\"type\":\"hand_to_user\",\"reason\":\"Login required\"}}"}}"""
        val value = JSONObject("""{"choices":[{"message":{"tool_calls":[$call]}}]}""")
        val decision = LocalGuiModel.parseResponse(value, tier = com.nova.nova_mobile.phone.PhoneTier.VIRTUAL)
        assertEquals(com.nova.nova_mobile.phone.PhoneAction.HandToUser("Login required"), decision.phoneAction)
        try { LocalGuiModel.parseResponse(value); fail("virtual action accepted on main") } catch(_: IllegalArgumentException) { }
    }
    @Test fun plainTextCannotBecomeAnExecutableAction() {
        val value = JSONObject("""{"choices":[{"message":{"content":"tap(10,20)"}}]}""")
        try { LocalGuiModel.parseResponse(value); fail("free text was executed") } catch(_: Exception) { }
    }
    @Test fun twoToolCallsCannotBeSilentlyCollapsedIntoOneWrite() {
        val call = """{"type":"function","function":{"name":"next_step","arguments":"{\"kind\":\"complete\",\"summary\":\"done\"}"}}"""
        val value = JSONObject("""{"choices":[{"message":{"tool_calls":[$call,$call]}}]}""")
        try { LocalGuiModel.parseResponse(value); fail("multiple calls accepted") } catch(_: IllegalArgumentException) { }
    }
    @Test fun endpointsCannotLeakCredentialsViaInsecureOrRedirectedUrlComponents() {
        for(url in listOf("http://example.com/v1", "https://user:pass@example.com/v1", "https://example.com/v1?key=x", "https://example.com/v1#x")) {
            try { ModelConfiguration(url,"model","secret"); fail("invalid endpoint accepted") } catch(_: IllegalArgumentException) { }
        }
    }
    @Test fun requestBindsCurrentScreenAndGoalButNeverIncludesCredentialInBody() {
        val task = JSONObject().put("goal", "Toggle once").put("acceptance", "Count is 1")
        val screen = JSONObject().put("image","YWJj").put("package","test.app").put("tree","Counter 0").put("width",100).put("height",200)
        val request = LocalGuiModel.requestBody("vision-model",task,screen,0)
        assertEquals("vision-model",request.getString("model"))
        assertEquals("next_step",request.getJSONObject("tool_choice").getJSONObject("function").getString("name"))
        val coordinates = request.getJSONArray("tools").getJSONObject(0).getJSONObject("function")
            .getJSONObject("parameters").getJSONObject("properties").getJSONObject("action").getJSONObject("properties")
        for (name in listOf("x", "y", "to_x", "to_y")) {
            assertEquals(0.0, coordinates.getJSONObject(name).getDouble("minimum"), 0.0)
            assertEquals(1.0, coordinates.getJSONObject(name).getDouble("maximum"), 0.0)
        }
        val message = request.getJSONArray("messages").getJSONObject(1).getJSONArray("content")
        assertTrue(message.getJSONObject(0).getString("text").contains("Toggle once"))
        assertEquals("data:image/jpeg;base64,YWJj",message.getJSONObject(1).getJSONObject("image_url").getString("url"))
        assertFalse(request.toString().contains("Authorization"))
    }
}
