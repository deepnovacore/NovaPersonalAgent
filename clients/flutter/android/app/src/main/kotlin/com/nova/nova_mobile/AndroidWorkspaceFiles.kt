package com.nova.nova_mobile

import android.os.ParcelFileDescriptor
import android.system.ErrnoException
import android.system.Os
import android.system.OsConstants
import java.io.File
import java.io.FileOutputStream

/** Pin each directory before following the next component; guest symlink swaps cannot redirect writes. */
internal object AndroidWorkspaceFiles {
    private fun directory(path: String): ParcelFileDescriptor {
        val fd = Os.open(path, OsConstants.O_RDONLY or OsConstants.O_NONBLOCK or OsConstants.O_NOFOLLOW or OsConstants.O_CLOEXEC, 0)
        return try {
            require(OsConstants.S_ISDIR(Os.fstat(fd).st_mode)) { "not_a_log_directory" }
            ParcelFileDescriptor.dup(fd)
        } finally { Os.close(fd) }
    }
    private fun path(parent: ParcelFileDescriptor, child: String) = "/proc/self/fd/${parent.fd}/$child"
    private fun descend(parent: ParcelFileDescriptor, name: String, exclusive: Boolean = false): ParcelFileDescriptor {
        val target = path(parent, name)
        try { Os.mkdir(target, 448) } catch (error: ErrnoException) {
            if (exclusive || error.errno != OsConstants.EEXIST) throw error
        }
        return directory(target)
    }
    fun ensureDirectories(root: File, names: List<String>) {
        directory(root.path).use { parent ->
            names.forEach { descend(parent, it).close() }
        }
    }

    fun replaceDns(rootfs: File, content: String) {
        directory(rootfs.path).use { root ->
            descend(root, "etc").use { etc ->
                val temporary = path(etc, ".resolv-${java.util.UUID.randomUUID()}")
                try {
                    FileOutputStream(Os.open(temporary, OsConstants.O_WRONLY or OsConstants.O_CREAT or
                        OsConstants.O_EXCL or OsConstants.O_NOFOLLOW or OsConstants.O_CLOEXEC, 384)).use {
                        it.write(content.toByteArray(Charsets.UTF_8))
                    }
                    // Rename replaces the directory entry, never a guest symlink target.
                    Os.rename(temporary, path(etc, "resolv.conf"))
                } finally { runCatching { Os.remove(temporary) } }
            }
        }
    }

    fun openLogs(workspace: File, id: String): ShellLogs {
        val descriptors = mutableListOf<ParcelFileDescriptor>()
        val streams = mutableListOf<FileOutputStream>()
        try {
            val root = directory(workspace.path).also(descriptors::add)
            val nova = descend(root, ".nova").also(descriptors::add)
            val logs = descend(nova, "logs").also(descriptors::add)
            val run = descend(logs, id, exclusive = true).also(descriptors::add)
            fun output(name: String): FileOutputStream = FileOutputStream(Os.open(path(run, name),
                OsConstants.O_WRONLY or OsConstants.O_CREAT or OsConstants.O_EXCL or OsConstants.O_NOFOLLOW or OsConstants.O_CLOEXEC, 384)).also(streams::add)
            val stdout = output("stdout.log")
            val stderr = output("stderr.log")
            return ShellLogs(stdout, stderr) { remove ->
                streams.forEach { runCatching { it.close() } }
                if (remove) {
                    // unlink never follows a replaced symlink. Never recursively walk guest-owned paths.
                    listOf("stdout.log", "stderr.log").forEach { runCatching { Os.remove(path(run, it)) } }
                    runCatching { Os.remove(path(logs, id)) }
                }
                descriptors.asReversed().forEach { runCatching { it.close() } }
            }
        } catch (error: Exception) {
            streams.forEach { runCatching { it.close() } }
            descriptors.asReversed().forEach { runCatching { it.close() } }
            throw error
        }
    }
}
