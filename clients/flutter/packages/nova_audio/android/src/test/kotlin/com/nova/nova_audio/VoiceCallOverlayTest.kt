package com.nova.nova_audio

import android.os.Looper
import android.view.Gravity
import android.view.MotionEvent
import android.view.View
import android.view.ViewGroup
import android.view.WindowManager
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.TextView
import org.junit.After
import org.junit.Assert.*
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import org.robolectric.shadows.ShadowSettings
import kotlin.math.roundToInt

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [28])
class VoiceCallOverlayTest {
    private val actions = mutableListOf<String>()
    private lateinit var overlay: VoiceCallOverlay
    private val task = VoicePetTask("one", "running", "First", 1)
    private val density get() = RuntimeEnvironment.getApplication().resources.displayMetrics.density
    private fun dp(n: Int) = (n * density).toInt()

    @Before fun setUp() {
        ShadowSettings.setCanDrawOverlays(true)
        overlay = VoiceCallOverlay(RuntimeEnvironment.getApplication(), { actions.add(it) }, { actions.add("open") }, {}, {})
    }
    @After fun tearDown() { overlay.hide() }

    private fun field(name: String) = VoiceCallOverlay::class.java.getDeclaredField(name).apply { isAccessible = true }.get(overlay)
    private fun setField(name: String, value: Any) = VoiceCallOverlay::class.java.getDeclaredField(name).apply { isAccessible = true }.set(overlay, value)
    private fun aspect(value: Float) = VoiceCallOverlay::class.java.getDeclaredMethod("applyAspect", Float::class.java)
        .apply { isAccessible = true }.invoke(overlay, value)
    private val box get() = field("view") as ViewGroup
    private val orb get() = field("orb") as View
    private val params get() = field("params") as WindowManager.LayoutParams
    private fun all(view: View): List<View> = listOf(view) + if (view is ViewGroup) (0 until view.childCount).flatMap { all(view.getChildAt(it)) } else emptyList()
    private fun labelled(label: String) = all(box).singleOrNull { it !== orb && it.contentDescription?.toString() == label }
    private fun control(label: String) = requireNotNull(labelled(label)) { "missing $label" }
    private fun preview() = control("Virtual screen preview") as ImageView
    private fun idle() = shadowOf(Looper.getMainLooper()).idle()

    @Test fun stepUpdateKeepsButtonsAndTheirClickListenersAttached() {
        overlay.setMode(true, task, false)
        assertTrue(overlay.show())
        orb.performClick()
        val stop = control("Stop")
        overlay.setMode(true, task.copy(step = 2, label = "Next"), false)
        assertSame(stop, control("Stop"))
        assertNotNull(stop.parent)
        stop.performClick()
        assertEquals(listOf("task_stop"), actions)
        assertEquals(0, params.flags and WindowManager.LayoutParams.FLAG_SECURE)
        val description = orb.contentDescription.toString()
        assertTrue(description.contains("microphone active"))
        assertTrue(description.contains("Step 2") && description.contains("Next"))
        overlay.setMode(true, task.copy(status = "needs_user", label = ""), true)
        assertTrue(orb.contentDescription.toString().contains("microphone muted"))
        assertTrue(orb.contentDescription.toString().contains("Your help is needed"))
        assertNull(labelled("Take over"))
    }

    @Test fun stepIsAnnouncedByTheOrbWithoutVisibleText() {
        overlay.setMode(false, task.copy(step = 3, label = "Search"), false)
        assertTrue(overlay.show()); orb.performClick()
        assertTrue(all(box).none { it is TextView && it.visibility == View.VISIBLE })
        assertEquals(View.ACCESSIBILITY_LIVE_REGION_POLITE, orb.accessibilityLiveRegion)
        assertTrue(orb.contentDescription.toString().contains("Step 3"))
        assertTrue(orb.contentDescription.toString().contains("Search"))
        assertTrue(all(box).none { it.contentDescription?.toString()?.contains("Take over") == true })
    }

    @Test fun expandFirstThenTaskArrivesShowsPreviewAndRow() {
        overlay.setMode(false, null, false)
        assertTrue(overlay.show()); orb.performClick()
        assertNotNull(labelled("Return to Nova"))
        assertNull(labelled("Stop"))
        overlay.setMode(false, task, false)
        assertNotNull(labelled("Virtual screen preview"))
        control("Open Nova").performClick()
        assertEquals(listOf("open"), actions)
        assertNull(labelled("Return to Nova"))
    }

    @Test fun taskFirstThenExpandShowsPreviewAndRow() {
        overlay.setMode(false, task, false)
        assertTrue(overlay.show())
        assertNull(labelled("Stop"))
        orb.performClick()
        assertNotNull(labelled("Stop")); assertNotNull(labelled("Open Nova"))
        idle()
        assertEquals(preview().layoutParams.width + dp(8), params.width)
    }

    @Test fun rowHoldsTwoTaskControlsOrFourWithACall() {
        overlay.setMode(false, task, false)
        assertTrue(overlay.show()); orb.performClick()
        val row = control("Stop").parent as LinearLayout
        assertEquals(LinearLayout.HORIZONTAL, row.orientation)
        assertEquals(listOf("Stop", "Open Nova"), (0 until row.childCount).map { row.getChildAt(it).contentDescription.toString() })
        overlay.setMode(true, task, false)
        val callRow = control("Stop").parent as LinearLayout
        assertEquals(listOf("Stop", "Open Nova", "Mute", "End call"), (0 until callRow.childCount).map { callRow.getChildAt(it).contentDescription.toString() })
        (0 until callRow.childCount).forEach { assertTrue(callRow.getChildAt(it).layoutParams.height >= dp(44)) }
        overlay.setMode(true, task, true)
        assertSame(callRow, control("Unmute").parent)
        control("Unmute").performClick(); control("End call").performClick()
        assertEquals(listOf("mute", "end"), actions)
    }

