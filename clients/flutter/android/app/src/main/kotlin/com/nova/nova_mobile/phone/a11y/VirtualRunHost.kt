package com.nova.nova_mobile.phone.a11y

import com.nova.nova_mobile.LocalToolLoop
import com.nova.nova_mobile.ToolActionParser
import com.nova.nova_mobile.ToolDecision
import com.nova.nova_mobile.phone.PhoneAction
import com.nova.nova_mobile.phone.PhoneActionErrors
import com.nova.nova_mobile.phone.PhoneSnapshot
import com.nova.nova_mobile.phone.PhoneStepEvent
import com.nova.nova_mobile.phone.PhoneTier
import com.nova.nova_mobile.phone.RunTakeover
import com.nova.nova_mobile.phone.StepStatus
import com.nova.nova_mobile.phone.TakeoverState
import com.nova.nova_mobile.phone.toJson
import org.json.JSONObject
import java.util.UUID

/** Thrown by [VirtualDevice.dispatch] when the run's fence closed before the effect; nothing was dispatched. */
const val EXECUTION_STOPPED = "execution_stopped"
/** Existing observation code: the display shows a package outside the run's [VirtualScope]. */
const val OUTSIDE_TARGET_APP = "outside_target_app"

/** An action resolved against the current display. [ref] is the model's ref; [label] an element name or package, never typed text. */
open class PreparedAction(val tool: String, val ref: String?, val label: String?)

/** [outcome] is a journal outcome (`dispatched`/`rejected`); [changed] whether the display's tree changed afterwards. */
class DispatchResult(val outcome: String, val changed: Boolean?)

/** The run's virtual display as the loop host uses it: [VirtualScreen] on a device, a fake in JVM tests. */
interface VirtualDevice {
    /** Foreground package of the display, or null when nothing readable is shown. */
    fun topPackage(): String?
    /** Reads and registers a numbered snapshot with the latest frame. */
    fun snapshot(): PhoneSnapshot
    /**
     * Resolves [action] without any effect on the display (except creating it for `open_app`). Throws the contract codes
     * `ref_expired`, `ref_not_editable`, `ref_not_scrollable`, `no_focused_input`, `private_input_requires_user`,
     * `app_not_allowed`, `display_unavailable` or `helper_unavailable`.
     */
    fun prepare(action: PhoneAction): PreparedAction
    /**
     * Dispatches [prepared] once if [allowed] still holds and waits briefly for the display to settle. A definite
     * pre-effect failure throws IllegalStateException with a code in [VirtualRunHost.NOTHING_DISPATCHED]; any other
     * exception means the effect is unknown.
     */
    fun dispatch(prepared: PreparedAction, allowed: () -> Boolean): DispatchResult
    /** After a takeover every ref is stale. */
    fun forgetRefs()
}

/** The controller's run state for a virtual run: RunFence, ActionApproval and LocalAgentJournal with unchanged semantics. */
interface VirtualRunGate {
    /** The run is current and its fence still allows work. */
    fun active(): Boolean
    /** Issues the single-use permit for [action] proposed on the observation [evidence] (its snapshot id). */
    fun approve(action: JSONObject, evidence: String): Boolean
    /**
     * Before any effect: consumes the permit for [evidence] (null: the action needs none), claims a fence step and journals
     * [attemptId]. Throws IllegalStateException when any of these fails.
     */
    fun begin(attemptId: String, action: JSONObject, evidence: String?)
    /** Records the attempt's outcome in the journal and the task's action list. */
    fun finish(attemptId: String, action: JSONObject, outcome: String, evidence: String?)
    /** The model proposes completion on the observation [evidence]. */
    fun complete(summary: String, evidence: String)
    fun interrupt(reason: String)
}

/**
 * [LocalToolLoop.Host] of a virtual-tier run. Observations are numbered snapshots of the run's display within [scope];
 * actions are parsed for the virtual tier, resolved before they are journaled (so `ref_expired` replans without any
 * effect), journaled once through [gate] and dispatched once. An out-of-scope foreground after the first observation and
 * `hand_to_user` start a [takeover]; the loop blocks in the next observation until it returns, and every ref is then stale.
 * Step events go to [emit]; labels never contain typed text.
 */
