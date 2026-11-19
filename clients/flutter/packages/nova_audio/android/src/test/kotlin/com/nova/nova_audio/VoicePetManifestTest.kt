package com.nova.nova_audio

import java.io.File
import javax.xml.parsers.DocumentBuilderFactory
import org.junit.Assert.*
import org.junit.Test
import org.w3c.dom.Element

class VoicePetManifestTest {
    @Test fun libraryDeclaresSpecialUsePermissionServiceAndSubtype() {
        val document = DocumentBuilderFactory.newInstance().apply { isNamespaceAware = true }
            .newDocumentBuilder().parse(File(requireNotNull(System.getProperty("nova.manifest"))))
        val android = "http://schemas.android.com/apk/res/android"
        fun elements(tag: String) = document.getElementsByTagName(tag).let { nodes ->
            (0 until nodes.length).map { nodes.item(it) as Element }
        }
        assertTrue(elements("uses-permission").any {
            it.getAttributeNS(android, "name") == "android.permission.FOREGROUND_SERVICE_SPECIAL_USE"
        })
        val service = elements("service").single { it.getAttributeNS(android, "name") == "com.nova.nova_audio.VoicePetService" }
        assertEquals("specialUse", service.getAttributeNS(android, "foregroundServiceType"))
        assertEquals("false", service.getAttributeNS(android, "exported"))
        val property = service.getElementsByTagName("property").item(0) as Element
        assertEquals("android.app.PROPERTY_SPECIAL_USE_FGS_SUBTYPE", property.getAttributeNS(android, "name"))
        assertTrue(property.getAttributeNS(android, "value").isNotBlank())
    }
}
