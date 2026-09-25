package com.onecall.aivoice.ui.home

import android.app.Application
import androidx.lifecycle.AndroidViewModel
import com.onecall.aivoice.data.UserPreferences
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update

data class HomeUiState(
    val voiceName: String = UserPreferences.FIXED_VOICE_NAME,
    val nickname: String = UserPreferences.DEFAULT_NICKNAME,
    val settingsOpen: Boolean = false,
    /** Masked Gemini key for display; empty when not set. */
    val maskedApiKey: String = "",
    val apiKeyEditing: Boolean = false,
    val apiKeyDraft: String = ""
)

class HomeViewModel(application: Application) : AndroidViewModel(application) {
    private val prefs = UserPreferences(application)

    private val _ui = MutableStateFlow(
        HomeUiState(
            voiceName = prefs.fixedVoiceName,
            nickname = prefs.nickname,
            maskedApiKey = UserPreferences.maskKey(prefs.geminiApiKey)
        )
    )
    val ui: StateFlow<HomeUiState> = _ui.asStateFlow()

    fun openSettings() {
        _ui.update {
            it.copy(
                settingsOpen = true,
                nickname = prefs.nickname,
                maskedApiKey = UserPreferences.maskKey(prefs.geminiApiKey),
                apiKeyEditing = false,
                apiKeyDraft = ""
            )
        }
    }

    fun closeSettings() {
        _ui.update { it.copy(settingsOpen = false, apiKeyEditing = false, apiKeyDraft = "") }
    }

    fun updateNicknameDraft(value: String) {
        _ui.update { it.copy(nickname = value) }
    }

    fun saveNickname() {
        prefs.nickname = _ui.value.nickname
        _ui.update { it.copy(nickname = prefs.nickname, settingsOpen = false) }
    }

    fun startApiKeyEdit() {
        _ui.update { it.copy(apiKeyEditing = true, apiKeyDraft = "") }
    }

    fun updateApiKeyDraft(value: String) {
        _ui.update { it.copy(apiKeyDraft = value) }
    }

    fun cancelApiKeyEdit() {
        _ui.update { it.copy(apiKeyEditing = false, apiKeyDraft = "") }
    }

    fun saveApiKey() {
        val draft = _ui.value.apiKeyDraft
        if (draft.isNotBlank()) prefs.geminiApiKey = draft
        _ui.update {
            it.copy(
                maskedApiKey = UserPreferences.maskKey(prefs.geminiApiKey),
                apiKeyEditing = false,
                apiKeyDraft = ""
            )
        }
    }

    fun clearApiKey() {
        prefs.geminiApiKey = null
        _ui.update { it.copy(maskedApiKey = "", apiKeyEditing = false, apiKeyDraft = "") }
    }
}
