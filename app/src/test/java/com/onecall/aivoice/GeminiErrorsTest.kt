package com.onecall.aivoice

import com.onecall.aivoice.data.UserPreferences
import com.onecall.aivoice.voice.GeminiClient
import com.onecall.aivoice.voice.GeminiErrors
import com.onecall.aivoice.voice.ReplyOrigin
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test
import java.io.IOException
import java.net.ConnectException
import java.net.SocketTimeoutException
import java.net.UnknownHostException

class GeminiErrorsTest {

    // Real body returned by the API for an invalid key (captured 2026-09-25)
    private val invalidKeyBody = """
        {"error":{"code":400,"message":"API key not valid. Please pass a valid API key.",
         "status":"INVALID_ARGUMENT","details":[
          {"@type":"type.googleapis.com/google.rpc.ErrorInfo","reason":"API_KEY_INVALID",
           "domain":"googleapis.com","metadata":{"service":"generativelanguage.googleapis.com"}}]}}
    """.trimIndent()

    @Test
    fun httpStatusMapping() {
        assertEquals("키 오류(API_KEY_INVALID)", GeminiErrors.httpReason(400, invalidKeyBody))
        assertEquals(
            "모델 없음(404 NOT_FOUND)",
            GeminiErrors.httpReason(404, """{"error":{"code":404,"status":"NOT_FOUND"}}""")
        )
        assertEquals("모델 없음(404 NOT_FOUND)", GeminiErrors.httpReason(404, "not json"))
        assertEquals(
            "한도 초과(429)",
            GeminiErrors.httpReason(429, """{"error":{"code":429,"status":"RESOURCE_EXHAUSTED"}}""")
        )
        assertEquals(
            "권한 없음(403 PERMISSION_DENIED)",
            GeminiErrors.httpReason(403, """{"error":{"code":403,"status":"PERMISSION_DENIED"}}""")
        )
        assertEquals(
            "권한 없음(403 SERVICE_DISABLED)",
            GeminiErrors.httpReason(
                403,
                """{"error":{"code":403,"status":"PERMISSION_DENIED","details":[{"reason":"SERVICE_DISABLED"}]}}"""
            )
        )
        assertEquals(
            "사용 불가(400 FAILED_PRECONDITION)",
            GeminiErrors.httpReason(400, """{"error":{"code":400,"status":"FAILED_PRECONDITION"}}""")
        )
        assertEquals(
            "서버 오류(503 UNAVAILABLE)",
            GeminiErrors.httpReason(503, """{"error":{"code":503,"status":"UNAVAILABLE"}}""")
        )
        assertEquals("시간 초과(504)", GeminiErrors.httpReason(504, ""))
    }

    @Test
    fun parseApiErrorReadsReason() {
        val e = GeminiErrors.parseApiError(invalidKeyBody)
        assertEquals(400, e.code)
        assertEquals("INVALID_ARGUMENT", e.status)
        assertEquals("API_KEY_INVALID", e.reason)
    }

    @Test
    fun exceptionMapping() {
        assertEquals("시간 초과", GeminiErrors.exceptionReason(SocketTimeoutException()))
        assertEquals("인터넷 없음", GeminiErrors.exceptionReason(UnknownHostException("x")))
        assertEquals("인터넷 없음", GeminiErrors.exceptionReason(ConnectException()))
        assertEquals("네트워크 오류(IOException)", GeminiErrors.exceptionReason(IOException()))
        assertEquals("취소됨", GeminiErrors.exceptionReason(IOException(), cancelled = true))
        assertEquals("오류(IllegalStateException)", GeminiErrors.exceptionReason(IllegalStateException()))
    }

    @Test
    fun emptyResponseMapping() {
        assertEquals("빈 응답", GeminiErrors.emptyReason("""{"candidates":[]}"""))
        assertEquals(
            "빈 응답(SAFETY)",
            GeminiErrors.emptyReason("""{"promptFeedback":{"blockReason":"SAFETY"}}""")
        )
        assertEquals(
            "빈 응답(MAX_TOKENS)",
            GeminiErrors.emptyReason("""{"candidates":[{"content":{"parts":[]},"finishReason":"MAX_TOKENS"}]}""")
        )
        assertEquals("빈 응답", GeminiErrors.emptyReason("garbage"))
    }

    @Test
    fun keyTestLabelAndModelVersion() {
        assertEquals("gemini-3.5-flash-lite", GeminiClient.MODEL_ID)
        assertEquals(
            "연결 성공 (gemini-3.5-flash-lite)",
            GeminiClient.keyTestSuccessLabel(
                GeminiClient.parseModelVersion("""{"candidates":[],"modelVersion":"gemini-3.5-flash-lite"}""")
            )
        )
        assertNull(GeminiClient.parseModelVersion("""{"candidates":[]}"""))
        assertEquals("연결 성공 (gemini-3.5-flash-lite)", GeminiClient.keyTestSuccessLabel(null))
    }

    @Test
    fun replyOriginLabels() {
        assertEquals("AI 대답", ReplyOrigin.Ai.label)
        assertEquals("기본 대답(키 없음)", ReplyOrigin.LocalNoKey.label)
        assertEquals("AI 실패: 키 오류(API_KEY_INVALID)", ReplyOrigin.AiFailed("키 오류(API_KEY_INVALID)").label)
    }

    @Test
    fun pastedKeyIsCleaned() {
        assertEquals("AIzaTEST_key-123", UserPreferences.cleanApiKey("  AIzaTEST_key-123\n"))
        assertEquals("AIzaTEST", UserPreferences.cleanApiKey("\"AIza\u200BTEST\"\r\n"))
        assertEquals("AIzaTEST", UserPreferences.cleanApiKey("\uFEFF“AIza TEST”\t"))
        assertEquals("", UserPreferences.cleanApiKey(" \n "))
        assertEquals("", UserPreferences.cleanApiKey(null))
    }
}
