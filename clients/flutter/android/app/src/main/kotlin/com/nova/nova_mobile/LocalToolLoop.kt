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
    fun run() {
        require(maxTurns in 1..100)
        var stage = "observation"
        try {
            repeat(maxTurns) { turn ->
                if(!host.active()) return
                stage = "observation"
                val observation = host.observe()
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
            val reason = when {
                stage == "model" && error is ModelHttpException -> "model_http_${error.status}"
                stage == "model" && error is java.net.UnknownHostException -> "model_dns_failed"
                stage == "model" && error is java.net.SocketTimeoutException -> "model_timeout"
                stage == "model" && error is javax.net.ssl.SSLException -> "model_tls_failed"
                else -> "${stage}_failed"
            }
            if(host.active()) host.interrupt(reason)
        }
    }
}
