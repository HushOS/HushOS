import Foundation
import HushOSCore
import Testing
@testable import HushOSKit
#if canImport(UIKit)
import UIKit
#endif

/*
 * Editing 1a and 1b on the phone (TextEditing.swift). Which bytes open for editing, in which encoding
 * and line breaks, and what a save writes for an edited text, are held to the web's verdicts
 * (fixtures/text-edit-cases.json); a file that opens for editing comes back out of the system's text
 * storage byte for byte; and the editor's saves ask the save path the right things: a new version from
 * the version it opened, a refusal when someone else saved first, Save on top after theirs, Save as a
 * copy beside it under the next free name.
 */

private struct Part: Decodable { let hex: String; let repeatCount: Int?
    enum CodingKeys: String, CodingKey { case hex; case repeatCount = "repeat" }
}
private struct ByteCase: Decodable {
    let name: String; let bytes: [Part]; let reason: String?
    let encoding: String?; let lineEnding: String?; let mixed: Bool?; let text: String?
}
private struct EditCase: Decodable { let name: String; let bytes: [Part]; let text: String; let saved: [Part]? }
private struct TextPart: Decodable { let text: String; let repeatCount: Int?
    enum CodingKeys: String, CodingKey { case text; case repeatCount = "repeat" }
}
private struct SessionSave: Decodable { let text: [TextPart]; let saved: [Part] }
private struct SessionCase: Decodable { let name: String; let bytes: [Part]; let saves: [SessionSave] }
private struct NameCase: Decodable { let name: String; let mime: String?; let editable: Bool }
private struct Cases: Decodable { let bytes: [ByteCase]; let edits: [EditCase]; let sessions: [SessionCase]; let names: [NameCase] }

/* What a save of `text` writes from an editor just opened on `original`; nil when it opened read-only. */
private func saved(_ text: String, from original: Data) -> Data? { TextEditing.SaveState(opening: original)?.bytes(for: text) }

private let cases: Cases = {
    let data = try! Data(contentsOf: Checkout.file("crates/hushos-core/fixtures/text-edit-cases.json"))
    return try! JSONDecoder().decode(Cases.self, from: data)
}()

private func bytes(_ parts: [Part]) -> Data {
    var out = Data()
    for part in parts {
        var one = Data()
        var index = part.hex.startIndex
        while index < part.hex.endIndex {
            let next = part.hex.index(index, offsetBy: 2)
            one.append(UInt8(part.hex[index ..< next], radix: 16)!)
            index = next
        }
        for _ in 0 ..< (part.repeatCount ?? 1) { out.append(one) }
    }
    return out
}

private func word(_ reason: TextReadOnly) -> String {
    switch reason {
    case .tooLarge: "too-large"
    case .encoding: "encoding"
    case .binary: "binary"
    case .lineEndings: "line-endings"
    }
}

private func word(_ encoding: TextEncoding) -> String {
    switch encoding {
    case .utf8: "utf-8"
    case .utf8Bom: "utf-8-bom"
    case .utf16Le: "utf-16le"
    case .utf16Be: "utf-16be"
    }
}

private func word(_ ending: LineEnding) -> String {
    switch ending {
    case .lf: "lf"
    case .crlf: "crlf"
    }
}

