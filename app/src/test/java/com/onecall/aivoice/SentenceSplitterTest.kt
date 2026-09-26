package com.onecall.aivoice

import com.onecall.aivoice.voice.SentenceSplitter
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class SentenceSplitterTest {

    @Test
    fun splitsCompleteTextIntoSentences() {
        assertEquals(
            listOf("아이고 찬식아, 발표 망해서 속상하겠다.", "어쩌다가 그렇게 됐어?"),
            SentenceSplitter.splitAll("아이고 찬식아, 발표 망해서 속상하겠다. 어쩌다가 그렇게 됐어?")
        )
    }

    @Test
    fun handlesExclamationEllipsisTildeAndNewlines() {
        assertEquals(
            listOf("헐 진짜?!", "대박이다…", "나도 가고 싶다~", "다음엔 같이 가자"),
            SentenceSplitter.splitAll("헐 진짜?! 대박이다… 나도 가고 싶다~ \n다음엔 같이 가자")
        )
    }

    @Test
    fun doesNotSplitDecimalsOrMidWordDots() {
        assertEquals(
            listOf("나 오늘 3.5킬로 뛰었어.", "대단하지?"),
            SentenceSplitter.splitAll("나 오늘 3.5킬로 뛰었어. 대단하지?")
        )
    }

    @Test
    fun streamingEmitsFirstSentenceBeforeTheRestArrives() {
        val sp = SentenceSplitter()
        assertTrue(sp.push("아이고 찬식").isEmpty())
        assertTrue(sp.push("아, 속상하겠다.").isEmpty()) // terminator at end: not certain yet
        assertEquals(listOf("아이고 찬식아, 속상하겠다."), sp.push(" 어쩌다"))
        assertTrue(sp.push("가 그렇게 됐어?").isEmpty())
        assertEquals(listOf("어쩌다가 그렇게 됐어?"), sp.flush())
        assertTrue(sp.flush().isEmpty())
    }

    @Test
    fun streamingSplitsAcrossArbitraryChunkBoundaries() {
        val text = "응 알겠어. 근데 너 밥은 먹었어? 나는 방금 라면 먹었지~ 맛있더라."
        val expected = SentenceSplitter.splitAll(text)
        for (size in 1..7) {
            val sp = SentenceSplitter()
            val out = mutableListOf<String>()
            text.chunked(size).forEach { out += sp.push(it) }
            out += sp.flush()
            assertEquals("chunk size $size", expected, out)
        }
        assertEquals(4, expected.size)
    }

    @Test
    fun veryShortFragmentIsMergedIntoNextSentence() {
        assertEquals(
            listOf("응. 그래서 어떻게 됐어?"),
            SentenceSplitter.splitAll("응. 그래서 어떻게 됐어?")
        )
        assertEquals(listOf("헐."), SentenceSplitter.splitAll("헐."))
    }

    @Test
    fun emptyAndWhitespaceProduceNothing() {
        assertTrue(SentenceSplitter.splitAll("").isEmpty())
        assertTrue(SentenceSplitter.splitAll("  \n ").isEmpty())
    }
}
