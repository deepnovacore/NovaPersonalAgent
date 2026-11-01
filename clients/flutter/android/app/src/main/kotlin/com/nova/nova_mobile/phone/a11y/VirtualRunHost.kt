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
/** Existing replanning code; a takeover that started since the observation refuses the effect with it. */
const val SCREEN_CHANGED = "screen_changed"
/** Not a contract code: the effect may have happened (cancelled, timed-out or failed mid-way); the host journals `unknown`. */
const val EFFECT_UNKNOWN = "effect_unknown"

/** An effect was refused at admission ([EXECUTION_STOPPED] or [SCREEN_CHANGED]); nothing of it was dispatched. */
class EffectRefused(code: String) : IllegalStateException(code)

/**
 * Admission of each effect on the run's display. [admit] executes [effect] only while the run may act and no takeover
 * started since the observation, and holds off takeover moves until [effect] returns; otherwise it throws
 * [EffectRefused]. Every effect, including a fallback after a refused first try, is admitted on its own.
 */
interface EffectAdmission {
    fun <T> admit(effect: () -> T): T
}

/** Result of one accessibility gesture. Only [REFUSED] (rejected before dispatch) proves that nothing happened. */
enum class GestureOutcome { COMPLETED, REFUSED, UNCERTAIN }

/**
 * One gesture, then the helper injection only when the system refused the gesture before dispatching it. A cancelled,
 * timed-out or interrupted gesture may already have acted: it throws [EFFECT_UNKNOWN] and is never injected again.
 */
fun gestureOrInjection(effects: EffectAdmission, gesture: () -> GestureOutcome, inject: () -> Boolean): Boolean =
    when (effects.admit(gesture)) {
        GestureOutcome.COMPLETED -> true
        GestureOutcome.UNCERTAIN -> throw IllegalStateException(EFFECT_UNKNOWN)
        GestureOutcome.REFUSED -> effects.admit(inject)
    }

/**
 * Typing as two effects, each admitted on its own: [focus] (only when [needsFocus]), then [setText]. A stop or takeover
 * between them refuses [setText]. A focus call that ran may have acted (a false result can also be an IPC timeout), so
 * that refusal throws [EFFECT_UNKNOWN]; without a focus call it stays an [EffectRefused] (nothing was dispatched).
 */
