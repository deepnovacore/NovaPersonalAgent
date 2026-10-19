package com.nova.nova_mobile

import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.runner.AndroidJUnit4
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import io.flutter.plugin.common.BinaryMessenger
import io.flutter.plugin.common.MethodCall
import io.flutter.plugin.common.StandardMethodCodec
import java.io.File
import java.nio.ByteBuffer
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.Executors

/** Executes the installed APK's actual PRoot + Alpine, including APK ELF loaders. */
@RunWith(AndroidJUnit4::class)
class LinuxWorkspaceDeviceTest {
    private class Messenger : BinaryMessenger {
        lateinit var handler: BinaryMessenger.BinaryMessageHandler
        override fun send(channel: String, message: ByteBuffer?) {}
        override fun send(channel: String, message: ByteBuffer?, callback: BinaryMessenger.BinaryReply?) {}
        override fun setMessageHandler(channel: String, handler: BinaryMessenger.BinaryMessageHandler?) { if (handler != null) this.handler = handler }
        fun invoke(method: String, args: Map<String, Any>): Map<*, *> {
            val latch = CountDownLatch(1)
            var result: Map<*, *>? = null
            var error: Throwable? = null
            val codec = StandardMethodCodec.INSTANCE
            val message = codec.encodeMethodCall(MethodCall(method, args)); message.flip()
            handler.onMessage(message) { reply ->
                try { reply!!.flip(); result = codec.decodeEnvelope(reply) as Map<*, *> }
                catch (failure: Throwable) { error = failure }
                finally { latch.countDown() }
            }
            check(latch.await(90, TimeUnit.SECONDS)) { "native_channel_timeout:$method" }
            error?.let { throw it }
            return result!!
        }
    }
    @Test fun apkDynamicLibrariesLoad() {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val messenger = Messenger()
        val host = LinuxWorkspaceHost(context, messenger)
        try {
            messenger.invoke("initialize", mapOf("root_path" to File(context.filesDir, "nova-workspace").path))
            val native = context.applicationInfo.nativeLibraryDir
            val runtime = File(context.noBackupFilesDir, "nova-linux")
            val trace = File(context.filesDir, "apk-debug.log")
            val builder = ProcessBuilder("$native/libproot.so", "-v", "9", "--kill-on-exit", "--link2symlink", "-0", "-r", File(runtime, "rootfs").path,
                "-b", "/dev", "-b", "/proc", "-b", "/sys", "-w", "/", "/bin/sh", "-c",
                InstrumentationRegistry.getArguments().getString("nova_apk_command") ?: "/sbin/apk --version")
                .redirectErrorStream(true).redirectOutput(trace)
            builder.environment().apply {
                clear(); put("PATH", "/usr/bin:/bin:/usr/sbin:/sbin"); put("HOME", "/root")
                put("PROOT_LOADER", "$native/libproot-loader.so"); put("PROOT_TMP_DIR", File(runtime, "proot-tmp").path)
                if (InstrumentationRegistry.getArguments().getString("nova_trace_all") == "true") {
                    put("PROOT_NO_SECCOMP", "1"); put("PROOT_ASSUME_NEW_SECCOMP", "1")
                }
            }
            val process = builder.start()
            if (!process.waitFor(45, TimeUnit.SECONDS)) { process.destroy(); fail("apk command timed out; inspect files/apk-debug.log") }
            val exit = process.exitValue()
            assertEquals(trace.readText().takeLast(2000), 0, exit)
        } finally { host.dispose() }
    }

    @Test fun dnsRefreshCannotFollowGuestSymlinks() {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val base = File(context.filesDir, "dns-${System.nanoTime()}").also { it.mkdirs() }
        val etc = File(base, "etc").also { it.mkdirs() }
        val outside = File(context.filesDir, "dns-outside-${System.nanoTime()}").also { it.mkdirs() }
        val sentinel = File(outside, "protected").also { it.writeText("protected") }
        val resolv = File(etc, "resolv.conf")
        android.system.Os.symlink(sentinel.path, resolv.path)
        try {
            AndroidWorkspaceFiles.replaceDns(base, "nameserver 1.1.1.1\n")
            assertEquals("protected", sentinel.readText())
            assertEquals("nameserver 1.1.1.1\n", resolv.readText())
            resolv.delete(); etc.delete()
            android.system.Os.symlink(outside.path, etc.path)
            try { AndroidWorkspaceFiles.replaceDns(base, "unsafe"); fail("followed etc symlink") }
            catch (_: android.system.ErrnoException) { }
            assertFalse(File(outside, "resolv.conf").exists())
            assertEquals("protected", sentinel.readText())
        } finally {
            if (android.system.OsConstants.S_ISLNK(android.system.Os.lstat(etc.path).st_mode)) android.system.Os.remove(etc.path)
            base.deleteRecursively(); outside.deleteRecursively()
        }
    }

