package com.nova.nova_mobile

import java.io.File
import java.nio.file.Files

object NativeSpaceSelectionChecks {
    @JvmStatic fun main(args: Array<String>) {
        val state = NativeSpaceSelection()
        check(runCatching { state.standalone() }.isFailure)
        val owner = Any(); var changes = 0
        state.listen(owner) { changes++ }
        state.select("space-a", "standalone"); val a = state.standalone()
        state.select("space-a", "standalone"); check(changes == 1)
        state.select("space-b", "standalone"); check(!state.isCurrent(a))
        state.select("phone", "client"); check(runCatching { state.standalone() }.isFailure)
        check(runCatching { state.select("../space-a", "standalone") }.isFailure)
        check(runCatching { state.select("space-a", "host") }.isFailure)
        val root = Files.createTempDirectory("native-space-selection").toFile()
        try {
            val aDir = NativeSpaceSelection.directory(root, "space-a").also { it.mkdirs() }
            val bDir = NativeSpaceSelection.directory(root, "space-b").also { it.mkdirs() }
            File(aDir, "local-agent-v1.db").writeText("A-private-data")
            File(bDir, "local-agent-v1.db").writeText("B-private-data")
            check(File(aDir, "local-agent-v1.db").readText() == "A-private-data")
            check(File(bDir, "local-agent-v1.db").readText() == "B-private-data")
            check(runCatching { NativeSpaceSelection.directory(root, "../../outside") }.isFailure)
        } finally { root.deleteRecursively() }
        state.removeListener(owner)
        println("PASS production native Space policy: role gates, stale scope, idempotent selection, per-Space files and traversal rejection")
    }
}
