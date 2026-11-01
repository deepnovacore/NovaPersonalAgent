package com.nova.nova_mobile

import com.nova.nova_mobile.phone.PhoneTier
import org.json.JSONObject

/** New records use the admitted tier; pre-virtual journal records are main. Never replace a run's fixed tier. */
internal fun taskWithTier(record: JSONObject, tier: PhoneTier = PhoneTier.MAIN): JSONObject = record.apply {
    if (!has("tier")) put("tier", tier.wire)
}
