package com.onecall.aivoice

import com.onecall.aivoice.voice.AudioSink
import com.onecall.aivoice.voice.FallbackSpeaker
import com.onecall.aivoice.voice.SpeechPipeline
import com.onecall.aivoice.voice.SpeechSynth
import com.onecall.aivoice.voice.SynthEvent
import com.onecall.aivoice.voice.SynthJob
import com.onecall.aivoice.voice.TtsFallback
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.util.Collections
import java.util.concurrent.CountDownLatch
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.TimeUnit

class SpeechPipelineTest {

    /** Log of everything that happened, in order (thread-safe). */
    private val log = Collections.synchronizedList(mutableListOf<String>())

    private inner class FakeJob(val text: String) : SynthJob {
        val q = LinkedBlockingQueue<SynthEvent>()
        @Volatile var cancelled = false
        fun succeed() {
            q.put(SynthEvent.Format(24000, 1))
            q.put(SynthEvent.Chunk(text.toByteArray()))
            q.put(SynthEvent.Done)
        }
        fun fail(reason: String) = q.put(SynthEvent.Failed(reason))
        override fun poll(timeoutMs: Long): SynthEvent? = q.poll(timeoutMs, TimeUnit.MILLISECONDS)
        override fun cancel() {
            cancelled = true
            log.add("cancel:$text")
        }
    }

    private inner class FakeSynth(val auto: Boolean = false) : SpeechSynth {
        val jobs = Collections.synchronizedMap(LinkedHashMap<String, FakeJob>())
        override fun start(text: String): SynthJob {
            log.add("synth:$text")
            val job = FakeJob(text)
            jobs[text] = job
            if (auto) job.succeed()
            return job
        }
    }

    private inner class FakeSink : AudioSink {
        private var onStart: (() -> Unit)? = null
        @Volatile var stopped = false
        override fun setPlaybackStartListener(listener: () -> Unit) { onStart = listener }
        override fun configure(sampleRate: Int, channels: Int) {}
        override fun write(data: ByteArray, length: Int): Boolean {
            if (stopped) return false
            log.add("play:" + String(data, 0, length))
            onStart?.invoke()
            return true
        }
        override fun drain() {}
        override fun stop() { stopped = true; log.add("sink-stop") }
        override fun release() {}
    }

    private inner class FakeFallback : FallbackSpeaker {
        override fun speakBlocking(text: String, isCancelled: () -> Boolean, onStart: () -> Unit): Boolean {
            if (isCancelled()) return false
            onStart()
            log.add("builtin:$text")
            return true
        }
        override fun stop() { log.add("builtin-stop") }
    }

    private inner class Recorder : SpeechPipeline.Listener {
        val finished = CountDownLatch(1)
        @Volatile var cancelled: Boolean? = null
        val fallbacks = Collections.synchronizedList(mutableListOf<String>())
        val firstSounds = Collections.synchronizedList(mutableListOf<Boolean>())
        override fun onFirstSound(atMs: Long, remote: Boolean) { firstSounds.add(remote) }
        override fun onFallback(index: Int, reason: String) { fallbacks.add("$index:$reason") }
        override fun onFinished(cancelled: Boolean) { this.cancelled = cancelled; finished.countDown() }
    }

    @Test
    fun playsInInputOrderEvenWhenLaterSentenceIsReadyFirst() {
        val synth = FakeSynth()
        val rec = Recorder()
        val p = SpeechPipeline(synth, FakeSink(), FakeFallback(), rec)
        p.start()
        p.add("하나.")
        p.add("둘.")
        p.add("셋.")
        p.endInput()
        Thread.sleep(50)
        // Sentence 2 finishes synthesis before sentence 1
        synth.jobs["둘."]!!.succeed()
        Thread.sleep(50)
        assertFalse(log.contains("play:둘."))
        synth.jobs["하나."]!!.succeed()
        Thread.sleep(100)
        synth.jobs["셋."]!!.succeed()
        assertTrue(rec.finished.await(2, TimeUnit.SECONDS))
        assertEquals(listOf("play:하나.", "play:둘.", "play:셋."), log.filter { it.startsWith("play:") })
        assertEquals(false, rec.cancelled)
        assertEquals(listOf(true), rec.firstSounds)
    }

