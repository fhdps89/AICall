package com.onecall.aivoice.ui.call

import android.app.Application
import android.os.SystemClock
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import com.onecall.aivoice.data.UserPreferences
import com.onecall.aivoice.voice.CallPhase
import com.onecall.aivoice.voice.ReplyLatency
import com.onecall.aivoice.voice.ReplyOrigin
import com.onecall.aivoice.voice.ReplySource
import com.onecall.aivoice.voice.VoiceCallEngine
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch

data class CallUiState(
    val phase: CallPhase = CallPhase.Idle,
    val muted: Boolean = false,
    val elapsedMs: Long = 0L,
    val partialText: String = "",
    val errorMessage: String? = null,
    val ended: Boolean = false,
    /** Small latency label, e.g. "첫 소리까지 1.9초 · 모델 첫 문장 0.7초 · 음성 1.2초". */
    val latencyText: String? = null,
    /** True when no key (OpenRouter or Gemini) is set (local fallback replies). */
    val aiKeyMissing: Boolean = false,
    /** Source of the last spoken reply: "AI 대답" / "기본 대답(키 없음)" / "AI 실패: …". */
    val replySourceText: String? = null,
    /** Brain + voice, e.g. "google/gemini-3.5-flash-lite · 목소리 2번 Puck". */
    val voiceInfoText: String? = null,
    /** "음성 실패: <사유> → 기본 음성" when a sentence fell back to the built-in TTS. */
    val voiceFailureText: String? = null
)

class CallViewModel(application: Application) : AndroidViewModel(application) {
    private val prefs = UserPreferences(application)

    private val _ui = MutableStateFlow(CallUiState())
    val ui: StateFlow<CallUiState> = _ui.asStateFlow()

    private var engine: VoiceCallEngine? = null
    private var timerJob: Job? = null
    private var callStartedAt = 0L

    fun startCall() {
        if (engine != null) return
        callStartedAt = SystemClock.elapsedRealtime()
        startTimer()
        // Fresh read at call start (UI hint); the engine re-reads the key at every request.
        val keySet = prefs.openRouterApiKey != null || prefs.geminiApiKey != null
        _ui.update {
            it.copy(
                aiKeyMissing = !keySet,
                latencyText = null,
                replySourceText = null,
                voiceInfoText = null,
                voiceFailureText = null
            )
        }
        engine = VoiceCallEngine(
            context = getApplication(),
            nicknameProvider = { prefs.nickname },
            onPhase = { phase -> _ui.update { it.copy(phase = phase) } },
            onPartialText = { text -> _ui.update { it.copy(partialText = text) } },
            onErrorMessage = { msg -> _ui.update { it.copy(errorMessage = msg) } },
            isMuted = { _ui.value.muted },
            apiKeyProvider = { prefs.geminiApiKey },
            openRouterKeyProvider = { prefs.openRouterApiKey },
            voiceProvider = { prefs.ttsVoice },
            onLatency = { latency -> _ui.update { it.copy(latencyText = formatLatency(latency)) } },
            onReplyOrigin = { origin ->
                _ui.update {
                    it.copy(
                        replySourceText = origin.label,
                        aiKeyMissing = origin is ReplyOrigin.LocalNoKey
                    )
                }
            },
            onVoiceInfo = { info -> _ui.update { it.copy(voiceInfoText = info) } },
            onVoiceFailure = { failure -> _ui.update { it.copy(voiceFailureText = failure) } }
        ).also { it.start() }
    }

    fun toggleMute() {
        val next = !_ui.value.muted
        _ui.update { it.copy(muted = next) }
        engine?.setMuted(next)
    }

    fun hangUp() {
        timerJob?.cancel()
        timerJob = null
        engine?.stop()
        engine = null
        _ui.update { it.copy(ended = true, phase = CallPhase.Ended) }
    }

    private fun startTimer() {
        timerJob?.cancel()
        timerJob = viewModelScope.launch {
            while (isActive) {
                val elapsed = SystemClock.elapsedRealtime() - callStartedAt
                _ui.update { it.copy(elapsedMs = elapsed) }
                delay(250L)
            }
        }
    }

    override fun onCleared() {
        timerJob?.cancel()
        engine?.stop()
        engine = null
        super.onCleared()
    }
}

fun formatElapsed(ms: Long): String {
    val totalSec = (ms / 1000).toInt().coerceAtLeast(0)
    val m = totalSec / 60
    val s = totalSec % 60
    return "%02d:%02d".format(m, s)
}

fun formatLatency(latency: ReplyLatency): String {
    fun sec(ms: Long) = "%.1f초".format(ms / 1000.0)
    val parts = mutableListOf("첫 소리까지 ${sec(latency.firstSoundMs)}")
    when (latency.source) {
        ReplySource.Ai -> latency.modelMs?.let { parts.add("모델 ${sec(it)}") }
        ReplySource.Local -> parts.add("기본 응답")
        ReplySource.Fallback -> parts.add("AI 응답 실패")
    }
    latency.voiceMs?.let { parts.add("음성 ${sec(it)}") }
    return parts.joinToString(" · ")
}
