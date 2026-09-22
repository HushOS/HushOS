package com.hushos.app.ui

import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.material3.ExperimentalMaterial3ExpressiveApi
import androidx.compose.material3.MaterialExpressiveTheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.Surface
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.ui.Modifier
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color

/*
 * Material 3 Expressive in Paper's own colours, light and dark: the same blue
 * ink on a desk and sheets as the web, not the wallpaper palette, so the app
 * looks like HushOS on every phone. The theme paints the background itself;
 * screens that are plain columns would otherwise sit on the window's colour.
 */
private val Ink = Color(0xFF1C2848)
private val Blue = Color(0xFF2C428E)
private val Desk = Color(0xFFE6E2D9)
private val SheetColor = Color(0xFFFCFBF7)
private val Rule = Color(0xFFCFC9BC)

private val NightInk = Color(0xFFE6E4DC)
private val NightBlue = Color(0xFFAAB8F4)
private val NightDesk = Color(0xFF13151B)
private val NightSheet = Color(0xFF1C1F28)
private val NightRule = Color(0xFF3A3F4F)

private val Light = lightColorScheme(
    primary = Blue, onPrimary = SheetColor, primaryContainer = Color(0xFFDDE3F8), onPrimaryContainer = Ink,
    secondaryContainer = Color(0xFFE3E0D6), onSecondaryContainer = Ink,
    background = Desk, onBackground = Ink, surface = SheetColor, onSurface = Ink,
    surfaceVariant = Color(0xFFEFECE4), onSurfaceVariant = Color(0xFF5C6070), surfaceContainer = SheetColor,
    surfaceContainerLow = Color(0xFFF3F1EB), surfaceContainerHigh = Color(0xFFF6F4EE), surfaceContainerHighest = Color(0xFFFFFFFF),
    outline = Rule, outlineVariant = Color(0xFFE0DBD0), error = Color(0xFFB3261E),
)

private val Dark = darkColorScheme(
    primary = NightBlue, onPrimary = Color(0xFF121833), primaryContainer = Color(0xFF2C3A6B), onPrimaryContainer = Color(0xFFDDE3F8),
    secondaryContainer = Color(0xFF2A2E3A), onSecondaryContainer = NightInk,
    background = NightDesk, onBackground = NightInk, surface = NightSheet, onSurface = NightInk,
    surfaceVariant = Color(0xFF262A35), onSurfaceVariant = Color(0xFFA9ADBB), surfaceContainer = NightSheet,
    surfaceContainerLow = Color(0xFF181B23), surfaceContainerHigh = Color(0xFF232733), surfaceContainerHighest = Color(0xFF2B2F3B),
    outline = NightRule, outlineVariant = Color(0xFF2E3341), error = Color(0xFFF2B8B5),
)

@OptIn(ExperimentalMaterial3ExpressiveApi::class)
@Composable
fun HushOSTheme(content: @Composable () -> Unit) {
    val scheme = if (isSystemInDarkTheme()) Dark else Light
    MaterialExpressiveTheme(colorScheme = scheme) {
        Surface(color = scheme.background, contentColor = scheme.onBackground, modifier = Modifier.fillMaxSize(), content = content)
    }
}
