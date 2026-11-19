import Foundation

/*
 * The open editor's work, held by the store rather than by the screens. Unfolding an iPhone Duo or
 * widening a window turns the tabs into a sidebar (MainView's defaultTabBarPlacement), which replaces the
 * tabs' controllers: what they presented is torn down, with no chance to save anything on the way out, and
 * SwiftUI presents the viewer again, new. The viewer finds the editor's work here and presents it again;
 * the editor takes the same text view back, with its text, cursor, scroll and undo. Only in memory, only
 * for the session (the vault) it was held under, and only while this person may still edit the file: a
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

    public init() {}

    /* The editor of `key` is open under `owner`: its work is held here, replacing any other. */
    public func hold(_ value: Value, key: NodeRef, owner: Owner) {
        current = Held(owner: ObjectIdentifier(owner), key: key, value: value)
    }

    /*
     * The work held for `key` under `owner`, for the editor presented again; nil for another file. Work held
     * under another session, or for a file `allowed` now refuses, is let go (and handed to `dropped` to be
     * emptied), never handed over.
     */
    public func held(key: NodeRef, owner: Owner, allowed: (NodeRef, Value) -> Bool = { _, _ in true },
                     dropped: (Value) -> Void = { _ in }) -> Value? {
        guard let work = waiting(owner: owner, allowed: allowed, dropped: dropped) else { return nil }
        return work.key == key ? work.value : nil
    }

    /* Whatever work waits under `owner` and is still allowed, whichever file: the viewer presents it before any other editor. */
    public func waiting(owner: Owner, allowed: (NodeRef, Value) -> Bool = { _, _ in true },
                        dropped: (Value) -> Void = { _ in }) -> (key: NodeRef, value: Value)? {
        guard let current else { return nil }
        guard current.owner == ObjectIdentifier(owner), allowed(current.key, current.value) else {
            self.current = nil
            dropped(current.value)
            return nil
        }
        return (current.key, current.value)
    }

    /* Access changed (a family's removal, a share revoked): work for a file `allowed` refuses goes now, presented or not. */
    @discardableResult public func check(allowed: (NodeRef, Value) -> Bool) -> Value? {
        guard let current, !allowed(current.key, current.value) else { return nil }
        self.current = nil
        return current.value
    }

    /* The editor of `key` ended on purpose (Close, Discard, Done): its work goes. */
    @discardableResult public func release(key: NodeRef) -> Value? {
        guard let current, current.key == key else { return nil }
        self.current = nil
        return current.value
    }

    /* The session ended (a sign-out, another session): nothing stays. Returns what was held, to be emptied. */
    @discardableResult public func drop() -> Value? {
        let value = current?.value
        current = nil
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
    public private(set) var state: State?
    public private(set) var reloadFrom: Opened?

    public init(file: Opened, box: Box) {
        self.file = file
        self.box = box
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
