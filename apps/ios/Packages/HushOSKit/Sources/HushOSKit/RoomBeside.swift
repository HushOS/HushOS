import CoreGraphics

/*
 * Whether a window has room for columns beside the screen: the tabs as a sidebar and Info as a
 * column beside the list (iPhone Duo's inner display on its side, an iPad), or the tab bar and
 * Info as a sheet. Narrower, the system lays both over the screen instead: the sidebar starts
 * hidden behind a button in a navigation bar the app's screens don't show (each draws its own
 * header), which leaves no way between the tabs, and Info covers the list it describes. The
 * inner display upright is 669 points wide, on its side 951. A large iPhone on its side is as
 * wide but short (compact height) and stays the iPhone it is everywhere else.
 */
public enum RoomBeside {
    /* The narrowest window where the sidebar sits beside the screen rather than over it. */
    public static let width: CGFloat = 900

    /* `regularHeight`: the vertical size class is regular (the inner display either way, an iPad). */
    public static func fits(width available: CGFloat, regularHeight: Bool) -> Bool {
        regularHeight && available >= width
    }
}
