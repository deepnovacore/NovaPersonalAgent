// Derived from Mika (https://github.com/wangzan101/Mika, Apache-2.0, commit 5f630d9),
// Copyright 2026 wangzan101. Modified by Nova: restricted Binder subset and own-display enforcement.
package com.nova.nova_mobile.phone.shell

import android.annotation.SuppressLint
import android.app.ActivityOptions
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.hardware.display.DisplayManager
import android.hardware.display.VirtualDisplay
import android.os.*
import android.util.Log
import android.view.*
import java.util.concurrent.TimeUnit
import kotlin.system.exitProcess

/** Shell-only process; the Binder authorizes Nova's runtime uid on every transaction. */
class NovaShellService(private val allowedUid: Int, private val appPackage: String) : INovaShell.Stub() {
    private val context: Context = ShellContext.create()
    private val displays = HashMap<Int, VirtualDisplay>()
    private val flagsUsed = HashMap<Int, Int>()
    private val movedOut = HashSet<Int>()
    private val launchLock = Any()
    private val strokeLock = Any()
    private val myUser = allowedUid / 100_000
    @SuppressLint("PrivateApi")
    private val displayManager = DisplayManager::class.java.getDeclaredConstructor(Context::class.java)
        .apply { isAccessible = true }.newInstance(context)
    private val taskManager: Any by lazy {
        Class.forName("android.app.ActivityTaskManager").getMethod("getService").invoke(null)!!
    }
    override fun onTransact(code: Int, data: Parcel, reply: Parcel?, flags: Int): Boolean {
        if (!allowsTransaction(code, Binder.getCallingUid(), allowedUid)) {
            throw SecurityException("caller_not_allowed")
        }
        return super.onTransact(code, data, reply, flags)
    }
    override fun identity() = intArrayOf(Process.myUid(), Process.myPid())
    @Synchronized
    override fun createDisplay(surface: Surface, width: Int, height: Int, dpi: Int): Int = try {
        createVirtualDisplay(surface, width, height, dpi, trusted = true)
    } catch (t: Throwable) {
        if (!retryWithoutTrust(t)) {
            Log.e(TAG, "createDisplay failed", t)
            -1
        } else {
            // shell 没有 ADD_TRUSTED_DISPLAY 时(有的系统不给):去掉只对可信屏可用的几项再建一次。
            // 退回后这块屏没有自己的焦点,自检页读它的标志会报「own focus no」并给出主屏焦点可能受影响的提示(Advice.FocusShared)。
            Log.w(TAG, "createDisplay without trusted display flags, retrying", t)
            try {
                createVirtualDisplay(surface, width, height, dpi, trusted = false)
            } catch (t: Throwable) {
                Log.e(TAG, "createDisplay failed", t)
                -1
            }
        }
    }

    private fun createVirtualDisplay(surface: Surface, width: Int, height: Int, dpi: Int, trusted: Boolean): Int {
        val vd = displayManager.createVirtualDisplay(
            "nova-agent", width, height, dpi, surface, displayFlags(Build.VERSION.SDK_INT, trusted),
        )
        val id = vd.display.displayId
        synchronized(displays) { displays[id] = vd; flagsUsed[id] = displayFlags(Build.VERSION.SDK_INT, trusted) }
        setImePolicy(id)
        return id
    }

    /** 只往这个服务自己建的虚拟屏上启动,调用方传错屏号(比如主屏)也不会打扰用户。 */
    private fun ownDisplay(displayId: Int): Boolean = synchronized(displays) { displayId in displays }

    @Synchronized
    override fun releaseDisplay(displayId: Int) {
        synchronized(launchLock) {
            synchronized(displays) { flagsUsed.remove(displayId); displays.remove(displayId) }?.release()
        }
    }


    @Synchronized
    override fun displayFlags(displayId: Int): Int = synchronized(displays) { flagsUsed[displayId] ?: -1 }

