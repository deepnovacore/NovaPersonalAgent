package com.nova.nova_mobile

import android.Manifest
import android.app.Activity
import android.app.AlertDialog
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Bitmap
import android.provider.CalendarContract
import android.provider.MediaStore
import android.util.Base64
import io.flutter.plugin.common.BinaryMessenger
import io.flutter.plugin.common.MethodChannel
import java.io.ByteArrayOutputStream
import java.time.Instant
import java.util.concurrent.Executors

/** One explicit action only; never invokes LocalAgentController or a model loop. */
class NovaSpaceTools(private val activity: Activity, messenger: BinaryMessenger) {
    private val worker = Executors.newSingleThreadExecutor()
    private var permissionReply: MethodChannel.Result? = null
    private var cameraReply: MethodChannel.Result? = null
    private var busy = false
    private val channel = MethodChannel(messenger, "nova/space_tools")
    init {
        channel.setMethodCallHandler { call, reply ->
            val input = call.arguments as? Map<*, *>
            val tool = input?.get("tool") as? String
            if (tool !in setOf("calendar.read", "camera.capture")) {
                reply.error("unsupported", "This system tool is unavailable on Android.", null)
            } else if (activity.isFinishing || activity.isDestroyed || !activity.hasWindowFocus()) {
                reply.error("unavailable", "Open the app to use this tool.", null)
            } else when (call.method) {
                "requestPermission" -> requestPermission(tool!!, reply)
                "execute" -> {
                    val id = input?.get("action_id") as? String
                    val args = input?.get("args") as? Map<*, *>
                    if (busy || id.isNullOrEmpty() || id.length > 200 || args == null) reply.error("unavailable", "Another action is active or the request is invalid.", null)
                    else if (!granted(tool!!)) reply.error("permission_denied", null, null)
                    else {
                        busy = true
                        if (tool == "calendar.read") readCalendar(args, reply) else capture(reply)
                    }
                }
                else -> reply.notImplemented()
            }
        }
    }
    private fun permission(tool: String) = if (tool == "calendar.read") Manifest.permission.READ_CALENDAR else Manifest.permission.CAMERA
    private fun granted(tool: String) = activity.checkSelfPermission(permission(tool)) == PackageManager.PERMISSION_GRANTED
    private fun requestPermission(tool: String, reply: MethodChannel.Result) {
        if (permissionReply != null || busy) { reply.error("unavailable", null, null); return }
        if (granted(tool)) { reply.success(true); return }
        permissionReply = reply
        activity.requestPermissions(arrayOf(permission(tool)), PERMISSION)
    }
    fun onRequestPermissionsResult(requestCode: Int, grantResults: IntArray): Boolean {
        if (requestCode != PERMISSION) return false
        permissionReply?.success(grantResults.isNotEmpty() && grantResults.all { it == PackageManager.PERMISSION_GRANTED })
        permissionReply = null
        return true
    }
    private fun fail(reply: MethodChannel.Result, code: String) { busy = false; reply.error(code, null, null) }
    private fun readCalendar(args: Map<*, *>, reply: MethodChannel.Result) {
        val start: Instant
        val end: Instant
        try {
            require(args.keys.all { it == "start" || it == "end" })
            start = Instant.parse(args["start"] as String)
            end = Instant.parse(args["end"] as String)
            require(end.isAfter(start) && end.epochSecond - start.epochSecond <= 366L * 86400)
        } catch (_: Exception) { fail(reply, "invalid_arguments"); return }
        AlertDialog.Builder(activity).setTitle("Share calendar with Host?")
            .setMessage("Your Host requested events from $start to $end.")
            .setNegativeButton("Cancel") { _, _ -> fail(reply, "permission_denied") }
            .setOnCancelListener { fail(reply, "permission_denied") }
            .setPositiveButton("Share") { _, _ -> worker.execute {
                try {
                    val items = mutableListOf<Map<String, Any>>()
                    var truncated = false
                    val columns = arrayOf(CalendarContract.Instances.EVENT_ID, CalendarContract.Instances.TITLE, CalendarContract.Instances.BEGIN, CalendarContract.Instances.END)
                    CalendarContract.Instances.query(activity.contentResolver, columns, start.toEpochMilli(), end.toEpochMilli()).use { cursor ->
                        while (cursor != null && cursor.moveToNext()) {
                            if (items.size == 100) { truncated = true; break }
                            items.add(mapOf("id" to cursor.getLong(0).toString(), "title" to (cursor.getString(1) ?: "").take(500),
                                "start" to Instant.ofEpochMilli(cursor.getLong(2)).toString(), "end" to Instant.ofEpochMilli(cursor.getLong(3)).toString()))
                        }
                    }
                    activity.runOnUiThread { busy = false; reply.success(mapOf("items" to items, "truncated" to truncated)) }
                } catch (_: SecurityException) { activity.runOnUiThread { fail(reply, "permission_denied") } }
                  catch (_: Exception) { activity.runOnUiThread { fail(reply, "unavailable") } }
            }}.show()
    }
    @Suppress("DEPRECATION")
    private fun capture(reply: MethodChannel.Result) {
        val intent = Intent(MediaStore.ACTION_IMAGE_CAPTURE)
        if (intent.resolveActivity(activity.packageManager) == null) { fail(reply, "unsupported"); return }
        cameraReply = reply
        try { activity.startActivityForResult(intent, CAMERA) }
        catch (_: Exception) { cameraReply = null; fail(reply, "unavailable") }
    }
    @Suppress("DEPRECATION")
    fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?): Boolean {
        if (requestCode != CAMERA) return false
        val reply = cameraReply ?: return true
        cameraReply = null
        if (resultCode != Activity.RESULT_OK) { fail(reply, "permission_denied"); return true }
        val original = data?.extras?.get("data") as? Bitmap
        if (original == null) { fail(reply, "unavailable"); return true }
        val scale = minOf(1.0, 640.0 / maxOf(original.width, original.height))
        val image = Bitmap.createScaledBitmap(original, maxOf(1, (original.width * scale).toInt()), maxOf(1, (original.height * scale).toInt()), true)
        val bytes = ByteArrayOutputStream().use { output -> image.compress(Bitmap.CompressFormat.JPEG, 40, output); output.toByteArray() }
        if (bytes.size > 65536) { fail(reply, "image_too_large"); return true }
        busy = false
        reply.success(mapOf("mime" to "image/jpeg", "data" to Base64.encodeToString(bytes, Base64.NO_WRAP), "width" to image.width, "height" to image.height))
        return true
    }
    fun close() {
        channel.setMethodCallHandler(null)
        permissionReply?.error("unavailable", null, null); permissionReply = null
        cameraReply?.error("outcome_unknown", null, null); cameraReply = null
        worker.shutdown()
    }
    companion object { private const val PERMISSION = 28101; private const val CAMERA = 28102 }
}
