/*
 * The item Info shows beside the list (iPhone Duo's inner display on its side, an iPad), kept in
 * step with what the drive knows now: a rename or a move here or on another device shows at
 * once, and once the item is trashed, deleted or drops out of every list the store holds, Info
 * closes rather than offer actions on something that is gone. An item the store never listed
 * (a share's top folder, which only the Shared tab holds) stays as it was opened: there is
 * nothing newer to follow, and its absence says nothing about it being gone.
 */
public struct InfoFollow: Equatable, Sendable {
    public private(set) var item: Opened
    /* The store has listed this item since Info opened: from then on, missing means gone. */
    private var listed: Bool

    /* `current`: what the store knows of the item right now (nil when it lists nothing by its id); nil when it is already gone. */
    public init?(_ item: Opened, current: Opened?) {
        self.item = item
        self.listed = false
        guard let next = following(current) else { return nil }
        self = next
    }

    /* Info after the store changed: the newer record, or nil to close. */
    public func following(_ current: Opened?) -> InfoFollow? {
        guard let current else { return listed ? nil : self }
        guard current.id == item.id, current.node.trashedAt == nil else { return nil }
        var next = self
        next.item = current
        next.listed = true
        return next
    }
}
