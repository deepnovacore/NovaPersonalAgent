// Derived from Mika (https://github.com/wangzan101/Mika, Apache-2.0, commit 5f630d9),
// Copyright 2026 wangzan101. Modified by Nova: slim 14-method subset of IMikaShell with English contract docs.
package com.nova.nova_mobile.phone.shell;

import android.view.Surface;

/**
 * Privileged service running as the shell user (uid 2000) inside the Nova helper process
 * (`app_process`, launched over the device's own wireless-debugging adbd). Contract:
 * docs/specs/mobile-virtual-display.md.
 *
 * Every call is rejected with SecurityException unless Binder.getCallingUid() is Nova's app uid.
 * "Own display" means a display created by this service instance through createDisplay and not yet
 * released; every display-scoped method fails closed (false / -1 / null / START_ERROR) otherwise,
 * so a wrong id (for example the main display 0) can never act on the user's screen.
 * Transaction ids are explicit and must never be renumbered or reused.
 */
interface INovaShell {
    // startApp results.
    const int START_OK = 0;
    /** The package has a visible task on the main display; nothing was started. */
    const int START_IN_USE_ON_MAIN = 1;
    /** The package has no launchable entry activity. */
    const int START_NOT_FOUND = 2;
    /** Not an own display, the main display could not be inspected, or the launch failed. */
    const int START_ERROR = 3;
    /** The package is already running on another own display. */
    const int START_IN_USE_BY_OTHER = 7;

    // Bits reported by displayFlags (DisplayManager.VIRTUAL_DISPLAY_FLAG_*).
    const int FLAG_TRUSTED = 1024;
    const int FLAG_OWN_FOCUS = 16384;

    /**
     * Creates a virtual display rendering into surface. Tries the trusted flag set first and retries
     * without trusted-only flags only on SecurityException. Sets the IME policy so the keyboard stays
     * on this display. Returns the new display id, or -1.
     */
    int createDisplay(in Surface surface, int width, int height, int dpi) = 1;

    /** Releases an own display; its content is destroyed (DESTROY_CONTENT_ON_REMOVAL). No-op otherwise. */
    void releaseDisplay(int displayId) = 2;

    /** Flags actually used for an own display (see FLAG_*), or -1. Self-check reads FLAG_OWN_FOCUS. */
    int displayFlags(int displayId) = 3;

    /** Launches the package's entry activity on an own display. Returns a START_* code. */
    int startApp(int displayId, String packageName) = 4;

    /** Task id at the top of an own display, or -1. */
    int topTaskId(int displayId) = 5;

    /** Class name of the top activity on an own display, or null. */
    String topActivity(int displayId) = 6;

    /** Display currently holding the task, or -1 when the task no longer exists. */
    int displayOfTask(int taskId) = 7;

    /**
     * Moves a root task between displays (takeover). Allowed only when the task is on an own display and
     * the target is the main display (0), or the task was moved out by this service during this binding
     * and the target is an own display. Returns false otherwise or on failure.
     */
    boolean moveTask(int taskId, int displayId) = 8;

    /** Injects key down/up on an own display. Only navigation/editing keys are allowed (no volume, power, home, recents, assist, camera, media). */
    boolean injectKey(int displayId, int keyCode) = 9;

    /** Injects a tap at display pixels (x, y) on an own display. */
    boolean injectTap(int displayId, int x, int y) = 10;

    /**
     * One-finger stroke on an own display: at times[i] ms after down the finger is at (xs[i], ys[i]).
     * 2..1024 points, times[0] == 0, non-decreasing, last <= 10000 ms. Returns after the last event;
     * false when arguments are invalid or the down event was not injected. Up is always sent after down.
     */
    boolean injectStroke(int displayId, in int[] xs, in int[] ys, in long[] times) = 11;

    /** [uid, pid] of the helper process; the app compares it to the handoff caller before accepting. */
    int[] identity() = 12;

    /** Releases every own display and forgets moved tasks. The process stays alive for the next handoff. */
    void releaseAll() = 13;

    /** releaseAll() and exit the helper process (unpair / uninstall path). */
    void destroy() = 14;
}