@Suite struct TextEditingTests {
    @Test func everyByteCaseOpensAsTheWebOpensIt() {
        #expect(cases.bytes.count >= 40)
        for c in cases.bytes {
            switch TextEditing.open(bytes(c.bytes)) {
            case .editable(let text, let format):
                #expect(c.reason == nil, "\(c.name)")
                #expect(word(format.encoding) == c.encoding, "\(c.name)")
                #expect(word(format.lineEnding) == c.lineEnding, "\(c.name)")
                #expect(format.mixed == c.mixed, "\(c.name)")
                if let expected = c.text { #expect(TextEditing.same(text, expected), "\(c.name)") }
                #expect(!TextEditing.hasCarriageReturn(text), "\(c.name)")
            case .readOnly(let reason, _): #expect(word(reason) == c.reason, "\(c.name)")
            }
        }
    }

    /* What a save writes for an edited text: the file's encoding, byte order mark and line breaks, as on the web. */
    @Test func everyEditWritesWhatTheWebWrites() {
        #expect(cases.edits.contains { $0.saved == nil })
        for c in cases.edits {
            let original = bytes(c.bytes)
            #expect(saved(c.text, from: original) == c.saved.map(bytes), "\(c.name)")
            // As the text view holds a paste (TextEditing.lineFeeds, every break LF): the same bytes.
            #expect(saved(TextEditing.lineFeeds(c.text), from: original) == c.saved.map(bytes), "\(c.name) as typed")
        }
    }

    @Test func everyNameOpensInTheEditorAsOnTheWeb() {
        for c in cases.names { #expect(TextEditing.opens(name: c.name, mime: c.mime) == c.editable, "\(c.name)") }
    }

    /* A save changes only the edited bytes: what opened comes back out exactly, through the text view's own storage. */
    @Test func everyEditableCaseComesBackOutByteForByte() {
        for c in cases.bytes where c.reason == nil {
            let data = bytes(c.bytes)
            guard case .editable(let text, _) = TextEditing.open(data) else { Issue.record("\(c.name) should open"); continue }
            #expect(saved(text, from: data) == data, "\(c.name)")
            #if canImport(UIKit)
            // As UITextView holds it: an NSTextStorage, read back as its string.
            if data.count < 100_000 {
                let storage = NSTextStorage(string: text)
                #expect(saved(storage.string, from: data) == data, "\(c.name) through NSTextStorage")
            }
            #endif
        }
    }

    /* Every save of one session, the format kept from the open: past the limit and back, a CRLF file emptied and typed into. */
    @Test func everySaveOfASessionWritesWhatTheWebWrites() throws {
        #expect(cases.sessions.count >= 5)
        for c in cases.sessions {
            var state = try #require(TextEditing.SaveState(opening: bytes(c.bytes)), "\(c.name)")
            for (at, save) in c.saves.enumerated() {
                let text = save.text.map { String(repeating: $0.text, count: $0.repeatCount ?? 1) }.joined()
                let written = state.bytes(for: text)
                #expect(written == bytes(save.saved), "\(c.name), save \(at + 1)")
                state = state.saved(text, as: written)
            }
        }
    }

    @Test func anEditInMultibyteTextChangesOnlyThoseBytes() throws {
        let original = "Grüße 👋\nzweite Zeile\u{2028}noch\nohne Zeilenende"
        guard case .editable(let text, _) = TextEditing.open(Data(original.utf8)) else { Issue.record("should open"); return }
        let edited = text.replacingOccurrences(of: "zweite", with: "dritte ✓")
        let written = try #require(saved(edited, from: Data(original.utf8)))
        let at = Data("Grüße 👋\n".utf8).count
        var expected = Data(original.utf8)
        expected.replaceSubrange(at ..< at + 6, with: Data("dritte ✓".utf8))
        #expect(written == expected)
        #expect(written.last == UInt8(ascii: "e"))
    }

    @Test func aLineBreakTypedOrPastedIsLineFeed() {
        #expect(TextEditing.lineFeeds("a\r\nb\rc\n") == "a\nb\nc\n")
        #expect(TextEditing.lineFeeds("plain") == "plain")
    }

    /* A paste of nothing but a Windows line break: Swift's one Character "\r\n", which a Character search misses. */
    @Test func aPastedCRLFAloneIsLineFeed() {
        #expect(TextEditing.hasCarriageReturn("\r\n"))
        #expect(TextEditing.lineFeeds("\r\n") == "\n")
        #expect(TextEditing.lineFeeds("x\r\n") == "x\n")
    }

    @Test func aListingForAnotherFolderOrWorkspaceIsNeverTheFilesFolder() throws {
        let file = opened("doc", parent: "f", version: "v1")
        let row = file.node
        let folder = opened("f").node
        let found = try TextEditing.target(in: Listing(folder: folder, ancestors: [], children: [row], nextCursor: nil), for: file)
        #expect(found.folder.id == "f" && found.file?.id == "doc")
        #expect(throws: TextEditing.WrongFolder.self) {
            try TextEditing.target(in: Listing(folder: opened("g").node, ancestors: [], children: [row], nextCursor: nil), for: file)
        }
        #expect(throws: TextEditing.WrongFolder.self) {
            try TextEditing.target(in: Listing(folder: opened("f", workspace: "other").node, ancestors: [], children: [row], nextCursor: nil), for: file)
        }
        // The file's id in another workspace or another folder is not the file.
        let twin = opened("doc", parent: "f", version: "v1", workspace: "other").node
        let moved = opened("doc", parent: "g", version: "v1").node
        #expect(try TextEditing.target(in: Listing(folder: folder, ancestors: [], children: [twin, moved], nextCursor: nil), for: file).file == nil)
    }

