// Derived from Mika (https://github.com/wangzan101/Mika, Apache-2.0, commit 5f630d9),
// Copyright 2026 wangzan101. Modified by Nova: notification copy and narrow accessibility reader seam.
package com.nova.nova_mobile.phone.setup

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.RemoteInput
import android.content.Context
import android.content.Intent
import android.os.Build
import androidx.core.app.NotificationManagerCompat
import com.nova.phone.core.shell.BuiltinShellFix
import com.nova.phone.core.shell.BuiltinShellStatus
import com.nova.phone.core.shell.PairingChannelHealth
import com.nova.phone.core.shell.PairingDiscovery
import com.nova.phone.core.shell.PhoneSetupFlow
import com.nova.nova_mobile.MainActivity

/** 配对通知此刻该显示什么。 */
sealed interface PairingNotice {
    /** 带输入框的「输入配对码」;[error] 是上一次没成功的原因和怎么办,输入框照样留着。 */
    data class EnterCode(val port: Int?, val error: String? = null) : PairingNotice
    data object Working : PairingNotice
    data object Done : PairingNotice
    /** 配对后没能连上:回 Nova 看怎么处理。 */
    data class Problem(val title: String) : PairingNotice

    companion object {
        /**
         * 只在用户正在配对的这段时间里用([PairingCoordinator] 开着时)。找到配对窗口才弹输入框;
         * 配对阶段的失败(码不对、过期、窗口关了)留在通知里重填;要重新配对的失败(配对失效)找到配对窗口后也给输入框,
         * 和无障碍读码认的一样(PairingScreen.attempt);别的失败请用户回 Nova。
         */
        fun of(status: BuiltinShellStatus, discovery: PairingDiscovery): PairingNotice? {
            val port = (discovery as? PairingDiscovery.Found)?.port
            return when (status) {
                BuiltinShellStatus.Running -> Done
                BuiltinShellStatus.Connecting -> Working
                is BuiltinShellStatus.Failed -> when {
                    status.reason.duringPairing -> EnterCode(port, PhoneSetupCopy.notifyRetry(status.reason))
                    status.fix == BuiltinShellFix.RePair && port != null -> EnterCode(port)
                    else -> Problem(PhoneSetupCopy.failure(status.reason).title)
                }
                BuiltinShellStatus.NotPaired, BuiltinShellStatus.WirelessDebuggingOff -> port?.let { EnterCode(it) }
            }
        }

        /** 无障碍在读配对码时,填码通知晚这么久再弹,多半已经配上了,不打扰。 */
        const val AUTO_READ_GRACE_MS = 5_000L
        /** 填码通知弹出后没人填,依次隔这么久再弹一次;最多 [MAX_REALERTS] 次,不刷屏。 */
        val REALERT_MS = listOf(8_000L, 20_000L, 40_000L)
        val MAX_REALERTS = REALERT_MS.size

        /** 发出 [notice] 前等多久。无障碍没开时找到配对窗口就弹,不等。 */
        fun delayBefore(notice: PairingNotice, autoRead: Boolean): Long =
            if (notice is EnterCode && autoRead) AUTO_READ_GRACE_MS else 0L

        /** 已经再提醒过 [sent] 次,下一次隔多久;null 表示不再提醒。 */
        fun realertAfter(notice: PairingNotice, sent: Int): Long? = if (notice is EnterCode) REALERT_MS.getOrNull(sent) else null

        /**
         * [PairingCoordinator] 跟着状态更新通知时的一次计算:这时该显示哪条,显示完是否不再跟。
         * 填了码、配对还没开始([submitted])时一律是「正在配对」,也不在这时结束(助手原本就在运行也一样,配对开始后状态还会变);
         * 「重新配对」时运行中的旧状态不算配好([PhoneSetupFlow.effectiveStatus]),助手在运行、又不在重新配对才结束。
         */
        fun follow(status: BuiltinShellStatus, discovery: PairingDiscovery, repairing: Boolean, submitted: Boolean): Pair<PairingNotice?, Boolean> =
            if (submitted) Working to false
            else of(PhoneSetupFlow.effectiveStatus(status, repairing), discovery) to (status == BuiltinShellStatus.Running && !repairing)
    }
}

