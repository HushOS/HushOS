import CoreGraphics

/*
 * What a window has room for beside the screen. The tabs go in a sidebar wherever both size
 * classes are regular: iPhone Duo's inner display either way up and an iPad; the outer display
 * and every iPhone (a Pro Max on its side is regular width but compact height) keep the tab bar.
 * Info goes in a column beside the list only where the window is wide enough for the list to
 * keep its width beside it (the inner display on its side, 951 points; upright it is 669 and
 * Info stays a sheet), and only where the height is regular too.
 */
public enum RoomBeside {
    /* The narrowest window where Info sits beside the list rather than over it. */
    public static let infoWidth: CGFloat = 900

    public static func sidebar(regularWidth: Bool, regularHeight: Bool) -> Bool {
        regularWidth && regularHeight
    }

    public static func info(width: CGFloat, regularHeight: Bool) -> Bool {
        regularHeight && width >= infoWidth
    }
}

/*
 * The sidebar around Info beside the list, on the inner display on its side: opening Info folds
 * the sidebar away so the list keeps its width, and closing Info brings it back only if it was
 * showing when Info opened. Someone who had collapsed it, or who opened it again while Info was
 * up, keeps what they chose.
 */
public struct SidebarAroundInfo: Equatable, Sendable {
    private var restore = false

    public init() {}

    /* Info opened beside the list; `shown`: the sidebar is showing. Returns whether to hide it now. */
    public mutating func infoOpened(sidebarShown shown: Bool) -> Bool {
        restore = shown
        return shown
    }

    /* Info closed (or moved to a sheet). Returns whether to show the sidebar again. */
    public mutating func infoClosed(sidebarShown shown: Bool) -> Bool {
        defer { restore = false }
        return restore && !shown
    }
}
