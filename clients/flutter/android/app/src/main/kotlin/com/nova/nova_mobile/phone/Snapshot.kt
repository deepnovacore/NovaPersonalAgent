package com.nova.nova_mobile.phone

// Numbered snapshot contract (virtual tier observation). Derived in shape from Mika UiElement/NodeIds
// (Apache-2.0, commit 5f630d9); see docs/specs/mobile-virtual-display.md "Numbered snapshots".

/** Normalized coordinate space of [UiElement.bounds]: 0..999 inclusive on each axis. */
const val SNAPSHOT_BOUNDS_MAX = 999
/** Snapshots kept for ref lookup; older ones are evicted and their refs are `ref_expired`. */
const val SNAPSHOT_KEEP = 4
const val SNAPSHOT_ID_PREFIX = "ph-"
/** Refs are `@e1`, `@e2`, ... in reading order, renumbered on every snapshot. */
val SNAPSHOT_REF = Regex("^@e[1-9][0-9]{0,3}$")

/**
 * The only element DTO for phone control (phone-core copies ElementLocator/relocate, not Mika's UiElement).
 * Wire: {ref, role, name, bounds:[l,t,r,b], resource_id?, clickable, editable, scrollable, focused, secret,
 * checkable, checked, selected, enabled, state_description?}.
 * [role] is the short class name (e.g. "Button", "EditText", "View"). [secret] marks password fields.
 * Editable and secret fields are named by their hint/label only, never by their content.
 */
data class UiElement(
    val ref: String,
    val role: String,
    val name: String,
    val bounds: List<Int>,
    val resourceId: String?,
    val clickable: Boolean,
    val editable: Boolean,
    val scrollable: Boolean,
    val focused: Boolean,
    val secret: Boolean,
    val checkable: Boolean = false,
    val checked: Boolean = false,
    val selected: Boolean = false,
    val enabled: Boolean = true,
    val stateDescription: String? = null,
    val packageName: String? = null,
    val className: String? = null,
)

/**
 * Wire (model observation, virtual tier): {snapshot_id, tier:"virtual", package?, width, height,
 * elements:[UiElement], image, changed_during_read, secure_frame, dark_region}.
 * [width]/[height] are virtual display pixels; [image] is base64 JPEG of the full frame (longest side <= 1280).
 * [changedDuringRead]: the UI moved while reading; refs may be unreliable.
 * [secureFrame]: the frame is black while the tree still shows elements (FLAG_SECURE); only back and hand_to_user run,
 * any other action starts a `secure_page` takeover.
 */
data class PhoneSnapshot(
    val snapshotId: String,
    val packageName: String?,
    val width: Int,
    val height: Int,
    val elements: List<UiElement>,
    val image: String,
    val changedDuringRead: Boolean,
    val secureFrame: Boolean,
    val darkRegion: Boolean = false,
)
