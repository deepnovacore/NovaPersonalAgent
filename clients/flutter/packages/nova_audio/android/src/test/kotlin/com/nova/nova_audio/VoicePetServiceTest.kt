package com.nova.nova_audio

import android.content.Intent
import org.junit.After
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [28])
class VoicePetServiceTest {
    @After fun release() {
        VoicePetService.onReady = null
        VoicePetService.current?.finish()
        VoicePetService.ownership.release("test")
        VoicePetHost.taskAction = null
        VoicePetHost.taskGone = null
        VoicePetHost.state.task = null
    }

    @Test fun cancelledStartPromotesBeforeStopping() {
        val controller = Robolectric.buildService(VoicePetService::class.java).create()
        val service = controller.get()
        service.onStartCommand(Intent().putExtra("owner", "cancelled"), 0, 1)
        val shadow = shadowOf(service)
        assertEquals(19745, shadow.lastForegroundNotificationId)
        assertTrue(shadow.isStoppedBySelf)
        assertNull(VoicePetService.current)
        controller.destroy()
    }

    @Test fun ownedStartPromotesBeforeReadyAndRepeatedIntentPromotesAgain() {
        VoicePetService.ownership.claim("test")
        val controller = Robolectric.buildService(VoicePetService::class.java).create()
        val service = controller.get()
        var ready = 0
        VoicePetService.onReady = { success ->
            assertTrue(success)
            assertNotNull(shadowOf(service).lastForegroundNotification)
            ready++
        }
        val intent = Intent().putExtra("owner", "test")
        service.onStartCommand(intent, 0, 1)
        assertEquals(1, ready)
        assertSame(service, VoicePetService.current)
        VoicePetService.onReady = null
        service.onStartCommand(intent, 0, 2)
        assertFalse(shadowOf(service).isStoppedBySelf)
        service.finish()
        controller.destroy()
    }

    @Test fun notificationStopIsScopedAndEmitsTaskStopBeforeDisappearance() {
        VoicePetService.ownership.claim("test")
        VoicePetService.onReady = {}
        val controller = Robolectric.buildService(VoicePetService::class.java).create()
        val service = controller.get()
        service.onStartCommand(Intent().putExtra("owner", "test"), 0, 1)
        VoicePetHost.state.task = VoicePetTask("two", "running", "", null)
        val events = mutableListOf<String>()
        VoicePetHost.taskAction = { events.add(it) }
        VoicePetHost.taskGone = { id, reason -> events.add("$id:$reason") }
        service.onStartCommand(Intent().setAction(VoicePetService.STOP).putExtra("owner", "test").putExtra("taskId", "one"), 0, 2)
        assertTrue(events.isEmpty())
        service.onStartCommand(Intent().setAction(VoicePetService.STOP).putExtra("owner", "test").putExtra("taskId", "two"), 0, 3)
        assertEquals(listOf("task_stop", "two:notification_stop"), events)
        assertTrue(shadowOf(service).isStoppedBySelf)
        controller.destroy()
    }
}
