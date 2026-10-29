package com.hushos.app.ui

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/*
 * The frame the app gets from its window, measured in dp the way Material's window size classes
 * measure it: the Pixel Fold's outer screen (411 x 797), its inner one held either way (841 x 701,
 * 701 x 841), a phone on its side (915 x 411), a 10-inch tablet (1280 x 800). A phone must keep its
 * bottom bar whatever else changes, and the list beside Info must never get narrower than a phone.
 */
class AdaptiveTest {
    @Test
    fun phonesKeepTheBottomBar() {
        assertEquals(NavKind.BAR, navKind(411f, 797f, tabletop = false, infoBeside = false))
        // The last compact width: one dp short of medium.
        assertEquals(NavKind.BAR, navKind(599.9f, 900f, tabletop = false, infoBeside = false))
        // A phone on its side is wide enough for a rail but too short for one.
        assertEquals(NavKind.BAR, navKind(915f, 411f, tabletop = false, infoBeside = false))
        assertEquals(NavKind.BAR, navKind(700f, 479.9f, tabletop = false, infoBeside = false))
    }

    @Test
    fun aMediumWindowGetsTheRail() {
        assertEquals(NavKind.RAIL, navKind(600f, 900f, tabletop = false, infoBeside = false))
        assertEquals(NavKind.RAIL, navKind(701f, 841f, tabletop = false, infoBeside = false))
        assertEquals(NavKind.RAIL, navKind(700f, 480f, tabletop = false, infoBeside = false))
        assertEquals(NavKind.RAIL, navKind(839.9f, 701f, tabletop = false, infoBeside = false))
    }

    @Test
    fun standingOnItsHingeTheBarIsOnTheLowerHalf() {
        // Half open with the hinge across: the bar, below the fold, even on a window wide enough for a rail.
        assertEquals(NavKind.BAR, navKind(701f, 841f, tabletop = true, infoBeside = false))
        assertEquals(NavKind.BAR, navKind(1280f, 800f, tabletop = true, infoBeside = false))
    }

    @Test
    fun anExpandedWindowShowsTheLabelsUntilInfoNeedsTheRoom() {
        assertEquals(NavKind.WIDE_RAIL, navKind(840f, 701f, tabletop = false, infoBeside = false))
        // The Fold opened flat: labels and the list fit (841 - 220 = 621), but with Info beside the list
        // would be 277 dp, so the rail folds back to icons and the list keeps 401.
        assertEquals(NavKind.WIDE_RAIL, navKind(841f, 701f, tabletop = false, infoBeside = false))
        assertEquals(NavKind.RAIL, navKind(841f, 701f, tabletop = false, infoBeside = true))
        // A tablet has room for all three.
        assertEquals(NavKind.WIDE_RAIL, navKind(1280f, 800f, tabletop = false, infoBeside = true))
    }

    @Test
    fun theWideRailFoldsAwayAtTheExactWidthTheListWouldGoBelowAPhone() {
        // 220 rail + 344 Info and gap + 360 list = 924.
        assertEquals(NavKind.WIDE_RAIL, navKind(924f, 800f, tabletop = false, infoBeside = true))
        assertEquals(NavKind.RAIL, navKind(923.9f, 800f, tabletop = false, infoBeside = true))
    }

    @Test
    fun aSheetStandingOnItsHingeKeepsBelowTheFold() {
        // The Fold half open, held tall: 841 dp, the hinge's lower edge at 420.5.
        assertEquals(420.5f, tabletopSheetMax(841f, 420.5f, tabletop = true)!!, 0.001f)
        // A tablet-sized foldable with the hinge lower down: only what is below it.
        assertEquals(500f, tabletopSheetMax(1200f, 700f, tabletop = true)!!, 0.001f)
    }

    @Test
    fun aSheetKeepsItsHeightWithoutAHingeAcross() {
        // Flat, folded, held like a book, or a phone: no limit.
        assertNull(tabletopSheetMax(841f, 420.5f, tabletop = false))
        assertNull(tabletopSheetMax(841f, null, tabletop = true))
        // A hinge too near either edge leaves no half worth keeping to.
        assertNull(tabletopSheetMax(841f, 700f, tabletop = true))
        assertNull(tabletopSheetMax(841f, 200f, tabletop = true))
    }

