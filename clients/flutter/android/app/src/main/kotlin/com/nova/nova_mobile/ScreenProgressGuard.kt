package com.nova.nova_mobile

import java.security.MessageDigest
import org.json.JSONArray
import org.json.JSONObject

/** Per-run, bounded tree history. Images, snapshot ids, refs and focus never count as progress. */
internal class ScreenProgressGuard {
    data class Result(val note: String = "", val interrupt: Boolean = false)
    private data class Visit(val signature: String, val action: String?)
    private val visits = ArrayDeque<Visit>()
    private var stagnant = 0
    private var warned = false
    private var afterWarning = 0

    fun observe(observation: JSONObject, previousAction: String?): Result {
        if (observation.optBoolean("changed_during_read")) return Result()
        val elements = observation.optJSONArray("elements")
        val tree = if (elements != null && elements.length() > 0) canonical(elements)
            else observation.optString("tree").takeIf { it.isNotBlank() } ?: return Result()
        val signature = MessageDigest.getInstance("SHA-256")
            .digest((observation.optString("package") + "\n" + tree).toByteArray())
            .joinToString("") { "%02x".format(it) }
        val known = visits.any { it.signature == signature }
        if (!known) { stagnant = 0; warned = false; afterWarning = 0 } else stagnant++
        visits.addLast(Visit(signature, previousAction))
        if (visits.size > 12) visits.removeFirst()
        val recent = visits.toList().takeLast(8)
        val count = recent.count { it.signature == signature }
        val cycle = recent.dropWhile { it.signature != signature }.drop(1)
        val oscillating = count >= 3 && cycle.any { it.action == "back" } &&
            cycle.any { it.action == "tap" || it.action == "open_app" }
        if (warned && known && ++afterWarning >= 2) return Result(interrupt = true)
        if (oscillating || stagnant >= 6 || warned) {
            warned = true
            return Result("You have returned to this same screen $count times in the last 8 observations, with $stagnant consecutive observations without a new screen. Do not repeat the same approach or leave and re-enter to fix a dark screenshot. Choose a different approach, hand to the user, or finish with an explanation; verify any previous effects first.")
        }
        return Result()
    }

    private fun canonical(value: Any?): String = when (value) {
        is JSONObject -> value.keys().asSequence().filter { it !in setOf("ref", "bounds", "focused") }
            .sorted().joinToString(prefix = "{", postfix = "}") { JSONObject.quote(it) + ":" + canonical(value.get(it)) }
        is JSONArray -> (0 until value.length()).joinToString(prefix = "[", postfix = "]") { canonical(value.get(it)) }
        is String -> JSONObject.quote(value)
        else -> value?.toString() ?: "null"
    }
}
