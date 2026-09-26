package com.onecall.aivoice.voice

import java.util.concurrent.atomic.AtomicBoolean

/** Events of one streamed TTS synthesis (one sentence). */
sealed class SynthEvent {
    /** PCM format of the following chunks (16-bit little-endian). */
    data class Format(val sampleRate: Int, val channels: Int) : SynthEvent()

    /** Raw PCM bytes (frame-aligned). */
    class Chunk(val data: ByteArray, val length: Int = data.size) : SynthEvent()

    object Done : SynthEvent()

    /** Synthesis failed; [reason] is a short Korean label (never contains a key). */
    data class Failed(val reason: String) : SynthEvent()
}

/** A running synthesis. Events arrive on a background thread; [poll] blocks. */
interface SynthJob {
    /** Next event, or null if none arrived within [timeoutMs]. */
    fun poll(timeoutMs: Long): SynthEvent?
    fun cancel()
}

/** Remote TTS: [start] must return immediately (work runs in the background). */
interface SpeechSynth {
    fun start(text: String): SynthJob
}

/** PCM output (AudioTrack on the phone, a fake in tests). One instance per reply. */
interface AudioSink {
    /** Called once by the pipeline; invoked when the first sample is actually audible. */
    fun setPlaybackStartListener(listener: () -> Unit)
    fun configure(sampleRate: Int, channels: Int)

    /** Blocking write; false once the sink has been stopped. */
    fun write(data: ByteArray, length: Int): Boolean

    /** Blocks until everything written so far has played (or the sink is stopped). */
    fun drain()

    /** Immediate stop (barge-in): drops buffered audio. Callable from any thread. */
    fun stop()
    fun release()
}

/** The phone's built-in TTS, used when remote TTS fails (or no OpenRouter key). */
interface FallbackSpeaker {
    /** Speaks [text], blocking until finished. [onStart] fires when audio starts. */
    fun speakBlocking(text: String, isCancelled: () -> Boolean, onStart: () -> Unit): Boolean
    fun stop()
}

/**
 * What to do after a remote TTS attempt for one sentence. Pure (unit-tested).
 * - cancelled (barge-in) → [Stop]
 * - success, or failure after some audio already played → [Continue] (never repeat audio)
 * - failure/timeout before any audio → [BuiltIn] for this sentence, so the call never stalls
 */
object TtsFallback {
    sealed class Decision {
        object Continue : Decision()
        object Stop : Decision()
        data class BuiltIn(val reason: String) : Decision()
    }

    fun decide(gotAudio: Boolean, failure: String?, cancelled: Boolean): Decision = when {
        cancelled -> Decision.Stop
        failure == null -> Decision.Continue
        gotAudio -> Decision.Continue
        else -> Decision.BuiltIn(failure)
    }

    /** Call-screen label, e.g. "음성 실패: 시간 초과 → 기본 음성". */
    fun label(reason: String): String = "음성 실패: $reason → 기본 음성"
}

/**
 * Plays one AI reply sentence by sentence.
 *
 * - Sentences are [add]ed as soon as they are known (while the chat reply still streams).
 * - Remote synthesis of sentence i+[lookahead] is started while sentence i plays (prefetch);
 *   playback order always follows the order of [add].
 * - Audio chunks are written to the [sink] as they arrive (progressive playback).
 * - If a sentence's synthesis fails or yields no audio within [firstChunkTimeoutMs] (from its
 *   request start), that sentence is spoken with the [fallback] (built-in TTS).
 * - [cancel] (barge-in) stops audio at once and cancels all pending synthesis.
 * - With [synth] == null every sentence uses the built-in TTS.
 *
 * Runs on its own thread; [Listener] callbacks come from background threads.
 */
