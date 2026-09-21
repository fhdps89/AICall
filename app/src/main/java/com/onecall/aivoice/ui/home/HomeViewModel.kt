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
    val settingsOpen: Boolean = false
)

class HomeViewModel(application: Application) : AndroidViewModel(application) {
    private val prefs = UserPreferences(application)

    private val _ui = MutableStateFlow(
        HomeUiState(
            voiceName = prefs.fixedVoiceName,
            nickname = prefs.nickname
        )
    )
    val ui: StateFlow<HomeUiState> = _ui.asStateFlow()

    fun openSettings() {
        _ui.update { it.copy(settingsOpen = true, nickname = prefs.nickname) }
    }

    fun closeSettings() {
        _ui.update { it.copy(settingsOpen = false) }
    }

    fun updateNicknameDraft(value: String) {
        _ui.update { it.copy(nickname = value) }
    }

    fun saveNickname() {
        prefs.nickname = _ui.value.nickname
        _ui.update { it.copy(nickname = prefs.nickname, settingsOpen = false) }
    }
}
