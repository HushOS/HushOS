import Foundation

/*
 * How Save to HushOS (the share extension) hands an upload to the app. The extension
 * seals the file into the app group's transfers folder, as the app's own queue does,
 * gives the parts to its own background session (iOS keeps sending them after the
 * extension closes), and leaves this note beside the parts. The app adopts the note
 * into its queue, which shows it in the transfers list and the Live Activity and
 * finishes it once every part has landed.
 *
 * The two processes never write the same file: the extension writes the note and one
 * small file per landed part ("etag-<n>"); the app only reads them and removes them as
 * it takes them in. When the extension is gone before the parts land, iOS wakes the
 * app for the extension's session instead, and the app's own delegate takes the rest.
 *
 * A note is held while the extension's sheet is open: a small file often lands in that
 * time, and the extension finishes it itself and removes the note (the app might never
 * be woken for it otherwise). Then it releases the rest. The app adopts a released note
 * at once, and a held one only when it is old enough that the extension must be gone.
 */
public struct ShareHandoff: Codable, Sendable, Equatable {
    /* The extension's background session; the app connects to it too, to take what lands after the extension closed. */
    public static let sessionIdentifier = "com.hushos.app.transfers.share"

    public let id: UUID
    public let name: String
    public let folderId: String
    public let mime: String?
    public let size: Int64?
    public let sealed: Vault.SealedUpload
    /* The extension is done with it; until then only the extension may finish it. */
    public var released = false

    public init(id: UUID, name: String, folderId: String, mime: String?, size: Int64?, sealed: Vault.SealedUpload) {
        self.id = id
        self.name = name
        self.folderId = folderId
        self.mime = mime
        self.size = size
        self.sealed = sealed
    }

    /* The queue's folder in the app group, the same one BackgroundTransfers keeps. */
    public static var transfers: URL {
        let group = FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: SharedKeychain.accessGroup)
            ?? FileManager.default.temporaryDirectory
        return group.appendingPathComponent("transfers", isDirectory: true)
    }

    public static func directory(_ id: UUID) -> URL { transfers.appendingPathComponent(id.uuidString, isDirectory: true) }

    private static func note(_ id: UUID) -> URL { directory(id).appendingPathComponent("handoff.json") }

    /* Written once the parts are sealed on disk, before they go to the session; written again to release it. */
    public func write() throws {
        try JSONEncoder().encode(self).write(to: Self.note(id), options: .atomic)
    }

    /* Notes the app may adopt: released ones, and held ones older than any extension lives. */
    public static func waiting(now: Date = Date()) -> [ShareHandoff] {
        let folders = (try? FileManager.default.contentsOfDirectory(at: transfers, includingPropertiesForKeys: nil)) ?? []
        return folders.compactMap { folder in
            let file = folder.appendingPathComponent("handoff.json")
            guard let data = try? Data(contentsOf: file), let note = try? JSONDecoder().decode(ShareHandoff.self, from: data) else { return nil }
            if note.released { return note }
            let written = (try? file.resourceValues(forKeys: [.contentModificationDateKey]).contentModificationDate) ?? now
            return now.timeIntervalSince(written) > 120 ? note : nil
        }
    }

    /* Adopted: the note goes, so it is not adopted twice. */
    public static func adopted(_ id: UUID) { try? FileManager.default.removeItem(at: note(id)) }

    /* A part the extension saw land. */
    public static func landed(_ id: UUID, part: Int, etag: String) {
        try? Data(etag.utf8).write(to: directory(id).appendingPathComponent("etag-\(part)"), options: .atomic)
    }

    /* The parts the extension saw land since the last look, taken (their files removed). */
    public static func takeLanded(_ id: UUID) -> [Int: String] {
        let files = (try? FileManager.default.contentsOfDirectory(at: directory(id), includingPropertiesForKeys: nil)) ?? []
        var found: [Int: String] = [:]
        for file in files where file.lastPathComponent.hasPrefix("etag-") {
            guard let part = Int(file.lastPathComponent.dropFirst("etag-".count)),
                  let etag = try? String(contentsOf: file, encoding: .utf8), !etag.isEmpty else { continue }
            found[part] = etag
            try? FileManager.default.removeItem(at: file)
        }
        return found
    }
}
