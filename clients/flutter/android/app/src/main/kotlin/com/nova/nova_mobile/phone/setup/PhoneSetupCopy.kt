// Derived from Mika (https://github.com/wangzan101/Mika, Apache-2.0, commit 5f630d9),
// Copyright 2026 wangzan101. Modified by Nova: bilingual native notification copy; Flutter owns setup UI.
package com.nova.nova_mobile.phone.setup

import com.nova.phone.core.shell.BuiltinShellFailure
import java.util.Locale

internal object PhoneSetupCopy {
    private fun t(zh: String, en: String) = if (Locale.getDefault().language == "zh") zh else en
    val NOTIFY_WAITING get() = t("正在等待无线调试配对。返回 Nova 可取消。", "Waiting for wireless debugging pairing. Return to Nova to cancel.")
    val CHANNEL_NAME get() = t("手机配对", "Phone pairing")
    val NOTIFY_INPUT_LABEL get() = t("六位配对码", "Six-digit pairing code")
    val NOTIFY_ACTION get() = t("配对", "Pair")
    val NOTIFY_ENTER_TITLE get() = t("将 Nova 与此手机配对", "Pair Nova with this phone")
    val NOTIFY_ENTER_TEXT get() = t("请输入「无线调试 > 使用配对码配对设备」中的配对码。", "Enter the code from Wireless debugging > Pair device with pairing code.")
    val NOTIFY_WINDOW_FOUND get() = t("已找到配对窗口", "Pairing window found")
    val NOTIFY_WORKING get() = t("正在配对并启动手机助手", "Pairing and starting phone helper")
    val NOTIFY_DONE_TITLE get() = t("手机助手已连接", "Phone helper connected")
    val NOTIFY_DONE_TEXT get() = t("返回 Nova 继续。", "Return to Nova to continue.")
    val NOTIFY_PROBLEM_TEXT get() = t("打开 Nova 重试或检查手机设置。", "Open Nova to retry or review phone settings.")
    val NOTIFY_CODE_INVALID get() = t("请输入六位配对码。", "Enter a six-digit pairing code.")
    data class Failure(val title: String)
    fun failure(reason: BuiltinShellFailure) = Failure(when (reason) {
        BuiltinShellFailure.HelperStartFailed -> t("手机助手启动失败", "Helper could not start")
        BuiltinShellFailure.AuthorizationRevoked -> t("配对授权已失效", "Pairing authorization expired")
        BuiltinShellFailure.NoWifi -> t("请连接 Wi-Fi", "Connect to Wi-Fi")
        BuiltinShellFailure.WifiNotAllowed -> t("请允许在此网络上进行无线调试", "Allow wireless debugging on this network")
        BuiltinShellFailure.KeyUnreadable -> t("请重新配对此手机", "Pair this phone again")
        else -> t("手机连接失败", "Phone connection failed")
    })
    fun notifyRetry(reason: BuiltinShellFailure): String = when (reason) {
        BuiltinShellFailure.WrongCode -> t("配对码错误或已过期。请打开新的配对窗口并输入新配对码。", "Code incorrect or expired. Open a new pairing window and enter the new code.")
        else -> t("请打开新的配对窗口并输入新配对码。", "Open a new pairing window and enter the new code.")
    }
}
