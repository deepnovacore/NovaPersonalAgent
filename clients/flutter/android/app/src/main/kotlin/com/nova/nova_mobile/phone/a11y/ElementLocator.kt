// Derived from Mika (https://github.com/wangzan101/Mika, Apache-2.0, commit 5f630d9),
// Copyright 2026 wangzan101. Modified by Nova: minimal internal copy of core/uistate/Accuracy.kt (ElementLocator,
// relocate, stationary) and ScreenPort.normalize, English comments.
// TODO(integration): replace with phone-core `com.nova.phone.core.uistate` (M2 lane) once both branches are merged.
package com.nova.nova_mobile.phone.a11y

import com.nova.nova_mobile.phone.SNAPSHOT_BOUNDS_MAX
import kotlin.math.hypot
import kotlin.math.max
import kotlin.math.min
import kotlin.math.roundToInt

/**
 * Features used to recognise "the same element" on a new screen. [context] is the nearest named element before it in
 * traversal order, so a same-named button elsewhere cannot take its place after scrolling. [hint]: the name is an
 * input hint/placeholder (these rotate). [inList]: the element is inside a list container (items are recycled).
 */
internal data class ElementLocator(
    val role: String,
    val name: String,
    val resourceId: String?,
    val centerX: Int,
    val centerY: Int,
    val context: String?,
    val hint: Boolean = false,
    val inList: Boolean = false,
)

internal sealed interface Relocation {
    /** [index] is the index in the new list. */
    data class Found(val index: Int) : Relocation
    /** Still there, but the context changed or it moved too far. */
    data object Moved : Relocation
    /** No name and no resource id, or several identical candidates. */
    data object Ambiguous : Relocation
    /** Not on the new screen. */
    data object Gone : Relocation
}

/** Largest centre shift accepted when relocating: this share of the screen's short side. */
internal const val RELOCATE_MAX_SHIFT = 0.15

/** "Still in place" shift limit: this share of the screen's short side. */
internal const val SAME_SPOT_SHIFT = 0.02

/**
 * Finds the unique counterpart of [previous] in [after] once its ref is stale. Found only when role, name and resource id
 * are equal, it is the only such element both in [before] and in [after], the context is the same and the centre moved at
 * most [RELOCATE_MAX_SHIFT] of the short side.
 *
 * When the page as a whole did not move (see [stationary]) two relaxations apply, for carousels and countdowns:
 * - a changed context is accepted if the element stayed in place and is not inside a list;
 * - a changed name is accepted if old and new share the resource id and role, stay in place, are alone there, and the
 *   names differ only in digits and whitespace ("Skip 3" -> "Skip 2") or the old name was a rotating hint.
 *   Semantic changes ("Follow" -> "Following", "Next" -> "Confirm payment") never match.
 */
internal fun relocate(previous: ElementLocator, before: List<ElementLocator>, after: List<ElementLocator>, shortSide: Int): Relocation {
    if (previous.name.isBlank() && previous.resourceId.isNullOrBlank()) return Relocation.Ambiguous
    val spot = shortSide * SAME_SPOT_SHIFT
    val still by lazy { stationary(before, after, spot) }
    fun same(e: ElementLocator) = e.role == previous.role && e.name == previous.name && e.resourceId == previous.resourceId
    val candidates = after.withIndex().filter { same(it.value) }
    if (candidates.isEmpty()) {
        if (previous.resourceId.isNullOrBlank() || !still) return Relocation.Gone
        val inPlace = after.withIndex().filter { (_, e) ->
            e.role == previous.role && e.resourceId == previous.resourceId && shift(e, previous) <= spot
        }
        val found = inPlace.singleOrNull() ?: return Relocation.Gone
        val renamedAlike = previous.hint || stripDigits(found.value.name) == stripDigits(previous.name)
        return if (renamedAlike) Relocation.Found(found.index) else Relocation.Gone
    }
    if (candidates.size > 1 || before.count(::same) > 1) return Relocation.Ambiguous
    val (index, found) = candidates.single()
    val moved = shift(found, previous)
    if (moved > shortSide * RELOCATE_MAX_SHIFT) return Relocation.Moved
    if (found.context != previous.context && !(still && moved <= spot && !previous.inList)) return Relocation.Moved
    return Relocation.Found(index)
}

private fun stripDigits(s: String) = s.filterNot { it.isDigit() || it.isWhitespace() }

private fun shift(a: ElementLocator, b: ElementLocator) =
    hypot((a.centerX - b.centerX).toDouble(), (a.centerY - b.centerY).toDouble())

/**
 * The page did not move: at least 2 named elements that are unique before and after, and 80% of them stayed in place.
 * Scrolling a list or switching pages moves or removes most elements.
 */
internal fun stationary(before: List<ElementLocator>, after: List<ElementLocator>, spot: Double): Boolean {
    fun key(e: ElementLocator) = Triple(e.role, e.name, e.resourceId)
    val afterByKey = after.filter { it.name.isNotBlank() }.groupBy(::key)
    var shared = 0
    var inPlace = 0
    for ((k, list) in before.filter { it.name.isNotBlank() }.groupBy(::key)) {
        val a = afterByKey[k]?.singleOrNull() ?: continue
        if (list.size != 1) continue
        shared++
        if (shift(list[0], a) <= spot) inPlace++
    }
    return shared >= 2 && inPlace >= shared * 0.8
}

/** Pixel [p] on an axis of [size] pixels to the snapshot's 0..[SNAPSHOT_BOUNDS_MAX] space. */
internal fun normalize(p: Int, size: Int): Int {
    if (size <= 1) return 0
    return min(SNAPSHOT_BOUNDS_MAX, max(0, (p * SNAPSHOT_BOUNDS_MAX.toDouble() / (size - 1)).roundToInt()))
}
