package com.nova.nova_mobile.phone

import com.nova.nova_mobile.phone.shell.INovaShell

// Contract types for native phone control. Owned by the contract; see
// docs/specs/mobile-virtual-display.md. JSON keys are the snake_case names in `wire`/comments.

/** MethodChannel carrying JSON-string arguments and JSON-string results. */
const val PHONE_METHOD_CHANNEL = "nova/phone/v1"
const val PHONE_SCHEMA_VERSION = 1
/** Lowest API with the helper path (Android 12). Below it the tier is always MAIN. */
const val PHONE_VIRTUAL_MIN_API = 31
/** Lowest API where the virtual tier is first-class (Android 14). 31..33 are experimental. */
const val PHONE_VIRTUAL_STABLE_API = 34

/** How a run drives apps. Chosen once at run start and fixed for the run. */
enum class PhoneTier(val wire: String) {
    /** Helper virtual display: api >= 31, accessibility enabled and helper RUNNING. */
    VIRTUAL("virtual"),
    /** Existing main-screen accessibility path, behaviour unchanged. */
    MAIN("main"),
}

enum class PairingState(val wire: String) {
    UNPAIRED("unpaired"),
    /** Looking for the system pairing window over mDNS; `pairing_port` is set once found. */
    SEARCHING("searching"),
    PAIRED("paired"),
}

/** Mirrors the copied BuiltinShellStatus (phone-core) plus UNSUPPORTED for api < 31. */
enum class HelperState(val wire: String) {
    UNSUPPORTED("unsupported"),
    NOT_PAIRED("not_paired"),
    WIRELESS_DEBUGGING_OFF("wireless_debugging_off"),
    CONNECTING("connecting"),
    RUNNING("running"),
    /** `helper_failure` and `helper_fix` are set. */
    FAILED("failed"),
}

/** Mirrors BuiltinShellFailure; the UI maps each to copy and a [HelperFix] button. */
enum class HelperFailure(val wire: String, val fix: HelperFix) {
    WRONG_CODE("wrong_code", HelperFix.RE_PAIR),
    PAIRING_WINDOW_CLOSED("pairing_window_closed", HelperFix.RE_PAIR),
    NO_WIFI("no_wifi", HelperFix.OPEN_WIFI),
    /** Reserved: no secure-settings auto-enable permission or network-refusal detection. */
    WIFI_NOT_ALLOWED("wifi_not_allowed", HelperFix.OPEN_WIRELESS_DEBUGGING),
    CONNECT_FAILED("connect_failed", HelperFix.RETRY),
    AUTHORIZATION_REVOKED("authorization_revoked", HelperFix.RE_PAIR),
    KEY_UNREADABLE("key_unreadable", HelperFix.RE_PAIR),
    HELPER_START_FAILED("helper_start_failed", HelperFix.RETRY),
    UNKNOWN("unknown", HelperFix.RETRY),
}

enum class HelperFix(val wire: String) {
    RETRY("retry"),
    RE_PAIR("re_pair"),
    OPEN_WIFI("open_wifi"),
    OPEN_WIRELESS_DEBUGGING("open_wireless_debugging"),
}

/** `openSettings(kind)` targets. */
enum class SettingsKind(val wire: String) {
    ACCESSIBILITY("accessibility"),
    OVERLAY("overlay"),
    BATTERY("battery"),
    DEVELOPER("developer"),
    WIRELESS_DEBUGGING("wireless_debugging"),
    WIFI("wifi"),
}

/**
 * Result of `status`, also pushed as the `status` event. Wire keys: schema_version, api_level, tier,
 * experimental, accessibility, overlay, battery_whitelisted, pairing, pairing_port?, helper,
 * helper_failure?, helper_fix?, notifications_allowed, pairing_stage.
 */
data class PhoneStatus(
    val apiLevel: Int,
    val tier: PhoneTier,
    /** tier == VIRTUAL and apiLevel < [PHONE_VIRTUAL_STABLE_API]: the UI shows the focus warning. */
    val experimental: Boolean,
    val accessibility: Boolean,
    val overlay: Boolean,
    val batteryWhitelisted: Boolean,
    val pairing: PairingState,
    val pairingPort: Int?,
    val helper: HelperState,
    val helperFailure: HelperFailure?,
    val notificationsAllowed: Boolean = false,
    val pairingStage: String = "idle",
)

/**
 * Seam between M2 (pairing/helper) and M3 (display/agent). M2 implements it over HelperHub.
 * [shell] is the accepted, identity-checked Binder or null; it becomes null on helper death.
 * [need] asks the watchdog to (re)start the helper now; it never blocks and never throws.
 */
interface ShellProvider {
    val shell: INovaShell?
    fun need()
}

enum class TakeoverState(val wire: String) {
    /** hand_to_user or the user asked; the task is still on the virtual display. */
    REQUESTED("requested"),
    /** The task was moved to the main display; the agent loop is paused. */
    ACTIVE("active"),
    /** Moved back and resumed with a fresh observation. */
    RETURNED("returned"),
    TIMED_OUT("timed_out"),
    /** moveTask failed; the run is interrupted with `takeover_unavailable`. */
    FAILED("failed"),
}

/** Implemented by M3; called by the M2 channel handler for `takeover` / `handBack`. */
interface PhoneTakeover {
    fun takeover(taskId: String): TakeoverState
    fun handBack(taskId: String): TakeoverState
}

/** One `selfCheck` row. Wire: {id, ok, detail?}. Ids are listed in the contract doc. */
data class SelfCheckItem(val id: String, val ok: Boolean, val detail: String?)

/** Implemented by M3 (display + accessibility checks); M2 reports helper-only rows until it exists. */
interface PhoneSelfCheck {
    fun run(): List<SelfCheckItem>
}
