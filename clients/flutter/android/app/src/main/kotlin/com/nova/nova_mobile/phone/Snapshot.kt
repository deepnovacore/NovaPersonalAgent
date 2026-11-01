package com.nova.nova_mobile.phone

// Numbered snapshot contract (virtual tier observation). Derived in shape from Mika UiElement/NodeIds
// (Apache-2.0, commit 5f630d9); see docs/development/mobile-virtual-display.md "Numbered snapshots".

/** Normalized coordinate space of [UiElement.bounds]: 0..999 inclusive on each axis. */
const val SNAPSHOT_BOUNDS_MAX = 999
/** Snapshots kept for ref lookup; older ones are evicted and their refs are `ref_expired`. */
const val SNAPSHOT_KEEP = 4
const val SNAPSHOT_ID_PREFIX = "ph-"
/** Refs are `@e1`, `@e2`, ... in reading order, renumbered on every snapshot. */
val SNAPSHOT_REF = Regex("^@e[1-9][0-9]{0,3}$")

/**
 * The only element DTO for phone control (phone-core copies ElementLocator/relocate, not Mika's UiElement).
 * Wire: {ref, role, name, bounds:[l,t,r,b], resource_id?, clickable, editable, scrollable, focused, secret}.
 * [role] is the short class name (e.g. "Button", "EditText", "View"). [secret] marks password fields;
 * their [name] is the hint/label only, never the content.
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
)

/**
 * Wire (model observation, virtual tier): {snapshot_id, tier:"virtual", package?, width, height,
 * elements:[UiElement], image, changed_during_read, secure_frame}.
 * [width]/[height] are virtual display pixels; [image] is base64 JPEG of the full frame (longest side <= 1280).
 * [changedDuringRead]: the UI moved while reading; refs may be unreliable.
 * [secureFrame]: the frame is black (FLAG_SECURE); the model should hand_to_user rather than guess.
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
)
