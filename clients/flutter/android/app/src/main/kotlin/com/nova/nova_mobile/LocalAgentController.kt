package com.nova.nova_mobile

import android.content.Context
import android.hardware.display.DisplayManager
import android.os.Build
import android.os.SystemClock
import android.provider.Settings
import android.util.DisplayMetrics
import android.view.Display
import androidx.annotation.RequiresApi
import com.nova.nova_mobile.phone.DoneOutcome
import com.nova.nova_mobile.phone.PhoneActionErrors
import com.nova.nova_mobile.phone.PhoneDoneEvent
import com.nova.nova_mobile.phone.PhoneEventSink
import com.nova.nova_mobile.phone.PhoneTakeover
import com.nova.nova_mobile.phone.PhoneTier
import com.nova.nova_mobile.phone.RunIdleGate
import com.nova.nova_mobile.phone.RunTakeover
import com.nova.nova_mobile.phone.ShellProvider
import com.nova.nova_mobile.phone.TakeoverState
import com.nova.nova_mobile.phone.VirtualSelfCheck
import com.nova.nova_mobile.phone.onMainLooper
import com.nova.nova_mobile.phone.a11y.PHONE_EXPERIMENTAL_ACK
import com.nova.nova_mobile.phone.a11y.PHONE_PREFERENCES
import com.nova.nova_mobile.phone.a11y.RuntimeFlagLeases
import com.nova.nova_mobile.phone.a11y.VirtualRunGate
import com.nova.nova_mobile.phone.a11y.VirtualRunHost
import com.nova.nova_mobile.phone.a11y.VirtualScope
import com.nova.nova_mobile.phone.a11y.VirtualScreen
import com.nova.nova_mobile.phone.a11y.phoneTierFor
import com.nova.nova_mobile.phone.display.AgentDisplay
import com.nova.nova_mobile.phone.display.LazyAgentDisplay
import com.nova.nova_mobile.phone.toJson
import org.json.JSONArray
import org.json.JSONObject
import java.util.UUID
import java.util.concurrent.Executors
import android.os.Handler
import android.os.Looper

/** The native command boundary used by a local planner. State sync has no path
 * into this controller. The UI can always stop a run without a Hub or model.
 * [shells] and [events] come from the phone bridge; without a running helper every run stays on the main tier. */
