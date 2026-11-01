// Derived from Mika (https://github.com/wangzan101/Mika, Apache-2.0, commit 5f630d9),
// Copyright 2026 wangzan101. Modified by Nova: subset of cap/phone/a11y/ScreenReader.kt (numbering, locators,
// change hash) and ScreenPort.normalize emitting the contract UiElement; no UiTreeNode/wheel/aggregate trees; element and name caps.
package com.nova.nova_mobile.phone.a11y

import android.graphics.Rect
import android.view.accessibility.AccessibilityNodeInfo
import android.view.accessibility.AccessibilityWindowInfo
import com.nova.nova_mobile.phone.SNAPSHOT_BOUNDS_MAX
import com.nova.nova_mobile.phone.UiElement
import kotlin.math.max
import kotlin.math.min
import kotlin.math.roundToInt

/**
 * One read of a display. [hash] covers every visible node's class, text, description, bounds and state (checked,
 * selected, enabled, focus, selection), so a focus change alone counts as a change. [appWindowElements] counts the
 * [entries] read from application windows; system windows (status bar, dialogs of other types) are not counted.
 */
internal class ScreenRead(
    val entries: List<NodeEntry<AccessibilityNodeInfo>>,
    val hash: Long,
    val appWindowElements: Int,
    val topPackage: String?,
)

/** Reads the numbered element list and the change hash from one display's windows. Never logs screen content. */
internal object SnapshotReader {
    private const val MIN_SIZE = 5
    private const val MAX_DEPTH = 80
    private const val AGGREGATE_MAX = 60
    /** Bounds model context; later nodes still count for [ScreenRead.hash]. */
    private const val MAX_ELEMENTS = 300
    private const val MAX_NAME = 200

    // The keyboard and accessibility overlays are not part of the operated app.
    private val SKIPPED_TYPES = setOf(
        AccessibilityWindowInfo.TYPE_INPUT_METHOD,
        AccessibilityWindowInfo.TYPE_ACCESSIBILITY_OVERLAY,
        AccessibilityWindowInfo.TYPE_MAGNIFICATION_OVERLAY,
        AccessibilityWindowInfo.TYPE_SPLIT_SCREEN_DIVIDER,
    )

    /** Content windows, top first. */
    fun contentWindows(windows: List<AccessibilityWindowInfo>): List<AccessibilityWindowInfo> =
        windows.filter { it.type !in SKIPPED_TYPES }.sortedByDescending { it.layer }

    // The top application window can be an unreadable popup (menus, text selection); skip those.
    fun topPackage(windows: List<AccessibilityWindowInfo>): String? =
        contentWindows(windows).filter { it.type == AccessibilityWindowInfo.TYPE_APPLICATION }
            .firstNotNullOfOrNull { it.root?.packageName?.toString() }

    fun read(windows: List<AccessibilityWindowInfo>, width: Int, height: Int): ScreenRead {
        val content = contentWindows(windows)
        val entries = mutableListOf<NodeEntry<AccessibilityNodeInfo>>()
        val seen = HashSet<String>()
        var hash = FNV_OFFSET
        var lastLabel: String? = null
        var appWindowElements = 0
        var inAppWindow = false
        val rect = Rect()

        fun visit(n: AccessibilityNodeInfo, depth: Int, inList: Boolean) {
            if (depth > MAX_DEPTH) return
            if (n.isVisibleToUser) {
                n.getBoundsInScreen(rect)
                hash = mix(hash, n.className, n.text, n.contentDescription, rect.flattenToString(), states(n))
                // Editable and secret fields expose only their hint or label, never their content.
                val own = ownLabel(n)
                clip(rect, width, height)
                val usable = rect.width() >= MIN_SIZE && rect.height() >= MIN_SIZE
                val interactive = n.isClickable || n.isEditable || n.isScrollable
                if (usable && (own != null || interactive) && entries.size < MAX_ELEMENTS) {
                    val label = labelOf(n, own)
                    val role = roleOf(n)
                    if (seen.add("$role|$label|${rect.flattenToString()}")) {
                        val rid = n.viewIdResourceName
                        val element = UiElement(
                            ref = "@e${entries.size + 1}",
                            role = role,
                            name = label.take(MAX_NAME),
                            bounds = listOf(normalize(rect.left, width), normalize(rect.top, height),
                                normalize(rect.right, width), normalize(rect.bottom, height)),
                            // Fields always carry their id: a search box's name is often only a suggestion.
                            resourceId = if (label.isEmpty() || n.isEditable) readableResourceId(rid) else null,
                            clickable = n.isClickable,
                            editable = n.isEditable,
                            scrollable = n.isScrollable,
                            focused = n.isFocused,
                            secret = n.isPassword,
                        )
                        val hint = namedByHint(n, own)
                        entries += NodeEntry(element, ElementLocator(role, label, rid, rect.centerX(), rect.centerY(), lastLabel, hint, inList), n)
                        if (inAppWindow) appWindowElements++
                        if (label.isNotEmpty()) lastLabel = label
                    }
                }
            }
            val childrenInList = inList || isList(n)
            for (i in 0 until n.childCount) n.getChild(i)?.let { visit(it, depth + 1, childrenInList) }
        }

        for (w in content) w.root?.let {
            inAppWindow = w.type == AccessibilityWindowInfo.TYPE_APPLICATION
            visit(it, 0, false)
        }
        return ScreenRead(
            entries = entries,
            hash = hash,
            appWindowElements = appWindowElements,
            topPackage = topPackage(windows),
        )
    }

