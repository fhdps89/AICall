package com.onecall.aivoice.voice

import org.json.JSONArray
import org.json.JSONObject
import java.io.IOException
import java.net.HttpURLConnection
import java.net.ConnectException
import java.net.NoRouteToHostException
import java.net.SocketTimeoutException
import java.net.URL
import java.net.UnknownHostException

/** One turn of in-call conversation memory ("user" or "model"). */
data class ChatTurn(val role: String, val text: String) {
    companion object {
        const val ROLE_USER = "user"
        const val ROLE_MODEL = "model"
    }
}

sealed class GeminiResult {
    abstract val networkMs: Long

    /** [modelVersion] is the "modelVersion" reported by the API (null if absent). */
    data class Success(
        val text: String,
        override val networkMs: Long,
        val modelVersion: String? = null
    ) : GeminiResult()

    /** [reason] is a short Korean label for UI, e.g. "키 오류(API_KEY_INVALID)". Never contains the key. */
    data class Failure(val reason: String, override val networkMs: Long) : GeminiResult()
}

/**
 * Minimal Gemini API REST client (generateContent) using HttpURLConnection + org.json.
 * API key is passed in per request from on-device settings; never hard-coded or logged.
 *
 * Blocking: call [GeminiRequest.execute] off the main thread.
 */
class GeminiRequest(
    private val apiKey: String,
    private val systemInstruction: String,
    private val turns: List<ChatTurn>,
    private val timeoutMs: Int = GeminiClient.TIMEOUT_MS
) {
    @Volatile
    private var connection: HttpURLConnection? = null

    @Volatile
    private var cancelled = false

    fun cancel() {
        cancelled = true
        try {
            connection?.disconnect()
        } catch (_: Exception) {
        }
    }

    fun execute(): GeminiResult {
        val startedAt = System.nanoTime()
        fun elapsed() = (System.nanoTime() - startedAt) / 1_000_000L
        var conn: HttpURLConnection? = null
        return try {
            val body = GeminiClient.buildRequestJson(systemInstruction, turns).toString()
            conn = (URL(GeminiClient.ENDPOINT).openConnection() as HttpURLConnection).apply {
                requestMethod = "POST"
                connectTimeout = timeoutMs
                readTimeout = timeoutMs
                doOutput = true
                useCaches = false
                setRequestProperty("Content-Type", "application/json; charset=utf-8")
                setRequestProperty("x-goog-api-key", apiKey)
            }
            connection = conn
            if (cancelled) return GeminiResult.Failure(GeminiErrors.CANCELLED, elapsed())
            conn.outputStream.use { it.write(body.toByteArray(Charsets.UTF_8)) }
            val code = conn.responseCode
            val stream = if (code in 200..299) conn.inputStream else conn.errorStream
            val text = stream?.bufferedReader(Charsets.UTF_8)?.use { it.readText() }.orEmpty()
            if (code !in 200..299) {
                return GeminiResult.Failure(GeminiErrors.httpReason(code, text), elapsed())
            }
            val reply = GeminiClient.parseResponseText(text)?.let { GeminiClient.sanitizeForSpeech(it) }
            if (reply.isNullOrBlank()) {
                GeminiResult.Failure(GeminiErrors.emptyReason(text), elapsed())
            } else {
                GeminiResult.Success(reply, elapsed(), GeminiClient.parseModelVersion(text))
            }
        } catch (e: Exception) {
            GeminiResult.Failure(GeminiErrors.exceptionReason(e, cancelled), elapsed())
        } finally {
            try {
                conn?.disconnect()
            } catch (_: Exception) {
            }
            connection = null
        }
    }
}

object GeminiClient {
    /** https://ai.google.dev/gemini-api/docs/models (Gemini 3.5 Flash-Lite, Stable). */
    const val MODEL_ID = "gemini-3.5-flash-lite"
    const val ENDPOINT =
        "https://generativelanguage.googleapis.com/v1beta/models/$MODEL_ID:generateContent"
    const val TIMEOUT_MS = 8_000
    const val MAX_OUTPUT_TOKENS = 256

