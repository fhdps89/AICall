package com.onecall.aivoice.ui.home

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.OutlinedTextFieldDefaults
import androidx.compose.material3.RadioButton
import androidx.compose.material3.RadioButtonDefaults
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewmodel.compose.viewModel
import com.onecall.aivoice.R
import com.onecall.aivoice.ui.components.GlowingOrb
import com.onecall.aivoice.ui.components.OrbMode
import com.onecall.aivoice.ui.theme.HerAmber
import com.onecall.aivoice.ui.theme.HerDanger
import com.onecall.aivoice.ui.theme.HerBg
import com.onecall.aivoice.ui.theme.HerSurface
import com.onecall.aivoice.ui.theme.HerText
import com.onecall.aivoice.ui.theme.HerTextDim
import com.onecall.aivoice.voice.TtsVoice

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun HomeScreen(
    onStartCall: () -> Unit,
    viewModel: HomeViewModel = viewModel()
) {
    val state by viewModel.ui.collectAsStateWithLifecycle()

    Box(
        modifier = Modifier
            .fillMaxSize()
            .background(HerBg)
            .padding(horizontal = 28.dp)
    ) {
        Column(
            modifier = Modifier.fillMaxSize(),
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.SpaceBetween
        ) {
            Spacer(Modifier.height(48.dp))

            Text(
                text = stringResource(R.string.app_name),
                style = MaterialTheme.typography.displayLarge,
                textAlign = TextAlign.Center,
                color = HerText
            )

            Column(horizontalAlignment = Alignment.CenterHorizontally) {
                GlowingOrb(
                    mode = OrbMode.Idle,
                    size = 220.dp,
                    onClick = { viewModel.openSettings() }
                )
                Spacer(Modifier.height(28.dp))
                Text(
                    text = "${stringResource(R.string.voice_label)}: ${state.voiceName}",
                    style = MaterialTheme.typography.bodyLarge,
                    color = HerTextDim,
                    textAlign = TextAlign.Center
                )
            }

            Column(
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(bottom = 48.dp),
                horizontalAlignment = Alignment.CenterHorizontally
            ) {
                Button(
                    onClick = onStartCall,
                    modifier = Modifier
                        .fillMaxWidth()
                        .height(56.dp),
                    shape = RoundedCornerShape(28.dp),
                    colors = ButtonDefaults.buttonColors(
                        containerColor = HerAmber,
                        contentColor = HerBg
                    )
                ) {
                    Text(
                        text = stringResource(R.string.call_button),
                        style = MaterialTheme.typography.labelLarge
                    )
                }
                Spacer(Modifier.height(12.dp))
                Text(
                    text = "오브를 눌러 설정을 엽니다",
                    style = MaterialTheme.typography.bodyMedium,
                    color = HerTextDim
                )
            }
        }
    }

    if (state.settingsOpen) {
        val sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true)
        ModalBottomSheet(
            onDismissRequest = { viewModel.closeSettings() },
            sheetState = sheetState,
            containerColor = HerSurface,
            contentColor = HerText
        ) {
            Column(
                modifier = Modifier
                    .fillMaxWidth()
                    .imePadding()
                    .verticalScroll(rememberScrollState())
                    .padding(horizontal = 24.dp, vertical = 8.dp)
                    .padding(bottom = 32.dp)
            ) {
                Text(
                    text = stringResource(R.string.settings_title),
                    style = MaterialTheme.typography.headlineMedium
                )
                Spacer(Modifier.height(20.dp))
                Text(
                    text = "${stringResource(R.string.voice_label)}",
                    style = MaterialTheme.typography.titleMedium
                )
                Spacer(Modifier.height(6.dp))
                Text(
                    text = state.voiceName,
                    style = MaterialTheme.typography.bodyLarge,
                    color = HerAmber
                )
                Spacer(Modifier.height(20.dp))
                OutlinedTextField(
                    value = state.nickname,
                    onValueChange = viewModel::updateNicknameDraft,
                    modifier = Modifier.fillMaxWidth(),
                    singleLine = true,
                    label = { Text(stringResource(R.string.nickname_label)) },
                    placeholder = { Text(stringResource(R.string.nickname_hint)) },
                    colors = OutlinedTextFieldDefaults.colors(
                        focusedBorderColor = HerAmber,
                        unfocusedBorderColor = HerTextDim,
                        focusedLabelColor = HerAmber,
                        cursorColor = HerAmber,
                        focusedTextColor = HerText,
                        unfocusedTextColor = HerText
                    )
                )
                Spacer(Modifier.height(20.dp))
                Button(
                    onClick = { viewModel.saveNickname() },
                    modifier = Modifier.fillMaxWidth(),
                    colors = ButtonDefaults.buttonColors(
                        containerColor = HerAmber,
                        contentColor = HerBg
                    )
                ) {
                    Text("저장")
                }
                TextButton(onClick = { viewModel.closeSettings() }) {
                    Text("닫기", color = HerTextDim)
                }
                Spacer(Modifier.height(12.dp))
                HorizontalDivider(color = HerTextDim.copy(alpha = 0.2f))
                ApiKeySection(
                    kind = KeyKind.OpenRouter,
                    key = state.openRouter,
                    title = stringResource(R.string.ai_key_label),
                    inputLabel = stringResource(R.string.ai_key_input_label),
                    modelLine = stringResource(R.string.ai_model_label, state.openRouterModel),
                    viewModel = viewModel
                )
                VoiceChoiceSection(state = state, viewModel = viewModel)
                HorizontalDivider(color = HerTextDim.copy(alpha = 0.2f))
                ApiKeySection(
                    kind = KeyKind.Gemini,
                    key = state.gemini,
                    title = stringResource(R.string.gemini_key_label),
                    inputLabel = stringResource(R.string.gemini_key_input_label),
                    modelLine = stringResource(R.string.gemini_model_label, state.modelId),
                    viewModel = viewModel
                )
            }
        }
    }
}

