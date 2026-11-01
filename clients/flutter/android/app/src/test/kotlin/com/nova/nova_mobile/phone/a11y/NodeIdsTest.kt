package com.nova.nova_mobile.phone.a11y

import com.nova.nova_mobile.phone.SNAPSHOT_ID_PREFIX
import com.nova.nova_mobile.phone.SNAPSHOT_KEEP
import com.nova.nova_mobile.phone.UiElement
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test

class NodeIdsTest {
    /** Stand-in for AccessibilityNodeInfo. */
    private data class Node(val id: String)

    private fun entry(index: Int, name: String, x: Int = 100, y: Int = 100 + index * 100, ctx: String? = null) = NodeEntry(
        UiElement("@e${index + 1}", "Button", name, listOf(0, 0, 10, 10), null, clickable = true, editable = false,
            scrollable = false, focused = false, secret = false),
        ElementLocator("Button", name, null, x, y, ctx),
        Node("$name@$x,$y"),
    )

    private fun snapshot(vararg names: String) = NodeSnapshot(snapshotId(), names.mapIndexed { i, n -> entry(i, n) })

    @Test fun snapshotIdsCarryThePhonePrefix() {
        val id = snapshotId()
        assertTrue(id.startsWith(SNAPSHOT_ID_PREFIX))
        assertTrue(id.length <= 64)
    }

    @Test fun lookupDistinguishesCurrentOldAndUnknown() {
        val ids = NodeIds<Node>()
        val first = snapshot("Search", "Cart")
        val second = snapshot("Search", "Cart", "Pay")
        ids.put(first)
        ids.put(second)
        val current = ids.lookup("@e2", second.id)
        assertTrue(current is NodeIds.Lookup.Current)
        assertSame(second.entries[1], (current as NodeIds.Lookup.Current).entry)
        val old = ids.lookup("@e1", first.id)
        assertTrue(old is NodeIds.Lookup.Old)
        assertSame(first.entries[0], (old as NodeIds.Lookup.Old).entry)
        // Out of range, malformed refs and unknown snapshots are all Unknown.
        assertSame(NodeIds.Lookup.Unknown, ids.lookup("@e3", first.id))
        assertSame(NodeIds.Lookup.Unknown, ids.lookup("@x1", second.id))
        assertSame(NodeIds.Lookup.Unknown, ids.lookup("@e1", "ph-missing"))
    }

    @Test fun onlyTheLastFourSnapshotsAreKept() {
        val ids = NodeIds<Node>()
        val all = (1..SNAPSHOT_KEEP + 1).map { snapshot("Item $it") }
        all.forEach(ids::put)
        assertSame(NodeIds.Lookup.Unknown, ids.lookup("@e1", all.first().id))
        assertTrue(ids.lookup("@e1", all[1].id) is NodeIds.Lookup.Old)
        assertTrue(ids.lookup("@e1", all.last().id) is NodeIds.Lookup.Current)
        assertSame(all.last(), ids.current())
    }

    @Test fun clearMakesEveryRefUnknownAfterATakeover() {
        val ids = NodeIds<Node>()
        val snap = snapshot("Search")
        ids.put(snap)
        ids.clear()
        assertSame(NodeIds.Lookup.Unknown, ids.lookup("@e1", snap.id))
        assertNull(ids.current())
    }

    @Test fun unchangedCurrentRefIsUsedWithoutReadingTheScreenAgain() {
        val ids = NodeIds<Node>()
        val snap = snapshot("Search", "Cart")
        ids.put(snap)
        var reads = 0
        val resolved = resolveRef(ids, "@e2", snap.id, 720, unchanged = { true }, readNow = { reads++; emptyList() })!!
        assertSame(snap.entries[1].node, resolved.node)
        assertFalse(resolved.relocated)
        assertEquals(0, reads)
    }

    @Test fun changedCurrentNodeIsRelocatedOnTheFreshRead() {
        val ids = NodeIds<Node>()
        val snap = snapshot("Search", "Cart")
        ids.put(snap)
        // The list was recycled: the old node now shows something else, Cart moved a little.
        val now = listOf(entry(0, "Search"), entry(1, "Cart", y = 230))
        val resolved = resolveRef(ids, "@e2", snap.id, 720, unchanged = { false }, readNow = { now })!!
        assertSame(now[1].node, resolved.node)
        assertTrue(resolved.relocated)
    }

    @Test fun oldSnapshotRefIsRelocatedNeverUsedDirectly() {
        val ids = NodeIds<Node>()
        val old = snapshot("Search", "Cart")
        ids.put(old)
        ids.put(snapshot("Search", "Cart", "Pay"))
        var unchangedCalls = 0
        val now = listOf(entry(0, "Search"), entry(1, "Cart"), entry(2, "Pay"))
        val resolved = resolveRef(ids, "@e2", old.id, 720, unchanged = { unchangedCalls++; true }, readNow = { now })!!
        assertSame(now[1].node, resolved.node)
        assertTrue(resolved.relocated)
        assertEquals(0, unchangedCalls)
    }

    @Test fun semanticChangeOrDisappearanceExpiresTheRef() {
        val ids = NodeIds<Node>()
        val snap = snapshot("Follow")
        ids.put(snap)
        assertNull(resolveRef(ids, "@e1", snap.id, 720, unchanged = { false }, readNow = { listOf(entry(0, "Following")) }))
        assertNull(resolveRef(ids, "@e1", snap.id, 720, unchanged = { false }, readNow = { emptyList() }))
        // Two identical candidates are ambiguous: never guess.
        assertNull(resolveRef(ids, "@e1", snap.id, 720, unchanged = { false },
            readNow = { listOf(entry(0, "Follow"), entry(1, "Follow", y = 110)) }))
    }

    @Test fun unknownRefExpiresWithoutReadingTheScreen() {
        val ids = NodeIds<Node>()
        var reads = 0
        assertNull(resolveRef(ids, "@e1", "ph-gone", 720, unchanged = { true }, readNow = { reads++; emptyList() }))
        assertEquals(0, reads)
    }
}
