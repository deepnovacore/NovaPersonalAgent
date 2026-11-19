// Derived from Mika (https://github.com/wangzan101/Mika, Apache-2.0, commit 5f630d9),
// Copyright 2026 wangzan101. Modified by Nova: package names and scoped native phone integration.
package com.nova.nova_mobile.phone.setup

import android.content.Intent
import android.net.Uri
import android.os.Bundle
import android.provider.Settings

/**
 * Settings destinations used by the Flutter wizard and the observed wireless-debugging URI.
 * Wireless debugging has no public destination: highlight its developer-options row when supported.
 */
object DeveloperSettings {
    /** 原版的全局设置项;未公开常量,按名字读。 */
    const val ADB_WIFI_ENABLED = "adb_wifi_enabled"
    /** 原版开发者选项里「无线调试」一行的 key,用来高亮。 */
    private const val WIRELESS_DEBUGGING_KEY = "toggle_adb_wireless"
    private const val EXTRA_FRAGMENT_ARG_KEY = ":settings:fragment_args_key"
    private const val EXTRA_SHOW_FRAGMENT_ARGS = ":settings:show_fragment_args"

    val wirelessDebuggingUri: Uri = Settings.Global.getUriFor(ADB_WIFI_ENABLED)

    fun developerOptionsPage(): List<Intent> = listOf(Intent(Settings.ACTION_APPLICATION_DEVELOPMENT_SETTINGS), Intent(Settings.ACTION_SETTINGS))

    fun wirelessDebuggingPage(): List<Intent> = highlighted(WIRELESS_DEBUGGING_KEY)

    private fun highlighted(key: String): List<Intent> {
        val highlight = Intent(Settings.ACTION_APPLICATION_DEVELOPMENT_SETTINGS)
            .putExtra(EXTRA_FRAGMENT_ARG_KEY, key)
            .putExtra(EXTRA_SHOW_FRAGMENT_ARGS, Bundle().apply { putString(EXTRA_FRAGMENT_ARG_KEY, key) })
        return listOf(highlight) + developerOptionsPage()
    }

    fun wifiPage(): List<Intent> = listOf(Intent(Settings.ACTION_WIFI_SETTINGS), Intent(Settings.ACTION_SETTINGS))
}
