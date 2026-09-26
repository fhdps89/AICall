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
import android.util.Log
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicBoolean

/** Where a spoken reply came from. */
enum class ReplySource { Ai, Local, Fallback }

/**
 * Latency of one reply, measured on the phone.
 * [firstSoundMs]: end-of-turn decision (1.5 s silence window closed) → first audible sample.
 * [sinceSpeechMs]: same end point but from the last final STT result (includes the window).
 * [modelMs]: OpenRouter = chat request → first complete sentence; Gemini key = whole request.
 * [voiceMs]: first sentence ready → first audible sample (TTS time incl. fallback).
 */
data class ReplyLatency(
    val firstSoundMs: Long,
    val modelMs: Long?,
    val source: ReplySource,
    val sinceSpeechMs: Long? = null,
    val voiceMs: Long? = null,
    val remoteVoice: Boolean = false
)

/**
 * Realtime voice loop:
 * - SpeechRecognizer; end-of-turn wait: after a final STT result the recognizer restarts and
 *   the reply is only generated after [UtteranceWindow.DEFAULT_WINDOW_MS] of silence
 * - Brain (keys read fresh at every request, in-call memory only):
 *   OpenRouter key → streamed chat ([OpenRouterClient.CHAT_MODEL]); else Gemini key → Gemini
 *   REST; else rule-based [ReplyGenerator]
 * - Voice: OpenRouter key → OpenRouter TTS (selected [TtsVoice]) sentence by sentence via
 *   [SpeechPipeline] (first sentence plays while the rest is synthesized); failed sentences
 *   and key-less modes use the built-in TTS
 * - Barge-in: while speaking, listen; on user speech stop audio + cancel pending synthesis
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
    private val openRouterKeyProvider: () -> String? = { null },
    private val voiceProvider: () -> TtsVoice = { TtsVoice.DEFAULT },
    private val onLatency: (ReplyLatency) -> Unit = {},
    private val onReplyOrigin: (ReplyOrigin) -> Unit = {},
    /** Brain + voice of the current reply, e.g. "google/gemini-3.5-flash-lite · 목소리 2번 Puck". */
    private val onVoiceInfo: (String) -> Unit = {},
    /** "음성 실패: <사유> → 기본 음성" or null when the reply's voice worked. */
    private val onVoiceFailure: (String?) -> Unit = {}
) {
    private val mainHandler = Handler(Looper.getMainLooper())
    private var speaker: BuiltInSpeaker? = null
    private var recognizer: SpeechRecognizer? = null

    private val running = AtomicBoolean(false)
    private val isSpeaking = AtomicBoolean(false)
    private val isListening = AtomicBoolean(false)
    private val bargeInArmed = AtomicBoolean(false)

    // AI (main-thread state). Memory lives only for this call.
    private val history = mutableListOf<ChatTurn>()
    private val netExecutor = Executors.newCachedThreadPool()
    private var inFlight: GeminiRequest? = null
    private var requestSeq = 0

    // End-of-turn silence window (main thread only)
    private val turn = UtteranceWindow()
    private val turnCheck = Runnable { checkTurnWindow() }

    /** True between the end of a user turn and the first sound of the reply (no listening then). */
    private var awaitingReply = false

    /** The reply being produced/spoken (main thread). */
    private var active: ActiveReply? = null
    private var replySeq = 0

    private enum class Brain { OpenRouter, Gemini, Local }

    /** One reply: chat stream (optional) + speech pipeline. Timestamps: elapsedRealtime ms. */
    private inner class ActiveReply(
        val id: Int,
        val brain: Brain,
        val voice: TtsVoice?,
        /** When the end-of-turn window closed; null for the greeting. */
        val committedAt: Long?,
        val lastSpeechAt: Long?,
        val isGreeting: Boolean
    ) {
        lateinit var pipeline: SpeechPipeline
        var sink: AudioTrackSink? = null

        @Volatile
        var chat: OpenRouterChatRequest? = null
        val streamed = StringBuffer()

        @Volatile
        var sentencesAdded = 0

        @Volatile
        var chatStartedAt = 0L

        @Volatile
        var firstSentenceAt: Long? = null

        @Volatile
        var modelMs: Long? = null
        var source: ReplySource = ReplySource.Ai

        @Volatile
        var cancelled = false
        var historyDone = false
        var voiceFailed = false
    }

    private fun currentKey(): String? = apiKeyProvider()?.trim()?.takeIf { it.isNotEmpty() }
    private fun currentOpenRouterKey(): String? = openRouterKeyProvider()?.trim()?.takeIf { it.isNotEmpty() }

    private fun now() = SystemClock.elapsedRealtime()

    fun start() {
        if (!running.compareAndSet(false, true)) return
        onPhase(CallPhase.Greeting)
        speaker = BuiltInSpeaker(context) { msg -> mainHandler.post { onErrorMessage(msg) } }
        ensureRecognizer()
        val orKey = currentOpenRouterKey()
        val key = currentKey()
        val nick = nicknameProvider()
        val brain = when {
            orKey != null -> Brain.OpenRouter
            key != null -> Brain.Gemini
            else -> Brain.Local
        }
        Log.i(LOG_TAG, "call start: brain=$brain voice=${if (orKey != null) voiceProvider().shortLabel else "builtin"}")
        when (brain) {
            Brain.OpenRouter -> {
                history.add(ChatTurn(ChatTurn.ROLE_USER, PersonaPrompt.greetingRequest(nick)))
                startOpenRouterReply(orKey!!, committedAt = null, lastSpeechAt = null, isGreeting = true)
            }
            Brain.Gemini -> {
                history.add(ChatTurn(ChatTurn.ROLE_USER, PersonaPrompt.greetingRequest(nick)))
                requestAi(key!!) { result ->
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
                    startStaticReply(text, Brain.Gemini, null, null, ReplySource.Ai, null, isGreeting = true)
                }
            }
            Brain.Local -> {
                onReplyOrigin(ReplyOrigin.LocalNoKey)
                startStaticReply(ReplyGenerator.greeting(nick), Brain.Local, null, null, ReplySource.Local, null, true)
            }
        }
    }

    fun stop() {
        if (!running.compareAndSet(true, false)) return
        bargeInArmed.set(false)
        requestSeq++
        inFlight?.cancel()
        inFlight = null
        cancelActiveReply(recordPartial = false)
        history.clear()
        awaitingReply = false
        resetTurn()
        stopListeningInternal()
        isSpeaking.set(false)
        destroyRecognizer()
        speaker?.shutdown()
        speaker = null
        netExecutor.shutdownNow()
        onPhase(CallPhase.Ended)
    }

    fun setMuted(muted: Boolean) {
        if (!running.get()) return
        if (muted) {
            resetTurn()
            stopListeningInternal()
            cancelActiveReply(recordPartial = true)
            isSpeaking.set(false)
            bargeInArmed.set(false)
            awaitingReply = false
            onPhase(CallPhase.Idle)
        } else {
            if (!isSpeaking.get() && !isListening.get()) {
                startListening()
            }
        }
    }

    // ---------------------------------------------------------------- replies

    private fun voiceLabel(brain: Brain, voice: TtsVoice?): String {
        val voicePart = voice?.let { "목소리 ${it.shortLabel}" } ?: "기본 음성"
        return when (brain) {
            Brain.OpenRouter -> "${OpenRouterClient.CHAT_MODEL} · $voicePart"
            Brain.Gemini -> "${GeminiClient.MODEL_ID}(Gemini 키) · $voicePart"
            Brain.Local -> voicePart
        }
    }

    /** Creates the reply + pipeline (remote voice only with an OpenRouter key). */
    private fun newReply(
        brain: Brain,
        orKey: String?,
        committedAt: Long?,
        lastSpeechAt: Long?,
        isGreeting: Boolean
    ): ActiveReply? {
        if (!running.get()) return null
        cancelActiveReply(recordPartial = true)
        val voice = if (orKey != null) voiceProvider() else null
        val reply = ActiveReply(++replySeq, brain, voice, committedAt, lastSpeechAt, isGreeting)
        val synth = if (orKey != null && voice != null) OpenRouterSynth(orKey, voice, netExecutor) else null
        val sink = AudioTrackSink(mainHandler)
        val fallback = speaker ?: return null
        reply.sink = sink
        reply.pipeline = SpeechPipeline(synth, sink, fallback, PipelineListener(reply))
        active = reply
        onVoiceInfo(voiceLabel(brain, voice))
        onVoiceFailure(null)
        stopListeningInternal()
        reply.pipeline.start()
        return reply
    }

    private inner class PipelineListener(private val reply: ActiveReply) : SpeechPipeline.Listener {
        private fun onMain(block: () -> Unit) = mainHandler.post {
            if (running.get() && active === reply && !reply.cancelled) block()
        }

        override fun onFirstSound(atMs: Long, remote: Boolean) {
            val at = now()
            onMain { onReplyFirstSound(reply, at, remote) }
        }

        override fun onSynthStarted(index: Int, text: String) {
            Log.d(LOG_TAG, "tts[$index] request start (${text.length} chars) voice=${reply.voice?.shortLabel}")
        }

        override fun onTtsTiming(index: Int, firstAudioMs: Long?, totalMs: Long) {
            Log.i(
                LOG_TAG,
                "tts[$index] firstAudio=${firstAudioMs ?: "-"}ms total=${totalMs}ms voice=${reply.voice?.shortLabel}"
            )
        }

        override fun onFallback(index: Int, reason: String) {
            Log.w(LOG_TAG, "tts[$index] failed: $reason → built-in TTS")
            onMain {
                reply.voiceFailed = true
                onVoiceFailure(TtsFallback.label(reason))
            }
        }

        override fun onFinished(cancelled: Boolean) {
            mainHandler.post { onReplyFinished(reply, cancelled) }
        }
    }

    private fun onReplyFirstSound(reply: ActiveReply, at: Long, remote: Boolean) {
        isSpeaking.set(true)
        awaitingReply = false
        onPhase(CallPhase.Speaking)
        val committed = reply.committedAt
        val voiceMs = reply.firstSentenceAt?.let { at - it }
        if (committed != null) {
            val latency = ReplyLatency(
                firstSoundMs = at - committed,
                modelMs = reply.modelMs,
                source = reply.source,
                sinceSpeechMs = reply.lastSpeechAt?.let { at - it },
                voiceMs = voiceMs,
                remoteVoice = remote
            )
            Log.i(
                LOG_TAG,
                "first sound: sinceTurnCommit=${latency.firstSoundMs}ms " +
                    "sinceLastSpeech(incl. ${turn.windowMs}ms window)=${latency.sinceSpeechMs ?: "-"}ms " +
                    "model(firstSentence)=${latency.modelMs ?: "-"}ms voice(sentence→sound)=${voiceMs ?: "-"}ms " +
                    "brain=${reply.brain} voice=${reply.voice?.shortLabel ?: "builtin"} " +
                    "remote=$remote source=${latency.source}"
            )
            onLatency(latency)
        } else {
            Log.i(
                LOG_TAG,
                "greeting first sound: model(firstSentence)=${reply.modelMs ?: "-"}ms " +
                    "voice(sentence→sound)=${voiceMs ?: "-"}ms voice=${reply.voice?.shortLabel ?: "builtin"} remote=$remote"
            )
        }
        // Arm barge-in shortly after audio starts (avoid self-echo)
        mainHandler.postDelayed({
            if (running.get() && isSpeaking.get() && !isMuted() && active === reply) {
                bargeInArmed.set(true)
                startListeningForBargeIn()
            }
        }, BARGE_IN_ARM_DELAY_MS)
    }

    private fun onReplyFinished(reply: ActiveReply, cancelled: Boolean) {
        if (active !== reply) return
        active = null
        if (cancelled || reply.cancelled || !running.get()) return
        isSpeaking.set(false)
        bargeInArmed.set(false)
        awaitingReply = false
        stopListeningInternal()
        if (isMuted()) {
            onPhase(CallPhase.Idle)
        } else {
            startListening()
        }
    }

    /** Stops audio + pending synthesis + chat stream. Keeps streamed text in memory if asked. */
    private fun cancelActiveReply(recordPartial: Boolean) {
        val reply = active ?: return
        active = null
        reply.cancelled = true
        reply.chat?.cancel()
        reply.pipeline.cancel()
        if (reply.brain == Brain.OpenRouter && !reply.historyDone) {
            reply.historyDone = true
            val partial = GeminiClient.sanitizeForSpeech(reply.streamed.toString())
            if (recordPartial && partial.isNotBlank()) {
                history.add(ChatTurn(ChatTurn.ROLE_MODEL, partial))
            } else {
                dropTrailingUserTurns()
            }
        }
    }

    private fun dropTrailingUserTurns() {
        while (history.lastOrNull()?.role == ChatTurn.ROLE_USER) history.removeAt(history.size - 1)
    }

    /** Known full text (local / Gemini key / fallback line): split and speak. */
    private fun startStaticReply(
        text: String,
        brain: Brain,
        committedAt: Long?,
        lastSpeechAt: Long?,
        source: ReplySource,
        modelMs: Long?,
        isGreeting: Boolean = false
    ) {
        if (!running.get() || isMuted()) {
            awaitingReply = false
            if (running.get()) onPhase(CallPhase.Idle)
            return
        }
        val reply = newReply(brain, currentOpenRouterKey().takeIf { brain == Brain.OpenRouter }, committedAt, lastSpeechAt, isGreeting)
            ?: return
        reply.source = source
        reply.modelMs = modelMs
        reply.historyDone = true
        reply.firstSentenceAt = now()
        SentenceSplitter.splitAll(text).map { GeminiClient.sanitizeForSpeech(it) }.forEach { reply.pipeline.add(it) }
        reply.pipeline.endInput()
    }

    /**
     * Streams the reply from OpenRouter; every completed sentence goes to the pipeline at once.
     * History (last turn = user or the greeting request) is sent as-is.
     */
    private fun startOpenRouterReply(orKey: String, committedAt: Long?, lastSpeechAt: Long?, isGreeting: Boolean) {
        val reply = newReply(Brain.OpenRouter, orKey, committedAt, lastSpeechAt, isGreeting) ?: return
        val nick = nicknameProvider()
        val splitter = SentenceSplitter()
        fun addSentence(raw: String) {
            val s = GeminiClient.sanitizeForSpeech(raw)
            if (s.isBlank()) return
            if (reply.sentencesAdded == 0) {
                val t = now()
                reply.firstSentenceAt = t
                reply.modelMs = t - reply.chatStartedAt
                Log.i(LOG_TAG, "chat first sentence=${reply.modelMs}ms (${s.length} chars)")
                mainHandler.post { if (active === reply) onReplyOrigin(ReplyOrigin.Ai) }
            }
            reply.sentencesAdded++
            reply.pipeline.add(s)
        }
        val request = OpenRouterChatRequest(
            apiKey = orKey,
            systemPrompt = PersonaPrompt.systemInstruction(nick),
            turns = history.toList(),
            onDelta = { delta ->
                if (!reply.cancelled) {
                    reply.streamed.append(delta)
                    splitter.push(delta).forEach { addSentence(it) }
                }
            }
        )
        reply.chat = request
        val firstTokenWatch = Runnable {
            if (reply.streamed.isEmpty() && !reply.cancelled) request.cancel(timeout = true)
        }
        val totalWatch = Runnable { if (!reply.cancelled) request.cancel(timeout = true) }
        mainHandler.postDelayed(firstTokenWatch, OpenRouterClient.CHAT_FIRST_TOKEN_TIMEOUT_MS.toLong())
        mainHandler.postDelayed(totalWatch, OpenRouterClient.CHAT_TOTAL_TIMEOUT_MS.toLong())
        reply.chatStartedAt = now()
        try {
            netExecutor.execute {
                val result = request.execute()
                mainHandler.removeCallbacks(firstTokenWatch)
                mainHandler.removeCallbacks(totalWatch)
                if (!reply.cancelled) {
                    if (result is ChatResult.Success || reply.sentencesAdded > 0) {
                        splitter.flush().forEach { addSentence(it) }
                    }
                    if (reply.sentencesAdded == 0) {
                        // Nothing usable arrived: speak the fixed retry line instead
                        reply.pipeline.add(
                            if (isGreeting) PersonaPrompt.greetingFallback(nick) else PersonaPrompt.RETRY_FALLBACK
                        )
                    }
                    reply.pipeline.endInput()
                }
                mainHandler.post { onChatDone(reply, result) }
            }
        } catch (e: Exception) {
            mainHandler.removeCallbacks(firstTokenWatch)
            mainHandler.removeCallbacks(totalWatch)
            reply.pipeline.add(PersonaPrompt.RETRY_FALLBACK)
            reply.pipeline.endInput()
            onChatDone(reply, ChatResult.Failure("오류(${e.javaClass.simpleName})", 0L))
        }
    }

    /** Main thread: record memory + reply source once the chat stream ended. */
    private fun onChatDone(reply: ActiveReply, result: ChatResult) {
        if (!running.get() || reply.cancelled || reply.historyDone) return
        reply.historyDone = true
        when (result) {
            is ChatResult.Success -> {
                Log.i(
                    LOG_TAG,
                    "chat done total=${result.networkMs}ms firstToken=${result.firstTokenMs ?: "-"}ms " +
                        "model=${result.model ?: OpenRouterClient.CHAT_MODEL}"
                )
                history.add(ChatTurn(ChatTurn.ROLE_MODEL, result.text))
                while (history.size > MAX_HISTORY_TURNS) history.removeAt(0)
                reply.source = ReplySource.Ai
                onReplyOrigin(ReplyOrigin.Ai)
            }
            is ChatResult.Failure -> {
                Log.w(LOG_TAG, "chat failed: ${result.reason} (${result.networkMs}ms, partial=${result.partialText.length} chars)")
                val partial = GeminiClient.sanitizeForSpeech(result.partialText)
                if (reply.sentencesAdded > 0 && partial.isNotBlank()) {
                    history.add(ChatTurn(ChatTurn.ROLE_MODEL, partial))
                    onReplyOrigin(ReplyOrigin.AiFailed(result.reason))
                } else {
                    reply.source = ReplySource.Fallback
                    reply.modelMs = result.networkMs
                    reply.firstSentenceAt = reply.firstSentenceAt ?: now()
                    if (reply.isGreeting) {
                        history.add(ChatTurn(ChatTurn.ROLE_MODEL, PersonaPrompt.greetingFallback(nicknameProvider())))
                    } else {
                        dropTrailingUserTurns()
                    }
                    onReplyOrigin(ReplyOrigin.AiFailed(result.reason))
                }
            }
        }
    }

    // ---------------------------------------------------------------- STT

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
        if (!running.get() || isMuted() || isSpeaking.get() || awaitingReply || active != null) return
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

    /** User speech detected while the reply plays: stop audio at once, cancel pending synthesis. */
    private fun bargeIn(why: String) {
        Log.i(LOG_TAG, "barge-in ($why): audio stopped, pending synthesis cancelled")
        bargeInArmed.set(false)
        cancelActiveReply(recordPartial = true)
        isSpeaking.set(false)
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
        cancelActiveReply(recordPartial = true)
        awaitingReply = true
        stopListeningInternal()
        onPhase(CallPhase.Thinking)
        onPartialText(cleaned)
        val orKey = currentOpenRouterKey()
        val key = currentKey()
        if (orKey == null && key == null) {
            val reply = ReplyGenerator.reply(cleaned, nicknameProvider())
            onReplyOrigin(ReplyOrigin.LocalNoKey)
            startStaticReply(reply, Brain.Local, windowClosedAt, lastSpeechAt, ReplySource.Local, null)
            return
        }
        history.add(ChatTurn(ChatTurn.ROLE_USER, cleaned))
        while (history.size > MAX_HISTORY_TURNS) history.removeAt(0)
        if (orKey != null) {
            startOpenRouterReply(orKey, windowClosedAt, lastSpeechAt, isGreeting = false)
            return
        }
        requestAi(key!!) { result ->
            when (result) {
                is GeminiResult.Success -> {
                    history.add(ChatTurn(ChatTurn.ROLE_MODEL, result.text))
                    onReplyOrigin(ReplyOrigin.Ai)
                    startStaticReply(result.text, Brain.Gemini, windowClosedAt, lastSpeechAt, ReplySource.Ai, result.networkMs)
                }
                is GeminiResult.Failure -> {
                    Log.w(LOG_TAG, "AI reply failed: ${result.reason} (${result.networkMs}ms)")
                    // Drop the unanswered user turn; the user is asked to repeat it.
                    dropTrailingUserTurns()
                    onReplyOrigin(ReplyOrigin.AiFailed(result.reason))
                    startStaticReply(
                        PersonaPrompt.RETRY_FALLBACK, Brain.Gemini, windowClosedAt, lastSpeechAt,
                        ReplySource.Fallback, result.networkMs
                    )
                }
            }
        }
    }

    /**
     * Sends the current in-call [history] to Gemini off the main thread (Gemini-key mode).
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

    companion object {
        private const val TAG = "VoiceCallEngine"
        private const val LOG_TAG = "AICall"
        private const val MAX_HISTORY_TURNS = 24
        private const val BARGE_IN_ARM_DELAY_MS = 450L
        private const val RMS_BARGE_THRESHOLD = 7.5f
        private const val WINDOW_RESTART_DELAY_MS = 100L
    }
}