    /** The node's current locator without context; null when invisible or too small. */
    fun locatorOf(n: AccessibilityNodeInfo, width: Int, height: Int): ElementLocator? {
        if (!n.isVisibleToUser) return null
        val rect = Rect().also { n.getBoundsInScreen(it) }
        clip(rect, width, height)
        if (rect.width() < MIN_SIZE || rect.height() < MIN_SIZE) return null
        val own = ownLabel(n)
        return ElementLocator(
            roleOf(n), labelOf(n, own), n.viewIdResourceName, rect.centerX(), rect.centerY(), null,
            hint = namedByHint(n, own), inList = inList(n),
        )
    }

    /** Only the change hash, no element list (before/after an action). */
    fun hash(windows: List<AccessibilityWindowInfo>): Long {
        var hash = FNV_OFFSET
        val rect = Rect()
        fun visit(n: AccessibilityNodeInfo, depth: Int) {
            if (depth > MAX_DEPTH) return
            if (n.isVisibleToUser) {
                n.getBoundsInScreen(rect)
                hash = mix(hash, n.className, n.text, n.contentDescription, rect.flattenToString(), states(n))
            }
            for (i in 0 until n.childCount) n.getChild(i)?.let { visit(it, depth + 1) }
        }
        for (w in contentWindows(windows)) w.root?.let { visit(it, 0) }
        return hash
    }

    /** List containers recycle their items; the same spot can show another entry. */
    private fun isList(n: AccessibilityNodeInfo): Boolean {
        if (n.collectionInfo != null) return true
        val cls = n.className?.toString() ?: return false
        return cls.endsWith("RecyclerView") || cls.endsWith("ListView") || cls.endsWith("GridView")
    }

    private fun inList(n: AccessibilityNodeInfo): Boolean {
        var p = n.parent
        var depth = 0
        while (p != null && depth++ < MAX_DEPTH) {
            if (isList(p)) return true
            p = p.parent
        }
        return false
    }

    private fun clip(rect: Rect, width: Int, height: Int) {
        if (!rect.intersect(0, 0, width, height)) rect.setEmpty()
    }

    private fun roleOf(n: AccessibilityNodeInfo) = n.className?.toString()?.substringAfterLast('.')?.ifEmpty { null } ?: "View"

    private fun labelOf(n: AccessibilityNodeInfo, own: String?) = own ?: if (n.isClickable) descendantLabel(n) else ""

    // isChecked is replaced by the tri-state `checked` from API 36; minSdk still needs it.
    @Suppress("DEPRECATION")
    private fun states(n: AccessibilityNodeInfo) =
        "${n.isChecked}${n.isSelected}${n.isEnabled}${n.isFocused}${n.textSelectionStart}:${n.textSelectionEnd}"

    /** Editable and secret fields hold user input; their names never come from their own text or description. */
    private fun isField(n: AccessibilityNodeInfo) = n.isEditable || n.isPassword