    /**
     * Builds the generateContent request body.
     * Consecutive turns with the same role are merged so roles always alternate,
     * and the conversation always starts with a user turn.
     */
    fun buildRequestJson(systemInstruction: String, turns: List<ChatTurn>): JSONObject {
        val merged = mutableListOf<ChatTurn>()
        for (turn in turns) {
            val text = turn.text.trim()
            if (text.isEmpty()) continue
            val last = merged.lastOrNull()
            if (last != null && last.role == turn.role) {
                merged[merged.size - 1] = last.copy(text = last.text + "\n" + text)
            } else {
                merged.add(ChatTurn(turn.role, text))
            }
        }
        if (merged.firstOrNull()?.role == ChatTurn.ROLE_MODEL) {
            merged.add(0, ChatTurn(ChatTurn.ROLE_USER, "(통화 연결됨)"))
        }

        val contents = JSONArray()
        merged.forEach { turn ->
            contents.put(
                JSONObject()
                    .put("role", turn.role)
                    .put("parts", JSONArray().put(JSONObject().put("text", turn.text)))
            )
        }
        return JSONObject()
            .put(
                "systemInstruction",
                JSONObject().put("parts", JSONArray().put(JSONObject().put("text", systemInstruction)))
            )
            .put("contents", contents)
            .put(
                "generationConfig",
                JSONObject()
                    .put("maxOutputTokens", MAX_OUTPUT_TOKENS)
                    .put("candidateCount", 1)
            )
    }

    /** Returns concatenated text of the first candidate (skipping thought parts), or null. */
    fun parseResponseText(body: String): String? {
        return try {
            val root = JSONObject(body)
            val candidates = root.optJSONArray("candidates") ?: return null
            if (candidates.length() == 0) return null
            val parts = candidates.getJSONObject(0)
                .optJSONObject("content")
                ?.optJSONArray("parts") ?: return null
            val sb = StringBuilder()
            for (i in 0 until parts.length()) {
                val part = parts.optJSONObject(i) ?: continue
                if (part.optBoolean("thought", false)) continue
                sb.append(part.optString("text", ""))
            }
            sb.toString().trim().ifEmpty { null }
        } catch (_: Exception) {
            null
        }
    }

    /** Label shown after a successful key test, e.g. "연결 성공 (gemini-3.5-flash-lite)". */
    fun keyTestSuccessLabel(modelVersion: String?): String =
        "연결 성공 (${modelVersion?.takeIf { it.isNotBlank() } ?: MODEL_ID})"

    /** Tiny blocking request to verify key + model (call off the main thread). */
    fun testKey(apiKey: String): GeminiResult = GeminiRequest(
        apiKey = apiKey,
        systemInstruction = "짧게 한 단어로만 답해.",
        turns = listOf(ChatTurn(ChatTurn.ROLE_USER, "연결 테스트야. 응 이라고만 답해."))
    ).execute()

    /** "modelVersion" field of a generateContent response, or null. */
    fun parseModelVersion(body: String): String? {
        return try {
            JSONObject(body).optString("modelVersion", "").trim().ifEmpty { null }
        } catch (_: Exception) {
            null
        }
    }

    /** Short error message from an API error body (never contains the key). */
    fun errorMessage(body: String): String {
        return try {
            JSONObject(body).optJSONObject("error")?.optString("status", "").orEmpty()
        } catch (_: Exception) {
            ""
        }
    }

    /** Strips emoji / markdown / list markers so TTS reads clean sentences. */
    fun sanitizeForSpeech(text: String): String {
        val sb = StringBuilder()
        var i = 0
        while (i < text.length) {
            val cp = text.codePointAt(i)
            i += Character.charCount(cp)
            val type = Character.getType(cp)
            val isEmoji = cp in 0x1F000..0x1FAFF ||
                cp in 0x2600..0x27BF ||
                cp == 0xFE0F || cp == 0x200D ||
                type == Character.OTHER_SYMBOL.toInt() ||
                type == Character.SURROGATE.toInt()
            if (isEmoji) continue
            sb.appendCodePoint(cp)
        }
        return sb.toString()
            .replace(Regex("(?m)^\\s*([-*•]|\\d+[.)])\\s+"), "")
            .replace(Regex("[*_#`>~|\\[\\]]"), "")
            .replace(Regex("\\s+"), " ")
            .trim()
    }
}