    @Test fun frameAspectResizesPreviewAndWindowTogetherWithHysteresis() {
        overlay.setMode(false, task, false)
        assertTrue(overlay.show()); orb.performClick(); idle()
        val scroll = box.getChildAt(1)
        assertEquals((dp(288) * 1200f / 2670f).roundToInt(), preview().layoutParams.width)
        assertEquals(dp(288), preview().layoutParams.height)
        aspect(9f / 16f)
        val width = (dp(288) * 9f / 16f).roundToInt()
        assertEquals(width, preview().layoutParams.width)
        assertEquals(width + dp(8), params.width)
        aspect(9.01f / 16f)
        assertEquals(9f / 16f, field("frameAspect") as Float, 0f)
        assertEquals(width, preview().layoutParams.width)
        aspect(16f / 9f)
        assertEquals(dp(240), preview().layoutParams.width)
        assertEquals((dp(240) * 9f / 16f).roundToInt(), preview().layoutParams.height)
        idle()
        assertEquals(dp(240) + dp(8), params.width)
        assertSame(scroll, box.getChildAt(1))
    }

    @Test fun dockedRightKeepsCardAndOrbOnTheRightEdge() {
        overlay.setMode(true, task, false)
        assertTrue(overlay.show())
        setField("dockedRight", true)
        orb.performClick(); idle()
        val screen = RuntimeEnvironment.getApplication().resources.displayMetrics.widthPixels
        assertEquals(screen - params.width, params.x)
        assertEquals(Gravity.END, (orb.layoutParams as LinearLayout.LayoutParams).gravity)
        aspect(9f / 16f); idle()
        assertEquals(screen - params.width, params.x)
        orb.performClick(); idle()
        assertEquals(screen - params.width, params.x)
    }

    private fun touch(action: Int, x: Float) {
        val event = MotionEvent.obtain(0, 0, action, x, 100f, 0)
        orb.dispatchTouchEvent(event); event.recycle()
    }

    @Test fun aspectChangeMidDragDoesNotSnapAndReleaseDocksWithNewWidth() {
        overlay.setMode(false, task, false)
        assertTrue(overlay.show()); orb.performClick(); idle()
        val screen = RuntimeEnvironment.getApplication().resources.displayMetrics.widthPixels
        assertEquals(0, params.x)
        touch(MotionEvent.ACTION_DOWN, 10f); touch(MotionEvent.ACTION_MOVE, 10f + dp(140))
        val dragged = params.x
        assertEquals(dp(140), dragged)
        aspect(9f / 16f); idle()
        val width = (dp(288) * 9f / 16f).roundToInt() + dp(8)
        assertEquals(width, params.width)
        assertEquals(dragged, params.x)
        touch(MotionEvent.ACTION_MOVE, 10f + dp(141))
        assertEquals(dragged + dp(1), params.x)
        touch(MotionEvent.ACTION_UP, 10f + dp(141)); idle()
        assertEquals(screen - width, params.x)
        assertEquals(Gravity.END, (orb.layoutParams as LinearLayout.LayoutParams).gravity)
    }

    @Test fun rightDockedGrowthMidDragKeepsTheOrbUnderTheFinger() {
        overlay.setMode(false, task, false)
        assertTrue(overlay.show())
        setField("dockedRight", true)
        orb.performClick(); idle()
        val screen = RuntimeEnvironment.getApplication().resources.displayMetrics.widthPixels
        touch(MotionEvent.ACTION_DOWN, 200f); touch(MotionEvent.ACTION_MOVE, 200f - dp(20))
        val orbRight = params.x + params.width
        aspect(9f / 16f); idle()
        assertEquals(orbRight, params.x + params.width)
        touch(MotionEvent.ACTION_MOVE, 200f - dp(21))
        assertEquals(orbRight - dp(1), params.x + params.width)
        touch(MotionEvent.ACTION_UP, 200f - dp(21)); idle()
        assertEquals(screen - params.width, params.x)
    }

    @Test fun terminalStateDisablesStop() {
        overlay.setMode(false, task, false)
        assertTrue(overlay.show()); orb.performClick()
        assertTrue(control("Stop").isEnabled)
        overlay.setMode(false, task.copy(status = "done"), false)
        val stop = control("Stop")
        assertFalse(stop.isEnabled)
        assertTrue(stop.alpha < 1f)
        assertTrue(control("Open Nova").isEnabled)
    }
    @Test fun callAndTaskWindowsAllowUserScreenshotsAcrossModeChanges() {
        ShadowSettings.setCanDrawOverlays(true)
        val overlay = VoiceCallOverlay(RuntimeEnvironment.getApplication(), {}, {}, {}, {})
        fun flags() = (VoiceCallOverlay::class.java.getDeclaredField("params").apply { isAccessible = true }.get(overlay) as WindowManager.LayoutParams).flags
        fun orb() = VoiceCallOverlay::class.java.getDeclaredField("orb").apply { isAccessible = true }.get(overlay) as View
        val task = VoicePetTask("one", "running", "First", 1)
        try {
            overlay.setMode(true, null, false)
            assertTrue(overlay.show())
            for (value in listOf(null, task, task.copy(status = "needs_user"), task.copy(status = "done"), null)) {
                overlay.setMode(true, value, false)
                assertEquals(0, flags() and WindowManager.LayoutParams.FLAG_SECURE)
                orb().performClick()
                assertEquals(0, flags() and WindowManager.LayoutParams.FLAG_SECURE)
            }
            overlay.setMode(false, task, false)
            assertEquals(0, flags() and WindowManager.LayoutParams.FLAG_SECURE)
        } finally { overlay.hide() }
    }
}