    /** The node's own name per [nodeName]; a field's label view counts only when it is not a field itself. */
    fun ownLabel(n: AccessibilityNodeInfo): String? =
        nodeName(n.text, n.contentDescription, n.hintText, isField(n)) {
            n.labeledBy?.takeUnless { isField(it) }?.let { label -> label.text ?: label.contentDescription }
        }

    /** The name is an input hint (these rotate): a field named by its hint, or another node showing its hint. */
    private fun namedByHint(n: AccessibilityNodeInfo, own: String?): Boolean =
        own != null && if (isField(n)) own == n.hintText?.toString()?.trim() else showingHint(n)

    /** The node shows its hint: flagged by the system, no real text, or the reported text equals the hint. */
    private fun showingHint(n: AccessibilityNodeInfo): Boolean {
        if (n.isShowingHintText) return true
        val hint = n.hintText?.toString()?.trim()
        if (hint.isNullOrEmpty()) return false
        val text = n.text?.toString()?.trim()
        return if (text.isNullOrEmpty()) n.contentDescription.isNullOrBlank() else text == hint
    }

    /** A clickable container without a name is named by its descendants' text. */
    private fun descendantLabel(n: AccessibilityNodeInfo): String {
        val parts = mutableListOf<String>()
        fun walk(c: AccessibilityNodeInfo, depth: Int) {
            if (depth > 6 || parts.joinToString(" ").length > AGGREGATE_MAX) return
            for (i in 0 until c.childCount) {
                val child = c.getChild(i) ?: continue
                if (!child.isVisibleToUser) continue
                // A secret descendant contributes nothing.
                if (!child.isPassword) ownLabel(child)?.let { if (it !in parts) parts += it }
                walk(child, depth + 1)
            }
        }
        walk(n, 0)
        val joined = parts.joinToString(" ")
        return if (joined.length > AGGREGATE_MAX) joined.take(AGGREGATE_MAX) + "…" else joined
    }

    /** `com.x:id/cart_icon` -> `cart_icon`; obfuscated short names say nothing and are dropped. */
    private fun readableResourceId(id: String?): String? {
        val short = id?.substringAfterLast('/') ?: return null
        return short.takeIf { Regex("^[A-Za-z0-9_]{4,}$").matches(it) && Regex("[A-Za-z]{3}").containsMatchIn(it) }
    }

    private const val FNV_OFFSET = -0x340d631b7bdddcdbL
    private const val FNV_PRIME = 0x100000001b3L

    private fun mix(h0: Long, vararg parts: Any?): Long {
        var h = h0
        for (p in parts) {
            val s = p?.toString() ?: "\u0000"
            for (c in s) h = (h xor c.code.toLong()) * FNV_PRIME
            h = (h xor 0x1f) * FNV_PRIME
        }
        return h
    }
}

/**
 * Name of a node. A [field] (editable or secret) is named by its [hint], else by the text of its label view
 * ([labelledBy]), never by its own [text] or [description], which may be what the user typed. Any other node is named by
 * its text, else its description, else its hint. Null when there is no name.
 */
internal fun nodeName(text: CharSequence?, description: CharSequence?, hint: CharSequence?, field: Boolean, labelledBy: () -> CharSequence?): String? {
    fun clean(value: CharSequence?) = value?.toString()?.trim()?.ifEmpty { null }
    if (field) return clean(hint) ?: clean(labelledBy())
    return clean(text) ?: clean(description) ?: clean(hint)
}

/**
 * Contract `secure_frame`: the frame is (near-)black while application windows still show [appWindowElements] readable
 * elements, as a FLAG_SECURE page does. A dark splash, video or switched-off screen without readable app elements is not
 * secure, even when system windows on the display have elements.
 */
internal fun isSecureFrame(black: Boolean, appWindowElements: Int): Boolean = black && appWindowElements > 0

/** Pixel [p] on an axis of [size] pixels to the snapshot's 0..[SNAPSHOT_BOUNDS_MAX] space. */
internal fun normalize(p: Int, size: Int): Int {
    if (size <= 1) return 0
    return min(SNAPSHOT_BOUNDS_MAX, max(0, (p * SNAPSHOT_BOUNDS_MAX.toDouble() / (size - 1)).roundToInt()))
}
