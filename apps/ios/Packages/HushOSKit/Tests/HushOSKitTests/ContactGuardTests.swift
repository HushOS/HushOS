import Foundation
import HushOSCore
import Testing
@testable import HushOSKit

/* A guard in a folder of the test's own, which a test can make refuse writes, as a full disk would. */
final class GuardSwitch: @unchecked Sendable {
    private let lock = NSLock()
    private var on = true
    var writable: Bool {
        get { lock.withLock { on } }
        set { lock.withLock { on = newValue } }
    }
}

/* A settings key and the envelope the server would keep it in, for a store on its own. */
func settingsKey(_ byte: UInt8) -> MarksKey {
    MarksKey(key: Data(repeating: byte, count: 32), envelope: SettingsKeyEnvelope(nonce: "n\(byte)", ciphertext: "c\(byte)"))
}

func guardStore(_ folder: URL, _ owner: AccountOwner, generation: GuardGeneration = GuardGeneration(), writes: GuardSwitch = GuardSwitch(),
                key: MarksKey? = settingsKey(7)) -> ContactGuardStore {
    var store = ContactGuardStore(folder: folder, owner: owner, generation: generation) { writes.writable }
    store.key = key
    return store
}

func guardFolder() -> URL {
    let url = FileManager.default.temporaryDirectory.appendingPathComponent("guard-\(UUID().uuidString)", isDirectory: true)
    try? FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
    return url
}

/* A first-seen pin's keys for an identity, as the guard remembers them. */
func firstSeen(_ envelope: IdentityEnvelope) throws -> PinKeys {
    try pinOfServed(served: try #require(servedOf(envelope).full), verified: false)
}

/*
 * The guard's store on its own: what one phone keeps per account and person, across the app and
 * its extensions, apart from the settings.
 */
struct ContactGuardStoreTests {
    let owner = AccountOwner(userId: "me", origin: "https://one.test")

    @Test func aSignOutLeavesNoGuardAndAWriteAfterItWritesNothing() throws {
        let root = guardFolder()
        let writes = GuardSwitch()
        let store = guardStore(root.appendingPathComponent("local/guard", isDirectory: true), owner, writes: writes)
        let maya = try makeIdentity("maya")
        try store.commit("maya", try guardEntryNext(previous: nil, pin: try firstSeen(maya.envelope)), over: 0)
        #expect(try store.entry("maya") != nil)
        AccountStore(root: root, temporary: guardFolder()).wipe()
        // Nothing of whom this account shared with stays: the next sign-in starts as a new device.
        #expect(!FileManager.default.fileExists(atPath: root.appendingPathComponent("local/guard").path))
        #expect(try store.entries().isEmpty)
        // A write still on its way when the session went is refused, and leaves nothing behind.
        writes.writable = false
        #expect(throws: GuardError.unsaved) { try store.commit("maya", try guardEntryNext(previous: nil, pin: try firstSeen(maya.envelope)), over: 0) }
        #expect(!FileManager.default.fileExists(atPath: store.file.path))
    }

    @Test func aRecordThatDoesNotReadIsUnreadableNeverNothing() throws {
        let store = guardStore(guardFolder(), owner)
        let maya = try makeIdentity("maya")
        try store.commit("maya", try guardEntryNext(previous: nil, pin: try firstSeen(maya.envelope)), over: 0)
        // Damaged bytes: never read as "no entry", which would be first use for everyone.
        try Data("{not json".utf8).write(to: store.file)
        #expect(throws: GuardError.unreadable) { _ = try store.entry("maya") }
        #expect(throws: GuardError.unreadable) { _ = try store.entry("someone-else") }
        // An entry edited to keys that make no commitment (a digest cut short), sealed properly, is no entry to judge by either.
        var record = ContactGuardStore.Record()
        let entry = try guardEntryNext(previous: nil, pin: try firstSeen(maya.envelope))
        record.entries["maya"] = StoredGuardEntry(GuardEntry(revision: 1, keyVersion: 1, encryptionPublicKey: entry.encryptionPublicKey,
                                                             signingPublicKey: entry.signingPublicKey, mlDsaPublicKeyHash: "00",
                                                             kemPublicKeyHash: entry.kemPublicKeyHash, previousSigningKeys: [], verified: false))
        let sealed = try contactGuardSeal(settingsKey: settingsKey(7).key, userId: owner.userId, slot: store.slot, kind: "record",
                                          record: String(decoding: try JSONEncoder().encode(record), as: UTF8.self))
        try JSONEncoder().encode(ContactGuardStore.Sealed(key: .init(nonce: "n7", ciphertext: "c7"), record: sealed)).write(to: store.file)
        #expect(throws: GuardError.unreadable) { _ = try store.entries() }
        // The plaintext form this branch wrote before the guard was sealed is refused, never read as it is.
        try JSONEncoder().encode(record).write(to: store.file)
        #expect(throws: GuardError.unreadable) { _ = try store.entries() }
        // And nothing is written over a record that doesn't read.
        #expect(throws: GuardError.unreadable) { try store.dropPending("maya") }
    }

    @Test func aGuardSealedUnderOneSettingsKeyIsUnreadableUnderAnotherAndNamesNobody() throws {
        let folder = guardFolder()
        let maya = try makeIdentity("6b1a3f0e-2c4d-4e5f-8a9b-0c1d2e3f4a5b")
        let sealedUnderA = guardStore(folder, owner, key: settingsKey(7))
        try sealedUnderA.commit("maya-account-id", try guardEntryNext(previous: nil, pin: try firstSeen(maya.envelope)), over: 0)
        // The bytes on disk: no account id of the contact, no key, no email, nothing in the clear.
        let bytes = try Data(contentsOf: sealedUnderA.file)
        let text = String(decoding: bytes, as: UTF8.self)
        for clear in ["maya-account-id", maya.envelope.signingPublicKey, maya.envelope.encryptionPublicKey, "entries", "revision"] {
            #expect(!text.contains(clear), "\(clear) is on disk in the clear")
        }
        // Another settings key (the server served a new one, or the record was swapped in): unreadable, never empty.
        let underB = guardStore(folder, owner, key: settingsKey(8))
        #expect(throws: GuardError.unreadable) { _ = try underB.entry("maya-account-id") }
        #expect(throws: GuardError.unreadable) { _ = try underB.entry("someone-else") }
        // And never written over: a write under B would have dropped what A recorded.
        #expect(throws: GuardError.unreadable) { try underB.putPending("someone-else", PendingAct(target: "t", revision: 0, at: "now", base: 0)) }
        // No key at all (an account not unlocked on this phone): the same.
        #expect(throws: GuardError.unreadable) { _ = try guardStore(folder, owner, key: nil).entries() }
        // The same record moved under another account's slot does not open there.
        let other = guardStore(folder, AccountOwner(userId: "someone", origin: owner.origin), key: settingsKey(7))
        try FileManager.default.copyItem(at: sealedUnderA.file, to: other.file)
        #expect(throws: GuardError.unreadable) { _ = try other.entries() }
        #expect(try sealedUnderA.entry("maya-account-id") != nil)
    }

    @Test func aCommitOverARevisionAnotherProcessMovedIsRefused() throws {
        let folder = guardFolder()
        // The app and the Files extension: two stores, one file.
        let app = guardStore(folder, owner)
        let files = guardStore(folder, owner)
        let first = try makeIdentity("maya")
        let second = try makeIdentity("maya")
        let read = try files.entry("maya")
        try app.commit("maya", try guardEntryNext(previous: nil, pin: try firstSeen(first.envelope)), over: 0)
        // The extension decided over what it read before the app wrote: its late write never lands over the newer entry.
        #expect(throws: GuardError.raced) {
            try files.commit("maya", try guardEntryNext(previous: read, pin: try firstSeen(second.envelope)), over: read?.revision ?? 0)
        }
        #expect(try app.entry("maya")?.signingPublicKey == first.envelope.signingPublicKey)
    }

    @Test func eightWritersAtOnceLoseNoRevision() async throws {
        let folder = guardFolder()
        let maya = try makeIdentity("maya")
        let keys = try firstSeen(maya.envelope)
        let owner = owner
        // Each writer reads, moves the entry one revision on and retries when another got there first.
        try await withThrowingTaskGroup(of: Void.self) { group in
            for _ in 0..<8 {
                group.addTask {
                    let store = guardStore(folder, owner)
                    while true {
                        let held = try store.entry("maya")
                        do {
                            try store.commit("maya", try guardEntryNext(previous: held, pin: keys), over: held?.revision ?? 0)
                            return
                        } catch GuardError.raced {
                            continue
                        }
                    }
                }
            }
            try await group.waitForAll()
        }
        #expect(try guardStore(folder, owner).entry("maya")?.revision == 8)
    }

    @Test func twoAccountsWithOneUserIdOnTwoServersKeepSeparateGuards() throws {
        let folder = guardFolder()
        let production = guardStore(folder, AccountOwner(userId: "me", origin: "https://hushos.com"))
        let staging = guardStore(folder, AccountOwner(userId: "me", origin: "https://staging.hushos.com"))
        let maya = try makeIdentity("maya")
        try production.commit("maya", try guardEntryNext(previous: nil, pin: try firstSeen(maya.envelope)), over: 0)
        // A staging copy of the database reuses the id: what production's account acted on is no mark for it.
        #expect(try staging.entry("maya") == nil)
        #expect(production.file != staging.file)
        // And the file names neither the account nor the server.
        #expect(!production.file.lastPathComponent.contains("me") && !production.file.lastPathComponent.contains("hushos"))
    }
}

