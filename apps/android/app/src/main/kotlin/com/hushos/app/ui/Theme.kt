package com.hushos.app.ui

import android.app.UiModeManager
import android.os.Build
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.ColorScheme
import androidx.compose.material3.ExperimentalMaterial3ExpressiveApi
import androidx.compose.material3.MaterialExpressiveTheme
import androidx.compose.material3.Shapes
import androidx.compose.material3.Surface
import androidx.compose.material3.Typography
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.Immutable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.compositeOver
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.em
import com.hushos.tokens.AlpineDark
import com.hushos.tokens.AlpineDarkHigh
import com.hushos.tokens.AlpineLight
import com.hushos.tokens.AlpineLightHigh
import com.hushos.tokens.AlpineRadius
import com.hushos.tokens.AlpineType

/*
 * Alpine, the HushOS tokens (packages/tokens, generated as com.hushos.tokens), as
 * Material 3 Expressive roles: light, dark, and a high contrast pair of each that
 * follows Android's contrast setting. Material's scheme covers what its components
 * paint; the roles it has no slot for (ground, folder sheets, warning,
 * the edge on raised surfaces, avatar tones) are read through `Alpine.colors`.
 */
@Immutable
data class AlpineColors(
    val surface: Color, val ground: Color, val ink: Color, val inkMuted: Color, val rule: Color, val field: Color,
    val primary: Color, val onPrimary: Color, val tint: Color, val onTint: Color,
    val folderBack: Color, val folderFront: Color, val warning: Color, val warningSoft: Color,
    val success: Color, val successSoft: Color, val danger: Color, val dangerSoft: Color,
    val snackbar: Color, val onSnackbar: Color, val snackbarAction: Color, val edge: Color, val scrim: Color,
    val avatars: List<Pair<Color, Color>>, val dark: Boolean, val high: Boolean,
) {
    /* The search bar and other quiet fills: ink at 6% over the surface, as the board draws them. */
    val fill: Color get() = ink.copy(alpha = 0.06f).compositeOver(surface)
    /* Menus and the tonal cards (paste bar, access banner): a little of the tint over the surface. */
    val menu: Color get() = tint.copy(alpha = 0.22f).compositeOver(surface)
    val card: Color get() = tint.copy(alpha = if (high) 1f else 0.45f).compositeOver(surface)
    val dialog: Color get() = tint.copy(alpha = 0.35f).compositeOver(surface)
    /*
     * Lines between rows. High contrast keeps its strong `rule` for control edges, but a
     * list ruled at that strength reads as a grid; rows get one step above normal instead.
     * Defined here, not in packages/tokens, which has no divider role.
     */
    val divider: Color get() = if (high) ink.copy(alpha = 0.22f).compositeOver(surface) else rule
}

private val Light = with(AlpineLight) {
    AlpineColors(Surface, Ground, Ink, InkMuted, Rule, Field, Primary, OnPrimary, Tint, OnTint, FolderBack, FolderFront, Warning, WarningSoft,
        Success, SuccessSoft, Danger, DangerSoft, Snackbar, OnSnackbar, SnackbarAction, Edge, Scrim,
        listOf(Avatar1 to OnAvatar1, Avatar2 to OnAvatar2, Avatar3 to OnAvatar3, Avatar4 to OnAvatar4), dark = false, high = false)
}
private val Dark = with(AlpineDark) {
    AlpineColors(Surface, Ground, Ink, InkMuted, Rule, Field, Primary, OnPrimary, Tint, OnTint, FolderBack, FolderFront, Warning, WarningSoft,
        Success, SuccessSoft, Danger, DangerSoft, Snackbar, OnSnackbar, SnackbarAction, Edge, Scrim,
        listOf(Avatar1 to OnAvatar1, Avatar2 to OnAvatar2, Avatar3 to OnAvatar3, Avatar4 to OnAvatar4), dark = true, high = false)
}
private val LightHigh = with(AlpineLightHigh) {
    AlpineColors(Surface, Ground, Ink, InkMuted, Rule, Field, Primary, OnPrimary, Tint, OnTint, FolderBack, FolderFront, Warning, WarningSoft,
        Success, SuccessSoft, Danger, DangerSoft, Snackbar, OnSnackbar, SnackbarAction, Edge, Scrim,
        listOf(Avatar1 to OnAvatar1, Avatar2 to OnAvatar2, Avatar3 to OnAvatar3, Avatar4 to OnAvatar4), dark = false, high = true)
}
private val DarkHigh = with(AlpineDarkHigh) {
    AlpineColors(Surface, Ground, Ink, InkMuted, Rule, Field, Primary, OnPrimary, Tint, OnTint, FolderBack, FolderFront, Warning, WarningSoft,
        Success, SuccessSoft, Danger, DangerSoft, Snackbar, OnSnackbar, SnackbarAction, Edge, Scrim,
        listOf(Avatar1 to OnAvatar1, Avatar2 to OnAvatar2, Avatar3 to OnAvatar3, Avatar4 to OnAvatar4), dark = true, high = true)
}

