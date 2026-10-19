package com.nova.nova_mobile

import java.io.ByteArrayOutputStream
import java.io.File
import java.io.InputStream
import java.io.OutputStream
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicReference

internal data class ShellRequest(
    val id: String,
    val command: String,
    val cwd: String = "/workspace",
    val timeoutMs: Long = 120_000,
    val environment: Map<String, String> = emptyMap(),
) {
    init {
        require(id.matches(Regex("[A-Za-z0-9_-]{1,128}"))) { "invalid_execution_id" }
        require(command.isNotBlank() && command.toByteArray(Charsets.UTF_8).size <= 65536 && '\u0000' !in command) { "invalid_command" }
        require((cwd == "/workspace" || cwd.startsWith("/workspace/")) && ".." !in cwd.split('/') && '\u0000' !in cwd) { "invalid_cwd" }
        require(timeoutMs in 1..3_600_000) { "invalid_timeout" }
        require(environment.all { (key, value) -> key in setOf("NOVA_BROWSER_URL", "NOVA_BROWSER_TOKEN") && value.length <= 8192 && '\u0000' !in value }) { "invalid_environment" }
    }
}

internal data class ShellResult(
    val status: String,
    val stdout: String,
    val stderr: String,
    val exitCode: Int?,
    val truncated: Boolean,
    val logPath: String? = null,
) {
    fun toMap(): Map<String, Any?> = mapOf(
        "status" to status, "stdout" to stdout, "stderr" to stderr,
        "exit_code" to exitCode, "truncated" to truncated, "log_path" to logPath,
    )
}

internal class ShellLogs(
    val stdout: OutputStream,
    val stderr: OutputStream,
    val finish: (Boolean) -> Unit,
)

/** Process supervisor, independent of Android so race/stream behavior runs on the JVM. */
internal class LinuxExecution(
    val workspace: File,
    private val outputLimit: Int = 128 * 1024,
    private val launch: (ShellRequest) -> Process,
    private val terminate: (Process) -> Unit,
    private val finished: (Process) -> Unit = {},
    private val openLogs: (String) -> ShellLogs = { id ->
        // JVM harness; Android injects descriptor-relative, nofollow file access.
        val directory = File(workspace, ".nova/logs/$id")
        require(directory.canonicalPath == directory.absolutePath && directory.mkdirs()) { "unsafe_or_existing_log_directory" }
        val stdout = File(directory, "stdout.log").outputStream()
        val stderr = File(directory, "stderr.log").outputStream()
        ShellLogs(stdout, stderr) { remove ->
            stdout.close(); stderr.close()
            if (remove) { File(directory, "stdout.log").delete(); File(directory, "stderr.log").delete(); directory.delete() }
        }
    },
) {
    private class Run {
        var process: Process? = null
        var reason: String? = null
        var finished = false
        var started = false
    }
    private val active = ConcurrentHashMap<String, Run>()
    private val usedIds = ConcurrentHashMap.newKeySet<String>()

    fun cancel(id: String): Boolean {
        val run = active[id] ?: return false
        synchronized(run) {
            if (run.finished || run.reason != null) return false
            run.reason = "cancelled"
            run.process?.let { runCatching { terminate(it) } }
            return true
        }
    }

    fun cancelAll() { active.keys.forEach(::cancel) }

    fun reserve(id: String) {
        require(usedIds.add(id)) { "execution_id_already_used" }
        active[id] = Run()
    }

    fun execute(request: ShellRequest, reserved: Boolean = false): ShellResult {
        if (!reserved) reserve(request.id)
        val run = active[request.id] ?: error("execution_not_reserved")
        synchronized(run) {
            check(!run.started) { "execution_already_started" }
            run.started = true
        }
        var process: Process? = null
        var logs: ShellLogs? = null
        try {
            synchronized(run) {
                if (run.reason != null) return ShellResult(run.reason!!, "", "", null, false)
            }
            val opened = openLogs(request.id)
            logs = opened
            process = launch(request)
            val stdout = Capture(process.inputStream, opened.stdout, outputLimit)
            val stderr = Capture(process.errorStream, opened.stderr, outputLimit)
            stdout.start(); stderr.start()
            // No interactive stdin: a command waiting for input receives EOF.
            process.outputStream.close()
            synchronized(run) {
                run.process = process
                if (run.reason != null) terminate(process)
            }
            val deadline = System.nanoTime() + request.timeoutMs * 1_000_000
            var exit: Int? = null
            var killDeadline: Long? = null
            while (exit == null) {
                exit = runCatching { process.exitValue() }.getOrNull()
                if (exit != null) break
                synchronized(run) {
                    if (run.reason == null && System.nanoTime() >= deadline) {
                        run.reason = "timed_out"
                        runCatching { terminate(process) }
                    }
                    if (run.reason != null && killDeadline == null) killDeadline = System.nanoTime() + 3_000_000_000
                }
                if (killDeadline?.let { System.nanoTime() >= it } == true) break
                Thread.sleep(10)
            }
            synchronized(run) { run.finished = true }
            // PRoot --kill-on-exit stops descendants; never wait indefinitely on inherited pipes.
            stdout.join(3000); stderr.join(3000)
            val drained = !stdout.isAlive && !stderr.isAlive
            if (!drained) { runCatching { terminate(process) }; runCatching { process.inputStream.close() }; runCatching { process.errorStream.close() } }
            val complete = exit != null && drained && (run.reason != null || (stdout.failure.get() == null && stderr.failure.get() == null))
            val truncated = stdout.truncated || stderr.truncated
            val result = ShellResult(
                if (!complete) "outcome_unknown" else run.reason ?: "completed",
                stdout.text(), stderr.text(), exit, truncated,
                if (truncated || !complete) "/workspace/.nova/logs/${request.id}" else null,
            )
            opened.finish(!truncated && complete)
            logs = null
            return result
        } catch (error: Exception) {
            process?.let { runCatching { terminate(it) } }
            return ShellResult("outcome_unknown", "", error.message ?: "shell_execution_failed", null, false)
        } finally {
            synchronized(run) { run.finished = true }
            active.remove(request.id, run)
            logs?.let { runCatching { it.finish(false) } }
            process?.let(finished)
        }
    }

    private class Capture(private val stream: InputStream, private val log: OutputStream, private val limit: Int) : Thread("nova-shell-output") {
        private val preview = ByteArrayOutputStream()
        val failure = AtomicReference<Exception?>()
        @Volatile var truncated = false
        init { isDaemon = true }
        override fun run() {
            try {
                log.use { output ->
                    stream.use { input ->
                        val buffer = ByteArray(8192)
                        while (true) {
                            val count = input.read(buffer)
                            if (count < 0) break
                            output.write(buffer, 0, count)
                            synchronized(preview) {
                                val keep = minOf(count, limit - preview.size())
                                if (keep > 0) preview.write(buffer, 0, keep)
                                if (keep < count) truncated = true
                            }
                        }
                    }
                }
            } catch (error: Exception) { failure.set(error) }
        }
        fun text(): String = synchronized(preview) { preview.toString("UTF-8") }
    }
}