    /* Opening may hand back a newer row the vault holds: one moved since is absent from this folder, never adopted. */
    @Test func aRowTheVaultSwappedForOneElsewhereIsNotTheFile() throws {
        let file = opened("doc", parent: "f", version: "v1")
        let folder = opened("f")
        #expect(try TextEditing.held(folder: folder, file: file, for: file).file?.id == "doc")
        let moved = opened("doc", parent: "g", version: "v2")
        #expect(try TextEditing.held(folder: folder, file: moved, for: file).file == nil)
        let twin = opened("doc", parent: "f", version: "v1", workspace: "other")
        #expect(try TextEditing.held(folder: folder, file: twin, for: file).file == nil)
        #expect(throws: TextEditing.WrongFolder.self) { try TextEditing.held(folder: opened("g"), file: file, for: file) }
        #expect(throws: TextEditing.WrongFolder.self) { try TextEditing.held(folder: opened("f", workspace: "other"), file: file, for: file) }
    }

    @Test func editRightsComeFromTheMountCoveringTheItem() {
        let parents = ["doc": "inner", "inner": "viewed", "viewed": "edited", "edited": "top"]
        let parent = { (id: String) in parents[id] }
        // Under a folder shared to view, inside one shared to edit: the nearer one decides.
        #expect(!EditRights.mayEditShared(itemId: "doc", roots: ["viewed": "viewer", "edited": "editor"], parent: parent))
        #expect(EditRights.mayEditShared(itemId: "doc", roots: ["edited": "editor"], parent: parent))
        // A file shared on its own, even to edit: its folder can't be listed.
        #expect(!EditRights.mayEditShared(itemId: "doc", roots: ["doc": "editor"], parent: parent))
        // Shared to edit itself, inside a folder shared to edit (or to view): its role is its own, and the folder lists.
        #expect(EditRights.mayEditShared(itemId: "doc", roots: ["doc": "editor", "edited": "editor"], parent: parent))
        #expect(EditRights.mayEditShared(itemId: "doc", roots: ["doc": "editor", "viewed": "viewer"], parent: parent))
        #expect(!EditRights.mayEditShared(itemId: "doc", roots: ["doc": "viewer", "edited": "editor"], parent: parent))
        // No mount found up its folders: not editable.
        #expect(!EditRights.mayEditShared(itemId: "doc", roots: [:], parent: parent))
    }

    /* Typed during a save: "é" for "e" + U+0301 is a change String's == can't see; the bytes do. */
    @Test func canonicallyEqualTextIsNotTheSameSave() {
        let composed = "caf\u{E9}"
        let decomposed = "cafe\u{301}"
        #expect(composed == decomposed)
        #expect(!TextEditing.same(composed, decomposed))
        #expect(TextEditing.same(composed, "caf\u{E9}"))
    }

    @Test func ownershipIsNeverAssumedBeforeTheOwnWorkspaceIsKnown() {
        let parents = ["doc": "inner", "inner": "top"]
        let parent = { (id: String) in parents[id] }
        // Not loaded yet: a viewer's share is not taken for one's own.
        #expect(!EditRights.mayEdit(itemId: "doc", workspaceId: "theirs", own: nil, roots: ["top": "viewer"], parent: parent))
        #expect(!EditRights.mayEdit(itemId: "doc", workspaceId: "theirs", own: nil, roots: [:], parent: parent))
        // An editor's mount covering it still counts.
        #expect(EditRights.mayEdit(itemId: "doc", workspaceId: "theirs", own: nil, roots: ["top": "editor"], parent: parent))
        // Known and the item's: one's own.
        #expect(EditRights.mayEdit(itemId: "doc", workspaceId: "MINE", own: "mine", roots: [:], parent: parent))
        #expect(!EditRights.mayEdit(itemId: "doc", workspaceId: "theirs", own: "mine", roots: [:], parent: parent))
    }