extension OnFakeDrive {
    /*
     * Contacts without comparing words (docs/optional-verification.md 2): first-seen pins, the
     * guard's commit, changes that pause one person until Continue or a check, removals that
     * stick, and settings replaced by a newer copy, against a stub of the server's routes.
     */
    @Suite struct ContactTrustTests {
        let me = UUID().uuidString.lowercased()
        let maya = UUID().uuidString.lowercased()
        let root: Data
        let own: IdentityEnvelope

        init() throws {
            root = try randomBytes(length: 32)
            own = try identityCreate(userId: me, accountKey: root, keyVersion: 1)
        }

        struct Phone {
            let vault: Vault
            let guardStore: ContactGuardStore
            let writes: GuardSwitch
        }

        /* A phone signed in as `me`: its own guard (or another process's view of the same one). */
        func phone(_ server: ContactServer, folder: URL = guardFolder()) async -> Phone {
            let session = SharedKeychain.Session(origin: "https://contacts.test", token: "t-\(me)", userId: me)
            ContactServer.current = server
            Auth.testSession = session
            let configuration = URLSessionConfiguration.ephemeral
            configuration.protocolClasses = [ContactServerProtocol.self]
            Auth.testTransport = configuration
            let vault = Vault(api: DriveAPI(session: session, configuration: configuration), session: session)
            await vault.adopt(accountKey: root)
            let writes = GuardSwitch()
            // No key of its own: the vault seals it under the account's settings key, as the app does.
            let store = guardStore(folder, AccountOwner(session), writes: writes, key: nil)
            await vault.adopt(guard: store)
            return Phone(vault: vault, guardStore: store, writes: writes)
        }

        func server(maya identity: IdentityEnvelope) -> ContactServer {
            let server = ContactServer(me: me, identity: own)
            server.people["maya@example.com"] = (maya, "Maya Lind", identity)
            return server
        }

        func done() { Auth.testSession = nil; Auth.testTransport = nil; ContactServer.current = nil }

        func contact(_ server: ContactServer) throws -> Contact {
            let found = try #require(server.people["maya@example.com"])
            let envelope = found.identity
            return Contact(userId: maya, name: found.name, email: "maya@example.com", keyVersion: envelope.keyVersion, identityVersion: Int(envelope.version),
                           encryptionPublicKey: envelope.encryptionPublicKey, signingPublicKey: envelope.signingPublicKey,
                           mlDsaPublicKey: envelope.mlDsa?.publicKey, kemPublicKey: envelope.kem?.publicKey, keysSignature: envelope.keysSignature,
                           upgraded: keysHold(userId: maya, servedOf(envelope), identityVersion: Int(envelope.version), keysSignature: envelope.keysSignature),
                           fingerprint: nil)
        }

        func granter(_ server: ContactServer) throws -> SharedWithMeView.Granter {
            let envelope = try #require(server.people["maya@example.com"]).identity
            var granter = SharedWithMeView.Granter(id: maya, name: "Maya Lind", email: "maya@example.com", encryptionPublicKey: envelope.encryptionPublicKey)
            granter.signingPublicKey = envelope.signingPublicKey
            granter.keyVersion = envelope.keyVersion
            granter.identityVersion = Int(envelope.version)
            granter.mlDsaPublicKey = envelope.mlDsa?.publicKey
            granter.kemPublicKey = envelope.kem?.publicKey
            granter.keysSignature = envelope.keysSignature
            return granter
        }

        /* Maya starts over on the server with keys her old ones never signed. */
        func startOver(_ server: ContactServer) throws -> IdentityEnvelope {
            let fresh = try identityCreate(userId: maya, accountKey: try randomBytes(length: 32), keyVersion: 1)
            server.people["maya@example.com"]?.identity = fresh
            return fresh
        }

        func storedPin(_ server: ContactServer) throws -> [String: Any]? {
            (try server.document(root: root)["contacts"] as? [String: Any])?[maya] as? [String: Any]
        }

        @Test func addingSomeoneWritesAFirstSeenPinOfTheServedKeysAndNoWords() async throws {
            defer { done() }
            let identity = try makeIdentity(maya)
            let server = server(maya: identity.envelope)
            let phone = await phone(server)
            let added = try await phone.vault.addContact(email: "maya@example.com")
            guard case .added(let pin) = added else { Issue.record("not added: \(added)"); return }
            // First-seen: the four keys served now, an empty fingerprint (never verified by any client), no words.
            #expect(pin.trust == .seen && !pin.verified)
            #expect(pin.commitment == (try contact(server)).commitment)
            let stored = try #require(try storedPin(server))
            #expect(stored["fingerprint"] as? String == "" && stored["firstSeen"] as? String == "added")
            // The guard holds the same keys, and the act left nothing pending.
            let entry = try #require(try await phone.vault.contactGuard.entry(maya))
            #expect(keyCommitment(pin: entry.keys) == pin.commitment && entry.revision == 1 && !entry.verified)
            #expect(try await phone.vault.contactGuard.pending(maya) == nil)
            // Adding again over the same keys says so and writes nothing.
            let puts = server.puts
            guard case .already = try await phone.vault.addContact(email: "maya@example.com") else { Issue.record("added twice"); return }
            #expect(server.puts == puts)
        }

        @Test func aShareSealsOnlyToThePinnedKeysAndAChangeSharesNothingUntilContinue() async throws {
            defer { done() }
            let identity = try makeIdentity(maya)
            let server = server(maya: identity.envelope)
            let phone = await phone(server)
            _ = try await phone.vault.addContact(email: "maya@example.com")
            let sealing = try await phone.vault.trustGrantee(try contact(server), follow: true)
            #expect(sealing.publicKey == (try base64urlDecode(value: identity.envelope.encryptionPublicKey)))
            #expect(sealing.kem == (try base64urlDecode(value: identity.envelope.kem!.publicKey)))
            // Keys her old ones never signed: paused, as the one notice, and nothing sealed to them.
            let fresh = try startOver(server)
            await #expect(throws: AccountChangedError.self) { _ = try await phone.vault.trustGrantee(try contact(server), follow: true) }
            #expect(await phone.vault.accountChanges()[maya] != nil)
            #expect(try await phone.vault.contactStandings()[maya]?.verified == false)
            // Continue: the new keys, first-seen, the old signing key kept as hers, and her shares queued to be sealed again.
            let pin = try await phone.vault.continueWith(AccountChange(contactId: maya, name: "Maya Lind", email: "maya@example.com"))
            #expect(pin.trust == .seen && pin.signingPublicKey == fresh.signingPublicKey)
            #expect(pin.previousSigningKeys == [identity.envelope.signingPublicKey] && pin.resealShares == true)
            #expect(ResealTo.contains(maya))
            #expect(await phone.vault.accountChanges()[maya] == nil)
            let after = try await phone.vault.trustGrantee(try contact(server), follow: true)
            #expect(after.publicKey == (try base64urlDecode(value: fresh.encryptionPublicKey)))
            #expect(try await phone.vault.contactGuard.entry(maya)?.signingPublicKey == fresh.signingPublicKey)
            ResealTo.remove([maya])
        }

