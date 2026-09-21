package com.onecall.aivoice.data

import android.content.Context

/**
 * Local SharedPreferences for Stage-1 settings.
 * Stores nickname (how AI addresses the user). Voice is fixed.
 */
class UserPreferences(context: Context) {

    private val prefs = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)

    var nickname: String
        get() = prefs.getString(KEY_NICKNAME, DEFAULT_NICKNAME)?.takeIf { it.isNotBlank() }
            ?: DEFAULT_NICKNAME
        set(value) {
            prefs.edit().putString(KEY_NICKNAME, value.trim().ifBlank { DEFAULT_NICKNAME }).apply()
        }

    /** Fixed Stage-1 voice display name (device default Korean TTS). */
    val fixedVoiceName: String = FIXED_VOICE_NAME

    companion object {
        const val PREFS_NAME = "aivoice_prefs"
        const val KEY_NICKNAME = "nickname"
        const val DEFAULT_NICKNAME = "친구"
        const val FIXED_VOICE_NAME = "기본 한국어 음성"
    }
}