/** 系统里已有的一个配对频道;[userSet] 是用户自己改过它的重要程度。 */
data class ChannelSnapshot(val id: String, val importance: Int, val userSet: Boolean)

/** 配对频道怎么处理:[Create] 新建 [id](高优先级);[Use] 用已有的 [id],[health] 是它现在的样子。 */
sealed interface ChannelPlan {
    val id: String
    val health: PairingChannelHealth

    data class Create(override val id: String) : ChannelPlan {
        override val health: PairingChannelHealth get() = PairingChannelHealth.Ready
    }

    data class Use(override val id: String, override val health: PairingChannelHealth) : ChannelPlan
}

/**
 * 配对频道的选择(纯函数,便于测试)。频道的重要程度建好后 App 改不了:
 * 旧版本建得不够高、用户也没动过,就换一个新 id 重建;用户自己调低或关掉的不改回去,交给引导页提示。
 */
object PairingChannel {
    /** 用过的频道 id,越往后越新;新装的直接用最后一个。 */
    val IDS = listOf("pairing_code", "pairing_alert")
    /** 更早版本的频道,见到就删,免得设置里多一项。 */
    const val LEGACY = "pairing"

    fun plan(existing: List<ChannelSnapshot>): ChannelPlan {
        val current = existing.filter { it.id in IDS }.maxByOrNull { IDS.indexOf(it.id) }
            ?: return ChannelPlan.Create(IDS.last())
        val newer = IDS.getOrNull(IDS.indexOf(current.id) + 1)
        return when {
            current.importance == NotificationManager.IMPORTANCE_NONE -> ChannelPlan.Use(current.id, PairingChannelHealth.Off)
            current.importance >= NotificationManager.IMPORTANCE_HIGH -> ChannelPlan.Use(current.id, PairingChannelHealth.Ready)
            current.userSet -> ChannelPlan.Use(current.id, PairingChannelHealth.Lowered)
            newer != null -> ChannelPlan.Create(newer)
            else -> ChannelPlan.Use(current.id, PairingChannelHealth.Lowered)
        }
    }
}

/**
 * 配对通知:高优先级、带声音和振动(勿扰时听系统的),在系统设置的配对窗口上方弹出来;
 * 输入框用 RemoteInput,用户不用离开配对窗口。输入的码交给 [PairingCodeInput]。
 */
object PairingNotifier {
    const val KEY_CODE = "pairing_code"
    const val EXTRA_PORT = "pairing_port"
    private const val ID = 4401
    private const val DONE_TIMEOUT_MS = 8_000L
    /** 填码通知最多留这么久(和找配对窗口的时长一样),App 被杀了也不会一直挂着。 */
    private const val INPUT_TIMEOUT_MS = 10 * 60_000L

    /** No channel yet means enabled by default; a user-disabled channel must stay disabled. */
    fun notificationsAllowed(context: Context): Boolean {
        if (!NotificationManagerCompat.from(context).areNotificationsEnabled()) return false
        if (Build.VERSION.SDK_INT < 26) return true
        val nm = context.getSystemService(NotificationManager::class.java)
        val existing = PairingChannel.IDS.mapNotNull { id ->
            nm.getNotificationChannel(id)?.let {
                ChannelSnapshot(id, it.importance, Build.VERSION.SDK_INT >= 29 && it.hasUserSetImportance())
            }
        }
        return PairingChannel.plan(existing).health != PairingChannelHealth.Off
    }