    @Test
    fun prefetchesOnlyTheNextSentenceWhileCurrentPlays() {
        val synth = FakeSynth()
        val rec = Recorder()
        val p = SpeechPipeline(synth, FakeSink(), FakeFallback(), rec)
        p.start()
        p.add("하나.")
        p.add("둘.")
        p.add("셋.")
        Thread.sleep(50)
        // Lookahead 1: sentence 1 + prefetch of sentence 2, sentence 3 not yet
        assertEquals(listOf("synth:하나.", "synth:둘."), log.filter { it.startsWith("synth:") })
        synth.jobs["하나."]!!.succeed()
        Thread.sleep(50)
        // Sentence 1 played → now at sentence 2 → sentence 3 prefetched
        assertEquals(listOf("synth:하나.", "synth:둘.", "synth:셋."), log.filter { it.startsWith("synth:") })
        assertTrue(log.indexOf("synth:둘.") < log.indexOf("play:하나."))
        synth.jobs["둘."]!!.succeed()
        synth.jobs["셋."]!!.succeed()
        p.endInput()
        assertTrue(rec.finished.await(2, TimeUnit.SECONDS))
    }

    @Test
    fun failedSentenceFallsBackToBuiltInAndCallContinues() {
        val synth = FakeSynth()
        val rec = Recorder()
        val p = SpeechPipeline(synth, FakeSink(), FakeFallback(), rec)
        p.start()
        p.add("하나.")
        p.add("둘.")
        p.endInput()
        Thread.sleep(50)
        synth.jobs["하나."]!!.fail("키 오류(401)")
        synth.jobs["둘."]!!.succeed()
        assertTrue(rec.finished.await(2, TimeUnit.SECONDS))
        assertEquals(listOf("builtin:하나.", "play:둘."), log.filter { it.startsWith("builtin:") || it.startsWith("play:") })
        assertEquals(listOf("0:키 오류(401)"), rec.fallbacks)
        assertEquals(listOf(false), rec.firstSounds) // first sound came from the built-in TTS
    }

    @Test
    fun firstChunkTimeoutFallsBackToBuiltIn() {
        val synth = FakeSynth()
        val rec = Recorder()
        val p = SpeechPipeline(synth, FakeSink(), FakeFallback(), rec, firstChunkTimeoutMs = 150)
        p.start()
        p.add("느린 문장.")
        p.endInput()
        assertTrue(rec.finished.await(2, TimeUnit.SECONDS))
        assertEquals(listOf("0:${SpeechPipeline.TIMEOUT}"), rec.fallbacks)
        assertTrue(log.contains("cancel:느린 문장."))
        assertTrue(log.contains("builtin:느린 문장."))
    }

    @Test
    fun cancelStopsAudioAndCancelsPendingSynthesis() {
        val synth = FakeSynth()
        val rec = Recorder()
        val sink = FakeSink()
        val p = SpeechPipeline(synth, sink, FakeFallback(), rec)
        p.start()
        p.add("하나.")
        p.add("둘.")
        Thread.sleep(50)
        synth.jobs["하나."]!!.succeed()
        Thread.sleep(50)
        p.cancel() // barge-in while sentence 2 is still being synthesized
        assertTrue(rec.finished.await(2, TimeUnit.SECONDS))
        assertEquals(true, rec.cancelled)
        assertTrue(sink.stopped)
        assertTrue(synth.jobs["둘."]!!.cancelled)
        assertTrue(log.contains("builtin-stop"))
        p.add("셋.") // ignored after cancel
        Thread.sleep(30)
        assertFalse(log.contains("synth:셋."))
        assertFalse(log.contains("play:둘."))
    }

    @Test
    fun withoutRemoteSynthEverySentenceUsesBuiltIn() {
        val rec = Recorder()
        val p = SpeechPipeline(null, FakeSink(), FakeFallback(), rec)
        p.start()
        p.add("하나.")
        p.add("둘.")
        p.endInput()
        assertTrue(rec.finished.await(2, TimeUnit.SECONDS))
        assertEquals(listOf("builtin:하나.", "builtin:둘."), log.filter { it.startsWith("builtin:") })
        assertTrue(rec.fallbacks.isEmpty())
    }

    @Test
    fun fallbackDecision() {
        assertEquals(TtsFallback.Decision.Continue, TtsFallback.decide(true, null, false))
        assertEquals(TtsFallback.Decision.Stop, TtsFallback.decide(false, "시간 초과", true))
        assertEquals(TtsFallback.Decision.Stop, TtsFallback.decide(true, null, true))
        assertEquals(TtsFallback.Decision.BuiltIn("시간 초과"), TtsFallback.decide(false, "시간 초과", false))
        assertEquals(TtsFallback.Decision.BuiltIn("키 오류(401)"), TtsFallback.decide(false, "키 오류(401)", false))
        // Audio already played: never repeat the sentence with the built-in voice
        assertEquals(TtsFallback.Decision.Continue, TtsFallback.decide(true, "시간 초과(중간)", false))
        assertEquals("음성 실패: 시간 초과 → 기본 음성", TtsFallback.label("시간 초과"))
    }
}
