// Derived from Mika (https://github.com/wangzan101/Mika, Apache-2.0, commit 5f630d9),
// Copyright 2026 wangzan101. Modified by Nova: rewritten subset of selfcheck/AndroidSelfCheck.kt (helper, display,
// launch, read, actions, own focus) driving system Settings instead of a bundled test activity; contract check ids.
package com.nova.nova_mobile.phone

import android.accessibilityservice.GestureDescription
import android.content.Context
import android.content.Intent
import android.graphics.Path
import android.graphics.Rect
import android.hardware.display.DisplayManager
import android.os.Build
import android.os.Bundle
import android.os.Looper
import android.os.SystemClock
import android.provider.Settings
import android.util.DisplayMetrics
import android.view.Display
import android.view.KeyEvent
import android.view.accessibility.AccessibilityNodeInfo
import androidx.annotation.RequiresApi
import com.nova.nova_mobile.LocalGuiService
import com.nova.nova_mobile.phone.a11y.GestureOutcome
import com.nova.nova_mobile.phone.a11y.RuntimeFlagLeases
import com.nova.nova_mobile.phone.a11y.SnapshotReader
import com.nova.nova_mobile.phone.a11y.startAppError
import com.nova.nova_mobile.phone.display.AgentDisplay
import com.nova.nova_mobile.phone.shell.INovaShell

/** Admits work that must not overlap an agent run. Implemented by LocalAgentController. */
interface RunIdleGate {
    /** Runs [block] only while no run is active, atomically with run admission; otherwise throws IllegalStateException(`run_active`). */
    fun <T> whileIdle(block: () -> T): T
}

/**
 * Self-check of the virtual tier (contract `selfCheck`): creates a temporary display, opens system Settings on it, reads
 * its tree and frame, taps a point outside every clickable node, types only into an editable Settings field (or reports
 * `no_text_field`), presses back with `injectKey` and reads FLAG_OWN_FOCUS. The runtime a11y flag and the display are
 * always released. It refuses with `run_active` while a run is active, and no run starts while it holds the flag.
 * Details are safe codes; no screen text is reported. [run] blocks and must not run on the main thread.
 */
class VirtualSelfCheck(context: Context, private val shells: ShellProvider, private val runs: RunIdleGate) : PhoneSelfCheck {
    private val app = context.applicationContext

    override fun run(): List<SelfCheckItem> {
        check(Looper.myLooper() != Looper.getMainLooper()) { "blocking_gui_call_on_main" }
        runs.whileIdle { }
        val results = linkedMapOf<String, SelfCheckItem>()
        fun put(id: String, ok: Boolean, detail: String? = null) { results[id] = SelfCheckItem(id, ok, detail) }
        val shell = shells.shell
        when {
            Build.VERSION.SDK_INT < PHONE_VIRTUAL_MIN_API -> put(ID_HELPER, false, "unsupported")
            shell == null -> { shells.need(); put(ID_HELPER, false, "not_running") }
            else -> runCatching { shell.identity().size == 2 }.getOrDefault(false).let { ok -> put(ID_HELPER, ok, if (ok) null else PhoneActionErrors.HELPER_UNAVAILABLE) }
        }
        if (Build.VERSION.SDK_INT >= PHONE_VIRTUAL_MIN_API && shell != null && results.getValue(ID_HELPER).ok) {
            runDisplayChecks(shell, ::put)
        }
        return IDS.map { results[it] ?: SelfCheckItem(it, false, "not_run") }
    }

