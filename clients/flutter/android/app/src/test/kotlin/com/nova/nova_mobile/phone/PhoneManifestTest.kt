package com.nova.nova_mobile.phone

import java.io.File
import javax.xml.parsers.DocumentBuilderFactory
import org.junit.Assert.*
import org.junit.Test
import org.w3c.dom.Element

class PhoneManifestTest {
    private val document = DocumentBuilderFactory.newInstance().apply { isNamespaceAware = true }
        .newDocumentBuilder().parse(File("src/main/AndroidManifest.xml"))
    private fun Element.android(name: String) = getAttributeNS("http://schemas.android.com/apk/res/android", name)
    private fun component(tag: String, name: String): Element {
        val nodes = document.getElementsByTagName(tag)
        return (0 until nodes.length).map { nodes.item(it) as Element }.single { it.android("name") == name }
    }
    @Test fun providerIsShellPermissionProtectedAndVariantScoped() {
        val provider = component("provider", ".phone.shell.HandoffProvider")
        assertEquals("true", provider.android("exported"))
        assertEquals("android.permission.INTERACT_ACROSS_USERS_FULL", provider.android("permission"))
        assertEquals("\${applicationId}.helper", provider.android("authorities"))
    }
    @Test fun pairingInputIsNotExported() {
        assertEquals("false", component("receiver", ".phone.setup.PairingCodeInput").android("exported"))
    }
    @Test fun pairingForegroundServiceDeclaresSpecialUseAndSubtype() {
        val service = component("service", ".phone.setup.PairingService")
        assertEquals("false", service.android("exported"))
        assertEquals("specialUse", service.android("foregroundServiceType"))
        val property = service.getElementsByTagName("property").item(0) as Element
        assertEquals("android.app.PROPERTY_SPECIAL_USE_FGS_SUBTYPE", property.android("name"))
        assertTrue(property.android("value").isNotBlank())
        component("uses-permission", "android.permission.FOREGROUND_SERVICE_SPECIAL_USE")
    }
}
