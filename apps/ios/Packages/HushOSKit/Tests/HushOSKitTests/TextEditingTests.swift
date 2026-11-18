import Foundation
import HushOSCore
import Testing
@testable import HushOSKit
#if canImport(UIKit)
import UIKit
#endif

/*
 * Editing 1a on the phone (TextEditing.swift). Which bytes open for editing is held to the web's
 * verdicts (fixtures/text-edit-cases.json); a file that opens for editing comes back out of the
 * system's text storage byte for byte; and the editor's saves ask the save path the right things: a
 * new version from the version it opened, a refusal when someone else saved first, Save on top
 * after theirs, Save as a copy beside it under the next free name.
 */

private struct Part: Decodable { let hex: String; let repeatCount: Int?
    enum CodingKeys: String, CodingKey { case hex; case repeatCount = "repeat" }
}
private struct ByteCase: Decodable { let name: String; let bytes: [Part]; let reason: String? }
private struct NameCase: Decodable { let name: String; let mime: String?; let editable: Bool }
private struct Cases: Decodable { let bytes: [ByteCase]; let names: [NameCase] }

private let cases: Cases = {
    // This file, then Tests/HushOSKitTests up to the repository root: seven steps.
    var url = URL(fileURLWithPath: #filePath)
    for _ in 0 ..< 7 { url.deleteLastPathComponent() }
    let data = try! Data(contentsOf: url.appendingPathComponent("crates/hushos-core/fixtures/text-edit-cases.json"))
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
    case .byteOrderMark: "byte-order-mark"
    case .utf16: "utf-16"
    case .encoding: "encoding"
    case .binary: "binary"
    case .lineEndings: "line-endings"
    }
}

@Suite struct TextEditingTests {
    @Test func everyByteCaseOpensAsTheWebOpensIt() {
        #expect(cases.bytes.count >= 20)
        for c in cases.bytes {
            switch TextEditing.open(bytes(c.bytes)) {
            case .editable: #expect(c.reason == nil, "\(c.name)")
            case .readOnly(let reason, _): #expect(word(reason) == c.reason, "\(c.name)")
            }
        }
    }

