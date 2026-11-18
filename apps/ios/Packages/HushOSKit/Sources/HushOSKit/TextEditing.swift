import Foundation
import HushOSCore

/*
 * Editing 1a on the phone (docs/editing-design.md sections 1 and 3, the web's lib/text-edit.ts and
 * lib/text-save.ts): which files the text editor opens, whether it may change them, and how a save
 * goes through the save path (SaveRuns.swift), never a second one.
 *
 * A file opens for editing only when what the editor saves is the file byte for byte except for the
 * edit: the core decides (text_edit.rs, held to the web by fixtures/text-edit-cases.json). Anything
 * else opens read-only with a note.
 */
public enum TextEditing {
    /* The largest file the editor opens for editing (8 MiB, the web's text preview limit). */
    public static var limit: UInt64 { textEditLimit() }

    /* A file the editor opens, by its name and recorded type (the bytes decide after that). */
    public static func opens(name: String, mime: String?) -> Bool { textEditableKind(name: name, mime: mime) }

    public static func opens(_ item: Opened) -> Bool {
        !item.isFolder && item.node.currentVersion != nil && opens(name: item.name, mime: item.metadata.mime)
    }

    /*
     * A file of no kind the editor knows by name whose bytes read as text (an extensionless README):
     * offered Edit as the web's viewer offers it after its sniff. Text the editor can't keep exactly
     * still opens, read-only, with its note; binary and other encodings don't.
     */
    /*
     * The same for a file on this phone, read no further than the editor would take (limit + 1 bytes):
     * a file of unknown size is never read whole to find out.
     */
    public static func readsAsText(fileAt url: URL) -> Bool {
        guard let handle = try? FileHandle(forReadingFrom: url) else { return false }
        defer { try? handle.close() }
        // nil is a clean end of file (an empty file); a read that fails is no answer, and says no. (Not `try?`, which would
        // fold the two together.)
        let bytes: Data
        do { bytes = try handle.read(upToCount: Int(limit) + 1) ?? Data() } catch { return false }
        guard UInt64(bytes.count) <= limit else { return false }
        return readsAsText(bytes)
    }

    public static func readsAsText(_ bytes: Data) -> Bool {
        switch textReadOnly(bytes: bytes) {
        case nil, .lineEndings, .byteOrderMark: true
        default: false
        }
    }

    /* What each read-only reason says, in the web's words. */
    public static func words(_ reason: TextReadOnly) -> String {
        switch reason {
        case .tooLarge: "This file is too large to edit here."
        case .byteOrderMark, .utf16: "HushOS can’t edit this file’s encoding yet."
        case .encoding: "This file uses an encoding HushOS can’t edit without changing it."
        case .binary: "This file isn’t plain text, so it can’t be edited here."
        case .lineEndings: "This file uses Windows line endings, which HushOS can’t edit yet."
        }
    }

    public enum Open: Equatable, Sendable {
        case editable(String)
        /* The text is shown when it decodes (never past the limit, never binary), and never saved. */
        case readOnly(TextReadOnly, String?)
    }

    /* The bytes as the editor holds them. */
    public static func open(_ data: Data) -> Open {
        if let reason = textReadOnly(bytes: data) {
            switch reason {
            case .tooLarge, .binary, .utf16: return .readOnly(reason, nil)
            default: return .readOnly(reason, String(decoding: data, as: UTF8.self))
            }
        }
        // Checked valid UTF-8 by the core, so this decodes every byte as it is.
        return .editable(String(decoding: data, as: UTF8.self))
    }

    /* What a save writes: the text as UTF-8, nothing added, nothing taken away. */
    public static func encode(_ text: String) -> Data { Data(text.utf8) }

    /*
     * A line break typed or pasted into the system's text view, as the editor keeps it: CRLF and a
     * lone CR become LF, as CodeMirror does on the web, so a file the editor wrote never holds a
     * carriage return (which would make it read-only next time). Looked for as a byte: Swift takes
     * "\r\n" for one Character, so a Character search for "\r" never finds it there.
     */
    public static func lineFeeds(_ inserted: String) -> String {
        guard hasCarriageReturn(inserted) else { return inserted }
        return inserted.replacingOccurrences(of: "\r\n", with: "\n").replacingOccurrences(of: "\r", with: "\n")
    }

