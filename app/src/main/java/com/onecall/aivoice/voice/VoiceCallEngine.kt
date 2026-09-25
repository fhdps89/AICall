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
 * Time from the end-of-turn decision (silence window closed) to the moment TTS starts
 * speaking the reply. [networkMs] is the Gemini request time (null for local replies).
 * [sinceSpeechMs] additionally includes the end-of-turn silence window (from the last
 * final STT result); null when unknown.
 */
data class ReplyLatency(
    val totalMs: Long,
    val networkMs: Long?,
    val source: ReplySource,
    val sinceSpeechMs: Long? = null
)

/**
 * Stage-1 realtime voice loop:
 * - Korean TTS (device default) + SpeechRecognizer
 * - Greets with nickname, listens, replies
 * - End-of-turn wait: after a final STT result the recognizer restarts immediately and
 *   the reply is only generated after [UtteranceWindow.DEFAULT_WINDOW_MS] of silence;
 *   speech inside the window is appended to the same turn
 * - Replies via Gemini API whenever an on-device key is set (read fresh from settings at
 *   every request; in-call memory only). With a key set, [ReplyGenerator] is never used:
 *   AI failures speak a retry line and keep listening. Without a key → [ReplyGenerator]
 * - Barge-in: while TTS speaking, restart listening; on partial/final speech stop TTS
 */
