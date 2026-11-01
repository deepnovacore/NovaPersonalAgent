package com.nova.nova_mobile.phone

import android.content.Intent
import android.net.Uri
import android.provider.Settings

/** Pure intent description so the API-level fallbacks and package/channel extras are JVM-testable. */
internal data class PhoneSettingsIntent(
    val action: String,
    val uri: String? = null,
    val extras: Map<String, String> = emptyMap(),
) {
    fun toIntent() = Intent(action).apply {
        uri?.let { data = Uri.parse(it) }
        this@PhoneSettingsIntent.extras.forEach { (key, value) -> putExtra(key, value) }
    }
}

internal fun phoneAppSettingsIntents(
    kind: String, packageName: String, apiLevel: Int, blockedPairingChannel: String? = null,
): List<PhoneSettingsIntent> {
    val details = PhoneSettingsIntent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, "package:$packageName")
    return when (kind) {
        "app_info" -> listOf(details)
        "notifications" -> buildList {
            if (apiLevel >= 26) {
                if (blockedPairingChannel != null) add(PhoneSettingsIntent(Settings.ACTION_CHANNEL_NOTIFICATION_SETTINGS,
                    extras = mapOf(Settings.EXTRA_APP_PACKAGE to packageName, Settings.EXTRA_CHANNEL_ID to blockedPairingChannel)))
                add(PhoneSettingsIntent(Settings.ACTION_APP_NOTIFICATION_SETTINGS,
                    extras = mapOf(Settings.EXTRA_APP_PACKAGE to packageName)))
            }
            add(details)
        }
        else -> throw IllegalArgumentException("invalid_settings")
    }
}
