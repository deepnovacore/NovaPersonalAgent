// Derived from Mika (https://github.com/wangzan101/Mika, Apache-2.0, commit 5f630d9),
// Copyright 2026 wangzan101. Modified by Nova: rewritten subset of cap/phone/a11y/AndroidScreen.kt (resolve, tapRef,
// typeText, scroll, back, openApp) on INovaShell and LocalGuiService, blocking, split into prepare/dispatch so ref
// resolution happens before the action is journaled; no paste/IME/spill/multi-user/pacing logic.
package com.nova.nova_mobile.phone.a11y

import android.accessibilityservice.GestureDescription
import android.graphics.Path
import android.graphics.Rect
import android.os.Bundle
import android.os.RemoteException
import android.os.SystemClock
import android.view.KeyEvent
import android.view.accessibility.AccessibilityNodeInfo
import androidx.annotation.RequiresApi
import com.nova.nova_mobile.LocalGuiService
import com.nova.nova_mobile.phone.PhoneAction
import com.nova.nova_mobile.phone.PhoneActionErrors
import com.nova.nova_mobile.phone.PhoneSnapshot
import com.nova.nova_mobile.phone.ScrollDirection
import com.nova.nova_mobile.phone.ShellProvider
import com.nova.nova_mobile.phone.display.AgentDisplay
import com.nova.nova_mobile.phone.display.LazyAgentDisplay
import com.nova.nova_mobile.phone.shell.INovaShell
import kotlin.math.min

/**
 * The run's virtual display seen through accessibility (read, numbered refs) and driven through gestures with helper
 * injection as fallback. Every call blocks and must run off the main thread. Execution errors are
 * IllegalStateException(contract code); nothing here logs screen content or typed text.
 */
