package com.onecall.aivoice

import com.onecall.aivoice.data.UserPreferences
import com.onecall.aivoice.voice.ChatResult
import com.onecall.aivoice.voice.ChatTurn
import com.onecall.aivoice.voice.OpenRouterClient
import com.onecall.aivoice.voice.OpenRouterClient.SseEvent
import com.onecall.aivoice.voice.OpenRouterErrors
import com.onecall.aivoice.voice.PcmAligner
import com.onecall.aivoice.voice.TtsTestResult
import com.onecall.aivoice.voice.TtsVoice
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class OpenRouterClientTest {

    @Test
    fun ttsBodyKeepsInputCleanAndPutsStyleInProviderOptions() {
        val json = OpenRouterClient.buildTtsJson(TtsVoice.GEMINI_LITE_PUCK, "안녕, 찬식아!")
        assertEquals("google/gemini-3.8-flash-lite-tts", json.getString("model"))
        assertEquals("Puck", json.getString("voice"))
        assertEquals("안녕, 찬식아!", json.getString("input")) // no instructions in the spoken text
        assertEquals("pcm", json.getString("response_format"))
        val style = json.getJSONObject("provider").getJSONObject("options")
            .getJSONObject("google-ai-studio").getJSONObject("speech_metadata").getString("style")
        assertEquals(OpenRouterClient.GEMINI_TTS_STYLE, style)

        val leda = OpenRouterClient.buildTtsJson(TtsVoice.GEMINI_FLASH_LEDA, "응")
        assertEquals("google/gemini-3.8-flash-tts", leda.getString("model"))
        assertEquals("Leda", leda.getString("voice"))
        assertTrue(leda.has("provider"))

        val qwen = OpenRouterClient.buildTtsJson(TtsVoice.QWEN_LONGANHUAN, "응")
        assertEquals("qwen/qwen-audio-3.0-tts-flash", qwen.getString("model"))
        assertEquals("longanhuan_v3.6", qwen.getString("voice"))
        assertFalse(qwen.has("provider"))
    }

    @Test
    fun voiceOptionsAndDefault() {
        assertEquals(TtsVoice.GEMINI_LITE_PUCK, TtsVoice.DEFAULT)
        assertEquals(TtsVoice.GEMINI_FLASH_LEDA, TtsVoice.fromOption("1"))
        assertEquals(TtsVoice.QWEN_LONGANHUAN, TtsVoice.fromOption("7"))
        assertEquals(TtsVoice.DEFAULT, TtsVoice.fromOption(null))
        assertEquals(TtsVoice.DEFAULT, TtsVoice.fromOption("9"))
        assertEquals("2번 Puck", TtsVoice.GEMINI_LITE_PUCK.shortLabel)
    }

    @Test
    fun pcmFormatFromContentType() {
        assertEquals(24000 to 1, OpenRouterClient.parsePcmFormat("audio/pcm;rate=24000;channels=1"))
        assertEquals(16000 to 2, OpenRouterClient.parsePcmFormat("audio/pcm; rate=16000; channels=2"))
        assertEquals(24000 to 1, OpenRouterClient.parsePcmFormat("audio/pcm"))
        assertEquals(24000 to 1, OpenRouterClient.parsePcmFormat(null))
        assertNull(OpenRouterClient.parsePcmFormat("audio/mpeg"))
    }

    @Test
    fun chatBodyUsesOpenRouterModelRolesAndStreaming() {
        val json = OpenRouterClient.buildChatJson(
            "시스템",
            listOf(
                ChatTurn(ChatTurn.ROLE_MODEL, "안녕!"),
                ChatTurn(ChatTurn.ROLE_USER, "응"),
                ChatTurn(ChatTurn.ROLE_USER, "뭐해"),
                ChatTurn(ChatTurn.ROLE_MODEL, "그냥 있어")
            )
        )
        assertEquals("google/gemini-3.5-flash-lite", json.getString("model"))
        assertTrue(json.getBoolean("stream"))
        val m = json.getJSONArray("messages")
        assertEquals("system", m.getJSONObject(0).getString("role"))
        assertEquals("user", m.getJSONObject(1).getString("role")) // conversation starts with user
        assertEquals("assistant", m.getJSONObject(2).getString("role"))
        assertEquals("user", m.getJSONObject(3).getString("role"))
        assertEquals("응\n뭐해", m.getJSONObject(3).getString("content"))
        assertEquals("assistant", m.getJSONObject(4).getString("role"))
        assertEquals(5, m.length())
    }

    @Test
    fun parsesSseLines() {
        val d = OpenRouterClient.parseSseLine(
            """data: {"id":"x","model":"google/gemini-3.5-flash-lite","choices":[{"index":0,"delta":{"role":"assistant","content":"아이고 "}}]}"""
        )
        assertEquals(SseEvent.Delta("아이고 ", "google/gemini-3.5-flash-lite"), d)
        assertEquals(SseEvent.Done, OpenRouterClient.parseSseLine("data: [DONE]"))
        assertEquals(SseEvent.Ignore, OpenRouterClient.parseSseLine(": OPENROUTER PROCESSING"))
        assertEquals(SseEvent.Ignore, OpenRouterClient.parseSseLine(""))
        assertEquals(
            SseEvent.Ignore,
            OpenRouterClient.parseSseLine("""data: {"choices":[{"delta":{"content":""},"finish_reason":"stop"}],"usage":{"cost":0.0001}}""")
        )
        assertEquals(
            SseEvent.Error("크레딧 부족(402)"),
            OpenRouterClient.parseSseLine("""data: {"error":{"code":402,"message":"Insufficient credits"}}""")
        )
    }

    @Test
    fun mapsOpenRouterErrors() {
        assertEquals("키 오류(401)", OpenRouterErrors.httpReason(401, """{"error":{"message":"No auth credentials found","code":401}}"""))
        assertEquals("크레딧 부족(402)", OpenRouterErrors.httpReason(402, ""))
        assertEquals("한도 초과(429)", OpenRouterErrors.httpReason(429, "not json"))
        assertEquals(
            "요청 오류(400 Gemini TTS only supports response_format=\"pcm\". Got \"mp3\".)",
            OpenRouterErrors.httpReason(400, """{"error":{"message":"Gemini TTS only supports response_format=\"pcm\". Got \"mp3\".","code":400}}""")
        )
        assertEquals("서버 오류(502)", OpenRouterErrors.httpReason(502, ""))
        assertEquals("시간 초과(408)", OpenRouterErrors.httpReason(408, ""))
    }

    @Test
    fun pcmAlignerKeepsSamplesWhole() {
        val a = PcmAligner(2)
        assertArrayEquals(byteArrayOf(1, 2), a.push(byteArrayOf(1, 2, 3), 3))
        assertNull(a.push(byteArrayOf(), 0))
        assertArrayEquals(byteArrayOf(3, 4), a.push(byteArrayOf(4, 9), 1))
        assertNull(a.push(byteArrayOf(5), 1))
        assertArrayEquals(byteArrayOf(5, 6, 7, 8), a.push(byteArrayOf(6, 7, 8), 3))
    }

    @Test
    fun keyTestLabelReportsChatAndVoiceSeparately() {
        val ok = OpenRouterClient.keyTestLabel(
            ChatResult.Success("응", 500, 400, "google/gemini-3.5-flash-lite"),
            TtsTestResult(true, null, 2100, 48000),
            TtsVoice.GEMINI_LITE_PUCK
        )
        assertEquals("대화 성공 (google/gemini-3.5-flash-lite)\n음성 성공 (2번 Puck, 첫 소리 2.1초)", ok.first)
        assertTrue(ok.second)
        val bad = OpenRouterClient.keyTestLabel(
            ChatResult.Failure("키 오류(401)", 100),
            TtsTestResult(false, "키 오류(401)", null, 0),
            TtsVoice.QWEN_LONGANHUAN
        )
        assertEquals("대화 실패: 키 오류(401)\n음성 실패: 키 오류(401)", bad.first)
        assertFalse(bad.second)
        val half = OpenRouterClient.keyTestLabel(
            ChatResult.Success("응", 500, 400, null),
            TtsTestResult(false, "시간 초과", null, 0),
            TtsVoice.GEMINI_FLASH_LEDA
        )
        assertFalse(half.second)
    }

    @Test
    fun openRouterKeySanitizing() {
        // Fake placeholder values only (never a real key)
        assertEquals("sk-or-v1-TESTabc123", UserPreferences.cleanApiKey("  sk-or-v1-TESTabc123\n"))
        assertEquals("sk-or-v1-TESTabc123", UserPreferences.cleanApiKey("\"sk-or-v1-\u200BTESTabc123\"\r\n"))
        assertEquals("sk-or-v1-TESTabc123", UserPreferences.cleanApiKey("\uFEFF“sk-or-v1- TESTabc123”\t"))
        assertEquals("sk-or-v1-TESTabc123", UserPreferences.cleanApiKey("'sk-or-v1-TEST\u2060abc123'"))
        assertEquals("", UserPreferences.cleanApiKey("\u200B \n"))
        assertEquals("sk-o••••••••c123", UserPreferences.maskKey("sk-or-v1-TESTabc123"))
    }
}
