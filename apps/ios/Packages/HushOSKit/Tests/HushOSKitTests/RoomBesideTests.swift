import CoreGraphics
import Testing
@testable import HushOSKit

/*
 * Columns where they can't sit beside the screen cover it: a sidebar starts hidden behind a
 * button the app's screens never show, so the tabs become unreachable, and Info hides the list.
 * The inner display upright, the outer display either way and every iPhone keep the tab bar and
 * Info as a sheet; only windows with room beside the screen get the columns.
 */
@Suite struct RoomBesideTests {
    @Test func theInnerDisplayUprightKeepsTheTabBarAndSheets() {
        #expect(!RoomBeside.fits(width: 669, regularHeight: true))
    }

    @Test func theInnerDisplayOnItsSideGetsColumns() {
        #expect(RoomBeside.fits(width: 951, regularHeight: true))
    }

    @Test func theOuterDisplayKeepsTheTabBarEitherWay() {
        #expect(!RoomBeside.fits(width: 466, regularHeight: true))
        #expect(!RoomBeside.fits(width: 678, regularHeight: false))
    }

    /* A Pro Max on its side is regular width and as wide as the inner display, but short. */
    @Test func aLargeIPhoneOnItsSideKeepsTheTabBar() {
        #expect(!RoomBeside.fits(width: 956, regularHeight: false))
    }

    @Test func halfOfTheInnerDisplayInSplitViewKeepsTheTabBar() {
        #expect(!RoomBeside.fits(width: 951 / 2, regularHeight: true))
    }
}