        @Test func aVerifiedContactsChangeLeadsWithACheckAndContinueDropsVerified() async throws {
            defer { done() }
            let server = server(maya: try makeIdentity(maya).envelope)
            let phone = await phone(server)
            let found = try await phone.vault.lookup(email: "maya@example.com")
            let checked = try await phone.vault.theyMatch(found)
            #expect(checked.trust == .verified)
            #expect(try await phone.vault.contactGuard.entry(maya)?.verified == true)
            #expect(try await phone.vault.contactStandings()[maya]?.verified == true)
            _ = try startOver(server)
            let changed = try await phone.vault.lookup(email: "maya@example.com")
            #expect(changed.changed && changed.wasVerified && !changed.verified)
            #expect(changed.heldFingerprint == checked.commitment)
            let pin = try await phone.vault.continueWith(AccountChange(contactId: maya, name: "Maya Lind", email: "maya@example.com"))
            // Verified was over the old keys; the new ones are first-seen until a check.
            #expect(pin.trust == .seen)
            #expect(try await phone.vault.contactStandings()[maya]?.verified == false)
            ResealTo.remove([maya])
        }

        @Test func settingsReplacedByANewerCopyAreAChangeNeverFirstUse() async throws {
            defer { done() }
            let identity = try makeIdentity(maya)
            let server = server(maya: identity.envelope)
            let phone = await phone(server)
            _ = try await phone.vault.addContact(email: "maya@example.com")
            // The server serves other keys for Maya and a newer settings copy pinning them first-seen, as a fresh device would save.
            let planted = try startOver(server)
            var document = try server.document(root: root)
            var contacts = document["contacts"] as? [String: Any] ?? [:]
            var pin = contacts[maya] as? [String: Any] ?? [:]
            let keys = try firstSeen(planted)
            pin["encryptionPublicKey"] = keys.encryptionPublicKey
            pin["signingPublicKey"] = keys.signingPublicKey
            pin["mlDsaPublicKeyHash"] = keys.mlDsaPublicKeyHash
            pin["kemPublicKeyHash"] = keys.kemPublicKeyHash
            // Even a previous-keys list naming what this phone holds stands in for no chain.
            pin["previousSigningKeys"] = [identity.envelope.signingPublicKey]
            contacts[maya] = pin
            document["contacts"] = contacts
            try server.replace(document, root: root)
            await #expect(throws: AccountChangedError.self) { _ = try await phone.vault.trustGrantee(try contact(server), follow: true) }
            #expect(try await phone.vault.contactStandings()[maya]?.changed == true)
            // Nor does a copy that drops her: a share from her (under the keys this phone holds) waits for the person's Open
            // instead of being pinned on its own, and one under the planted keys is the notice.
            document["contacts"] = [String: Any]()
            try server.replace(document, root: root)
            await #expect(throws: GranterTrust.self) { _ = try await phone.vault.trustGranter(try granter(server), explicit: false) }
            server.people["maya@example.com"]?.identity = identity.envelope
            try server.replace(document, root: root)
            await #expect(throws: GranterTrust.waiting("Open this to add Maya to your contacts.")) {
                _ = try await phone.vault.trustGranter(try granter(server), explicit: false)
            }
            #expect(try storedPin(server) == nil)
            // Who wrote what judges by the guard's keys, not the settings': a record under the planted keys is nobody's.
            let pins = try await phone.vault.effectivePins()
            #expect(pins.isEmpty)
        }

