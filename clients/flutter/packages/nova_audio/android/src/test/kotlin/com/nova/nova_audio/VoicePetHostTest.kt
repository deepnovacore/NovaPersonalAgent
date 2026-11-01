package com.nova.nova_audio

import android.app.Activity
import android.os.Looper
import java.time.Duration
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import org.robolectric.shadows.ShadowSettings

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [28])
class VoicePetHostTest {
    @Test fun pauseDoesNotShowAndStopIsDebouncedAcrossActivities() {
        VoicePetHost.initialize(RuntimeEnvironment.getApplication())
        val first = Robolectric.buildActivity(Activity::class.java).create().get()
        val second = Robolectric.buildActivity(Activity::class.java).create().get()
        VoicePetHost.attach(first)
        VoicePetHost.state.task = VoicePetTask("one", "running", "", null)
        VoicePetHost.onActivityPaused(first)
        assertFalse(VoicePetHost.state.visible)
        VoicePetHost.onActivityStopped(first)
        shadowOf(Looper.getMainLooper()).idleFor(Duration.ofMillis(100))
        assertFalse(VoicePetHost.state.visible)
        VoicePetHost.onActivityStarted(second)
        shadowOf(Looper.getMainLooper()).idleFor(Duration.ofMillis(100))
        assertFalse(VoicePetHost.state.visible)
        VoicePetHost.onActivityStopped(second)
        shadowOf(Looper.getMainLooper()).idleFor(Duration.ofMillis(150))
        assertTrue(VoicePetHost.state.visible)
        VoicePetHost.task(null)
    }

    @Test fun probeAddsRealWindowAndImmediatelyRestoresForegroundVisibility() {
        ShadowSettings.setCanDrawOverlays(true)
        VoicePetHost.initialize(RuntimeEnvironment.getApplication())
        val activity = Robolectric.buildActivity(Activity::class.java).create().get()
        VoicePetHost.attach(activity)
        VoicePetHost.task(VoicePetTask("one", "running", "", null))
        assertTrue(VoicePetHost.probe())
        assertFalse(VoicePetHost.state.visible)
        ShadowSettings.setCanDrawOverlays(false)
        assertFalse(VoicePetHost.probe())
        VoicePetHost.task(null)
        VoicePetHost.onActivityStopped(activity)
    }
}