class SpeechPipeline(
    private val synth: SpeechSynth?,
    private val sink: AudioSink,
    private val fallback: FallbackSpeaker,
    private val listener: Listener,
    private val firstChunkTimeoutMs: Long = DEFAULT_FIRST_CHUNK_TIMEOUT_MS,
    private val chunkGapTimeoutMs: Long = DEFAULT_CHUNK_GAP_TIMEOUT_MS,
    private val lookahead: Int = 1,
    private val clock: () -> Long = { System.nanoTime() / 1_000_000L }
) {
    interface Listener {
        /** First audible sample of this reply ([remote] false = built-in TTS). */
        fun onFirstSound(atMs: Long, remote: Boolean) {}
        fun onSynthStarted(index: Int, text: String) {}
        fun onSentencePlaying(index: Int, remote: Boolean) {}

        /** Remote TTS timing for one sentence (ms since its request started). */
        fun onTtsTiming(index: Int, firstAudioMs: Long?, totalMs: Long) {}
        fun onFallback(index: Int, reason: String) {}
        fun onFinished(cancelled: Boolean) {}
    }

    private class Started(val job: SynthJob, val startedAt: Long)
    private class Outcome(val gotAudio: Boolean, val failure: String?)

    private val lock = Object()
    private val sentences = ArrayList<String>()
    private val jobs = HashMap<Int, Started>()
    private var inputEnded = false
    private var current = 0

    @Volatile
    private var cancelled = false
    private val firstSound = AtomicBoolean(false)
    private val started = AtomicBoolean(false)
    private var thread: Thread? = null

    val isCancelled: Boolean get() = cancelled

    init {
        sink.setPlaybackStartListener { reportFirstSound(remote = true) }
    }

    fun add(sentence: String) {
        val s = sentence.trim()
        if (s.isEmpty()) return
        synchronized(lock) {
            if (cancelled || inputEnded) return
            sentences.add(s)
            startDueJobsLocked()
            lock.notifyAll()
        }
    }

    fun endInput() {
        synchronized(lock) {
            inputEnded = true
            lock.notifyAll()
        }
    }

    fun start() {
        if (!started.compareAndSet(false, true)) return
        thread = Thread({ run() }, "speech-pipeline").also { it.start() }
    }

    fun cancel() {
        val toCancel: List<SynthJob>
        synchronized(lock) {
            if (cancelled) return
            cancelled = true
            toCancel = jobs.values.map { it.job }
            lock.notifyAll()
        }
        toCancel.forEach { runCatching { it.cancel() } }
        runCatching { sink.stop() }
        runCatching { fallback.stop() }
        thread?.interrupt()
    }

    /** Blocks until the pipeline thread ends (tests). */
    fun join(timeoutMs: Long) {
        thread?.join(timeoutMs)
    }

    private fun startDueJobsLocked() {
        val s = synth ?: return
        val last = minOf(current + lookahead, sentences.size - 1)
        for (i in current..last) {
            if (jobs.containsKey(i)) continue
            jobs[i] = Started(s.start(sentences[i]), clock())
            listener.onSynthStarted(i, sentences[i])
        }
    }

    private fun reportFirstSound(remote: Boolean) {
        if (cancelled) return
        if (firstSound.compareAndSet(false, true)) listener.onFirstSound(clock(), remote)
    }

    private fun run() {
        try {
            var i = 0
            while (true) {
                val text: String
                val job: Started?
                synchronized(lock) {
                    while (!cancelled && i >= sentences.size && !inputEnded) lock.wait()
                    if (cancelled || i >= sentences.size) return
                    current = i
                    startDueJobsLocked()
                    text = sentences[i]
                    job = jobs[i]
                }
                if (job == null) {
                    speakBuiltIn(i, text)
                } else {
                    listener.onSentencePlaying(i, true)
                    val outcome = playRemote(i, job)
                    when (val d = TtsFallback.decide(outcome.gotAudio, outcome.failure, cancelled)) {
                        TtsFallback.Decision.Stop -> return
                        TtsFallback.Decision.Continue -> Unit
                        is TtsFallback.Decision.BuiltIn -> {
                            listener.onFallback(i, d.reason)
                            speakBuiltIn(i, text)
                        }
                    }
                }
                if (cancelled) return
                i++
            }
        } catch (_: InterruptedException) {
        } finally {
            if (!cancelled) runCatching { sink.drain() }
            runCatching { sink.release() }
            listener.onFinished(cancelled)
        }
    }

    private fun speakBuiltIn(i: Int, text: String) {
        if (cancelled) return
        sink.drain() // remote audio of earlier sentences finishes first
        if (cancelled) return
        listener.onSentencePlaying(i, false)
        fallback.speakBlocking(text, { cancelled }) { reportFirstSound(remote = false) }
    }

    private fun playRemote(i: Int, s: Started): Outcome {
        var gotAudio = false
        var firstAudioAt: Long? = null
        while (!cancelled) {
            val wait = if (gotAudio) chunkGapTimeoutMs else s.startedAt + firstChunkTimeoutMs - clock()
            if (wait <= 0) {
                s.job.cancel()
                return Outcome(false, TIMEOUT)
            }
            when (val ev = s.job.poll(wait)) {
                null -> if (gotAudio) {
                    s.job.cancel()
                    return Outcome(true, "$TIMEOUT(중간)")
                }
                is SynthEvent.Format -> sink.configure(ev.sampleRate, ev.channels)
                is SynthEvent.Chunk -> {
                    if (ev.length <= 0) continue
                    if (!gotAudio) {
                        gotAudio = true
                        firstAudioAt = clock()
                    }
                    if (!sink.write(ev.data, ev.length)) return Outcome(true, null)
                }
                SynthEvent.Done -> {
                    listener.onTtsTiming(i, firstAudioAt?.let { it - s.startedAt }, clock() - s.startedAt)
                    return Outcome(gotAudio, if (gotAudio) null else EMPTY)
                }
                is SynthEvent.Failed -> {
                    listener.onTtsTiming(i, firstAudioAt?.let { it - s.startedAt }, clock() - s.startedAt)
                    return Outcome(gotAudio, ev.reason)
                }
            }
        }
        return Outcome(gotAudio, null)
    }

    companion object {
        /** Max wait for the first audio of a sentence (from its request start). */
        const val DEFAULT_FIRST_CHUNK_TIMEOUT_MS = 6_000L
        const val DEFAULT_CHUNK_GAP_TIMEOUT_MS = 6_000L
        const val TIMEOUT = "시간 초과"
        const val EMPTY = "빈 음성"
    }
}
