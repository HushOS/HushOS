import Foundation

/*
 * The folder last added to: where Save to HushOS and the Home Screen quick actions put
 * things next (falling back to Files when it is gone), as Android keeps it. An id and a
 * name, both the account's, kept in the app group so the share extension reads the same
 * one, and forgotten with the rest of the account (AccountStore).
 */
public enum Places {
    public struct Folder: Codable, Hashable, Sendable {
        public init(id: String, name: String) {
            self.id = id
            self.name = name
        }

        public let id: String
        public let name: String
    }

    /* A JSON file beside the kept-file lists, out of backups (`Unbacked`); an earlier version used the group's defaults. */
    static let file = "last-folder.json"

    public static func last() -> Folder? { Unbacked.read(Folder.self, file) }

    public static func used(_ id: String, name: String) { Unbacked.write(Folder(id: id, name: name), file) }

    public static func forget() { Unbacked.write(nil as Folder?, file) }
}