        @Test func aLostSettingsAnswerIsFinishedByThePendingRecordAndNothingElse() async throws {
            defer { done() }
            let server = server(maya: try makeIdentity(maya).envelope)
            let folder = guardFolder()
            let phone = await phone(server, folder: folder)
            _ = try await phone.vault.addContact(email: "maya@example.com")
            let fresh = try startOver(server)
            // Continue's save lands on the server, and its answer is lost.
            server.loseNextSettingsAnswer = true
            await #expect(throws: (any Error).self) {
                _ = try await phone.vault.continueWith(AccountChange(contactId: maya, name: "Maya Lind", email: "maya@example.com"))
            }
            let pending = try #require(try await phone.vault.contactGuard.pending(maya))
            #expect(pending.target == (try contact(server)).commitment && pending.revision == 1)
            // Without the pending record, the same settings would be a change: here it finishes silently.
            let restarted = await self.phone(server, folder: folder)
            let sealing = try await restarted.vault.trustGrantee(try contact(server), follow: true)
            #expect(sealing.publicKey == (try base64urlDecode(value: fresh.encryptionPublicKey)))
            let finished = await restarted.vault.contactGuard
            #expect(try finished.entry(maya)?.revision == 2 && (try finished.pending(maya)) == nil)
            ResealTo.remove([maya])
        }

        @Test func withoutAPendingRecordAMovedPinIsAChange() async throws {
            defer { done() }
            let server = server(maya: try makeIdentity(maya).envelope)
            let folder = guardFolder()
            let phone = await phone(server, folder: folder)
            _ = try await phone.vault.addContact(email: "maya@example.com")
            _ = try startOver(server)
            server.loseNextSettingsAnswer = true
            _ = try? await phone.vault.continueWith(AccountChange(contactId: maya, name: "Maya Lind", email: "maya@example.com"))
            try await phone.vault.contactGuard.dropPending(maya)
            await #expect(throws: AccountChangedError.self) { _ = try await phone.vault.trustGrantee(try contact(server), follow: true) }
            #expect(try await phone.vault.contactGuard.entry(maya)?.revision == 1)
        }

        @Test func aVaultThatCannotOpenTheSettingsKeyCannotReadTheGuard() async throws {
            defer { done() }
            let server = server(maya: try makeIdentity(maya).envelope)
            let folder = guardFolder()
            let phone = await phone(server, folder: folder)
            _ = try await phone.vault.addContact(email: "maya@example.com")
            #expect(try await phone.vault.contactGuard.entry(maya) != nil)
            // The same account on this phone with no account key opened (signed in, nothing unlocked): ciphertext only.
            let session = SharedKeychain.Session(origin: "https://contacts.test", token: "t-\(me)", userId: me)
            let locked = Vault(api: DriveAPI(session: session, configuration: Auth.testTransport!), session: session)
            await locked.adopt(guard: guardStore(folder, AccountOwner(session), key: nil))
            await locked.resolveGuardKey()
            await #expect(throws: GuardError.unreadable) { _ = try await locked.contactGuard.entries() }
        }

        @Test func aContinueFinishedAfterItsAppStoppedStillResealsWhatWasShared() async throws {
            defer { done() }
            let server = server(maya: try makeIdentity(maya).envelope)
            let folder = guardFolder()
            let phone = await phone(server, folder: folder)
            _ = try await phone.vault.addContact(email: "maya@example.com")
            // Shared with her before her account changed: the ledger and the server's list both hold it.
            let workspace = UUID().uuidString.lowercased()
            let nodeId = UUID().uuidString.lowercased()
            var document = try server.document(root: root)
            document["sharing"] = ["shares": [nodeId: [maya]], "links": [String: Any]()]
            try server.replace(document, root: root)
            let node = try JSONDecoder().decode(NodeView.self, from: JSONSerialization.data(withJSONObject: [
                "id": nodeId, "workspaceId": workspace, "kind": "file", "keyEpoch": 3, "parentKeyEpoch": 1, "keyEnvelope": "k",
                "metadataVersion": 1, "metadataEnvelope": "m",
            ]))
            let nodeKey = try randomBytes(length: 32)
            // She starts over; Continue's save lands, its answer is lost, and the app stops before queuing the re-seal.
            let freshRoot = try randomBytes(length: 32)
            let fresh = try identityCreate(userId: maya, accountKey: freshRoot, keyVersion: 1)
            server.people["maya@example.com"]?.identity = fresh
            server.loseNextSettingsAnswer = true
            _ = try? await phone.vault.continueWith(AccountChange(contactId: maya, name: "Maya Lind", email: "maya@example.com"))
            ResealTo.remove([maya])
            defer { ResealTo.remove([maya]) }
            server.sharesMine = [[
                "id": "share-1", "role": "viewer", "keyEpoch": 3, "createdAt": "2026-10-30T00:00:00Z", "suite": 4,
                "grantee": ["id": maya, "name": "Maya Lind", "email": "maya@example.com"],
                "node": try JSONSerialization.jsonObject(with: JSONEncoder().encode(node)),
                "granteeIdentity": [
                    "keyVersion": fresh.keyVersion, "identityVersion": Int(fresh.version), "encryptionPublicKey": fresh.encryptionPublicKey,
                    "signingPublicKey": fresh.signingPublicKey, "mlDsaPublicKey": fresh.mlDsa!.publicKey, "kemPublicKey": fresh.kem!.publicKey,
                    "keysSignature": fresh.keysSignature!,
                ],
            ]]
            // The next process: the pending record finishes the act, and the re-seal is queued with it.
            let restarted = await self.phone(server, folder: folder)
            _ = try await restarted.vault.adopt(node, nodeKey: nodeKey, metadata: NodeMetadata(name: "plan.md", mime: nil, size: 3, modified: nil, attributes: [:]),
                                                in: workspace)
            _ = try await restarted.vault.trustGrantee(try contact(server), follow: false)
            #expect(ResealTo.contains(maya))
            // The upgrade pass seals that share again, to her new keys and nothing else.
            let outcome = try await restarted.vault.upgradeShares()
            #expect(outcome.rotated == 1 && outcome.skipped.isEmpty)
            let resealed = try #require(server.resealed["share-1"])
            let ownKeys = try identityOpen(userId: me, accountKey: root, envelope: own)
            let opened = try shareOpen(
                envelope: try base64urlDecode(value: resealed),
                granter: HybridPublicKey(signingPublicKey: try base64urlDecode(value: ownKeys.signingPublicKey),
                                         mlDsaPublicKey: try base64urlDecode(value: ownKeys.mlDsaPublicKey!)),
                grantee: try identityOpen(userId: maya, accountKey: freshRoot, envelope: fresh),
                ctx: ShareContext(workspaceId: workspace, nodeId: nodeId, keyEpoch: 3, granteeUserId: maya, granterUserId: me)
            )
            #expect(opened == nodeKey)
            #expect(!ResealTo.contains(maya))
        }

        struct Stopped: Error {}

        @Test func aStopRightAfterContinuesGuardCommitStillLeavesItsResealQueued() async throws {
            defer { done() }
            let server = server(maya: try makeIdentity(maya).envelope)
            let folder = guardFolder()
            let phone = await phone(server, folder: folder)
            _ = try await phone.vault.addContact(email: "maya@example.com")
            let workspace = UUID().uuidString.lowercased()
            let nodeId = UUID().uuidString.lowercased()
            var document = try server.document(root: root)
            document["sharing"] = ["shares": [nodeId: [maya]], "links": [String: Any]()]
            try server.replace(document, root: root)
            let node = try JSONDecoder().decode(NodeView.self, from: JSONSerialization.data(withJSONObject: [
                "id": nodeId, "workspaceId": workspace, "kind": "file", "keyEpoch": 3, "parentKeyEpoch": 1, "keyEnvelope": "k",
                "metadataVersion": 1, "metadataEnvelope": "m",
            ]))
            let nodeKey = try randomBytes(length: 32)
            let freshRoot = try randomBytes(length: 32)
            let fresh = try identityCreate(userId: maya, accountKey: freshRoot, keyVersion: 1)
            server.people["maya@example.com"]?.identity = fresh
            ResealTo.remove([maya])
            defer { ResealTo.remove([maya]) }
            // Continue's save lands and the guard commits (the pending record goes), and the process stops right there.
            await phone.vault.adopt(afterGuardCommit: { throw Stopped() })
            await #expect(throws: Stopped.self) {
                _ = try await phone.vault.continueWith(AccountChange(contactId: maya, name: "Maya Lind", email: "maya@example.com"))
            }
            // Nothing is left for a later read to settle: the guard and the settings agree, and no pending record names her.
            let settled = await phone.vault.contactGuard
            #expect(try settled.pending(maya) == nil && (try settled.entry(maya))?.signingPublicKey == fresh.signingPublicKey)
            // So the re-seal must already be queued, or what was shared with her stays on her old keys for good.
            #expect(ResealTo.contains(maya))
            server.sharesMine = [[
                "id": "share-1", "role": "viewer", "keyEpoch": 3, "createdAt": "2026-10-30T00:00:00Z", "suite": 4,
                "grantee": ["id": maya, "name": "Maya Lind", "email": "maya@example.com"],
                "node": try JSONSerialization.jsonObject(with: JSONEncoder().encode(node)),
                "granteeIdentity": [
                    "keyVersion": fresh.keyVersion, "identityVersion": Int(fresh.version), "encryptionPublicKey": fresh.encryptionPublicKey,
                    "signingPublicKey": fresh.signingPublicKey, "mlDsaPublicKey": fresh.mlDsa!.publicKey, "kemPublicKey": fresh.kem!.publicKey,
                    "keysSignature": fresh.keysSignature!,
                ],
            ]]
            // The next process's upgrade pass seals that share again, to her new keys.
            let restarted = await self.phone(server, folder: folder)
            _ = try await restarted.vault.adopt(node, nodeKey: nodeKey, metadata: NodeMetadata(name: "plan.md", mime: nil, size: 3, modified: nil, attributes: [:]),
                                                in: workspace)
            let outcome = try await restarted.vault.upgradeShares()
            #expect(outcome.rotated == 1)
            let resealed = try #require(server.resealed["share-1"])
            let ownKeys = try identityOpen(userId: me, accountKey: root, envelope: own)
            let opened = try shareOpen(
                envelope: try base64urlDecode(value: resealed),
                granter: HybridPublicKey(signingPublicKey: try base64urlDecode(value: ownKeys.signingPublicKey),
                                         mlDsaPublicKey: try base64urlDecode(value: ownKeys.mlDsaPublicKey!)),
                grantee: try identityOpen(userId: maya, accountKey: freshRoot, envelope: fresh),
                ctx: ShareContext(workspaceId: workspace, nodeId: nodeId, keyEpoch: 3, granteeUserId: maya, granterUserId: me)
            )
            #expect(opened == nodeKey)
        }

        @Test func theShareSheetsLookupIsKeptForAMinuteAndForgottenOnContinue() async throws {
            defer { done() }
            let server = server(maya: try makeIdentity(maya).envelope)
            let phone = await phone(server)
            guard case .added(let pin) = try await phone.vault.addContact(email: "maya@example.com") else { Issue.record("not added"); return }
            let before = server.lookups
            #expect(try await !phone.vault.shareeChanged(pin))
            #expect(try await !phone.vault.shareeChanged(pin))
            // One lookup for two loads of the sheet within the minute: the account's sixty a minute stay for Add and Share.
            #expect(server.lookups == before + 1)
            // Her keys change: the kept lookup still says nothing changed (it is display only, never what is sealed to)...
            _ = try startOver(server)
            #expect(try await !phone.vault.shareeChanged(pin))
            // ...until the share itself, which looks up afresh, meets the change, and Continue settles it and forgets the kept one.
            await #expect(throws: AccountChangedError.self) { _ = try await phone.vault.trustGrantee(try contact(server), follow: true) }
            _ = try await phone.vault.continueWith(AccountChange(contactId: maya, name: "Maya Lind", email: "maya@example.com"))
            let afterContinue = server.lookups
            #expect(try await !phone.vault.shareeChanged(pin))
            #expect(server.lookups == afterContinue + 1)
            ResealTo.remove([maya])
        }

        @Test func oneMountingPassReadsTheSettingsOnceAndNeverReusesAVerdictForOtherKeys() async throws {
            defer { done() }
            let identity = try makeIdentity(maya)
            let server = server(maya: identity.envelope)
            let phone = await phone(server)
            _ = try await phone.vault.addContact(email: "maya@example.com")
            let reads = server.settingsReads
            let pass = MountPass()
            // Three shares from Maya, under the keys she was added with: one settings read, one verdict.
            for _ in 0..<3 {
                let opened = try await phone.vault.trustGranter(try granter(server), explicit: false, pass: pass)
                #expect(opened.signingPublicKey == (try base64urlDecode(value: identity.envelope.signingPublicKey)))
            }
            #expect(server.settingsReads == reads + 1)
            // A fourth share "from" her under other keys, in the same pass: judged on its own, and it is the change.
            _ = try startOver(server)
            await #expect(throws: GranterTrust.self) { _ = try await phone.vault.trustGranter(try granter(server), explicit: false, pass: pass) }
            // Without a pass, each share reads the settings.
            let unpassed = server.settingsReads
            server.people["maya@example.com"]?.identity = identity.envelope
            for _ in 0..<2 { _ = try await phone.vault.trustGranter(try granter(server), explicit: false) }
            #expect(server.settingsReads == unpassed + 2)
        }

        @Test func onePassNeverSealsToOtherKeysServedLaterForThePersonItAccepted() async throws {
            defer { done() }
            let identity = try makeIdentity(maya)
            let server = server(maya: identity.envelope)
            let phone = await phone(server)
            _ = try await phone.vault.addContact(email: "maya@example.com")
            let workspace = UUID().uuidString.lowercased()
            let nodeIds = [UUID().uuidString.lowercased(), UUID().uuidString.lowercased()]
            var document = try server.document(root: root)
            document["sharing"] = ["shares": [nodeIds[0]: [maya], nodeIds[1]: [maya]], "links": [String: Any]()]
            try server.replace(document, root: root)
            func served(_ envelope: IdentityEnvelope) -> [String: Any] {
                ["keyVersion": envelope.keyVersion, "identityVersion": Int(envelope.version), "encryptionPublicKey": envelope.encryptionPublicKey,
                 "signingPublicKey": envelope.signingPublicKey, "mlDsaPublicKey": envelope.mlDsa!.publicKey, "kemPublicKey": envelope.kem!.publicKey,
                 "keysSignature": envelope.keysSignature!]
            }
            // Two shares to Maya, both owed a re-seal (an older suite): the first lists her keys, the second other keys under her name.
            let planted = try makeIdentity(maya).envelope
            server.sharesMine = []
            for (index, nodeId) in nodeIds.enumerated() {
                let node = try JSONDecoder().decode(NodeView.self, from: JSONSerialization.data(withJSONObject: [
                    "id": nodeId, "workspaceId": workspace, "kind": "file", "keyEpoch": 3, "parentKeyEpoch": 1, "keyEnvelope": "k",
                    "metadataVersion": 1, "metadataEnvelope": "m",
                ]))
                _ = try await phone.vault.adopt(node, nodeKey: try randomBytes(length: 32),
                                                metadata: NodeMetadata(name: "f\(index)", mime: nil, size: 3, modified: nil, attributes: [:]), in: workspace)
                server.sharesMine.append([
                    "id": "share-\(index + 1)", "role": "viewer", "keyEpoch": 3, "createdAt": "2026-10-30T00:00:00Z", "suite": 3,
                    "grantee": ["id": maya, "name": "Maya Lind", "email": "maya@example.com"],
                    "node": try JSONSerialization.jsonObject(with: JSONEncoder().encode(node)),
                    "granteeIdentity": served(index == 0 ? identity.envelope : planted),
                ])
            }
            let outcome = try await phone.vault.upgradeShares()
            // The first is sealed to the keys she was added with; the second is never sealed on the strength of the first's verdict.
            #expect(server.resealed["share-1"] != nil)
            #expect(server.resealed["share-2"] == nil)
            #expect(outcome.rotated == 1 && outcome.skipped.contains("Maya’s account changed."))
        }

        @Test func aRotationThatCannotReadTheGuardStopsBeforeSendingAndLeavesNobodyOut() async throws {
            defer { done() }
            let server = server(maya: try makeIdentity(maya).envelope)
            let phone = await phone(server)
            _ = try await phone.vault.addContact(email: "maya@example.com")
            // A file shared with Maya, in the owner's own drive.
            let workspace = UUID().uuidString.lowercased()
            let nodeId = UUID().uuidString.lowercased()
            let workspaceKey = try randomBytes(length: 32)
            await phone.vault.adopt(workspace: WorkspaceView(workspaceId: workspace, changeSeq: nil, grant: nil, root: nil), key: workspaceKey)
            let nodeKey = try randomBytes(length: 32)
            let metadata = NodeMetadata(name: "plan.md", mime: nil, size: 3, modified: nil, attributes: [:])
            let sealed = try metadataSeal(ctx: MetadataContext(workspaceId: workspace, nodeId: nodeId, metadataVersion: 1), nodeKey: nodeKey, metadata: metadata)
            let node: [String: Any] = ["id": nodeId, "workspaceId": workspace, "kind": "file", "keyEpoch": 1, "parentKeyEpoch": 1, "keyEnvelope": "k",
                                       "metadataVersion": 1, "metadataEnvelope": base64urlEncode(bytes: sealed)]
            let item = try await phone.vault.adopt(try JSONDecoder().decode(NodeView.self, from: JSONSerialization.data(withJSONObject: node)),
                                                   nodeKey: nodeKey, metadata: metadata, in: workspace)
            var document = try server.document(root: root)
            document["sharing"] = ["shares": [nodeId: [maya]], "links": [String: Any]()]
            try server.replace(document, root: root)
            let served = try #require(server.people["maya@example.com"]).identity
            nonisolated(unsafe) var sent: [[String: Any]] = []
            server.routes = { method, path, body in
                switch (method, path) {
                case ("POST", "/api/drive/nodes/\(nodeId)/rotation"):
                    return (200, ["rotation": ["nodeId": nodeId, "targetEpoch": 2]])
                case ("GET", "/api/drive/nodes/\(nodeId)/rotation/work"):
                    var entry = node
                    entry["depth"] = 0
                    entry["versions"] = [Any]()
                    entry["links"] = [Any]()
                    entry["shares"] = [["id": "share-1", "granteeUserId": self.maya, "grantee": [
                        "keyVersion": served.keyVersion, "identityVersion": Int(served.version), "encryptionPublicKey": served.encryptionPublicKey,
                        "signingPublicKey": served.signingPublicKey, "mlDsaPublicKey": served.mlDsa!.publicKey, "kemPublicKey": served.kem!.publicKey,
                        "keysSignature": served.keysSignature!,
                    ]]]
                    let done = !sent.isEmpty
                    return (200, ["rotation": ["nodeId": nodeId, "targetEpoch": 2], "nodes": done ? [] : [entry], "nextCursor": NSNull(), "done": done])
                case ("POST", "/api/drive/nodes/\(nodeId)/rotation/nodes"):
                    sent += body["nodes"] as? [[String: Any]] ?? []
                    return (200, ["results": [["id": nodeId, "status": "ok"]]])
                default:
                    return nil
                }
            }
            // Whom to trust loaded before the disk went bad; then the guard can't be read.
            await phone.vault.adopt(signers: try TrustedSigners(userId: me, identities: [try identityOpen(userId: me, accountKey: root, envelope: own)], pins: []))
            try Data("damaged".utf8).write(to: phone.guardStore.file)
            // Left out, Maya's share would be revoked by the server: the rotation stops instead, having sent nothing.
            await #expect(throws: GuardError.unreadable) { _ = try await phone.vault.rotate(item) }
            #expect(sent.isEmpty)
        }

        @Test func aGuardWriteThatFailsStopsTheActAndTheNextOneSettlesIt() async throws {
            defer { done() }
            let server = server(maya: try makeIdentity(maya).envelope)
            let phone = await phone(server)
            // The disk refuses the guard's write right after the settings saved.
            server.onSettingsPut = { phone.writes.writable = false }
            await #expect(throws: GuardError.unsaved) { _ = try await phone.vault.addContact(email: "maya@example.com") }
            #expect(try storedPin(server) != nil)
            // Nothing is shared on the strength of an act that wasn't recorded.
            await #expect(throws: GuardError.unsaved) { _ = try await phone.vault.trustGrantee(try contact(server), follow: true) }
            server.onSettingsPut = nil
            phone.writes.writable = true
            // Space again: the pending record names exactly the pin the settings hold, and the act finishes.
            _ = try await phone.vault.trustGrantee(try contact(server), follow: true)
            let settled = await phone.vault.contactGuard
            #expect(try settled.entry(maya) != nil && (try settled.pending(maya)) == nil)
        }

        @Test func anUnreadableGuardPausesEveryoneAndPinsNobody() async throws {
            defer { done() }
            let server = server(maya: try makeIdentity(maya).envelope)
            let phone = await phone(server)
            _ = try await phone.vault.addContact(email: "maya@example.com")
            try Data("damaged".utf8).write(to: phone.guardStore.file)
            await #expect(throws: GuardError.unreadable) { _ = try await phone.vault.trustGrantee(try contact(server), follow: true) }
            await #expect(throws: GuardError.unreadable) { _ = try await phone.vault.contactStandings() }
            await #expect(throws: GuardError.unreadable) { _ = try await phone.vault.trustGranter(try granter(server), explicit: true) }
            // Someone new is no first use while the guard can't be read.
            server.people["sam@example.com"] = ("sam", "Sam", try makeIdentity("sam").envelope)
            let before = server.puts
            await #expect(throws: GuardError.unreadable) { _ = try await phone.vault.addContact(email: "sam@example.com") }
            #expect(server.puts == before)
        }

        @Test func aShareFromSomeoneNeverAddedPinsTheKeysItCameWithAndOtherKeysPause() async throws {
            defer { done() }
            let identity = try makeIdentity(maya)
            let server = server(maya: identity.envelope)
            let phone = await phone(server)
            let opened = try await phone.vault.trustGranter(try granter(server), explicit: false)
            #expect(opened.signingPublicKey == (try base64urlDecode(value: identity.envelope.signingPublicKey)))
            let stored = try #require(try storedPin(server))
            #expect(stored["firstSeen"] as? String == "shared-with-me" && stored["fingerprint"] as? String == "")
            // A second share "from" Maya under keys of the server's: the notice, never a second first use.
            _ = try startOver(server)
            await #expect(throws: GranterTrust.self) { _ = try await phone.vault.trustGranter(try granter(server), explicit: false) }
            #expect(await phone.vault.accountChanges()[maya] != nil)
        }

        @Test func aRemovedContactsShareWaitsForOpenWhichAddsThemBack() async throws {
            defer { done() }
            let server = server(maya: try makeIdentity(maya).envelope)
            let phone = await phone(server)
            _ = try await phone.vault.addContact(email: "maya@example.com")
            try await phone.vault.remove(maya)
            #expect((try server.document(root: root)["removedContacts"] as? [String: Any])?[maya] != nil)
            #expect(try storedPin(server) == nil)
            // Listing what she shared never adds her back on its own, on this phone or one with no guard for her.
            await #expect(throws: GranterTrust.waiting("You removed Maya from your contacts. Open this to add them again.")) {
                _ = try await phone.vault.trustGranter(try granter(server), explicit: false)
            }
            let fresh = await self.phone(server)
            await #expect(throws: GranterTrust.waiting("You removed Maya from your contacts. Open this to add them again.")) {
                _ = try await fresh.vault.trustGranter(try granter(server), explicit: false)
            }
            #expect(try storedPin(server) == nil)
            // Open is the person's act: she is added back and the removal forgotten.
            try await phone.vault.openWaiting(try granter(server))
            #expect(try storedPin(server) != nil)
            #expect((try server.document(root: root)["removedContacts"] as? [String: Any])?[maya] == nil)
        }

        @Test func aLegacyPinBecomesFirstSeenOnlyUnderAStatementItsOwnKeySigned() async throws {
            defer { done() }
            let identity = try makeIdentity(maya)
            let server = server(maya: identity.envelope)
            let phone = await phone(server)
            let legacy = pinnedBeforeTheRelease(try pinned(maya, identity.keys, name: "Maya Lind"))
            var settings = Settings()
            settings.setPin(legacy)
            // A statement signed by another key beside Maya's classical keys: left legacy, nothing shared.
            var forged = identity.envelope
            forged.keysSignature = try makeIdentity(maya).envelope.keysSignature
            server.people["maya@example.com"]?.identity = forged
            try server.replace(try reread(settings), root: root)
            await #expect(throws: ContactError.self) { _ = try await phone.vault.trustGrantee(try contact(server), follow: true) }
            #expect(try storedPin(server)?["mlDsaPublicKeyHash"] == nil)
            // Her own statement: first-seen over the served keys, never verified.
            server.people["maya@example.com"]?.identity = identity.envelope
            _ = try await phone.vault.trustGrantee(try contact(server), follow: true)
            let upgraded = try #require(try storedPin(server))
            #expect(upgraded["fingerprint"] as? String == "" && upgraded["mlDsaPublicKeyHash"] as? String != nil)
        }

        @Test func aSuccessionSignedByFirstSeenKeysIsFollowedAndStaysFirstSeen() async throws {
            defer { done() }
            let mayaRoot = try randomBytes(length: 32)
            let first = try identityCreate(userId: maya, accountKey: mayaRoot, keyVersion: 1)
            let server = server(maya: first)
            let phone = await phone(server)
            _ = try await phone.vault.addContact(email: "maya@example.com")
            let succession = try identitySucceed(userId: maya, accountKey: mayaRoot, current: first)
            server.people["maya@example.com"]?.identity = succession.identity
            server.links[maya] = [ContactServer.link(from: first, to: succession)]
            let found = try await phone.vault.lookup(email: "maya@example.com")
            #expect(found.followed && !found.changed)
            // The lookup moved whom signatures count for: the screen that asked must judge again.
            #expect(found.trustChanged)
            #expect(try await !phone.vault.lookup(email: "maya@example.com").trustChanged)
            let pin = try #require(found.pinned)
            #expect(pin.trust == .seen && pin.signingPublicKey == succession.identity.signingPublicKey)
            #expect(pin.previousSigningKeys?.contains(first.signingPublicKey) == true)
            // A chain the first-seen keys never signed (another account's link served as hers) is not followed.
            let otherRoot = try randomBytes(length: 32)
            let other = try identityCreate(userId: maya, accountKey: otherRoot, keyVersion: 2)
            let forged = try identitySucceed(userId: maya, accountKey: otherRoot, current: other)
            server.people["maya@example.com"]?.identity = forged.identity
            server.links[maya] = [ContactServer.link(from: other, to: forged)]
            #expect(try await phone.vault.lookup(email: "maya@example.com").changed)
            ResealTo.remove([maya])
        }

        @Test func firstSeenWritersReadAsSeenAndADisagreeingPinVouchesForNothing() async throws {
            defer { done() }
            let identity = try makeIdentity(maya)
            let server = server(maya: identity.envelope)
            let phone = await phone(server)
            _ = try await phone.vault.addContact(email: "maya@example.com")
            let pins = try await phone.vault.effectivePins()
            let signers = try TrustedSigners(userId: me, identities: [], pins: pins)
            let keys = try #require(signers.trusted(Signer(id: maya)))
            let signing = try base64urlDecode(value: identity.envelope.signingPublicKey)
            #expect(keys.seen && keys.current == signing)
            #expect(signers.provenance(.seen, signer: Signer(id: maya)) == nil)
        }
    }
}

