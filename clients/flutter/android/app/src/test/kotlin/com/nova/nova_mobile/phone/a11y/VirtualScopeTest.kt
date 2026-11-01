package com.nova.nova_mobile.phone.a11y

import com.nova.nova_mobile.phone.PhoneActionErrors
import com.nova.nova_mobile.phone.PhoneSnapshot
import com.nova.nova_mobile.phone.PhoneTier
import com.nova.nova_mobile.phone.UiElement
import com.nova.nova_mobile.phone.shell.INovaShell
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

class VirtualScopeTest {
    private val scope = VirtualScope("com.example.shop", "com.nova.nova_mobile", "com.example.keyboard")

    @Test fun onlyTheTargetAndSystemMediatorsAreInScope() {
        assertTrue(scope.allows("com.example.shop"))
        assertTrue(scope.allows("com.android.permissioncontroller"))
        assertTrue(scope.allows("com.google.android.permissioncontroller"))
        assertTrue(scope.allows("android"))
        assertTrue(scope.allows("com.android.intentresolver"))
        assertTrue(scope.allows("com.example.keyboard"))
        assertFalse(scope.allows("com.example.other"))
        assertFalse(scope.allows("com.nova.nova_mobile"))
        assertFalse(scope.allows(null))
    }

    @Test fun openAppAcceptsOnlyTheTarget() {
        scope.checkOpenApp("com.example.shop")
        for (name in listOf("com.example.other", "com.nova.nova_mobile", "com.android.settings")) {
            try { scope.checkOpenApp(name); fail("opened $name") } catch (e: IllegalStateException) {
                assertEquals(PhoneActionErrors.APP_NOT_ALLOWED, e.message)
            }
        }
    }

    @Test fun novaItselfCanNeverBeTheTarget() {
        try { VirtualScope("com.nova.nova_mobile", "com.nova.nova_mobile", null); fail("own package accepted") } catch (e: IllegalArgumentException) {
            assertEquals(PhoneActionErrors.APP_NOT_ALLOWED, e.message)
        }
    }

    @Test fun defaultImePackageComesFromTheComponentName() {
        assertEquals("com.example.keyboard", VirtualScope.imePackage("com.example.keyboard/.LatinIME"))
        assertNull(VirtualScope.imePackage(null))
        assertNull(VirtualScope.imePackage(""))
    }

    @Test fun startResultsMapToContractCodes() {
        assertNull(startAppError(INovaShell.START_OK))
        assertEquals(PhoneActionErrors.APP_IN_USE_ON_MAIN, startAppError(INovaShell.START_IN_USE_ON_MAIN))
        assertEquals(PhoneActionErrors.APP_NOT_LAUNCHABLE, startAppError(INovaShell.START_NOT_FOUND))
        assertEquals(PhoneActionErrors.DISPLAY_UNAVAILABLE, startAppError(INovaShell.START_ERROR))
        assertEquals(PhoneActionErrors.DISPLAY_UNAVAILABLE, startAppError(INovaShell.START_IN_USE_BY_OTHER))
    }

    @Test fun tierIsVirtualOnlyWithApi31AccessibilityAndARunningHelper() {
        assertEquals(PhoneTier.VIRTUAL, phoneTierFor(31, accessibility = true, helperRunning = true))
        assertEquals(PhoneTier.VIRTUAL, phoneTierFor(35, accessibility = true, helperRunning = true))
        assertEquals(PhoneTier.MAIN, phoneTierFor(30, accessibility = true, helperRunning = true))
        assertEquals(PhoneTier.MAIN, phoneTierFor(34, accessibility = false, helperRunning = true))
        assertEquals(PhoneTier.MAIN, phoneTierFor(34, accessibility = true, helperRunning = false))
    }

    @Test fun snapshotWireShapeMatchesTheContract() {
        val element = UiElement("@e1", "EditText", "Password", listOf(1, 2, 3, 4), "password_input", clickable = true,
            editable = true, scrollable = false, focused = true, secret = true)
        val plain = element.copy(ref = "@e2", resourceId = null, secret = false, name = "Go")
        val json = PhoneSnapshot("ph-1", "com.example.shop", 1080, 2400, listOf(element, plain), "YWJj", changedDuringRead = false, secureFrame = true).toJson()
        assertEquals(setOf("snapshot_id", "tier", "package", "width", "height", "elements", "image", "changed_during_read", "secure_frame"), json.keys().asSequence().toSet())
        assertEquals("virtual", json.getString("tier"))
        val first = json.getJSONArray("elements").getJSONObject(0)
        assertEquals(setOf("ref", "role", "name", "bounds", "resource_id", "clickable", "editable", "scrollable", "focused", "secret"), first.keys().asSequence().toSet())
        assertEquals(4, first.getJSONArray("bounds").length())
        assertFalse(json.getJSONArray("elements").getJSONObject(1).has("resource_id"))
        assertFalse(PhoneSnapshot("ph-2", null, 1, 1, emptyList(), "", false, false).toJson().has("package"))
    }
}
