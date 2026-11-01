package com.nova.nova_mobile.phone

import org.json.JSONObject

// Event and frame channel contract. See docs/development/mobile-virtual-display.md "Channels".

/** EventChannel of JSON strings, each an object with `type` in [PhoneEventType]. */
const val PHONE_EVENT_CHANNEL = "nova/phone/events"
/** EventChannel of raw JPEG bytes (Uint8List in Dart), pushed only while preview is visible. */
const val PHONE_FRAME_CHANNEL = "nova/phone/frames"
const val PHONE_FRAME_MAX_FPS = 8
const val PHONE_FRAME_MIN_WIDTH = 360
const val PHONE_FRAME_MAX_WIDTH = 480
const val PHONE_FRAME_JPEG_QUALITY = 65

enum class PhoneEventType(val wire: String) {
    /** {type, status: PhoneStatus} on any status change. */
    STATUS("status"),
    /** [PhoneStepEvent]. */
    STEP("step"),
    /** [PhoneTakeoverEvent]. */
    TAKEOVER("takeover"),
    /** [PhoneDoneEvent]; last event of a task. */
    DONE("done"),
}

enum class StepStatus(val wire: String) {
    RUNNING("running"),
    COMPLETED("completed"),
    FAILED("failed"),
    /** Dispatched but the effect could not be confirmed (journal "unknown"). */
    UNKNOWN("unknown"),
}

/**
 * Wire: {type:"step", task_id, step, tool, label, status, changed?, ref?, tier}.
 * The same (task_id, step) is sent as RUNNING then once more with its final status.
 * [tool] is the action type (`tap`, `type`, `scroll`, `swipe`, `open_app`, `back`, `hand_to_user`) or `observe`.
 * [label] is the model summary, else the element name or package; never typed text or secret names.
 */
data class PhoneStepEvent(
    val taskId: String,
    val step: Int,
    val tool: String,
    val label: String,
    val status: StepStatus,
    val changed: Boolean?,
    val ref: String?,
    val tier: PhoneTier,
)

/** Wire: {type:"takeover", task_id, state, by:"model"|"user", reason?}. */
data class PhoneTakeoverEvent(val taskId: String, val state: TakeoverState, val byModel: Boolean, val reason: String?)

enum class DoneOutcome(val wire: String) { COMPLETED("completed"), FAILED("failed"), CANCELLED("cancelled"), INTERRUPTED("interrupted") }

/** Wire: {type:"done", task_id, outcome, reason?, summary?, steps, duration_ms}. reason is a safe code, never provider text. */
data class PhoneDoneEvent(
    val taskId: String,
    val outcome: DoneOutcome,
    val reason: String?,
    val summary: String?,
    val steps: Int,
    val durationMs: Long,
)

/**
 * Seam: M2's channel bridge implements it, M3's run/display code emits into it. Implementations
 * post to the platform thread and drop silently when Dart has no listener.
 */
interface PhoneEventSink {
    fun emit(event: JSONObject)
    /** Emits only when [previewVisible]; callers throttle to [PHONE_FRAME_MAX_FPS] and skip identical frames. */
    fun frame(jpeg: ByteArray)
    /** True while the frame channel has a listener and the last `setPreview` was visible:true. */
    val previewVisible: Boolean
}
