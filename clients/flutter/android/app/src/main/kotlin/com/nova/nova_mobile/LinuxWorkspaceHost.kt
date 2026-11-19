package com.nova.nova_mobile

import android.content.Context
import android.net.ConnectivityManager
import android.os.Handler
import android.os.Looper
import android.system.Os
import android.system.OsConstants
import io.flutter.plugin.common.BinaryMessenger
import io.flutter.plugin.common.MethodChannel
import java.io.File
import java.security.MessageDigest
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.Executors

/** The app UID remains the security boundary. PRoot provides Linux compatibility. */
internal class LinuxWorkspaceHost(context: Context, messenger: BinaryMessenger) {
    private val context = context.applicationContext
    private val channel = MethodChannel(messenger, "nova/workspace/v1")
    private val worker = Executors.newCachedThreadPool()
    private val main = Handler(Looper.getMainLooper())
    @Volatile private var runtime: LinuxRuntime? = null
    private val owned = ConcurrentHashMap.newKeySet<String>()
    @Volatile private var disposed = false

    init {
        NovaSpaceScope.listen(this) {
            val old = runtime
            owned.forEach { old?.cancel(it) }
            runtime = null
        }
        channel.setMethodCallHandler { call, result ->
            try {
                check(!disposed) { "workspace_host_disposed" }
                val args = call.arguments as? Map<*, *> ?: emptyMap<Any, Any>()
                when (call.method) {
                    "cancel" -> result.success(mapOf("accepted" to (runtime?.cancel(args["id"] as? String ?: "") ?: false)))
                    "initialize" -> {
                        val scope = NovaSpaceScope.standalone()
                        worker.execute {
                        try {
                            val selectedRuntime = LinuxRuntime.get(context, scope.id)
                            selectedRuntime.initialize(args["root_path"] as? String ?: error("missing_root_path"))
                            check(NovaSpaceScope.isCurrent(scope)) { "workspace_scope_changed" }
                            runtime = selectedRuntime
                            main.post { result.success(mapOf("ready" to true, "platform" to "android")) }
                        } catch (error: Exception) { main.post { result.error("workspace_error", error.message, null) } }
                    }
                    }
                    "execute" -> {
                        val scope = NovaSpaceScope.standalone()
                        val selectedRuntime = runtime ?: error("workspace_not_initialized")
                        check(selectedRuntime.spaceId == scope.id) { "workspace_scope_changed" }
                        val request = ShellRequest(
                            id = args["id"] as? String ?: error("missing_id"),
                            command = args["command"] as? String ?: error("missing_command"),
                            cwd = args["cwd"] as? String ?: "/workspace",
                            timeoutMs = (args["timeout_ms"] as? Number)?.toLong() ?: 120_000,
                            environment = (args["environment"] as? Map<*, *>)?.entries?.associate {
                                (it.key as? String ?: error("invalid_environment")) to (it.value as? String ?: error("invalid_environment"))
                            } ?: emptyMap(),
                        )
                        // Register synchronously: the next channel cancel cannot overtake this run.
                        val execution = selectedRuntime.execution ?: error("workspace_not_initialized")
                        execution.reserve(request.id)
                        owned.add(request.id)
                        worker.execute {
                            try {
                                val reply = execution.execute(request, reserved = true).toMap()
                                main.post { result.success(reply) }
                            } catch (error: Exception) { main.post { result.error("workspace_error", error.message, null) } }
                            finally { owned.remove(request.id) }
                        }
                    }
                    else -> result.notImplemented()
                }
            } catch (error: Exception) { result.error("workspace_error", error.message, null) }
        }
    }

    fun dispose() {
        disposed = true
        NovaSpaceScope.removeListener(this)
        channel.setMethodCallHandler(null)
        owned.forEach { runtime?.cancel(it) }
        worker.shutdown()
    }
}

/** One filesystem installer and supervisor for all foreground/headless engines. */
private class LinuxRuntime(private val context: Context, val spaceId: String) {
    companion object {
        private val instances = mutableMapOf<String, LinuxRuntime>()
        @Synchronized fun get(context: Context, spaceId: String): LinuxRuntime = instances.getOrPut(spaceId) { LinuxRuntime(context.applicationContext, spaceId) }
    }
    private val runtime = File(NovaSpaceScope.privateDirectory(context, spaceId), "nova-linux")
    private val rootfs = File(runtime, "rootfs")
    private val native = File(context.applicationInfo.nativeLibraryDir)
    private val processGroups = ConcurrentHashMap<Process, Int>()
    @Volatile var execution: LinuxExecution? = null
        private set
    fun cancel(id: String): Boolean = execution?.cancel(id) ?: false

