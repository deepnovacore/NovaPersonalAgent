package com.nova.nova_mobile

import android.content.ContentValues
import android.content.Context
import android.database.sqlite.SQLiteDatabase
import android.database.sqlite.SQLiteOpenHelper
import org.json.JSONObject
import java.io.File

/** Native-only writer, excluded from Android Auto Backup. Unknown attempts are
 * retained for reconciliation, never replayed when the process reconnects. */
class LocalAgentJournal(context: Context, spaceId: String) : SQLiteOpenHelper(
    context, File(NovaSpaceScope.privateDirectory(context, spaceId), "local-agent-v1.db").path, null, 1
) {
    override fun onCreate(db: SQLiteDatabase) {
        db.execSQL("CREATE TABLE tasks(id TEXT PRIMARY KEY, record TEXT NOT NULL)")
        db.execSQL("CREATE TABLE attempts(id TEXT PRIMARY KEY, task_id TEXT NOT NULL, record TEXT NOT NULL)")
    }
    override fun onConfigure(db: SQLiteDatabase) { db.execSQL("PRAGMA synchronous=FULL") }
    override fun onUpgrade(db: SQLiteDatabase, oldVersion: Int, newVersion: Int) = error("unsupported_agent_schema")
    @Synchronized fun task(id: String): JSONObject? = readableDatabase.rawQuery("SELECT record FROM tasks WHERE id=?", arrayOf(id)).use { if(it.moveToFirst()) JSONObject(it.getString(0)) else null }
    @Synchronized fun tasks(): List<JSONObject> = readableDatabase.rawQuery("SELECT record FROM tasks ORDER BY rowid DESC LIMIT 100", null).use { cursor -> buildList { while(cursor.moveToNext()) add(JSONObject(cursor.getString(0))) } }
    @Synchronized fun save(task: JSONObject) {
        refreshSafety(task,task.getString("id"))
        if(task.optString("phase")=="interrupted" && task.getBoolean("action_in_flight") &&
            !task.optString("summary").contains(IN_FLIGHT_COPY)) task.put("summary",task.optString("summary")+IN_FLIGHT_COPY)
        val values=ContentValues().apply { put("id",task.getString("id"));put("record",task.toString()) }
        check(writableDatabase.insertWithOnConflict("tasks",null,values,SQLiteDatabase.CONFLICT_REPLACE)!=-1L)
    }
    @Synchronized fun attempt(id: String): JSONObject? = readableDatabase.rawQuery("SELECT record FROM attempts WHERE id=?",arrayOf(id)).use { if(it.moveToFirst()) JSONObject(it.getString(0)) else null }
    @Synchronized fun beginAttempt(id: String, taskId: String, action: JSONObject): Boolean {
        if(attempt(id)!=null)return false
        val value=JSONObject().put("id",id).put("task_id",taskId).put("state","dispatching").put("action",action).put("created_at",System.currentTimeMillis())
        val row=ContentValues().apply { put("id",id);put("task_id",taskId);put("record",value.toString()) }
        check(writableDatabase.insertOrThrow("attempts",null,row)!=-1L)
        task(taskId)?.let(::save)
        return true
    }
    @Synchronized fun finishAttempt(id: String, state: String) {
        val value=attempt(id)?:return
        value.put("state",state)
        writableDatabase.execSQL("UPDATE attempts SET record=? WHERE id=?",arrayOf(value.toString(),id))
        // Launch attempts are not in actions[]. Refresh even a task that already stopped while dispatch was pending.
        task(value.getString("task_id"))?.let(::save)
    }
    @Synchronized fun refreshSafety(record:JSONObject,taskId:String):JSONObject {
        val states=readableDatabase.rawQuery("SELECT record FROM attempts WHERE task_id=?",arrayOf(taskId)).use { c ->
            buildList { while(c.moveToNext()) add(JSONObject(c.getString(0)).optString("state")) }
        }
        return attemptSafety(record,states)
    }
    @Synchronized fun recover() {
        writableDatabase.beginTransaction()
        try {
            readableDatabase.rawQuery("SELECT id,record FROM attempts",null).use { c ->
                while(c.moveToNext()) { val row=JSONObject(c.getString(1));if(row.optString("state")=="dispatching")finishAttempt(c.getString(0),"unknown") }
            }
            // Query all tasks, not only the UI's bounded recent list.
            val recoveredTasks=readableDatabase.rawQuery("SELECT record FROM tasks",null).use { c ->
                buildList { while(c.moveToNext()) add(JSONObject(c.getString(0))) }
            }
            for(task in recoveredTasks) {
                if(task.optString("phase") in listOf("running","waiting_approval")) {
                    task.remove("proposal")
                    task.put("phase","interrupted").put("reason","execution_interrupted").put("summary","已暂停：执行服务曾中断。已经做过的步骤请先在 App 里核对，再决定要不要重新开始。")
                }
                // Backfill every terminal record; don't replace task rowids under an open read cursor.
                save(task)
            }
            writableDatabase.setTransactionSuccessful()
        } finally { writableDatabase.endTransaction() }
    }
}

internal const val IN_FLIGHT_COPY="有一个操作可能已经生效。"

/** Only explicit dispatch/refusal resolves an attempt; unknown and future unrecognized outcomes stay blocked. */
internal fun attemptSafety(record:JSONObject,states:List<String>):JSONObject = record
    .put("action_in_flight",states.any { it=="dispatching" })
    .put("unresolved_actions",states.count { it!="dispatched" && it!="rejected" })
    .put("dispatched_actions",states.count { it=="dispatched" })
