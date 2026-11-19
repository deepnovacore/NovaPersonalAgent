package com.nova.nova_mobile.phone

import android.provider.Settings
import org.junit.Assert.*
import org.junit.Test

class PhoneSettingsIntentTest {
    private val pkg = "com.nova.nova_mobile.autonomy"

    @Test fun appInfoTargetsTheCurrentVariantPackage() {
        val intent = phoneAppSettingsIntents("app_info", pkg, 34).single()
        assertEquals(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, intent.action)
        assertEquals("package:$pkg", intent.uri)
        assertTrue(intent.extras.isEmpty())
    }

    @Test fun notificationsUseAppSettingsThenAppDetailsFallback() {
        val intents = phoneAppSettingsIntents("notifications", pkg, 34)
        assertEquals(listOf(Settings.ACTION_APP_NOTIFICATION_SETTINGS, Settings.ACTION_APPLICATION_DETAILS_SETTINGS), intents.map { it.action })
        assertEquals(mapOf(Settings.EXTRA_APP_PACKAGE to pkg), intents.first().extras)
        assertNull(intents.first().uri)
        assertEquals("package:$pkg", intents.last().uri)
    }

    @Test fun blockedPairingChannelIsFirstWithoutRemovingAppFallback() {
        val intents = phoneAppSettingsIntents("notifications", pkg, 26, "pairing_alert")
        assertEquals(Settings.ACTION_CHANNEL_NOTIFICATION_SETTINGS, intents.first().action)
        assertEquals(mapOf(Settings.EXTRA_APP_PACKAGE to pkg, Settings.EXTRA_CHANNEL_ID to "pairing_alert"), intents.first().extras)
        assertEquals(Settings.ACTION_APP_NOTIFICATION_SETTINGS, intents[1].action)
    }

    @Test fun preChannelAndroidUsesAppDetails() {
        for (api in 24..25) assertEquals(phoneAppSettingsIntents("app_info", pkg, api),
            phoneAppSettingsIntents("notifications", pkg, api, "pairing_alert"))
    }
}
