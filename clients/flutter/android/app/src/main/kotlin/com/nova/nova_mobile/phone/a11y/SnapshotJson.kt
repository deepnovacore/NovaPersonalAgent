package com.nova.nova_mobile.phone.a11y

import com.nova.nova_mobile.phone.PhoneSnapshot
import com.nova.nova_mobile.phone.PhoneTier
import com.nova.nova_mobile.phone.UiElement
import org.json.JSONArray
import org.json.JSONObject

// Wire form of the contract snapshot (docs/specs/mobile-virtual-display.md "Numbered snapshots").

fun UiElement.toJson(): JSONObject = JSONObject()
    .put("ref", ref)
    .put("role", role)
    .put("name", name)
    .put("bounds", JSONArray(bounds))
    .apply { if (resourceId != null) put("resource_id", resourceId) }
    .apply { if (packageName != null) put("package", packageName) }
    .apply { if (className != null) put("class", className) }
    .put("clickable", clickable)
    .put("editable", editable)
    .put("scrollable", scrollable)
    .put("focused", focused)
    .put("secret", secret)
    .put("checkable", checkable)
    .put("checked", checked)
    .put("selected", selected)
    .put("enabled", enabled)
    .apply { if (stateDescription != null) put("state_description", stateDescription) }

/** The virtual-tier model observation. */
fun PhoneSnapshot.toJson(): JSONObject = JSONObject()
    .put("snapshot_id", snapshotId)
    .put("tier", PhoneTier.VIRTUAL.wire)
    .apply { if (packageName != null) put("package", packageName) }
    .put("width", width)
    .put("height", height)
    .put("elements", JSONArray().apply { elements.forEach { put(it.toJson()) } })
    .put("image", image)
    .put("changed_during_read", changedDuringRead)
    .put("secure_frame", secureFrame)
    .put("dark_region", darkRegion)
