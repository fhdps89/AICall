package com.onecall.aivoice.ui.home

import android.app.Application
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import com.onecall.aivoice.data.UserPreferences
import com.onecall.aivoice.voice.GeminiClient
import com.onecall.aivoice.voice.GeminiResult
import com.onecall.aivoice.voice.OpenRouterClient
import com.onecall.aivoice.voice.TtsVoice
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.async
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update

/** Which on-device key a settings action refers to. */
enum class KeyKind { OpenRouter, Gemini }

/** UI state of one key row (masked value, paste field, key test). */
data class KeyUi(
    /** Masked key for display; empty when not set. */
    val masked: String = "",
    val editing: Boolean = false,
    val draft: String = "",
    val testRunning: Boolean = false,
    /** Success label or failure reason(s); null before a test. */
    val testResult: String? = null,
    val testOk: Boolean = false
)

data class HomeUiState(
    val voiceName: String = UserPreferences.FIXED_VOICE_NAME,
    val nickname: String = UserPreferences.DEFAULT_NICKNAME,
    val settingsOpen: Boolean = false,
    val openRouter: KeyUi = KeyUi(),
    val gemini: KeyUi = KeyUi(),
    val selectedVoice: TtsVoice = TtsVoice.DEFAULT,
    /** Chat model used with the OpenRouter key. */
    val openRouterModel: String = OpenRouterClient.CHAT_MODEL,
    /** Gemini model id used with the fallback Gemini key. */
    val modelId: String = GeminiClient.MODEL_ID
) {
    fun key(kind: KeyKind): KeyUi = if (kind == KeyKind.OpenRouter) openRouter else gemini
}

class HomeViewModel(application: Application) : AndroidViewModel(application) {
    private val prefs = UserPreferences(application)

    private val _ui = MutableStateFlow(
        HomeUiState(
            voiceName = prefs.voiceDisplayName,
            nickname = prefs.nickname,
            openRouter = KeyUi(masked = UserPreferences.maskKey(prefs.openRouterApiKey)),
            gemini = KeyUi(masked = UserPreferences.maskKey(prefs.geminiApiKey)),
            selectedVoice = prefs.ttsVoice
        )
    )
    val ui: StateFlow<HomeUiState> = _ui.asStateFlow()

    private fun savedKey(kind: KeyKind): String? =
        if (kind == KeyKind.OpenRouter) prefs.openRouterApiKey else prefs.geminiApiKey

    private fun storeKey(kind: KeyKind, value: String?) {
        if (kind == KeyKind.OpenRouter) prefs.openRouterApiKey = value else prefs.geminiApiKey = value
    }

    private fun updateKey(kind: KeyKind, f: (KeyUi) -> KeyUi) {
        _ui.update {
            if (kind == KeyKind.OpenRouter) it.copy(openRouter = f(it.openRouter))
            else it.copy(gemini = f(it.gemini))
        }
    }

    private fun refreshVoiceName() {
        _ui.update { it.copy(voiceName = prefs.voiceDisplayName, selectedVoice = prefs.ttsVoice) }
    }

    fun openSettings() {
        _ui.update {
            it.copy(
                settingsOpen = true,
                nickname = prefs.nickname,
                openRouter = KeyUi(masked = UserPreferences.maskKey(prefs.openRouterApiKey)),
                gemini = KeyUi(masked = UserPreferences.maskKey(prefs.geminiApiKey)),
                selectedVoice = prefs.ttsVoice
            )
        }
    }

    fun closeSettings() {
        // A pasted-but-unsaved key is kept (sheet dismissed / "닫기" / big "저장" button).
        commitAllDrafts()
        _ui.update {
            it.copy(
                settingsOpen = false,
                openRouter = it.openRouter.copy(editing = false, draft = ""),
                gemini = it.gemini.copy(editing = false, draft = "")
            )
        }
    }

    fun updateNicknameDraft(value: String) {
        _ui.update { it.copy(nickname = value) }
    }

    fun saveNickname() {
        prefs.nickname = _ui.value.nickname
        commitAllDrafts()
        _ui.update {
            it.copy(
                nickname = prefs.nickname,
                settingsOpen = false,
                openRouter = it.openRouter.copy(editing = false, draft = ""),
                gemini = it.gemini.copy(editing = false, draft = "")
            )
        }
    }

    fun selectVoice(voice: TtsVoice) {
        prefs.ttsVoice = voice
        refreshVoiceName()
        updateKey(KeyKind.OpenRouter) { it.copy(testResult = null) }
    }

    fun startApiKeyEdit(kind: KeyKind) {
        updateKey(kind) { it.copy(editing = true, draft = "") }
    }

    fun updateApiKeyDraft(kind: KeyKind, value: String) {
        updateKey(kind) { it.copy(draft = value) }
    }

    fun cancelApiKeyEdit(kind: KeyKind) {
        updateKey(kind) { it.copy(editing = false, draft = "") }
    }

    private fun commitAllDrafts() {
        commitApiKeyDraft(KeyKind.OpenRouter)
        commitApiKeyDraft(KeyKind.Gemini)
    }

    /** Saves a non-blank key draft (if any) to prefs (cleaned: whitespace/invisible/quotes). */
    private fun commitApiKeyDraft(kind: KeyKind) {
        val draft = _ui.value.key(kind).draft
        if (UserPreferences.cleanApiKey(draft).isNotEmpty()) {
            storeKey(kind, draft)
            updateKey(kind) { it.copy(masked = UserPreferences.maskKey(savedKey(kind))) }
            refreshVoiceName()
        }
    }

    fun saveApiKey(kind: KeyKind) {
        commitApiKeyDraft(kind)
        updateKey(kind) {
            it.copy(masked = UserPreferences.maskKey(savedKey(kind)), editing = false, draft = "")
        }
    }

    fun clearApiKey(kind: KeyKind) {
        storeKey(kind, null)
        updateKey(kind) { KeyUi() }
        refreshVoiceName()
    }

    /**
     * Tests the typed draft (saved first) or the saved key.
     * OpenRouter: chat + TTS (selected voice) in parallel; Gemini: one tiny request.
     */
    fun testApiKey(kind: KeyKind) {
        if (_ui.value.key(kind).testRunning) return
        commitApiKeyDraft(kind)
        val key = savedKey(kind)
        if (key == null) {
            updateKey(kind) { it.copy(testResult = "키가 저장되지 않았어요", testOk = false) }
            return
        }
        updateKey(kind) {
            it.copy(testRunning = true, testResult = "테스트 중…", testOk = false, editing = false, draft = "")
        }
        viewModelScope.launch {
            val (text, ok) = if (kind == KeyKind.OpenRouter) {
                val voice = prefs.ttsVoice
                withContext(Dispatchers.IO) {
                    val chat = async { OpenRouterClient.testChat(key) }
                    val tts = async { OpenRouterClient.testTts(key, voice) }
                    OpenRouterClient.keyTestLabel(chat.await(), tts.await(), voice)
                }
            } else {
                when (val result = withContext(Dispatchers.IO) { GeminiClient.testKey(key) }) {
                    is GeminiResult.Success -> GeminiClient.keyTestSuccessLabel(result.modelVersion) to true
                    is GeminiResult.Failure -> result.reason to false
                }
            }
            updateKey(kind) { it.copy(testRunning = false, testResult = text, testOk = ok) }
        }
    }
}