@RequiresApi(31)
class VirtualScreen(
    private val service: LocalGuiService,
    private val shells: ShellProvider,
    val display: LazyAgentDisplay,
    val scope: VirtualScope,
) {
    private val ids = NodeIds<AccessibilityNodeInfo>()

    /** A resolved action ready to dispatch. [ref] is the model's ref, [label] an element name or package (never typed text). */
    class Prepared internal constructor(
        val tool: String,
        val ref: String?,
        val label: String?,
        internal val changeWaitMs: Long,
        internal val run: (AgentDisplay) -> Boolean,
        internal val settled: ((AgentDisplay) -> Boolean)? = null,
    )

    /** [outcome] is a journal outcome (`dispatched`/`rejected`); [changed] whether the display's tree changed afterwards. */
    class Dispatched(val outcome: String, val changed: Boolean?)

    /** The helper binder the display was created with; a missing or different binder means the helper died or restarted. */
    private fun shell(): INovaShell {
        val now = shells.shell ?: throw IllegalStateException(PhoneActionErrors.HELPER_UNAVAILABLE)
        val made = display.current
        if (made != null && made.shell.asBinder() !== now.asBinder()) throw IllegalStateException(PhoneActionErrors.HELPER_UNAVAILABLE)
        return now
    }

    private fun requireDisplay(): AgentDisplay = display.current ?: throw IllegalStateException(PhoneActionErrors.DISPLAY_UNAVAILABLE)

    private fun windows(d: AgentDisplay) = service.windowsOn(d.displayId)

    private fun read(d: AgentDisplay) = SnapshotReader.read(windows(d), d.width, d.height)

    /** Foreground package of the display, or null when nothing readable is shown. */
    fun topPackage(): String? = display.current?.let { SnapshotReader.topPackage(windows(it)) }

    /** Reads and registers a numbered snapshot with the latest frame. */
    fun snapshot(): PhoneSnapshot = helperCall {
        shell()
        val d = requireDisplay()
        if (!d.awaitFrame(FIRST_FRAME_MS)) throw IllegalStateException(SCREEN_UNAVAILABLE)
        val r = read(d)
        val after = SnapshotReader.hash(windows(d))
        val image = d.modelImage() ?: throw IllegalStateException(SCREEN_UNAVAILABLE)
        val snap = NodeSnapshot(snapshotId(), r.entries)
        ids.put(snap)
        PhoneSnapshot(
            snapshotId = snap.id,
            packageName = r.topPackage,
            width = d.width,
            height = d.height,
            elements = r.entries.map { it.element },
            image = image.jpegBase64,
            changedDuringRead = after != r.hash,
            secureFrame = image.black && r.hasAppWindow,
        )
    }

    /** After a takeover every ref is stale. */
    fun forgetRefs() = ids.clear()

    /**
     * Resolves [action] against the current display without any effect on it (except creating the display for
     * `open_app`). Throws `ref_expired`, `ref_not_editable`, `ref_not_scrollable`, `no_focused_input`,
     * `private_input_requires_user`, `app_not_allowed`, `display_unavailable` or `helper_unavailable`.
     */
    fun prepare(action: PhoneAction): Prepared = helperCall {
        shell()
        when (action) {
            is PhoneAction.OpenApp -> prepareOpenApp(action.packageName)
            is PhoneAction.TapRef -> {
                val d = requireDisplay()
                val target = resolve(d, action.ref, action.snapshotId)
                Prepared("tap", action.ref, target.element.name, CHANGE_WAIT_MS, { click(it, target.node) })
            }
            is PhoneAction.TapPoint -> {
                val d = requireDisplay()
                val x = pixel(action.x, d.width)
                val y = pixel(action.y, d.height)
                Prepared("tap", null, null, CHANGE_WAIT_MS, { touch(it, x, y) })
            }
            is PhoneAction.Swipe -> {
                val d = requireDisplay()
                val from = pixel(action.x, d.width) to pixel(action.y, d.height)
                val to = pixel(action.toX, d.width) to pixel(action.toY, d.height)
                Prepared("swipe", null, null, CHANGE_WAIT_MS, { drag(it, from, to) })
            }
            is PhoneAction.Type -> prepareType(requireDisplay(), action)
            is PhoneAction.Scroll -> prepareScroll(requireDisplay(), action)
            PhoneAction.Back -> {
                requireDisplay()
                Prepared("back", null, null, CHANGE_WAIT_MS, { shell().injectKey(it.displayId, KeyEvent.KEYCODE_BACK) })
            }
            is PhoneAction.HandToUser -> throw IllegalArgumentException("unsupported_action")
        }
    }

    /**
     * Dispatches [prepared] once if [allowed] still holds, then waits briefly for the display to change and settle.
     * A definite pre-effect failure (for example `app_in_use_on_main`) throws its contract code; any other exception
     * means the effect is unknown.
     */
    fun dispatch(prepared: Prepared, allowed: () -> Boolean): Dispatched {
        shell()
        val d = requireDisplay()
        check(allowed()) { "execution_stopped" }
        val before = SnapshotReader.hash(windows(d))
        if (!prepared.run(d)) return Dispatched("rejected", null)
        return Dispatched("dispatched", settle(d, before, prepared))
    }

    /** Ends the run's display: later calls fail with `display_unavailable`. */
    fun close() {
        ids.clear()
        display.close()?.release()
    }

    private fun prepareOpenApp(packageName: String): Prepared {
        scope.checkOpenApp(packageName)
        val d = try {
            display.get()
        } catch (e: RemoteException) {
            throw IllegalStateException(PhoneActionErrors.HELPER_UNAVAILABLE)
        } catch (e: IllegalStateException) {
            throw e.takeIf { it.message == PhoneActionErrors.HELPER_UNAVAILABLE } ?: IllegalStateException(PhoneActionErrors.DISPLAY_UNAVAILABLE)
        } catch (e: Exception) {
            throw IllegalStateException(PhoneActionErrors.DISPLAY_UNAVAILABLE)
        }
        shell()
        return Prepared("open_app", null, packageName, LAUNCH_WAIT_MS, run = {
            startAppError(shell().startApp(d.displayId, packageName))?.let { code -> throw IllegalStateException(code) }
            true
        }, settled = { SnapshotReader.topPackage(windows(it)) == packageName })
    }

    private fun prepareType(d: AgentDisplay, action: PhoneAction.Type): Prepared {
        val field: AccessibilityNodeInfo
        var label: String? = null
        if (action.ref != null && action.snapshotId != null) {
            val target = resolve(d, action.ref, action.snapshotId)
            field = if (target.node.isEditable) target.node else descendant(target.node) { it.isEditable }
                ?: throw IllegalStateException(PhoneActionErrors.REF_NOT_EDITABLE)
            if (!target.element.secret) label = target.element.name
        } else {
            field = focusedEditable(d) ?: throw IllegalStateException(PhoneActionErrors.NO_FOCUSED_INPUT)
        }
        if (field.isPassword) throw IllegalStateException(PhoneActionErrors.PRIVATE_INPUT_REQUIRES_USER)
        val text = action.text
        return Prepared("type", action.ref, label, CHANGE_WAIT_MS, {
            if (!field.isFocused) field.performAction(AccessibilityNodeInfo.ACTION_FOCUS)
            val args = Bundle().apply { putCharSequence(AccessibilityNodeInfo.ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE, text) }
            field.performAction(AccessibilityNodeInfo.ACTION_SET_TEXT, args)
        })
    }

    private fun prepareScroll(d: AgentDisplay, action: PhoneAction.Scroll): Prepared {
        var label: String? = null
        val node: AccessibilityNodeInfo? = if (action.ref != null && action.snapshotId != null) {
            val target = resolve(d, action.ref, action.snapshotId)
            label = target.element.name
            ancestorOrSelf(target.node) { it.isScrollable } ?: throw IllegalStateException(PhoneActionErrors.REF_NOT_SCROLLABLE)
        } else {
            // Without a ref: the largest scrollable area on the display, else a swipe across the middle.
            read(d).entries.filter { it.element.scrollable }
                .maxByOrNull { e -> Rect().also { e.node.getBoundsInScreen(it) }.let { it.width().toLong() * it.height() } }?.node
        }
        val direction = action.direction
        return Prepared("scroll", action.ref, label, CHANGE_WAIT_MS, { shown ->
            val area = node?.let { n -> Rect().also { n.getBoundsInScreen(it) } }?.takeIf { it.intersect(0, 0, shown.width, shown.height) }
                ?: Rect(0, 0, shown.width, shown.height)
            val (from, to) = swipeFor(area, direction)
            (node != null && scrollAction(node, direction)) || drag(shown, from, to)
        })
    }

    private fun resolve(d: AgentDisplay, ref: String, snapshotId: String): ResolvedRef<AccessibilityNodeInfo> =
        resolveRef(ids, ref, snapshotId, min(d.width, d.height),
            unchanged = { entry -> entry.node.refresh() && SnapshotReader.locatorOf(entry.node, d.width, d.height) == entry.locator.copy(context = null) },
            readNow = { read(d).entries },
        ) ?: throw IllegalStateException(PhoneActionErrors.REF_EXPIRED)

    /** Input focus inside this display's windows only (never rootInActiveWindow, which is the main screen). */
    private fun focusedEditable(d: AgentDisplay): AccessibilityNodeInfo? {
        for (w in SnapshotReader.contentWindows(windows(d))) {
            val focused = w.root?.findFocus(AccessibilityNodeInfo.FOCUS_INPUT) ?: continue
            if (focused.isEditable) return focused
            descendant(focused) { it.isFocused && it.isEditable }?.let { return it }
        }
        return null
    }

    /** Waits for the tree to change after an action, then for the display's events to go quiet (both capped). */
    private fun settle(d: AgentDisplay, before: Long, prepared: Prepared): Boolean {
        val start = SystemClock.uptimeMillis()
        var changed = false
        while (SystemClock.uptimeMillis() - start < prepared.changeWaitMs) {
            val done = prepared.settled?.invoke(d) ?: true
            if (done && SnapshotReader.hash(windows(d)) != before) { changed = true; break }
            Thread.sleep(POLL_MS)
        }
        if (changed) {
            val quietStart = SystemClock.uptimeMillis()
            while (SystemClock.uptimeMillis() - quietStart < SETTLE_CAP_MS &&
                SystemClock.uptimeMillis() - service.lastEventAt(d.displayId) < QUIET_MS) Thread.sleep(POLL_MS)
        }
        return changed
    }

    // ---------- low-level input ----------

    /** Click the node (or its nearest clickable ancestor); otherwise touch its centre. */
    private fun click(d: AgentDisplay, node: AccessibilityNodeInfo): Boolean {
        val target = ancestorOrSelf(node) { it.isClickable && it.isEnabled }
        if (target != null && target.performAction(AccessibilityNodeInfo.ACTION_CLICK)) return true
        val rect = Rect().also { node.getBoundsInScreen(it) }
        if (!rect.intersect(0, 0, d.width, d.height)) return false
        return touch(d, rect.centerX(), rect.centerY())
    }

    /** A tap by accessibility gesture on the display, else helper injection. */
    private fun touch(d: AgentDisplay, x: Int, y: Int): Boolean {
        val path = Path().apply { moveTo(x.toFloat(), y.toFloat()) }
        if (service.gesture(d.displayId, listOf(GestureDescription.StrokeDescription(path, 0, TAP_MS)))) return true
        return shell().injectTap(d.displayId, x, y)
    }

    /** One-finger swipe by accessibility gesture, else helper stroke injection. */
    private fun drag(d: AgentDisplay, from: Pair<Int, Int>, to: Pair<Int, Int>): Boolean {
        val path = Path().apply { moveTo(from.first.toFloat(), from.second.toFloat()); lineTo(to.first.toFloat(), to.second.toFloat()) }
        if (service.gesture(d.displayId, listOf(GestureDescription.StrokeDescription(path, 0, SWIPE_MS)))) return true
        return shell().injectStroke(d.displayId, intArrayOf(from.first, to.first), intArrayOf(from.second, to.second), longArrayOf(0, SWIPE_MS))
    }

    /** [direction] is where the view moves in the content: `down` shows what is below. */
    private fun scrollAction(node: AccessibilityNodeInfo, direction: ScrollDirection): Boolean {
        val directional = when (direction) {
            ScrollDirection.UP -> AccessibilityNodeInfo.AccessibilityAction.ACTION_SCROLL_UP
            ScrollDirection.DOWN -> AccessibilityNodeInfo.AccessibilityAction.ACTION_SCROLL_DOWN
            ScrollDirection.LEFT -> AccessibilityNodeInfo.AccessibilityAction.ACTION_SCROLL_LEFT
            ScrollDirection.RIGHT -> AccessibilityNodeInfo.AccessibilityAction.ACTION_SCROLL_RIGHT
        }
        if (node.actionList.any { it.id == directional.id } && node.performAction(directional.id)) return true
        return when (direction) {
            ScrollDirection.DOWN -> node.performAction(AccessibilityNodeInfo.ACTION_SCROLL_FORWARD)
            ScrollDirection.UP -> node.performAction(AccessibilityNodeInfo.ACTION_SCROLL_BACKWARD)
            else -> false
        }
    }

    private fun pixel(normalized: Double, size: Int) = (normalized * (size - 1)).toInt()

    private inline fun ancestorOrSelf(node: AccessibilityNodeInfo, test: (AccessibilityNodeInfo) -> Boolean): AccessibilityNodeInfo? {
        var n: AccessibilityNodeInfo? = node
        var depth = 0
        while (n != null && depth <= MAX_ANCESTORS) {
            if (test(n)) return n
            n = n.parent
            depth++
        }
        return null
    }

    private fun descendant(node: AccessibilityNodeInfo, test: (AccessibilityNodeInfo) -> Boolean): AccessibilityNodeInfo? {
        val queue = ArrayDeque<AccessibilityNodeInfo>().apply { add(node) }
        var visited = 0
        while (queue.isNotEmpty() && visited++ < MAX_DESCENDANTS) {
            val n = queue.removeFirst()
            if (test(n)) return n
            for (i in 0 until n.childCount) n.getChild(i)?.let(queue::add)
        }
        return null
    }

    /** A dead helper binder becomes `helper_unavailable`; every other failure keeps its own type and code. */
    private inline fun <T> helperCall(block: () -> T): T = try {
        block()
    } catch (e: RemoteException) {
        throw IllegalStateException(PhoneActionErrors.HELPER_UNAVAILABLE)
    }

    companion object {
        /** Existing safe observation code, reused when the display has no frame yet. */
        const val SCREEN_UNAVAILABLE = "screen_unavailable"
        private const val FIRST_FRAME_MS = 2_000L
        private const val CHANGE_WAIT_MS = 1_500L
        private const val LAUNCH_WAIT_MS = 5_000L
        private const val SETTLE_CAP_MS = 1_500L
        private const val QUIET_MS = 300L
        private const val POLL_MS = 100L
        /** Same tap and swipe durations as the main-tier gestures. */
        private const val TAP_MS = 80L
        private const val SWIPE_MS = 450L
        private const val MAX_ANCESTORS = 8
        private const val MAX_DESCENDANTS = 500

        /** Finger path inside [area] that moves the view toward [direction] (the finger moves the opposite way). */
        internal fun swipeFor(area: Rect, direction: ScrollDirection): Pair<Pair<Int, Int>, Pair<Int, Int>> {
            val cx = area.centerX()
            val cy = area.centerY()
            val dy = area.height() / 4
            val dx = area.width() / 4
            return when (direction) {
                ScrollDirection.DOWN -> (cx to cy + dy) to (cx to cy - dy)
                ScrollDirection.UP -> (cx to cy - dy) to (cx to cy + dy)
                ScrollDirection.RIGHT -> (cx + dx to cy) to (cx - dx to cy)
                ScrollDirection.LEFT -> (cx - dx to cy) to (cx + dx to cy)
            }
        }
    }
}
