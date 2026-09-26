package com.onecall.aivoice.voice

import org.json.JSONArray
import org.json.JSONObject
import java.io.InputStream
import java.net.HttpURLConnection
import java.net.URL
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.TimeUnit

/**
 * OpenRouter (one key for the reply brain and the voice).
 * - Chat: POST /api/v1/chat/completions with stream=true (SSE), model [CHAT_MODEL].
 * - TTS: POST /api/v1/audio/speech, response_format "pcm" (16-bit LE mono, rate from the
 *   Content-Type header, 24 kHz for all three voices); the body is read and played as it arrives.
 * The key is passed per request from on-device settings; never hard-coded or logged.
 */
object OpenRouterClient {
    const val CHAT_ENDPOINT = "https://openrouter.ai/api/v1/chat/completions"
    const val TTS_ENDPOINT = "https://openrouter.ai/api/v1/audio/speech"

    /** Verified via GET /api/v1/models (Gemini 3.5 Flash-Lite). */
    const val CHAT_MODEL = "google/gemini-3.5-flash-lite"
    const val MAX_TOKENS = 256

    /** Chat: max wait for the first streamed token. */
    const val CHAT_FIRST_TOKEN_TIMEOUT_MS = 8_000
    /** Chat: hard cap for the whole streamed reply. */
    const val CHAT_TOTAL_TIMEOUT_MS = 15_000
    /** TTS: connect / per-read timeout (the pipeline also enforces 6 s to first audio). */
    const val TTS_TIMEOUT_MS = 6_000

    /** Speaking style for Gemini TTS (sent as metadata, never inside the spoken text). */
    const val GEMINI_TTS_STYLE =
        "warm, casual, natural tone of a close friend in their twenties chatting on the phone"

    fun chatRole(role: String): String = if (role == ChatTurn.ROLE_MODEL) "assistant" else "user"

    /**
     * OpenAI-style chat body. Same-role turns are merged and the conversation starts with a
     * user turn (like the Gemini request).
     */
    fun buildChatJson(systemPrompt: String, turns: List<ChatTurn>, stream: Boolean = true): JSONObject {
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
        val messages = JSONArray().put(JSONObject().put("role", "system").put("content", systemPrompt))
        merged.forEach { messages.put(JSONObject().put("role", chatRole(it.role)).put("content", it.text)) }
        return JSONObject()
            .put("model", CHAT_MODEL)
            .put("messages", messages)
            .put("max_tokens", MAX_TOKENS)
            .put("stream", stream)
    }

    /** One parsed SSE line of a streamed chat completion. */
    sealed class SseEvent {
        data class Delta(val text: String, val model: String?) : SseEvent()
        object Done : SseEvent()
        data class Error(val reason: String) : SseEvent()
        object Ignore : SseEvent()
    }

    fun parseSseLine(rawLine: String): SseEvent {
        val line = rawLine.trim()
        if (!line.startsWith("data:")) return SseEvent.Ignore // ": OPENROUTER PROCESSING" etc.
        val data = line.removePrefix("data:").trim()
        if (data == "[DONE]") return SseEvent.Done
        return try {
            val root = JSONObject(data)
            root.optJSONObject("error")?.let { return SseEvent.Error(OpenRouterErrors.fromErrorObject(it)) }
            val choice = root.optJSONArray("choices")?.optJSONObject(0) ?: return SseEvent.Ignore
            if (choice.optString("finish_reason") == "error") return SseEvent.Error("스트림 오류")
            val content = choice.optJSONObject("delta")?.optString("content", "").orEmpty()
            if (content.isEmpty()) SseEvent.Ignore
            else SseEvent.Delta(content, root.optString("model", "").ifEmpty { null })
        } catch (_: Exception) {
            SseEvent.Ignore
        }
    }

    /** TTS body: input is the sentence only; style goes to provider options (Gemini). */
    fun buildTtsJson(voice: TtsVoice, text: String): JSONObject {
        val body = JSONObject()
            .put("model", voice.model)
            .put("input", text)
            .put("voice", voice.voice)
            .put("response_format", "pcm")
        if (voice.googleStyle) {
            body.put(
                "provider",
                JSONObject().put(
                    "options",
                    JSONObject().put(
                        "google-ai-studio",
                        JSONObject().put("speech_metadata", JSONObject().put("style", GEMINI_TTS_STYLE))
                    )
                )
            )
        }
        return body
    }

