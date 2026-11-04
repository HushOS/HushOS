import CoreGraphics
import Testing
@testable import HushOSKit

/*
 * The tabs are a sidebar wherever both size classes are regular (the inner display either way
 * up, an iPad), and never on the outer display or any other iPhone, a Pro Max on its side
 * included. Info goes beside the list only where the list keeps its width beside it.
 */
@Suite struct RoomBesideTests {
    @Test func theInnerDisplayGetsTheSidebarEitherWayUp() {
        #expect(RoomBeside.sidebar(regularWidth: true, regularHeight: true))
    }

    @Test func theOuterDisplayNeverGetsTheSidebar() {
        // Upright: compact width. On its side (678 points): compact both ways.
        #expect(!RoomBeside.sidebar(regularWidth: false, regularHeight: true))
        #expect(!RoomBeside.sidebar(regularWidth: false, regularHeight: false))
    }

    /* A Pro Max on its side is regular width but short. */
    @Test func aProMaxOnItsSideNeverGetsTheSidebar() {
        #expect(!RoomBeside.sidebar(regularWidth: true, regularHeight: false))
    }

    @Test func infoSitsBesideTheListOnlyOnTheInnerDisplayOnItsSide() {
        #expect(RoomBeside.info(width: 951, regularHeight: true))
        #expect(!RoomBeside.info(width: 669, regularHeight: true))
        #expect(!RoomBeside.info(width: 956, regularHeight: false))
        #expect(!RoomBeside.info(width: 951 / 2, regularHeight: true))
    }
}

/* Opening Info on its side folds the sidebar away; closing it brings back only what the person had. */
@Suite struct SidebarAroundInfoTests {
    @Test func aShowingSidebarFoldsAwayForInfoAndComesBack() {
        var rule = SidebarAroundInfo()
        let hide = rule.infoOpened(sidebarShown: true)
        let show = rule.infoClosed(sidebarShown: false)
        #expect(hide && show)
    }

    @Test func aSidebarThePersonCollapsedStaysCollapsed() {
        var rule = SidebarAroundInfo()
        let hide = rule.infoOpened(sidebarShown: false)
        let show = rule.infoClosed(sidebarShown: false)
        #expect(!hide && !show)
    }

    /* They opened it again while Info was up: it is already showing, nothing to undo. */
    @Test func aSidebarReopenedDuringInfoIsLeftAlone() {
        var rule = SidebarAroundInfo()
        _ = rule.infoOpened(sidebarShown: true)
        let show = rule.infoClosed(sidebarShown: true)
        #expect(!show)
    }

    /* Each opening decides afresh: a restore from an earlier Info never leaks into the next. */
    @Test func aRestoreIsUsedOnce() {
        var rule = SidebarAroundInfo()
        _ = rule.infoOpened(sidebarShown: true)
        _ = rule.infoClosed(sidebarShown: false)
        let again = rule.infoClosed(sidebarShown: false)
        #expect(!again)
    }
}
