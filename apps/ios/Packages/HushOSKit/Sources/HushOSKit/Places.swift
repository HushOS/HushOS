import Foundation

/*
 * The folder last added to: where Save to HushOS and the Home Screen quick actions put
 * things next (falling back to Files when it is gone), as Android keeps it. An id and a
 * name, both the account's, kept in the app group so the share extension reads the same
 * one, and forgotten with the rest of the account (AccountStore).
 */
public enum Places {
    public struct Folder: Hashable, Sendable {
        public init(id: String, name: String) {
            self.id = id
            self.name = name
        }

        public let id: String
        public let name: String
    }

    static let idKey = "places.lastFolder"
    static let nameKey = "places.lastFolderName"

    public static func last() -> Folder? {
        guard let id = Offline.defaults.string(forKey: idKey) else { return nil }
        return Folder(id: id, name: Offline.defaults.string(forKey: nameKey) ?? "Files")
    }

    public static func used(_ id: String, name: String) {
        Offline.defaults.set(id, forKey: idKey)
        Offline.defaults.set(name, forKey: nameKey)
    }

    public static func forget() {
        Offline.defaults.removeObject(forKey: idKey)
        Offline.defaults.removeObject(forKey: nameKey)
    }
}