    /** 确保有一个配对频道,返回要用的那个(引导页据此提示、打开它的设置页)。 */
    fun ensureChannel(context: Context): ChannelPlan {
        val nm = context.getSystemService(NotificationManager::class.java)
        val existing = PairingChannel.IDS.mapNotNull { id ->
            nm.getNotificationChannel(id)?.let { ChannelSnapshot(id, it.importance, it.hasUserSetImportance()) }
        }
        val plan = PairingChannel.plan(existing)
        if (plan is ChannelPlan.Create) {
            nm.createNotificationChannel(
                NotificationChannel(plan.id, PhoneSetupCopy.CHANNEL_NAME, NotificationManager.IMPORTANCE_HIGH).apply {
                    enableVibration(true)
                    setShowBadge(false)
                },
            )
        }
        // Refresh only the localized name; keep the user's channel importance and preferences.
        nm.getNotificationChannel(plan.id)?.let { channel ->
            if (channel.name.toString() != PhoneSetupCopy.CHANNEL_NAME) {
                channel.name = PhoneSetupCopy.CHANNEL_NAME
                nm.createNotificationChannel(channel)
            }
        }
        (PairingChannel.IDS + PairingChannel.LEGACY + "phone_connection").filter { it != plan.id }.forEach { id ->
            if (nm.getNotificationChannel(id) != null) nm.deleteNotificationChannel(id)
        }
        return plan
    }

    fun show(context: Context, notice: PairingNotice) {
        val nm = context.getSystemService(NotificationManager::class.java)
        val channel = ensureChannel(context).id
        val open = PendingIntent.getActivity(
            context, 0, Intent(context, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )
        val b = Notification.Builder(context, channel)
            .setSmallIcon(android.R.drawable.stat_sys_data_bluetooth)
            .setCategory(Notification.CATEGORY_STATUS)
            .setContentIntent(open)
        when (notice) {
            is PairingNotice.EnterCode -> {
                val input = RemoteInput.Builder(KEY_CODE).setLabel(PhoneSetupCopy.NOTIFY_INPUT_LABEL).setAllowFreeFormInput(true).build()
                // RemoteInput 要往 Intent 里填结果,必须是可变的
                val reply = PendingIntent.getBroadcast(
                    context, 1,
                    Intent(context, PairingCodeInput::class.java).apply { notice.port?.let { putExtra(EXTRA_PORT, it) } },
                    PendingIntent.FLAG_MUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
                )
                val action = Notification.Action.Builder(null, PhoneSetupCopy.NOTIFY_ACTION, reply)
                    .addRemoteInput(input)
                    .setAllowGeneratedReplies(false)
                    .setSemanticAction(Notification.Action.SEMANTIC_ACTION_REPLY)
                // 锁着屏也能直接填,不先要求解锁
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) action.setAuthenticationRequired(false)
                val text = notice.error ?: PhoneSetupCopy.NOTIFY_ENTER_TEXT
                b.setContentTitle(PhoneSetupCopy.NOTIFY_ENTER_TITLE)
                    .setContentText(text)
                    .setStyle(Notification.BigTextStyle().bigText(text))
                    .setOngoing(true)
                    // 每次发都要响铃、弹出,包括没人填时的再次提醒和填错后的提示
                    .setOnlyAlertOnce(false)
                    .setTimeoutAfter(INPUT_TIMEOUT_MS)
                    .addAction(action.build())
                if (notice.port != null) b.setSubText(PhoneSetupCopy.NOTIFY_WINDOW_FOUND)
            }
            PairingNotice.Working -> b.setContentTitle(PhoneSetupCopy.NOTIFY_WORKING).setOngoing(true).setOnlyAlertOnce(true)
                .setProgress(0, 0, true)
            PairingNotice.Done -> b.setContentTitle(PhoneSetupCopy.NOTIFY_DONE_TITLE).setContentText(PhoneSetupCopy.NOTIFY_DONE_TEXT)
                .setAutoCancel(true).setOnlyAlertOnce(true).setTimeoutAfter(DONE_TIMEOUT_MS)
            is PairingNotice.Problem -> b.setContentTitle(notice.title).setContentText(PhoneSetupCopy.NOTIFY_PROBLEM_TEXT).setAutoCancel(true)
        }
        // 没允许通知时系统会丢掉它;引导页在配对这一步先请用户允许
        runCatching { nm.notify(ID, b.build()) }
    }

    fun cancel(context: Context) {
        context.getSystemService(NotificationManager::class.java).cancel(ID)
    }
}