    /** "audio/pcm;rate=24000;channels=1" → (24000, 1); null if not PCM. */
    fun parsePcmFormat(contentType: String?): Pair<Int, Int>? {
        val ct = contentType?.lowercase()?.trim() ?: return Pair(DEFAULT_RATE, 1)
        if (!ct.startsWith("audio/pcm") && !ct.startsWith("audio/l16") &&
            !ct.startsWith("application/octet-stream")
        ) return null
        var rate = DEFAULT_RATE
        var channels = 1
        ct.split(';').drop(1).forEach { p ->
            val kv = p.split('=')
            if (kv.size == 2) {
                when (kv[0].trim()) {
                    "rate" -> kv[1].trim().toIntOrNull()?.let { rate = it }
                    "channels" -> kv[1].trim().toIntOrNull()?.let { channels = it }
                }
            }
        }
        return Pair(rate, channels)
    }

    const val DEFAULT_RATE = 24_000

    private val canceller = Executors.newSingleThreadExecutor { r ->
        Thread(r, "openrouter-cancel").apply { isDaemon = true }
    }

    /** Closes a connection off the calling (possibly main) thread. */
    fun disconnectAsync(conn: HttpURLConnection?) {
        conn ?: return
        try {
            canceller.execute {
                try {
                    conn.disconnect()
                } catch (_: Exception) {
                }
            }
        } catch (_: Exception) {
        }
    }

    fun keyTestLabel(chat: ChatResult, tts: TtsTestResult, voice: TtsVoice): Pair<String, Boolean> {
        val chatPart = when (chat) {
            is ChatResult.Success -> "대화 성공 (${chat.model ?: CHAT_MODEL})"
            is ChatResult.Failure -> "대화 실패: ${chat.reason}"
        }
        val ttsPart = if (tts.ok) {
            "음성 성공 (${voice.shortLabel}, 첫 소리 %.1f초)".format((tts.firstAudioMs ?: 0L) / 1000.0)
        } else {
            "음성 실패: ${tts.reason}"
        }
        return "$chatPart\n$ttsPart" to (chat is ChatResult.Success && tts.ok)
    }

    /** Tiny chat request to verify the key (blocking). */
    fun testChat(apiKey: String): ChatResult = OpenRouterChatRequest(
        apiKey = apiKey,
        systemPrompt = "짧게 한 단어로만 답해.",
        turns = listOf(ChatTurn(ChatTurn.ROLE_USER, "연결 테스트야. 응 이라고만 답해.")),
        onDelta = {}
    ).execute()

    /** Tiny TTS request with [voice] (blocking); measures time to first audio bytes. */
    fun testTts(apiKey: String, voice: TtsVoice): TtsTestResult {
        val job = OpenRouterSynthJob(apiKey, voice, "응, 잘 들려.")
        val t0 = System.nanoTime()
        job.run()
        var first: Long? = null
        var bytes = 0
        while (true) {
            when (val ev = job.poll(0) ?: break) {
                is SynthEvent.Chunk -> {
                    bytes += ev.length
                    if (first == null) first = job.firstAudioAtNanos?.let { (it - t0) / 1_000_000L }
                }
                is SynthEvent.Failed -> return TtsTestResult(false, ev.reason, null, bytes)
                SynthEvent.Done -> break
                else -> Unit
            }
        }
        return if (bytes > 0) TtsTestResult(true, null, first, bytes)
        else TtsTestResult(false, SpeechPipeline.EMPTY, null, 0)
    }
}

data class TtsTestResult(val ok: Boolean, val reason: String?, val firstAudioMs: Long?, val bytes: Int)

/** The three test voices (numbers match the earlier voice samples). */
enum class TtsVoice(
    val option: String,
    val model: String,
    val voice: String,
    val description: String,
    val googleStyle: Boolean
) {
    GEMINI_LITE_PUCK("2", "google/gemini-3.8-flash-lite-tts", "Puck", "Gemini Flash-Lite TTS · 남 · 기본", true),
    GEMINI_FLASH_LEDA("1", "google/gemini-3.8-flash-tts", "Leda", "Gemini Flash TTS · 여", true),
    QWEN_LONGANHUAN("7", "qwen/qwen-audio-3.0-tts-flash", "longanhuan_v3.6", "Qwen TTS Flash · 여", false);

    val shortLabel: String get() = "${option}번 $voice"

    companion object {
        val DEFAULT = GEMINI_LITE_PUCK
        fun fromOption(option: String?): TtsVoice = values().firstOrNull { it.option == option } ?: DEFAULT
    }
}

sealed class ChatResult {
    abstract val networkMs: Long

    data class Success(
        val text: String,
        override val networkMs: Long,
        val firstTokenMs: Long?,
        val model: String?
    ) : ChatResult()

    /** [partialText] = text streamed before the failure (may be empty). */
    data class Failure(val reason: String, override val networkMs: Long, val partialText: String = "") : ChatResult()
}

