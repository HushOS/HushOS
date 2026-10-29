package com.hushos.app.ui

import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.layout.wrapContentWidth
import androidx.compose.material3.adaptive.WindowAdaptiveInfo
import androidx.compose.runtime.Composable
import androidx.compose.runtime.compositionLocalOf
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalWindowInfo
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.window.core.layout.WindowSizeClass
import com.hushos.app.data.Opened

/*
 * Foldables, tablets and windows of any size, following Google's large screen guidelines and
 * Material's window size classes. The same screens everywhere; only their frame changes:
 *
 * - compact width, compact height (a phone on its side) or tabletop: the bottom bar, as on every phone;
 * - medium: a collapsed navigation rail at the start;
 * - expanded and wider: the rail with its labels, which folds back to icons while Info sits beside
 *   the list and the list would otherwise be narrower than a phone (as iOS's sidebar does).
 *
 * The decisions are plain functions of the window in dp, so they are tested without a device.
 */

/* What carries Home, Files, Shared and Account. */
enum class NavKind { BAR, RAIL, WIDE_RAIL }

/* The widths the frame is planned with. The rails are Material's; Info is DESIGN.md's details panel. */
object Frame {
    val Rail = 96.dp
    val WideRail = 220.dp
    val Info = 320.dp
    val PaneGap = 24.dp
    // The narrowest a list may get beside Info: a phone's width, where rows were drawn for.
    val ListMin = 360.dp
    // Lists, the account page and other single columns stop here and centre on a wider window.
    val Readable = 840.dp
    // Forms (sign-in, passwords, recovery): fields and buttons never stretch wider than this.
    val Form = 560.dp
}

fun navKind(widthDp: Float, heightDp: Float, tabletop: Boolean, infoBeside: Boolean): NavKind {
    if (widthDp < WindowSizeClass.WIDTH_DP_MEDIUM_LOWER_BOUND) return NavKind.BAR
    // A phone on its side, or a half-open foldable standing on its hinge: the bar, on the lower half.
    if (tabletop || heightDp < WindowSizeClass.HEIGHT_DP_MEDIUM_LOWER_BOUND) return NavKind.BAR
    if (widthDp < WindowSizeClass.WIDTH_DP_EXPANDED_LOWER_BOUND) return NavKind.RAIL
    val beside = if (infoBeside) Frame.Info.value + Frame.PaneGap.value else 0f
    return if (widthDp - Frame.WideRail.value - beside >= Frame.ListMin.value) NavKind.WIDE_RAIL else NavKind.RAIL
}

/*
 * A bottom sheet's tallest, in dp, while the device stands half open on a horizontal hinge: it
 * stays on the lower half, below the fold, where the hands are, and nothing of it bends over the
 * hinge. Null when there is no such hinge (flat, folded shut, a book-style hinge, a phone).
 * `hingeBottomDp` is the fold's lower edge measured from the window's top.
 */
fun tabletopSheetMax(windowHeightDp: Float, hingeBottomDp: Float?, tabletop: Boolean): Float? {
    if (!tabletop || hingeBottomDp == null) return null
    val below = windowHeightDp - hingeBottomDp
    // A hinge near either edge leaves no half to speak of: the sheet keeps its usual height.
    return if (below < SheetMinBelowFold || hingeBottomDp < SheetMinBelowFold) null else below
}

private const val SheetMinBelowFold = 240f

/* The frame this window gets: navigation, whether Info sits beside the list, and a tabletop sheet's limit. */
data class AppFrame(val nav: NavKind, val infoBeside: Boolean, val sheetMaxDp: Float?)

@Composable
fun windowDp(): Pair<Float, Float> {
    val size = LocalWindowInfo.current.containerSize
    val density = LocalDensity.current.density
    return size.width / density to size.height / density
}

/* The lower edge of a separating horizontal hinge (tabletop), in dp from the window's top. */
fun horizontalHingeBottomDp(info: WindowAdaptiveInfo, density: Float): Float? =
    info.windowPosture.hingeList.firstOrNull { !it.isVertical && it.isSeparating }?.bounds?.bottom?.div(density)

val LocalFrame = compositionLocalOf { AppFrame(NavKind.BAR, infoBeside = false, sheetMaxDp = null) }

/*
 * Where Info opens. Main provides it: beside the list while the window has room for two panes,
 * otherwise as the sheet it has always been. Null inside the sheets Main itself draws.
 */
interface InfoHost {
    fun open(item: Opened)
}

val LocalInfo = compositionLocalOf<InfoHost?> { null }

/* A single column that stops at `max` and centres on a wider window; full width below it. */
fun Modifier.readableWidth(max: Dp = Frame.Readable): Modifier =
    this.fillMaxWidth().wrapContentWidth(Alignment.CenterHorizontally).widthIn(max = max)
