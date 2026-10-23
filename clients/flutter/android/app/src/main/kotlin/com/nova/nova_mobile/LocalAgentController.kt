package com.nova.nova_mobile

import android.content.Context
import android.os.SystemClock
import org.json.JSONArray
import org.json.JSONObject
import java.util.UUID
import java.util.concurrent.Executors
import android.os.Handler
import android.os.Looper

/** The native command boundary used by a local planner. State sync has no path
 * into this controller. The UI can always stop a run without a Hub or model. */
class LocalAgentController(context: Context, spaceId: String) {
    private val journal=LocalAgentJournal(context.applicationContext, spaceId)
    private val settings = LocalModelSettings(context.applicationContext, spaceId)
    private val loopWorker = Executors.newSingleThreadExecutor()
    private val main = Handler(Looper.getMainLooper())
    private data class Active(val id:String,val secret:String,val fence:RunFence,var observation:JSONObject?=null,
        var target:String?=null, var model:LocalGuiModel?=null, var approval:ActionApproval?=null)
    @Volatile private var active:Active?=null
    @Volatile private var closed=false
    init { journal.recover() }
    @Synchronized fun start(request:JSONObject):JSONObject {
        check(!closed) { "space_changed" }
        val id=request.getString("id");require(id.length in 1..100)
        val prior=journal.task(id)
        if(prior!=null){
            require(prior.getString("goal")==request.getString("goal")&&prior.getString("acceptance")==request.getString("acceptance")){"task_id_conflict"}
            return prior
        }
        check(active==null){"another_task_is_active"}
        val service=LocalGuiService.current?:throw IllegalStateException("accessibility_required")
        val goal=request.getString("goal").trim();val acceptance=request.getString("acceptance").trim()
        val todo=request.optJSONObject("todo_ref")
        if(todo!=null)require(todo.keys().asSequence().toSet()==setOf("id","version") && todo.getString("id").length in 1..200 && todo.get("version") is Int && todo.getInt("version")>0){"invalid_todo_reference"}
        require(goal.isNotEmpty()&&goal.length<=4000&&acceptance.isNotEmpty()&&acceptance.length<=2000){"goal_and_acceptance_required"}
        val run=Active(id,UUID.randomUUID().toString(),RunFence(id,SystemClock.elapsedRealtime()+300000,30))
        val record=JSONObject().put("id",id).put("goal",goal).put("acceptance",acceptance).put("phase","running").put("created_at",System.currentTimeMillis()).put("control_token",run.secret).put("actions",JSONArray())
        if(todo!=null)record.put("todo_ref",todo)
        journal.save(record);active=run
        service.onStop={stop(id)}
        service.onUnavailable={interrupt(id,"accessibility_unavailable")}
        service.showStop()
        main.postDelayed({ if(active===run) interrupt(id,"time_limit") },300000)
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
        val record=start(request)
        val run=active!!
        run.target=target
        run.model=LocalGuiModel(config)
        record.put("target_package",target).put("execution_mode","native_model").put("authorization_mode","automatic").put("model",config.model).put("model_endpoint",config.endpoint)
        journal.save(record)
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
    /** Starting a task authorizes its steps within the selected app. Keep a
     * single-use, screen-bound permit, but never wait for a per-step UI approval. */
    @Synchronized private fun authorizeAction(run:Active,decision:ToolDecision,observation:JSONObject):Boolean {
        val now=SystemClock.elapsedRealtime()
        if(active!==run || !run.fence.allows(run.fence.token(),now))return false
        check(observation.getString("package")==run.target){"outside_target_app"}
        run.approval?.cancel()
        val approval=ActionApproval(UUID.randomUUID().toString(),decision.action!!.toString(),observation.getString("fingerprint"),now+90000)
        run.approval=approval
        return approval.resolve(approval.id,true,now)
    }
    @Synchronized fun interrupt(id:String,reason:String):JSONObject? {
        val run=active
        if(run?.id!=id)return journal.task(id)
        endRun(run)
        val task=journal.task(id)!!
        task.remove("proposal")
        task.put("phase","interrupted").put("reason",reason).put("summary","执行已暂停，请核对 App 后重新委托；不会自动重复未确认的动作。")
        journal.save(task)
        return task
    }
    private fun endRun(run:Active) {
        run.fence.stop();run.approval?.cancel();active=null
        run.model?.let { model -> Thread { runCatching { model.cancel() } }.apply { isDaemon=true;start() } }
        LocalGuiService.current?.hideStop()
    }
    private fun requireRun(request:JSONObject):Active {
        val run=active?:throw IllegalStateException("task_not_running")
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
                endRun(run);task.put("phase","interrupted").put("summary","动作结果为 $outcome，请核对 App；不会自动重做。")
            }
            journal.save(task)
        }
        return journal.attempt(attemptId)!!
    }
    @Synchronized fun stop(id:String):JSONObject? {
        val run=active
        if(run?.id==id)endRun(run)
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
        journal.save(task);endRun(run)
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