    @Test func everyNameOpensInTheEditorAsOnTheWeb() {
        for c in cases.names { #expect(TextEditing.opens(name: c.name, mime: c.mime) == c.editable, "\(c.name)") }
    }

    /* A save changes only the edited bytes: what opened comes back out exactly, through the text view's own storage. */
    @Test func everyEditableCaseComesBackOutByteForByte() {
        for c in cases.bytes where c.reason == nil {
            let data = bytes(c.bytes)
            guard case .editable(let text) = TextEditing.open(data) else { Issue.record("\(c.name) should open"); continue }
            #expect(TextEditing.encode(text) == data, "\(c.name)")
            #if canImport(UIKit)
            // As UITextView holds it: an NSTextStorage, read back as its string.
            if data.count < 100_000 {
                let storage = NSTextStorage(string: text)
                #expect(TextEditing.encode(storage.string) == data, "\(c.name) through NSTextStorage")
            }
            #endif
        }
    }

    @Test func anEditInMultibyteTextChangesOnlyThoseBytes() {
        let original = "Grüße 👋\nzweite Zeile\u{2028}noch\nohne Zeilenende"
        guard case .editable(let text) = TextEditing.open(Data(original.utf8)) else { Issue.record("should open"); return }
        let edited = text.replacingOccurrences(of: "zweite", with: "dritte ✓")
        let saved = TextEditing.encode(edited)
        let at = Data("Grüße 👋\n".utf8).count
        var expected = Data(original.utf8)
        expected.replaceSubrange(at ..< at + 6, with: Data("dritte ✓".utf8))
        #expect(saved == expected)
        #expect(saved.last == UInt8(ascii: "e"))
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

    @Test func editRightsComeFromTheMountCoveringTheItem() {
        let parents = ["doc": "inner", "inner": "viewed", "viewed": "edited", "edited": "top"]
        let parent = { (id: String) in parents[id] }
        // Under a folder shared to view, inside one shared to edit: the nearer one decides.
        #expect(!EditRights.mayEditShared(itemId: "doc", roots: ["viewed": "viewer", "edited": "editor"], parent: parent))
        #expect(EditRights.mayEditShared(itemId: "doc", roots: ["edited": "editor"], parent: parent))
        // A file shared on its own, even to edit: its folder can't be listed.
        #expect(!EditRights.mayEditShared(itemId: "doc", roots: ["doc": "editor"], parent: parent))
        // No mount found up its folders: not editable.
        #expect(!EditRights.mayEditShared(itemId: "doc", roots: [:], parent: parent))
    }

    @Test func aViewerOffersEditForBytesThatReadAsText() {
        #expect(TextEditing.readsAsText(Data("Read me\n".utf8)))
        #expect(TextEditing.readsAsText(Data("a\r\nb".utf8)))
        #expect(!TextEditing.readsAsText(Data([0x61, 0x00, 0x62])))
        #expect(!TextEditing.readsAsText(Data([0x63, 0x61, 0x66, 0xE9])))
    }

    @Test func readOnlyFilesKeepTheirWordsAndNeverOfferText() {
        #expect(TextEditing.open(Data([0x61, 0x00])) == .readOnly(.binary, nil))
        #expect(TextEditing.open(Data([0xEF, 0xBB, 0xBF, 0x68, 0x69])) == .readOnly(.byteOrderMark, "\u{FEFF}hi"))
        #expect(TextEditing.words(.lineEndings) == "This file uses Windows line endings, which HushOS can’t edit yet.")
        #expect(TextEditing.limit == 8 * 1024 * 1024)
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
        let saved = try await TextSave.version("café ✓\n", of: file, in: opened("f"), startedFrom: file.node.currentVersion?.id,
                                               start: start(bench, planned: planned))
        guard case .saved = saved else { Issue.record("not saved"); return }
        #expect(await bench.text(file.id) == "café ✓\n")
        #expect(await bench.versions[file.id]?.count == 2)
        // Its UTF-8 bytes (10), not its length in characters (7), and no thumbnail.
        #expect(await planned.results == [[.known(size: 10, thumbnail: false)]])
        #expect(await bench.signed.last.map { $0.version == .own } == true)
    }

    /* Someone else saved right after this landed: the next save must start from this save's version, not theirs. */
    @Test func aSaveNamesTheVersionItPublishedNotTheReplyRowsCurrentOne() async throws {
        let bench = TextBench()
        let file = await bench.add("notes.txt", "a")
        await bench.set(theirsAfterLanding: "theirs")
        let saved = try await TextSave.version("mine", of: file, in: opened("f"), startedFrom: file.node.currentVersion?.id, start: start(bench))
        let mine = await bench.versionId(of: file.id, at: 1)
        guard case .saved(_, let versionId) = saved else { Issue.record("not saved"); return }
        #expect(versionId == mine)
        #expect(await bench.text(file.id) == "theirs")
    }

    @Test func aSaveAfterSomeoneElsesIsStaleAndPublishesNothing() async throws {
        let bench = TextBench()
        let file = await bench.add("notes.txt", "start\n")
        let theirs = await bench.theirs(file.id, "theirs\n")
        let saved = try await TextSave.version("mine\n", of: file, in: opened("f"), startedFrom: file.node.currentVersion?.id, start: start(bench))
        #expect(saved == .stale(currentVersionId: theirs))
        #expect(await bench.text(file.id) == "theirs\n")
        #expect(await bench.versions[file.id]?.count == 2)
    }

    @Test func saveOnTopMakesANewVersionAfterTheirsAndBothStay() async throws {
        let bench = TextBench()
        let file = await bench.add("notes.txt", "start\n")
        let theirs = await bench.theirs(file.id, "theirs\n")
        let fresh = await bench.file(file.id)
        let saved = try await TextSave.version("mine\n", of: fresh, in: opened("f"), startedFrom: theirs, start: start(bench))
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
        let made = try await TextSave.copy("mine\n", of: file, in: opened("f"), sources: sources, start: start(bench))
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
