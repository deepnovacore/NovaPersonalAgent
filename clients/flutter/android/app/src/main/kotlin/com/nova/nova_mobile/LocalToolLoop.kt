package com.nova.nova_mobile

import com.nova.nova_mobile.phone.PhoneAction
import com.nova.nova_mobile.phone.PhoneActionErrors
import com.nova.nova_mobile.phone.PhoneActionParser
import com.nova.nova_mobile.phone.PhoneTier
import com.nova.nova_mobile.phone.SNAPSHOT_ID_PREFIX
import com.nova.nova_mobile.phone.SNAPSHOT_REF
import com.nova.nova_mobile.phone.ScrollDirection
import org.json.JSONObject

/**
 * Contract action parser (docs/specs/mobile-virtual-display.md "Action schema"): exact key sets, no I/O.
 * MAIN keeps the legacy tap/swipe/type/back set with its original checks and error codes.
 */
object ToolActionParser : PhoneActionParser {
    private val MAIN_FIELDS = mapOf(
        "tap" to setOf("type", "x", "y"),
        "swipe" to setOf("type", "x", "y", "to_x", "to_y"),
        "type" to setOf("type", "text"),
        "back" to setOf("type"),
    )
    private val PACKAGE = Regex("^[A-Za-z][A-Za-z0-9_]*(\\.[A-Za-z0-9_]+)+$")
    private val REF_KEYS = setOf("ref", "snapshot_id")

    override fun parse(action: JSONObject, tier: PhoneTier): PhoneAction {
        val type = action.getString("type")
        val keys = action.keys().asSequence().toSet()
        if(tier == PhoneTier.MAIN) {
            val fields = MAIN_FIELDS[type] ?: throw IllegalArgumentException(PhoneActionErrors.UNSUPPORTED_ACTION)
            require(keys == fields) { PhoneActionErrors.INVALID_ACTION_FIELDS }
            val numbers = (fields - setOf("type", "text")).associateWith { coordinate(action, it) }
            return when(type) {
                "tap" -> PhoneAction.TapPoint(numbers.getValue("x"), numbers.getValue("y"))
                "swipe" -> PhoneAction.Swipe(numbers.getValue("x"), numbers.getValue("y"), numbers.getValue("to_x"), numbers.getValue("to_y"))
                "type" -> PhoneAction.Type(text(action), null, null)
                else -> PhoneAction.Back
            }
        }
        fun fields(vararg names: String) = setOf("type", *names)
        return when(type) {
            "tap" -> when(keys) {
                fields("ref", "snapshot_id") -> PhoneAction.TapRef(ref(action), snapshotId(action))
                fields("x", "y") -> PhoneAction.TapPoint(coordinate(action, "x"), coordinate(action, "y"))
                else -> throw IllegalArgumentException(PhoneActionErrors.INVALID_ACTION_FIELDS)
            }
            "swipe" -> {
                require(keys == fields("x", "y", "to_x", "to_y")) { PhoneActionErrors.INVALID_ACTION_FIELDS }
                PhoneAction.Swipe(coordinate(action, "x"), coordinate(action, "y"), coordinate(action, "to_x"), coordinate(action, "to_y"))
            }
            "type" -> {
                val referenced = optionalRef(keys, fields("text"))
                val text = text(action)
                if(referenced) PhoneAction.Type(text, ref(action), snapshotId(action)) else PhoneAction.Type(text, null, null)
            }
            "scroll" -> {
                val referenced = optionalRef(keys, fields("direction"))
                val name = action.get("direction")
                val direction = ScrollDirection.entries.firstOrNull { it.wire == name } ?: throw IllegalArgumentException(PhoneActionErrors.INVALID_DIRECTION)
                if(referenced) PhoneAction.Scroll(direction, ref(action), snapshotId(action)) else PhoneAction.Scroll(direction, null, null)
            }
            "open_app" -> {
                require(keys == fields("package")) { PhoneActionErrors.INVALID_ACTION_FIELDS }
                val name = action.get("package")
                require(name is String && name.length <= 255 && PACKAGE.matches(name)) { PhoneActionErrors.INVALID_PACKAGE }
                PhoneAction.OpenApp(name)
            }
            "back" -> {
                require(keys == fields()) { PhoneActionErrors.INVALID_ACTION_FIELDS }
                PhoneAction.Back
            }
            "hand_to_user" -> {
                require(keys == fields("reason")) { PhoneActionErrors.INVALID_ACTION_FIELDS }
                val reason = (action.get("reason") as? String)?.trim()
                require(reason != null && reason.length in 1..500) { PhoneActionErrors.INVALID_REASON }
                PhoneAction.HandToUser(reason)
            }
            else -> throw IllegalArgumentException(PhoneActionErrors.UNSUPPORTED_ACTION)
        }
    }

