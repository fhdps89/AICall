package com.onecall.aivoice.ui.call

import android.app.Application
import android.os.SystemClock
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import com.onecall.aivoice.data.UserPreferences
import com.onecall.aivoice.voice.CallPhase
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
    val ended: Boolean = false
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
        engine = VoiceCallEngine(
            context = getApplication(),
            nicknameProvider = { prefs.nickname },
            onPhase = { phase -> _ui.update { it.copy(phase = phase) } },
            onPartialText = { text -> _ui.update { it.copy(partialText = text) } },
            onErrorMessage = { msg -> _ui.update { it.copy(errorMessage = msg) } },
            isMuted = { _ui.value.muted }
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
