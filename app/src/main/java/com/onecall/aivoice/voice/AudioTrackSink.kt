package com.onecall.aivoice.voice

import android.media.AudioAttributes
import android.media.AudioFormat
import android.media.AudioTrack
import android.os.Handler
import android.os.SystemClock
import android.util.Log

/**
 * Streams 16-bit PCM to an [AudioTrack] (MODE_STREAM) as chunks arrive.
 * One instance per reply. [stop] (barge-in) pauses + flushes immediately from any thread;
 * the owning pipeline thread releases the track afterwards.
 */
class AudioTrackSink(private val callbackHandler: Handler) : AudioSink {
    private val lock = Any()
    private var track: AudioTrack? = null
    private var rate = OpenRouterClient.DEFAULT_RATE
    private var channels = 1
    private var framesWritten = 0L
    private var bufferFrames = 0
    private var startListener: (() -> Unit)? = null
    private val startFired = java.util.concurrent.atomic.AtomicBoolean(false)

    @Volatile
    private var stopped = false

    override fun setPlaybackStartListener(listener: () -> Unit) {
        startListener = listener
    }

    /** First audible sample: marker callback, or head position > 0 seen while writing. */
    private fun fireStart() {
        if (startFired.compareAndSet(false, true)) startListener?.invoke()
    }

    override fun configure(sampleRate: Int, channels: Int) {
        val changed = track != null && (sampleRate != rate || channels != this.channels)
        if (changed) drain()
        rate = sampleRate
        this.channels = channels
    }

    private fun ensureTrack(): AudioTrack? {
        synchronized(lock) {
            if (stopped) return null
            track?.let { return it }
            val channelMask = if (channels == 2) AudioFormat.CHANNEL_OUT_STEREO else AudioFormat.CHANNEL_OUT_MONO
            val minBuf = AudioTrack.getMinBufferSize(rate, channelMask, AudioFormat.ENCODING_PCM_16BIT)
            // ~250 ms buffer: small enough to start quickly, big enough to ride out jitter
            val bytes = maxOf(minBuf * 2, rate * 2 * channels / 4)
            val t = AudioTrack.Builder()
                .setAudioAttributes(
                    AudioAttributes.Builder()
                        .setUsage(AudioAttributes.USAGE_MEDIA)
                        .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
                        .build()
                )
                .setAudioFormat(
                    AudioFormat.Builder()
                        .setEncoding(AudioFormat.ENCODING_PCM_16BIT)
                        .setSampleRate(rate)
                        .setChannelMask(channelMask)
                        .build()
                )
                .setBufferSizeInBytes(bytes)
                .setTransferMode(AudioTrack.MODE_STREAM)
                .build()
            bufferFrames = bytes / (2 * channels)
            framesWritten = 0
            val listener = startListener
            if (listener != null) {
                t.setPlaybackPositionUpdateListener(object : AudioTrack.OnPlaybackPositionUpdateListener {
                    override fun onMarkerReached(track: AudioTrack?) = fireStart()
                    override fun onPeriodicNotification(track: AudioTrack?) {}
                }, callbackHandler)
                t.notificationMarkerPosition = 1
            }
            t.play()
            track = t
            return t
        }
    }

    override fun write(data: ByteArray, length: Int): Boolean {
        val t = ensureTrack() ?: return false
        var off = 0
        while (off < length) {
            if (stopped) return false
            val n = t.write(data, off, length - off) // blocking
            if (n < 0) {
                Log.w(TAG, "AudioTrack.write error $n")
                return false
            }
            if (n == 0 && stopped) return false
            off += n
        }
        framesWritten += length / (2 * channels)
        if (!startFired.get() && t.playbackHeadPosition > 0) fireStart()
        return !stopped
    }

    /**
     * Waits until all written frames have played. Silence is appended first so a short clip
     * still crosses the track's start threshold. Then the track is released.
     */
    override fun drain() {
        val t = synchronized(lock) { track } ?: return
        val real = framesWritten
        try {
            if (!stopped && real > 0) {
                val pad = ByteArray(bufferFrames * 2 * channels)
                t.write(pad, 0, pad.size)
                val deadline = SystemClock.elapsedRealtime() + real * 1000L / rate + 1500L
                while (!stopped && SystemClock.elapsedRealtime() < deadline) {
                    val head = t.playbackHeadPosition.toLong() and 0xFFFFFFFFL
                    if (head > 0 && !startFired.get()) fireStart()
                    if (head >= real) break
                    Thread.sleep(10)
                }
            }
        } catch (_: InterruptedException) {
            Thread.currentThread().interrupt()
        } catch (e: Exception) {
            Log.w(TAG, "drain failed", e)
        } finally {
            releaseTrack()
        }
    }

    override fun stop() {
        stopped = true
        synchronized(lock) {
            track?.let {
                try {
                    it.pause()
                    it.flush()
                } catch (_: Exception) {
                }
            }
        }
    }

    override fun release() {
        releaseTrack()
    }

    private fun releaseTrack() {
        synchronized(lock) {
            val t = track ?: return
            track = null
            try {
                t.setPlaybackPositionUpdateListener(null)
                if (t.playState != AudioTrack.PLAYSTATE_STOPPED) {
                    t.pause()
                    t.flush()
                }
                t.stop()
            } catch (_: Exception) {
            }
            try {
                t.release()
            } catch (_: Exception) {
            }
        }
    }

    companion object {
        private const val TAG = "AudioTrackSink"
    }
}