    @Synchronized
    override fun startApp(displayId: Int, packageName: String): Int = synchronized(launchLock) {
        if (!ownDisplay(displayId) || !allowsApp(packageName, appPackage)) return START_ERROR
        try {
            // Missing visibility metadata fails closed: never move a possibly visible main task away.
            val visible = TASK_INFO.getField("isVisible")
            if (tasksOn(0).any { packageName in packagesOf(it) && visible.getBoolean(it) }) return START_IN_USE_ON_MAIN
            val others = synchronized(displays) { displays.keys.toList() }.filter { it != displayId }
            if (others.any { id -> tasksOn(id).any { packageName in packagesOf(it) } }) return START_IN_USE_BY_OTHER
        } catch (_: Throwable) { return START_ERROR }
        val intent = runCatching { context.packageManager.getLaunchIntentForPackage(packageName) }.getOrNull()
            ?: return START_NOT_FOUND
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        val options = ActivityOptions.makeBasic().setLaunchDisplayId(displayId).toBundle()
        val ok = try {
            val start = taskManager.javaClass.methods.first { it.name == "startActivityAsUser" && it.parameterTypes.size == 12 }
            (start.invoke(taskManager, null, ShellContext.SHELL_PACKAGE, null, intent, null, null, null,
                0, 0, null, options, myUser) as Int) >= 0
        } catch (_: Throwable) {
            val component = intent.component?.flattenToShortString() ?: return START_NOT_FOUND
            exec("am", "start", "--user", "$myUser", "--display", "$displayId", "-n", component) == 0
        }
        if (ok) START_OK else START_ERROR
    }
    private fun packagesOf(task: Any): List<String> = listOf("baseActivity", "topActivity").mapNotNull {
        (TASK_INFO.getField(it).get(task) as? ComponentName)?.packageName
    }

    private fun tasksOn(displayId: Int): List<Any> {
        val methods = taskManager.javaClass.methods.filter { it.name == "getTasks" }
        val withDisplay = methods.firstOrNull { it.parameterTypes.size == 4 }
        val tasks = if (withDisplay != null) {
            withDisplay.invoke(taskManager, MAX_TASKS, false, false, displayId)
        } else {
            methods.first { it.parameterTypes.size == 3 }.invoke(taskManager, MAX_TASKS, false, false)
        } as List<*>
        val displayField = TASK_INFO.getField("displayId")
        return tasks.filterNotNull().filter { displayField.getInt(it) == displayId }
    }

    /** 所有屏上的任务:带屏号的重载传 INVALID_DISPLAY 即不按屏过滤。 */
    private fun allTasks(): List<Any> {
        val methods = taskManager.javaClass.methods.filter { it.name == "getTasks" }
        val withDisplay = methods.firstOrNull { it.parameterTypes.size == 4 }
        val tasks = if (withDisplay != null) {
            withDisplay.invoke(taskManager, MAX_TASKS, false, false, Display.INVALID_DISPLAY)
        } else {
            methods.first { it.parameterTypes.size == 3 }.invoke(taskManager, MAX_TASKS, false, false)
        } as List<*>
        return tasks.filterNotNull()
    }

    private fun task(taskId: Int): Any? {
        val idField = TASK_INFO.getField("taskId")
        return allTasks().firstOrNull { idField.getInt(it) == taskId }
    }

    override fun displayOfTask(taskId: Int): Int = try {
        task(taskId)?.let { TASK_INFO.getField("displayId").getInt(it) } ?: -1
    } catch (t: Throwable) {
        Log.e(TAG, "displayOfTask failed", t)
        -1
    }

    @Synchronized
    override fun topTaskId(displayId: Int): Int = try {
        if (!ownDisplay(displayId)) -1 else tasksOn(displayId).firstOrNull()?.let { TASK_INFO.getField("taskId").getInt(it) } ?: -1
    } catch (t: Throwable) {
        Log.e(TAG, "topTaskId failed", t)
        -1
    }

    @Synchronized
    override fun topActivity(displayId: Int): String? = try {
        if (!ownDisplay(displayId)) null else tasksOn(displayId).firstOrNull()?.let {
            (TASK_INFO.getField("topActivity").get(it) as? ComponentName)?.className
        }
    } catch (t: Throwable) {
        Log.e(TAG, "topActivity failed", t)
        null
    }


