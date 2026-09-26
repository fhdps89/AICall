package com.onecall.aivoice.voice

/**
 * Incremental sentence splitter for streamed AI replies.
 *
 * Text arrives in arbitrary pieces ([push]); every complete sentence is returned as soon as
 * its end is certain, so the first sentence can be synthesized while the rest is still
 * streaming. A sentence ends at `.`, `!`, `?`, `…`, `~` (and full-width variants) followed by
 * whitespace, or at a line break. A terminator at the very end of the buffer is not final yet
 * (it may be "..." or "3.5"), so it waits for the next piece or [flush].
 *
 * Fragments with fewer than [minChars] letters/digits (e.g. "응.") are merged into the next
 * sentence so the TTS never gets a single syllable on its own.
 *
 * Pure Kotlin (unit-tested). Not thread-safe: use one instance per reply from one thread.
 */
class SentenceSplitter(private val minChars: Int = DEFAULT_MIN_CHARS) {
    private val buf = StringBuilder()
    private var carry = ""

    /** Adds streamed text; returns sentences completed by it (trimmed, non-empty). */
    fun push(delta: String): List<String> {
        if (delta.isEmpty()) return emptyList()
        buf.append(delta)
        val out = mutableListOf<String>()
        var start = 0
        var i = 0
        while (i < buf.length) {
            val c = buf[i]
            if (c == '\n' || c == '\r') {
                emit(buf.substring(start, i), out)
                start = i + 1
            } else if (c in TERMINATORS) {
                // Swallow runs like "?!" / "..." / closing quotes
                var j = i + 1
                while (j < buf.length && (buf[j] in TERMINATORS || buf[j] in CLOSERS)) j++
                if (j >= buf.length) break // end unknown yet: wait for more text
                if (buf[j].isWhitespace()) {
                    emit(buf.substring(start, j), out)
                    start = j
                }
                i = j
                continue
            }
            i++
        }
        buf.delete(0, start)
        return out
    }

    /** Ends the stream: returns whatever is left (including a merged short fragment). */
    fun flush(): List<String> {
        val rest = listOf(carry, buf.toString().trim()).filter { it.isNotEmpty() }.joinToString(" ")
        buf.setLength(0)
        carry = ""
        return if (rest.isEmpty()) emptyList() else listOf(rest)
    }

    private fun emit(raw: String, out: MutableList<String>) {
        val s = raw.trim()
        if (s.isEmpty()) return
        val merged = if (carry.isEmpty()) s else "$carry $s"
        if (contentChars(merged) < minChars) {
            carry = merged
            return
        }
        carry = ""
        out.add(merged)
    }

    companion object {
        const val DEFAULT_MIN_CHARS = 2
        private val TERMINATORS = setOf('.', '!', '?', '…', '~', '。', '！', '？')
        private val CLOSERS = setOf('"', '\'', ')', '」', '』', '”', '’')

        private fun contentChars(s: String): Int = s.count { it.isLetterOrDigit() }

        /** Splits a complete text at once. */
        fun splitAll(text: String, minChars: Int = DEFAULT_MIN_CHARS): List<String> {
            val sp = SentenceSplitter(minChars)
            return sp.push(text) + sp.flush()
        }
    }
}
