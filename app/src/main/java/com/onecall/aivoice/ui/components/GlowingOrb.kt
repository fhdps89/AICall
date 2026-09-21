package com.onecall.aivoice.ui.components

import androidx.compose.animation.core.LinearEasing
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.size
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import com.onecall.aivoice.ui.theme.HerAmber
import com.onecall.aivoice.ui.theme.HerGlow
import com.onecall.aivoice.voice.CallPhase

enum class OrbMode {
    Idle,
    Listening,
    Speaking
}

fun CallPhase.toOrbMode(): OrbMode = when (this) {
    CallPhase.Listening -> OrbMode.Listening
    CallPhase.Speaking, CallPhase.Greeting -> OrbMode.Speaking
    CallPhase.Thinking -> OrbMode.Listening
    else -> OrbMode.Idle
}

@Composable
fun GlowingOrb(
    mode: OrbMode,
    modifier: Modifier = Modifier,
    size: Dp = 200.dp,
    onClick: (() -> Unit)? = null
) {
    val transition = rememberInfiniteTransition(label = "orb")

    val pulse by transition.animateFloat(
        initialValue = 0.92f,
        targetValue = when (mode) {
            OrbMode.Idle -> 1.05f
            OrbMode.Listening -> 1.12f
            OrbMode.Speaking -> 1.18f
        },
        animationSpec = infiniteRepeatable(
            animation = tween(
                durationMillis = when (mode) {
                    OrbMode.Idle -> 2800
                    OrbMode.Listening -> 1400
                    OrbMode.Speaking -> 900
                },
                easing = LinearEasing
            ),
            repeatMode = RepeatMode.Reverse
        ),
        label = "pulse"
    )

    val glowAlpha by transition.animateFloat(
        initialValue = 0.25f,
        targetValue = when (mode) {
            OrbMode.Idle -> 0.45f
            OrbMode.Listening -> 0.65f
            OrbMode.Speaking -> 0.85f
        },
        animationSpec = infiniteRepeatable(
            animation = tween(
                durationMillis = when (mode) {
                    OrbMode.Idle -> 2600
                    OrbMode.Listening -> 1200
                    OrbMode.Speaking -> 700
                }
            ),
            repeatMode = RepeatMode.Reverse
        ),
        label = "glow"
    )

    val coreColor = when (mode) {
        OrbMode.Idle -> HerAmber
        OrbMode.Listening -> Color(0xFFFFC9A0)
        OrbMode.Speaking -> Color(0xFFFFD4B0)
    }

    val clickMod = if (onClick != null) {
        modifier.clickable(
            indication = null,
            interactionSource = remember { MutableInteractionSource() },
            onClick = onClick
        )
    } else modifier

    Canvas(modifier = clickMod.size(size)) {
        val radius = (this.size.minDimension / 2f) * pulse
        val center = Offset(this.size.width / 2f, this.size.height / 2f)

        // Outer soft glow
        drawCircle(
            brush = Brush.radialGradient(
                colors = listOf(
                    HerGlow.copy(alpha = glowAlpha),
                    Color.Transparent
                ),
                center = center,
                radius = radius * 1.55f
            ),
            radius = radius * 1.55f,
            center = center
        )

        // Mid ring
        drawCircle(
            brush = Brush.radialGradient(
                colors = listOf(
                    coreColor.copy(alpha = 0.55f),
                    HerGlow.copy(alpha = 0.15f),
                    Color.Transparent
                ),
                center = center,
                radius = radius * 1.15f
            ),
            radius = radius * 1.15f,
            center = center
        )

        // Core
        drawCircle(
            brush = Brush.radialGradient(
                colors = listOf(
                    Color.White.copy(alpha = 0.85f),
                    coreColor,
                    coreColor.copy(alpha = 0.7f)
                ),
                center = center,
                radius = radius * 0.72f
            ),
            radius = radius * 0.72f,
            center = center
        )
    }
}
