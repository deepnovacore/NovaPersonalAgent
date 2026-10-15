package com.nova.nova_mobile

import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

class LocalGuiModelTest {
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
        val message = request.getJSONArray("messages").getJSONObject(1).getJSONArray("content")
        assertTrue(message.getJSONObject(0).getString("text").contains("Toggle once"))
        assertEquals("data:image/jpeg;base64,YWJj",message.getJSONObject(1).getJSONObject("image_url").getString("url"))
        assertFalse(request.toString().contains("Authorization"))
    }
}
