package com.nova.nova_mobile

import org.junit.Assert.*
import org.junit.Test
import org.json.JSONObject

class ArtifactWebContractTest {
    @Test fun htmlBudgetCountsUtf8AndScriptBudgetIsBounded() {
        assertTrue(ArtifactWebContract.validHtml("<p>你好</p>"))
        assertFalse(ArtifactWebContract.validHtml(""))
        assertFalse(ArtifactWebContract.validHtml("你".repeat(90000)))
        assertTrue(ArtifactWebContract.validScript("return {ok:true};"))
        assertFalse(ArtifactWebContract.validScript("x".repeat(8001)))
    }

    @Test fun sandboxPolicyPrecedesGeneratedScriptsAndForbidsExternalResources() {
        val source = ArtifactWebContract.document("<script>window.marker=1</script>")
        assertTrue(source.indexOf("Content-Security-Policy") < source.indexOf("window.marker"))
        for (directive in listOf("connect-src 'none'", "frame-src 'none'", "worker-src 'none'", "object-src 'none'", "form-action 'none'", "base-uri 'none'")) {
            assertTrue(source.contains(directive))
        }
        assertTrue(source.indexOf("__novaPreviewErrors") < source.indexOf("window.marker"))
        assertFalse(ArtifactWebContract.permitsNavigation("https://example.com"))
        assertFalse(ArtifactWebContract.permitsNavigation("file:///data/private"))
        assertFalse(ArtifactWebContract.permitsNavigation("javascript:alert(1)"))
        assertFalse(ArtifactWebContract.permitsNavigation("intent://app"))
        assertFalse(ArtifactWebContract.permitsNavigation("about:srcdoc"))
        assertFalse(ArtifactWebContract.permitsNavigation("about:blank"))
        assertTrue(ArtifactWebContract.permitsNavigation("about:blank#local"))
        assertTrue(ArtifactWebContract.permitsNavigation("https://fixture.invalid/index.html#local", "https://fixture.invalid/index.html"))
        assertFalse(ArtifactWebContract.permitsNavigation("https://fixture.invalid/index.html", "https://fixture.invalid/index.html"))
        assertTrue(ArtifactWebContract.document("<p>ready</p>", "test-token").contains("value:\"test-token\""))
    }

    @Test fun javascriptCallbackDoubleEncodingMatchesMethodChannelJsonValues() {
        val json = """{"loaded":true,"title":"你好","errors":[],"result":{"ok":true,"count":2,"items":[null,"x"]}}"""
        val result = ArtifactWebContract.decodeResult(JSONObject.quote(json))
        assertEquals(true, result["loaded"])
        assertEquals("你好", result["title"])
        val checks = result["result"] as Map<*, *>
        assertEquals(true, checks["ok"])
        assertEquals(2, checks["count"])
        assertEquals(listOf(null, "x"), checks["items"])
    }

    @Test fun malformedOversizedOrDeepResultsProduceSanitizedFailure() {
        for (raw in listOf("null", "{}", "[".repeat(10000), JSONObject.quote("not json"), JSONObject.quote("""{"loaded":"yes","errors":[]}"""))) {
            assertEquals(listOf("invalid_test_result"), ArtifactWebContract.decodeResult(raw)["errors"])
        }
        val huge = JSONObject.quote("""{"loaded":true,"errors":[],"result":"${"a".repeat(32768)}"}""")
        assertEquals(listOf("invalid_test_result"), ArtifactWebContract.decodeResult(huge)["errors"])
        val nested = "[".repeat(40) + "0" + "]".repeat(40)
        assertEquals(listOf("invalid_test_result"), ArtifactWebContract.decodeResult(JSONObject.quote("""{"loaded":true,"errors":[],"result":$nested}"""))["errors"])
    }

    @Test fun scriptIsAFunctionBodyAndErrorsStayBounded() {
        val script = ArtifactWebContract.inspectionScript("return {found: !!document.querySelector('#game')};")
        assertTrue(script.contains("new Function(" + JSONObject.quote("return {found: !!document.querySelector('#game')};")))
        assertTrue(script.contains("async_test_script_unsupported"))
        assertTrue(script.contains("JSON.stringify"))
        assertTrue(script.contains("slice(0,500)"))
    }
}