    @Synchronized
    override fun moveTask(taskId: Int, displayId: Int): Boolean = synchronized(launchLock) {
        val from = displayOfTask(taskId)
        val own = synchronized(displays) { displays.keys.toSet() }
        if (!allowsTaskMove(taskId, from, displayId, own, movedOut)) return false
        val outward = displayId == Display.DEFAULT_DISPLAY
        val ok = try {
            taskManager.javaClass.getMethod("moveRootTaskToDisplay", Int::class.java, Int::class.java)
                .invoke(taskManager, taskId, displayId)
            true
        } catch (_: Throwable) { exec("am", "display", "move-stack", "$taskId", "$displayId") == 0 }
        if (ok) { if (outward) movedOut.add(taskId) else movedOut.remove(taskId) }
        ok
    }
    @Synchronized
    override fun injectKey(displayId: Int, keyCode: Int): Boolean {
        // 与 press_key 同一张白名单:即便调用方出错,也不从这里发出音量、电源、Home 之类的整机按键
        if (!ownDisplay(displayId) || keyCode !in ALLOWED_KEYS) {
            Log.w(TAG, "refused key $keyCode")
            return false
        }
        val now = SystemClock.uptimeMillis()
        val down = KeyEvent(now, now, KeyEvent.ACTION_DOWN, keyCode, 0, 0, VIRTUAL_KEYBOARD, 0, 0, InputDevice.SOURCE_KEYBOARD)
        val up = KeyEvent.changeAction(down, KeyEvent.ACTION_UP)
        return injectPair(down, up, displayId) { exec("input", "-d", "$displayId", "keyevent", "$keyCode") == 0 }
    }

    @Synchronized
    override fun injectTap(displayId: Int, x: Int, y: Int): Boolean {
        if (!ownDisplay(displayId)) return false
        val now = SystemClock.uptimeMillis()
        val down = MotionEvent.obtain(now, now, MotionEvent.ACTION_DOWN, x.toFloat(), y.toFloat(), 0)
        val up = MotionEvent.obtain(now, now + TAP_MS, MotionEvent.ACTION_UP, x.toFloat(), y.toFloat(), 0)
        return try {
            down.source = InputDevice.SOURCE_TOUCHSCREEN
            up.source = InputDevice.SOURCE_TOUCHSCREEN
            injectPair(down, up, displayId) { exec("input", "-d", "$displayId", "tap", "$x", "$y") == 0 }
        } finally {
            down.recycle()
            up.recycle()
        }
    }

    /**
     * 一根手指的一笔:按下、按 [times] 逐点移动、在最后一点抬起;每个事件到了它的时刻才注入(事件时间就是那一刻),
     * App 看到的速度就是 Nova 排好的快慢。只发到 Nova 自己的屏。按下没注入成功返回 false(调用方改走别的路);
     * 按下之后中途哪个点没注入成功也照样往下走,最后一定补发抬起,不让手指一直按着。
     */
    override fun injectStroke(displayId: Int, xs: IntArray, ys: IntArray, times: LongArray): Boolean {
        synchronized(strokeLock) {
            val n = times.size
            synchronized(this) {
                if (!ownDisplay(displayId)) return false
                if (n < 2 || n > STROKE_MAX_POINTS || xs.size != n || ys.size != n || times[0] != 0L ||
                    times.last() > STROKE_MAX_MS || (1 until n).any { times[it] < times[it - 1] }
                ) return false
            }
            val down = SystemClock.uptimeMillis()
            fun event(i: Int, action: Int): MotionEvent {
                val props = MotionEvent.PointerProperties().apply { id = 0; toolType = MotionEvent.TOOL_TYPE_FINGER }
                val coords = MotionEvent.PointerCoords().apply { x = xs[i].toFloat(); y = ys[i].toFloat(); pressure = 1f; size = 1f }
                return MotionEvent.obtain(down, down + times[i], action, 1, arrayOf(props), arrayOf(coords), 0, 0, 1f, 1f, 0, 0, InputDevice.SOURCE_TOUCHSCREEN, 0)
            }
            fun send(i: Int, action: Int): Boolean {
                val wait = down + times[i] - SystemClock.uptimeMillis()
                if (wait > 0) SystemClock.sleep(wait)
                return synchronized(this) {
                    if (!ownDisplay(displayId)) return false
                    val e = event(i, action)
                    try { inject(e, displayId) } finally { e.recycle() }
                }
            }
            if (!send(0, MotionEvent.ACTION_DOWN)) return false
            for (i in 1 until n) send(i, MotionEvent.ACTION_MOVE)
            return send(n - 1, MotionEvent.ACTION_UP) || send(n - 1, MotionEvent.ACTION_UP)
        }
    }