    /** [keys] is [base] (false) or [base] plus ref and snapshot_id (true); anything else is invalid. */
    private fun optionalRef(keys: Set<String>, base: Set<String>): Boolean = when(keys) {
        base -> false
        base + REF_KEYS -> true
        else -> throw IllegalArgumentException(PhoneActionErrors.INVALID_ACTION_FIELDS)
    }
    private fun coordinate(action: JSONObject, key: String): Double {
        val number = action.get(key)
        require(number is Number && number.toDouble().isFinite() && number.toDouble() in 0.0..1.0) { PhoneActionErrors.INVALID_COORDINATE }
        return number.toDouble()
    }
    private fun text(action: JSONObject): String {
        val text = action.get("text")
        require(text is String && text.length <= 4000) { PhoneActionErrors.INVALID_INPUT }
        return text
    }
    private fun ref(action: JSONObject): String {
        val ref = action.get("ref")
        require(ref is String && SNAPSHOT_REF.matches(ref)) { PhoneActionErrors.INVALID_REF }
        return ref
    }
    private fun snapshotId(action: JSONObject): String {
        val id = action.get("snapshot_id")
        require(id is String && id.length in 1..64 && id.startsWith(SNAPSHOT_ID_PREFIX)) { PhoneActionErrors.INVALID_SNAPSHOT_ID }
        return id
    }
}

/** Model output is a proposal. This parser grants no authority to execute it. [phoneAction] is [action] validated for [tier]. */
class ToolDecision private constructor(val kind: String, val summary: String, val action: JSONObject?, val tier: PhoneTier, val phoneAction: PhoneAction?) {
    companion object {
        fun parse(value: JSONObject, tier: PhoneTier = PhoneTier.MAIN): ToolDecision {
            require(value.keys().asSequence().all { it in setOf("kind", "summary", "action") }) { "invalid_model_decision" }
            val kind = value.getString("kind")
            require(kind in setOf("action", "complete", "wait", "observe")) { "invalid_model_decision" }
            val summary = value.getString("summary").trim()
            require(summary.isNotEmpty() && summary.length <= 2000) { "invalid_model_decision" }
            if (kind != "action") {
                require(!value.has("action") || value.isNull("action")) { "unexpected_action" }
                return ToolDecision(kind, summary, null, tier, null)
            }
            val action = value.getJSONObject("action")
            val parsed = ToolActionParser.parse(action, tier)
            return ToolDecision(kind, summary, JSONObject(action.toString()), tier, parsed)
        }
    }
}

