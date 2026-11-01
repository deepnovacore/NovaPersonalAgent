package com.nova.nova_mobile.phone

/** Process bridge hooks owned by the current Space controller. Updated on main, read by bridge IO calls. */
internal class PhoneRunHooks {
    @Volatile var takeover: PhoneTakeover? = null
    @Volatile var selfCheck: PhoneSelfCheck? = null

    /** An old activity's destruction must not detach a newer activity's controller. */
    fun clear(owner: PhoneTakeover) {
        if (takeover === owner) {
            selfCheck = null
            takeover = null
        }
    }
}
