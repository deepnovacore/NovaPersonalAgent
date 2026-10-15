package com.nova.nova_mobile

import android.content.ContentValues
import android.content.Context
import android.database.sqlite.SQLiteDatabase
import android.database.sqlite.SQLiteOpenHelper
import org.json.JSONObject
import java.io.File

/** Native-only writer, excluded from Android Auto Backup. Unknown attempts are
 * retained for reconciliation, never replayed when the process reconnects. */
class LocalAgentJournal(context: Context) : SQLiteOpenHelper(
    context, File(context.noBackupFilesDir, "local-agent-v1.db").path, null, 1
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
        val values=ContentValues().apply { put("id",task.getString("id"));put("record",task.toString()) }
        check(writableDatabase.insertWithOnConflict("tasks",null,values,SQLiteDatabase.CONFLICT_REPLACE)!=-1L)
    }
    @Synchronized fun attempt(id: String): JSONObject? = readableDatabase.rawQuery("SELECT record FROM attempts WHERE id=?",arrayOf(id)).use { if(it.moveToFirst()) JSONObject(it.getString(0)) else null }
    @Synchronized fun beginAttempt(id: String, taskId: String, action: JSONObject): Boolean {
        if(attempt(id)!=null)return false
        val value=JSONObject().put("id",id).put("task_id",taskId).put("state","dispatching").put("action",action).put("created_at",System.currentTimeMillis())
        val row=ContentValues().apply { put("id",id);put("task_id",taskId);put("record",value.toString()) }
        check(writableDatabase.insertOrThrow("attempts",null,row)!=-1L)
        return true
    }
    @Synchronized fun finishAttempt(id: String, state: String) {
        val value=attempt(id)?:return
        value.put("state",state)
        writableDatabase.execSQL("UPDATE attempts SET record=? WHERE id=?",arrayOf(value.toString(),id))
    }
    @Synchronized fun recover() {
        writableDatabase.beginTransaction()
        try {
            readableDatabase.rawQuery("SELECT id,record FROM attempts",null).use { c ->
                while(c.moveToNext()) { val row=JSONObject(c.getString(1));if(row.optString("state")=="dispatching")finishAttempt(c.getString(0),"unknown") }
            }
            // Query all tasks, not only the UI's bounded recent list.
            readableDatabase.rawQuery("SELECT record FROM tasks",null).use { c ->
                while(c.moveToNext()) {
                    val task=JSONObject(c.getString(0))
                    if(task.optString("phase") in listOf("running","waiting_approval")) {
                        task.remove("proposal")
                        task.put("phase","interrupted").put("summary","执行服务曾中断。请核对当前 App，任务不会自动重跑。")
                        save(task)
                    }
                }
            }
            writableDatabase.setTransactionSuccessful()
        } finally { writableDatabase.endTransaction() }
    }
}