fun focusThenSetText(effects: EffectAdmission, needsFocus: Boolean, focus: () -> Unit, setText: () -> Boolean): Boolean {
    if (needsFocus) effects.admit(focus)
    return try { effects.admit(setText) } catch (e: EffectRefused) {
        if (needsFocus) throw IllegalStateException(EFFECT_UNKNOWN)
        throw e
    }
}

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
     * Dispatches [prepared] once, every effect through [effects], and waits briefly for the display to settle. A definite
     * pre-effect failure throws IllegalStateException with a code in [VirtualRunHost.NOTHING_DISPATCHED] (an
     * [EffectRefused] passes through unchanged); any other exception means the effect is unknown.
     */
    fun dispatch(prepared: PreparedAction, effects: EffectAdmission): DispatchResult
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
    /** [RunTakeover.generation] when [observation] was read: any later takeover invalidates its plan and prepared actions. */
    private var observedGeneration = 0
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
        val generation = takeover.generation
        val prepared = device.prepare(PhoneAction.OpenApp(scope.target))
        return journaled(attemptId, action, null, prepared, scope.target, generation)
    }

    override fun active(): Boolean = gate.active()

    override fun observe(): JSONObject {
        repeat(SCOPE_TAKEOVERS + 1) {
            awaitTakeover()
            // Read before the snapshot: a takeover that starts while reading invalidates it.
            val generation = takeover.generation
            val snapshot = try { device.snapshot() } catch (e: IllegalStateException) {
                // A user takeover that started meanwhile moved the app to the main display on purpose.
                if (e.message == PhoneActionErrors.DISPLAY_UNAVAILABLE && takeover.pending) return@repeat
                throw e
            }
            if (scope.allows(snapshot.packageName)) {
                observedOnce = true
                observedGeneration = generation
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
        val observed = observation ?: throw IllegalStateException("observation_required")
        val evidence = observed.getString("snapshot_id")
        // A takeover since the observation moved the app: the plan is stale, never dispatch it.
        if (takeover.pending || takeover.generation != observedGeneration) {
            awaitTakeover()
            throw IllegalStateException(SCREEN_CHANGED)
        }
        // On a secure page only back and hand_to_user run; anything else hands the screen to the user.
        if (observed.getBoolean("secure_frame") && parsed !is PhoneAction.Back && parsed !is PhoneAction.HandToUser) securePage()
        val attemptId = newAttemptId()
        if (parsed is PhoneAction.HandToUser) return handToUser(attemptId, action, parsed, evidence)
        if (!scope.allows(device.topPackage())) throw IllegalStateException(SCREEN_CHANGED)
        val prepared = device.prepare(parsed)
        // Typing and submitting are labelled by a fixed text: field names and summaries can carry typed text.
        val label = when (parsed) {
            is PhoneAction.Type -> TYPE_LABEL
            PhoneAction.Submit -> SUBMIT_LABEL
            else -> summary ?: prepared.label ?: scope.target
        }
        return journaled(attemptId, action, evidence, prepared, label, observedGeneration)
    }

    override fun finish(summary: String) = gate.complete(summary, (observation ?: throw IllegalStateException("observation_required")).getString("snapshot_id"))

    override fun interrupt(reason: String) = gate.interrupt(reason)

    /**
     * Nothing is dispatched on a secure page: a takeover (`secure_page`) starts and the plan is stale, so the loop
     * observes again after the hand-back. Without a takeover the run ends with `secure_page`.
     */
    private fun securePage(): Nothing {
        if (takeover.request(byModel = true, reason = SECURE_PAGE) == TakeoverState.ACTIVE) throw IllegalStateException(SCREEN_CHANGED)
        gate.interrupt(SECURE_PAGE)
        throw IllegalStateException(PhoneActionErrors.TAKEOVER_UNAVAILABLE)
    }

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

    /**
     * Each effect is admitted only while the run is active and no takeover started since [generation]; the check and the
     * effect hold off takeover moves together. A stop is never blocked: an effect admitted before it counts as earlier.
     */
    private fun admission(generation: Int) = object : EffectAdmission {
        override fun <T> admit(effect: () -> T): T = takeover.withoutMoves {
            if (!gate.active()) throw EffectRefused(EXECUTION_STOPPED)
            if (takeover.pending || takeover.generation != generation) throw EffectRefused(SCREEN_CHANGED)
            effect()
        }
    }

    /** Journal once, dispatch once. A definite failure is `rejected` and keeps its code; anything else is `unknown`. */
    private fun journaled(attemptId: String, action: JSONObject, evidence: String?, prepared: PreparedAction, label: String, generation: Int): String {
        val step = startStep(prepared.tool, label, prepared.ref)
        try { gate.begin(attemptId, action, evidence) } catch (e: Exception) { endStep(step, prepared.tool, label, prepared.ref, StepStatus.FAILED, null); throw e }
        val result = try { device.dispatch(prepared, admission(generation)) } catch (e: Exception) {
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
            SCREEN_CHANGED,
            PhoneActionErrors.APP_IN_USE_ON_MAIN,
            PhoneActionErrors.APP_NOT_LAUNCHABLE,
            PhoneActionErrors.DISPLAY_UNAVAILABLE,
            PhoneActionErrors.HELPER_UNAVAILABLE,
        )
        /** Out-of-scope foregrounds handed to the user per observation before the run stops. */
        private const val SCOPE_TAKEOVERS = 2
        private const val LABEL_MAX = 200
        /** Step label of every `type` action. */
        const val TYPE_LABEL = "输入文字"
        /** Step label of every `submit` action. */
        const val SUBMIT_LABEL = "提交"
        /** Takeover reason and run reason when a non-allowed action meets a secure frame. */
        const val SECURE_PAGE = "secure_page"
    }
}