/**
 * Streamed chat completion. [onDelta] is called on the executing thread for every text piece.
 * Blocking: call [execute] off the main thread; [cancel] from any thread.
 */
class OpenRouterChatRequest(
    private val apiKey: String,
    private val systemPrompt: String,
    private val turns: List<ChatTurn>,
    private val onDelta: (String) -> Unit,
    private val timeoutMs: Int = OpenRouterClient.CHAT_FIRST_TOKEN_TIMEOUT_MS
) {
    @Volatile
    private var connection: HttpURLConnection? = null

    @Volatile
    private var cancelled = false

    @Volatile
    var timedOut = false
        private set

    fun cancel(timeout: Boolean = false) {
        if (timeout) timedOut = true
        cancelled = true
        OpenRouterClient.disconnectAsync(connection)
    }

    fun execute(): ChatResult {
        val startedAt = System.nanoTime()
        fun elapsed() = (System.nanoTime() - startedAt) / 1_000_000L
        val text = StringBuilder()
        var firstTokenMs: Long? = null
        var model: String? = null
        var conn: HttpURLConnection? = null
        fun fail(reason: String) = ChatResult.Failure(reason, elapsed(), text.toString())
        return try {
            val body = OpenRouterClient.buildChatJson(systemPrompt, turns, stream = true).toString()
            conn = (URL(OpenRouterClient.CHAT_ENDPOINT).openConnection() as HttpURLConnection).apply {
                requestMethod = "POST"
                connectTimeout = timeoutMs
                readTimeout = timeoutMs
                doOutput = true
                useCaches = false
                setRequestProperty("Content-Type", "application/json; charset=utf-8")
                setRequestProperty("Accept", "text/event-stream")
                setRequestProperty("Authorization", "Bearer $apiKey")
            }
            connection = conn
            if (cancelled) return fail(cancelReason())
            conn.outputStream.use { it.write(body.toByteArray(Charsets.UTF_8)) }
            val code = conn.responseCode
            if (code !in 200..299) {
                val err = conn.errorStream?.bufferedReader(Charsets.UTF_8)?.use { it.readText() }.orEmpty()
                return fail(OpenRouterErrors.httpReason(code, err))
            }
            conn.inputStream.bufferedReader(Charsets.UTF_8).use { reader ->
                while (true) {
                    val line = reader.readLine() ?: break
                    when (val ev = OpenRouterClient.parseSseLine(line)) {
                        is OpenRouterClient.SseEvent.Delta -> {
                            if (firstTokenMs == null) firstTokenMs = elapsed()
                            if (ev.model != null) model = ev.model
                            text.append(ev.text)
                            onDelta(ev.text)
                        }
                        OpenRouterClient.SseEvent.Done -> break
                        is OpenRouterClient.SseEvent.Error -> return fail(ev.reason)
                        OpenRouterClient.SseEvent.Ignore -> Unit
                    }
                    if (cancelled) return fail(cancelReason())
                }
            }
            val reply = GeminiClient.sanitizeForSpeech(text.toString())
            if (reply.isBlank()) fail(GeminiErrors.EMPTY)
            else ChatResult.Success(reply, elapsed(), firstTokenMs, model)
        } catch (e: Exception) {
            if (cancelled) fail(cancelReason()) else fail(GeminiErrors.exceptionReason(e))
        } finally {
            try {
                conn?.disconnect()
            } catch (_: Exception) {
            }
            connection = null
        }
    }

    private fun cancelReason() = if (timedOut) GeminiErrors.TIMEOUT else GeminiErrors.CANCELLED
}

/** Remote TTS via OpenRouter; each [start] runs one request on [executor]. */
class OpenRouterSynth(
    private val apiKey: String,
    private val voice: TtsVoice,
    private val executor: ExecutorService
) : SpeechSynth {
    override fun start(text: String): SynthJob {
        val job = OpenRouterSynthJob(apiKey, voice, text)
        try {
            executor.execute(job)
        } catch (e: Exception) {
            job.failNow("오류(${e.javaClass.simpleName})")
        }
        return job
    }
}

