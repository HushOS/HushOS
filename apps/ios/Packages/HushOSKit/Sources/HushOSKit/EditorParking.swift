import Foundation

/*
 * The open editor's work, held by the store rather than by the screens. Unfolding an iPhone Duo or
 * widening a window turns the tabs into a sidebar (MainView's defaultTabBarPlacement), which replaces the
 * tabs' controllers: what they presented is torn down, with no chance to save anything on the way out, and
 * SwiftUI presents the viewer again, new. The viewer finds the editor's work here and presents it again;
 * the editor takes the same text view back, with its text, cursor, scroll and undo. Only in memory, only
 * for the session (the vault) it was held under, and until this person's access to the file is confirmed lost: a
 * Close, a sign-out, another session or a loss of access (a family's removal, a share revoked) lets it go
 * (DriveStore), and nothing is kept on the phone. One editor's work at a time: a new one is never opened
 * over work not yet taken back (the viewer presents that one first).
 */
@MainActor public final class EditorParking<Owner: AnyObject, Value: AnyObject> {
    private struct Held {
        let owner: ObjectIdentifier
        let key: NodeRef
        let value: Value
    }

    private var current: Held?
    /* Whether the held work's editor is on screen now, or parked while the screens are rebuilt. */
    public private(set) var presented = false

    public init() {}

    /* The editor of `key` is open (on screen) under `owner`: its work is held here, replacing any other. */
    public func hold(_ value: Value, key: NodeRef, owner: Owner) {
        current = Held(owner: ObjectIdentifier(owner), key: key, value: value)
        presented = true
    }

    /* The editor's screen was torn down without a close (an unfold): its work waits, parked. */
    public func park(key: NodeRef) {
        if current?.key == key { presented = false }
    }

    /*
     * The work held for `key` under `owner`, for the editor presented again; nil for another file. Work held
     * under another session, or for a file whose access is now confirmed lost, is let go (and handed to `dropped`
     * to be emptied and closed), never handed over. Access that couldn't be confirmed keeps it (EditAccess).
     */
    public func held(key: NodeRef, owner: Owner, access: (NodeRef, Value) -> EditAccess = { _, _ in .allowed },
                     dropped: (Value) -> Void = { _ in }) -> Value? {
        guard let work = waiting(owner: owner, access: access, dropped: dropped) else { return nil }
        return work.key == key ? work.value : nil
    }

    /* Whatever work waits under `owner` and isn't lost, whichever file: the viewer presents it before any other editor. */
    public func waiting(owner: Owner, access: (NodeRef, Value) -> EditAccess = { _, _ in .allowed },
                        dropped: (Value) -> Void = { _ in }) -> (key: NodeRef, value: Value)? {
        guard let current else { return nil }
        guard current.owner == ObjectIdentifier(owner), access(current.key, current.value) != .lost else {
            self.current = nil
            presented = false
            dropped(current.value)
            return nil
        }
        return (current.key, current.value)
    }

    /*
     * Access changed (a family's removal, a share revoked, or a refresh that couldn't tell): work whose access is
     * confirmed lost goes now, on screen or parked; work whose access couldn't be confirmed stays, text and all.
     * Returns what went and whether its editor was on screen (which must then end; parked, its close is the
     * caller's to finish).
     */
    @discardableResult public func check(access: (NodeRef, Value) -> EditAccess) -> (value: Value, presented: Bool)? {
        guard let current, access(current.key, current.value) == .lost else { return nil }
        self.current = nil
        let wasPresented = presented
        presented = false
        return (current.value, wasPresented)
    }

    /* The editor of `key` ended on purpose (Close, Discard, Done): its work goes. */
    @discardableResult public func release(key: NodeRef) -> Value? {
        guard let current, current.key == key else { return nil }
        self.current = nil
        presented = false
        return current.value
    }

    /* The session ended (a sign-out, another session): nothing stays. Returns what was held, to be emptied. */
    @discardableResult public func drop() -> Value? {
        let value = current?.value
        current = nil
        presented = false
        return value
    }

    public var isEmpty: Bool { current == nil }
}

/*
 * One editor's work as the store holds it: the file it was opened on, the text view's box, and either the
 * state the editor had (taken back as it was) or, after Open theirs, the version being read in its place
 * (read again, never the old baseline over an emptied box).
 */
@MainActor public final class ParkedEdit<Box: AnyObject, State> {
    public let file: Opened
    public let box: Box
    /* The share that let this person edit `file` when Edit was chosen (its id); nil for their own file or a family's. */
    public let grant: String?
    public private(set) var state: State?
    public private(set) var reloadFrom: Opened?

    public init(file: Opened, box: Box, grant: String? = nil) {
        self.file = file
        self.box = box
        self.grant = grant
    }

    /* What the editor shows now. */
    public func remember(_ state: State) {
        self.state = state
        reloadFrom = nil
    }

    /* Open theirs: the old text and its baseline are gone, and `file` is being read in their place. */
    public func reload(from file: Opened) {
        state = nil
        reloadFrom = file
    }

    public enum Restore {
        /* Take the editor's state back as it was. */
        case adopt(State)
        /* Read this version afresh, as Open theirs was doing. */
        case read(Opened)
        /* Nothing to take back: open the file as new. */
        case fresh
    }

    public var restore: Restore {
        if let state { return .adopt(state) }
        if let reloadFrom { return .read(reloadFrom) }
        return .fresh
    }
}

/*
 * Whether held editor work may stay, as this phone knows access now. Only a confirmed loss empties it: the share that
 * let this person edit is gone from a listing that answered, or now a viewer's; the file's family removed. A refresh
 * that couldn't tell (the share listed but its folder not opened, its guard unreadable, a network error, a family
 * folder not writable here right now) keeps the text and stops saves until access is confirmed again.
 */
public enum EditAccess: Sendable, Equatable {
    case allowed
    case uncertain
    case lost

    /* One share as the last listing that answered had it: its id, its role, and whether its folder opened. */
    public struct Grant: Sendable, Equatable {
        public let id: String
        public let role: String
        public let opened: Bool
        public init(id: String, role: String, opened: Bool) {
            self.id = id
            self.role = role
            self.opened = opened
        }
    }

    /*
     * A file edited through the share `grant` (nil when none was recorded). `listing`: the shares the last listing that
     * answered held, nil before one has.
     */
    public static func share(grant: String?, listing: [Grant]?) -> EditAccess {
        guard let grant, let listing else { return .uncertain }
        guard let held = listing.first(where: { $0.id == grant }) else { return .lost }
        guard held.opened else { return .uncertain }
        return held.role == "editor" ? .allowed : .lost
    }

    /*
     * A family folder's file: its family removed (the server said so, or the member list forked or refused it) is a
     * loss; otherwise the folder's write verdict now, the same one that offers Edit.
     */
    public static func family(removed: Bool, writable: Bool) -> EditAccess {
        if removed { return .lost }
        return writable ? .allowed : .uncertain
    }
}
