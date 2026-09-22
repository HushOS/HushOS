package com.hushos.app.ui

import android.os.Build
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.material3.ExperimentalMaterial3ExpressiveApi
import androidx.compose.material3.MaterialExpressiveTheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.dynamicDarkColorScheme
import androidx.compose.material3.dynamicLightColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext

/* Material 3 Expressive with the device's own colours when it offers them, else Paper's blue on the desk. */
private val Ink = Color(0xFF1C2848)
private val Blue = Color(0xFF2C428E)
private val Desk = Color(0xFFE6E2D9)
private val SheetColor = Color(0xFFFCFBF7)

@OptIn(ExperimentalMaterial3ExpressiveApi::class)
@Composable
fun HushOSTheme(content: @Composable () -> Unit) {
    val dark = isSystemInDarkTheme()
    val context = LocalContext.current
    val scheme = when {
        Build.VERSION.SDK_INT >= Build.VERSION_CODES.S -> if (dark) dynamicDarkColorScheme(context) else dynamicLightColorScheme(context)
        dark -> darkColorScheme(primary = Color(0xFFAAB8F4), onPrimary = Color(0xFF121833), background = Color(0xFF13151B), surface = Color(0xFF1C1F28))
        else -> lightColorScheme(primary = Blue, onPrimary = SheetColor, background = Desk, surface = SheetColor, onSurface = Ink)
    }
    MaterialExpressiveTheme(colorScheme = scheme, content = content)
}