/**
 * Maps Gemini API failures to short Korean labels for the call screen / key test.
 * Pure Kotlin + org.json so it is unit-testable.
 */
object GeminiErrors {
    const val TIMEOUT = "시간 초과"
    const val NO_INTERNET = "인터넷 없음"
    const val EMPTY = "빈 응답"
    const val CANCELLED = "취소됨"

    /** Parsed Google error body: error.code / error.status / first ErrorInfo reason. */
    data class ApiError(val code: Int?, val status: String?, val reason: String?)

    fun parseApiError(body: String): ApiError {
        return try {
            val err = JSONObject(body).optJSONObject("error") ?: return ApiError(null, null, null)
            val code = if (err.has("code")) err.optInt("code") else null
            val status = err.optString("status", "").trim().ifEmpty { null }
            var reason: String? = null
            val details = err.optJSONArray("details")
            if (details != null) {
                for (i in 0 until details.length()) {
                    val d = details.optJSONObject(i) ?: continue
                    val r = d.optString("reason", "").trim()
                    if (r.isNotEmpty()) {
                        reason = r
                        break
                    }
                }
            }
            ApiError(code, status, reason)
        } catch (_: Exception) {
            ApiError(null, null, null)
        }
    }

    /** Label for a non-2xx HTTP response. */
    fun httpReason(httpCode: Int, body: String): String {
        val e = parseApiError(body)
        val status = e.status
        val reason = e.reason
        val keyProblem = reason != null && reason.startsWith("API_KEY")
        return when {
            keyProblem -> "키 오류($reason)"
            httpCode == 404 -> "모델 없음(404 ${status ?: "NOT_FOUND"})"
            httpCode == 429 -> "한도 초과(429)"
            httpCode == 401 || httpCode == 403 ->
                "권한 없음($httpCode ${reason ?: status ?: "PERMISSION_DENIED"})"
            httpCode == 400 && status == "FAILED_PRECONDITION" ->
                "사용 불가(400 FAILED_PRECONDITION)"
            httpCode == 400 -> "요청 오류(400 ${reason ?: status ?: "INVALID_ARGUMENT"})"
            httpCode == 408 || httpCode == 504 -> "$TIMEOUT($httpCode)"
            httpCode in 500..599 -> "서버 오류($httpCode${status?.let { " $it" }.orEmpty()})"
            else -> "HTTP 오류($httpCode${status?.let { " $it" }.orEmpty()})"
        }
    }

    /** Label for a 2xx response without usable text (safety block, token limit, ...). */
    fun emptyReason(body: String): String {
        val why = try {
            val root = JSONObject(body)
            val block = root.optJSONObject("promptFeedback")?.optString("blockReason", "").orEmpty()
            val finish = root.optJSONArray("candidates")?.optJSONObject(0)
                ?.optString("finishReason", "").orEmpty()
            when {
                block.isNotBlank() -> block
                finish.isNotBlank() && finish != "STOP" -> finish
                else -> ""
            }
        } catch (_: Exception) {
            ""
        }
        return if (why.isEmpty()) EMPTY else "$EMPTY($why)"
    }

    /** Label for an exception thrown while calling the API. */
    fun exceptionReason(e: Throwable, cancelled: Boolean = false): String = when {
        cancelled -> CANCELLED
        e is SocketTimeoutException -> TIMEOUT
        e is UnknownHostException || e is ConnectException || e is NoRouteToHostException -> NO_INTERNET
        e is IOException -> "네트워크 오류(${e.javaClass.simpleName})"
        else -> "오류(${e.javaClass.simpleName})"
    }
}