    /**
     * 只有 DOWN 就没注入成功时才退回 shell 命令;DOWN 已送达后再退回会造成一次多余的完整点击/按键,
     * 这时只补发 UP(失败重试一次)。
     */
    private inline fun injectPair(down: InputEvent, up: InputEvent, displayId: Int, fallback: () -> Boolean): Boolean {
        return injectDownUp({ inject(down, displayId) }, { inject(up, displayId) }, fallback)
    }


    @Synchronized
    override fun releaseAll() = synchronized(launchLock) {
        movedOut.clear()
        synchronized(displays) { displays.values.toList().also { displays.clear(); flagsUsed.clear() } }
            .forEach { runCatching { it.release() } }
    }
    override fun destroy() { releaseAll(); exitProcess(0) }
    /** IWindowManager.setDisplayImePolicy:输入法不弹到用户的主屏。选哪种策略见 IME_POLICY。 */
    @SuppressLint("PrivateApi")
    private fun setImePolicy(displayId: Int) {
        runCatching {
            val wm = Class.forName("android.view.WindowManagerGlobal").getMethod("getWindowManagerService").invoke(null)!!
            wm.javaClass.getMethod("setDisplayImePolicy", Int::class.java, Int::class.java).invoke(wm, displayId, IME_POLICY)
        }.onFailure { Log.w(TAG, "setDisplayImePolicy failed", it) }
    }

    @SuppressLint("PrivateApi")
    private fun inject(event: InputEvent, displayId: Int, waitForFinish: Boolean = false): Boolean = try {
        event.javaClass.getMethod("setDisplayId", Int::class.java).invoke(event, displayId)
        val manager = inputManager()
        manager.javaClass.getMethod("injectInputEvent", InputEvent::class.java, Int::class.java)
            .invoke(manager, event, if (waitForFinish) INJECT_MODE_WAIT_FOR_FINISH else INJECT_MODE_ASYNC) as Boolean
    } catch (t: Throwable) {
        Log.w(TAG, "injectInputEvent failed", t)
        false
    }


    /** API 34 moved injection to InputManagerGlobal. */
    @SuppressLint("PrivateApi")
    private fun inputManager(): Any = runCatching {
        Class.forName("android.hardware.input.InputManagerGlobal").getMethod("getInstance").invoke(null)
    }.getOrNull() ?: Class.forName("android.hardware.input.InputManager").getMethod("getInstance").invoke(null)!!

    private fun exec(vararg command: String): Int = try {
        val process = ProcessBuilder(*command).redirectOutput(java.io.File("/dev/null"))
            .redirectError(java.io.File("/dev/null")).start()
        if (process.waitFor(10, TimeUnit.SECONDS)) process.exitValue()
        else { process.destroyForcibly(); -1 }
    } catch (_: Exception) { -1 }

