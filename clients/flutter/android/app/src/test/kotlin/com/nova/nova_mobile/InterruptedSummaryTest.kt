package com.nova.nova_mobile

import org.junit.Assert.*
import org.junit.Test

class InterruptedSummaryTest {
    @Test fun reasonSpecificCopyDoesNotClaimAnUnknownEffectFailed() {
        assertTrue(interruptedSummary("action_outcome_unknown").contains("无法确认是否生效，没有重试"))
        assertTrue(interruptedSummary("step_limit").contains("步骤用完"))
        assertTrue(interruptedSummary("no_progress").startsWith("已暂停："))
        assertTrue(interruptedSummary("no_progress").contains("请先在 App 里核对"))
        assertFalse(interruptedSummary("no_progress").contains("不会重复"))
        assertTrue(interruptedSummary("tool_helper_unavailable").contains("设置 → 手机操作"))
        assertTrue(interruptedSummary("tool_helper_unavailable").contains("无线调试"))
        for (reason in listOf("accessibility_unavailable", "a11y_interrupted", "a11y_destroyed", "a11y_reconnected")) {
            assertTrue(interruptedSummary(reason).contains("无障碍服务断开"))
            assertTrue(interruptedSummary(reason).contains("已经做过的步骤请先在 App 里核对"))
            assertFalse(interruptedSummary(reason).contains("不会重复"))
        }
        assertFalse(interruptedSummary("unknown_private_detail").contains("unknown_private_detail"))
    }
    @Test fun nativeCopyOwnsThePausedPrefixAndWarnsAboutInFlightEffects() {
        for(reason in listOf("accessibility_unavailable","step_limit","native_loop_failed","execution_interrupted","helper_unavailable","time_limit")) {
            val summary=interruptedSummary(reason,true)
            assertTrue(summary.startsWith("已暂停："))
            assertEquals(1,Regex("已暂停：").findAll(summary).count())
            assertTrue(summary.endsWith("有一个操作可能已经生效。"))
            assertFalse(interruptedSummary(reason).contains(IN_FLIGHT_COPY))
        }
    }
}