/* Settings saves keep what other clients wrote, and removals count against the room (2.7). */
struct ContactSettingsTests {
    /* As the web and a later version write it: fields this version doesn't know, inside pins too. */
    let written = """
    {"version":2,"contacts":{"ana":{"userId":"ana","email":"ana@example.com","name":"Ana","encryptionPublicKey":"e","signingPublicKey":"s",\
    "fingerprint":"","pinnedAt":"2026-10-27T00:00:00.000Z","kemPublicKeyHash":"k","mlDsaPublicKeyHash":"m","keyVersion":1,"firstSeen":"shared-with-me",\
    "replacementSeen":"2026-10-20","trustedViaFamily":"Acme"}},"removedContacts":{"bo":"2026-10-28T10:00:00.000Z"},\
    "familyChecks":{"g1":{"rosterVersion":3,"with":"ana","code":["a","b"],"checkedAt":"2026-10-28T00:00:00.000Z"}},\
    "familyChecksSince":"2026-10-27T00:00:00.000Z","pendingRoles":{"g1":{"cy":"members"}},"resealOwnShares":true,\
    "groups":{"future":{"x":1.5,"y":"\\u00e9"}},"sharing":{"shares":{},"links":{},"stopping":{"n":["bo"]}}}
    """

    func field(_ json: String, _ key: String) throws -> Data {
        let object = try #require(try JSONSerialization.jsonObject(with: Data(json.utf8)) as? [String: Any])
        return try JSONSerialization.data(withJSONObject: [key: object[key] ?? NSNull()], options: [.sortedKeys, .withoutEscapingSlashes])
    }