    @RequiresApi(31)
    private fun runDisplayChecks(shell: INovaShell, put: (String, Boolean, String?) -> Unit) {
        val service = LocalGuiService.current
        val metrics = DisplayMetrics()
        @Suppress("DEPRECATION") app.getSystemService(DisplayManager::class.java).getDisplay(Display.DEFAULT_DISPLAY).getRealMetrics(metrics)
        val width = minOf(metrics.widthPixels, metrics.heightPixels)
        val height = maxOf(metrics.widthPixels, metrics.heightPixels)
        var flags: RuntimeFlagLeases.Lease? = null
        var created: AgentDisplay? = null
        try {
            // Taken while no run is active; a run cannot start until the lease is released below.
            if (service != null) {
                flags = try { runs.whileIdle { service.acquireVirtualFlags { } } } catch (e: IllegalStateException) {
                    if (e.message == RUN_ACTIVE) throw e
                    put(ID_CREATE_DISPLAY, false, "accessibility_flags_failed")
                    return
                } catch (_: Exception) {
                    put(ID_CREATE_DISPLAY, false, "accessibility_flags_failed")
                    return
                }
            }
            val display = try { AgentDisplay(shell, width, height, metrics.densityDpi, null) } catch (_: Exception) {
                put(ID_CREATE_DISPLAY, false, "create_failed")
                return
            }
            created = display
            put(ID_CREATE_DISPLAY, true, null)
            val flags = runCatching { shell.displayFlags(display.displayId) }.getOrDefault(-1)
            put(ID_MAIN_FOCUS, flags >= 0 && flags and INovaShell.FLAG_OWN_FOCUS != 0, if (flags < 0) "unknown" else if (flags and INovaShell.FLAG_OWN_FOCUS == 0) "shared_focus" else null)

            val settings = runCatching { app.packageManager.resolveActivity(Intent(Settings.ACTION_SETTINGS), 0)?.activityInfo?.packageName }.getOrNull()
                ?: "com.android.settings"
            val started = runCatching { startAppError(shell.startApp(display.displayId, settings)) }.getOrElse { PhoneActionErrors.HELPER_UNAVAILABLE }
            if (started != null) { put(ID_START_APP, false, started); return }
            if (service == null) { put(ID_START_APP, false, "accessibility_required"); return }
            val onTop = poll(LAUNCH_WAIT_MS) { SnapshotReader.topPackage(service.windowsOn(display.displayId)) == settings }
            put(ID_START_APP, onTop, if (onTop) null else "not_on_display")
            if (!onTop) return

            poll(LAUNCH_WAIT_MS) { SnapshotReader.read(service.windowsOn(display.displayId), width, height).entries.isNotEmpty() }
            val read = SnapshotReader.read(service.windowsOn(display.displayId), width, height)
            val frame = display.awaitFrame(LAUNCH_WAIT_MS)
            val black = display.modelImage()?.black
            put(ID_READ_TREE, read.entries.isNotEmpty() && frame && black == false, when {
                read.entries.isEmpty() -> "empty_tree"
                !frame || black == null -> "no_frame"
                black -> "black_frame"
                else -> null
            })

            // A tap where nothing is clickable proves dispatch without changing any setting.
            val clickable = read.entries.filter { it.element.clickable }.map { e -> Rect().also { e.node.getBoundsInScreen(it) }.let { intArrayOf(it.left, it.top, it.right, it.bottom) } }
            val point = freePoint(width, height, clickable)
            if (point == null) put(ID_TAP, false, "no_free_point") else {
                val path = Path().apply { moveTo(point.first.toFloat(), point.second.toFloat()) }
                val gesture = runCatching { service.gesture(display.displayId, listOf(GestureDescription.StrokeDescription(path, 0, TAP_MS))) }.getOrDefault(GestureOutcome.UNCERTAIN)
                // Only a refused gesture is followed by an injection; an uncertain one may already have tapped.
                when (gesture) {
                    GestureOutcome.COMPLETED -> put(ID_TAP, true, null)
                    GestureOutcome.UNCERTAIN -> put(ID_TAP, false, "gesture_uncertain")
                    GestureOutcome.REFUSED -> {
                        val injected = runCatching { shell.injectTap(display.displayId, point.first, point.second) }.getOrDefault(false)
                        put(ID_TAP, injected, if (injected) "injection_only" else "tap_refused")
                    }
                }
            }

            val field = read.entries.firstOrNull { it.element.editable && !it.element.secret }?.node
            if (field == null) put(ID_TYPE, false, "no_text_field") else {
                val args = Bundle().apply { putCharSequence(AccessibilityNodeInfo.ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE, TYPE_PROBE) }
                field.performAction(AccessibilityNodeInfo.ACTION_FOCUS)
                val typed = field.performAction(AccessibilityNodeInfo.ACTION_SET_TEXT, args) &&
                    poll(ACTION_WAIT_MS) { field.refresh() && field.text?.toString() == TYPE_PROBE }
                field.performAction(AccessibilityNodeInfo.ACTION_SET_TEXT, Bundle().apply { putCharSequence(AccessibilityNodeInfo.ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE, "") })
                put(ID_TYPE, typed, if (typed) null else "text_not_set")
            }

            // Back may first close the keyboard; Settings must then leave the display's top or its tree must change.
            val before = SnapshotReader.hash(service.windowsOn(display.displayId))
            var accepted = false
            var left = false
            repeat(BACK_TRIES) {
                if (left) return@repeat
                accepted = runCatching { shell.injectKey(display.displayId, KeyEvent.KEYCODE_BACK) }.getOrDefault(false) || accepted
                left = poll(ACTION_WAIT_MS) {
                    SnapshotReader.topPackage(service.windowsOn(display.displayId)) != settings || SnapshotReader.hash(service.windowsOn(display.displayId)) != before
                }
            }
            put(ID_BACK, accepted && left, if (!accepted) "injection_refused" else if (!left) "no_effect" else null)
        } finally {
            created?.release()
            flags?.release()
        }
    }

    private fun poll(timeoutMs: Long, test: () -> Boolean): Boolean {
        val deadline = SystemClock.uptimeMillis() + timeoutMs
        while (true) {
            if (runCatching(test).getOrDefault(false)) return true
            if (SystemClock.uptimeMillis() >= deadline) return false
            Thread.sleep(POLL_MS)
        }
    }

    companion object {
        const val ID_HELPER = "helper"
        const val ID_CREATE_DISPLAY = "create_display"
        const val ID_START_APP = "start_app"
        const val ID_READ_TREE = "read_tree"
        const val ID_TAP = "tap"
        const val ID_TYPE = "type"
        const val ID_BACK = "back"
        const val ID_MAIN_FOCUS = "main_focus"
        /** Refusal while an agent run is active. */
        const val RUN_ACTIVE = "run_active"
        /** Contract order of the rows. */
        val IDS = listOf(ID_HELPER, ID_CREATE_DISPLAY, ID_START_APP, ID_READ_TREE, ID_TAP, ID_TYPE, ID_BACK, ID_MAIN_FOCUS)
        private const val TYPE_PROBE = "nova"
        private const val LAUNCH_WAIT_MS = 5_000L
        private const val ACTION_WAIT_MS = 2_000L
        private const val POLL_MS = 100L
        private const val TAP_MS = 80L
        private const val BACK_TRIES = 2
        /** Grid step of the free-point search, in pixels. */
        private const val GRID = 24

        /**
         * A point inside the display, away from the status-bar strip, that lies outside every rectangle in [clickable]
         * ([left, top, right, bottom] pixels), scanning from the bottom centre up; null when there is none.
         */
        internal fun freePoint(width: Int, height: Int, clickable: List<IntArray>): Pair<Int, Int>? {
            val margin = GRID
            var y = height - margin
            while (y >= height / 10) {
                for (x in listOf(width / 2) + (margin until width - margin step GRID)) if (clickable.none { x >= it[0] && x < it[2] && y >= it[1] && y < it[3] }) return x to y
                y -= GRID
            }
            return null
        }
    }
}