    @Test func aViewerOffersEditForBytesThatReadAsText() {
        #expect(TextEditing.readsAsText(Data("Read me\n".utf8)))
        #expect(TextEditing.readsAsText(Data("a\r\nb".utf8)))
        #expect(TextEditing.readsAsText(Data("a\rb".utf8)))
        #expect(TextEditing.readsAsText(Data([0xFF, 0xFE, 0x68, 0x00])))
        #expect(!TextEditing.readsAsText(Data([0x61, 0x00, 0x62])))
        #expect(!TextEditing.readsAsText(Data([0x63, 0x61, 0x66, 0xE9])))
    }

    @Test func readOnlyFilesKeepTheirWordsAndNeverOfferText() {
        #expect(TextEditing.open(Data([0x61, 0x00, 0x62])) == .readOnly(.binary, nil))
        #expect(TextEditing.open(Data([0x63, 0x61, 0x66, 0xE9])) == .readOnly(.encoding, "caf\u{FFFD}"))
        #expect(TextEditing.open(Data("a\rb".utf8)) == .readOnly(.lineEndings, "a\rb"))
        #expect(TextEditing.words(.encoding) == "This file uses an encoding HushOS can’t edit without changing it.")
        #expect(TextEditing.limit == 8 * 1024 * 1024)
        // Nothing is written for a file the editor can't keep exactly.
        #expect(saved("cafe", from: Data([0x63, 0x61, 0x66, 0xE9])) == nil)
    }

    @Test func aMixedFileSaysWhichLineBreakASaveWrites() {
        guard case .editable(_, let crlf) = TextEditing.open(Data("a\r\nb\r\nc\n".utf8)),
              case .editable(_, let lf) = TextEditing.open(Data("a\nb\nc\r\n".utf8)),
              case .editable(_, let windows) = TextEditing.open(Data("a\r\n".utf8)) else { Issue.record("should open"); return }
        #expect(TextEditing.mixedNote(crlf) == "This file mixes line endings; saving uses Windows (CRLF).")
        #expect(TextEditing.mixedNote(lf) == "This file mixes line endings; saving uses Unix (LF).")
        #expect(TextEditing.mixedNote(windows) == nil)
    }
}

/* A folder the way the server keeps it for a save: each file's versions in order, a version refused stale when the file moved on. */
actor TextBench: SaveRunWriter {
    var versions: [String: [(id: String, bytes: Data)]] = [:]
    var names: [String: String] = [:]
    var signed: [(metadata: Signing, version: Signing)] = []
    /* Someone else saves right after this one lands, before its reply is read (the reply row shows theirs). */
    var theirsAfterLanding: String?
    func set(theirsAfterLanding: String?) { self.theirsAfterLanding = theirsAfterLanding }
    /* The session the upload went under ended (a 401 naming it) once the run had begun. */
    var refusedAs: String??
    func set(refusedAs: String?) { self.refusedAs = .some(refusedAs) }
    private var count = 0

    func add(_ name: String, _ text: String) -> Opened {
        count += 1
        let id = "n\(count)"
        names[id] = name
        versions[id] = [("v\(count)", Data(text.utf8))]
        return file(id)
    }
    func versionId(of id: String, at index: Int) -> String { versions[id]![index].id }
    func file(_ id: String) -> Opened { opened(id, parent: "f", version: versions[id]!.last!.id, name: names[id]) }
    /* Someone else's save from another device. */
    func theirs(_ id: String, _ text: String) -> String {
        count += 1
        versions[id]!.append(("v\(count)", Data(text.utf8)))
        return "v\(count)"
    }
    func text(_ id: String, at index: Int = -1) -> String {
        let list = versions[id]!
        return String(decoding: list[index < 0 ? list.count + index : index].bytes, as: UTF8.self)
    }

    func gate(_ target: Opened) async -> SaveGate { .writable }
    func room(_ workspaceId: String) async throws -> SaveRoom { .own(1 << 40) }
    func names(in folder: Opened) async throws -> [String] { Array(names.values) }
    func makeFolder(in folder: Opened, name: String, signing: Signing, minted: @escaping @Sendable (String) throws -> Void) async throws -> Opened {
        throw DriveAPIError.server(400, "not asked")
    }
    func uploadResult(_ bytes: Data, name: String, mime: String?, in folder: Opened, replacing: Opened?, startedFrom: String?, thumbnail: Data?,
                      signing: (metadata: Signing, version: Signing), onBegun: @escaping @Sendable (Vault.BegunIds) throws -> Void,
                      onCompleting: @escaping @Sendable (String) throws -> Void) async throws -> Opened {
        count += 1
        signed.append(signing)
        if let refused = refusedAs { throw DriveAPIError.notAuthenticated(session: refused) }
        if let replacing {
            guard let list = versions[replacing.id] else { throw SaveStale(currentVersionId: nil) }
            if list.last!.id != startedFrom { throw SaveStale(currentVersionId: list.last!.id) }
            let minted = "v\(count)"
            try onBegun(Vault.BegunIds(workspaceId: "ws", uploadId: "up-\(count)", nodeId: replacing.id, versionId: minted))
            try onCompleting("up-\(count)")
            versions[replacing.id]!.append((minted, bytes))
            if let theirs = theirsAfterLanding {
                theirsAfterLanding = nil
                _ = self.theirs(replacing.id, theirs)
            }
            return file(replacing.id)
        }
        let id = "n\(count)"
        try onBegun(Vault.BegunIds(workspaceId: "ws", uploadId: "up-\(count)", nodeId: id, versionId: "v\(count)"))
        try onCompleting("up-\(count)")
        names[id] = name
        versions[id] = [("v\(count)", bytes)]
        return file(id)
    }
    func fresh(_ file: Opened, in folder: Opened) async throws -> Opened? { versions[file.id] == nil ? nil : self.file(file.id) }
    func lookFolder(_ id: String, in workspaceId: String, while stillOn: @escaping @Sendable () -> Bool) async throws -> FolderCount? { nil }
    func listed(_ id: String, in folder: Opened) async throws -> Opened? { nil }
    func refreshFolder(_ folder: Opened) async throws -> Opened { folder }
    func keyChangePause(_ workspaceId: String, attempt: Int) async throws {}
    func abortUpload(_ uploadId: String, in workspaceId: String, while stillOn: @escaping @Sendable () -> Bool) async -> DriveAPI.AbortFate { .aborted }
    func trash(_ ids: [String], in workspaceId: String, while stillOn: @escaping @Sendable () -> Bool) async throws -> [String: SaveItemFate] { [:] }
    func purge(_ ids: [String], in workspaceId: String, while stillOn: @escaping @Sendable () -> Bool) async throws -> [String: SaveItemFate] { [:] }
    func mayPurge(_ workspaceId: String) async -> Bool? { true }
}