/** One streamed TTS request: PCM bytes are queued as they arrive (frame-aligned). */
class OpenRouterSynthJob(
    private val apiKey: String,
    private val voice: TtsVoice,
    private val text: String,
    private val timeoutMs: Int = OpenRouterClient.TTS_TIMEOUT_MS
) : SynthJob, Runnable {
    private val queue = LinkedBlockingQueue<SynthEvent>()

    @Volatile
    private var cancelled = false

    @Volatile
    private var connection: HttpURLConnection? = null

    @Volatile
    var firstAudioAtNanos: Long? = null
        private set

    override fun poll(timeoutMs: Long): SynthEvent? =
        if (timeoutMs <= 0) queue.poll() else queue.poll(timeoutMs, TimeUnit.MILLISECONDS)

    override fun cancel() {
        cancelled = true
        OpenRouterClient.disconnectAsync(connection)
    }

    fun failNow(reason: String) {
        queue.put(SynthEvent.Failed(reason))
    }

    override fun run() {
        var conn: HttpURLConnection? = null
        try {
            if (cancelled) return
            val body = OpenRouterClient.buildTtsJson(voice, text).toString()
            conn = (URL(OpenRouterClient.TTS_ENDPOINT).openConnection() as HttpURLConnection).apply {
                requestMethod = "POST"
                connectTimeout = timeoutMs
                readTimeout = timeoutMs
                doOutput = true
                useCaches = false
                setRequestProperty("Content-Type", "application/json; charset=utf-8")
                setRequestProperty("Authorization", "Bearer $apiKey")
            }
            connection = conn
            conn.outputStream.use { it.write(body.toByteArray(Charsets.UTF_8)) }
            val code = conn.responseCode
            if (code !in 200..299) {
                val err = conn.errorStream?.bufferedReader(Charsets.UTF_8)?.use { it.readText() }.orEmpty()
                queue.put(SynthEvent.Failed(OpenRouterErrors.httpReason(code, err)))
                return
            }
            val format = OpenRouterClient.parsePcmFormat(conn.contentType)
            if (format == null) {
                queue.put(SynthEvent.Failed("형식 오류(${conn.contentType})"))
                return
            }
            queue.put(SynthEvent.Format(format.first, format.second))
            pump(conn.inputStream, 2 * format.second)
            if (!cancelled) queue.put(SynthEvent.Done)
        } catch (e: Exception) {
            if (!cancelled) queue.put(SynthEvent.Failed(GeminiErrors.exceptionReason(e)))
        } finally {
            try {
                conn?.disconnect()
            } catch (_: Exception) {
            }
            connection = null
        }
    }

    private fun pump(input: InputStream, frameBytes: Int) {
        val aligner = PcmAligner(frameBytes)
        val buf = ByteArray(8192)
        input.use { s ->
            while (!cancelled) {
                val n = s.read(buf)
                if (n < 0) break
                if (n == 0) continue
                val out = aligner.push(buf, n) ?: continue
                if (firstAudioAtNanos == null) firstAudioAtNanos = System.nanoTime()
                queue.put(SynthEvent.Chunk(out))
            }
        }
    }
}

/** Keeps PCM chunks frame-aligned (a network read can end mid-sample). Pure (unit-tested). */
class PcmAligner(private val frameBytes: Int) {
    private var pending = ByteArray(0)

    /** Returns a frame-aligned copy of pending + data[0 until n], or null if < 1 frame. */
    fun push(data: ByteArray, n: Int): ByteArray? {
        val total = pending.size + n
        val usable = total - total % frameBytes
        if (usable == 0) {
            pending = pending + data.copyOf(n)
            return null
        }
        val all = ByteArray(total)
        System.arraycopy(pending, 0, all, 0, pending.size)
        System.arraycopy(data, 0, all, pending.size, n)
        pending = all.copyOfRange(usable, total)
        return all.copyOf(usable)
    }
}

/** Maps OpenRouter errors ({"error":{"code":..,"message":..}}) to short Korean labels. */
object OpenRouterErrors {
    fun fromErrorObject(err: JSONObject): String {
        val code = err.optInt("code", 0)
        return httpReasonFor(code, err.optString("message", ""))
    }

    fun httpReason(httpCode: Int, body: String): String {
        val message = try {
            JSONObject(body).optJSONObject("error")?.optString("message", "").orEmpty()
        } catch (_: Exception) {
            ""
        }
        return httpReasonFor(httpCode, message)
    }

    private fun httpReasonFor(code: Int, message: String): String {
        val short = message.replace(Regex("\\s+"), " ").trim().take(60)
        val detail = if (short.isEmpty()) "" else " $short"
        return when (code) {
            401 -> "키 오류(401)"
            402 -> "크레딧 부족(402)"
            403 -> "권한 없음(403$detail)"
            404 -> "모델 없음(404$detail)"
            408, 504 -> "${GeminiErrors.TIMEOUT}($code)"
            429 -> "한도 초과(429)"
            400 -> "요청 오류(400$detail)"
            in 500..599 -> "서버 오류($code)"
            0 -> if (short.isEmpty()) "오류" else "오류($short)"
            else -> "HTTP 오류($code)"
        }
    }
}
