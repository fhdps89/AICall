package com.onecall.aivoice.voice

import android.content.Context
import android.content.Intent
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.speech.RecognitionListener
import android.speech.RecognizerIntent
import android.speech.SpeechRecognizer
import android.speech.tts.TextToSpeech
import android.speech.tts.UtteranceProgressListener
import android.util.Log
import java.util.Locale
import java.util.UUID
import java.util.concurrent.atomic.AtomicBoolean

/**
 * Stage-1 realtime voice loop:
 * - Korean TTS (device default) + SpeechRecognizer
 * - Greets with nickname, listens, replies
 * - Barge-in: while TTS speaking, restart listening; on partial/final speech stop TTS
 */
class VoiceCallEngine(
    private val context: Context,
    private val nicknameProvider: () -> String,
    private val onPhase: (CallPhase) -> Unit,
    private val onPartialText: (String) -> Unit = {},
    private val onErrorMessage: (String) -> Unit = {},
    private val isMuted: () -> Boolean = { false }
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

    fun start() {
        if (!running.compareAndSet(false, true)) return
        onPhase(CallPhase.Greeting)
        initTts {
            if (!running.get()) return@initTts
            ensureRecognizer()
            val nick = nicknameProvider()
            speak(ReplyGenerator.greeting(nick)) {
                if (running.get() && !isMuted()) startListening()
            }
        }
    }

    fun stop() {
        if (!running.compareAndSet(true, false)) return
        bargeInArmed.set(false)
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
                    mainHandler.post {
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

    private fun speak(text: String, then: (() -> Unit)? = null) {
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

        // For partials during listening (not barge-in), wait for final unless substantial
        if (fromPartial && !wasBargeInContext()) {
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
        stopListeningInternal()
        onPhase(CallPhase.Thinking)
        val nick = nicknameProvider()
        val reply = ReplyGenerator.reply(text, nick)
        speak(reply) {
            if (running.get() && !isMuted()) startListening()
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
                    // Substantial partial → treat as utterance for snappier UX
                    if (best.trim().length >= MIN_PARTIAL_CHARS * 2) {
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
        private const val BARGE_IN_ARM_DELAY_MS = 450L
        private const val RMS_BARGE_THRESHOLD = 7.5f
        private const val MIN_PARTIAL_CHARS = 2
    }
}
