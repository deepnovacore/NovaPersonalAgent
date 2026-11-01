package com.nova.nova_audio

import android.view.View
import android.view.ViewGroup
import android.view.WindowManager
import android.widget.Button
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config
import org.robolectric.shadows.ShadowSettings

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [28])
class VoiceCallOverlayTest {
    @Test fun stepUpdateKeepsButtonsAndTheirClickListenersAttached() {
        ShadowSettings.setCanDrawOverlays(true)
        val actions = mutableListOf<String>()
        val overlay = VoiceCallOverlay(RuntimeEnvironment.getApplication(), { actions.add(it) }, {}, {}, {})
        val task = VoicePetTask("one", "running", "First", 1)
        overlay.setMode(true, task, false)
        assertTrue(overlay.show())
        fun field(name: String) = VoiceCallOverlay::class.java.getDeclaredField(name).apply { isAccessible = true }.get(overlay)
        (field("orb") as View).performClick()
        val box = field("view") as ViewGroup
        fun buttons(view: View): List<Button> = if (view is Button) listOf(view) else if (view is ViewGroup)
            (0 until view.childCount).flatMap { buttons(view.getChildAt(it)) } else emptyList()
        val stop = buttons(box).first()
        overlay.setMode(true, task.copy(step = 2, label = "Next"), false)
        assertSame(stop, buttons(box).first())
        assertNotNull(stop.parent)
        stop.performClick()
        assertEquals(listOf("task_stop"), actions)
        assertTrue((field("params") as WindowManager.LayoutParams).flags and WindowManager.LayoutParams.FLAG_SECURE != 0)
        val description = (field("orb") as View).contentDescription.toString()
        assertTrue(description.contains("microphone active"))
        overlay.setMode(true, task.copy(status = "needs_user", label = ""), true)
        assertTrue((field("orb") as View).contentDescription.toString().contains("microphone muted"))
        assertTrue((field("orb") as View).contentDescription.toString().contains("Your help is needed"))
        overlay.hide()
    }
}