class LocalAgentController(context: Context, spaceId: String, private val shells: ShellProvider? = null,
    private val events: PhoneEventSink? = null) : PhoneTakeover, RunIdleGate {
    private val app = context.applicationContext
    private val journal=LocalAgentJournal(context.applicationContext, spaceId)
    private val settings = LocalModelSettings(context.applicationContext, spaceId)
    private val loopWorker = Executors.newSingleThreadExecutor()
    private val main = Handler(Looper.getMainLooper())
    /**
     * A virtual-tier run's display, takeover, loop host and runtime a11y flag lease. [releaseFlags] runs synchronously
     * when the run ends, before another run can be admitted; [close] (takeover and display) may run later.
     */
    private class VirtualRun(val screen: VirtualScreen, val takeover: RunTakeover, val host: VirtualRunHost) {
        @Volatile var flags: RuntimeFlagLeases.Lease? = null
        private var closed = false
        fun releaseFlags() { flags?.release() }
        @Synchronized fun close() {
            if(closed) return
            closed = true
            takeover.cancel()
            runCatching { screen.close() }
        }
    }
    private data class Active(val id:String,val secret:String,val fence:RunFence,var observation:JSONObject?=null,
        var target:String?=null, var model:LocalGuiModel?=null, var approval:ActionApproval?=null,
        val tier:PhoneTier=PhoneTier.MAIN, val startedAt:Long=SystemClock.elapsedRealtime(), var virtual:VirtualRun?=null)
    @Volatile private var active:Active?=null
    @Volatile private var closed=false
    init { journal.recover() }
    @Synchronized fun start(request:JSONObject):JSONObject = start(request, PhoneTier.MAIN)
    /** A virtual run gets 15 min: 5 min of agent time plus up to 10 min of takeover. */
    private fun budgetMs(tier:PhoneTier) = if(tier==PhoneTier.VIRTUAL) 900000L else 300000L
    @Synchronized private fun start(request:JSONObject, tier:PhoneTier):JSONObject {
        check(!closed) { "space_changed" }
        val id=request.getString("id");require(id.length in 1..100)
        val prior=journal.task(id)
        if(prior!=null){
            require(prior.getString("goal")==request.getString("goal")&&prior.getString("acceptance")==request.getString("acceptance")){"task_id_conflict"}
            return prior
        }
        check(active==null){"another_task_is_active"}
        val service=LocalGuiService.current?:throw IllegalStateException("accessibility_required")
        // The self-check holds the runtime a11y flag; no run may observe while it is set.
        check(service.virtualFlagLeases==0){"another_task_is_active"}
        // A failed restoration may have left that flag set: retry it, and admit no run of either tier until it succeeds.
        check(service.restoreVirtualFlags()){RuntimeFlagLeases.ACCESSIBILITY_FLAGS_FAILED}
        val goal=request.getString("goal").trim();val acceptance=request.getString("acceptance").trim()
        val todo=request.optJSONObject("todo_ref")
        if(todo!=null)require(todo.keys().asSequence().toSet()==setOf("id","version") && todo.getString("id").length in 1..200 && todo.get("version") is Int && todo.getInt("version")>0){"invalid_todo_reference"}
        require(goal.isNotEmpty()&&goal.length<=4000&&acceptance.isNotEmpty()&&acceptance.length<=2000){"goal_and_acceptance_required"}
        val budget=budgetMs(tier)
        val run=Active(id,UUID.randomUUID().toString(),RunFence(id,SystemClock.elapsedRealtime()+budget,30),tier=tier)
        val record=JSONObject().put("id",id).put("goal",goal).put("acceptance",acceptance).put("phase","running").put("created_at",System.currentTimeMillis()).put("control_token",run.secret).put("actions",JSONArray())
        if(todo!=null)record.put("todo_ref",todo)
        journal.save(record);active=run
        service.onStop={stop(id)}
        service.onUnavailable={interrupt(id,"accessibility_unavailable")}
        service.showStop()
        main.postDelayed({ if(active===run) interrupt(id,"time_limit") },budget)
        return record
    }
    @Synchronized fun close() {
        closed=true
        active?.let { interrupt(it.id, "space_changed") }
        loopWorker.shutdownNow()
        // Let an interrupted worker finish writing its old scoped journal; never
        // substitute the new Space's store under an existing task.
    }
    fun modelSettings() = settings.status()
    @Synchronized fun clearChatGptSettings():JSONObject {
        active?.let { stop(it.id) }
        settings.clearChatGpt()
        return settings.status()
    }
    @Synchronized fun saveModelSettings(value:JSONObject):JSONObject {
        check(!closed) { "space_changed" }
        check(active==null){"stop_task_before_changing_model"}
        settings.save(value)
        return settings.status()
    }
    @Synchronized fun runModel(request:JSONObject):JSONObject {
        check(!closed) { "space_changed" }
        journal.task(request.getString("id"))?.let { previous ->
            require(previous.optJSONObject("todo_ref")?.toString()==request.optJSONObject("todo_ref")?.toString()){"task_id_conflict"}
            require(previous.getString("goal")==request.getString("goal") && previous.getString("acceptance")==request.getString("acceptance") && previous.optString("target_package")==request.getString("target_package")){"task_id_conflict"}
            return previous
        }
        val config=settings.read()?:throw IllegalStateException("model_settings_required")
        val target=request.getString("target_package")
        require(target.matches(Regex("[A-Za-z][A-Za-z0-9_]*(\\.[A-Za-z0-9_]+)+"))){"invalid_target_app"}
        // The tier is chosen once here and fixed for the run. Android 12/13 need the user's experimental acknowledgement.
        val tier=shells?.let { phoneTierFor(Build.VERSION.SDK_INT, LocalGuiService.current!=null, it.shell!=null, experimentalAcknowledged()) } ?: PhoneTier.MAIN
        check(tier!=PhoneTier.VIRTUAL || target!=app.packageName){PhoneActionErrors.APP_NOT_ALLOWED}
        val record=start(request, tier)
        val run=active!!
        run.target=target
        run.model=LocalGuiModel(config)
        record.put("target_package",target).put("execution_mode","native_model").put("authorization_mode","automatic").put("model",config.model).put("model_endpoint",config.endpoint).put("tier",tier.wire)
        journal.save(record)
        if(Build.VERSION.SDK_INT>=31 && tier==PhoneTier.VIRTUAL) {
            try { startVirtual(run, target) } catch(_:Exception) { return interrupt(run.id,"virtual_setup_failed")!! }
            loopWorker.execute { runVirtual(run) }
            return record
        }
        loopWorker.execute {
            try {
                // The user's Start command explicitly selects and launches this app.
                // Even this deterministic action is journaled before it reaches Android.
                val action=JSONObject().put("type","launch").put("package",target)
                val attempt="${run.id}:launch"
                synchronized(this) {
                    check(active===run && run.fence.claim(run.fence.token(),SystemClock.elapsedRealtime())){"task_stopped"}
                    check(journal.beginAttempt(attempt,run.id,action)) {"launch_already_recorded"}
                }
                val result=try {
                    LocalGuiService.current!!.perform(action,JSONObject()){active===run && run.fence.allowsAfterClaim(run.fence.token(),SystemClock.elapsedRealtime())}
                } catch(_:Exception) {"unknown"}
                journal.finishAttempt(attempt,result)
                if(result!="dispatched") {interrupt(run.id,"launch_outcome_$result");return@execute}
                Thread.sleep(700)
                val control=JSONObject().put("id",run.id).put("control_token",run.secret)
                LocalToolLoop(object:LocalToolLoop.Host {
                    override fun active():Boolean = this@LocalAgentController.active===run && run.fence.allowsAfterClaim(run.fence.token(),SystemClock.elapsedRealtime())
                    override fun observe():JSONObject {
                        val observation=this@LocalAgentController.observe(control)
                        check(observation.getString("package")==target){"outside_target_app"}
                        return observation
                    }
                    override fun approve(decision:ToolDecision,observation:JSONObject)=authorizeAction(run,decision,observation)
                    override fun execute(action:JSONObject)=this@LocalAgentController.execute(JSONObject(control.toString()).put("attempt_id",UUID.randomUUID().toString()).put("action",action)).getString("state")
                    override fun finish(summary:String) {this@LocalAgentController.finish(JSONObject(control.toString()).put("summary",summary))}
                    override fun interrupt(reason:String) {this@LocalAgentController.interrupt(run.id,reason)}
                },{ observation,turn -> run.model!!.decide(journal.task(run.id)!!,observation,turn) },maxTurns=29,initialLaunchGrace=true).run()
            } catch(_:Exception) {interrupt(run.id,"native_loop_failed")}
            finally { if(active===run) interrupt(run.id,"execution_interrupted") }
        }
        return record
    }
    @RequiresApi(31)
    private fun startVirtual(run:Active, target:String) {
        val service=LocalGuiService.current?:throw IllegalStateException("accessibility_required")
        val provider=shells!!
        val metrics=DisplayMetrics()
        @Suppress("DEPRECATION") app.getSystemService(DisplayManager::class.java).getDisplay(Display.DEFAULT_DISPLAY).getRealMetrics(metrics)
        val width=minOf(metrics.widthPixels,metrics.heightPixels);val height=maxOf(metrics.widthPixels,metrics.heightPixels)
        val ime=VirtualScope.imePackage(Settings.Secure.getString(app.contentResolver,Settings.Secure.DEFAULT_INPUT_METHOD))
        val scope=VirtualScope(target,app.packageName,ime)
        // Created by the run's first open_app; the helper binder is captured then and checked on every call.
        val display=LazyAgentDisplay(width,height) {
            AgentDisplay(provider.shell?:throw IllegalStateException(PhoneActionErrors.HELPER_UNAVAILABLE),width,height,metrics.densityDpi,events)
        }
        val screen=VirtualScreen(service,provider,display,scope)
        val takeover=RunTakeover(run.id,screen.takeoverPort(),{ event -> events?.emit(event.toJson()) },SystemClock::elapsedRealtime,onMainLooper)
        val host=VirtualRunHost(run.id,scope,screen,takeover,virtualGate(run),events?.let { sink -> { event:JSONObject -> sink.emit(event) } })
        // Owned by the run before anything is acquired, so the run's end releases whatever was set up.
        val virtual=VirtualRun(screen,takeover,host)
        run.virtual=virtual
        virtual.flags=service.acquireVirtualFlags { interrupt(run.id,"accessibility_unavailable") }
    }
    private fun experimentalAcknowledged()=app.getSharedPreferences(PHONE_PREFERENCES,Context.MODE_PRIVATE).getBoolean(PHONE_EXPERIMENTAL_ACK,false)
    /** Self-check admission: [block] runs only while no run is active, atomically with run admission; else `run_active`. */
    @Synchronized override fun <T> whileIdle(block:()->T):T {
        check(active==null){VirtualSelfCheck.RUN_ACTIVE}
        return block()
    }
    private fun runVirtual(run:Active) {
        try {
            val virtual=run.virtual!!
            // The user's Start command explicitly selects this app; its launch is the run's first open_app.
            val outcome=try { virtual.host.launch("${run.id}:launch") } catch(error:Exception) {
                val code=rootCause(error).let { if(it is IllegalStateException) it.message else null }
                interrupt(run.id,if(code in VirtualRunHost.NOTHING_DISPATCHED || code==PhoneActionErrors.APP_NOT_ALLOWED) "launch_$code" else "launch_failed")
                return
            }
            if(outcome!="dispatched") { interrupt(run.id,"launch_outcome_$outcome"); return }
            LocalToolLoop(virtual.host,{ observation,turn ->
                virtual.host.decided(run.model!!.decide(journal.task(run.id)!!,observation,turn,PhoneTier.VIRTUAL))
            },maxTurns=29,initialLaunchGrace=true).run()
        } catch(_:Exception) {interrupt(run.id,"native_loop_failed")}
        finally { if(active===run) interrupt(run.id,"execution_interrupted") }
    }
    private fun rootCause(error:Throwable):Throwable {
        var cause=error
        repeat(8) { cause.cause?.let { if(it!==cause) cause=it } }
        return cause
    }
    /** RunFence, ActionApproval and journal for a virtual run; same rules as [execute]. Evidence is the snapshot id. */
    private fun virtualGate(run:Active)=object:VirtualRunGate {
        override fun active()=this@LocalAgentController.active===run && run.fence.allowsAfterClaim(run.fence.token(),SystemClock.elapsedRealtime())
        override fun approve(action:JSONObject,evidence:String)=authorize(run,action,evidence)
        override fun begin(attemptId:String,action:JSONObject,evidence:String?) = synchronized(this@LocalAgentController) {
            val now=SystemClock.elapsedRealtime()
            check(this@LocalAgentController.active===run){"stale_or_stopped_task"}
            if(evidence!=null) check(run.approval?.consume(action.toString(),evidence,now)==true){"approval_required"}
            check(run.fence.claim(run.fence.token(),now)){"stale_or_stopped_task"}
            check(journal.beginAttempt(attemptId,run.id,action)){"attempt_already_recorded"}
        }
        override fun finish(attemptId:String,action:JSONObject,outcome:String,evidence:String?) {
            journal.finishAttempt(attemptId,outcome)
            synchronized(this@LocalAgentController) {
                val task=journal.task(run.id)!!
                task.getJSONArray("actions").put(JSONObject().put("attempt_id",attemptId).put("action",action).put("outcome",outcome).put("observation",evidence?:JSONObject.NULL))
                journal.save(task)
            }
        }
        override fun complete(summary:String,evidence:String) = synchronized(this@LocalAgentController) {
            check(this@LocalAgentController.active===run && run.fence.allows(run.fence.token(),SystemClock.elapsedRealtime())){"stale_or_stopped_task"}
            val text=summary.trim();require(text.isNotEmpty()&&text.length<=2000)
            val task=journal.task(run.id)!!
            task.put("phase","verifying").put("summary",text).put("evidence",evidence)
            journal.save(task);endRun(run,DoneOutcome.COMPLETED,null,text)
        }
        override fun interrupt(reason:String) { this@LocalAgentController.interrupt(run.id,reason) }
    }
    private fun virtualRun(taskId:String):VirtualRun {
        val run=active
        check(run!=null && run.id==taskId){"task_not_running"}
        return run.virtual?:throw IllegalStateException("task_not_running")
    }
    /** User "I'll do it": moves the run's app to the main display now; the loop pauses at its next step. */
    override fun takeover(taskId:String):TakeoverState = virtualRun(taskId).takeover.request(byModel=false,reason=null)
    /** User "done": moves the app back; the loop resumes with a fresh observation. */
    override fun handBack(taskId:String):TakeoverState = virtualRun(taskId).takeover.handBack()
    /** Starting a task authorizes its steps within the selected app. Keep a
     * single-use, screen-bound permit, but never wait for a per-step UI approval. */
    @Synchronized private fun authorizeAction(run:Active,decision:ToolDecision,observation:JSONObject):Boolean {
        val now=SystemClock.elapsedRealtime()
        if(active!==run || !run.fence.allows(run.fence.token(),now))return false
        check(observation.getString("package")==run.target){"outside_target_app"}
        return authorize(run,decision.action!!,observation.getString("fingerprint"))
    }
    /** Replaces the run's permit with one for [action] on the observation [evidence] (fingerprint or snapshot id). */
    @Synchronized private fun authorize(run:Active,action:JSONObject,evidence:String):Boolean {
        val now=SystemClock.elapsedRealtime()
        if(active!==run || !run.fence.allows(run.fence.token(),now))return false
        run.approval?.cancel()
        val approval=ActionApproval(UUID.randomUUID().toString(),action.toString(),evidence,now+90000)
        run.approval=approval
        return approval.resolve(approval.id,true,now)
    }
    @Synchronized fun interrupt(id:String,reason:String):JSONObject? {
        val run=active
        if(run?.id!=id)return journal.task(id)
        endRun(run,DoneOutcome.INTERRUPTED,reason,null)
        val task=journal.task(id)!!
        task.remove("proposal")
        task.put("phase","interrupted").put("reason",reason).put("summary","执行已暂停，请核对 App 后重新委托；不会自动重复未确认的动作。")
        journal.save(task)
        return task
    }
    private fun endRun(run:Active,outcome:DoneOutcome,reason:String?,summary:String?) {
        run.fence.stop();run.approval?.cancel()
        // The main-tier tree must be unchanged for the next run: restore the a11y flag before admitting one.
        run.virtual?.let { virtual -> runCatching { virtual.releaseFlags() } }
        active=null
        run.model?.let { model -> Thread { runCatching { model.cancel() } }.apply { isDaemon=true;start() } }
        LocalGuiService.current?.hideStop()
        // Release the display off the caller's thread: it may wait for a display being created.
        run.virtual?.let { virtual -> Thread { virtual.close() }.apply { isDaemon=true;start() } }
        if(run.tier==PhoneTier.VIRTUAL) runCatching {
            events?.emit(PhoneDoneEvent(run.id,outcome,reason,summary,run.virtual?.host?.steps?:0,SystemClock.elapsedRealtime()-run.startedAt).toJson())
        }
    }
    private fun requireRun(request:JSONObject):Active {
        val run=active?:throw IllegalStateException("task_not_running")
        // The external planner commands drive the main screen only.
        check(run.tier==PhoneTier.MAIN){"stale_or_stopped_task"}
        check(run.id==request.getString("id")&&run.secret==request.getString("control_token")&&run.fence.allows(run.fence.token(),SystemClock.elapsedRealtime())){"stale_or_stopped_task"}
        return run
    }
    fun observe(request:JSONObject):JSONObject {
        val run=requireRun(request);val token=run.fence.token()
        val observation=(LocalGuiService.current?:throw IllegalStateException("accessibility_required")).observe(run.target)
        synchronized(this){
            check(active===run&&run.fence.allows(token,SystemClock.elapsedRealtime())){"stale_or_stopped_task"}
            run.observation=observation
        }
        return observation
    }
    fun execute(request:JSONObject):JSONObject {
        val action=request.getJSONObject("action");val attemptId=request.getString("attempt_id")
        require(attemptId.length in 1..100)
        val prior=journal.attempt(attemptId)
        if(prior!=null){
            require(prior.getString("task_id")==request.getString("id")&&prior.getJSONObject("action").toString()==action.toString()){"attempt_id_conflict"}
            return prior
        }
        val run=requireRun(request);val token=run.fence.token()
        val service=LocalGuiService.current?:throw IllegalStateException("accessibility_required")
        val previous=run.observation?:throw IllegalStateException("observation_required")
        val fresh=service.observe(run.target)
        check(fresh.getString("fingerprint")==previous.getString("fingerprint")){"screen_changed"}
        synchronized(this){
            if(run.target!=null) {
                check(fresh.getString("package")==run.target){"outside_target_app"}
                check(run.approval?.consume(action.toString(),fresh.getString("fingerprint"),SystemClock.elapsedRealtime())==true){"approval_required"}
            }
            check(active===run&&run.fence.claim(token,SystemClock.elapsedRealtime())){"stale_or_stopped_task"}
            check(journal.beginAttempt(attemptId,run.id,action)){"attempt_already_recorded"}
        }
        val outcome=try {
            service.perform(action,fresh){active===run&&run.fence.allowsAfterClaim(token,SystemClock.elapsedRealtime())}
        }catch(_:Exception){"unknown"}
        journal.finishAttempt(attemptId,outcome)
        synchronized(this){
            val task=journal.task(run.id)!!
            task.getJSONArray("actions").put(JSONObject().put("attempt_id",attemptId).put("action",action).put("outcome",outcome).put("observation",fresh.getString("fingerprint")))
            if(active===run&&outcome!="dispatched"){
                endRun(run,DoneOutcome.INTERRUPTED,"action_outcome_$outcome",null);task.put("phase","interrupted").put("summary","动作结果为 $outcome，请核对 App；不会自动重做。")
            }
            journal.save(task)
        }
        return journal.attempt(attemptId)!!
    }
    @Synchronized fun stop(id:String):JSONObject? {
        val run=active
        if(run?.id==id)endRun(run,DoneOutcome.CANCELLED,null,null)
        val task=journal.task(id)?:return null
        if(task.optString("phase") in listOf("running","waiting_approval","verifying")) {
            task.put("phase","cancelled").put("summary","用户已停止；已派发的动作可能已生效，请核对 App。")
            task.remove("proposal")
            journal.save(task)
        }
        return task
    }
    @Synchronized fun finish(request:JSONObject):JSONObject {
        val run=requireRun(request)
        val observation=run.observation?:throw IllegalStateException("observation_required")
        val summary=request.getString("summary").trim();require(summary.isNotEmpty()&&summary.length<=2000)
        val task=journal.task(run.id)!!
        task.put("phase","verifying").put("summary",summary).put("evidence",observation.getString("fingerprint"))
        journal.save(task);endRun(run,DoneOutcome.COMPLETED,null,summary)
        return task
    }
    @Synchronized fun verify(id:String):JSONObject {
        val task=journal.task(id)?:throw IllegalArgumentException("task_not_found")
        check(task.optString("phase")=="verifying"&&task.has("evidence")){"task_not_ready_for_verification"}
        task.put("phase","completed").put("verified_by","user").put("verified_at",System.currentTimeMillis());journal.save(task)
        return task
    }
    fun tasks()=JSONArray(journal.tasks())
}
