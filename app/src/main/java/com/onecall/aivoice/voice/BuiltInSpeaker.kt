package com.onecall.aivoice.voice

import android.content.Context
import android.speech.tts.TextToSpeech
import android.speech.tts.UtteranceProgressListener
import java.util.Locale
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

/**
 * The phone's built-in Korean TTS as a blocking [FallbackSpeaker]. Used per sentence when
 * OpenRouter TTS fails / times out, and for every sentence when no OpenRouter key is set.
 * Create on the main thread; [speakBlocking] runs on the pipeline thread.
 */
class BuiltInSpeaker(context: Context, private val onInitError: (String) -> Unit) : FallbackSpeaker {
    private class Pending(val onStart: () -> Unit) {
        val done = CountDownLatch(1)

        @Volatile
        var ok = false
    }

    private val ready = CountDownLatch(1)

    @Volatile
    private var ok = false
    private val pending = ConcurrentHashMap<String, Pending>()

    @Volatile
    private var tts: TextToSpeech? = null

    init {
        tts = TextToSpeech(context.applicationContext) { status ->
            val engine = tts
            if (status != TextToSpeech.SUCCESS || engine == null) {
                onInitError("TTS 초기화 실패. 기기 한국어 TTS를 확인해 주세요.")
                ready.countDown()
                return@TextToSpeech
            }
            val result = engine.setLanguage(Locale.KOREAN)
            if (result == TextToSpeech.LANG_MISSING_DATA || result == TextToSpeech.LANG_NOT_SUPPORTED) {
                engine.setLanguage(Locale.forLanguageTag("ko"))
            }
            engine.setSpeechRate(1.0f)
            engine.setPitch(1.0f)
            engine.setOnUtteranceProgressListener(object : UtteranceProgressListener() {
                override fun onStart(utteranceId: String?) {
                    pending[utteranceId ?: return]?.onStart?.invoke()
                }

                override fun onDone(utteranceId: String?) = finish(utteranceId, true)

                @Deprecated("Deprecated in API")
                override fun onError(utteranceId: String?) = finish(utteranceId, false)

                override fun onError(utteranceId: String?, errorCode: Int) = finish(utteranceId, false)

                override fun onStop(utteranceId: String?, interrupted: Boolean) = finish(utteranceId, false)
            })
            ok = true
            ready.countDown()
        }
    }

    private fun finish(id: String?, success: Boolean) {
        val p = pending[id ?: return] ?: return
        p.ok = success
        p.done.countDown()
    }

    override fun speakBlocking(text: String, isCancelled: () -> Boolean, onStart: () -> Unit): Boolean {
        if (!ready.await(INIT_WAIT_MS, TimeUnit.MILLISECONDS) || !ok) return false
        val engine = tts ?: return false
        if (isCancelled()) return false
        val id = UUID.randomUUID().toString()
        val p = Pending(onStart)
        pending[id] = p
        try {
            if (engine.speak(text, TextToSpeech.QUEUE_FLUSH, null, id) != TextToSpeech.SUCCESS) return false
            // Generous cap: ~200 ms per char + 5 s
            p.done.await(5_000L + text.length * 200L, TimeUnit.MILLISECONDS)
            return p.ok && !isCancelled()
        } catch (_: InterruptedException) {
            Thread.currentThread().interrupt()
            return false
        } finally {
            pending.remove(id)
        }
    }

    override fun stop() {
        try {
            tts?.stop()
        } catch (_: Exception) {
        }
        pending.values.forEach { it.done.countDown() }
    }

    fun shutdown() {
        stop()
        try {
            tts?.shutdown()
        } catch (_: Exception) {
        }
        tts = null
    }

    companion object {
        private const val INIT_WAIT_MS = 4_000L
    }
}