    public static func hasCarriageReturn(_ text: String) -> Bool { text.utf8.contains(13) }

    /* Whether two texts are the same bytes: String's == takes "é" and "e" + U+0301 for equal, which a save must not. */
    public static func same(_ a: String, _ b: String) -> Bool { a.utf8.elementsEqual(b.utf8) }

    /* The save's session ended (the screen closed, another sign-in): nothing was started. */
    public struct SessionEnded: Error, Equatable {}

    /* Why a listing can't stand for the file's folder: it answered for another folder or another workspace. */
    public struct WrongFolder: Error, Equatable, WordedError {
        public init() {}
        public var errorDescription: String? { "HushOS answered with a different folder than this file’s. Nothing was saved." }
    }

    /*
     * The file's folder and the file in a listing asked for by the file's own folder and workspace,
     * or WrongFolder when the listing answers for another: a save never goes into a folder the editor
     * didn't open the file from. The file is the row with its id in that same workspace and folder,
     * or nil when it is no longer there.
     */
    /*
     * The folder and file as the vault opened them, held to the editor's file again: the folder must be the
     * file's own (else WrongFolder); a file row the vault swapped for one elsewhere (moved since) is absent
     * from this folder, never adopted.
     */
    public static func held(folder: Opened, file: Opened?, for original: Opened) throws -> (folder: Opened, file: Opened?) {
        let workspace = original.node.workspaceId.lowercased()
        guard let parent = original.node.parentId, folder.id == parent, folder.isFolder,
              folder.node.workspaceId.lowercased() == workspace else { throw WrongFolder() }
        guard let file, file.id == original.id, !file.isFolder, file.node.workspaceId.lowercased() == workspace,
              file.node.parentId == parent else { return (folder, nil) }
        return (folder, file)
    }

    public static func target(in listing: Listing, for file: Opened) throws -> (folder: NodeView, file: NodeView?) {
        let workspace = file.node.workspaceId.lowercased()
        guard let parent = file.node.parentId, listing.folder.id == parent, listing.folder.isFolder,
              listing.folder.workspaceId.lowercased() == workspace else { throw WrongFolder() }
        let row = listing.children.first {
            $0.id == file.id && $0.workspaceId.lowercased() == workspace && $0.parentId == parent && !$0.isFolder
        }
        return (listing.folder, row)
    }
}

/*
 * One text editor's session (Editing 1a): the vault it opened under and which opened text is on
 * screen. Every save, copy and Open theirs takes a token before its first wait and asks it right
 * before a run starts and before anything it found reaches the screen: the editor closed, another
 * session (a sign-out and in, another account), or Open theirs since, and the work publishes nothing.
 */
@MainActor public final class EditSession<Owner: AnyObject> {
    public struct Token: @unchecked Sendable {
        /* The vault the work runs under: the one the editor opened with. */
        public let owner: Owner
        fileprivate let opening: Int
    }

    private var owner: Owner?
    private var opening = 0
    public private(set) var closed = false

    public init() {}

    /* A token for work beginning now under `current` (the store's vault); nil once closed or under another one. */
    public func take(_ current: Owner) -> Token? {
        if owner == nil { owner = current }
        guard !closed, let owner, owner === current else { return nil }
        return Token(owner: owner, opening: opening)
    }

    /* Whether work begun with `token` may go on: not closed, the same vault, the same opened text, its task not cancelled. */
    public func live(_ token: Token, current: Owner) -> Bool {
        !closed && !Task.isCancelled && owner === token.owner && token.owner === current && opening == token.opening
    }

    /* Another text opened (Open theirs): earlier work publishes nothing over it. */
    public func reopened() { opening += 1 }

    /* The editor closed, or its session ended: nothing of it goes on. */
    public func close() { closed = true }
}

/* What a save did: a new version, or someone else's version is current (nil: the file is gone). */
public enum TextSaved: Equatable, Sendable {
    /* `versionId`: the version this save published, as minted; nil when not known (the next save then asks the stale question). */
    case saved(Opened, versionId: String?)
    case stale(currentVersionId: String?)
}

