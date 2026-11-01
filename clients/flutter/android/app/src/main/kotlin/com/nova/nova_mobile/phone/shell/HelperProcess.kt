// Derived from Mika (https://github.com/wangzan101/Mika, Apache-2.0, commit 5f630d9),
// Copyright 2026 wangzan101. Modified by Nova: package names and scoped native phone integration.
package com.nova.nova_mobile.phone.shell

import android.annotation.SuppressLint
import android.app.ActivityManager
import android.content.AttributionSource
import android.content.Context
import android.content.pm.PackageInfo
import android.content.pm.PackageManager
import android.content.pm.ProviderInfo
import android.os.Binder
import android.os.Bundle
import android.os.Handler
import android.os.HandlerThread
import android.os.IBinder
import android.os.Looper
import android.os.Process
import android.util.Log
import com.nova.phone.core.shell.HelperHandoff
import java.io.File
import java.lang.reflect.Proxy
import kotlin.system.exitProcess

/** Runs as shell, authenticates the installed app before every handoff, and cleans up on app death.
 * The nonce arrives only on stdin. Automatic app/accessibility restoration is not part of this port.
 */
object HelperProcess {
    private const val TAG = "NovaHelper"

    @JvmStatic
    fun main(args: Array<String>) {
        if (args.size < 3) {
            Log.e(TAG, "usage: HelperMain <package> <uid> <cert-sha256> (nonce on stdin)")
            exitProcess(2)
        }
        val packageName = args[0]
        val appUid = args[1].toIntOrNull() ?: exitProcess(2)
        val certPin = args[2]
        // 读完就关:标准输入只用来递口令
        val launchNonce = runCatching { System.`in`.bufferedReader().readLine()?.trim() }.getOrNull()
        runCatching { System.`in`.close() }
        if (launchNonce.isNullOrEmpty()) {
            Log.e(TAG, "no nonce on stdin")
            exitProcess(2)
        }
        // ShellContext 自建 ActivityThread 时要有主线程 Looper
        Looper.prepareMainLooper()
        val service = NovaShellService(allowedUid = appUid)
        val helper = Helper(service, packageName, appUid, certPin)
        helper.start(launchNonce)
        Looper.loop()
    }

