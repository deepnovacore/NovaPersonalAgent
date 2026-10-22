package com.nova.nova_mobile

import org.json.JSONArray
import org.json.JSONObject
import org.json.JSONTokener

/** Pure wire/sandbox rules; no Android, page bridge, storage, or credentials. */
internal object ArtifactWebContract {
    const val maxHtmlBytes = 256 * 1024
    const val maxScriptChars = 8000
    const val maxResultBytes = 32768
    const val timeoutMillis = 15000L
    const val settleMillis = 200L

    fun validHtml(html: String?) = html != null && html.isNotEmpty() &&
        html.length <= maxHtmlBytes && html.toByteArray(Charsets.UTF_8).size <= maxHtmlBytes
    fun validScript(script: String?) = script != null && script.length <= maxScriptChars

    // The host serves one exact synthetic HTTPS URL entirely from memory.
    // Native loadUrl bypasses navigation callbacks; only same-document fragment
    // links may navigate afterward. No external/file/content/intent navigation.
    fun permitsNavigation(url: String?, documentUrl: String = "about:blank") =
        url?.startsWith("$documentUrl#") == true

    const val contentPolicy = "default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval'; style-src 'unsafe-inline'; img-src data: blob:; media-src data: blob:; font-src data:; connect-src 'none'; frame-src 'none'; child-src 'none'; worker-src 'none'; object-src 'none'; form-action 'none'; base-uri 'none'"

    fun document(html: String, readyToken: String = "fixture"): String = """
        <!doctype html><meta charset="utf-8">
        <meta http-equiv="Content-Security-Policy" content="$contentPolicy">
        <script>
        Object.defineProperty(window,'__novaArtifactToken',{value:${JSONObject.quote(readyToken)}});
        window.__novaPreviewErrors=[];
        (()=>{const record=(value)=>{if(window.__novaPreviewErrors.length<20)window.__novaPreviewErrors.push(String(value).slice(0,500));};
        addEventListener('error',e=>record(e.message||'resource_error'));
        addEventListener('unhandledrejection',e=>record(e.reason));})();
        </script>
    """.trimIndent() + html

    fun inspectionScript(script: String): String = """
        (()=>{try{const result=(new Function(${JSONObject.quote(script)}))();
        if(result&&typeof result.then==='function')throw new Error('async_test_script_unsupported: use a synchronous function body');
        if(result===undefined||typeof result==='function'||typeof result==='symbol')throw new Error('invalid_test_result: return JSON-safe checks from a synchronous function body');
        return JSON.stringify({loaded:true,title:document.title,errors:window.__novaPreviewErrors||[],result});}
        catch(e){return JSON.stringify({loaded:true,errors:[...(window.__novaPreviewErrors||[]).slice(0,19),String(e).slice(0,500)]});}})()
    """.trimIndent()

    fun failure(code: String, loaded: Boolean = false): Map<String, Any?> =
        mapOf("loaded" to loaded, "errors" to listOf(code))

    /** evaluateJavascript returns a JSON-encoded JS string, hence two decodes. */
    fun decodeResult(raw: String?): Map<String, Any?> {
        try {
            require(raw != null && raw.length <= maxResultBytes * 6 + 2)
            require(raw.startsWith('"') && raw.endsWith('"'))
            val text = JSONTokener(raw).nextValue() as? String ?: error("invalid")
            require(text.toByteArray(Charsets.UTF_8).size <= maxResultBytes)
            // Bound parser recursion before org.json allocates nested containers.
            var depth = 0
            var quoted = false
            var escaped = false
            for (char in text) {
                if (quoted) {
                    if (escaped) escaped = false
                    else if (char == '\\') escaped = true
                    else if (char == '"') quoted = false
                } else when (char) {
                    '"' -> quoted = true
                    '{', '[' -> { depth++; require(depth <= 32) }
                    '}', ']' -> { depth--; require(depth >= 0) }
                }
            }
            require(depth == 0 && !quoted)
            val root = JSONObject(text)
            require(root.opt("loaded") is Boolean && root.opt("errors") is JSONArray)
            var nodes = 0
            fun convert(value: Any?, depth: Int): Any? {
                require(depth <= 32 && ++nodes <= 4096)
                return when (value) {
                    null, JSONObject.NULL -> null
                    is JSONObject -> value.keys().asSequence().associateWith { convert(value.get(it), depth + 1) }
                    is JSONArray -> (0 until value.length()).map { convert(value.get(it), depth + 1) }
                    is String, is Boolean, is Int, is Long, is Double -> value
                    else -> error("invalid")
                }
            }
            @Suppress("UNCHECKED_CAST")
            return convert(root, 0) as Map<String, Any?>
        } catch (_: Exception) {
            return failure("invalid_test_result", loaded = true)
        }
    }
}
