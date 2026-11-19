package com.nova.nova_mobile.phone.a11y

import com.nova.nova_mobile.phone.PHONE_VIRTUAL_MIN_API
import com.nova.nova_mobile.phone.PHONE_VIRTUAL_STABLE_API
import com.nova.nova_mobile.phone.PhoneActionErrors
import com.nova.nova_mobile.phone.PhoneTier
import com.nova.nova_mobile.phone.shell.INovaShell

/** Native SharedPreferences file of phone control. */
const val PHONE_PREFERENCES = "nova_phone"
/** Boolean in [PHONE_PREFERENCES]: the user acknowledged the Android 12/13 focus warning (written through the bridge). */
const val PHONE_EXPERIMENTAL_ACK = "phone.experimental_ack"

/**
 * Contract tier rule, evaluated once at run start: api >= 31, accessibility on and helper running, and on the
 * experimental api 31..33 also [experimentalAcknowledged]; else main.
 */
fun phoneTierFor(apiLevel: Int, accessibility: Boolean, helperRunning: Boolean, experimentalAcknowledged: Boolean): PhoneTier =
    if (apiLevel >= PHONE_VIRTUAL_MIN_API && accessibility && helperRunning &&
        (apiLevel >= PHONE_VIRTUAL_STABLE_API || experimentalAcknowledged)) PhoneTier.VIRTUAL else PhoneTier.MAIN

/** Admission must not turn a missing helper into permission to operate the main display. */
fun phoneTierForAdmission(apiLevel: Int, accessibility: Boolean, helperRunning: Boolean, experimentalAcknowledged: Boolean): PhoneTier {
    val tier = phoneTierFor(apiLevel, accessibility, true, experimentalAcknowledged)
    check(tier != PhoneTier.VIRTUAL || helperRunning) { PhoneActionErrors.HELPER_UNAVAILABLE }
    return tier
}

/**
 * Consent scope of a virtual-tier run (contract "App scope (virtual tier)"): the user chose [target]; the agent may act
 * while the display shows [target] or a system mediator (permission dialogs, pickers, the keyboard). Nova's own
 * package ([own]) is never in scope.
 */
class VirtualScope(val target: String, private val own: String, private val defaultIme: String?) {
    init { require(target != own) { PhoneActionErrors.APP_NOT_ALLOWED } }

    /** Whether the agent may observe and act while [foreground] is on top of the display. Unknown (null) is not in scope. */
    fun allows(foreground: String?): Boolean =
        foreground != null && foreground != own && (foreground == target || foreground in SYSTEM_MEDIATORS || foreground == defaultIme)

    /** `open_app` accepts only the run's target. */
    fun checkOpenApp(packageName: String) {
        check(packageName == target && packageName != own) { PhoneActionErrors.APP_NOT_ALLOWED }
    }

    companion object {
        val SYSTEM_MEDIATORS = setOf(
            "android",
            "com.android.permissioncontroller",
            "com.google.android.permissioncontroller",
            "com.android.systemui",
            "com.android.documentsui",
            "com.android.intentresolver",
        )

        /** Package of `Settings.Secure.DEFAULT_INPUT_METHOD` ("pkg/.Service"), or null. */
        fun imePackage(defaultInputMethod: String?): String? =
            defaultInputMethod?.substringBefore('/')?.trim()?.ifEmpty { null }
    }
}

/** Maps an `INovaShell.startApp` result to null (started) or the contract execution code. Nothing was started otherwise. */
fun startAppError(code: Int): String? = when (code) {
    INovaShell.START_OK -> null
    INovaShell.START_IN_USE_ON_MAIN -> PhoneActionErrors.APP_IN_USE_ON_MAIN
    INovaShell.START_NOT_FOUND -> PhoneActionErrors.APP_NOT_LAUNCHABLE
    else -> PhoneActionErrors.DISPLAY_UNAVAILABLE
}