    @Test
    fun withTheKeyboardUpASheetMayRiseOverTheFold() {
        assertEquals(420.5f, sheetLimit(420.5f, keyboard = false)!!, 0.001f)
        assertNull(sheetLimit(420.5f, keyboard = true))
        assertNull(sheetLimit(null, keyboard = false))
    }

    @Test
    fun aBoundedSheetLeavesRoomForWhatMaterialAddsAroundItsContent() {
        // Below the Fold's hinge, 420.5 dp; the handle (48) and the navigation bar's inset (24) as laid out.
        assertEquals(348.5f, sheetContentMax(420.5f, sheetDp = 500f, contentDp = 428f), 0.001f)
        // Not laid out yet: nothing assumed around it, corrected on the next pass.
        assertEquals(420.5f, sheetContentMax(420.5f, sheetDp = 0f, contentDp = 0f), 0.001f)
        // More around it than the limit allows: no room, never a negative height.
        assertEquals(0f, sheetContentMax(40f, sheetDp = 500f, contentDp = 428f), 0.001f)
    }

    private fun lookup(live: Boolean = false, held: Boolean = false, removed: Boolean = false, outOfReach: Boolean = false, seen: Boolean = false) =
        infoLookup(live = live, held = held, removed = removed, outOfReach = outOfReach, seen = seen)

    /*
     * Info shows its item only while the lists would: a row that went away (trashed here or on another device,
     * inside a trashed folder, unshared) stayed on screen from the first lookup, with Share and Tags live.
     */
    @Test
    fun infoClosesOnARemovalTheServerConfirmed() {
        assertEquals(InfoLookup.SHOW, lookup(live = true, held = true))
        // Trashed, or inside a trashed folder: the row is still held, but not live.
        assertEquals(InfoLookup.CLOSE, lookup(held = true, seen = true))
        assertEquals(InfoLookup.CLOSE, lookup(held = true))
        // Trashed from here, tombstoned in the feed, purged: gone, and no lookup brings it back.
        assertEquals(InfoLookup.CLOSE, lookup(removed = true, seen = true))
        // A share's item once the shares listed no longer include its workspace, even while its row lingers.
        assertEquals(InfoLookup.CLOSE, lookup(live = true, held = true, outOfReach = true, seen = true))
    }

    /*
     * A rotation (after Stop sharing) forgets every row before the lists reload them, and a catalogue update forgets a
     * row before it reopens it: a pass in that gap (a notice, transfer progress) saw the row missing and closed Info and
     * its Share sheet while the owner still had the item. Absent without a removal, Info keeps what it showed.
     */
    @Test
    fun rowsForgottenMidRebuildKeepInfoOpen() {
        assertEquals(InfoLookup.HOLD, lookup(seen = true))
        // Then the reload puts the row back.
        assertEquals(InfoLookup.SHOW, lookup(live = true, held = true, seen = true))
        // Never shown in this process (the system restarted the app): looked up once.
        assertEquals(InfoLookup.FIND, lookup())
    }

    /*
     * Info on a share item, its folder refreshed, then the item moved into a sibling folder: the move changes the
     * cached parent before the sibling reloads, and the sibling's list on screen is from before (without the item).
     * Evidence kept by item alone counted the old folder's refresh for the new one and closed Info on that stale list.
     */
    @Test
    fun aRefreshOfTheOldFolderSaysNothingAfterAMove() {
        val evidence = ParentRefresh()
        assertEquals(false, evidence.observe("theirs", "S", "t", loading = false))
        assertEquals(false, evidence.observe("theirs", "S", "t", loading = true))
        assertEquals(true, evidence.observe("theirs", "S", "t", loading = false))
        // Moved into U: nothing about U yet, so Info stays whatever U's old list says.
        assertEquals(false, evidence.observe("theirs", "U", "t", loading = false))
        // U refreshed after the move: now its list counts.
        assertEquals(false, evidence.observe("theirs", "U", "t", loading = true))
        assertEquals(true, evidence.observe("theirs", "U", "t", loading = false))
        // The same id in another workspace is another node, with no refresh of its own yet.
        assertEquals(false, evidence.observe("mine", "U", "t", loading = false))
    }
}

