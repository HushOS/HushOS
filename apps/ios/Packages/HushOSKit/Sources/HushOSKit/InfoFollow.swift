/* Where a row stands now (`Vault.standing(of:)`), as far as this process can say. */
public enum RowStanding: Equatable, Sendable {
    /* Held and live: its current record. */
    case live(Opened)
    /* Held but not live: trashed, or a trashed folder above it in its own workspace. */
    case held
    /* It, or a folder above it, confirmed gone: trashed from here, a feed tombstone, a purge. */
    case removed
    /* Not held: dropped to be read again (a rotation, a re-read), or never opened in this process. */
    case absent
}

/* What Info does with its item now: show it live, keep showing it as last seen, look it up, or close. */
public enum InfoLookup: Equatable, Sendable {
    case show, hold, find, close

    /*
     * The same rule as Android's `infoLookup` (ui/Adaptive.kt), so the clients close Info on the same
     * events: a removal the server confirmed, or a workspace out of reach, closes; a live row shows;
     * a row held but not live closes; a row merely absent keeps what was shown, or is looked up once
     * when nothing was shown in this process.
     */
    public static func decide(live: Bool, held: Bool, removed: Bool, outOfReach: Bool, seen: Bool) -> InfoLookup {
        if outOfReach || removed { return .close }
        if live { return .show }
        if held { return .close }
        return seen ? .hold : .find
    }
}

/*
 * The item Info shows beside the list (iPhone Duo's inner display on its side, an iPad), kept in step
 * with what the drive knows: a rename or a move here or on another device shows at once; trashed or
 * deleted, here or elsewhere, a trashed folder above it included, Info closes rather than offer
 * actions on something gone. A row only being read again (a key rotation, a catalogue update) keeps
 * the last one shown.
 */
public struct InfoFollow: Equatable, Sendable {
    public private(set) var item: Opened
    /* A row of it has been shown in this process: from Info's own opening, from a row on screen. */
    private var seen = true

    public init(_ item: Opened) {
        self.item = item
    }

    /*
     * A received share has no feed here, and nothing that only closes Info may change what the vault holds:
     * the share's folder listed afresh without the item closes Info, a decision on the lists alone (main's
     * behaviour), and the vault keeps its row. `folderId`: the folder just listed; `children`: what it lists.
     */
    public func missing(from folderId: String, children: [Opened]) -> Bool {
        guard item.node.parentId?.lowercased() == folderId.lowercased() else { return false }
        return !children.contains { $0.ref == item.ref }
    }

    /* `outOfReach`: its workspace is neither this account's, a family's, nor among the shares just listed. */
    public mutating func update(_ standing: RowStanding, outOfReach: Bool) -> InfoLookup {
        var live: Opened?
        if case .live(let row) = standing, row.id == item.id { live = row }
        let step = InfoLookup.decide(live: live != nil, held: standing == .held, removed: standing == .removed, outOfReach: outOfReach, seen: seen)
        if step == .show, let live {
            item = live
            seen = true
        }
        return step
    }
}