@Suite(.serialized) struct TextSaveTests {
    private func start(_ bench: TextBench, planned: PlannedBox? = nil) -> TextSave.Start {
        let rows = journal()
        return { targets, results in
            await planned?.add(results)
            return try await SaveRun.start(writer: bench, targets: targets, results: results, journal: rows)
        }
    }

    @Test func aSaveIsANewVersionHoldingExactlyTheEditedTextPlannedAsItsBytes() async throws {
        let bench = TextBench()
        let file = await bench.add("notes.txt", "café\n")
        let planned = PlannedBox()
        let saved = try await TextSave.version(Data("café ✓\n".utf8), of: file, in: opened("f"), startedFrom: file.node.currentVersion?.id,
                                               start: start(bench, planned: planned))
        guard case .saved = saved else { Issue.record("not saved"); return }
        #expect(await bench.text(file.id) == "café ✓\n")
        #expect(await bench.versions[file.id]?.count == 2)
        // Its UTF-8 bytes (10), not its length in characters (7), and no thumbnail.
        #expect(await planned.results == [[.known(size: 10, thumbnail: false)]])
        #expect(await bench.signed.last.map { $0.version == .own } == true)
    }

    /*
     * A 401 while the save's upload went up: the run stops naming the session refused, so the editor hands it to the app's
     * session check (DriveStore.report) rather than showing it as a line. Fails if the refusal is lost in the stop.
     */
    @Test func aSaveStoppedByA401NamesTheSessionRefused() async throws {
        let bench = TextBench()
        let file = await bench.add("notes.txt", "a")
        await bench.set(refusedAs: "session-1")
        do {
            _ = try await TextSave.version(Data("b".utf8), of: file, in: opened("f"), startedFrom: file.node.currentVersion?.id, start: start(bench))
            Issue.record("saved")
        } catch let stopped as SaveRunStopped {
            #expect(stopped.refusedSession == SaveRunStopped.RefusedSession(tag: "session-1"))
            guard case .notAuthenticated(let tag)? = stopped.sessionRefusal else { Issue.record("no refusal"); return }
            #expect(tag == "session-1")
        }
        #expect(await bench.versions[file.id]?.count == 1)
    }