/** One model tool loop. All state and side effects remain owned by Host. */
class LocalToolLoop(
    private val host: Host,
    private val model: (JSONObject, Int) -> ToolDecision,
    private val maxTurns: Int = 30,
    private val initialLaunchGrace: Boolean = false
) {
    interface Host {
        fun active(): Boolean
        fun observe(): JSONObject
        fun approve(decision: ToolDecision, observation: JSONObject): Boolean
        fun execute(action: JSONObject): String
        fun finish(summary: String)
        fun interrupt(reason: String)
    }
    private fun rootCause(error: Throwable): Throwable {
        var cause = error
        repeat(8) { cause.cause?.let { if (it !== cause) cause = it } }
        return cause
    }
    private fun observeStable(launching: Boolean = false): JSONObject {
        var captureRetries = 0
        var launchRetries = 0
        while(true) {
            try { return host.observe() } catch (error: Exception) {
                val cause = rootCause(error)
                if(!host.active() || cause !is IllegalStateException) throw error
                // Only the first observation may wait for the explicitly launched app.
                // The service rejects other packages before taking a screenshot.
                if(launching && cause.message == "outside_target_app" && launchRetries++ < 5) {
                    Thread.sleep(500)
                    if(!host.active()) throw error
                    continue
                }
                // Re-capture a transition only; never repeat a dispatched action.
                val throttled = cause.message == "screenshot_unavailable_3"
                if((cause.message != "screen_changed_during_capture" && !throttled) || captureRetries++ >= 2) throw error
                // Android's screenshot rate limit is a read failure with no effect.
                Thread.sleep(if(throttled) 500 else 200)
                if(!host.active()) throw error
            }
        }
    }
    fun run() {
        require(maxTurns in 1..100)
        var stage = "observation"
        var stalePlans = 0
        var loadingObservations = 0
        try {
            repeat(maxTurns) { turn ->
                if(!host.active()) return
                stage = "observation"
                val observation = observeStable(initialLaunchGrace && turn == 0)
                if(!host.active()) return
                stage = "model"
                val decision = model(observation, turn)
                if(!host.active()) return
                stage = "tool"
                when(decision.kind) {
                    "complete" -> { host.finish(decision.summary); return }
                    "wait" -> { host.interrupt("model_needs_user"); return }
                    "observe" -> {
                        // Loading is a read-only wait, never a replay of the last effect.
                        if(loadingObservations++ >= 3) { host.interrupt("model_observation_limit"); return }
                        Thread.sleep(1000)
                    }
                    "action" -> {
                        val accepted = host.approve(decision, observation)
                        if(!host.active()) return
                        if(!accepted) { host.interrupt("approval_declined"); return }
                        val outcome = try { host.execute(decision.action!!) } catch(error: Exception) {
                            val cause = rootCause(error)
                            if(!host.active()) return
                            // Both capture changes and stale frames occur before beginAttempt.
                            // Observe and ask the model again; never retry the old action.
                            // Errors after journaling are returned as unknown and stop the run.
                            // An expired ref (virtual tier) is the same: the element is gone or moved.
                            if(cause is IllegalStateException && cause.message in setOf("screen_changed", "screen_changed_during_capture", PhoneActionErrors.REF_EXPIRED) && stalePlans < 3) {
                                stalePlans++
                                Thread.sleep(200)
                                return@repeat
                            }
                            throw error
                        }
                        if(!host.active()) return
                        if(outcome != "dispatched") { host.interrupt("action_outcome_$outcome"); return }
                        stalePlans = 0
                        loadingObservations = 0
                    }
                }
            }
            if(host.active()) host.interrupt("step_limit")
        } catch(error: Exception) {
            // Do not expose provider bodies, credentials or screen text in errors.
            val cause = rootCause(error)
            val safeGuiCodes = setOf("screen_changed", "screen_changed_before_dispatch",
                "screen_changed_during_capture", "screen_unavailable", "outside_target_app",
                "approval_required", "accessibility_required", "blocking_gui_call_on_main",
                PhoneActionErrors.REF_EXPIRED, PhoneActionErrors.REF_NOT_EDITABLE, PhoneActionErrors.REF_NOT_SCROLLABLE,
                PhoneActionErrors.NO_FOCUSED_INPUT, PhoneActionErrors.PRIVATE_INPUT_REQUIRES_USER,
                PhoneActionErrors.APP_NOT_LAUNCHABLE, PhoneActionErrors.APP_IN_USE_ON_MAIN, PhoneActionErrors.APP_NOT_ALLOWED,
                PhoneActionErrors.DISPLAY_UNAVAILABLE, PhoneActionErrors.HELPER_UNAVAILABLE,
                PhoneActionErrors.TAKEOVER_UNAVAILABLE, PhoneActionErrors.TAKEOVER_TIMEOUT)
            val safeModelCodes = setOf("invalid_model_decision", "unexpected_action", "unsupported_action",
                "invalid_action_fields", "invalid_coordinate", "invalid_input", "one_model_choice_required",
                "one_tool_call_required", "function_required", "unsupported_model_tool", "invalid_model_response",
                PhoneActionErrors.INVALID_REF, PhoneActionErrors.INVALID_SNAPSHOT_ID, PhoneActionErrors.INVALID_DIRECTION,
                PhoneActionErrors.INVALID_PACKAGE, PhoneActionErrors.INVALID_REASON)
            val reason = when {
                stage == "model" && cause is ModelHttpException -> "model_http_${cause.status}"
                stage == "model" && cause is java.net.UnknownHostException -> "model_dns_failed"
                stage == "model" && cause is java.net.SocketTimeoutException -> "model_timeout"
                stage == "model" && cause is javax.net.ssl.SSLException -> "model_tls_failed"
                stage == "model" && cause is org.json.JSONException -> "model_invalid_response"
                stage == "model" && cause is IllegalArgumentException && cause.message in safeModelCodes -> "model_${cause.message}"
                stage != "model" && cause is java.util.concurrent.TimeoutException -> "${stage}_timeout"
                stage != "model" && cause is IllegalStateException && cause.message?.matches(Regex("screenshot_unavailable_[0-9]+")) == true -> "${stage}_${cause.message}"
                stage != "model" && cause.message in safeGuiCodes -> "${stage}_${cause.message}"
                else -> "${stage}_failed"
            }
            if(host.active()) host.interrupt(reason)
        }
    }
}