class VirtualRunHost(
    private val taskId: String,
    private val scope: VirtualScope,
    private val device: VirtualDevice,
    private val takeover: RunTakeover,
    private val gate: VirtualRunGate,
    private val emit: ((JSONObject) -> Unit)?,
    private val newAttemptId: () -> String = { UUID.randomUUID().toString() },
) : LocalToolLoop.Host {
    /** Steps reported as step events so far. */
    @Volatile var steps = 0
        private set
    private var observation: JSONObject? = null
    private var observedOnce = false
    private var observedReturns = 0
    private var seenReturns = 0
    private var summary: String? = null

    /** Records the model's summary as the next step label; an `observe` decision is reported as its own step. */
    fun decided(decision: ToolDecision): ToolDecision {
        summary = decision.summary
        if (decision.kind == "observe") {
            val step = startStep("observe", decision.summary, null)
            endStep(step, "observe", decision.summary, null, StepStatus.COMPLETED, null)
        }
        return decision
    }

    /** The run's own launch of the target: the first `open_app`, which creates the display. Returns the journal outcome. */
    fun launch(attemptId: String): String {
        val action = JSONObject().put("type", "open_app").put("package", scope.target)
        val prepared = device.prepare(PhoneAction.OpenApp(scope.target))
        return journaled(attemptId, action, null, prepared, scope.target)
    }

    override fun active(): Boolean = gate.active()

    override fun observe(): JSONObject {
        repeat(SCOPE_TAKEOVERS + 1) {
            awaitTakeover()
            val snapshot = device.snapshot()
            if (scope.allows(snapshot.packageName)) {
                observedOnce = true
                observedReturns = takeover.returns
                return snapshot.toJson().also { observation = it }
            }
            // The launch grace waits for the target; afterwards the user resolves the foreground app.
            if (!observedOnce) throw IllegalStateException(OUTSIDE_TARGET_APP)
            if (takeover.request(byModel = true, reason = OUTSIDE_TARGET_APP) == TakeoverState.FAILED) throw IllegalStateException(OUTSIDE_TARGET_APP)
        }
        throw IllegalStateException(OUTSIDE_TARGET_APP)
    }

    override fun approve(decision: ToolDecision, observation: JSONObject): Boolean {
        if (decision.phoneAction is PhoneAction.HandToUser) return gate.active()
        return gate.approve(decision.action!!, observation.getString("snapshot_id"))
    }

    override fun execute(action: JSONObject): String {
        val parsed = ToolActionParser.parse(action, PhoneTier.VIRTUAL)
        val evidence = (observation ?: throw IllegalStateException("observation_required")).getString("snapshot_id")
        // A takeover since the observation moved the app: the plan is stale, never dispatch it.
        if (takeover.pending || takeover.returns != observedReturns) {
            awaitTakeover()
            throw IllegalStateException("screen_changed")
        }
        val attemptId = newAttemptId()
        if (parsed is PhoneAction.HandToUser) return handToUser(attemptId, action, parsed, evidence)
        if (!scope.allows(device.topPackage())) throw IllegalStateException("screen_changed")
        val prepared = device.prepare(parsed)
        val label = if (parsed is PhoneAction.Type) prepared.label ?: scope.target else summary ?: prepared.label ?: scope.target
        return journaled(attemptId, action, evidence, prepared, label)
    }

    override fun finish(summary: String) = gate.complete(summary, (observation ?: throw IllegalStateException("observation_required")).getString("snapshot_id"))

    override fun interrupt(reason: String) = gate.interrupt(reason)

    private fun handToUser(attemptId: String, action: JSONObject, parsed: PhoneAction.HandToUser, evidence: String): String {
        val step = startStep("hand_to_user", parsed.reason, null)
        try { gate.begin(attemptId, action, null) } catch (e: Exception) { endStep(step, "hand_to_user", parsed.reason, null, StepStatus.FAILED, null); throw e }
        if (takeover.request(byModel = true, reason = parsed.reason) != TakeoverState.ACTIVE) {
            gate.finish(attemptId, action, "rejected", evidence)
            endStep(step, "hand_to_user", parsed.reason, null, StepStatus.FAILED, null)
            throw IllegalStateException(PhoneActionErrors.TAKEOVER_UNAVAILABLE)
        }
        gate.finish(attemptId, action, "dispatched", evidence)
        endStep(step, "hand_to_user", parsed.reason, null, StepStatus.COMPLETED, null)
        return "dispatched"
    }

    /** Journal once, dispatch once. A definite failure is `rejected` and keeps its code; anything else is `unknown`. */
    private fun journaled(attemptId: String, action: JSONObject, evidence: String?, prepared: PreparedAction, label: String): String {
        val step = startStep(prepared.tool, label, prepared.ref)
        try { gate.begin(attemptId, action, evidence) } catch (e: Exception) { endStep(step, prepared.tool, label, prepared.ref, StepStatus.FAILED, null); throw e }
        val result = try { device.dispatch(prepared, gate::active) } catch (e: Exception) {
            val code = rootCause(e).let { if (it is IllegalStateException) it.message else null }
            if (code in NOTHING_DISPATCHED) {
                gate.finish(attemptId, action, "rejected", evidence)
                endStep(step, prepared.tool, label, prepared.ref, StepStatus.FAILED, null)
                throw IllegalStateException(code)
            }
            gate.finish(attemptId, action, "unknown", evidence)
            endStep(step, prepared.tool, label, prepared.ref, StepStatus.UNKNOWN, null)
            return "unknown"
        }
        gate.finish(attemptId, action, result.outcome, evidence)
        val status = if (result.outcome == "dispatched") StepStatus.COMPLETED else StepStatus.FAILED
        endStep(step, prepared.tool, label, prepared.ref, status, result.changed)
        return result.outcome
    }

    private fun awaitTakeover() {
        when (takeover.await(gate::active)) {
            TakeoverState.TIMED_OUT -> throw IllegalStateException(PhoneActionErrors.TAKEOVER_TIMEOUT)
            TakeoverState.FAILED -> throw IllegalStateException(PhoneActionErrors.TAKEOVER_UNAVAILABLE)
            else -> Unit
        }
        if (takeover.returns != seenReturns) {
            seenReturns = takeover.returns
            device.forgetRefs()
        }
    }

    private fun startStep(tool: String, label: String, ref: String?): Int {
        val step = ++steps
        send(PhoneStepEvent(taskId, step, tool, label.take(LABEL_MAX), StepStatus.RUNNING, null, ref, PhoneTier.VIRTUAL))
        return step
    }

    private fun endStep(step: Int, tool: String, label: String, ref: String?, status: StepStatus, changed: Boolean?) =
        send(PhoneStepEvent(taskId, step, tool, label.take(LABEL_MAX), status, changed, ref, PhoneTier.VIRTUAL))

    private fun send(event: PhoneStepEvent) { emit?.let { sink -> runCatching { sink(event.toJson()) } } }

    private fun rootCause(error: Throwable): Throwable {
        var cause = error
        repeat(8) { cause.cause?.let { if (it !== cause) cause = it } }
        return cause
    }

    companion object {
        /** Codes a dispatch throws before any effect: the attempt is journaled `rejected` and the code is reported. */
        val NOTHING_DISPATCHED = setOf(
            EXECUTION_STOPPED,
            PhoneActionErrors.APP_IN_USE_ON_MAIN,
            PhoneActionErrors.APP_NOT_LAUNCHABLE,
            PhoneActionErrors.DISPLAY_UNAVAILABLE,
            PhoneActionErrors.HELPER_UNAVAILABLE,
        )
        /** Out-of-scope foregrounds handed to the user per observation before the run stops. */
        private const val SCOPE_TAKEOVERS = 2
        private const val LABEL_MAX = 200
    }
}
