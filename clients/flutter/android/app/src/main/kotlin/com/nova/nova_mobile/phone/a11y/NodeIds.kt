// Derived from Mika (https://github.com/wangzan101/Mika, Apache-2.0, commit 5f630d9),
// Copyright 2026 wangzan101. Modified by Nova: generic node type (JVM-testable), contract UiElement/SNAPSHOT_KEEP,
// ref resolution (AndroidScreen.resolve) as a pure function.
package com.nova.nova_mobile.phone.a11y

import com.nova.nova_mobile.phone.SNAPSHOT_ID_PREFIX
import com.nova.nova_mobile.phone.SNAPSHOT_KEEP
import com.nova.nova_mobile.phone.UiElement
import java.util.UUID

/** A phone snapshot id: the `ph-` prefix plus a random UUID. */
internal fun snapshotId(): String = SNAPSHOT_ID_PREFIX + UUID.randomUUID()

/** One snapshot element: [element] goes to the model, [locator] re-identifies it, [node] is acted on. */
internal class NodeEntry<N>(val element: UiElement, val locator: ElementLocator, val node: N)

internal class NodeSnapshot<N>(val id: String, val entries: List<NodeEntry<N>>) {
    val locators: List<ElementLocator> get() = entries.map { it.locator }
}

/**
 * Ref registry: every snapshot renumbers from `@e1`; only the last [keep] snapshots are known. Refs of the newest
 * snapshot can be used directly; older snapshots are only used to relocate the original element.
 */
internal class NodeIds<N>(private val keep: Int = SNAPSHOT_KEEP) {
    sealed interface Lookup<out N> {
        class Current<N>(val entry: NodeEntry<N>, val snapshot: NodeSnapshot<N>) : Lookup<N>
        class Old<N>(val entry: NodeEntry<N>, val snapshot: NodeSnapshot<N>) : Lookup<N>
        data object Unknown : Lookup<Nothing>
    }

    private val history = ArrayDeque<NodeSnapshot<N>>()

    @Synchronized
    fun put(snapshot: NodeSnapshot<N>) {
        history.addFirst(snapshot)
        while (history.size > keep) history.removeLast()
    }

    @Synchronized
    fun current(): NodeSnapshot<N>? = history.firstOrNull()

    /** Forget every snapshot: after a takeover all refs are stale. */
    @Synchronized
    fun clear() = history.clear()

    @Synchronized
    fun lookup(ref: String, snapshotId: String): Lookup<N> {
        val index = ref.removePrefix("@e").toIntOrNull()?.minus(1) ?: return Lookup.Unknown
        val i = history.indexOfFirst { it.id == snapshotId }
        if (i < 0) return Lookup.Unknown
        val snap = history[i]
        val entry = snap.entries.getOrNull(index) ?: return Lookup.Unknown
        return if (i == 0) Lookup.Current(entry, snap) else Lookup.Old(entry, snap)
    }
}

/** A ref resolved on the current screen. [relocated]: the node was found again by [relocate], not used as numbered. */
internal class ResolvedRef<N>(val node: N, val element: UiElement, val relocated: Boolean)

/**
 * Contract lookup: a ref of the current snapshot whose node still [unchanged] (refresh + same locator without context)
 * is used directly; a changed node or an older snapshot is relocated on [readNow]; anything else is null (`ref_expired`).
 */
internal fun <N> resolveRef(
    ids: NodeIds<N>,
    ref: String,
    snapshotId: String,
    shortSide: Int,
    unchanged: (NodeEntry<N>) -> Boolean,
    readNow: () -> List<NodeEntry<N>>,
): ResolvedRef<N>? {
    val (entry, snapshot) = when (val l = ids.lookup(ref, snapshotId)) {
        is NodeIds.Lookup.Unknown -> return null
        is NodeIds.Lookup.Current -> {
            if (unchanged(l.entry)) return ResolvedRef(l.entry.node, l.entry.element, relocated = false)
            l.entry to l.snapshot
        }
        is NodeIds.Lookup.Old -> l.entry to l.snapshot
    }
    val now = readNow()
    return when (val r = relocate(entry.locator, snapshot.locators, now.map { it.locator }, shortSide)) {
        is Relocation.Found -> now[r.index].let { ResolvedRef(it.node, it.element, relocated = true) }
        else -> null
    }
}
