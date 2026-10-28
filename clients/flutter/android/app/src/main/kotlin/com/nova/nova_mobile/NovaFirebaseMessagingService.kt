package com.nova.nova_mobile

import android.content.Context
import com.google.firebase.messaging.FirebaseMessagingService
import com.google.firebase.messaging.RemoteMessage

class NovaFirebaseMessagingService : FirebaseMessagingService() {
    override fun onNewToken(token: String) { NovaSpacePush.token(this, "fcm", token) }
    override fun onMessageReceived(message: RemoteMessage) {
        // Bounded local crypto only; no network or model work in FCM's short execution window.
        NovaSpacePush.notify(this, message.data)
    }
    override fun onDeletedMessages() {
        getSharedPreferences("nova_push", Context.MODE_PRIVATE).edit().putBoolean("sync_required", true).apply()
        NovaSpacePush.emit(mapOf("type" to "syncRequired"))
    }
}
