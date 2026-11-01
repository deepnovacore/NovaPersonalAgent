package com.nova.nova_mobile.phone

import org.json.JSONObject

// Wire form of the M3 events on `nova/phone/events` (docs/specs/mobile-virtual-display.md "Channels").
// The bridge serializes `status` itself.

fun PhoneStepEvent.toJson(): JSONObject = JSONObject()
    .put("type", PhoneEventType.STEP.wire)
    .put("task_id", taskId)
    .put("step", step)
    .put("tool", tool)
    .put("label", label)
    .put("status", status.wire)
    .apply { if (changed != null) put("changed", changed) }
    .apply { if (ref != null) put("ref", ref) }
    .put("tier", tier.wire)

fun PhoneTakeoverEvent.toJson(): JSONObject = JSONObject()
    .put("type", PhoneEventType.TAKEOVER.wire)
    .put("task_id", taskId)
    .put("state", state.wire)
    .put("by", if (byModel) "model" else "user")
    .apply { if (reason != null) put("reason", reason) }

fun PhoneDoneEvent.toJson(): JSONObject = JSONObject()
    .put("type", PhoneEventType.DONE.wire)
    .put("task_id", taskId)
    .put("outcome", outcome.wire)
    .apply { if (reason != null) put("reason", reason) }
    .apply { if (summary != null) put("summary", summary) }
    .put("steps", steps)
    .put("duration_ms", durationMs)
