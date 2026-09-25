package com.onecall.aivoice.data

import android.content.Context

/**
 * Local SharedPreferences for Stage-1 settings.
 * Stores nickname (how AI addresses the user). Voice is fixed.
 * Also stores the user-pasted Gemini API key on-device only (this prefs file is
 * excluded from backup; the key is never bundled in the repo or APK).
 */
class UserPreferences(context: Context) {

    private val prefs = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)

    var nickname: String
        get() = prefs.getString(KEY_NICKNAME, DEFAULT_NICKNAME)?.takeIf { it.isNotBlank() }
            ?: DEFAULT_NICKNAME
        set(value) {
            prefs.edit().putString(KEY_NICKNAME, value.trim().ifBlank { DEFAULT_NICKNAME }).apply()
        }

    /**
     * Gemini API key pasted by the user in settings. Null when not set.
     * Read fresh from SharedPreferences on every access (no caching). Saved with commit()
     * so it is on disk before the next call starts.
     */
    var geminiApiKey: String?
        get() = cleanApiKey(prefs.getString(KEY_GEMINI_API_KEY, null)).ifEmpty { null }
        set(value) {
            val cleaned = cleanApiKey(value)
            if (cleaned.isEmpty()) {
                prefs.edit().remove(KEY_GEMINI_API_KEY).commit()
            } else {
                prefs.edit().putString(KEY_GEMINI_API_KEY, cleaned).commit()
            }
        }

    /** Fixed Stage-1 voice display name (device default Korean TTS). */
    val fixedVoiceName: String = FIXED_VOICE_NAME

    companion object {
        const val PREFS_NAME = "aivoice_prefs"
        const val KEY_NICKNAME = "nickname"
        const val KEY_GEMINI_API_KEY = "gemini_api_key"
        const val DEFAULT_NICKNAME = "친구"
        const val FIXED_VOICE_NAME = "기본 한국어 음성"

        private val QUOTE_CHARS = setOf('"', '\'', '`', '\u201C', '\u201D', '\u2018', '\u2019')

        /**
         * Cleans a pasted key: drops whitespace/newlines, invisible format characters
         * (zero-width space, BOM, ...), control characters and quote marks.
         */
        fun cleanApiKey(raw: String?): String {
            if (raw == null) return ""
            val sb = StringBuilder()
            for (ch in raw) {
                if (ch.isWhitespace() || ch.isISOControl() || ch in QUOTE_CHARS) continue
                if (Character.getType(ch) == Character.FORMAT.toInt()) continue
                sb.append(ch)
            }
            return sb.toString()
        }

        /** Masked display, e.g. "abcd••••••••wxyz". */
        fun maskKey(key: String?): String {
            if (key.isNullOrBlank()) return ""
            if (key.length <= 8) return "•".repeat(key.length)
            return key.take(4) + "••••••••" + key.takeLast(4)
        }
    }
}
