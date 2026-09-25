package com.onecall.aivoice.ui.home

import android.app.Application
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import com.onecall.aivoice.data.UserPreferences
import com.onecall.aivoice.voice.GeminiClient
import com.onecall.aivoice.voice.GeminiResult
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
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
    val apiKeyDraft: String = "",
    /** Gemini model id used for calls, shown in the AI settings row. */
    val modelId: String = GeminiClient.MODEL_ID,
    val keyTestRunning: Boolean = false,
    /** "연결 성공 (모델)" or the failure reason; null before a test. */
    val keyTestResult: String? = null,
    val keyTestOk: Boolean = false
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
                apiKeyDraft = "",
                keyTestResult = null
            )
        }
    }

    fun closeSettings() {
        // A pasted-but-unsaved key used to be silently discarded here (sheet dismissed /
        // "닫기" / big "저장" button) → calls ran without a key. Keep it instead.
        commitApiKeyDraft()
        _ui.update { it.copy(settingsOpen = false, apiKeyEditing = false, apiKeyDraft = "") }
    }

    fun updateNicknameDraft(value: String) {
        _ui.update { it.copy(nickname = value) }
    }

    fun saveNickname() {
        prefs.nickname = _ui.value.nickname
        commitApiKeyDraft()
        _ui.update {
            it.copy(
                nickname = prefs.nickname,
                settingsOpen = false,
                apiKeyEditing = false,
                apiKeyDraft = ""
            )
        }
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

    /** Saves a non-blank key draft (if any) to prefs. */
    private fun commitApiKeyDraft() {
        val draft = _ui.value.apiKeyDraft
        if (UserPreferences.cleanApiKey(draft).isNotEmpty()) {
            prefs.geminiApiKey = draft
            _ui.update { it.copy(maskedApiKey = UserPreferences.maskKey(prefs.geminiApiKey)) }
        }
    }

    fun saveApiKey() {
        commitApiKeyDraft()
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
        _ui.update {
            it.copy(maskedApiKey = "", apiKeyEditing = false, apiKeyDraft = "", keyTestResult = null)
        }
    }

    /**
     * Sends a tiny request with the key being edited (if any) or the saved key and shows
     * "연결 성공 (모델)" or the failure reason. A typed draft is saved first.
     */
    fun testApiKey() {
        if (_ui.value.keyTestRunning) return
        commitApiKeyDraft()
        val key = prefs.geminiApiKey
        if (key == null) {
            _ui.update { it.copy(keyTestResult = "키가 저장되지 않았어요", keyTestOk = false) }
            return
        }
        _ui.update {
            it.copy(
                keyTestRunning = true,
                keyTestResult = "테스트 중…",
                keyTestOk = false,
                apiKeyEditing = false,
                apiKeyDraft = ""
            )
        }
        viewModelScope.launch {
            val result = withContext(Dispatchers.IO) { GeminiClient.testKey(key) }
            val (text, ok) = when (result) {
                is GeminiResult.Success -> GeminiClient.keyTestSuccessLabel(result.modelVersion) to true
                is GeminiResult.Failure -> result.reason to false
            }
            _ui.update { it.copy(keyTestRunning = false, keyTestResult = text, keyTestOk = ok) }
        }
    }
}
