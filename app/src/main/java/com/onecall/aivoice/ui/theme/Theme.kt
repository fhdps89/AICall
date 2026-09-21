package com.onecall.aivoice.ui.theme

import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.runtime.Composable

private val HerDarkScheme = darkColorScheme(
    primary = HerAmber,
    onPrimary = HerBg,
    secondary = HerGlow,
    background = HerBg,
    onBackground = HerText,
    surface = HerSurface,
    onSurface = HerText,
    error = HerDanger
)

@Composable
fun AICallTheme(content: @Composable () -> Unit) {
    MaterialTheme(
        colorScheme = HerDarkScheme,
        typography = Typography,
        content = content
    )
}
