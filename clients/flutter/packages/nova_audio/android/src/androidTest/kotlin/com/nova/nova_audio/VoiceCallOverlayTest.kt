package com.nova.nova_audio

import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.drawable.BitmapDrawable
import android.widget.ImageView
import android.graphics.Canvas
import android.graphics.Color
import android.view.View
import android.widget.FrameLayout
import android.widget.ImageButton
import android.widget.LinearLayout
import androidx.test.platform.app.InstrumentationRegistry
import org.junit.Assert.*
import org.junit.Test
import java.io.File
import kotlin.math.abs

class VoiceCallOverlayTest {
    @Test fun orbUsesBundledPetPortrait() {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        instrumentation.runOnMainSync {
            val context = instrumentation.targetContext
            val overlay = VoiceCallOverlay(context, {}, {})
            val avatar = VoiceCallOverlay::class.java.getDeclaredMethod("avatarView").apply { isAccessible = true }.invoke(overlay) as ImageView
            val expected = BitmapFactory.decodeResource(context.resources, R.drawable.nova_orb_avatar)
            assertTrue((avatar.drawable as BitmapDrawable).bitmap.sameAs(expected))
            assertEquals(ImageView.ScaleType.CENTER_CROP, avatar.scaleType)
            assertTrue(avatar.clipToOutline)
        }
    }

    @Test fun expandedControlsKeepHangupVisibleAndDispatchActions() {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        instrumentation.runOnMainSync {
            val context = instrumentation.targetContext
            val actions = mutableListOf<String>()
            var opened = false
            val overlay = VoiceCallOverlay(context, { actions.add(it) }, { opened = true })
            val box = LinearLayout(context).apply {
                orientation = LinearLayout.VERTICAL
                addView(FrameLayout(context))
            }
            VoiceCallOverlay::class.java.getDeclaredField("view").apply { isAccessible = true }.set(overlay, box)
            VoiceCallOverlay::class.java.getDeclaredField("expanded").apply { isAccessible = true }.setBoolean(overlay, true)
            VoiceCallOverlay::class.java.getDeclaredMethod("rebuildControls").apply { isAccessible = true }.invoke(overlay)
            assertEquals(4, box.childCount)
            val back = box.getChildAt(1) as ImageButton
            val mute = box.getChildAt(2) as ImageButton
            val end = box.getChildAt(3) as ImageButton
            val size = end.layoutParams.width
            end.measure(View.MeasureSpec.makeMeasureSpec(size, View.MeasureSpec.EXACTLY), View.MeasureSpec.makeMeasureSpec(size, View.MeasureSpec.EXACTLY))
            end.layout(0, 0, size, size)
            val bitmap = Bitmap.createBitmap(size, size, Bitmap.Config.ARGB_8888)
            val canvas = Canvas(bitmap)
            canvas.drawColor(Color.WHITE)
            end.draw(canvas)
            File(context.cacheDir, "hangup-control.png").outputStream().use { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }
            var redPixels = 0
            for (x in 0 until size) for (y in 0 until size) {
                val color = bitmap.getPixel(x, y)
                if (Color.red(color) > 180 && Color.green(color) < 140 && Color.blue(color) < 140) redPixels++
            }
            assertTrue("End-call control must have a visible red background at rest; found $redPixels red pixels", redPixels > size * size / 3)
            var glyphLeft = size
            var glyphRight = 0
            var glyphTop = size
            var glyphBottom = 0
            for (x in size / 4 until size * 3 / 4) for (y in size / 4 until size * 3 / 4) {
                val color = bitmap.getPixel(x, y)
                if (Color.red(color) > 240 && Color.green(color) > 240 && Color.blue(color) > 240) {
                    glyphLeft = minOf(glyphLeft, x)
                    glyphRight = maxOf(glyphRight, x)
                    glyphTop = minOf(glyphTop, y)
                    glyphBottom = maxOf(glyphBottom, y)
                }
            }
            assertTrue("Handset must remain recognizable at the real control size", glyphRight - glyphLeft >= size / 4)
            assertTrue("Handset must sit on the vertical centre of the button, was ${(glyphTop + glyphBottom) / 2} of $size", abs((glyphTop + glyphBottom) / 2 - size / 2) <= size / 10)
            back.performClick(); assertTrue(opened)
            mute.performClick(); end.performClick()
            assertEquals(listOf("mute", "end"), actions)
            overlay.update(true)
            assertTrue(mute.contentDescription.toString().isNotBlank())
        }
    }
}
