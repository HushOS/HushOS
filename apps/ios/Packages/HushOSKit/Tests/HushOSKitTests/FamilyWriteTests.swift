import Foundation
import HushOSCore
import Testing
@testable import HushOSKit

/*
 * Writes into a family folder on the phone (docs/groups-mobile-plan.md, iOS 2) against the stub
 * of the group and Drive routes, with member lists and keys the core makes: every key a write
 * wraps or seals under comes from the area ledger, an upload into a folder the key change hasn't
 * reached waits and goes once the walk re-keyed it, a 409 `rotating` is the same wait, a top
 * folder whose key isn't the committed one leaves the folder read only, and a move into one's own
 * files is uploaded again, never the server's in-workspace move. Each fails on its defect.
 */
extension OnFakeDrive {
    @Suite struct FamilyWriteTests {
        /*
         * A new folder, a rename and the trash in a writable family folder: the folder's key is
         * wrapped under the top folder's key, the new name sealed under the file's own key, and the
         * file trashed. Fails if a write seals under any other key (or isn't sent).
         */
        @Test func aNewFolderARenameAndTheTrashLandUnderTheFolderKeys() async throws {
            let family = try FamilyFixture()
            let server = family.server(chain: [family.r1, family.r2], pin: try family.pin(through: [family.r1, family.r2]))
            let phone = try await family.phone(server)
            defer { phone.done() }
            guard case .accepted(let view) = await phone.sync.sync(family.summary) else { Issue.record("not accepted"); return }
            #expect(view.areas.first?.write == .writable)
            _ = try await phone.vault.children(of: family.rootId)

            let made = try await phone.vault.createFolder(in: family.rootId, name: "Trips")
            let folder = try #require((server.sent("/api/drive/folders").first?["folders"] as? [[String: Any]])?.first)
            let keyEpoch = try #require((folder["keyEpoch"] as? NSNumber)?.uint64Value)
            let opened = try nodeOpen(ctx: NodeKeyContext(workspaceId: family.workspaceId, nodeId: made.id, parentId: family.rootId, parentKeyEpoch: 1, keyEpoch: keyEpoch),
                                      parentKey: family.rootKey, keyEnvelope: try base64urlDecode(value: try #require(folder["keyEnvelope"] as? String)))
            #expect(opened.count == 32)
            #expect(try await phone.vault.children(of: family.rootId).map(\.name).contains("Trips"))

            _ = try await phone.vault.rename(family.fileId, to: "Recipes (old).txt")
            let renamed = try #require(server.sent("/api/drive/nodes/\(family.fileId)/metadata").first)
            let metadata = try metadataOpen(ctx: MetadataContext(workspaceId: family.workspaceId, nodeId: family.fileId, metadataVersion: 2), nodeKey: family.fileKey,
                                            envelope: try base64urlDecode(value: try #require(renamed["metadataEnvelope"] as? String)))
            #expect(metadata.name == "Recipes (old).txt")

            try await phone.vault.trash(family.fileId)
            #expect(server.node(family.fileId)?.trashedAt != nil)
        }

        /*
         * A selection to the trash and its Undo in a writable family folder go through the batch
         * routes to the family's own workspace, gated by the ledger like every write: the file is
         * trashed and back. Fails if either is sent elsewhere, or not sent.
         */
        @Test func aBatchTrashAndItsUndoLandInTheFamilysWorkspace() async throws {
            let family = try FamilyFixture()
            let server = family.server(chain: [family.r1, family.r2], pin: try family.pin(through: [family.r1, family.r2]))
            let phone = try await family.phone(server)
            defer { phone.done() }
            guard case .accepted = await phone.sync.sync(family.summary) else { Issue.record("not accepted"); return }
            let vault = phone.vault
            _ = try await vault.children(of: family.rootId)
            let row = try #require(await vault.item(family.fileId))

            let trashed = await vault.trashMany([family.fileId])
            #expect((try? trashed.first?.get()) == .trashed)
            #expect(server.count("/api/drive/workspaces/\(family.workspaceId)/trash-batch", method: "POST") == 1)
            #expect(server.node(family.fileId)?.trashedAt != nil)

            let back = await vault.restoreMany([row])
            #expect(back.count == 1 && (try? back[0].get()) != nil)
            #expect(server.count("/api/drive/workspaces/\(family.workspaceId)/restore-batch", method: "POST") == 1)
            #expect(server.node(family.fileId)?.trashedAt == nil)
        }

        /*
         * The family folder's key was replaced (roster 3: the folder at key version 2, its top folder
         * re-keyed, its previous key kept under option A's label). "Trips" is still wrapped under the
         * top folder's previous key: the walk hasn't reached it. An upload into it waits (the row says
         * so), looks the folder up again after the pause, and goes only once the walk re-keyed
         * "Trips" under the new top folder key, wrapped under the folder's new key. Fails if the
         * upload seals under the key reached through the previous root, or fails instead of waiting.
         */
        @Test func anUploadIntoAFolderReachedThroughThePreviousRootWaitsAndGoesOnceTheWalkReKeyedIt() async throws {
            let family = try FamilyFixture()
            let rotation = try FamilyRotation(family)
            let server = family.server(chain: [family.r1, family.r2, rotation.r3], pin: try family.pin(through: [family.r1, family.r2]))
            server.areaVersion = 2
            server.areaGrant = (3, rosterDigest(statement: rotation.r3.statement), rotation.grant)
            server.put(rotation.root, rotation.trips)
            let phone = try await family.phone(server)
            defer { phone.done() }
            guard case .accepted(let view) = await phone.sync.sync(family.summary) else { Issue.record("not accepted"); return }
            #expect(view.areas.first?.write == .writable)
            #expect(try await phone.vault.children(of: family.rootId).map(\.name).contains("Trips"))

            let source = try temporaryFile("beach.jpg", Data(repeating: 7, count: 5000))
            let pauses = Tally()
            let waited = Tally()
            let sealed = try await phone.vault.sealUpload(
                fileURL: source, name: "beach.jpg", mime: "image/jpeg", in: rotation.tripsId, replacing: nil, thumbnail: nil, into: temporaryFolder(),
                waiting: KeyChangeWait.Policy(pause: { _ in pauses.add(); server.put(rotation.walked) }, waiting: { _ in waited.add() })
            )
            #expect(pauses.count == 1)
            #expect(waited.count >= 1)
            // Nothing was begun under the previous key: the one begin is under the walked folder's key.
            let begins = server.allBegins
            #expect(begins.count == 1)
            let node = try #require(begins.first?.body["node"] as? [String: Any])
            #expect((node["parentKeyEpoch"] as? NSNumber)?.uint64Value == 7)
            let key = try nodeOpen(
                ctx: NodeKeyContext(workspaceId: family.workspaceId, nodeId: sealed.nodeId, parentId: rotation.tripsId, parentKeyEpoch: 7,
                                    keyEpoch: try #require((node["keyEpoch"] as? NSNumber)?.uint64Value)),
                parentKey: rotation.walkedKey, keyEnvelope: try base64urlDecode(value: try #require(node["keyEnvelope"] as? String))
            )
            #expect(key.count == 32)
        }

        /*
         * The server serves the family folder's top folder under a key its member list never
         * committed to (a key epoch it never had, under the folder's key at version 1): the folder
         * reads Couldn't check and is read only. Nothing is written into what was opened before it,
         * not a folder, a rename, an upload, a move inside or the trash. Fails if any write skips the
         * ledger's require_writable (the trash seals nothing, so only the gate stops it).
         */
        @Test func aRootWhoseKeyIsNotTheCommittedOneMakesTheFolderReadOnly() async throws {
            let family = try FamilyFixture()
            let server = family.server(chain: [family.r1, family.r2], pin: try family.pin(through: [family.r1, family.r2]))
            server.put(family.docs)
            let phone = try await family.phone(server)
            defer { phone.done() }
            guard case .accepted = await phone.sync.sync(family.summary) else { Issue.record("not accepted"); return }
            let vault = phone.vault
            _ = try await vault.children(of: family.rootId)
            let row = try #require(await vault.item(family.fileId))

            let planted = try FamilyFixture.node(id: family.rootId, in: family.workspaceId, parent: nil, parentKey: family.areaKey, key: try randomBytes(length: 32),
                                                 kind: .folder, name: "Photos", writer: family.creator, keyEpoch: 9)
            server.put(planted)
            guard case .accepted(let view) = await phone.sync.sync(family.summary) else { Issue.record("not accepted"); return }
            let area = try #require(view.areas.first)
            #expect(!area.openable && area.write == .readOnly && area.line == "Couldn’t check this folder’s keys")
            do {
                _ = try await vault.children(of: family.rootId)
                Issue.record("a top folder the member list never committed to listed")
            } catch {
                #expect(FamilyWords.error(error) == FamilyWords.couldntCheckKeys)
            }

            server.clearRequests()
            let source = try temporaryFile("note.txt", Data("x".utf8))
            await #expect(throws: (any Error).self) { _ = try await vault.createFolder(in: family.docs.id, name: "New") }
            await #expect(throws: (any Error).self) { _ = try await vault.rename(family.fileId, to: "renamed.txt") }
            await #expect(throws: (any Error).self) { _ = try await vault.upload(fileURL: source, name: "note.txt", mime: "text/plain", in: family.docs.id, replacing: nil) }
            await #expect(throws: (any Error).self) { _ = try await vault.relocate(family.fileId, to: family.docs.id) }
            await #expect(throws: (any Error).self) { try await vault.trash(family.fileId) }
            // A selection to the trash and its Undo (the batch routes) are stopped by the same gate.
            let trashed = await vault.trashMany([family.fileId])
            #expect(trashed.allSatisfy { if case .failure = $0 { true } else { false } })
            let back = await vault.restoreMany([row])
            #expect(back.allSatisfy { if case .failure = $0 { true } else { false } })
            #expect(server.writes.isEmpty)
        }

        /*
         * Mid-walk, "Trips" and the file in it are reached only through the top folder's previous
         * key: a rename, a move within the folder and a new version of the file are each refused with
         * the key-change words and send nothing. Fails if a write takes the key this process opened
         * (readable) instead of the ledger's writable one, or re-wraps without the ledger.
         */
        @Test func aRenameMoveOrNewVersionOfAnItemReachedThroughThePreviousRootSendsNothing() async throws {
            let family = try FamilyFixture()
            let rotation = try FamilyRotation(family)
            let server = family.server(chain: [family.r1, family.r2, rotation.r3], pin: try family.pin(through: [family.r1, family.r2]))
            server.areaVersion = 2
            server.areaGrant = (3, rosterDigest(statement: rotation.r3.statement), rotation.grant)
            server.put(rotation.root, rotation.trips, rotation.tripsFile)
            let phone = try await family.phone(server)
            defer { phone.done() }
            guard case .accepted = await phone.sync.sync(family.summary) else { Issue.record("not accepted"); return }
            let vault = phone.vault
            _ = try await vault.children(of: family.rootId)
            _ = try await vault.children(of: rotation.tripsId)
            let source = try temporaryFile("plan.txt", Data("v2".utf8))
            let replaced = try #require(await vault.item(rotation.tripsFile.id))
            server.clearRequests()

            for write in [
                { _ = try await vault.rename(rotation.tripsId, to: "Trips 2026") },
                { _ = try await vault.relocate(rotation.tripsFile.id, to: family.rootId) },
                { _ = try await vault.sealUpload(fileURL: source, name: "plan.txt", mime: "text/plain", in: rotation.tripsId, replacing: replaced,
                                                 thumbnail: nil, into: try temporaryFolder()) },
            ] as [@Sendable () async throws -> Void] {
                do {
                    try await write()
                    Issue.record("a write under a key the key change replaces was sent")
                } catch {
                    #expect(FamilyWords.error(error) == "HushOS is finishing a key change for this folder. Try again in a moment.")
                }
            }
            #expect(server.writes.isEmpty)
        }

        /*
         * The family folder's key is replaced after this phone checked the family: its top folder is
         * now served under key version 2, which the ledger doesn't hold. An upload into the top folder
         * waits (the ledger's "older workspace key"), checks the family again in the pause, and goes
         * under the new top folder key. Fails if that refusal fails the upload instead of waiting.
         */
        @Test func anUploadIntoTheTopFolderRightAfterAKeyChangeWaitsForTheFamilyCheck() async throws {
            let family = try FamilyFixture()
            let rotation = try FamilyRotation(family)
            let server = family.server(chain: [family.r1, family.r2], pin: try family.pin(through: [family.r1, family.r2]))
            let phone = try await family.phone(server)
            defer { phone.done() }
            guard case .accepted = await phone.sync.sync(family.summary) else { Issue.record("not accepted"); return }
            _ = try await phone.vault.children(of: family.rootId)

            server.serve(chain: [family.r1, family.r2, rotation.r3])
            server.areaVersion = 2
            server.areaGrant = (3, rosterDigest(statement: rotation.r3.statement), rotation.grant)
            server.put(rotation.root)
            let pauses = Tally()
            let sealed = try await phone.vault.sealUpload(
                fileURL: try temporaryFile("top.txt", Data("top".utf8)), name: "top.txt", mime: "text/plain", in: family.rootId, replacing: nil,
                thumbnail: nil, into: try temporaryFolder(), waiting: KeyChangeWait.Policy(pause: { _ in pauses.add() })
            )
            #expect(pauses.count == 1)
            let node = try #require(server.allBegins.last?.body["node"] as? [String: Any])
            #expect((node["parentKeyEpoch"] as? NSNumber)?.uint64Value == 5)
            let key = try nodeOpen(
                ctx: NodeKeyContext(workspaceId: family.workspaceId, nodeId: sealed.nodeId, parentId: family.rootId, parentKeyEpoch: 5,
                                    keyEpoch: try #require((node["keyEpoch"] as? NSNumber)?.uint64Value)),
                parentKey: rotation.rootKey, keyEnvelope: try base64urlDecode(value: try #require(node["keyEnvelope"] as? String))
            )
            #expect(key.count == 32)
        }

        /*
         * The server refuses the begin with 409 `rotating` (a key change this phone hasn't heard of
         * yet): the upload waits and goes again, not a failure. Without a way to wait the refusal is
         * said, never swallowed; a `stale` before any wait is a failure at once, after a wait it is
         * the wait ending; half an hour of waiting gives up with the web's words. Fails if `rotating`
         * fails the upload, or if every 409 is waited on.
         */
        @Test func a409RotatingWaitsAndRetriesRatherThanFailing() async throws {
            let family = try FamilyFixture()
            let server = family.server(chain: [family.r1, family.r2], pin: try family.pin(through: [family.r1, family.r2]))
            let phone = try await family.phone(server)
            defer { phone.done() }
            guard case .accepted = await phone.sync.sync(family.summary) else { Issue.record("not accepted"); return }
            let vault = phone.vault
            _ = try await vault.children(of: family.rootId)
            let source = try temporaryFile("scan.pdf", Data(repeating: 3, count: 2000))
            let pauses = Tally()
            let policy = KeyChangeWait.Policy(pause: { _ in pauses.add() })
            func seal(_ waiting: KeyChangeWait.Policy?) async throws -> Vault.SealedUpload {
                try await vault.sealUpload(fileURL: source, name: "scan.pdf", mime: "application/pdf", in: family.rootId, replacing: nil, thumbnail: nil,
                                           into: try temporaryFolder(), waiting: waiting)
            }

            server.rotatingBegins = 1
            _ = try await seal(policy)
            #expect(pauses.count == 1)
            #expect(server.count("/api/drive/uploads", method: "POST") == 2)
            #expect(server.allBegins.count == 1)

            server.rotatingBegins = 1
            do {
                _ = try await seal(nil)
                Issue.record("a rotating refusal was swallowed without a wait")
            } catch DriveAPIError.rotating {}

            server.staleBegins = 1
            do {
                _ = try await seal(policy)
                Issue.record("a stale answer before any wait was waited on")
            } catch DriveAPIError.stale {}
            #expect(pauses.count == 1)

            server.rotatingBegins = 1
            server.staleBegins = 1
            _ = try await seal(policy)
            #expect(pauses.count == 3)

            server.rotatingBegins = 100
            let began = Date()
            let clock = Clock(began)
            do {
                _ = try await seal(KeyChangeWait.Policy(since: began, pause: { _ in clock.advance(31 * 60) }, now: { clock.now }))
                Issue.record("an upload waited past half an hour")
            } catch {
                #expect(error.localizedDescription == KeyChangeWait.gaveUp)
            }
        }

        /*
         * Within the family folder a move is one server move, the key re-wrapped by the ledger under
         * the destination's key. Into the member's own files it is uploaded again under their own
         * keys (the bytes open there to the photo) and the original goes to the family folder's
         * Trash: the server's in-workspace move and copy are never asked. Fails if a cross-space move
         * calls either, or uploads anything but the photo.
         */
        @Test func aMoveAcrossSpacesUploadsAgainAndNeverCallsTheServersMove() async throws {
            let family = try FamilyFixture()
            let server = family.server(chain: [family.r1, family.r2], pin: try family.pin(through: [family.r1, family.r2]))
            server.put(family.photo, family.docs)
            server.objects[try #require(family.photo.currentVersion).id] = family.photoObject
            let phone = try await family.phone(server)
            defer { phone.done() }
            guard case .accepted = await phone.sync.sync(family.summary) else { Issue.record("not accepted"); return }
            let vault = phone.vault
            _ = try await vault.children(of: family.rootId)

            let within = try await vault.relocate(family.photo.id, to: family.docs.id)
            #expect(!within.across)
            let moved = try #require(server.sent("/api/drive/nodes/\(family.photo.id)/parent").first)
            let rewrapped = try nodeOpen(ctx: NodeKeyContext(workspaceId: family.workspaceId, nodeId: family.photo.id, parentId: family.docs.id, parentKeyEpoch: 2, keyEpoch: 3),
                                         parentKey: family.docsKey, keyEnvelope: try base64urlDecode(value: try #require(moved["keyEnvelope"] as? String)))
            #expect(rewrapped == family.photoKey)

            server.clearRequests()
            let across = try await vault.relocate(family.photo.id, to: family.personalRoot.id)
            #expect(across.across)
            #expect(!server.requested("/api/drive/nodes/\(family.photo.id)/parent", method: "POST"))
            #expect(!server.requested("/api/drive/nodes/\(family.photo.id)/copy", method: "POST"))
            let begin = try #require(server.allBegins.last)
            #expect(begin.body["workspaceId"] as? String == family.personal)
            let node = try #require(begin.body["node"] as? [String: Any])
            let nodeId = try #require(node["id"] as? String)
            let key = try nodeOpen(ctx: NodeKeyContext(workspaceId: family.personal, nodeId: nodeId, parentId: family.personalRoot.id, parentKeyEpoch: 1,
                                                       keyEpoch: try #require((node["keyEpoch"] as? NSNumber)?.uint64Value)),
                                   parentKey: family.personalRootKey, keyEnvelope: try base64urlDecode(value: try #require(node["keyEnvelope"] as? String)))
            let objectId = try #require(begin.body["objectId"] as? String)
            let suite = UInt32(try #require((begin.body["contentSuite"] as? NSNumber)?.intValue))
            let version = try versionOpen(
                ctx: VersionContext(workspaceId: family.personal, nodeId: nodeId, versionId: try #require(begin.body["versionId"] as? String), objectId: objectId),
                suite: suite, nodeKey: key, envelope: try base64urlDecode(value: try #require(begin.body["contentKeyEnvelope"] as? String)), rowSize: nil
            )
            let content = Content(workspaceId: family.personal, objectId: objectId, suite: suite, key: version.key,
                                  nonce: try base64urlDecode(value: try #require(begin.body["contentNonce"] as? String)),
                                  plaintextSize: version.plaintextSize, thumbnailBytes: version.thumbnailBytes)
            var plaintext = Data()
            for (part, sealed) in server.putParts(begin.id).sorted(by: { $0.key < $1.key }) {
                plaintext.append(try chunkDecrypt(content: content, index: UInt64(part - 1), ciphertext: sealed))
            }
            #expect(plaintext == family.photoBytes)
            #expect(server.node(family.photo.id)?.trashedAt != nil)
        }
    }
}

/*
 * The family folder's key replaced at roster 3, as a removal's rotation leaves it before the walk
 * reaches "Trips": key version 2 granted to the member, the top folder re-keyed under it (key epoch
 * 5) with its previous key under option A's label, "Trips" (epoch 6) under the top folder's
 * previous key, and "Trips" as the walk re-keys it (epoch 7, under the new top folder key).
 */
struct FamilyRotation {
    let r3: SignedGroupStatement
    let areaKey: Data
    let rootKey: Data
    let grant: Data
    let root: NodeView
    let tripsId: String
    let tripsKey: Data
    let trips: NodeView
    /* A file in "Trips", under its key as the walk hasn't reached it. */
    let tripsFile: NodeView
    let walkedKey: Data
    let walked: NodeView
    /* The fixture's "Docs" as the walk re-keys it (epoch 9, under the new top folder key). */
    let docsWalkedKey: Data
    let docsWalked: NodeView

    init(_ family: FamilyFixture) throws {
        func chain(_ rosters: [SignedGroupStatement]) throws -> AcceptedRosters {
            guard case .accepted(let chain) = try acceptRosters(groupId: family.groupId, firstKeys: try family.firstKeys, firstKeysChecked: true, pins: [], rosters: rosters,
                                                                successions: [], mlDsaKeys: try family.signerKeys, me: family.creator.own, cache: nil)
            else { throw FamilyFailure(message: "the creator's chain didn't accept") }
            return chain
        }
        let ws = family.workspaceId
        areaKey = try randomBytes(length: 32)
        rootKey = try randomBytes(length: 32)
        let roster = try rosterNext(chain: try chain([family.r1, family.r2]),
                                    members: [try family.creator.entry([.billing, .members], since: 1), try family.member.entry([], since: 2)],
                                    signerUserId: family.creator.userId, areaKeys: [AreaKey(workspaceId: ws, workspaceKey: areaKey, rootKey: rootKey)],
                                    retireAreas: nil, format: 2)
        r3 = try rosterSign(roster: roster, groupSeed: family.groupSeed, signer: family.creator.keys)
        grant = try areaGrantSeal(
            workspaceKey: areaKey,
            ctx: AreaGrantContext(groupId: family.groupId, workspaceId: ws, workspaceKeyVersion: 2, granteeUserId: family.member.userId,
                                  granteeKeyVersion: family.member.keys.keyVersion, granterUserId: family.creator.userId, rosterVersion: 3,
                                  rosterDigest: rosterDigest(statement: r3.statement)),
            chain: try chain([family.r1, family.r2, r3]), areaIdSeed: family.workspaceSeed,
            granteeKemPublicKey: try base64urlDecode(value: family.member.keys.kemPublicKey!), granter: family.creator.keys
        )
        let previous = try previousRootKeyWrap(ctx: NodeKeyContext(workspaceId: ws, nodeId: family.rootId, parentId: ws, parentKeyEpoch: 2, keyEpoch: 1),
                                               areaKey: areaKey, rootKey: family.rootKey)
        root = try FamilyFixture.node(id: family.rootId, in: ws, parent: nil, parentKey: areaKey, key: rootKey, kind: .folder, name: "Photos", writer: family.creator,
                                      keyEpoch: 5, parentKeyEpoch: 2).with(prev: (base64urlEncode(bytes: previous), 1, 2))
        tripsId = try newId(kind: .node, scopeId: ws).id
        tripsKey = try randomBytes(length: 32)
        trips = try FamilyFixture.node(id: tripsId, in: ws, parent: family.rootId, parentKey: family.rootKey, key: tripsKey, kind: .folder,
                                       name: "Trips", writer: family.creator, keyEpoch: 6, parentKeyEpoch: 1)
        tripsFile = try FamilyFixture.node(id: try newId(kind: .node, scopeId: ws).id, in: ws, parent: tripsId, parentKey: tripsKey, key: try randomBytes(length: 32),
                                           kind: .file, name: "plan.txt", writer: family.creator, keyEpoch: 8, parentKeyEpoch: 6)
        walkedKey = try randomBytes(length: 32)
        walked = try FamilyFixture.node(id: tripsId, in: ws, parent: family.rootId, parentKey: rootKey, key: walkedKey, kind: .folder,
                                        name: "Trips", writer: family.creator, keyEpoch: 7, parentKeyEpoch: 5)
        docsWalkedKey = try randomBytes(length: 32)
        docsWalked = try FamilyFixture.node(id: family.docs.id, in: ws, parent: family.rootId, parentKey: rootKey, key: docsWalkedKey, kind: .folder,
                                            name: "Docs", writer: family.creator, keyEpoch: 9, parentKeyEpoch: 5)
    }
}

/* A count the stub's closures raise from any thread. */
final class Tally: @unchecked Sendable {
    private let lock = NSLock()
    private var value = 0
    func add() { lock.withLock { value += 1 } }
    var count: Int { lock.withLock { value } }
}

/* A clock a test moves by hand. */
final class Clock: @unchecked Sendable {
    private let lock = NSLock()
    private var current: Date
    init(_ start: Date) { current = start }
    func advance(_ seconds: TimeInterval) { lock.withLock { current = current.addingTimeInterval(seconds) } }
    var now: Date { lock.withLock { current } }
}

func temporaryFolder() throws -> URL {
    let url = FileManager.default.temporaryDirectory.appendingPathComponent("family-write-\(UUID().uuidString)", isDirectory: true)
    try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
    return url
}

func temporaryFile(_ name: String, _ data: Data) throws -> URL {
    let url = try temporaryFolder().appendingPathComponent(name)
    try data.write(to: url)
    return url
}
