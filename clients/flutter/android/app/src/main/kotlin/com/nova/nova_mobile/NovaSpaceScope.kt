package com.nova.nova_mobile

import android.content.Context
import io.flutter.plugin.common.BinaryMessenger
import io.flutter.plugin.common.MethodChannel
import java.io.File

/** Selection is installed before any native planner or mutable workspace exists. */
internal object NovaSpaceScope {
    private val state = NativeSpaceSelection()
    fun standalone(): NativeSpaceSelection.Selection = state.standalone()
    fun isCurrent(scope: NativeSpaceSelection.Selection): Boolean = state.isCurrent(scope)
    fun select(id: String, mode: String) { state.select(id, mode) }
    fun install(messenger: BinaryMessenger) {
        MethodChannel(messenger, "nova/space_scope").setMethodCallHandler { call, reply ->
            if (call.method != "setSpaceScope") { reply.notImplemented(); return@setMethodCallHandler }
            try {
                val args = call.arguments as? Map<*, *> ?: error("invalid_space_scope")
                val id = args["spaceId"] as? String ?: error("invalid_space_scope")
                val mode = args["mode"] as? String ?: error("invalid_space_scope")
                select(id, mode)
                reply.success(null)
            } catch (_: Exception) { reply.error("space_scope_unavailable", "Could not switch the native Space safely.", null) }
        }
    }
    fun listen(owner: Any, listener: () -> Unit) { state.listen(owner, listener) }
    fun removeListener(owner: Any) { state.removeListener(owner) }
    fun privateDirectory(context: Context, id: String): File = NativeSpaceSelection.directory(context.noBackupFilesDir, id)
        .also { check(it.isDirectory || it.mkdirs()) }
    fun workspace(context: Context, id: String): File = File(NativeSpaceSelection.directory(context.filesDir, id), "nova-workspace")
}
