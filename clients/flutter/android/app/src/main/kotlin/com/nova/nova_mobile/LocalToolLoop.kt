package com.nova.nova_mobile

import org.json.JSONObject

/** Model output is a proposal. This parser grants no authority to execute it. */
class ToolDecision private constructor(val kind: String, val summary: String, val action: JSONObject?) {
    companion object {
        fun parse(value: JSONObject): ToolDecision {
            require(value.keys().asSequence().all { it in setOf("kind", "summary", "action") }) { "invalid_model_decision" }
            val kind = value.getString("kind")
            require(kind in setOf("action", "complete", "wait")) { "invalid_model_decision" }
            val summary = value.getString("summary").trim()
            require(summary.isNotEmpty() && summary.length <= 2000) { "invalid_model_decision" }
            if (kind != "action") {
                require(!value.has("action") || value.isNull("action")) { "unexpected_action" }
                return ToolDecision(kind, summary, null)
            }
            val action = value.getJSONObject("action")
            val fields = when(action.getString("type")) {
                "tap" -> setOf("type", "x", "y")
                "swipe" -> setOf("type", "x", "y", "to_x", "to_y")
                "type" -> setOf("type", "text")
                "back" -> setOf("type")
                else -> throw IllegalArgumentException("unsupported_action")
            }
            require(action.keys().asSequence().toSet() == fields) { "invalid_action_fields" }
            for(key in fields - setOf("type", "text")) {
                val number = action.get(key)
                require(number is Number && number.toDouble().isFinite() && number.toDouble() in 0.0..1.0) { "invalid_coordinate" }
            }
            if("text" in fields) require(action.get("text") is String && action.getString("text").length <= 4000) { "invalid_input" }
            return ToolDecision(kind, summary, JSONObject(action.toString()))
        }
    }
}

/** One model tool loop. All state and side effects remain owned by Host. */
class LocalToolLoop(
    private val host: Host,
    private val model: (JSONObject, Int) -> ToolDecision,
    private val maxTurns: Int = 30
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
    private fun observeStable(): JSONObject {
        repeat(3) { attempt ->
            try { return host.observe() } catch (error: Exception) {
                val cause = rootCause(error)
                // A transition can invalidate a read after an already dispatched
                // action. Re-capture only; never repeat that action or its approval.
                if (!host.active() || attempt == 2 || cause !is IllegalStateException ||
                    cause.message != "screen_changed_during_capture") throw error
            }
        }
        error("unreachable")
    }
    fun run() {
        require(maxTurns in 1..100)
        var stage = "observation"
        try {
            repeat(maxTurns) { turn ->
                if(!host.active()) return
                stage = "observation"
                val observation = observeStable()
                if(!host.active()) return
                stage = "model"
                val decision = model(observation, turn)
                if(!host.active()) return
                stage = "tool"
                when(decision.kind) {
                    "complete" -> { host.finish(decision.summary); return }
                    "wait" -> { host.interrupt("model_needs_user"); return }
                    "action" -> {
                        val accepted = host.approve(decision, observation)
                        if(!host.active()) return
                        if(!accepted) { host.interrupt("approval_declined"); return }
                        val outcome = host.execute(decision.action!!)
                        if(!host.active()) return
                        if(outcome != "dispatched") { host.interrupt("action_outcome_$outcome"); return }
                    }
                }
            }
            if(host.active()) host.interrupt("step_limit")
        } catch(error: Exception) {
            // Do not expose provider bodies, credentials or screen text in errors.
            val cause = rootCause(error)
            val safeGuiCodes = setOf("screen_changed", "screen_changed_before_dispatch",
                "screen_changed_during_capture", "screen_unavailable", "outside_target_app",
                "approval_required", "accessibility_required", "blocking_gui_call_on_main")
            val safeModelCodes = setOf("invalid_model_decision", "unexpected_action", "unsupported_action",
                "invalid_action_fields", "invalid_coordinate", "invalid_input", "one_model_choice_required",
                "one_tool_call_required", "function_required", "unsupported_model_tool", "invalid_model_response")
            val reason = when {
                stage == "model" && cause is ModelHttpException -> "model_http_${cause.status}"
                stage == "model" && cause is java.net.UnknownHostException -> "model_dns_failed"
                stage == "model" && cause is java.net.SocketTimeoutException -> "model_timeout"
                stage == "model" && cause is javax.net.ssl.SSLException -> "model_tls_failed"
                stage == "model" && cause is org.json.JSONException -> "model_invalid_response"
                stage == "model" && cause is IllegalArgumentException && cause.message in safeModelCodes -> "model_${cause.message}"
                stage != "model" && cause.message in safeGuiCodes -> "${stage}_${cause.message}"
                else -> "${stage}_failed"
            }
            if(host.active()) host.interrupt(reason)
        }
    }
}
