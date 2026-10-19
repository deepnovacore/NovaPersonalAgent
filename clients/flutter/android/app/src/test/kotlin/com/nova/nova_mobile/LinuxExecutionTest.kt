package com.nova.nova_mobile

import org.junit.Assert.*
import org.junit.Test
import java.io.File
import java.nio.file.Files
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit

class LinuxExecutionTest {
    private fun runner(limit: Int = 64 * 1024): LinuxExecution = LinuxExecution(
        Files.createTempDirectory("nova-linux-test").toFile(), limit,
        { request -> ProcessBuilder("/bin/sh", "-c", request.command).start() },
        { process -> process.destroyForcibly(); Unit },
    )
    @Test fun capturesExitCodeAndSeparateStreams() {
        val result = runner().execute(ShellRequest("capture", "printf hello; printf problem >&2; exit 7"))
        assertEquals("completed", result.status)
        assertEquals("hello", result.stdout)
        assertEquals("problem", result.stderr)
        assertEquals(7, result.exitCode)
        assertFalse(result.truncated)
    }
    @Test fun truncationKeepsFullOutputLog() {
        val execution = runner(8)
        val result = execution.execute(ShellRequest("long", "printf 12345678901234567890"))
        assertTrue(result.truncated)
        assertEquals("12345678", result.stdout)
        assertNotNull(result.logPath)
        assertTrue(File(execution.workspace, ".nova/logs/long/stdout.log").readText().contains("12345678901234567890"))
    }
    @Test fun timeoutTerminatesCommand() {
        val result = runner().execute(ShellRequest("deadline", "exec sleep 10", timeoutMs = 50))
        assertEquals("timed_out", result.status)
    }
    @Test fun cancellationOnlyTargetsRequestedExecution() {
        val execution = runner()
        val worker = Executors.newFixedThreadPool(2)
        try {
            val slow = worker.submit<ShellResult> { execution.execute(ShellRequest("slow", "exec sleep 10")) }
            val deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(3)
            while (!execution.cancel("slow") && System.nanoTime() < deadline) Thread.yield()
            assertEquals("cancelled", slow.get(3, TimeUnit.SECONDS).status)
            assertEquals("completed", execution.execute(ShellRequest("fast", "printf fine")).status)
            assertFalse(execution.cancel("missing"))
        } finally { worker.shutdownNow() }
    }
    @Test fun refusesDuplicateExecutionIdsIncludingCompletedOnes() {
        val execution = runner()
        execution.execute(ShellRequest("same", "true"))
        assertThrows(IllegalArgumentException::class.java) { execution.execute(ShellRequest("same", "true")) }
    }
    @Test fun cancellationOfReservedWorkPreventsTheProcessStarting() {
        val execution = runner()
        execution.reserve("queued")
        assertTrue(execution.cancel("queued"))
        val result = execution.execute(ShellRequest("queued", "echo should-not-run"), reserved = true)
        assertEquals("cancelled", result.status)
        assertEquals("", result.stdout)
    }
    @Test fun validatesIdsCwdAndLimits() {
        assertThrows(IllegalArgumentException::class.java) { ShellRequest("../../outside", "true") }
        assertThrows(IllegalArgumentException::class.java) { ShellRequest("id", "true", cwd = "relative") }
        assertThrows(IllegalArgumentException::class.java) { ShellRequest("id", "true", cwd = "/workspace/../root") }
        assertThrows(IllegalArgumentException::class.java) { ShellRequest("id", "true", cwd = "/root") }
        assertThrows(IllegalArgumentException::class.java) { ShellRequest("id", "a".repeat(65537)) }
        assertThrows(IllegalArgumentException::class.java) { ShellRequest("id", "true", timeoutMs = 0) }
        assertThrows(IllegalArgumentException::class.java) { ShellRequest("id", "true", environment = mapOf("PATH" to "/evil")) }
    }
}
