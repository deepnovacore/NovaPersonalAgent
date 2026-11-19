// Derived from Mika (https://github.com/wangzan101/Mika, Apache-2.0, commit 5f630d9),
// Copyright 2026 wangzan101. Modified by Nova: consume a narrow window-text interface, not a second accessibility service.
package com.nova.nova_mobile.phone.setup

import android.content.Context
import com.nova.phone.core.shell.BuiltinShellControl
import com.nova.phone.core.shell.PairingDiscovery
import com.nova.phone.core.shell.PairingScreen
import com.nova.phone.core.shell.PhoneSetupFlow
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive

/** Implemented by the existing accessibility service. Never returns other apps' text.
 * Read only main-display system Settings windows, separately, with at most 400 nodes per window.
 * Implementations marshal tree access to their service thread. No text or code is logged.
 */
interface PairingWindowReader {
    val available: Boolean
    fun settingsWindowTexts(): List<List<String>>
}

internal object PairingCodeReader {
    suspend fun run(context: Context, control: BuiltinShellControl, coordinator: PairingCoordinator) {
        val tried = mutableSetOf<String>()
        while (currentCoroutineContext().isActive) {
            delay(300)
            val reader = coordinator.windowReader()?.takeIf { it.available } ?: continue
            val windows = runCatching { reader.settingsWindowTexts() }.getOrDefault(emptyList())
            val attempt = windows.firstNotNullOfOrNull {
                PairingScreen.attempt(PairingScreen.read(it), control.pairingDiscovery.value is PairingDiscovery.Found,
                    PhoneSetupFlow.effectiveStatus(control.status.value, coordinator.repairing.value), tried)
            } ?: continue
            tried += attempt.code
            coordinator.pair(attempt.code, attempt.port)
        }
    }
}
