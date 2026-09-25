package com.onecall.aivoice.voice

import org.json.JSONArray
import org.json.JSONObject
import java.io.IOException
import java.net.HttpURLConnection
import java.net.SocketTimeoutException
import java.net.URL

/** One turn of in-call conversation memory ("user" or "model"). */
data class ChatTurn(val role: String, val text: String) {
    companion object {
        const val ROLE_USER = "user"
        const val ROLE_MODEL = "model"
    }
}

sealed class GeminiResult {
    abstract val networkMs: Long

    data class Success(val text: String, override val networkMs: Long) : GeminiResult()
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
            if (cancelled) return GeminiResult.Failure("cancelled", elapsed())
            conn.outputStream.use { it.write(body.toByteArray(Charsets.UTF_8)) }
            val code = conn.responseCode
            val stream = if (code in 200..299) conn.inputStream else conn.errorStream
            val text = stream?.bufferedReader(Charsets.UTF_8)?.use { it.readText() }.orEmpty()
            if (code !in 200..299) {
                return GeminiResult.Failure("http $code ${GeminiClient.errorMessage(text)}", elapsed())
            }
            val reply = GeminiClient.parseResponseText(text)?.let { GeminiClient.sanitizeForSpeech(it) }
            if (reply.isNullOrBlank()) {
                GeminiResult.Failure("empty response", elapsed())
            } else {
                GeminiResult.Success(reply, elapsed())
            }
        } catch (e: SocketTimeoutException) {
            GeminiResult.Failure("timeout", elapsed())
        } catch (e: IOException) {
            GeminiResult.Failure(if (cancelled) "cancelled" else "network ${e.javaClass.simpleName}", elapsed())
        } catch (e: Exception) {
            GeminiResult.Failure("error ${e.javaClass.simpleName}", elapsed())
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
