package com.nova.nova_mobile.phone

import org.json.JSONObject

// Model action schema for ToolDecision.action. Rules: docs/development/mobile-virtual-display.md "Action schema".

enum class ScrollDirection(val wire: String) { UP("up"), DOWN("down"), LEFT("left"), RIGHT("right") }

/** A validated model proposal. Validation grants no authority to execute (ActionApproval still applies). */
sealed interface PhoneAction {
    /** {type:"tap", ref, snapshot_id} — virtual tier only. */
    data class TapRef(val ref: String, val snapshotId: String) : PhoneAction
    /** {type:"tap", x, y} — x, y in 0.0..1.0 of the observed frame (existing contract). */
    data class TapPoint(val x: Double, val y: Double) : PhoneAction
    /** {type:"swipe", x, y, to_x, to_y} — existing contract, both tiers. */
    data class Swipe(val x: Double, val y: Double, val toX: Double, val toY: Double) : PhoneAction
    /** {type:"type", text, ref?, snapshot_id?} — without ref, the focused input on the run's display. */
    data class Type(val text: String, val ref: String?, val snapshotId: String?) : PhoneAction
    /** {type:"scroll", direction, ref?, snapshot_id?} — virtual tier only; without ref, the largest scrollable. */
    data class Scroll(val direction: ScrollDirection, val ref: String?, val snapshotId: String?) : PhoneAction
    /** {type:"open_app", package} — virtual tier only; launches on the run's virtual display. */
    data class OpenApp(val packageName: String) : PhoneAction
    /** {type:"back"}. */
    data object Back : PhoneAction
    /** {type:"hand_to_user", reason} — virtual tier only; starts a takeover, needs no ActionApproval. */
    data class HandToUser(val reason: String) : PhoneAction
}

/**
 * Error codes. Parse codes are thrown as IllegalArgumentException(code) and reported as `model_<code>`;
 * execution codes as IllegalStateException(code) and reported as `tool_<code>`.
 */
object PhoneActionErrors {
    // Parse (existing).
    const val UNSUPPORTED_ACTION = "unsupported_action"
    const val INVALID_ACTION_FIELDS = "invalid_action_fields"
    const val INVALID_COORDINATE = "invalid_coordinate"
    const val INVALID_INPUT = "invalid_input"
    // Parse (new).
    const val INVALID_REF = "invalid_ref"
    const val INVALID_SNAPSHOT_ID = "invalid_snapshot_id"
    const val INVALID_DIRECTION = "invalid_direction"
    const val INVALID_PACKAGE = "invalid_package"
    const val INVALID_REASON = "invalid_reason"
    // Execution (new). REF_EXPIRED re-observes like screen_changed; it never retries the old action.
    const val REF_EXPIRED = "ref_expired"
    const val REF_NOT_EDITABLE = "ref_not_editable"
    const val REF_NOT_SCROLLABLE = "ref_not_scrollable"
    const val APP_IN_USE_ON_MAIN = "app_in_use_on_main"
    const val APP_NOT_ALLOWED = "app_not_allowed"
    const val DISPLAY_UNAVAILABLE = "display_unavailable"
    const val HELPER_UNAVAILABLE = "helper_unavailable"
    const val TAKEOVER_UNAVAILABLE = "takeover_unavailable"
    const val TAKEOVER_TIMEOUT = "takeover_timeout"
    // Execution (existing, reused).
    const val NO_FOCUSED_INPUT = "no_focused_input"
    const val PRIVATE_INPUT_REQUIRES_USER = "private_input_requires_user"
    const val APP_NOT_LAUNCHABLE = "app_not_launchable"
}

/** Pure, deterministic validation of one `action` object for [tier]. Implemented by M3 inside ToolDecision. */
fun interface PhoneActionParser {
    fun parse(action: JSONObject, tier: PhoneTier): PhoneAction
}