    @Test func savesKeepEveryFieldOtherClientsWroteByteForByte() throws {
        var settings = try Settings(json: written, version: 7)
        let cy = ContactPin(userId: "cy", email: "cy@example.com", name: "Cy", keys: PinKeys(keyVersion: 1, encryptionPublicKey: "x", signingPublicKey: "y",
                                                                                         mlDsaPublicKeyHash: "a", kemPublicKeyHash: "b", fingerprint: ""),
                            pinnedAt: "2026-10-30T00:00:00Z", firstSeen: "added")
        try settings.setPinOnce(cy)
        settings.removeContact("dee", at: "2026-10-30T01:00:00.000Z")
        settings.ledger.addShare(node: "node-a", grantee: "cy")
        let saved = try settings.json()
        for key in ["familyChecks", "familyChecksSince", "pendingRoles", "resealOwnShares", "groups"] {
            #expect(try field(saved, key) == (try field(written, key)), "\(key) changed")
        }
        // Inside Ana's pin, untouched: firstSeen and the web's own fields.
        let ana = try #require(((try JSONSerialization.jsonObject(with: Data(saved.utf8)) as? [String: Any])?["contacts"] as? [String: Any])?["ana"] as? [String: Any])
        #expect(ana["firstSeen"] as? String == "shared-with-me" && ana["replacementSeen"] as? String == "2026-10-20" && ana["trustedViaFamily"] as? String == "Acme")
        #expect(ana["fingerprint"] as? String == "")
        // Bo's removal stays beside Dee's; the ledger's own extra field too.
        #expect(settings.removed("bo") && settings.removed("dee"))
        #expect(((try JSONSerialization.jsonObject(with: Data(saved.utf8)) as? [String: Any])?["sharing"] as? [String: Any])?["stopping"] != nil)
        // Writing a removed person's pin forgets their removal, and only theirs.
        try settings.setPinOnce(ContactPin(userId: "BO", email: "bo@example.com", name: "Bo", keys: cy.keys, pinnedAt: "2026-10-30T02:00:00Z", firstSeen: "added"))
        #expect(!settings.removed("bo") && settings.removed("dee"))
    }