    @Test fun logsRejectSymlinkDirectory() {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val base = File(context.filesDir, "log-link-${System.nanoTime()}").also { it.mkdirs() }
        val outside = File(context.filesDir, "outside-${System.nanoTime()}").also { it.mkdirs() }
        val link = File(base, ".nova")
        android.system.Os.symlink(outside.path, link.path)
        try {
            try { AndroidWorkspaceFiles.openLogs(base, "denied"); fail("followed guest symlink") }
            catch (_: android.system.ErrnoException) { }
            assertTrue(outside.listFiles()!!.isEmpty())
        } finally { android.system.Os.remove(link.path); base.delete(); outside.delete() }
    }

    @Test fun logDescriptorsSurviveGuestPathReplacement() {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val base = File(context.filesDir, "log-swap-${System.nanoTime()}").also { it.mkdirs() }
        val outside = File(context.filesDir, "outside-${System.nanoTime()}").also { it.mkdirs() }
        val sentinel = File(outside, "stdout.log").also { it.writeText("protected") }
        val logs = AndroidWorkspaceFiles.openLogs(base, "swap")
        val original = File(base, ".nova/logs/swap")
        val moved = File(base, ".nova/logs/moved")
        assertTrue(original.renameTo(moved))
        android.system.Os.symlink(outside.path, original.path)
        try {
            logs.stdout.write("captured".toByteArray())
            logs.stdout.flush()
            assertEquals("captured", File(moved, "stdout.log").readText())
            logs.finish(true)
            assertEquals("protected", sentinel.readText())
            assertFalse(File(outside, "stderr.log").exists())
        } finally {
            if (java.nio.file.Files.exists(original.toPath(), java.nio.file.LinkOption.NOFOLLOW_LINKS)) android.system.Os.remove(original.path)
            base.deleteRecursively(); outside.deleteRecursively()
        }
    }

    @Test fun guestCommandsAndCancellation() {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val messenger = Messenger()
        val host = LinuxWorkspaceHost(context, messenger)
        val workspace = File(context.filesDir, "nova-workspace")
        workspace.mkdirs()
        File(workspace, ".nova/logs").deleteRecursively()
        fun execute(id: String, command: String, timeout: Int = 15000, cwd: String = "/workspace") = messenger.invoke("execute", mapOf("id" to id, "command" to command, "timeout_ms" to timeout, "cwd" to cwd))
        try {
            try {
                messenger.invoke("initialize", mapOf("root_path" to File(context.filesDir, "other/nova-workspace").path))
                fail("accepted a different workspace root")
            } catch (expected: io.flutter.plugin.common.FlutterException) {
                assertEquals("invalid_workspace_root", expected.message)
            }
            assertEquals(true, messenger.invoke("initialize", mapOf("root_path" to workspace.path))["ready"])
            val normal = execute("normal", "mkdir -p sub; printf 'one\\ntwo\\n' > sub/note; cat sub/note | wc -l; printf issue >&2; exit 7")
            assertEquals(normal.toString(), "completed", normal["status"])
            assertEquals(normal.toString(), 7, normal["exit_code"])
            assertEquals("2", (normal["stdout"] as String).trim())
            assertEquals("issue", normal["stderr"])
            assertEquals("one\ntwo\n", File(workspace, "sub/note").readText())
            val cwd = execute("cwd", "pwd; cat note", cwd = "/workspace/sub")
            assertEquals("/workspace/sub\none\ntwo\n", cwd["stdout"])
            assertEquals("timed_out", execute("timeout", "sleep 30 & wait", 100)["status"])
            val long = execute("long", "yes abc | head -c 200000")
            assertEquals(true, long["truncated"])
            assertEquals(200000L, File(workspace, ".nova/logs/long/stdout.log").length())
            val threads = Executors.newSingleThreadExecutor()
            try {
                val slow = threads.submit<Map<*, *>> { execute("cancel", "sleep 30 & wait") }
                var accepted = false
                repeat(100) {
                    if (!accepted) { accepted = messenger.invoke("cancel", mapOf("id" to "cancel"))["accepted"] == true; if (!accepted) Thread.sleep(10) }
                }
                assertTrue(accepted)
                assertEquals("cancelled", slow.get(10, TimeUnit.SECONDS)["status"])
                assertEquals("completed", execute("after-cancel", "printf alive")["status"])
                val second = Messenger()
                val otherHost = LinuxWorkspaceHost(context, second)
                try {
                    assertEquals(true, second.invoke("initialize", mapOf("root_path" to workspace.path))["ready"])
                    host.dispose()
                    val shared = second.invoke("execute", mapOf("id" to "shared-runtime", "command" to "cat sub/note"))
                    assertEquals("one\ntwo\n", shared["stdout"])
                } finally { otherHost.dispose() }
            } finally { threads.shutdownNow() }
        } finally { host.dispose() }
    }
}
