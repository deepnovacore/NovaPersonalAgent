package com.nova.nova_mobile

import android.content.Context
import com.xiaomi.mipush.sdk.MiPushClient
import com.xiaomi.mipush.sdk.MiPushCommandMessage
import com.xiaomi.mipush.sdk.MiPushMessage
import com.xiaomi.mipush.sdk.PushMessageReceiver
import com.xiaomi.mipush.sdk.PushMessageHelper
import org.json.JSONObject

object NovaMiPush {
    @Suppress("DEPRECATION")
    @JvmStatic fun readOpen(intent: android.content.Intent): Map<String, String>? {
        val message = intent.getSerializableExtra(PushMessageHelper.KEY_MESSAGE) as? MiPushMessage ?: return null
        val data = JSONObject(message.content)
        return mapOf("notificationId" to data.getString("notificationId"), "handle" to data.getString("handle"))
    }
    @JvmStatic fun register(context: Context) {
        require(BuildConfig.NOVA_MIPUSH_APP_ID.isNotEmpty() && BuildConfig.NOVA_MIPUSH_APP_KEY.isNotEmpty())
        MiPushClient.registerPush(context, BuildConfig.NOVA_MIPUSH_APP_ID, BuildConfig.NOVA_MIPUSH_APP_KEY)
    }
}
class NovaMiPushReceiver : PushMessageReceiver() {
    override fun onReceiveRegisterResult(context: Context, message: MiPushCommandMessage) {
        if (message.command == MiPushClient.COMMAND_REGISTER && message.resultCode == 0L) {
            message.commandArguments?.firstOrNull()?.let { NovaSpacePush.token(context, "mipush", it) }
        }
    }
    override fun onNotificationMessageClicked(context: Context, message: MiPushMessage) {
        try {
            val data = JSONObject(message.content)
            val intent = android.content.Intent(context, MainActivity::class.java).addFlags(android.content.Intent.FLAG_ACTIVITY_NEW_TASK or android.content.Intent.FLAG_ACTIVITY_CLEAR_TOP)
                .putExtra("nova_notification_id", data.getString("notificationId")).putExtra("nova_push_handle", data.getString("handle"))
            context.startActivity(intent)
        } catch (_: Exception) { }
    }
}
