package com.onecall.aivoice

import com.onecall.aivoice.data.UserPreferences
import com.onecall.aivoice.voice.ChatTurn
import com.onecall.aivoice.voice.GeminiClient
import com.onecall.aivoice.voice.PersonaPrompt
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class GeminiClientTest {

    @Test
    fun requestHasSystemInstructionAndAlternatingContents() {
        val json = GeminiClient.buildRequestJson(
            PersonaPrompt.systemInstruction("민수"),
            listOf(
                ChatTurn(ChatTurn.ROLE_MODEL, "민수야 안녕!"),
                ChatTurn(ChatTurn.ROLE_USER, "안녕"),
                ChatTurn(ChatTurn.ROLE_USER, "오늘 피곤해"),
                ChatTurn(ChatTurn.ROLE_MODEL, "많이 피곤했구나.")
            )
        )
        val sys = json.getJSONObject("systemInstruction").getJSONArray("parts")
            .getJSONObject(0).getString("text")
        assertTrue(sys.contains("민수"))
        assertTrue(sys.contains("반말"))

        val contents = json.getJSONArray("contents")
        // leading model turn gets a user placeholder; consecutive user turns are merged
        assertEquals(4, contents.length())
        assertEquals("user", contents.getJSONObject(0).getString("role"))
        assertEquals("model", contents.getJSONObject(1).getString("role"))
        assertEquals("user", contents.getJSONObject(2).getString("role"))
        assertEquals(
            "안녕\n오늘 피곤해",
            contents.getJSONObject(2).getJSONArray("parts").getJSONObject(0).getString("text")
        )
        assertEquals("model", contents.getJSONObject(3).getString("role"))
        assertTrue(json.getJSONObject("generationConfig").has("maxOutputTokens"))
    }

    @Test
    fun parsesTextAndSkipsThoughtParts() {
        val body = """
            {"candidates":[{"content":{"role":"model","parts":[
              {"text":"생각 중","thought":true},
              {"text":"민수야, 오늘 뭐 했어?"}
            ]},"finishReason":"STOP"}]}
        """.trimIndent()
        assertEquals("민수야, 오늘 뭐 했어?", GeminiClient.parseResponseText(body))
    }

    @Test
    fun emptyOrBrokenResponseIsNull() {
        assertNull(GeminiClient.parseResponseText("""{"candidates":[]}"""))
        assertNull(GeminiClient.parseResponseText("""{"promptFeedback":{"blockReason":"SAFETY"}}"""))
        assertNull(GeminiClient.parseResponseText("not json"))
    }

    @Test
    fun sanitizeRemovesEmojiAndMarkdown() {
        val out = GeminiClient.sanitizeForSpeech("**민수야** 안녕! 😊\n- 오늘 어땠어?")
        assertEquals("민수야 안녕! 오늘 어땠어?", out)
        assertFalse(out.contains("*"))
    }

    @Test
    fun fallbackPhraseAndMask() {
        assertEquals("잠깐 잘 안 들렸어, 다시 말해줄래?", PersonaPrompt.RETRY_FALLBACK)
        assertEquals("abcd••••••••1234", UserPreferences.maskKey("abcdTESTTEST1234"))
        assertEquals("", UserPreferences.maskKey(null))
    }
}