    /*
     * The editor's header names and marks the version its text is: a row a save answered with takes over only when it
     * lists the version that save published, in the editor's folder. Fails if someone else's newer version (verified or
     * not), or a row elsewhere, would take the marks off the text read.
     */
    @Test func onlyARowListingThePublishedVersionInItsFolderSpeaksForTheText() async throws {
        let bench = TextBench()
        let file = await bench.add("notes.txt", "a")
        let destination = EditDestination(of: file)
        let mine = try #require(file.node.currentVersion?.id)
        #expect(TextEditing.speaksFor(file, versionId: mine, at: destination))
        _ = await bench.theirs(file.id, "theirs")
        let theirs = await bench.file(file.id)
        #expect(!TextEditing.speaksFor(theirs, versionId: mine, at: destination))
        #expect(!TextEditing.speaksFor(file, versionId: nil, at: destination))
        #expect(!TextEditing.speaksFor(file, versionId: mine, at: EditDestination(of: opened("x", parent: "elsewhere", version: "v", name: "x"))))
    }

    /* Someone else saved right after this landed: the next save must start from this save's version, not theirs. */
    @Test func aSaveNamesTheVersionItPublishedNotTheReplyRowsCurrentOne() async throws {
        let bench = TextBench()
        let file = await bench.add("notes.txt", "a")
        await bench.set(theirsAfterLanding: "theirs")
        let saved = try await TextSave.version(Data("mine".utf8), of: file, in: opened("f"), startedFrom: file.node.currentVersion?.id, start: start(bench))
        let mine = await bench.versionId(of: file.id, at: 1)
        guard case .saved(_, let versionId) = saved else { Issue.record("not saved"); return }
        #expect(versionId == mine)
        #expect(await bench.text(file.id) == "theirs")
    }

    /* The screen closed or another session began while the folder was being listed: nothing starts, nothing uploads. */
    @Test func aSaveWhoseSessionEndedStartsNothing() async throws {
        let bench = TextBench()
        let file = await bench.add("notes.txt", "a")
        await #expect(throws: TextEditing.SessionEnded.self) {
            _ = try await TextSave.version(Data("b".utf8), of: file, in: opened("f"), startedFrom: file.node.currentVersion?.id, start: start(bench),
                                           stillOn: { false })
        }
        await #expect(throws: TextEditing.SessionEnded.self) {
            _ = try await TextSave.copy(Data("b".utf8), of: file, in: opened("f"), sources: .ownWriting, start: start(bench), stillOn: { false })
        }
        #expect(await bench.versions[file.id]?.count == 1)
        #expect(await bench.names.count == 1)
    }

    /* Discarded while the run started (the room check, its record): nothing is handed to the run, and its row goes. */
    @Test func aSaveWhoseSessionEndsWhileItsRunStartsUploadsNothing() async throws {
        let bench = TextBench()
        let file = await bench.add("notes.txt", "a")
        let on = SessionFlag()
        let rows = journal()
        let start: TextSave.Start = { targets, results in
            let run = try await SaveRun.start(writer: bench, targets: targets, results: results, journal: rows)
            on.off()
            return run
        }
        await #expect(throws: TextEditing.SessionEnded.self) {
            _ = try await TextSave.version(Data("b".utf8), of: file, in: opened("f"), startedFrom: file.node.currentVersion?.id, start: start,
                                           stillOn: { on.isOn }, pause: { _ in })
        }
        #expect(await bench.versions[file.id]?.count == 1)
        #expect(rows.list().isEmpty)
        on.on()
        await #expect(throws: TextEditing.SessionEnded.self) {
            _ = try await TextSave.copy(Data("b".utf8), of: file, in: opened("f"), sources: .ownWriting, start: start, stillOn: { on.isOn }, pause: { _ in })
        }
        #expect(await bench.names.count == 1)
        #expect(rows.list().isEmpty)
    }

    @Test func aSaveAfterSomeoneElsesIsStaleAndPublishesNothing() async throws {
        let bench = TextBench()
        let file = await bench.add("notes.txt", "start\n")
        let theirs = await bench.theirs(file.id, "theirs\n")
        let saved = try await TextSave.version(Data("mine\n".utf8), of: file, in: opened("f"), startedFrom: file.node.currentVersion?.id, start: start(bench))
        #expect(saved == .stale(currentVersionId: theirs))
        #expect(await bench.text(file.id) == "theirs\n")
        #expect(await bench.versions[file.id]?.count == 2)
    }

    @Test func saveOnTopMakesANewVersionAfterTheirsAndBothStay() async throws {
        let bench = TextBench()
        let file = await bench.add("notes.txt", "start\n")
        let theirs = await bench.theirs(file.id, "theirs\n")
        let fresh = await bench.file(file.id)
        let saved = try await TextSave.version(Data("mine\n".utf8), of: fresh, in: opened("f"), startedFrom: theirs, start: start(bench))
        guard case .saved = saved else { Issue.record("not saved"); return }
        #expect(await bench.versions[file.id]?.count == 3)
        #expect(await bench.text(file.id, at: 1) == "theirs\n")
        #expect(await bench.text(file.id) == "mine\n")
    }

    @Test func saveAsACopyMakesASiblingUnderTheNextFreeNameSignedAsItsSource() async throws {
        let bench = TextBench()
        let file = await bench.add("notes.txt", "start\n")
        _ = await bench.add("notes (2).txt", "already here")
        _ = await bench.theirs(file.id, "theirs\n")
        let sources = SaveSources.from([.file(metadata: .unknownSigner, version: .unknownSigner, fromLink: false)])
        let made = try await TextSave.copy(Data("mine\n".utf8), of: file, in: opened("f"), sources: sources, start: start(bench))
        #expect(await bench.names[made.file.id] == "notes (3).txt")
        #expect(await bench.text(made.file.id) == "mine\n")
        #expect(made.versionId == (await bench.versionId(of: made.file.id, at: 0)))
        #expect(await bench.text(file.id) == "theirs\n")
        // An Unverified source's copy is never signed as the person's own writing.
        #expect(await bench.signed.last.map { $0.metadata == .copy(.unknownSigner) } == true)
    }
}

