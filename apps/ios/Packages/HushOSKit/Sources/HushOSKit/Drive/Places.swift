import Foundation

/*
 * The folder last added to: where Save to HushOS and the Home Screen quick actions put
 * things next (falling back to Files when it is gone), as Android keeps it. An id and a
 * name, both the account's, kept in the app group so the share extension reads the same
 * one, and forgotten with the rest of the account (AccountStore).
 */
public enum Places {
    /* A folder; one in a family folder also names its family and the family folder's workspace (both or neither). */
    public struct Folder: Codable, Hashable, Sendable {
        public init(id: String, name: String, groupId: String? = nil, workspaceId: String? = nil) {
            self.id = id
            self.name = name
            self.groupId = groupId
            self.workspaceId = workspaceId
        }

        public let id: String
        public let name: String
        public let groupId: String?
        public let workspaceId: String?

        /* The family upload's family, for a family folder; nil for one of your own drive. */
        public var family: FamilyUpload.Family? {
            guard let groupId, let workspaceId else { return nil }
            return FamilyUpload.Family(groupId: groupId, workspaceId: workspaceId)
        }

        /* Half a family's (an older write, a torn one) is no family folder, and never one of your own drive either. */
        var whole: Bool { (groupId == nil) == (workspaceId == nil) }
    }

    /* A JSON file beside the kept-file lists, out of backups (`Unbacked`); an earlier version used the group's defaults. */
    static let file = "last-folder.json"

    public static func last() -> Folder? { Unbacked.read(Folder.self, file).flatMap { $0.whole ? $0 : nil } }

    public static func used(_ id: String, name: String) { used(Folder(id: id, name: name)) }

    public static func used(_ folder: Folder) { Unbacked.write(folder, file) }

    public static func forget() { Unbacked.write(nil as Folder?, file) }
}
