package com.onecall.aivoice.voice

import android.content.Context
import android.content.Intent
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.speech.RecognitionListener
import android.speech.RecognizerIntent
import android.speech.SpeechRecognizer
import android.speech.tts.TextToSpeech
import android.speech.tts.UtteranceProgressListener
import android.util.Log
import java.util.Locale
import java.util.UUID
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicBoolean

/** Where a spoken reply came from. */
enum class ReplySource { Ai, Local, Fallback }

/**
 * Time from the final STT result to the moment TTS starts speaking the reply.
 * [networkMs] is the Gemini request time (null for local replies).
 */
data class ReplyLatency(
    val totalMs: Long,
    val networkMs: Long?,
    val source: ReplySource
)

/**
 * Stage-1 realtime voice loop:
 * - Korean TTS (device default) + SpeechRecognizer
 * - Greets with nickname, listens, replies
 * - Replies via Gemini API when an on-device key is set (in-call memory only),
 *   otherwise via local [ReplyGenerator]; AI failures speak a retry prompt and keep listening
 * - Barge-in: while TTS speaking, restart listening; on partial/final speech stop TTS
 */
class VoiceCallEngine(
    private val context: Context,
    private val nicknameProvider: () -> String,
    private val onPhase: (CallPhase) -> Unit,
    private val onPartialText: (String) -> Unit = {},
    private val onErrorMessage: (String) -> Unit = {},
    private val isMuted: () -> Boolean = { false },
    private val apiKeyProvider: () -> String? = { null },
    private val onLatency: (ReplyLatency) -> Unit = {}
) {
    private val mainHandler = Handler(Looper.getMainLooper())
    private var tts: TextToSpeech? = null
    private var recognizer: SpeechRecognizer? = null

    private val running = AtomicBoolean(false)
    private val ttsReady = AtomicBoolean(false)
    private val isSpeaking = AtomicBoolean(false)
    private val isListening = AtomicBoolean(false)
    private val bargeInArmed = AtomicBoolean(false)

    private var pendingAfterTts: (() -> Unit)? = null
    private var currentUtteranceId: String? = null

    // Gemini (main-thread state). Memory lives only for this call.
    private var aiKey: String? = null
    private val history = mutableListOf<ChatTurn>()
    private val netExecutor = Executors.newCachedThreadPool()
    private var inFlight: GeminiRequest? = null
    private var requestSeq = 0
    private var greetingText: String? = null
    private var ttsInitDone = false

    private class LatencyMark(
        val heardAt: Long,
        val networkMs: Long?,
        val source: ReplySource
    )

    private var pendingLatency: LatencyMark? = null
    private var pendingLatencyUtteranceId: String? = null

    private val aiEnabled: Boolean get() = aiKey != null

    fun start() {
        if (!running.compareAndSet(false, true)) return
        onPhase(CallPhase.Greeting)
        aiKey = apiKeyProvider()?.takeIf { it.isNotBlank() }
        val nick = nicknameProvider()
        if (aiKey == null) {
            greetingText = ReplyGenerator.greeting(nick)
        } else {
            // Fetch the AI greeting in parallel with TTS init
            history.add(ChatTurn(ChatTurn.ROLE_USER, PersonaPrompt.greetingRequest(nick)))
            requestAi { result ->
                val greeting = (result as? GeminiResult.Success)?.text
                if (greeting == null) {
                    Log.w(LOG_TAG, "AI greeting failed: ${(result as GeminiResult.Failure).reason} (${result.networkMs}ms)")
                } else {
                    Log.i(LOG_TAG, "AI greeting network=${result.networkMs}ms")
                }
                val text = greeting ?: ReplyGenerator.greeting(nick)
                history.add(ChatTurn(ChatTurn.ROLE_MODEL, text))
                greetingText = text
                maybeSpeakGreeting()
            }
        }
        initTts {
            mainHandler.post {
                if (!running.get()) return@post
                ensureRecognizer()
                ttsInitDone = true
                maybeSpeakGreeting()
            }
        }
    }

    private fun maybeSpeakGreeting() {
        if (!running.get() || !ttsInitDone) return
        val text = greetingText ?: return
        greetingText = null
        speak(text) {
            if (running.get() && !isMuted()) startListening()
        }
    }

    fun stop() {
        if (!running.compareAndSet(true, false)) return
        bargeInArmed.set(false)
        requestSeq++
        inFlight?.cancel()
        inFlight = null
        history.clear()
        pendingLatency = null
        netExecutor.shutdownNow()
        stopListeningInternal()
        stopSpeakingInternal()
        pendingAfterTts = null
        destroyRecognizer()
        destroyTts()
        onPhase(CallPhase.Ended)
    }

    fun setMuted(muted: Boolean) {
        if (!running.get()) return
        if (muted) {
            stopListeningInternal()
            stopSpeakingInternal()
            onPhase(CallPhase.Idle)
        } else {
            if (!isSpeaking.get() && !isListening.get()) {
                startListening()
            }
        }
    }

    private fun initTts(onReady: () -> Unit) {
        tts = TextToSpeech(context) { status ->
            if (status != TextToSpeech.SUCCESS) {
                onErrorMessage("TTS 초기화 실패. 기기 한국어 TTS를 확인해 주세요.")
                ttsReady.set(false)
                return@TextToSpeech
            }
            val engine = tts ?: return@TextToSpeech
            val result = engine.setLanguage(Locale.KOREAN)
            if (result == TextToSpeech.LANG_MISSING_DATA || result == TextToSpeech.LANG_NOT_SUPPORTED) {
                // Fallback: try language tag ko
                engine.setLanguage(Locale.forLanguageTag("ko"))
            }
            engine.setSpeechRate(1.0f)
            engine.setPitch(1.0f)
            engine.setOnUtteranceProgressListener(object : UtteranceProgressListener() {
                override fun onStart(utteranceId: String?) {
                    val startedAt = SystemClock.elapsedRealtime()
                    mainHandler.post {
                        reportLatency(utteranceId, startedAt)
                        isSpeaking.set(true)
                        onPhase(CallPhase.Speaking)
                        // Arm barge-in shortly after TTS starts (avoid self-echo)
                        mainHandler.postDelayed({
                            if (running.get() && isSpeaking.get() && !isMuted()) {
                                bargeInArmed.set(true)
                                startListeningForBargeIn()
                            }
                        }, BARGE_IN_ARM_DELAY_MS)
                    }
                }

                override fun onDone(utteranceId: String?) {
                    mainHandler.post {
                        if (utteranceId != currentUtteranceId) return@post
                        finishSpeaking()
                    }
                }

                @Deprecated("Deprecated in API")
                override fun onError(utteranceId: String?) {
                    mainHandler.post {
                        if (utteranceId != currentUtteranceId) return@post
                        finishSpeaking()
                    }
                }

                override fun onError(utteranceId: String?, errorCode: Int) {
                    mainHandler.post {
                        if (utteranceId != currentUtteranceId) return@post
                        finishSpeaking()
                    }
                }
            })
            ttsReady.set(true)
            onReady()
        }
    }

    private fun finishSpeaking() {
        isSpeaking.set(false)
        bargeInArmed.set(false)
        stopListeningInternal()
        val next = pendingAfterTts
        pendingAfterTts = null
        if (!running.get() || isMuted()) {
            onPhase(CallPhase.Idle)
            return
        }
        if (next != null) {
            next.invoke()
        } else {
            startListening()
        }
    }

    private fun reportLatency(utteranceId: String?, ttsStartedAt: Long) {
        val mark = pendingLatency ?: return
        if (utteranceId == null || utteranceId != pendingLatencyUtteranceId) return
        pendingLatency = null
        pendingLatencyUtteranceId = null
        val latency = ReplyLatency(
            totalMs = ttsStartedAt - mark.heardAt,
            networkMs = mark.networkMs,
            source = mark.source
        )
        Log.i(
            LOG_TAG,
            "reply latency total=${latency.totalMs}ms network=${latency.networkMs ?: "-"}ms source=${latency.source}"
        )
        onLatency(latency)
    }

    private fun speak(text: String, latency: LatencyMark? = null, then: (() -> Unit)? = null) {
        if (!running.get() || isMuted()) {
            then?.invoke()
            return
        }
        val engine = tts
        if (engine == null || !ttsReady.get()) {
            onErrorMessage("TTS가 준비되지 않았습니다.")
            then?.invoke()
            return
        }
        stopListeningInternal()
        pendingAfterTts = then
        val id = UUID.randomUUID().toString()
        currentUtteranceId = id
        pendingLatency = latency
        pendingLatencyUtteranceId = if (latency != null) id else null
        onPhase(CallPhase.Speaking)
        engine.speak(text, TextToSpeech.QUEUE_FLUSH, null, id)
    }

    private fun ensureRecognizer() {
        if (recognizer != null) return
        if (!SpeechRecognizer.isRecognitionAvailable(context)) {
            onErrorMessage("이 기기에서 음성 인식을 사용할 수 없습니다.")
            return
        }
        recognizer = SpeechRecognizer.createSpeechRecognizer(context).also {
            it.setRecognitionListener(listener)
        }
    }

    private fun startListening() {
        if (!running.get() || isMuted() || isSpeaking.get()) return
        ensureRecognizer()
        val r = recognizer ?: return
        if (isListening.get()) return
        isListening.set(true)
        bargeInArmed.set(false)
        onPhase(CallPhase.Listening)
        onPartialText("")
        try {
            r.startListening(buildListenIntent(partial = true))
        } catch (e: Exception) {
            Log.w(TAG, "startListening failed", e)
            isListening.set(false)
            scheduleRestartListen()
        }
    }

    private fun startListeningForBargeIn() {
        if (!running.get() || isMuted() || !isSpeaking.get() || !bargeInArmed.get()) return
        ensureRecognizer()
        val r = recognizer ?: return
        if (isListening.get()) return
        isListening.set(true)
        try {
            r.startListening(buildListenIntent(partial = true))
        } catch (e: Exception) {
            Log.w(TAG, "barge-in listen failed", e)
            isListening.set(false)
        }
    }

    private fun buildListenIntent(partial: Boolean): Intent {
        return Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH).apply {
            putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM)
            putExtra(RecognizerIntent.EXTRA_LANGUAGE, "ko-KR")
            putExtra(RecognizerIntent.EXTRA_PARTIAL_RESULTS, partial)
            putExtra(RecognizerIntent.EXTRA_MAX_RESULTS, 3)
            // Prefer on-device when available (API 33+); ignored on older
            putExtra(RecognizerIntent.EXTRA_PREFER_OFFLINE, false)
            putExtra(RecognizerIntent.EXTRA_CALLING_PACKAGE, context.packageName)
        }
    }

    private fun stopListeningInternal() {
        isListening.set(false)
        try {
            recognizer?.cancel()
        } catch (_: Exception) {
        }
    }

    private fun stopSpeakingInternal() {
        bargeInArmed.set(false)
        isSpeaking.set(false)
        try {
            tts?.stop()
        } catch (_: Exception) {
        }
        currentUtteranceId = null
    }

    private fun handleUserSpeech(text: String, fromPartial: Boolean) {
        val cleaned = text.trim()
        if (cleaned.isEmpty()) return

        // Barge-in: user spoke while TTS was playing
        if (isSpeaking.get()) {
            Log.d(TAG, "barge-in detected: $cleaned (partial=$fromPartial)")
            stopSpeakingInternal()
            pendingAfterTts = null
            // Continue below to process after stopping TTS
        }

        if (fromPartial && cleaned.length < MIN_PARTIAL_CHARS) {
            onPartialText(cleaned)
            return
        }

        onPartialText(cleaned)

        // For partials during listening (not barge-in), wait for final unless substantial.
        // AI mode always waits for the final STT result (full sentence for the model).
        if (fromPartial && (aiEnabled || !wasBargeInContext())) {
            // Keep listening; final will arrive
            return
        }

        processUserUtterance(cleaned)
    }

    private var lastBargeInAt = 0L
    private fun wasBargeInContext(): Boolean {
        // After we stopped speaking due to barge-in, treat next speech as final-ish
        return System.currentTimeMillis() - lastBargeInAt < 1500L
    }

    private fun processUserUtterance(text: String) {
        if (!running.get() || isMuted()) return
        val heardAt = SystemClock.elapsedRealtime()
        stopListeningInternal()
        onPhase(CallPhase.Thinking)
        if (!aiEnabled) {
            val reply = ReplyGenerator.reply(text, nicknameProvider())
            speakReply(reply, LatencyMark(heardAt, null, ReplySource.Local))
            return
        }
        history.add(ChatTurn(ChatTurn.ROLE_USER, text))
        while (history.size > MAX_HISTORY_TURNS) history.removeAt(0)
        requestAi { result ->
            when (result) {
                is GeminiResult.Success -> {
                    history.add(ChatTurn(ChatTurn.ROLE_MODEL, result.text))
                    speakReply(result.text, LatencyMark(heardAt, result.networkMs, ReplySource.Ai))
                }
                is GeminiResult.Failure -> {
                    Log.w(LOG_TAG, "AI reply failed: ${result.reason} (${result.networkMs}ms)")
                    // Drop the unanswered user turn; the user is asked to repeat it.
                    while (history.lastOrNull()?.role == ChatTurn.ROLE_USER) {
                        history.removeAt(history.size - 1)
                    }
                    speakReply(
                        PersonaPrompt.RETRY_FALLBACK,
                        LatencyMark(heardAt, result.networkMs, ReplySource.Fallback)
                    )
                }
            }
        }
    }

    private fun speakReply(text: String, latency: LatencyMark) {
        speak(text, latency) {
            if (running.get() && !isMuted()) startListening()
        }
    }

    /**
     * Sends the current in-call [history] to Gemini off the main thread.
     * [onResult] runs on the main thread, only if the call is still active and no newer
     * request superseded this one. Overall deadline: [GeminiClient.TIMEOUT_MS].
     */
    private fun requestAi(onResult: (GeminiResult) -> Unit) {
        val key = aiKey ?: return
        inFlight?.cancel()
        val seq = ++requestSeq
        val request = GeminiRequest(
            apiKey = key,
            systemInstruction = PersonaPrompt.systemInstruction(nicknameProvider()),
            turns = history.toList()
        )
        inFlight = request
        val startedAt = SystemClock.elapsedRealtime()
        val delivered = AtomicBoolean(false)
        val deliver: (GeminiResult) -> Unit = { result ->
            if (delivered.compareAndSet(false, true)) {
                mainHandler.post {
                    if (running.get() && seq == requestSeq) {
                        inFlight = null
                        onResult(result)
                    }
                }
            }
        }
        val deadline = Runnable {
            request.cancel()
            deliver(GeminiResult.Failure("timeout", SystemClock.elapsedRealtime() - startedAt))
        }
        mainHandler.postDelayed(deadline, GeminiClient.TIMEOUT_MS.toLong())
        try {
            netExecutor.execute {
                val result = request.execute()
                mainHandler.removeCallbacks(deadline)
                deliver(result)
            }
        } catch (e: Exception) {
            mainHandler.removeCallbacks(deadline)
            deliver(GeminiResult.Failure("executor ${e.javaClass.simpleName}", 0L))
        }
    }

    private fun scheduleRestartListen() {
        mainHandler.postDelayed({
            if (running.get() && !isMuted() && !isSpeaking.get() && !isListening.get()) {
                startListening()
            }
        }, 600L)
    }

    private val listener = object : RecognitionListener {
        override fun onReadyForSpeech(params: Bundle?) {}
        override fun onBeginningOfSpeech() {
            if (isSpeaking.get() && bargeInArmed.get()) {
                lastBargeInAt = System.currentTimeMillis()
                stopSpeakingInternal()
                pendingAfterTts = null
                onPhase(CallPhase.Listening)
            }
        }

        override fun onRmsChanged(rmsdB: Float) {
            // Optional audio-level barge-in while speaking
            if (isSpeaking.get() && bargeInArmed.get() && rmsdB >= RMS_BARGE_THRESHOLD) {
                lastBargeInAt = System.currentTimeMillis()
                Log.d(TAG, "RMS barge-in rms=$rmsdB")
                stopSpeakingInternal()
                pendingAfterTts = null
                onPhase(CallPhase.Listening)
            }
        }

        override fun onBufferReceived(buffer: ByteArray?) {}
        override fun onEndOfSpeech() {
            isListening.set(false)
        }

        override fun onError(error: Int) {
            isListening.set(false)
            Log.d(TAG, "Recognition error: $error")
            if (!running.get() || isMuted()) return
            // While speaking, recognition errors are common (echo); re-arm barge-in listen
            if (isSpeaking.get()) {
                mainHandler.postDelayed({
                    if (running.get() && isSpeaking.get() && bargeInArmed.get() && !isMuted()) {
                        startListeningForBargeIn()
                    }
                }, 350L)
                return
            }
            // Normal listen errors → restart
            when (error) {
                SpeechRecognizer.ERROR_CLIENT,
                SpeechRecognizer.ERROR_RECOGNIZER_BUSY -> scheduleRestartListen()
                SpeechRecognizer.ERROR_NO_MATCH,
                SpeechRecognizer.ERROR_SPEECH_TIMEOUT -> scheduleRestartListen()
                SpeechRecognizer.ERROR_INSUFFICIENT_PERMISSIONS ->
                    onErrorMessage("마이크 권한이 필요합니다.")
                else -> scheduleRestartListen()
            }
        }

        override fun onResults(results: Bundle?) {
            isListening.set(false)
            val texts = results?.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION)
            val best = texts?.firstOrNull().orEmpty()
            if (best.isNotBlank()) {
                handleUserSpeech(best, fromPartial = false)
            } else if (running.get() && !isMuted() && !isSpeaking.get()) {
                scheduleRestartListen()
            }
        }

        override fun onPartialResults(partialResults: Bundle?) {
            val texts = partialResults?.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION)
            val best = texts?.firstOrNull().orEmpty()
            if (best.isNotBlank()) {
                if (isSpeaking.get() && bargeInArmed.get()) {
                    lastBargeInAt = System.currentTimeMillis()
                    handleUserSpeech(best, fromPartial = true)
                } else {
                    onPartialText(best)
                    // Substantial partial → treat as utterance for snappier UX (local mode only)
                    if (!aiEnabled && best.trim().length >= MIN_PARTIAL_CHARS * 2) {
                        handleUserSpeech(best, fromPartial = false)
                    }
                }
            }
        }

        override fun onEvent(eventType: Int, params: Bundle?) {}
    }

    private fun destroyRecognizer() {
        try {
            recognizer?.destroy()
        } catch (_: Exception) {
        }
        recognizer = null
        isListening.set(false)
    }

    private fun destroyTts() {
        try {
            tts?.stop()
            tts?.shutdown()
        } catch (_: Exception) {
        }
        tts = null
        ttsReady.set(false)
        isSpeaking.set(false)
    }

    companion object {
        private const val TAG = "VoiceCallEngine"
        private const val LOG_TAG = "AICall"
        private const val MAX_HISTORY_TURNS = 24
        private const val BARGE_IN_ARM_DELAY_MS = 450L
        private const val RMS_BARGE_THRESHOLD = 7.5f
        private const val MIN_PARTIAL_CHARS = 2
    }
}