/* A copy saved: the new file, and its version as minted (nil when not known). */
public struct TextCopy: Equatable, Sendable {
    public let file: Opened
    public let versionId: String?
}

/*
 * The editor's saves over the save path. `start` makes the run (SaveRun.start over the vault in the
 * app; a stand-in in tests).
 */
public enum TextSave {
    public typealias Start = @Sendable (_ targets: [Opened], _ results: [PlannedResult]) async throws -> SaveRun

    /* The app's runs: over the vault, with this account's journal. */
    public static func runs(_ writer: SaveRunWriter) -> Start {
        { targets, results in try await SaveRun.start(writer: writer, targets: targets, results: results) }
    }

    /*
     * Ends a run whose result is in: its row goes. A row this phone wouldn't update is asked again
     * (never the upload); past the tries the run is cancelled, which keeps what landed and lets the
     * run go, its row settled at the next open. Never throws: what was saved stays saved.
     */
    @discardableResult
    public static func end(_ run: SaveRun, tries: Int = 3, pause: @Sendable (Int) async -> Void = { try? await Task.sleep(for: .milliseconds(250 * $0)) }) async -> Bool {
        for attempt in 1 ... tries {
            do {
                try await run.finish()
                return true
            } catch {
                if attempt < tries { await pause(attempt) }
            }
        }
        _ = await run.cancel()
        return false
    }

    /*
     * Save, and Save on top: a new version of `file` holding `text`, unless the file moved on from
     * `startedFrom` (Save on top passes the version current now). Planned as its UTF-8 bytes with no
     * thumbnail, signed as the person's own writing.
     */
    public static func version(_ text: String, of file: Opened, in folder: Opened, startedFrom: String?, start: Start,
                               stillOn: @Sendable () async -> Bool = { true },
                               pause: (@Sendable (Int) async -> Void)? = nil) async throws -> TextSaved {
        let bytes = TextEditing.encode(text)
        // Asked last thing before the run starts: a save whose session ended uploads nothing.
        guard await stillOn() else { throw TextEditing.SessionEnded() }
        let run = try await start([file], [.known(size: UInt64(bytes.count), thumbnail: false)])
        // Starting waited (the room check, the run's record): asked again before any byte goes; the empty run retired.
        guard await stillOn() else {
            if let pause { await end(run, pause: pause) } else { await end(run) }
            throw TextEditing.SessionEnded()
        }
        let saved = try await run.version(bytes, of: file, in: folder, startedFrom: startedFrom, sources: .ownWriting, mime: file.metadata.mime)
        if let pause { await end(run, pause: pause) } else { await end(run) }
        switch saved {
        case .saved(let landed, let versionId): return .saved(landed, versionId: versionId)
        case .stale(let current): return .stale(currentVersionId: current)
        }
    }

    /* Save as a copy: a new file beside `file` under the next free name, signed as `file` is (`sources`). */
    public static func copy(_ text: String, of file: Opened, in folder: Opened, sources: SaveSources, start: Start,
                            stillOn: @Sendable () async -> Bool = { true },
                            pause: (@Sendable (Int) async -> Void)? = nil) async throws -> TextCopy {
        let bytes = TextEditing.encode(text)
        guard await stillOn() else { throw TextEditing.SessionEnded() }
        let run = try await start([folder], [.known(size: UInt64(bytes.count), thumbnail: false)])
        guard await stillOn() else {
            if let pause { await end(run, pause: pause) } else { await end(run) }
            throw TextEditing.SessionEnded()
        }
        let minted = MintedVersion()
        let made = try await run.file(bytes, name: file.name, mime: file.metadata.mime, sources: sources, in: folder, minted: minted)
        if let pause { await end(run, pause: pause) } else { await end(run) }
        return TextCopy(file: made, versionId: minted.id)
    }
}

/*
 * Who may edit an item seen through shares: the mount covering it, the nearest one up its own
 * workspace's folders (not the widest role anywhere in the workspace). A file shared on its own (the
 * mount is the file itself) isn't edited: its folder can't be listed, and a save needs it.
 */
