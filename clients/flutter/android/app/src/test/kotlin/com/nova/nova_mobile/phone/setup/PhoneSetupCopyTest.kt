package com.nova.nova_mobile.phone.setup

import java.util.Locale
import org.junit.Assert.*
import org.junit.Test
import com.nova.phone.core.shell.BuiltinShellFailure

class PhoneSetupCopyTest {
    @Test fun notificationCopyFollowsChineseOrEnglishLocale() {
        val original = Locale.getDefault()
        try {
            Locale.setDefault(Locale.ENGLISH)
            assertEquals("Phone pairing", PhoneSetupCopy.CHANNEL_NAME)
            assertEquals("Pair", PhoneSetupCopy.NOTIFY_ACTION)
            assertTrue(PhoneSetupCopy.failure(BuiltinShellFailure.NoWifi).title.contains("Wi-Fi"))
            Locale.setDefault(Locale.SIMPLIFIED_CHINESE)
            assertEquals("手机配对", PhoneSetupCopy.CHANNEL_NAME)
            assertEquals("配对", PhoneSetupCopy.NOTIFY_ACTION)
            assertTrue(PhoneSetupCopy.NOTIFY_WAITING.contains("无线调试"))
            assertTrue(PhoneSetupCopy.notifyRetry(BuiltinShellFailure.WrongCode).contains("配对码"))
        } finally { Locale.setDefault(original) }
    }
}
