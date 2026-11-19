// Derived from Mika (https://github.com/wangzan101/Mika, Apache-2.0, commit 5f630d9),
// Copyright 2026 wangzan101. Modified by Nova: extract and test ordered credential handoff.
package com.nova.phone.core.shell

/** Called under the hub's lock: never contact an uncredentialed Binder or consume before identity. */
object HandoffGate {
    sealed interface Result {
        data class Accepted(val nextNonce: String) : Result
        data class Rejected(val reason: HelperHandoff.Reject) : Result
    }

    fun offer(
        check: () -> HelperHandoff.Reject?,
        matches: () -> Boolean,
        identity: () -> Boolean,
        accept: () -> String?,
    ): Result {
        check()?.let { return Result.Rejected(it) }
        if (!matches()) return Result.Rejected(HelperHandoff.Reject.BadNonce)
        if (!identity()) return Result.Rejected(HelperHandoff.Reject.BinderElsewhere)
        return accept()?.let { Result.Accepted(it) } ?: Result.Rejected(HelperHandoff.Reject.BadNonce)
    }
}