actor PlannedBox {
    var results: [[PlannedResult]] = []
    func add(_ more: [PlannedResult]) { results.append(more) }
}

/* An editor's session: work taken under it stops publishing once it closes, another session begins, or another text opens. */
@MainActor @Suite struct EditSessionTests {
    final class Owner {}

    @Test func workGoesOnOnlyInTheSessionItBeganIn() {
        let first = Owner()
        let session = EditSession<Owner>()
        let token = session.take(first)!
        #expect(token.owner === first)
        #expect(session.live(token, current: first))
        // Another sign-in replaced the vault: nothing begun before goes on, and nothing new begins under it.
        let second = Owner()
        #expect(!session.live(token, current: second))
        #expect(session.take(second) == nil)
    }

    @Test func openTheirsAndClosingEndEarlierWork() {
        let owner = Owner()
        let session = EditSession<Owner>()
        let before = session.take(owner)!
        session.reopened()
        #expect(!session.live(before, current: owner))
        let after = session.take(owner)!
        #expect(session.live(after, current: owner))
        session.close()
        #expect(!session.live(after, current: owner))
        #expect(session.take(owner) == nil)
    }
}

@Suite struct TextSniffTests {
    @Test func aFileIsReadNoFurtherThanTheEditorTakes() throws {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("sniff-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: dir) }
        let small = dir.appendingPathComponent("README")
        try Data("Read me\n".utf8).write(to: small)
        #expect(TextEditing.readsAsText(fileAt: small))
        // Text past the limit, of a size no row said: not offered, and never read whole.
        let large = dir.appendingPathComponent("BIG")
        try Data(repeating: UInt8(ascii: "a"), count: Int(TextEditing.limit) + 2).write(to: large)
        #expect(!TextEditing.readsAsText(fileAt: large))
    }
}

final class SessionFlag: @unchecked Sendable {
    private let lock = NSLock()
    private var value = true
    var isOn: Bool { lock.withLock { value } }
    func on() { lock.withLock { value = true } }
    func off() { lock.withLock { value = false } }
}

@Suite struct EmptySniffTests {
    @Test func anEmptyExtensionlessFileReadsAsText() throws {
        let url = FileManager.default.temporaryDirectory.appendingPathComponent("empty-\(UUID().uuidString)")
        try Data().write(to: url)
        defer { try? FileManager.default.removeItem(at: url) }
        #expect(TextEditing.readsAsText(fileAt: url))
        #expect(!TextEditing.readsAsText(fileAt: url.appendingPathExtension("missing")))
    }
}
