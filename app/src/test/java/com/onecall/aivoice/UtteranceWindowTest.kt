package com.onecall.aivoice

import com.onecall.aivoice.voice.UtteranceWindow
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class UtteranceWindowTest {

    @Test
    fun singleFinalIsDueOnlyAfterWindow() {
        val w = UtteranceWindow(1500)
        w.onFinal("오늘 회사에서", 1_000)
        assertTrue(w.hasContent)
        assertFalse(w.isDue(1_000))
        assertFalse(w.isDue(2_499))
        assertTrue(w.isDue(2_500))
        assertEquals("오늘 회사에서", w.take())
        assertFalse(w.hasContent)
        assertNull(w.deadline)
    }

    @Test
    fun speechInsideWindowIsJoinedAndRestartsWindow() {
        val w = UtteranceWindow(1500)
        w.onFinal("오늘 회사에서", 0)
        w.onPartial("팀장님이", 1_200)          // user keeps talking before the window closes
        assertFalse(w.isDue(1_600))
        assertEquals("오늘 회사에서 팀장님이", w.displayText())
        w.onFinal("팀장님이 칭찬해 줬어", 2_000)
        assertFalse(w.isDue(3_499))
        assertTrue(w.isDue(3_500))
        assertEquals(2_000L, w.lastFinalAt)
        assertEquals("오늘 회사에서 팀장님이 칭찬해 줬어", w.take())
    }

    @Test
    fun activityExtendsButNeverShortensDeadline() {
        val w = UtteranceWindow(1500)
        w.onFinal("응", 0)
        w.onActivity(1_000)
        assertEquals(2_500L, w.deadline)
        w.onActivity(500) // older timestamp must not pull the deadline in
        assertEquals(2_500L, w.deadline)
        assertTrue(w.isDue(2_500))
    }

    @Test
    fun partialWithoutFinalIsNotLostWhenWindowCloses() {
        val w = UtteranceWindow(1500)
        w.onFinal("있잖아", 0)
        w.onPartial("나 내일", 1_000)
        assertTrue(w.isDue(2_500))
        assertEquals("있잖아 나 내일", w.take())
    }

    @Test
    fun blankFinalAndSilenceDoNotAddText() {
        val w = UtteranceWindow(1500)
        w.onFinal("   ", 0)
        assertFalse(w.hasContent)
        assertFalse(w.isDue(10_000))
        w.onPartial("음", 0)      // partial before any final: engine waits for the final
        w.onActivity(0)
        assertFalse(w.hasContent)
        assertNull(w.deadline)

        w.onFinal("밥 먹었어", 100)
        w.onFinal("", 900)        // empty final inside window = silence, window still restarts
        assertEquals("밥 먹었어", w.displayText())
        assertTrue(w.isDue(2_400))
    }

    @Test
    fun resetClearsEverything() {
        val w = UtteranceWindow()
        assertEquals(1_500L, w.windowMs)
        w.onFinal("안녕", 0)
        w.reset()
        assertFalse(w.hasContent)
        assertEquals("", w.displayText())
        assertFalse(w.isDue(99_999))
    }
}