    companion object {
        internal fun allowsTransaction(code: Int, caller: Int, owner: Int): Boolean =
            code !in FIRST_CALL_TRANSACTION..LAST_CALL_TRANSACTION || caller == owner

        internal fun allowsApp(packageName: String, appPackage: String): Boolean =
            PACKAGE.matches(packageName) && packageName != appPackage

        internal fun allowsTaskMove(taskId: Int, from: Int, to: Int, own: Set<Int>, moved: Set<Int>): Boolean =
            (from in own && to == Display.DEFAULT_DISPLAY) ||
                (from == Display.DEFAULT_DISPLAY && taskId in moved && to in own)

        /** Once DOWN arrived, repeating the whole gesture could click twice. Retry only UP. */
        internal inline fun injectDownUp(down: () -> Boolean, up: () -> Boolean, fallback: () -> Boolean): Boolean {
            if (!down()) return fallback()
            return up() || up()
        }

        private const val TAG = "NovaShell"
        private const val MAX_TASKS = 100
        private const val TAP_MS = 50L
        private const val STROKE_MAX_POINTS = 1024
        private const val STROKE_MAX_MS = 10_000L
        private const val VIRTUAL_KEYBOARD = -1
        private const val INJECT_MODE_ASYNC = 0
        private const val INJECT_MODE_WAIT_FOR_FINISH = 2
        private const val IME_POLICY = 0
        private val TASK_INFO: Class<*> by lazy { Class.forName("android.app.TaskInfo") }
        private val PACKAGE = Regex("[A-Za-z][A-Za-z0-9_]*(\\.[A-Za-z0-9_]+)+")
        internal val ALLOWED_KEYS = setOf(19, 20, 21, 22, 23, 66, 160, 67, 112, 61, 62, 111, 92, 93, 122, 123, 4, 82)
        const val START_OK = INovaShell.START_OK
        const val START_IN_USE_ON_MAIN = INovaShell.START_IN_USE_ON_MAIN
        const val START_NOT_FOUND = INovaShell.START_NOT_FOUND
        const val START_ERROR = INovaShell.START_ERROR
        const val START_IN_USE_BY_OTHER = INovaShell.START_IN_USE_BY_OTHER
        // DisplayManager.VIRTUAL_DISPLAY_FLAG_*(部分为隐藏常量)
        private const val FLAG_PUBLIC = 1 shl 0
        private const val FLAG_OWN_CONTENT_ONLY = 1 shl 3
        private const val FLAG_SUPPORTS_TOUCH = 1 shl 6
        private const val FLAG_ROTATES_WITH_CONTENT = 1 shl 7
        private const val FLAG_DESTROY_CONTENT_ON_REMOVAL = 1 shl 8
        private const val FLAG_TRUSTED = 1 shl 10
        private const val FLAG_OWN_DISPLAY_GROUP = 1 shl 11
        private const val FLAG_ALWAYS_UNLOCKED = 1 shl 12
        private const val FLAG_TOUCH_FEEDBACK_DISABLED = 1 shl 13
        private const val FLAG_OWN_FOCUS = 1 shl 14
        private const val FLAG_STEAL_TOP_FOCUS_DISABLED = 1 shl 16

        /**
         * 建虚拟屏用的标志。[trusted] 为 false 时去掉依赖可信屏的那几项:有的系统里 shell 没有
         * ADD_TRUSTED_DISPLAY,带上 TRUSTED 会被系统以 SecurityException 拒绝;OWN_DISPLAY_GROUP、ALWAYS_UNLOCKED
         * 和 OWN_FOCUS/STEAL_TOP_FOCUS_DISABLED 同样只对可信屏可用。其余几项与可信与否无关,照旧。
         */
        internal fun displayFlags(sdk: Int, trusted: Boolean): Int {
            var flags = FLAG_PUBLIC or FLAG_OWN_CONTENT_ONLY or FLAG_SUPPORTS_TOUCH or
                FLAG_ROTATES_WITH_CONTENT or FLAG_DESTROY_CONTENT_ON_REMOVAL
            if (sdk >= Build.VERSION_CODES.TIRAMISU) {
                flags = flags or FLAG_TOUCH_FEEDBACK_DISABLED
                if (trusted) flags = flags or FLAG_TRUSTED or FLAG_OWN_DISPLAY_GROUP or FLAG_ALWAYS_UNLOCKED
            }
            // 只有 OWN_FOCUS 时,虚拟屏上启动 App 或 App 自己开新页面都会让它成为「最上层焦点屏」,
            // 主屏的焦点窗口随之清空;STEAL_TOP_FOCUS_DISABLED(需同时有 OWN_FOCUS、TRUSTED)让它不抢主屏的焦点
            if (sdk >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE && trusted) {
                flags = flags or FLAG_OWN_FOCUS or FLAG_STEAL_TOP_FOCUS_DISABLED
            }
            return flags
        }

        /** 只有缺权限(SecurityException,如 shell 没有 ADD_TRUSTED_DISPLAY)才值得去掉可信标志再试;别的失败照旧报错。 */
        internal fun retryWithoutTrust(t: Throwable): Boolean = t is SecurityException

    }
}
