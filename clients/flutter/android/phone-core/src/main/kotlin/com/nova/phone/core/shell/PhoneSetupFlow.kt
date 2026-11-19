// Derived from Mika (https://github.com/wangzan101/Mika, Apache-2.0, commit 5f630d9),
// Copyright 2026 wangzan101. Modified by Nova: package names and scoped native phone integration.
package com.nova.phone.core.shell

/** Notification channel readiness is independent of the helper connection. */
enum class PairingChannelHealth { Ready, Lowered, Off }

enum class PairingStage(val wire: String) {
    IDLE("idle"), WAITING_CODE("waiting_code"), PAIRING("pairing"),
    CONNECTING("connecting"), DONE("done"), FAILED("failed"),
}

/** Shared projection for the native notification and Flutter's setup wizard. */
object PhoneSetupFlow {
    fun stage(status: BuiltinShellStatus, discovery: PairingDiscovery, repairing: Boolean, exchangingCode: Boolean): PairingStage = when {
        exchangingCode -> PairingStage.PAIRING
        repairing -> PairingStage.WAITING_CODE
        status is BuiltinShellStatus.Failed -> PairingStage.FAILED
        status == BuiltinShellStatus.Connecting -> PairingStage.CONNECTING
        status == BuiltinShellStatus.Running -> PairingStage.DONE
        discovery != PairingDiscovery.Idle -> PairingStage.WAITING_CODE
        else -> PairingStage.IDLE
    }

    /** Re-pairing waits for a fresh code even when the previous helper is alive. */
    fun effectiveStatus(status: BuiltinShellStatus, repair: Boolean): BuiltinShellStatus =
        if (repair && status !is BuiltinShellStatus.Connecting) BuiltinShellStatus.NotPaired else status
}
