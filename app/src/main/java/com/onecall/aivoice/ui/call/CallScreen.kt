package com.onecall.aivoice.ui.call

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.CallEnd
import androidx.compose.material.icons.filled.Mic
import androidx.compose.material.icons.filled.MicOff
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.IconButtonDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
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
import com.onecall.aivoice.ui.components.toOrbMode
import com.onecall.aivoice.ui.theme.HerAmber
import com.onecall.aivoice.ui.theme.HerBg
import com.onecall.aivoice.ui.theme.HerDanger
import com.onecall.aivoice.ui.theme.HerSurface
import com.onecall.aivoice.ui.theme.HerText
import com.onecall.aivoice.ui.theme.HerTextDim
import com.onecall.aivoice.voice.CallPhase

@Composable
fun CallScreen(
    onHangUp: () -> Unit,
    viewModel: CallViewModel = viewModel()
) {
    val state by viewModel.ui.collectAsStateWithLifecycle()

    LaunchedEffect(Unit) {
        viewModel.startCall()
    }

    DisposableEffect(Unit) {
        onDispose {
            // ViewModel.onCleared handles engine stop when nav pops
        }
    }

    LaunchedEffect(state.ended) {
        if (state.ended) onHangUp()
    }

    Box(
        modifier = Modifier
            .fillMaxSize()
            .background(HerBg)
            .padding(horizontal = 24.dp)
    ) {
        Column(
            modifier = Modifier.fillMaxSize(),
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.SpaceBetween
        ) {
            Column(
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(top = 40.dp),
                horizontalAlignment = Alignment.CenterHorizontally
            ) {
                Surface(
                    color = HerSurface,
                    shape = RoundedCornerShape(20.dp)
                ) {
                    Text(
                        text = stringResource(R.string.ai_voice_notice),
                        modifier = Modifier.padding(horizontal = 16.dp, vertical = 8.dp),
                        style = MaterialTheme.typography.bodyMedium,
                        color = HerAmber
                    )
                }
                Spacer(Modifier.height(16.dp))
                Text(
                    text = formatElapsed(state.elapsedMs),
                    style = MaterialTheme.typography.headlineMedium,
                    color = HerText
                )
                Spacer(Modifier.height(8.dp))
                Text(
                    text = phaseLabel(state.phase, state.muted),
                    style = MaterialTheme.typography.bodyLarge,
                    color = HerTextDim
                )
                state.latencyText?.let { latency ->
                    Spacer(Modifier.height(4.dp))
                    Text(
                        text = latency,
                        style = MaterialTheme.typography.labelSmall,
                        color = HerTextDim
                    )
                }
                if (state.aiKeyMissing) {
                    Spacer(Modifier.height(4.dp))
                    Text(
                        text = stringResource(R.string.ai_key_missing_hint),
                        style = MaterialTheme.typography.labelSmall,
                        color = HerTextDim
                    )
                }
            }

            Column(horizontalAlignment = Alignment.CenterHorizontally) {
                GlowingOrb(
                    mode = state.phase.toOrbMode(),
                    size = 240.dp
                )
                Spacer(Modifier.height(20.dp))
                if (state.partialText.isNotBlank()) {
                    Text(
                        text = state.partialText,
                        style = MaterialTheme.typography.bodyMedium,
                        color = HerTextDim,
                        textAlign = TextAlign.Center,
                        modifier = Modifier.padding(horizontal = 16.dp)
                    )
                }
                state.errorMessage?.let { err ->
                    Spacer(Modifier.height(8.dp))
                    Text(
                        text = err,
                        style = MaterialTheme.typography.bodyMedium,
                        color = HerDanger,
                        textAlign = TextAlign.Center
                    )
                }
            }

            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(bottom = 48.dp),
                horizontalArrangement = Arrangement.SpaceEvenly,
                verticalAlignment = Alignment.CenterVertically
            ) {
                Column(horizontalAlignment = Alignment.CenterHorizontally) {
                    IconButton(
                        onClick = { viewModel.toggleMute() },
                        modifier = Modifier.size(64.dp),
                        colors = IconButtonDefaults.iconButtonColors(
                            containerColor = HerSurface,
                            contentColor = HerText
                        )
                    ) {
                        Icon(
                            imageVector = if (state.muted) Icons.Default.MicOff else Icons.Default.Mic,
                            contentDescription = if (state.muted) {
                                stringResource(R.string.unmute)
                            } else {
                                stringResource(R.string.mute)
                            },
                            modifier = Modifier.size(28.dp)
                        )
                    }
                    Spacer(Modifier.height(6.dp))
                    Text(
                        text = if (state.muted) stringResource(R.string.unmute)
                        else stringResource(R.string.mute),
                        style = MaterialTheme.typography.bodyMedium,
                        color = HerTextDim
                    )
                }

                Column(horizontalAlignment = Alignment.CenterHorizontally) {
                    IconButton(
                        onClick = { viewModel.hangUp() },
                        modifier = Modifier.size(72.dp),
                        colors = IconButtonDefaults.iconButtonColors(
                            containerColor = HerDanger,
                            contentColor = HerText
                        ),
                    ) {
                        Icon(
                            imageVector = Icons.Default.CallEnd,
                            contentDescription = stringResource(R.string.hang_up),
                            modifier = Modifier.size(32.dp)
                        )
                    }
                    Spacer(Modifier.height(6.dp))
                    Text(
                        text = stringResource(R.string.hang_up),
                        style = MaterialTheme.typography.bodyMedium,
                        color = HerTextDim
                    )
                }
            }
        }
    }
}

@Composable
private fun phaseLabel(phase: CallPhase, muted: Boolean): String {
    if (muted) return stringResource(R.string.mute)
    return when (phase) {
        CallPhase.Listening, CallPhase.Thinking -> stringResource(R.string.listening)
        CallPhase.Speaking, CallPhase.Greeting -> stringResource(R.string.speaking)
        CallPhase.Ended -> stringResource(R.string.hang_up)
        CallPhase.Idle -> "…"
    }
}