    private class Helper(
        private val service: NovaShellService,
        private val packageName: String,
        private val appUid: Int,
        private val certPin: String,
    ) {
        private val context: Context = ShellContext.create()
        private val authority = HelperHandoff.authority(packageName)
        private val userId = appUid / PER_USER_RANGE
        /** 交接、Nova 死亡处理都排在这一条线程上,彼此不交错,也不堵主线程。 */
        private val worker = Handler(HandlerThread("helper-handoff").apply { start() }.looper)
        /** 下次交接用的口令(Nova 上次收下时换发的)。 */
        private var nonce: String? = null
        /** Nova 进程交给我们的令牌;为 null 表示 Nova 现在不在。 */
        private var appToken: IBinder? = null
        private var retrying = false
        fun start(launchNonce: String) = worker.post {
            when (deliver(launchNonce)) {
                Outcome.Accepted -> {
                    // Nova 收下了这一个:之前起的(或残留的)助手实例都该走了
                    killOtherInstances()
                    watchUid()
                }
                Outcome.Rejected -> { service.releaseAll(); exitProcess(0) }
                Outcome.Failed -> exitProcess(1)
            }
        }

        private enum class Outcome { Accepted, Rejected, Failed }

        /** 经 ActivityManager 拿 Nova 的 provider(同 `content call` 的做法),把 Binder 和自报的 uid/pid 交过去。 */
        @SuppressLint("PrivateApi", "DiscouragedPrivateApi")
        private fun deliver(n: String?): Outcome {
            if (n == null) return Outcome.Rejected
            // 包名和 uid 可能被重装的别的 App 占用:签名对不上就不交 Binder,撤掉改动退出
            if (!signedAsPinned()) {
                Log.e(TAG, "$packageName is missing or not signed with the pinned certificate; exiting")
                runCatching { service.releaseAll() }
                exitProcess(0)
            }
            val am = Class.forName("android.app.ActivityManager").getMethod("getService").invoke(null)!!
            val token = Binder()
            val holder = try {
                am.javaClass.getMethod(
                    "getContentProviderExternal", String::class.java, Int::class.javaPrimitiveType,
                    IBinder::class.java, String::class.java,
                ).invoke(am, authority, userId, token, TAG)
            } catch (t: Throwable) {
                Log.w(TAG, "getContentProviderExternal failed", t)
                return Outcome.Failed
            } ?: return Outcome.Failed
            try {
                // 同名 authority 只可能属于一个包;还是核对一下,不把 Binder 交给 Nova 以外的 App
                val info = holder.javaClass.getField("info").get(holder) as? ProviderInfo
                if (info == null || info.packageName != packageName || info.applicationInfo?.uid != appUid) {
                    Log.e(TAG, "provider $authority does not belong to $packageName/$appUid")
                    return Outcome.Rejected
                }
                val provider = holder.javaClass.getField("provider").get(holder)!!
                val extras = Bundle().apply {
                    putString(HelperHandoff.KEY_NONCE, n)
                    putBinder(HelperHandoff.KEY_BINDER, service)
                    putInt(HelperHandoff.KEY_UID, Process.myUid())
                    putInt(HelperHandoff.KEY_PID, Process.myPid())
                    putString(HelperHandoff.KEY_APK, System.getProperty("java.class.path"))

                }
                val call = provider.javaClass.methods.first {
                    it.name == "call" && it.parameterTypes.size == 5 && it.parameterTypes[0] == AttributionSource::class.java
                }
                val caller = AttributionSource.Builder(Process.myUid()).setPackageName(ShellContext.SHELL_PACKAGE).build()
                val result = call.invoke(provider, caller, authority, HelperHandoff.METHOD_ATTACH, null, extras) as Bundle?
                if (result?.getBoolean(HelperHandoff.KEY_ACCEPTED) != true) {
                    Log.w(TAG, "handoff rejected: ${result?.getString(HelperHandoff.KEY_REASON)}")
                    return Outcome.Rejected
                }
                val appBinder = result.getBinder(HelperHandoff.KEY_TOKEN) ?: return Outcome.Rejected
                nonce = result.getString(HelperHandoff.KEY_NEXT)
                appToken = appBinder
                try {
                    appBinder.linkToDeath({ worker.post { onAppDied(appBinder) } }, 0)
                } catch (t: Throwable) {
                    worker.post { onAppDied(appBinder) }
                }
                Log.i(TAG, "handed off to $packageName")
                return Outcome.Accepted
            } catch (t: Throwable) {
                Log.w(TAG, "handoff failed", t)
                return Outcome.Failed
            } finally {
                runCatching {
                    am.javaClass.getMethod(
                        "removeContentProviderExternalAsUser", String::class.java, IBinder::class.java, Int::class.javaPrimitiveType,
                    ).invoke(am, authority, token, userId)
                }
            }
        }

        /** Nova 进程没了:它建的屏、静音、剪贴板改动跟着撤掉(和服务结束时一样),助手本身留着。 */
        private fun onAppDied(token: IBinder) {
            if (appToken !== token) return
            appToken = null
            runCatching { service.releaseAll() }.onFailure { Log.w(TAG, "cleanup failed", it) }
            if (!installed()) {
                Log.i(TAG, "$packageName is gone; exiting")
                exitProcess(0)
            }
            Log.i(TAG, "$packageName died; waiting for it to come back")
        }

        @SuppressLint("DiscouragedPrivateApi")
        private fun installed(): Boolean = runCatching {
            context.packageManager.javaClass.getMethod("getPackageUidAsUser", String::class.java, Int::class.javaPrimitiveType, Int::class.javaPrimitiveType)
                .invoke(context.packageManager, packageName, 0, userId)
            true
        }.getOrElse { t ->
            // 包不在了才退出;反射不可用时看不清,当作还在
            val cause = (t as? java.lang.reflect.InvocationTargetException)?.targetException ?: t
            cause !is android.content.pm.PackageManager.NameNotFoundException
        }

        /**
         * 盯着 Nova 的 uid:进程重新起来时(从不存在变成任一状态)系统会报一次,这时把 Binder 再交过去。
         * 用的是 ActivityManager 的 uid 重要性监听(要 PACKAGE_USAGE_STATS,shell 有),回调在 binder 线程。
         * 注册不上时由 Nova 那边兜底:等不到交接就经 adbd 另起一个助手,新的收下后会结束这个。
         */
        @SuppressLint("PrivateApi", "DiscouragedPrivateApi")
        private fun watchUid() {
            runCatching {
                // 用 shell 包名的上下文建 ActivityManager:注册时系统按调用方包名核对权限
                val manager = ActivityManager::class.java.getDeclaredConstructor(Context::class.java, Handler::class.java)
                    .apply { isAccessible = true }.newInstance(context, worker)
                val listenerClass = Class.forName("android.app.ActivityManager\$OnUidImportanceListener")
                val listener = Proxy.newProxyInstance(HelperProcess::class.java.classLoader, arrayOf(listenerClass)) { proxy, method, a ->
                    when (method.name) {
                        "onUidImportance" -> { onUidImportance(a[0] as Int, a[1] as Int); null }
                        "hashCode" -> System.identityHashCode(proxy)
                        "equals" -> proxy === a?.getOrNull(0)
                        "toString" -> "NovaHelperUidListener"
                        else -> null
                    }
                }
                ActivityManager::class.java.getMethod("addOnUidImportanceListener", listenerClass, Int::class.javaPrimitiveType)
                    .invoke(manager, listener, ActivityManager.RunningAppProcessInfo.IMPORTANCE_CACHED)
            }.onFailure { Log.w(TAG, "cannot watch $packageName; relying on the app to restart the helper", it) }
        }

        private fun onUidImportance(uid: Int, importance: Int) {
            if (uid != appUid || importance == ActivityManager.RunningAppProcessInfo.IMPORTANCE_GONE) return
            worker.post { if (appToken == null && !retrying) redeliver(0) }
        }

        /** 重新交接;provider 暂时不可用时隔一会儿再试几次,还不行就等下一次 Nova 起来。 */
        private fun redeliver(attempt: Int) {
            if (appToken != null) return
            when (deliver(nonce)) {
                Outcome.Accepted -> retrying = false
                // Nova 不认这个助手了(重装过、解除了配对、或者已经换了新的):退出
                Outcome.Rejected -> { service.releaseAll(); exitProcess(0) }
                Outcome.Failed -> {
                    retrying = attempt + 1 < RETRY_DELAYS_MS.size
                    if (retrying) worker.postDelayed({ redeliver(attempt + 1) }, RETRY_DELAYS_MS[attempt + 1])
                }
            }
        }

        /** 现在装着的 [packageName] 仍是这个 uid、签名证书指纹与启动时 Nova 给的一致。看不清一律当不一致。 */
        @SuppressLint("DiscouragedPrivateApi")
        private fun signedAsPinned(): Boolean = runCatching {
            val pm = context.packageManager
            val flags = PackageManager.GET_SIGNING_CERTIFICATES
            val info = if (userId == 0) pm.getPackageInfo(packageName, flags)
            else pm.javaClass.getMethod("getPackageInfoAsUser", String::class.java, Int::class.javaPrimitiveType, Int::class.javaPrimitiveType)
                .invoke(pm, packageName, flags, userId) as PackageInfo
            val signers = info.signingInfo?.apkContentsSigners?.map { it.toByteArray() }
            info.applicationInfo?.uid == appUid && HelperHandoff.certPin(signers) == certPin
        }.getOrElse { t ->
            Log.w(TAG, "cannot read signing info of $packageName", t)
            false
        }

        /** 只认进程名完全相同的同 uid 进程:别的 app_process 不能误伤。 */
        private fun killOtherInstances() {
            val me = Process.myPid()
            val name = HelperHandoff.processName(packageName)
            File("/proc").listFiles()?.forEach { dir ->
                val pid = dir.name.toIntOrNull() ?: return@forEach
                if (pid == me) return@forEach
                val cmdline = runCatching { File(dir, "cmdline").readBytes() }.getOrNull() ?: return@forEach
                val argv0 = String(cmdline.takeWhile { it != 0.toByte() }.toByteArray())
                if (argv0 == name) {
                    Log.i(TAG, "stopping older helper $pid")
                    Process.killProcess(pid)
                }
            }
        }

        companion object {
            private const val PER_USER_RANGE = 100_000
            private val RETRY_DELAYS_MS = longArrayOf(0, 1_000, 3_000, 10_000)
        }
    }
}