/** Test voice choice (used only with an OpenRouter key). Saved immediately. */
@Composable
private fun VoiceChoiceSection(state: HomeUiState, viewModel: HomeViewModel) {
    Column(modifier = Modifier.fillMaxWidth().padding(bottom = 8.dp)) {
        Text(
            text = stringResource(R.string.voice_choice_label),
            style = MaterialTheme.typography.bodyMedium,
            color = HerTextDim
        )
        TtsVoice.values().forEach { voice ->
            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .clickable { viewModel.selectVoice(voice) }
                    .padding(vertical = 2.dp),
                verticalAlignment = Alignment.CenterVertically
            ) {
                RadioButton(
                    selected = state.selectedVoice == voice,
                    onClick = { viewModel.selectVoice(voice) },
                    colors = RadioButtonDefaults.colors(selectedColor = HerAmber, unselectedColor = HerTextDim)
                )
                Column {
                    Text(
                        text = voice.shortLabel,
                        style = MaterialTheme.typography.bodyMedium,
                        color = if (state.selectedVoice == voice) HerAmber else HerText
                    )
                    Text(
                        text = voice.description,
                        style = MaterialTheme.typography.labelSmall,
                        color = HerTextDim
                    )
                }
            }
        }
        if (state.openRouter.masked.isEmpty()) {
            Text(
                text = stringResource(R.string.voice_choice_needs_key),
                style = MaterialTheme.typography.labelSmall,
                color = HerTextDim
            )
        }
    }
}

/** Subtle on-device key entry (test builds). The key never leaves the phone except to call the API. */
@Composable
private fun ApiKeySection(
    kind: KeyKind,
    key: KeyUi,
    title: String,
    inputLabel: String,
    modelLine: String,
    viewModel: HomeViewModel
) {
    Column(modifier = Modifier.fillMaxWidth()) {
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .clickable(enabled = !key.editing) { viewModel.startApiKeyEdit(kind) }
                .padding(vertical = 12.dp)
        ) {
            Text(
                text = title,
                style = MaterialTheme.typography.bodyMedium,
                color = HerTextDim
            )
            Spacer(Modifier.height(2.dp))
            Text(
                text = key.masked.ifEmpty { stringResource(R.string.ai_key_not_set) },
                style = MaterialTheme.typography.bodyMedium,
                color = if (key.masked.isEmpty()) HerTextDim else HerAmber
            )
            Spacer(Modifier.height(2.dp))
            Text(
                text = modelLine,
                style = MaterialTheme.typography.labelSmall,
                color = HerTextDim
            )
        }
        if (key.editing) {
            OutlinedTextField(
                value = key.draft,
                onValueChange = { viewModel.updateApiKeyDraft(kind, it) },
                modifier = Modifier.fillMaxWidth(),
                singleLine = true,
                label = { Text(inputLabel) },
                visualTransformation = PasswordVisualTransformation(),
                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Password),
                colors = OutlinedTextFieldDefaults.colors(
                    focusedBorderColor = HerAmber,
                    unfocusedBorderColor = HerTextDim,
                    focusedLabelColor = HerAmber,
                    cursorColor = HerAmber,
                    focusedTextColor = HerText,
                    unfocusedTextColor = HerText
                )
            )
            Spacer(Modifier.height(4.dp))
            Text(
                text = stringResource(R.string.ai_key_notice),
                style = MaterialTheme.typography.bodyMedium,
                color = HerTextDim
            )
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.End
            ) {
                TextButton(onClick = { viewModel.cancelApiKeyEdit(kind) }) {
                    Text(stringResource(R.string.ai_key_cancel), color = HerTextDim)
                }
                TextButton(
                    onClick = { viewModel.testApiKey(kind) },
                    enabled = key.draft.isNotBlank() && !key.testRunning
                ) {
                    Text(stringResource(R.string.ai_key_test), color = HerTextDim)
                }
                TextButton(
                    onClick = { viewModel.saveApiKey(kind) },
                    enabled = key.draft.isNotBlank()
                ) {
                    Text(stringResource(R.string.ai_key_save), color = HerAmber)
                }
            }
        } else if (key.masked.isNotEmpty()) {
            Row(modifier = Modifier.fillMaxWidth()) {
                TextButton(
                    onClick = { viewModel.testApiKey(kind) },
                    enabled = !key.testRunning
                ) {
                    Text(stringResource(R.string.ai_key_test), color = HerAmber)
                }
                TextButton(onClick = { viewModel.startApiKeyEdit(kind) }) {
                    Text(stringResource(R.string.ai_key_replace), color = HerTextDim)
                }
                TextButton(onClick = { viewModel.clearApiKey(kind) }) {
                    Text(stringResource(R.string.ai_key_clear), color = HerTextDim)
                }
            }
        }
        key.testResult?.let { result ->
            Text(
                text = result,
                style = MaterialTheme.typography.bodyMedium,
                color = when {
                    key.testRunning -> HerTextDim
                    key.testOk -> HerAmber
                    else -> HerDanger
                },
                modifier = Modifier.padding(vertical = 4.dp)
            )
        }
    }
}
