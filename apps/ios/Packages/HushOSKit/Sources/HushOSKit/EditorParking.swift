import Foundation

/*
 * The open editor's work, held by the store rather than by the screens. Unfolding an iPhone Duo or widening a
 * window turns the tabs into a sidebar (MainView's defaultTabBarPlacement), which replaces the tabs' controllers:
 * what they presented is torn down, with no chance to save anything on the way out, and SwiftUI presents the
 * viewer again, new. The viewer finds the editor's work here and presents it again; the editor takes the same text
 * view back, with its text, cursor, scroll and undo. Only in memory, only for the session (the vault) it was held
 * under: a Close, a sign-out or another session lets it go (DriveStore), and nothing is kept on the phone.
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

    /* The work held for `key` under `owner`, for the editor presented again; nil for another file. Work held under
     * another session is let go, never handed over. */
    public func held(key: NodeRef, owner: Owner) -> Value? {
        guard let current else { return nil }
        guard current.owner == ObjectIdentifier(owner) else {
            self.current = nil
            return nil
        }
        return current.key == key ? current.value : nil
    }

    /* The editor of `key` ended on purpose (Close, Discard, a family's removal): its work goes. */
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