private val LocalAlpine = staticCompositionLocalOf { Light }

object Alpine {
    val colors: AlpineColors @Composable get() = LocalAlpine.current
}

/*
 * Screens sit on the ground; sheets and the navigation bar are the white (or, at
 * night, raised) surface. Selected things take the tint with its own ink. Inputs
 * and outlines use `field`, which reaches 3:1 against the surface.
 */
private fun scheme(a: AlpineColors): ColorScheme = (if (a.dark) darkColorScheme() else lightColorScheme()).copy(
    primary = a.primary, onPrimary = a.onPrimary, primaryContainer = a.tint, onPrimaryContainer = a.onTint,
    inversePrimary = a.snackbarAction,
    secondary = a.primary, onSecondary = a.onPrimary, secondaryContainer = a.tint, onSecondaryContainer = a.onTint,
    tertiary = a.primary, onTertiary = a.onPrimary, tertiaryContainer = a.tint, onTertiaryContainer = a.onTint,
    background = a.ground, onBackground = a.ink, surface = a.ground, onSurface = a.ink,
    surfaceVariant = a.fill, onSurfaceVariant = a.inkMuted, surfaceTint = a.primary,
    inverseSurface = a.snackbar, inverseOnSurface = a.onSnackbar,
    error = a.danger, onError = a.onPrimary, errorContainer = a.dangerSoft, onErrorContainer = a.danger,
    outline = a.field, outlineVariant = a.divider, scrim = a.scrim.copy(alpha = 1f),
    surfaceBright = a.surface, surfaceDim = a.ground,
    surfaceContainerLowest = a.surface, surfaceContainerLow = a.surface,
    surfaceContainer = a.menu, surfaceContainerHigh = a.dialog, surfaceContainerHighest = a.fill,
)

/*
 * The system face throughout (Alpine's brand face is for the web); Material's roles
 * at Material's sizes, which the board's Android drawings use. The one Alpine size
 * on Android is the large title: titleLarge, 34 extra bold, tight.
 */
private val Type = Typography().let { base ->
    base.copy(
        headlineLarge = TextStyle(fontSize = AlpineType.TitleLarge, fontWeight = FontWeight.ExtraBold, letterSpacing = (-0.03).em, lineHeight = 1.1.em),
        headlineMedium = TextStyle(fontSize = AlpineType.TitleLarge, fontWeight = FontWeight.ExtraBold, letterSpacing = (-0.03).em, lineHeight = 1.1.em),
    )
}

/* Material's corners, with Alpine's card radius for menus, banners and the transfer panel. */
private val Corners = Shapes(
    extraSmall = RoundedCornerShape(4.dp), small = RoundedCornerShape(8.dp), medium = RoundedCornerShape(12.dp),
    large = RoundedCornerShape(AlpineRadius.Card), extraLarge = RoundedCornerShape(28.dp),
)

/* Android 14 and later report the contrast setting; at 0.5 and above the high contrast scheme applies. */
@Composable
private fun highContrast(): Boolean {
    if (Build.VERSION.SDK_INT < 34) return false
    val context = LocalContext.current
    val modes = remember { context.getSystemService(UiModeManager::class.java) } ?: return false
    var level by remember { mutableFloatStateOf(modes.contrast) }
    DisposableEffect(modes) {
        val listener = UiModeManager.ContrastChangeListener { level = it }
        modes.addContrastChangeListener(context.mainExecutor, listener)
        onDispose { modes.removeContrastChangeListener(listener) }
    }
    return level >= 0.5f
}

@OptIn(ExperimentalMaterial3ExpressiveApi::class)
@Composable
fun HushOSTheme(ground: Boolean = true, content: @Composable () -> Unit) {
    val dark = isSystemInDarkTheme()
    val high = highContrast()
    val alpine = when {
        dark && high -> DarkHigh
        dark -> Dark
        high -> LightHigh
        else -> Light
    }
    val scheme = remember(alpine) { scheme(alpine) }
    CompositionLocalProvider(LocalAlpine provides alpine) {
        MaterialExpressiveTheme(colorScheme = scheme, typography = Type, shapes = Corners) {
            // `ground: false`: no page behind, for a sheet over another app (Save to HushOS).
            if (ground) Surface(color = scheme.background, contentColor = scheme.onBackground, modifier = Modifier.fillMaxSize(), content = content)
            else content()
        }
    }
}
