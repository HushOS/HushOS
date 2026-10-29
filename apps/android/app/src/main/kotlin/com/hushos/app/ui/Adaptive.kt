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

/*
 * A sheet's tallest right now: below the fold while the device stands half open, unless the keyboard is
 * up. The keyboard takes most of the lower half itself, so a sheet held there would leave its field a
 * strip too thin to see; it rises over the fold until the keyboard goes, then settles below it again.
 */
fun sheetLimit(belowFoldDp: Float?, keyboard: Boolean): Float? = if (keyboard) null else belowFoldDp

/*
 * The content's tallest so that the whole sheet fits `limitDp`: the limit less what the sheet adds around its
 * content (`sheetDp - contentDp`: the drag handle and the bottom inset as laid out). Before the first layout
 * (nothing measured yet) it assumes nothing is added; the next pass corrects it before the sheet has risen.
 */
fun sheetContentMax(limitDp: Float, sheetDp: Float, contentDp: Float): Float =
    (limitDp - (sheetDp - contentDp).coerceAtLeast(0f)).coerceAtLeast(0f)

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

/* What Info does with its item now: show it live, keep showing it as last seen, look it up, or close. */
enum class InfoLookup { SHOW, HOLD, FIND, CLOSE }

/*
 * Info follows the rows the lists follow, and closes only on a removal the server confirmed:
 * - `live`: the row is there and live: shown.
 * - `held`: the row is there but not live (trashed, or inside a trashed folder): closed.
 * - `removed`: the server said it is gone (trashed from here, tombstoned in the feed, purged): closed.
 * - `outOfReach`: in a workspace that is neither this account's nor among the shares just listed (unshared, revoked): closed.
 * - `missingFromList`: a received share's item absent from the list its own parent shows after a refresh
 *   (`missingFromShareList`): closed. The share's feed is its owner's, so nothing else here hears of a trash there.
 * - Otherwise the row is merely absent: dropped to be read again (a rotation forgets every row before the lists reload,
 *   a catalogue update forgets then reopens), so Info keeps what it showed (`seen`); never seen in this process (after
 *   the system restarted the app), it is looked up once.
 */
fun infoLookup(live: Boolean, held: Boolean, removed: Boolean, outOfReach: Boolean, seen: Boolean, missingFromList: Boolean = false): InfoLookup = when {
    outOfReach || removed || missingFromList -> InfoLookup.CLOSE
    live -> InfoLookup.SHOW
    held -> InfoLookup.CLOSE
    seen -> InfoLookup.HOLD
    else -> InfoLookup.FIND
}

/*
 * Whether a received share's item is gone from what the screen shows: `item` is in another workspace than this
 * account's `own`, its own parent was refreshed since Info showed it, and that parent's list as the screen has it
 * (`listed`) does not name it. A decision for Info alone: the cache keeps every row as it was.
 */
fun missingFromShareList(item: Opened, own: String?, refreshed: Boolean, listed: List<Opened>?): Boolean =
    own != null && item.node.workspaceId != own && refreshed && listed != null &&
        listed.none { it.id == item.id && it.node.workspaceId == item.node.workspaceId }

/*
 * Whether the folder an item is in now has finished a refresh since Info began watching it there: the evidence
 * `missingFromShareList` needs. Kept per (workspace, parent, item): a move puts the item under a parent whose list
 * the screen holds from before (a move changes the cached parent before the destination reloads), so a refresh
 * seen under the old parent says nothing about the new one, and only a load of the new parent that began after
 * the move counts. Fed once a pass with whether that parent is loading.
 */
class ParentRefresh {
    private var key: Triple<String, String?, String>? = null
    private var loadSeen = false

    fun observe(workspaceId: String, parentId: String?, itemId: String, loading: Boolean): Boolean {
        val now = Triple(workspaceId, parentId, itemId)
        if (now != key) { key = now; loadSeen = false }
        if (loading) { loadSeen = true; return false }
        return loadSeen
    }
}

val LocalFrame = compositionLocalOf { AppFrame(NavKind.BAR, infoBeside = false, sheetMaxDp = null) }

/*
 * Where Info opens. Main provides it: beside the list while the window has room for two panes,
 * otherwise as the sheet it has always been. Null inside the sheets Main itself draws.
 */
interface InfoHost {
    fun open(item: Opened)
}

val LocalInfo = compositionLocalOf<InfoHost?> { null }

/* The item whose Info is open beside the list, by workspace and id: its row takes the selection tint, as the web's selected row does. */
val LocalInfoShown = compositionLocalOf<Pair<String, String>?> { null }

/* A single column that stops at `max` and centres on a wider window; full width below it. */
fun Modifier.readableWidth(max: Dp = Frame.Readable): Modifier =
    this.fillMaxWidth().wrapContentWidth(Alignment.CenterHorizontally).widthIn(max = max)
