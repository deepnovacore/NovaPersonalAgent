package com.nova.nova_mobile

import org.json.JSONObject

/**
 * Consecutive page visits only; refs and changing digits are not identities. One exception
 * spans a back: when a tap left its page and back restores that exact page, the immediate
 * re-tap of the same element is refused (tap, back, tap loops). Any other action lifts it.
 */
internal class TapGuard {
    data class Target(val identity: String, val location: String, val element: JSONObject, val page: String)
    private val tapped = mutableSetOf<String>()
    private var opened: Target? = null
    private var openedPage = ""
    private var backPending = false
    private var returned: String? = null
    private var pending: Target? = null

    fun target(action: JSONObject?, observation: JSONObject): Target? {
        if (action?.optString("type") != "tap") return null
        val element = if (action.has("ref")) {
            if (action.optString("snapshot_id") != observation.optString("snapshot_id")) return null
            elements(observation).firstOrNull { it.optString("ref") == action.optString("ref") }
        } else {
            val x = action.optDouble("x") * 999
            val y = action.optDouble("y") * 999
            elements(observation).filter { e ->
                val b = e.optJSONArray("bounds")
                e.optBoolean("clickable") && b != null && b.length() == 4 &&
                    x >= b.getInt(0) && x <= b.getInt(2) && y >= b.getInt(1) && y <= b.getInt(3)
            }.minByOrNull { e -> e.getJSONArray("bounds").let { (it.getInt(2) - it.getInt(0)).toLong() * (it.getInt(3) - it.getInt(1)) } }
        } ?: return null
        return Target(identity(element, observation), identity(element, observation, false), element, page(observation))
    }

    fun check(target: Target?) { require(target == null || (target.identity !in tapped && target.identity != returned)) { CODE } }

    fun dispatched(action: JSONObject, target: Target?) {
        returned = null
        val type = action.optString("type")
        if (type in setOf("back", "open_app")) tapped.clear()
        backPending = type == "back"
        if (type == "open_app") opened = null
        if (target == null) return
        tapped += target.identity
        pending = target
    }

    fun observe(observation: JSONObject) {
        val current = elements(observation).associateBy { identity(it, observation) }
        tapped.retainAll(current.keys)
        if (backPending) {
            backPending = false
            // A back that left the opened page anywhere else ends the candidate.
            val now = page(observation)
            opened?.let { if (it.page == now) returned = it.identity; if (now != openedPage) opened = null }
        }
        val before = pending ?: return
        pending = null
        val oldState = state(before.element)
        val newState = current.values.firstOrNull { identity(it, observation, false) == before.location }?.let(::state)
        if (newState == null) { opened = before; openedPage = page(observation) }
        observation.put("last_tap_effect", JSONObject().put("before", oldState)
            .put("after", newState ?: JSONObject.NULL)
            .put("changed", newState != null && oldState.toString() != newState.toString()))
    }

    private fun page(observation: JSONObject) =
        elements(observation).map { identity(it, observation) }.sorted().joinToString("\u001e")

    private fun identity(e: JSONObject, observation: JSONObject, includeLabel: Boolean = true): String {
        val b = e.getJSONArray("bounds")
        return listOf(e.optString("package", observation.optString("package")), e.optString("resource_id"),
            e.optString("class", e.optString("role")), if (includeLabel) e.optString("name").replace(Regex("\\d"), "") else "",
            (0 until b.length()).joinToString(",") { (b.getInt(it) / 50).toString() }).joinToString("\u001f")
    }

    companion object {
        const val CODE = "repeat_tap_same_element"
        const val REPAIR = "You already tapped this element on this page, or opened it and came back. Do not tap it again. Judge the current state from elements/screenshot; if you cannot verify, complete and say the state is unverified."
        private fun elements(o: JSONObject): List<JSONObject> = o.optJSONArray("elements")?.let { a ->
            (0 until a.length()).map { a.getJSONObject(it) }
        }.orEmpty()
        private fun state(e: JSONObject) = JSONObject().apply {
            for (key in listOf("name", "content_description", "checkable", "checked", "selected", "state_description"))
                if (e.has(key)) put(key, e.get(key))
        }
    }
}
