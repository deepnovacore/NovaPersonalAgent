// Derived from Mika (https://github.com/wangzan101/Mika, Apache-2.0, commit 5f630d9),
// Copyright 2026 wangzan101. Modified by Nova: package names and scoped native phone integration.
package com.nova.nova_mobile.phone.setup

import android.content.ContentResolver
import android.content.Intent
import android.net.Uri
import android.os.Bundle
import android.provider.Settings

/**
 * 引导要看的系统开关,以及跳到对应设置页的 Intent。
 * 「USB 调试」「无线调试」没有公开的跳转入口:进开发者选项,并按原版设置的做法高亮那一行;不认这个参数的手机就停在开发者选项顶部。
 */
object DeveloperSettings {
    /** 原版的全局设置项;未公开常量,按名字读。 */
    const val ADB_WIFI_ENABLED = "adb_wifi_enabled"
    /** 原版开发者选项里「无线调试」一行的 key,用来高亮。 */
    private const val WIRELESS_DEBUGGING_KEY = "toggle_adb_wireless"
    /** 原版开发者选项里「USB 调试」一行的 key。 */
    private const val USB_DEBUGGING_KEY = "enable_adb"
    private const val EXTRA_FRAGMENT_ARG_KEY = ":settings:fragment_args_key"
    private const val EXTRA_SHOW_FRAGMENT_ARGS = ":settings:show_fragment_args"

    val developerOptionsUri: Uri = Settings.Global.getUriFor(Settings.Global.DEVELOPMENT_SETTINGS_ENABLED)
    val wirelessDebuggingUri: Uri = Settings.Global.getUriFor(ADB_WIFI_ENABLED)
    val usbDebuggingUri: Uri = Settings.Global.getUriFor(Settings.Global.ADB_ENABLED)

    fun developerOptions(cr: ContentResolver): Boolean =
        Settings.Global.getInt(cr, Settings.Global.DEVELOPMENT_SETTINGS_ENABLED, 0) == 1

    /** 没写过这一项(从没开过)按关着算;读不准的手机由引导页的「我已经打开了」兜底。 */
    fun wirelessDebugging(cr: ContentResolver): Boolean = Settings.Global.getInt(cr, ADB_WIFI_ENABLED, 0) == 1

    /**
     * 系统里没有无线调试这一项。原版(安卓 11 起)开机时总会把这项设置按当前状态写成 0 或 1,所以开着关着都读得到;
     * 一直没有这一项,说明系统没带无线调试。读的时候出错(系统不让读)不下结论,按有算。
     */
    fun wirelessDebuggingMissing(cr: ContentResolver): Boolean =
        runCatching { Settings.Global.getString(cr, ADB_WIFI_ENABLED) == null }.getOrDefault(false)

    /**
     * 把无线调试开关写成打开(要有修改系统设置的授权)。写入被拒(抛异常或返回 false)返回 false;
     * 写进去之后系统还可能马上拨回去(见 [com.nova.phone.core.shell.WirelessDebuggingAutoOn]),由调用方再读。
     */
    fun turnOnWirelessDebugging(cr: ContentResolver): Boolean =
        runCatching { Settings.Global.putInt(cr, ADB_WIFI_ENABLED, 1) }.getOrDefault(false)

    fun usbDebugging(cr: ContentResolver): Boolean = Settings.Global.getInt(cr, Settings.Global.ADB_ENABLED, 0) == 1

    /** 「关于手机」,版本号在这里(有的手机在它下面的「软件信息」里)。 */
    fun aboutPhone(): List<Intent> = listOf(Intent(Settings.ACTION_DEVICE_INFO_SETTINGS), Intent(Settings.ACTION_SETTINGS))

    fun developerOptionsPage(): List<Intent> = listOf(Intent(Settings.ACTION_APPLICATION_DEVELOPMENT_SETTINGS), Intent(Settings.ACTION_SETTINGS))

    fun usbDebuggingPage(): List<Intent> = highlighted(USB_DEBUGGING_KEY)

    fun wirelessDebuggingPage(): List<Intent> = highlighted(WIRELESS_DEBUGGING_KEY)

    private fun highlighted(key: String): List<Intent> {
        val highlight = Intent(Settings.ACTION_APPLICATION_DEVELOPMENT_SETTINGS)
            .putExtra(EXTRA_FRAGMENT_ARG_KEY, key)
            .putExtra(EXTRA_SHOW_FRAGMENT_ARGS, Bundle().apply { putString(EXTRA_FRAGMENT_ARG_KEY, key) })
        return listOf(highlight) + developerOptionsPage()
    }

    fun wifiPage(): List<Intent> = listOf(Intent(Settings.ACTION_WIFI_SETTINGS), Intent(Settings.ACTION_SETTINGS))
}
