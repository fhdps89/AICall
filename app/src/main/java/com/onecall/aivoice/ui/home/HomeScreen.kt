package com.onecall.aivoice.ui.home

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.OutlinedTextFieldDefaults
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewmodel.compose.viewModel
import com.onecall.aivoice.R
import com.onecall.aivoice.ui.components.GlowingOrb
import com.onecall.aivoice.ui.components.OrbMode
import com.onecall.aivoice.ui.theme.HerAmber
import com.onecall.aivoice.ui.theme.HerBg
import com.onecall.aivoice.ui.theme.HerSurface
import com.onecall.aivoice.ui.theme.HerText
import com.onecall.aivoice.ui.theme.HerTextDim

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
            }
        }
    }
}
