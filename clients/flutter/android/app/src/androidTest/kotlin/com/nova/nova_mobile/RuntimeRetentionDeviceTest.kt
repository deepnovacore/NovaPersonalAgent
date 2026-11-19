package com.nova.nova_mobile

import android.content.Intent
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.runner.AndroidJUnit4
import androidx.test.runner.lifecycle.ActivityLifecycleMonitorRegistry
import androidx.test.runner.lifecycle.Stage
import com.nova.nova_mobile.phone.PhoneBridge
import io.flutter.embedding.android.FlutterActivity
import io.flutter.embedding.engine.FlutterEngine
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class RuntimeRetentionDeviceTest {
    @Test fun activityRecreationKeepsEngineAndNativeTaskOwner() {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val context = instrumentation.targetContext
        check(context.packageName != MainActivity::class.java.`package`!!.name && context.applicationInfo.flags and android.content.pm.ApplicationInfo.FLAG_DEBUGGABLE != 0) { "Use the isolated acceptance package" }
        val first = instrumentation.startActivitySync(Intent(context, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)) as MainActivity
        instrumentation.waitForIdleSync()
        Thread.sleep(1500)
        val getter = FlutterActivity::class.java.getDeclaredMethod("getFlutterEngine").apply { isAccessible = true }
        var engine: FlutterEngine? = null
        var taskOwner: Any? = null
        instrumentation.runOnMainSync {
            engine = getter.invoke(first) as FlutterEngine
            NovaSpaceScope.select("runtime-retention-test", "standalone")
            taskOwner = PhoneBridge.of(context).takeover
            first.recreate()
        }
        var second: MainActivity? = null
        val deadline = System.currentTimeMillis() + 10000
        while (second == null && System.currentTimeMillis() < deadline) {
            instrumentation.runOnMainSync {
                second = ActivityLifecycleMonitorRegistry.getInstance().getActivitiesInStage(Stage.RESUMED)
                    .filterIsInstance<MainActivity>().firstOrNull { it !== first }
            }
            if (second == null) Thread.sleep(100)
        }
        try {
            assertNotNull("Activity was recreated", second)
            assertNotNull("Native task owner was initialized", taskOwner)
            instrumentation.runOnMainSync {
                assertSame("Page destruction must not destroy the running Dart engine", engine, getter.invoke(second))
                assertTrue(engine!!.dartExecutor.isExecutingDart)
                assertSame("Page reattachment must not cancel or replace native tasks", taskOwner, PhoneBridge.of(context).takeover)
                NovaSpaceScope.select("runtime-retention-other", "standalone")
                assertNotSame("An explicit Space switch must retire the old native owner", taskOwner, PhoneBridge.of(context).takeover)
            }
        } finally {
            instrumentation.runOnMainSync { second?.finish() }
            val finishDeadline = System.currentTimeMillis() + 5000
            while (second?.isDestroyed == false && System.currentTimeMillis() < finishDeadline) Thread.sleep(50)
            instrumentation.waitForIdleSync()
            instrumentation.runOnMainSync {
                if (second?.isDestroyed == true && engine?.dartExecutor?.isExecutingDart == true) engine?.destroy()
            }
        }
    }
}
