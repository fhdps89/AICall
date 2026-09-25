package com.onecall.aivoice.voice

/**
 * End-of-turn wait (pure Kotlin, time injected for tests).
 *
 * After a final STT result the user may only be pausing. Each final segment is
 * appended and a [windowMs] silence window (re)starts. Any sign of new speech
 * (partial result, beginning of speech, loud RMS) pushes the deadline out again.
 * Only when the deadline passes with no new speech is the joined text taken as the
 * user's turn. If a partial was heard but its final never arrived before the
 * deadline, the partial text is included so nothing the user said is lost.
 */
class UtteranceWindow(val windowMs: Long = DEFAULT_WINDOW_MS) {
    private val segments = mutableListOf<String>()
    private var pendingPartial: String? = null

    /** Absolute time (ms) when the turn ends if no new speech arrives; null if empty. */
    var deadline: Long? = null
        private set

    /** Time of the most recent final segment (for "including window" latency logs). */
    var lastFinalAt: Long? = null
        private set

    val hasContent: Boolean get() = segments.isNotEmpty()

    /** A final STT result arrived. Blank text is treated as silence. */
    fun onFinal(text: String, now: Long) {
        val t = text.trim()
        pendingPartial = null
        if (t.isNotEmpty()) {
            segments.add(t)
            lastFinalAt = now
        }
        if (segments.isNotEmpty()) extendTo(now + windowMs)
    }

    /** A partial STT result arrived (user is speaking again). Only matters inside a window. */
    fun onPartial(text: String, now: Long) {
        if (segments.isEmpty()) return
        val t = text.trim()
        if (t.isNotEmpty()) pendingPartial = t
        extendTo(now + windowMs)
    }

    /** Beginning-of-speech / loud RMS inside a window: keep waiting. */
    fun onActivity(now: Long) {
        if (segments.isEmpty()) return
        extendTo(now + windowMs)
    }

    /** True when the silence window has elapsed and there is text to send. */
    fun isDue(now: Long): Boolean {
        val d = deadline ?: return false
        return segments.isNotEmpty() && now >= d
    }

    /** Text shown while accumulating: finals so far + current partial. */
    fun displayText(partial: String? = pendingPartial): String =
        (segments + listOfNotNull(partial?.trim()?.takeIf { it.isNotEmpty() })).joinToString(" ")

    /** Returns the joined turn text and resets. */
    fun take(): String {
        val text = displayText(pendingPartial)
        reset()
        return text
    }

    fun reset() {
        segments.clear()
        pendingPartial = null
        deadline = null
        lastFinalAt = null
    }

    private fun extendTo(t: Long) {
        val d = deadline
        deadline = if (d == null || t > d) t else d
    }

    companion object {
        const val DEFAULT_WINDOW_MS = 1_500L
    }
}