public enum EditRights {
    /*
     * Whether this person may change an item that isn't a family folder's: their own only when their own
     * workspace is known and is the item's (never assumed before it loads), otherwise through an editor's
     * mount covering it (mayEditShared).
     */
    public static func mayEdit(itemId: String, workspaceId: String, own: String?, roots: [String: String], parent: (String) -> String?) -> Bool {
        if let own, own.lowercased() == workspaceId.lowercased() { return true }
        return mayEditShared(itemId: itemId, roots: roots, parent: parent)
    }

    /*
     * `roots`: the mounts in the item's workspace, by root id, with their roles. `parent`: an item's
     * parent within that same workspace, or nil when not known. True only for an editor's mount that
     * is a folder above the item.
     */
    public static func mayEditShared(itemId: String, roots: [String: String], parent: (String) -> String?) -> Bool {
        // The nearest grant decides the role (the item's own first); a grant on a folder above must exist too, or its
        // folder can't be listed for a save.
        var role: String?
        var folderAbove = false
        var cursor: String? = itemId
        var steps = 0
        while let id = cursor, steps < 256 {
            if let here = roots[id] {
                role = role ?? here
                if id != itemId { folderAbove = true; break }
            }
            cursor = parent(id)
            steps += 1
        }
        return role == "editor" && folderAbove
    }
}

extension Vault {
    /*
     * The file's folder and the file as the server lists them now, in the file's own workspace and
     * folder (TextEditing.target refuses a listing that answers for another): what a save writes into,
     * and the version that is current. The file is nil when it is no longer in its folder.
     */
    public func editTarget(_ file: Opened) async throws -> (folder: Opened, file: Opened?) {
        guard let parent = file.node.parentId else { throw DriveAPIError.notFound("This file isn’t in a folder.") }
        let listing = try await listChildren(of: parent, in: file.node.workspaceId)
        let (folder, row) = try TextEditing.target(in: listing, for: file)
        // Checked again as opened: opening may hand back a newer row this vault holds (one moved since), never the listing's.
        return try TextEditing.held(folder: try open(folder, replacing: true), file: try row.map { try open($0, replacing: true) }, for: file)
    }

    /*
     * The bytes of `file`'s version, the one its row names, read in its own workspace (its key by its
     * ref) into memory: never a copy on disk, never a kept copy of whatever version that happens to be,
     * at most `limit` + 1 bytes. A sign-out (the task cancelled) stops the read.
     */
    public func editBytes(_ file: Opened, limit: UInt64) async throws -> Data {
        let control = RunControl(watchdogMillis: toolWatchdogMillis(), clock: nil)
        defer { control.finish() }
        let reader = try await toolReader(file, control: control)
        let length = min(reader.size(), limit + 1)
        return try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { (done: CheckedContinuation<Data, Error>) in
                // On a thread of its own: the core's reads wait on the network (StoreSource), never on the cooperative pool.
                let thread = Thread { done.resume(with: Result { try reader.readAt(offset: 0, length: length) }) }
                thread.stackSize = 8 << 20
                thread.start()
            }
        } onCancel: {
            control.cancel()
        }
    }

    /*
     * What a copy of `file` is signed with: its records' verdicts as a copy across takes them (a family
     * folder's by its member list), so an Unverified file's copy stays Unverified.
     */
    public func copySources(of file: Opened) async throws -> SaveSources {
        guard let version = file.node.currentVersion else { throw DriveAPIError.notFound("This file has no content yet.") }
        if isFamilyWorkspace(file.node.workspaceId) {
            let metadata = try await familyPrior(FamilySync.metadataRecord(of: file.node), in: file.node.workspaceId, copying: true)
            let current = try await familyPrior(FamilySync.versionRecord(version, of: file.node), in: file.node.workspaceId, copying: true)
            return .from([.file(metadata: metadata, version: current, fromLink: false)])
        }
        let trusted = try await copySigners()
        return .from([.file(metadata: trusted.metadata(of: file.node), version: trusted.version(version, of: file.node), fromLink: false)])
    }
}
