// Derived from Mika (https://github.com/wangzan101/Mika, Apache-2.0, commit 5f630d9),
// Copyright 2026 wangzan101. Modified by Nova: native notification-only English copy; Flutter owns setup UI.
package com.nova.nova_mobile.phone.setup

import com.nova.phone.core.shell.BuiltinShellFailure

internal object PhoneSetupCopy {
    const val CHANNEL_NAME = "Phone pairing"
    const val NOTIFY_INPUT_LABEL = "Six-digit pairing code"
    const val NOTIFY_ACTION = "Pair"
    const val NOTIFY_ENTER_TITLE = "Pair Nova with this phone"
    const val NOTIFY_ENTER_TEXT = "Enter the code from Wireless debugging > Pair device with pairing code."
    const val NOTIFY_WINDOW_FOUND = "Pairing window found"
    const val NOTIFY_WORKING = "Pairing and starting phone helper"
    const val NOTIFY_DONE_TITLE = "Phone helper connected"
    const val NOTIFY_DONE_TEXT = "Return to Nova to continue."
    const val NOTIFY_PROBLEM_TEXT = "Open Nova to retry or review phone settings."
    const val NOTIFY_CODE_INVALID = "Enter a six-digit pairing code."
    data class Failure(val title: String)
    fun failure(reason: BuiltinShellFailure) = Failure(when (reason) {
        BuiltinShellFailure.HelperStartFailed -> "Helper could not start"
        BuiltinShellFailure.AuthorizationRevoked -> "Pairing authorization expired"
        BuiltinShellFailure.UsbHelperStopped -> "Phone helper stopped"
        BuiltinShellFailure.NoWifi -> "Connect to Wi-Fi"
        BuiltinShellFailure.WifiNotAllowed -> "Allow wireless debugging on this network"
        BuiltinShellFailure.KeyUnreadable -> "Pair this phone again"
        else -> "Phone connection failed"
    })
    fun notifyRetry(reason: BuiltinShellFailure): String = when (reason) {
        BuiltinShellFailure.WrongCode -> "Code incorrect or expired. Open a new pairing window and enter the new code."
        else -> "Open a new pairing window and enter the new code."
    }
}
