package com.nova.nova_mobile

import java.io.File

/** Pure selection policy, also exercised on the JVM without an Android device. */
internal class NativeSpaceSelection {
    data class Selection(val id: String, val mode: String)
    @Volatile private var selected: Selection? = null
    private val listeners = linkedMapOf<Any, () -> Unit>()
    fun standalone(): Selection = selected?.takeIf { it.mode == "standalone" } ?: error("local_runtime_unavailable")
    fun isCurrent(scope: Selection): Boolean = selected == scope && scope.mode == "standalone"
    fun select(id: String, mode: String) {
        require(validId(id) && mode in setOf("standalone", "client")) { "invalid_space_scope" }
        val next = Selection(id, mode)
        if (next != selected) { selected = next; synchronized(listeners) { listeners.values.toList() }.forEach { it() } }
    }
    fun listen(owner: Any, listener: () -> Unit) { synchronized(listeners) { listeners[owner] = listener } }
    fun removeListener(owner: Any) { synchronized(listeners) { listeners.remove(owner) } }
    companion object {
        fun validId(id: String): Boolean = id.matches(Regex("[A-Za-z0-9_-]{1,128}"))
        fun directory(root: File, id: String): File {
            require(validId(id)) { "invalid_space_scope" }
            return File(root, "spaces/$id")
        }
    }
}
