// Derived from Mika (https://github.com/wangzan101/Mika, Apache-2.0, commit 5f630d9),
// Copyright 2026 wangzan101. Modified by Nova: package names and scoped native phone integration.
package com.nova.phone.core.shell

import java.security.MessageDigest
import java.security.SecureRandom

/**
 * 助手进程把 Binder 交给 Nova 时双方共用的约定:provider 的方法名和 Bundle 键、助手的进程名、启动命令,
 * 以及 Nova 一侧收下之前要过的检查。
 */
object HelperHandoff {
    const val SHELL_UID = 2000
    const val METHOD_ATTACH = "attach"
    const val HELPER_CLASS = "com.nova.nova_mobile.phone.shell.HelperMain"

    // 助手 → Nova
    const val KEY_NONCE = "nonce"
    const val KEY_BINDER = "binder"
    const val KEY_UID = "uid"
    const val KEY_PID = "pid"
    const val KEY_APK = "apk"
    // Nova → 助手
    const val KEY_ACCEPTED = "accepted"
    const val KEY_NEXT = "next"
    const val KEY_TOKEN = "token"
    const val KEY_REASON = "reason"

    fun authority(packageName: String) = "$packageName.helper"

    /** 助手的进程名(app_process 的 --nice-name);同时用来认出旧的助手实例。 */
    fun processName(packageName: String) = "$packageName:helper"

    /**
     * 经 adbd 的 exec: 服务执行的命令(adbd 用 `sh -c` 跑它)。流一关,adbd 就把 sh 那一组进程都杀掉,
     * 所以助手用 setsid 另起会话;sh 再 `read` 等着,直到 App 收到交接后关流,
     * 免得 setsid 还没生效 sh 就退出、助手被连带杀掉。
     *
     * 口令不进命令行(同为 shell 的进程能读 /proc/<pid>/cmdline):App 开流后写一行 [stdinLine],
     * sh 读进变量,再用内建 echo 经管道交给助手;助手的标准输入是这条管道,不是 adb 的流。
     * [certPin] 是 Nova 签名证书的指纹,不是秘密,放在参数里。
     */
    fun command(apkPath: String, packageName: String, appUid: Int, certPin: String): String =
        "read n; (echo \"\$n\" | CLASSPATH=${quote(apkPath)} setsid app_process /system/bin " +
            "--nice-name=${quote(processName(packageName))} $HELPER_CLASS ${quote(packageName)} $appUid ${quote(certPin)} " +
            ">/dev/null 2>&1 &); read _"

    fun stdinLine(nonce: String): ByteArray = "$nonce\n".toByteArray(Charsets.UTF_8)

    /** 签名证书(DER)的 SHA-256 指纹;多个签名者时排序后用逗号连起来。没有证书返回 null。 */
    fun certPin(certs: List<ByteArray>?): String? {
        if (certs.isNullOrEmpty()) return null
        return certs.map { c -> MessageDigest.getInstance("SHA-256").digest(c).joinToString("") { "%02x".format(it) } }
            .sorted().joinToString(",")
    }

    private fun quote(s: String) = "'" + s.replace("'", "'\\''") + "'"

    enum class Reject {
        /** 调用方不是 shell(uid 2000)。 */
        NotShell,
        /** 助手自报的 uid/pid 和 Binder 看到的调用方对不上。 */
        IdMismatch,
        /** 助手跑的不是当前安装的这份 APK(Nova 更新过):让它退出,重新起一个。 */
        StaleApk,
        NoBinder,
        BadNonce,
        /** Binder 所在的进程不是来交接的那个。 */
        BinderElsewhere,
    }

    /** 不碰 Binder 就能做的检查;通过返回 null。口令另由 [HandoffNonces] 核对。 */
    fun check(
        callingUid: Int, callingPid: Int, reportedUid: Int, reportedPid: Int,
        helperApk: String?, appApk: String, hasBinder: Boolean,
    ): Reject? = when {
        callingUid != SHELL_UID -> Reject.NotShell
        reportedUid != callingUid || reportedPid != callingPid -> Reject.IdMismatch
        helperApk != appApk -> Reject.StaleApk
        !hasBinder -> Reject.NoBinder
        else -> null
    }
}

/** Persisted reconnect credential and short-lived launch credential (monotonic milliseconds). */
data class NonceSlots(
    val resume: String? = null, val launch: String? = null, val launchAt: Long = 0,
)

interface NonceStore {
    fun load(): NonceSlots
    fun save(slots: NonceSlots)
}

/**
 * Nova 生成、一次有效的交接口令。任何一枚被用掉,几枚都作废,并换发一枚新的 [NonceSlots.resume] 给收下的助手;
 * 存下来是为了 Nova 进程被杀后,还活着的助手拿它重新交接时新进程认得。
 * [clock] measures launch credential age since boot.
 */
class HandoffNonces(
    private val store: NonceStore,
    private val clock: () -> Long,
    private val random: () -> String = ::randomNonce,
) {
    @Synchronized
    fun issueLaunch(): String = random().also { store.save(store.load().copy(launch = it, launchAt = clock())) }

    @Synchronized
    fun matches(nonce: String?): Boolean {
        if (nonce == null) return false
        val s = store.load()
        val age = clock() - s.launchAt
        // 启动口令只在交接等待期内有效;没用上的过期作废
        val launch = s.launch?.takeIf { age in 0..LAUNCH_TTL_MS }
        return same(nonce, s.resume) or same(nonce, launch)
    }

    /** 口令对就用掉它并返回换发的新口令,不对返回 null。 */
    @Synchronized
    fun accept(nonce: String?): String? {
        if (!matches(nonce)) return null
        return random().also { store.save(NonceSlots(resume = it)) }
    }

    @Synchronized
    fun clear() { store.save(NonceSlots()) }

    private fun same(a: String, b: String?) =
        b != null && MessageDigest.isEqual(a.toByteArray(Charsets.UTF_8), b.toByteArray(Charsets.UTF_8))

    companion object {
        /** 覆盖 App 开着流等交接、引擎再等一轮交接的总时长。 */
        const val LAUNCH_TTL_MS = 30_000L
        private val rng = SecureRandom()
        fun randomNonce(): String = ByteArray(32).also(rng::nextBytes).joinToString("") { "%02x".format(it) }
    }
}