    @Synchronized internal fun initialize(path: String) {
        val supplied = File(path)
        val expected = NovaSpaceScope.workspace(context, spaceId).absoluteFile
        require(supplied.isAbsolute && supplied.absoluteFile == expected) { "invalid_workspace_root" }
        val root = supplied.canonicalFile
        require(root == File(context.filesDir.canonicalFile, "spaces/$spaceId/nova-workspace")) { "workspace_outside_app_data" }
        execution?.let { require(it.workspace == root) { "workspace_root_changed" }; return }
        check(root.isDirectory || root.mkdirs()) { "workspace_create_failed" }
        listOf("libproot.so", "libproot-loader.so", "libnova-exec.so").forEach {
            check(File(native, it).canExecute()) { "missing_packaged_runtime:$it" }
        }
        installRootfs()
        AndroidWorkspaceFiles.ensureDirectories(rootfs, listOf("workspace", "tmp", "root", "dev", "proc", "sys"))
        refreshDns()
        execution = LinuxExecution(root, launch = { launch(it, root) }, terminate = ::terminate, finished = { processGroups.remove(it) }, openLogs = { AndroidWorkspaceFiles.openLogs(root, it) })
    }

    private fun installRootfs() {
        runtime.mkdirs()
        val expected = context.assets.open("nova-linux/rootfs.sha256").bufferedReader().use { it.readText().trim().substringBefore(' ') }
        val marker = File(rootfs, ".nova-rootfs-version")
        // Existing user-installed packages belong to the user. A future base-image
        // migration must be explicit; an app update never replaces this filesystem.
        if (marker.isFile && marker.readText().matches(Regex("[a-f0-9]{64}"))) return
        check(!rootfs.exists()) { "existing_rootfs_requires_recovery" }
        val archive = File(runtime, "rootfs.tgz")
        context.assets.open("nova-linux/rootfs.tgz").use { source -> archive.outputStream().use { source.copyTo(it) } }
        val digest = MessageDigest.getInstance("SHA-256")
        archive.inputStream().use { input ->
            val buffer = ByteArray(65536)
            while (true) { val count = input.read(buffer); if (count < 0) break; digest.update(buffer, 0, count) }
        }
        check(digest.digest().joinToString("") { "%02x".format(it) } == expected) { "rootfs_checksum_mismatch" }
        val staging = File(runtime, "rootfs-install-${java.util.UUID.randomUUID()}")
        check(staging.mkdir())
        val process = ProcessBuilder("/system/bin/toybox", "tar", "-xzf", archive.path, "-C", staging.path).redirectErrorStream(true).start()
        val output = process.inputStream.bufferedReader().use { it.readText() }
        check(process.waitFor() == 0) { "rootfs_extract_failed:$output" }
        check(File(staging, "bin/busybox").isFile) { "rootfs_incomplete" }
        File(staging, ".nova-rootfs-version").writeText(expected)
        // Publish only a first installation; never replace an existing filesystem.
        check(staging.renameTo(rootfs)) { "rootfs_install_failed" }
        archive.delete()
    }

    private fun refreshDns() {
        val connectivity = context.getSystemService(Context.CONNECTIVITY_SERVICE) as ConnectivityManager
        val servers = connectivity.activeNetwork?.let { connectivity.getLinkProperties(it)?.dnsServers }.orEmpty()
        val addresses = servers.mapNotNull { it.hostAddress }.filter { '%' !in it }
        AndroidWorkspaceFiles.replaceDns(rootfs, (addresses.ifEmpty { listOf("1.1.1.1", "8.8.8.8") }).joinToString("\n", postfix = "\n") { "nameserver $it" })
    }

    private fun launch(request: ShellRequest, root: File): Process {
        val pidFile = File(runtime, "run-${request.id}.pid")
        check(!pidFile.exists()) { "stale_execution_pid" }
        val command = listOf(
            File(native, "libnova-exec.so").path, pidFile.path,
            File(native, "libproot.so").path, "--kill-on-exit", "--link2symlink", "-0",
            "-r", rootfs.path, "-b", "/dev", "-b", "/proc", "-b", "/sys",
            "-b", "${root.path}:/workspace", "-w", request.cwd, "/bin/sh", "-c", request.command,
        )
        val builder = ProcessBuilder(command).directory(rootfs)
        builder.environment().apply {
            clear()
            put("PATH", "/workspace/.nova/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin")
            put("HOME", "/root"); put("TMPDIR", "/tmp"); put("LANG", "C.UTF-8")
            putAll(request.environment)
            // Host-owned launcher values cannot be overridden by a guest environment.
            put("PROOT_LOADER", File(native, "libproot-loader.so").path)
            put("PROOT_TMP_DIR", File(runtime, "proot-tmp").also { it.mkdirs() }.path)
            // Let PRoot detect syscall/seccomp ordering; forcing NO_SECCOMP
            // breaks ENOENT handling under Android app-inherited filters.
        }
        val process = builder.start()
        val deadline = System.nanoTime() + 2_000_000_000
        while (System.nanoTime() < deadline) {
            val pid = runCatching { pidFile.readText().trim().toInt() }.getOrNull()
            if (pid != null && pid > 1) { processGroups[process] = pid; pidFile.delete(); return process }
            if (runCatching { process.exitValue() }.isSuccess) break
            Thread.sleep(5)
        }
        process.destroy(); pidFile.delete()
        error("process_group_start_failed")
    }

    private fun terminate(process: Process) {
        val group = processGroups.remove(process)
        if (group != null) runCatching { Os.kill(-group, OsConstants.SIGKILL) }
        process.destroy()
    }

}