class VoiceCallEngine(
    private val context: Context,
    private val nicknameProvider: () -> String,
    private val onPhase: (CallPhase) -> Unit,
    private val onPartialText: (String) -> Unit = {},
    private val onErrorMessage: (String) -> Unit = {},
    private val isMuted: () -> Boolean = { false },
    /** Read at every AI request (not cached), so a key saved in settings is always used. */
    private val apiKeyProvider: () -> String? = { null },
    private val onLatency: (ReplyLatency) -> Unit = {},
    private val onReplyOrigin: (ReplyOrigin) -> Unit = {}
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
    private val history = mutableListOf<ChatTurn>()
    private val netExecutor = Executors.newCachedThreadPool()
    private var inFlight: GeminiRequest? = null
    private var requestSeq = 0
    private var greetingText: String? = null
    private var ttsInitDone = false

    // End-of-turn silence window (main thread only)
    private val turn = UtteranceWindow()
    private val turnCheck = Runnable { checkTurnWindow() }

    /** True between the end of a user turn and the start of the reply (no listening then). */
    private var awaitingReply = false

    private class LatencyMark(
        val heardAt: Long,
        val networkMs: Long?,
        val source: ReplySource,
        val lastSpeechAt: Long? = null
    )

    private var pendingLatency: LatencyMark? = null
    private var pendingLatencyUtteranceId: String? = null

    /** Fresh read of the saved key; null when not set. */
    private fun currentKey(): String? = apiKeyProvider()?.trim()?.takeIf { it.isNotEmpty() }

    fun start() {
        if (!running.compareAndSet(false, true)) return
        onPhase(CallPhase.Greeting)
        val key = currentKey()
        val nick = nicknameProvider()
        Log.i(LOG_TAG, "call start: ai=${key != null} model=${GeminiClient.MODEL_ID}")
        if (key == null) {
            greetingText = ReplyGenerator.greeting(nick)
            onReplyOrigin(ReplyOrigin.LocalNoKey)
        } else {
            // Fetch the AI greeting in parallel with TTS init
            history.add(ChatTurn(ChatTurn.ROLE_USER, PersonaPrompt.greetingRequest(nick)))
            requestAi(key) { result ->
                val text = when (result) {
                    is GeminiResult.Success -> {
                        Log.i(LOG_TAG, "AI greeting network=${result.networkMs}ms")
                        onReplyOrigin(ReplyOrigin.Ai)
                        result.text
                    }
                    is GeminiResult.Failure -> {
                        Log.w(LOG_TAG, "AI greeting failed: ${result.reason} (${result.networkMs}ms)")
                        onReplyOrigin(ReplyOrigin.AiFailed(result.reason))
                        PersonaPrompt.greetingFallback(nick)
                    }
                }
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
        awaitingReply = false
        resetTurn()
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
            resetTurn()
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
            source = mark.source,
            sinceSpeechMs = mark.lastSpeechAt?.let { ttsStartedAt - it }
        )
        Log.i(
            LOG_TAG,
            "reply latency total=${latency.totalMs}ms network=${latency.networkMs ?: "-"}ms " +
                "sinceLastSpeech(incl. ${turn.windowMs}ms window)=${latency.sinceSpeechMs ?: "-"}ms " +
                "source=${latency.source}"
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
        if (!running.get() || isMuted() || isSpeaking.get() || awaitingReply) return
        ensureRecognizer()
        val r = recognizer ?: return
        if (isListening.get()) return
        isListening.set(true)
        bargeInArmed.set(false)
        onPhase(CallPhase.Listening)
        // Keep showing the accumulated text while the end-of-turn window is open
        if (!turn.hasContent) onPartialText("")
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
            // Hints only (many recognizers ignore them); the real wait is UtteranceWindow
            putExtra(
                RecognizerIntent.EXTRA_SPEECH_INPUT_COMPLETE_SILENCE_LENGTH_MILLIS,
                UtteranceWindow.DEFAULT_WINDOW_MS
            )
            putExtra(
                RecognizerIntent.EXTRA_SPEECH_INPUT_POSSIBLY_COMPLETE_SILENCE_LENGTH_MILLIS,
                UtteranceWindow.DEFAULT_WINDOW_MS
            )
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

    /** User speech detected while TTS is playing: stop TTS (barge-in) and go back to listening. */
    private fun bargeIn(why: String) {
        Log.d(TAG, "barge-in detected ($why)")
        stopSpeakingInternal()
        pendingAfterTts = null
        onPhase(CallPhase.Listening)
    }

    /**
     * A final STT result: append to the current turn, restart the recognizer right away and
     * (re)start the silence window. The reply is only generated when the window closes.
     */
    private fun acceptFinal(text: String) {
        if (!running.get() || isMuted()) return
        val now = SystemClock.elapsedRealtime()
        turn.onFinal(text, now)
        Log.d(TAG, "final segment added; waiting ${turn.windowMs}ms for more speech")
        onPartialText(turn.displayText())
        isListening.set(false)
        startListening()
        scheduleTurnCheck()
    }

    private fun scheduleTurnCheck() {
        mainHandler.removeCallbacks(turnCheck)
        val deadline = turn.deadline ?: return
        val delay = (deadline - SystemClock.elapsedRealtime()).coerceAtLeast(0L)
        mainHandler.postDelayed(turnCheck, delay)
    }

    private fun checkTurnWindow() {
        if (!running.get() || isMuted() || !turn.hasContent) return
        val now = SystemClock.elapsedRealtime()
        if (!turn.isDue(now)) {
            // New speech pushed the deadline out; check again later
            scheduleTurnCheck()
            return
        }
        val lastFinalAt = turn.lastFinalAt
        val text = turn.take()
        Log.i(LOG_TAG, "turn closed after ${turn.windowMs}ms silence (${text.length} chars)")
        processUserUtterance(text, windowClosedAt = now, lastSpeechAt = lastFinalAt)
    }

    private fun resetTurn() {
        mainHandler.removeCallbacks(turnCheck)
        turn.reset()
    }

    private fun processUserUtterance(text: String, windowClosedAt: Long, lastSpeechAt: Long?) {
        if (!running.get() || isMuted()) return
        val cleaned = text.trim()
        if (cleaned.isEmpty()) {
            startListening()
            return
        }
        awaitingReply = true
        stopListeningInternal()
        onPhase(CallPhase.Thinking)
        onPartialText(cleaned)
        val key = currentKey()
        if (key == null) {
            val reply = ReplyGenerator.reply(cleaned, nicknameProvider())
            onReplyOrigin(ReplyOrigin.LocalNoKey)
            speakReply(reply, LatencyMark(windowClosedAt, null, ReplySource.Local, lastSpeechAt))
            return
        }
        history.add(ChatTurn(ChatTurn.ROLE_USER, cleaned))
        while (history.size > MAX_HISTORY_TURNS) history.removeAt(0)
        requestAi(key) { result ->
            when (result) {
                is GeminiResult.Success -> {
                    history.add(ChatTurn(ChatTurn.ROLE_MODEL, result.text))
                    onReplyOrigin(ReplyOrigin.Ai)
                    speakReply(
                        result.text,
                        LatencyMark(windowClosedAt, result.networkMs, ReplySource.Ai, lastSpeechAt)
                    )
                }
                is GeminiResult.Failure -> {
                    Log.w(LOG_TAG, "AI reply failed: ${result.reason} (${result.networkMs}ms)")
                    // Drop the unanswered user turn; the user is asked to repeat it.
                    while (history.lastOrNull()?.role == ChatTurn.ROLE_USER) {
                        history.removeAt(history.size - 1)
                    }
                    onReplyOrigin(ReplyOrigin.AiFailed(result.reason))
                    speakReply(
                        PersonaPrompt.RETRY_FALLBACK,
                        LatencyMark(windowClosedAt, result.networkMs, ReplySource.Fallback, lastSpeechAt)
                    )
                }
            }
        }
    }

    private fun speakReply(text: String, latency: LatencyMark) {
        awaitingReply = false
        speak(text, latency) {
            if (running.get() && !isMuted()) startListening()
        }
    }

    /**
     * Sends the current in-call [history] to Gemini off the main thread.
     * [onResult] runs on the main thread, only if the call is still active and no newer
     * request superseded this one. Overall deadline: [GeminiClient.TIMEOUT_MS].
     */
    private fun requestAi(key: String, onResult: (GeminiResult) -> Unit) {
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
            deliver(GeminiResult.Failure(GeminiErrors.TIMEOUT, SystemClock.elapsedRealtime() - startedAt))
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
            deliver(GeminiResult.Failure("오류(${e.javaClass.simpleName})", 0L))
        }
    }

    private fun scheduleRestartListen(delayMs: Long = 600L) {
        mainHandler.postDelayed({
            if (running.get() && !isMuted() && !isSpeaking.get() && !isListening.get()) {
                startListening()
            }
        }, delayMs)
    }

    private val listener = object : RecognitionListener {
        override fun onReadyForSpeech(params: Bundle?) {}
        override fun onBeginningOfSpeech() {
            if (isSpeaking.get() && bargeInArmed.get()) {
                bargeIn("beginning of speech")
            } else if (turn.hasContent) {
                turn.onActivity(SystemClock.elapsedRealtime())
            }
        }

        override fun onRmsChanged(rmsdB: Float) {
            if (rmsdB < RMS_BARGE_THRESHOLD) return
            // Optional audio-level barge-in while speaking
            if (isSpeaking.get() && bargeInArmed.get()) {
                Log.d(TAG, "RMS barge-in rms=$rmsdB")
                bargeIn("rms")
            } else if (turn.hasContent) {
                // Voice-level audio during the end-of-turn window: user is still talking
                turn.onActivity(SystemClock.elapsedRealtime())
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
            if (error == SpeechRecognizer.ERROR_INSUFFICIENT_PERMISSIONS) {
                onErrorMessage("마이크 권한이 필요합니다.")
                return
            }
            if (turn.hasContent) {
                // Inside the end-of-turn window NO_MATCH / SPEECH_TIMEOUT (and other errors)
                // just mean silence: keep listening, the window timer decides the turn end.
                scheduleRestartListen(WINDOW_RESTART_DELAY_MS)
                return
            }
            // Normal listen errors → restart
            scheduleRestartListen()
        }

        override fun onResults(results: Bundle?) {
            isListening.set(false)
            val texts = results?.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION)
            val best = texts?.firstOrNull().orEmpty().trim()
            if (best.isNotEmpty()) {
                if (isSpeaking.get()) bargeIn("final result")
                acceptFinal(best)
            } else if (running.get() && !isMuted() && !isSpeaking.get()) {
                scheduleRestartListen(if (turn.hasContent) WINDOW_RESTART_DELAY_MS else 600L)
            }
        }

        override fun onPartialResults(partialResults: Bundle?) {
            val texts = partialResults?.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION)
            val best = texts?.firstOrNull().orEmpty().trim()
            if (best.isEmpty()) return
            if (isSpeaking.get()) {
                if (!bargeInArmed.get()) return
                bargeIn("partial result")
            }
            turn.onPartial(best, SystemClock.elapsedRealtime())
            onPartialText(turn.displayText(best))
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
        private const val WINDOW_RESTART_DELAY_MS = 100L
    }
}