    @Test func aPinStoredUnderTheIdInOtherLettersKeepsEveryFieldWhenWrittenUnderTheServedId() throws {
        let stored = """
        {"version":2,"contacts":{"ANA-ID":{"userId":"ANA-ID","email":"ana@example.com","name":"Ana","encryptionPublicKey":"e",\
        "signingPublicKey":"s","fingerprint":"","pinnedAt":"2026-10-27T00:00:00.000Z","kemPublicKeyHash":"k","mlDsaPublicKeyHash":"m",\
        "keyVersion":1,"firstSeen":"shared-with-me","replacementSeen":"2026-10-20","trustedViaFamily":"Acme","future":{"x":[1,"\\u00e9"]}}}}
        """
        var settings = try Settings(json: stored, version: 3)
        let before = try #require((try JSONSerialization.jsonObject(with: Data(stored.utf8)) as? [String: Any])?["contacts"] as? [String: Any])["ANA-ID"]
            as? [String: Any]
        let pin = ContactPin(userId: "ana-id", email: "ana@example.com", name: "Ana", keys: PinKeys(keyVersion: 2, encryptionPublicKey: "e2",
                             signingPublicKey: "s2", mlDsaPublicKeyHash: "m2", kemPublicKeyHash: "k2", fingerprint: ""),
                             pinnedAt: "2026-10-30T00:00:00Z", firstSeen: nil)
        try settings.setPinOnce(pin)
        let contacts = try #require(try reread(settings)["contacts"] as? [String: Any])
        // One pin, under the served id; the old key is gone.
        #expect(Array(contacts.keys) == ["ana-id"])
        let after = try #require(contacts["ana-id"] as? [String: Any])
        // Every field this version doesn't write, byte for byte.
        for key in ["firstSeen", "replacementSeen", "trustedViaFamily", "future"] {
            let was = try JSONSerialization.data(withJSONObject: [key: before?[key] ?? NSNull()], options: [.sortedKeys])
            let now = try JSONSerialization.data(withJSONObject: [key: after[key] ?? NSNull()], options: [.sortedKeys])
            #expect(was == now, "\(key) was lost or changed")
        }
        // And the known ones are the new pin's.
        #expect(after["signingPublicKey"] as? String == "s2" && after["userId"] as? String == "ana-id")
    }

    @Test func removalsAreForgottenOldestFirstAndAFullDocumentRefusesAPin() throws {
        var settings = Settings()
        let filler = String(repeating: "f", count: 600)
        var count = 0
        // Pins up to just under the cap.
        while try settings.bytes() < Settings.maxBytes - 2_000 {
            settings.setPin(ContactPin(userId: "p\(count)", email: "p\(count)@example.com", name: filler, encryptionPublicKey: "e", signingPublicKey: "s",
                                       fingerprint: "", pinnedAt: "2026-10-01T00:00:00Z", kemPublicKeyHash: nil))
            count += 1
        }
        for index in 0..<40 { settings.removeContact("gone-\(index)", at: String(format: "2026-10-%02dT00:00:00Z", index % 28 + 1) + "\(index)") }
        #expect(try settings.bytes() <= Settings.maxBytes)
        let oldest = settings.removals.first!.id
        let newest = settings.removals.last!.id
        let pin = ContactPin(userId: "new", email: "new@example.com", name: filler + filler, encryptionPublicKey: "e", signingPublicKey: "s",
                             fingerprint: "", pinnedAt: "2026-10-30T00:00:00Z", kemPublicKeyHash: nil)
        try settings.setPinOnce(pin)
        // Room was made by forgetting the oldest removals, never the newest, and never a pin.
        #expect(!settings.removed(oldest) && settings.removed(newest))
        #expect(settings.contacts.count == count + 1)
        // Full with no removal left to forget: refused, and the document as it was.
        settings.document["removedContacts"] = nil
        let before = try settings.json()
        var big = pin
        big = ContactPin(userId: "huge", email: "h@example.com", name: String(repeating: "h", count: Settings.maxBytes), encryptionPublicKey: "e",
                         signingPublicKey: "s", fingerprint: "", pinnedAt: "2026-10-30T00:00:00Z", kemPublicKeyHash: nil)
        #expect(throws: ContactError.message(Settings.contactsFull)) { try settings.setPinOnce(big) }
        #expect(try settings.json() == before)
    }
}

