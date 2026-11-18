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
     * carriage return (which would make it read-only next time).
     */
    public static func lineFeeds(_ inserted: String) -> String {
        guard inserted.contains("\r") else { return inserted }
        return inserted.replacingOccurrences(of: "\r\n", with: "\n").replacingOccurrences(of: "\r", with: "\n")
    }
}

/* What a save did: a new version (its id, when the reply names one), or someone else's version is current (nil: the file is gone). */
public enum TextSaved: Equatable, Sendable {
    case saved(Opened)
    case stale(currentVersionId: String?)
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
     * Save, and Save on top: a new version of `file` holding `text`, unless the file moved on from
     * `startedFrom` (Save on top passes the version that is current now). Planned as its UTF-8 bytes
     * with no thumbnail, signed as the person's own writing.
     */
    public static func version(_ text: String, of file: Opened, in folder: Opened, startedFrom: String?, start: Start) async throws -> TextSaved {
        let bytes = TextEditing.encode(text)
        let run = try await start([file], [.known(size: UInt64(bytes.count), thumbnail: false)])
        let saved = try await run.version(bytes, of: file, in: folder, startedFrom: startedFrom, sources: .ownWriting, mime: file.metadata.mime)
        // Its only result is in, saved or not: the row goes. One this phone couldn't update stays for the next open,
        // which finds nothing to delete.
        try? await run.finish()
        switch saved {
        case .saved(let landed): return .saved(landed)
        case .stale(let current): return .stale(currentVersionId: current)
        }
    }

    /* Save as a copy: a new file beside `file` under the next free name, signed as `file` is (`sources`). */
    public static func copy(_ text: String, of file: Opened, in folder: Opened, sources: SaveSources, start: Start) async throws -> Opened {
        let bytes = TextEditing.encode(text)
        let run = try await start([folder], [.known(size: UInt64(bytes.count), thumbnail: false)])
        let made = try await run.file(bytes, name: file.name, mime: file.metadata.mime, sources: sources, in: folder)
        try? await run.finish()
        return made
    }
}

extension Vault {
    /*
     * The file's folder and the file as the server lists them now, in the file's own workspace
     * (never the own drive's row of the same id): what a save writes into, and the version that is
     * current. The file is nil when it is no longer in its folder.
     */
    public func editTarget(_ file: Opened) async throws -> (folder: Opened, file: Opened?) {
        guard let parent = file.node.parentId else { throw DriveAPIError.notFound("This file isn’t in a folder.") }
        let listing = try await listChildren(of: parent, in: file.node.workspaceId)
        let folder = try open(listing.folder, replacing: true)
        let row = listing.children.first { $0.id == file.id }
        return (folder, try row.map { try open($0, replacing: true) })
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
