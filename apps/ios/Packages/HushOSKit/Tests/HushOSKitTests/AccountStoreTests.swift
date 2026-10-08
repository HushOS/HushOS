import Foundation
import Testing
@testable import HushOSKit

/*
 * One account's data must never show to the next account on this phone: decrypted kept
 * files, files opened or fetched, the queue's copies, the parents index, and the stores
 * behind them. The same six cases as Android's AccountStoreTest.
 */
extension OfflineStore {
@Suite final class AccountStoreTests {
    let root: URL
    let temporary: URL
    let counter = Counter()
    let store: AccountStore

    final class Counter: @unchecked Sendable {
        private let lock = NSLock()
        private var value = 0
        func increment() { lock.lock(); value += 1; lock.unlock() }
        func reset() { lock.lock(); value = 0; lock.unlock() }
        var count: Int { lock.lock(); defer { lock.unlock() }; return value }
    }

    init() {
        let base = FileManager.default.temporaryDirectory.appendingPathComponent("account-store-" + UUID().uuidString, isDirectory: true)
        root = base.appendingPathComponent("group", isDirectory: true)
        temporary = base.appendingPathComponent("tmp", isDirectory: true)
        let counter = counter
        store = AccountStore(root: root, temporary: temporary) { counter.increment() }
    }

    deinit { try? FileManager.default.removeItem(at: root.deletingLastPathComponent()) }

    /* What account A leaves on the phone after keeping, opening, uploading and sharing. */
    var alicesFiles: [URL] {
        [
            root.appendingPathComponent("offline/node-a/version-1/Tax return.pdf"),
            root.appendingPathComponent("transfers/job-1/content"),
            root.appendingPathComponent("files-parents.json"),
            temporary.appendingPathComponent("opened/node-a/version-1/Tax return.pdf"),
            temporary.appendingPathComponent("links/node-d/version-3/Shared.pdf"),
            temporary.appendingPathComponent("kit-1/hushos-recovery-kit.txt"),
            temporary.appendingPathComponent("save-2/Holiday.jpg"),
        ]
    }

    /* Alice's files, written after her sign-in; only what happens afterwards is counted. */
    func leaveAlicesData() throws {
        for file in alicesFiles {
            try FileManager.default.createDirectory(at: file.deletingLastPathComponent(), withIntermediateDirectories: true)
            try Data("decrypted".utf8).write(to: file)
        }
        counter.reset()
    }

    func exists(_ url: URL) -> Bool { FileManager.default.fileExists(atPath: url.path) }

    @Test func anotherAccountSigningInRemovesTheFirstAccountsData() throws {
        store.claim("alice")
        try leaveAlicesData()
        #expect(store.claim("bob"))
        for file in alicesFiles { #expect(!exists(file), "\(file.lastPathComponent) survived another account's sign-in") }
        #expect(counter.count == 1)
        #expect(store.owner() == "bob")
    }

    @Test func theSameAccountSigningInAgainKeepsWhatItKept() throws {
        // Its session ended (a password changed elsewhere) and it signs back in: kept files stay.
        store.claim("alice")
        try leaveAlicesData()
        #expect(!store.claim("ALICE"))
        for file in alicesFiles { #expect(exists(file), "\(file.lastPathComponent) was lost on the same account's sign-in") }
        #expect(counter.count == 0)
    }

    @Test func dataNobodyIsRecordedAsOwningIsRemovedBeforeASignIn() throws {
        // Kept before the owner was recorded (an older version signed out without wiping).
        try leaveAlicesData()
        store.claim("bob")
        for file in alicesFiles { #expect(!exists(file), "\(file.lastPathComponent) of an unknown account survived") }
    }

    @Test func signingOutRemovesEverythingAndTheOwner() throws {
        store.claim("alice")
        try leaveAlicesData()
        store.wipe()
        for file in alicesFiles { #expect(!exists(file), "\(file.lastPathComponent) survived sign-out") }
        #expect(counter.count == 1)
        #expect(store.owner() == nil)
    }

    @Test func aSessionFromBeforeTheStoreKeepsItsOwnData() throws {
        // Already signed in when this version first runs: nothing is wiped, and it is recorded.
        try leaveAlicesData()
        store.adopt("alice")
        for file in alicesFiles { #expect(exists(file)) }
        #expect(store.owner() == "alice")
        // Then someone else signs in: Alice's data goes.
        store.claim("bob")
        for file in alicesFiles { #expect(!exists(file)) }
    }

    @Test func whatIsNotAccountDataInTheGroupStays() throws {
        // The group's own preferences (the server address lives beside them) are not the account's:
        // a wipe that emptied the whole container would take them too.
        let preferences = root.appendingPathComponent("Library/Preferences/group.com.hushos.app.plist")
        try FileManager.default.createDirectory(at: preferences.deletingLastPathComponent(), withIntermediateDirectories: true)
        try Data("settings".utf8).write(to: preferences)
        store.claim("alice")
        store.claim("bob")
        #expect(exists(preferences))
    }

    /* A kept folder and the files it brought, as the store keeps them. */
    func opened(_ id: String, folder: Bool, name: String) -> Opened {
        let node = NodeView(id: id, workspaceId: "w", parentId: "p", kind: folder ? "folder" : "file", keyEpoch: 1, parentKeyEpoch: 1,
                            keyEnvelope: "", metadataVersion: 1, metadataEnvelope: "", currentVersion: nil, trashedAt: nil,
                            changeSeq: 1, createdAt: nil, updatedAt: nil)
        return Opened(node: node, metadata: NodeMetadata(name: name, mime: nil, size: 3, modified: nil), nodeKey: nil)
    }

    @Test func keptFoldersAndTheirFilesGoWithTheAccount() {
        Offline.forgetAll()
        Offline.rememberFolder(opened("folder-1", folder: true, name: "Lisbon"))
        Offline.remember(opened("inside-1", folder: false, name: "a.jpg"), folder: "folder-1")
        // What sign-out and another account's sign-in run (AccountStore.shared's stores).
        Offline.forgetAll()
        #expect(Offline.keptFolders().isEmpty)
        #expect(Offline.entries().isEmpty)
        #expect(Offline.keptBy("inside-1") == nil)
    }

    @Test func removingAKeptFolderTakesItsFilesButNotOnesKeptOnTheirOwn() {
        Offline.forgetAll()
        // Kept on its own first, then its folder is kept: it stays its own.
        Offline.remember(opened("own-1", folder: false, name: "own.pdf"))
        Offline.rememberFolder(opened("folder-2", folder: true, name: "Work"))
        Offline.remember(opened("own-1", folder: false, name: "own.pdf"), folder: "folder-2")
        Offline.remember(opened("inside-2", folder: false, name: "b.jpg"), folder: "folder-2")
        #expect(Offline.keptBy("inside-2")?.name == "Work")
        #expect(Offline.keptBy("own-1") == nil)
        // A refresh of a file kept with the folder keeps it with the folder.
        Offline.remember(opened("inside-2", folder: false, name: "b.jpg"))
        #expect(Offline.keptBy("inside-2")?.id == "folder-2")
        Offline.forgetFolder("folder-2")
        #expect(!Offline.isFolderKept("folder-2"))
        #expect(!Offline.isKept("inside-2"))
        #expect(Offline.isKept("own-1"))
        Offline.forgetAll()
    }
}
}
