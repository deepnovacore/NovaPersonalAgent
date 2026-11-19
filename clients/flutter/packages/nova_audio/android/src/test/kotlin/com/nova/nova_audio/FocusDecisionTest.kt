package com.nova.nova_audio
import android.media.AudioManager
import org.junit.Assert.*
import org.junit.Test
class FocusDecisionTest {
 @Test fun transientLossFromAnotherAppHoldsTheCall() {
  assertEquals(FocusDecision.HOLD,focusDecision(AudioManager.AUDIOFOCUS_LOSS_TRANSIENT,AudioManager.MODE_IN_COMMUNICATION))
  assertEquals(FocusDecision.HOLD,focusDecision(AudioManager.AUDIOFOCUS_LOSS_TRANSIENT_CAN_DUCK,AudioManager.MODE_NORMAL))
 }
 @Test fun phoneCallOrPermanentLossEndsTheCall() {
  assertEquals(FocusDecision.END,focusDecision(AudioManager.AUDIOFOCUS_LOSS_TRANSIENT,AudioManager.MODE_RINGTONE))
  assertEquals(FocusDecision.END,focusDecision(AudioManager.AUDIOFOCUS_LOSS_TRANSIENT,AudioManager.MODE_IN_CALL))
  assertEquals(FocusDecision.END,focusDecision(AudioManager.AUDIOFOCUS_LOSS_TRANSIENT_CAN_DUCK,AudioManager.MODE_CALL_SCREENING))
  assertEquals(FocusDecision.END,focusDecision(AudioManager.AUDIOFOCUS_LOSS,AudioManager.MODE_IN_COMMUNICATION))
 }
 @Test fun regainResumes() {
  assertEquals(FocusDecision.RESUME,focusDecision(AudioManager.AUDIOFOCUS_GAIN,AudioManager.MODE_IN_COMMUNICATION))
  assertTrue(callMode(AudioManager.MODE_IN_CALL))
  assertFalse(callMode(AudioManager.MODE_IN_COMMUNICATION))
 }
}