func reread(_ settings: Settings) throws -> [String: Any] {
    try JSONSerialization.jsonObject(with: Data(try settings.json().utf8)) as? [String: Any] ?? [:]
}

/*
 * The server's account routes a contact act uses: the own identity and its history, the settings
 * (compare-and-set on the stored sequence) and their key, contact lookup and succession links.
 */
final class ContactServer: @unchecked Sendable {
    nonisolated(unsafe) static var current: ContactServer?
    let me: String
    var identity: IdentityEnvelope
    /* By email: the account id, name and identity served. */
    var people: [String: (userId: String, name: String, identity: IdentityEnvelope)] = [:]
    var links: [String: [[String: Any]]] = [:]
    var settingsKey: [String: Any]?
    var settings: [String: Any]?
    var settingsVersion: UInt64 = 0
    var puts = 0
    /* The next settings save is stored and its answer lost. */
    var loseNextSettingsAnswer = false
    var onSettingsPut: (() -> Void)?
    /* What `/shares/mine` lists, and the envelopes put back by share id. */
    var sharesMine: [[String: Any]] = []
    /* Requests counted: contact lookups and settings reads. */
    var lookups = 0
    var settingsReads = 0
    var resealed: [String: String] = [:]
    /* Any other route a test answers itself (a rotation's), by method, path and JSON body; nil passes it on. */
    var routes: ((String, String, [String: Any]) -> (Int, [String: Any])?)?
    private let lock = NSLock()

    init(me: String, identity: IdentityEnvelope) {
        self.me = me
        self.identity = identity
    }

    static func link(from old: IdentityEnvelope, to next: IdentitySuccession) -> [String: Any] {
        ["oldKeyVersion": old.keyVersion, "newKeyVersion": next.identity.keyVersion, "oldEncryptionPublicKey": old.encryptionPublicKey,
         "oldSigningPublicKey": old.signingPublicKey, "oldMlDsaPublicKey": old.mlDsa?.publicKey ?? "",
         "newEncryptionPublicKey": next.identity.encryptionPublicKey, "newSigningPublicKey": next.identity.signingPublicKey,
         "newMlDsaPublicKey": next.identity.mlDsa?.publicKey ?? "", "newKemPublicKey": next.identity.kem?.publicKey ?? "", "signature": next.signature]
    }

    private func key(root: Data) throws -> Data {
        let stored = try #require(settingsKey)
        return try settingsKeyOpen(userId: me, accountKey: root, envelope: Auth.settingsKeyEnvelope(from: stored))
    }

    /* The settings as stored, opened as a device of the account would. */
    func document(root: Data) throws -> [String: Any] {
        guard let settings else { return [:] }
        let envelope = SettingsEnvelope(version: 2, settingsVersion: settingsVersion, nonce: settings["nonce"] as? String ?? "",
                                        ciphertext: settings["ciphertext"] as? String ?? "")
        let json = try #require(try settingsOpen(userId: me, settingsKey: try key(root: root), envelope: envelope))
        return try JSONSerialization.jsonObject(with: Data(json.utf8)) as? [String: Any] ?? [:]
    }

    /* Another device's (or the server's replay of an older) copy, stored at the next sequence. */
    func replace(_ document: [String: Any], root: Data) throws {
        if settingsKey == nil {
            let made = try settingsKeyCreate(userId: me, accountKey: root)
            settingsKey = Auth.json(made.envelope)
        }
        let json = String(decoding: try JSONSerialization.data(withJSONObject: document, options: [.sortedKeys]), as: UTF8.self)
        let sealed = try settingsSeal(userId: me, settingsKey: try key(root: root), settingsVersion: settingsVersion + 1, json: json)
        settings = ["version": sealed.version, "settingsVersion": sealed.settingsVersion, "nonce": sealed.nonce, "ciphertext": sealed.ciphertext]
        settingsVersion = sealed.settingsVersion
    }

    func answer(_ request: URLRequest, body: Data?) -> (Int, [String: Any]) {
        lock.lock()
        defer { lock.unlock() }
        let path = request.url?.path ?? ""
        let json = body.flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: Any] } ?? [:]
        switch (request.httpMethod ?? "GET", path) {
        case ("GET", "/api/auth/identity"): return (200, ["identity": Auth.json(identity)])
        case ("GET", "/api/auth/identity/history"): return (200, ["identities": []])
        case ("GET", "/api/auth/settings"):
            settingsReads += 1
            return (200, ["settings": settings as Any, "settingsKey": settingsKey as Any, "settingsVersion": settingsVersion])
        case ("PUT", "/api/auth/settings-key"):
            guard settingsKey == nil else { return (409, ["message": "A settings key is already stored."]) }
            settingsKey = json
            return (200, [:])
        case ("PUT", "/api/auth/settings"):
            guard (json["expectedVersion"] as? NSNumber)?.uint64Value == settingsVersion else {
                return (409, ["message": "Your settings changed on another device."])
            }
            settingsVersion += 1
            settings = ["version": json["version"] as Any, "settingsVersion": settingsVersion, "nonce": json["nonce"] as Any,
                        "ciphertext": json["ciphertext"] as Any]
            puts += 1
            onSettingsPut?()
            if loseNextSettingsAnswer {
                loseNextSettingsAnswer = false
                return (500, ["message": "No answer."])
            }
            return (200, ["settingsVersion": settingsVersion])
        case ("GET", "/api/drive/shares/mine"):
            return (200, ["shares": sharesMine, "links": []])
        case ("POST", "/api/auth/contacts/lookup"):
            lookups += 1
            guard let email = json["email"] as? String, let person = people[email] else { return (404, ["message": "No HushOS account uses that email."]) }
            let served = person.identity
            return (200, ["contact": [
                "userId": person.userId, "name": person.name, "email": email, "keyVersion": served.keyVersion, "identityVersion": Int(served.version),
                "encryptionPublicKey": served.encryptionPublicKey, "signingPublicKey": served.signingPublicKey,
                "mlDsaPublicKey": served.mlDsa?.publicKey as Any, "kemPublicKey": served.kem?.publicKey as Any, "keysSignature": served.keysSignature as Any,
            ]])
        default:
            if request.httpMethod == "PUT", path.hasPrefix("/api/drive/shares/"), path.hasSuffix("/envelope") {
                resealed[String(path.split(separator: "/")[3])] = json["shareEnvelope"] as? String
                return (200, [:])
            }
            if path.hasPrefix("/api/auth/contacts/"), path.hasSuffix("/succession") {
                let id = path.split(separator: "/")[3]
                return (200, ["links": links[String(id)] ?? []])
            }
            if let answered = routes?(request.httpMethod ?? "GET", path, json) { return answered }
            return (404, ["message": "Not here."])
        }
    }
}

final class ContactServerProtocol: URLProtocol {
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        var body = request.httpBody
        if body == nil, let stream = request.httpBodyStream {
            stream.open()
            var data = Data()
            var buffer = [UInt8](repeating: 0, count: 4096)
            while stream.hasBytesAvailable {
                let read = stream.read(&buffer, maxLength: buffer.count)
                if read <= 0 { break }
                data.append(buffer, count: read)
            }
            stream.close()
            body = data
        }
        let (status, json) = ContactServer.current?.answer(request, body: body) ?? (500, ["message": "No server"])
        let response = HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: "HTTP/1.1", headerFields: ["Content-Type": "application/json"])!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: (try? JSONSerialization.data(withJSONObject: json)) ?? Data())
        client?.urlProtocolDidFinishLoading(self)
    }

    override func stopLoading() {}
}
