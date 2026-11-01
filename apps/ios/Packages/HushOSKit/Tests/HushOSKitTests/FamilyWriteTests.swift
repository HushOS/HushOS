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
            // Everything else carried over, attributes this app doesn't know included.
            #expect(metadata.attributes == FamilyFixture.attributes)

            try await phone.vault.trash(family.fileId)
            #expect(server.node(family.fileId)?.trashedAt != nil)
        }

        /*
         * The first acceptance on this phone hands back a guard that can't be stored, so the family is
         * refused before any of its folders was opened. Its folders are still held for the barrier: a
         * write into one waits for the guard with the storage words, never sent as a personal folder's.
         * Fails if the folders are held only after the guard is stored.
         */
        @Test func aFirstAcceptanceWhoseGuardIsNotStoredStillHoldsItsFolders() async throws {
            let family = try FamilyFixture()
            let writes = GuardSwitch()
            writes.writable = false
            let server = family.server(chain: [family.r1, family.r2], pin: try family.pin(through: [family.r1, family.r2]))
            let phone = try await family.phone(server, guards: familyGuards(family.member, writes: writes))
            defer { phone.done() }
            #expect(await phone.sync.sync(family.summary) == .failed(GuardWords.unsaved))
            await #expect(throws: GuardError.unsaved) { try await phone.vault.sendingIntoFamily(family.workspaceId) }
        }

        /*
         * The member list names a received share's workspace as a family folder as well. Only route 25
         * and the folder ids prove a family folder: the share stays a share, read and written as one
         * once the guard is stored, never refused as a family folder this family doesn't hold. Fails if
         * a member list's word alone makes a workspace a family folder.
         */
        @Test func aRosterNamingAReceivedSharesWorkspaceLeavesTheShareAShare() async throws {
            let theirs = UUID().uuidString.lowercased()
            let family = try await onLargeStack { try FamilyFixture.$naming.withValue(theirs) { try FamilyFixture() } }
            let server = family.server(chain: [family.r1, family.r2], pin: try family.pin(through: [family.r1, family.r2]))
            let phone = try await family.phone(server)
            defer { phone.done() }
            let vault = phone.vault
            let sKey = try randomBytes(length: 32)
            let shared = try FamilyFixture.node(id: try newId(kind: .node, scopeId: theirs).id, in: theirs, parent: nil, parentKey: try randomBytes(length: 32), key: sKey,
                                                kind: .folder, name: "Shared", writer: family.creator)
            let plan = try FamilyFixture.node(id: try newId(kind: .node, scopeId: theirs).id, in: theirs, parent: shared.id, parentKey: sKey, key: try randomBytes(length: 32),
                                              kind: .file, name: "Plan.txt", writer: family.creator)
            server.put(shared, plan)
            _ = try await vault.adopt(shared, nodeKey: sKey, metadata: NodeMetadata(name: "Shared", mime: nil, size: nil, modified: nil, attributes: [:]), in: theirs)
            guard case .accepted = await phone.sync.sync(family.summary) else { Issue.record("not accepted"); return }
            #expect(!(await vault.isFamilyWorkspace(theirs)), "a member list's word made a share a family folder")
            #expect(try await vault.children(of: shared.id).map(\.name) == ["Plan.txt"])
            server.clearRequests()
            let made = try await vault.createFolder(in: shared.id, name: "Notes")
            #expect(made.node.workspaceId == theirs)
            #expect(!server.writes.isEmpty)
        }

        /*
         * Two answers for one family file arrive out of order: the newer row (a second version) is
         * opened first, then an older listing's row lands. The vault keeps the newer row and key, a
         * download fetches the newer version, and asking for the old version's id writes nothing.
         * Fails if an older answer replaces a newer row, or a copy's path can hold another version.
         */
        @Test func anOlderAnswerLandingLastKeepsTheNewerRowAndItsVersion() async throws {
            let family = try FamilyFixture()
            let server = family.server(chain: [family.r1, family.r2], pin: try family.pin(through: [family.r1, family.r2]))
            server.put(family.photo)
            let first = try #require(family.photo.currentVersion)
            server.objects[first.id] = family.photoObject
            let phone = try await family.phone(server)
            defer { phone.done() }
            guard case .accepted = await phone.sync.sync(family.summary) else { Issue.record("not accepted"); return }
            let vault = phone.vault
            _ = try await vault.children(of: family.rootId)

            // The creator replaced the photo: a second version, sealed as an upload seals it.
            let bytes = Data((0 ..< 2000).map { UInt8(($0 * 7) % 251) })
            let (second, object) = try sealVersion(bytes, of: family.photo.id, family)
            let newer = family.photo.with(version: second)
            server.put(newer)
            server.objects[second.id] = object
            try await vault.open(newer)
            // The older listing's answer lands last.
            try await vault.open(family.photo)
            #expect(await vault.item(family.photo.id)?.node.currentVersion?.id == second.id, "an older answer replaced the newer row")

            let folder = FileManager.default.temporaryDirectory.appendingPathComponent("versions-\(UUID().uuidString)", isDirectory: true)
            try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
            let current = folder.appendingPathComponent("current")
            try await vault.download(family.photo.id, expectedVersionId: second.id, to: current)
            #expect(try Data(contentsOf: current) == bytes)
            // A path named after the old version gets nothing: the row names another now.
            let old = folder.appendingPathComponent("old")
            await #expect(throws: VersionChanged.self) { try await vault.download(family.photo.id, expectedVersionId: first.id, to: old) }
            #expect(!FileManager.default.fileExists(atPath: old.path))
            #expect(!FileManager.default.fileExists(atPath: old.appendingPathExtension("part").path))

            // The viewer still shows the old row and asks again: the copy is made for the row held now, at its own path.
            let held = try #require(await vault.item(family.photo.id))
            let shownOld = Opened(node: family.photo, metadata: held.metadata, nodeKey: nil)
            let (copied, file) = try await vault.downloadCurrent(shownOld) { row in
                folder.appendingPathComponent(try #require(row.node.currentVersion).id)
            }
            #expect(copied.node.currentVersion?.id == second.id)
            #expect(file.lastPathComponent == second.id)
            #expect(try Data(contentsOf: file) == bytes)
            #expect(!FileManager.default.fileExists(atPath: folder.appendingPathComponent(first.id).path))
        }

        /*
         * The member's own drive holds a file with the family photo's id. A copy of the family photo
         * is of the family row only: by id alone the own drive's row answers first, and its bytes
         * must never come down under the family file's name, nor after a retry, nor for a row of a
         * workspace not held here. Fails if a download looks a row up by id alone.
         */
        @Test func aFamilyRowWithAPersonalFilesIdNeverDownloadsThePersonalBytes() async throws {
            let family = try FamilyFixture()
            let server = family.server(chain: [family.r1, family.r2], pin: try family.pin(through: [family.r1, family.r2]))
            server.put(family.photo)
            let familyVersion = try #require(family.photo.currentVersion)
            server.objects[familyVersion.id] = family.photoObject
            let phone = try await family.phone(server)
            defer { phone.done() }
            guard case .accepted = await phone.sync.sync(family.summary) else { Issue.record("not accepted"); return }
            let vault = phone.vault
            _ = try await vault.children(of: family.rootId)
            let familyRow = try #require(await vault.item(family.photo.ref))

            // The own drive's file under the same node id and version id, with other bytes.
            let ownKey = try randomBytes(length: 32)
            let ownBytes = Data("the member's own file".utf8)
            let (ownVersion, ownObject) = try sealVersion(ownBytes, of: family.photo.id, family, in: family.personal, nodeKey: ownKey)
            let own = try FamilyFixture.node(id: family.photo.id, in: family.personal, parent: family.personalRoot.id, parentKey: family.personalRootKey,
                                             key: ownKey, kind: .file, name: "Beach.jpg", writer: family.member).with(version: ownVersion)
            server.objects[ownVersion.id] = ownObject
            try await vault.open(family.personalRoot)
            // The family row holds the id here: the own row is refused (Vault.admitId), and could only be asked for by its workspace.
            await #expect(throws: IdCollision.self) { try await vault.open(own) }
            // Two workspaces hold the id now: by id alone nothing answers for it (Vault.admitId).
            #expect(await vault.item(family.photo.id) == nil)

            let folder = FileManager.default.temporaryDirectory.appendingPathComponent("collide-\(UUID().uuidString)", isDirectory: true)
            try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
            let (copied, file) = try await vault.downloadCurrent(familyRow) { row in folder.appendingPathComponent(row.node.workspaceId) }
            #expect(copied.ref == family.photo.ref)
            #expect(try Data(contentsOf: file) == family.photoBytes, "the own drive's bytes came down as the family photo")
            let direct = folder.appendingPathComponent("direct")
            try await vault.download(family.photo.id, ref: family.photo.ref, expectedVersionId: familyVersion.id, to: direct)
            #expect(try Data(contentsOf: direct) == family.photoBytes)
            // A row of a workspace not held here (a share not listed yet): refused, never answered by the own drive's.
            let elsewhere = folder.appendingPathComponent("elsewhere")
            let unheld = NodeRef(workspaceId: UUID().uuidString, nodeId: family.photo.id)
            await #expect(throws: (any Error).self) { try await vault.download(family.photo.id, ref: unheld, to: elsewhere) }
            #expect(!FileManager.default.fileExists(atPath: elsewhere.path), "the own drive's bytes came down for another workspace's row")
        }

        /*
         * A personal file's preview shows the version it was listed with, and the vault has since
         * learned a newer one (another device replaced it): the copy comes down for the newer row,
         * by its workspace and id, instead of a refusal on every Try again. Fails if only a family
         * file takes the newer row.
         */
        @Test func aStalePersonalPreviewTakesTheNewerRow() async throws {
            let family = try FamilyFixture()
            let server = family.server(chain: [family.r1, family.r2], pin: try family.pin(through: [family.r1, family.r2]))
            let phone = try await family.phone(server)
            defer { phone.done() }
            let vault = phone.vault
            try await vault.open(family.personalRoot)
            let key = try randomBytes(length: 32)
            let id = try newId(kind: .node, scopeId: family.personal).id
            let base = try FamilyFixture.node(id: id, in: family.personal, parent: family.personalRoot.id, parentKey: family.personalRootKey,
                                              key: key, kind: .file, name: "Notes.txt", writer: family.member)
            let (first, firstObject) = try sealVersion(Data("first".utf8), of: id, family, in: family.personal, nodeKey: key)
            let (second, secondObject) = try sealVersion(Data("second".utf8), of: id, family, in: family.personal, nodeKey: key)
            server.objects[first.id] = firstObject
            server.objects[second.id] = secondObject
            server.put(family.personalRoot, base.with(version: first))
            let shown = try #require(try await vault.children(of: family.personalRoot.id).first)
            // Replaced on another device: the next listing of the folder brings the newer row while the preview shows the first.
            server.put(base.with(version: first).with(version: second))
            _ = try await vault.children(of: family.personalRoot.id)
            let folder = FileManager.default.temporaryDirectory.appendingPathComponent("personal-\(UUID().uuidString)", isDirectory: true)
            try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
            let (copied, file) = try await vault.downloadCurrent(shown) { row in folder.appendingPathComponent(try #require(row.node.currentVersion).id) }
            #expect(copied.node.currentVersion?.id == second.id)
            #expect(try Data(contentsOf: file) == Data("second".utf8))
        }

        /*
         * Another member moved the photo from the family's top folder into Docs: Docs' listing opens
         * the moved row first, then an older listing of the top folder (from before the move) lands.
         * The photo shows in Docs alone. Fails if a listing shows a row the vault holds as moved out.
         */
        @Test func aFamilyFileMovedBetweenFoldersShowsOnlyInTheNewOne() async throws {
            let family = try FamilyFixture()
            let server = family.server(chain: [family.r1, family.r2], pin: try family.pin(through: [family.r1, family.r2]))
            server.put(family.photo, family.docs)
            let phone = try await family.phone(server)
            defer { phone.done() }
            guard case .accepted = await phone.sync.sync(family.summary) else { Issue.record("not accepted"); return }
            let vault = phone.vault
            #expect(try await vault.children(of: family.rootId).map(\.name).contains("Beach.jpg"))
            let version = try #require(family.photo.currentVersion)
            let moved = try FamilyFixture.node(id: family.photo.id, in: family.workspaceId, parent: family.docs.id, parentKey: family.docsKey, key: family.photoKey,
                                               kind: .file, name: "Beach.jpg", writer: family.creator, keyEpoch: 3, parentKeyEpoch: 2)
                .with(version: version).with(version: version)
            #expect(try #require(moved.changeSeq) > (family.photo.changeSeq ?? 0))
            server.put(moved)
            #expect(try await vault.children(of: family.docs.id).map(\.name) == ["Beach.jpg"])
            // The top folder's listing from before the move lands now.
            server.put(family.photo)
            #expect(!(try await vault.children(of: family.rootId).map(\.name).contains("Beach.jpg")), "a moved file showed in the folder it left")
            #expect(await vault.item(family.photo.ref)?.node.parentId == family.docs.id)
        }

        /*
         * A received share's file moved on another device from A to B: shares get no feed, so the row
         * held here is the one from before the move. B's listing is newer and is trusted: the file
         * shows in B, and the row held follows it. Fails if a listing drops a row because the row held
         * is older than the listing's.
         */
        @Test func aSharedFileMovedOnAnotherDeviceShowsInItsNewFolder() async throws {
            let family = try FamilyFixture()
            let server = family.server(chain: [family.r1, family.r2], pin: try family.pin(through: [family.r1, family.r2]))
            let phone = try await family.phone(server)
            defer { phone.done() }
            let vault = phone.vault
            // Eve's workspace: the shared folder S (opened from the share), its folders A and B, and a file in A.
            let theirs = UUID().uuidString.lowercased()
            let (sKey, aKey, bKey, fileKey) = (try randomBytes(length: 32), try randomBytes(length: 32), try randomBytes(length: 32), try randomBytes(length: 32))
            let shared = try FamilyFixture.node(id: try newId(kind: .node, scopeId: theirs).id, in: theirs, parent: nil, parentKey: try randomBytes(length: 32), key: sKey,
                                                kind: .folder, name: "Shared", writer: family.creator)
            let a = try FamilyFixture.node(id: try newId(kind: .node, scopeId: theirs).id, in: theirs, parent: shared.id, parentKey: sKey, key: aKey,
                                           kind: .folder, name: "A", writer: family.creator)
            let b = try FamilyFixture.node(id: try newId(kind: .node, scopeId: theirs).id, in: theirs, parent: shared.id, parentKey: sKey, key: bKey,
                                           kind: .folder, name: "B", writer: family.creator)
            let fileId = try newId(kind: .node, scopeId: theirs).id
            let inA = try FamilyFixture.node(id: fileId, in: theirs, parent: a.id, parentKey: aKey, key: fileKey, kind: .file, name: "Plan.txt", writer: family.creator)
            server.put(shared, a, b, inA)
            _ = try await vault.adopt(shared, nodeKey: sKey, metadata: NodeMetadata(name: "Shared", mime: nil, size: nil, modified: nil, attributes: [:]), in: theirs)
            _ = try await vault.children(of: shared.id)
            #expect(try await vault.children(of: a.id).map(\.name) == ["Plan.txt"])
            // Moved on Eve's device: rewrapped under B, a later change.
            let inB = try FamilyFixture.node(id: fileId, in: theirs, parent: b.id, parentKey: bKey, key: fileKey, kind: .file, name: "Plan.txt", writer: family.creator)
                .with(version: nil)
            server.put(inB)
            #expect(try await vault.children(of: b.id).map(\.name) == ["Plan.txt"], "a moved shared file was left out of its new folder")
            #expect(await vault.item(inB.ref)?.node.parentId == b.id, "the row held didn't follow the newer listing")
            #expect(try await vault.children(of: a.id).isEmpty)
        }

        /* An own-drive row with `id`, under the member's top folder. */
        private func ownRow(_ id: String, _ family: FamilyFixture, kind: NodeKind, name: String) throws -> NodeView {
            try FamilyFixture.node(id: id, in: family.personal, parent: family.personalRoot.id, parentKey: family.personalRootKey,
                                   key: try randomBytes(length: 32), kind: kind, name: name, writer: family.member)
        }

        /*
         * The own drive holds a folder with the family's top folder's id and a file with a family
         * file's id before the family is opened. The family's top folder is refused (Couldn't check),
         * never listed as the own folder; the family file is left out of its listing; by id alone
         * neither answers, so nothing written by id lands on the own rows. Fails if an id-only
         * lookup, the catalogue or a listing takes the own row for the family one.
         */
        @Test func ownRowsHeldFirstNeverStandForFamilyRowsWithTheirIds() async throws {
            let family = try FamilyFixture()
            let server = family.server(chain: [family.r1, family.r2], pin: try family.pin(through: [family.r1, family.r2]))
            server.put(family.photo)
            let phone = try await family.phone(server)
            defer { phone.done() }
            let vault = phone.vault
            try await vault.open(family.personalRoot)
            let ownFile = try ownRow(family.fileId, family, kind: .file, name: "Mine.txt")
            try await vault.open(ownFile)

            guard case .accepted = await phone.sync.sync(family.summary) else { Issue.record("not accepted"); return }
            // The family's file with the own file's id is left out; the rest of the folder lists.
            #expect(try await vault.children(of: family.rootId).map(\.name) == ["Beach.jpg"])
            #expect(await vault.item(family.fileId) == nil, "an id two workspaces hold answered by id alone")
            #expect(await vault.item(ownFile.ref)?.name == "Mine.txt")
            server.clearRequests()
            await #expect(throws: (any Error).self) { _ = try await vault.rename(family.fileId, to: "Renamed.txt") }
            await #expect(throws: (any Error).self) { try await vault.trash(family.fileId) }
            #expect(server.writes.isEmpty, "a write by id landed: \(server.writes)")
        }

        /* The family's top folder's id held by an own folder first: the family folder is refused, never listed as the own one. */
        @Test func anOwnFolderWithTheFamilyRootsIdNeverListsAsIt() async throws {
            let family = try FamilyFixture()
            let server = family.server(chain: [family.r1, family.r2], pin: try family.pin(through: [family.r1, family.r2]))
            let phone = try await family.phone(server)
            defer { phone.done() }
            let vault = phone.vault
            try await vault.open(family.personalRoot)
            try await vault.open(try ownRow(family.rootId, family, kind: .folder, name: "Mine"))
            guard case .accepted(let view) = await phone.sync.sync(family.summary) else { Issue.record("not accepted"); return }
            #expect(view.areas.first?.root == nil, "the family's top folder opened over the own folder's id")
            server.clearRequests()
            await #expect(throws: (any Error).self) { _ = try await vault.children(of: family.rootId) }
            // Never asked of the own drive either: by id alone the own workspace would answer with the own folder's children.
            #expect(!server.traffic.contains { $0.url.contains("/nodes/\(family.rootId)/children") && $0.url.contains(family.personal) },
                    "the family root's id was listed in the own drive")
            #expect(await vault.item(family.rootId) == nil)
            server.clearRequests()
            await #expect(throws: (any Error).self) { _ = try await vault.createFolder(in: family.rootId, name: "New") }
            #expect(server.writes.isEmpty)
        }

        /*
         * The family's rows are held first, then the own drive's file with a family file's id: the own
         * row is refused, the family file still downloads as itself by its workspace and id, and by id
         * alone nothing answers, so a write by id touches neither. Fails if a later own row takes over
         * the id.
         */
        @Test func anOwnRowArrivingLaterNeverTakesAFamilyRowsId() async throws {
            let family = try FamilyFixture()
            let server = family.server(chain: [family.r1, family.r2], pin: try family.pin(through: [family.r1, family.r2]))
            server.put(family.photo)
            let photoVersion = try #require(family.photo.currentVersion)
            server.objects[photoVersion.id] = family.photoObject
            let phone = try await family.phone(server)
            defer { phone.done() }
            let vault = phone.vault
            guard case .accepted = await phone.sync.sync(family.summary) else { Issue.record("not accepted"); return }
            _ = try await vault.children(of: family.rootId)
            try await vault.open(family.personalRoot)
            let ownPhoto = try ownRow(family.photo.id, family, kind: .file, name: "Mine.jpg")
            // Refused: the id belongs to the family row on this phone, so the screens never hold both.
            await #expect(throws: IdCollision.self) { try await vault.open(ownPhoto) }
            #expect(await vault.item(ownPhoto.ref) == nil)
            #expect(await vault.item(family.photo.id) == nil)
            #expect(await vault.item(family.photo.ref)?.name == "Beach.jpg")
            let file = FileManager.default.temporaryDirectory.appendingPathComponent("later-\(UUID().uuidString)")
            try await vault.download(family.photo.id, ref: family.photo.ref, expectedVersionId: photoVersion.id, to: file)
            #expect(try Data(contentsOf: file) == family.photoBytes)
            server.clearRequests()
            await #expect(throws: (any Error).self) { _ = try await vault.rename(family.photo.id, to: "Renamed.jpg") }
            #expect(server.writes.isEmpty)
        }

        /* `bytes` sealed as a new version of `nodeId` in the family folder, under the photo's key, signed by the creator. */
        private func sealVersion(_ bytes: Data, of nodeId: String, _ family: FamilyFixture, in workspace: String? = nil, nodeKey: Data? = nil,
                                 versionId: String? = nil) throws -> (VersionView, Data) {
            let workspaceId = workspace ?? family.workspaceId
            let versionId = try versionId ?? newId(kind: .version, scopeId: workspaceId).id
            let objectId = try newId(kind: .object, scopeId: workspaceId).id
            let contentKey = try randomBytes(length: 32)
            let nonce = try randomBytes(length: 16)
            let suite = HushOSCore.contentSuite()
            let size = UInt64(bytes.count)
            let content = Content(workspaceId: workspaceId, objectId: objectId, suite: suite, key: contentKey, nonce: nonce, plaintextSize: size, thumbnailBytes: 0)
            let layout = try contentLayout(suite: suite, plaintextSize: size, thumbnailBytes: 0)
            var object = Data()
            var at = 0
            for index in 0 ..< layout.chunkCount {
                let length = Int(chunkLength(plaintextSize: size, index: index))
                object.append(try chunkEncrypt(content: content, index: index, plaintext: bytes.subdata(in: at ..< at + length)))
                at += length
            }
            let sealed = try versionSeal(ctx: VersionContext(workspaceId: workspaceId, nodeId: nodeId, versionId: versionId, objectId: objectId),
                                         nodeKey: nodeKey ?? family.photoKey, contentKey: contentKey, plaintextSize: size, thumbnailBytes: 0)
            let signature = try versionSign(signingSeed: family.creator.keys.signingSeed,
                                            statement: VersionStatement(workspaceId: workspaceId, nodeId: nodeId, versionId: versionId, objectId: objectId, contentSuite: suite),
                                            contentKeyEnvelope: sealed.envelope)
            var version = VersionView(id: versionId, objectId: objectId, contentKeyEnvelope: base64urlEncode(bytes: sealed.envelope), status: "ready", contentSuite: suite,
                                      chunkCount: Int(layout.chunkCount), contentNonce: base64urlEncode(bytes: nonce), plaintextSize: nil,
                                      ciphertextSize: String(object.count), readyAt: "2026-10-19T10:00:00.000Z")
            version.signer = Signer(id: family.creator.userId)
            version.signature = base64urlEncode(bytes: signature)
            return (version, object)
        }

        /*
         * A newer member list that changes no folder key is accepted (the core commits it, so the ledger
         * says writable) while the guard it hands back can't be stored: the refusal takes the commit back
         * (the web's uncommit), so nothing of the family lists, and until a later sync stores it every
         * write into the family is refused with the storage words (the barrier, before the core) and
         * nothing reaches the server; once stored, reading and writing go on. Fails if a write checks
         * only the ledger, or the refused chain still opens the folder.
         */
        @Test func aFamilyWriteWhileItsGuardIsNotStoredIsRefusedAndNothingIsSent() async throws {
            let family = try FamilyFixture()
            let writes = GuardSwitch()
            let server = family.server(chain: [family.r1, family.r2], pin: try family.pin(through: [family.r1, family.r2]))
            let phone = try await family.phone(server, guards: familyGuards(family.member, writes: writes))
            defer { phone.done() }
            guard case .accepted = await phone.sync.sync(family.summary) else { Issue.record("not accepted"); return }
            _ = try await phone.vault.children(of: family.rootId)

            server.serve(chain: [family.r1, family.r2, family.r3])
            writes.writable = false
            #expect(await phone.sync.sync(family.summary) == .failed(GuardWords.unsaved))
            #expect(phone.vault.areaLedger.isArea(workspaceId: family.workspaceId))
            // The refused chain opens nothing: the folder doesn't list through it.
            await #expect(throws: (any Error).self) { _ = try await phone.vault.children(of: family.rootId) }
            server.clearRequests()
            // The barrier holds the family's folders with the storage words, the last check every write makes before it leaves.
            await #expect(throws: GuardError.unsaved) { try await phone.vault.sendingIntoFamily(family.workspaceId) }
            await #expect(throws: (any Error).self) { _ = try await phone.vault.createFolder(in: family.rootId, name: "Trips") }
            await #expect(throws: (any Error).self) { _ = try await phone.vault.rename(family.fileId, to: "Recipes (old).txt") }
            await #expect(throws: (any Error).self) { try await phone.vault.trash(family.fileId) }
            #expect(server.writes.isEmpty, "a family write was sent while its guard wasn't stored: \(server.writes)")

            writes.writable = true
            guard case .accepted = await phone.sync.sync(family.summary) else { Issue.record("not accepted once the guard stored"); return }
            #expect(try phone.held.family(family.groupId)?.rosterVersion == 3)
            _ = try await phone.vault.children(of: family.rootId)
            _ = try await phone.vault.createFolder(in: family.rootId, name: "Trips")
            #expect(server.sent("/api/drive/folders").count == 1)
        }

        /*
         * A new folder started while the family's guard was stored, suspended on its first await (the
         * server's key epochs), while a sync commits a newer member list and fails to store its guard:
         * when it resumes, the folder is never sent. Fails unless the barrier is checked again past the
         * entry, where the key is made and right before the write leaves.
         */
        @Test func aWriteSuspendedWhileASyncFailsToStoreItsGuardIsNeverSent() async throws {
            let family = try FamilyFixture()
            let writes = GuardSwitch()
            let server = family.server(chain: [family.r1, family.r2], pin: try family.pin(through: [family.r1, family.r2]))
            let phone = try await family.phone(server, guards: familyGuards(family.member, writes: writes))
            defer { phone.done() }
            guard case .accepted = await phone.sync.sync(family.summary) else { Issue.record("not accepted"); return }
            _ = try await phone.vault.children(of: family.rootId)

            let hold = DispatchSemaphore(value: 0)
            server.holdEpochs = hold
            let vault = phone.vault
            let rootId = family.rootId
            let creating = Task { try await vault.createFolder(in: rootId, name: "Trips") }
            // Past the entry check, waiting on the server.
            await withCheckedContinuation { (done: CheckedContinuation<Void, Never>) in
                DispatchQueue.global().async { server.epochsArrived.wait(); done.resume() }
            }
            server.serve(chain: [family.r1, family.r2, family.r3])
            writes.writable = false
            #expect(await phone.sync.sync(family.summary) == .failed(GuardWords.unsaved))
            server.holdEpochs = nil
            hold.signal()
            await #expect(throws: GuardError.unsaved) { _ = try await creating.value }
            #expect(server.sent("/api/drive/folders").isEmpty, "a folder was sent under a chain whose guard wasn't stored")
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
            // Made again under the destination's keys, the record keeps the photo's attributes.
            let metadata = try metadataOpen(ctx: MetadataContext(workspaceId: family.personal, nodeId: nodeId, metadataVersion: 1), nodeKey: key,
                                            envelope: try base64urlDecode(value: try #require(node["metadataEnvelope"] as? String)))
            #expect(metadata.name == "Beach.jpg")
            #expect(metadata.attributes == FamilyFixture.attributes)
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
            guard case .accepted(let chain) = try acceptRosters(groupId: family.groupId, firstKeys: try family.firstKeys, anchor: .created, pins: [], rosters: rosters,
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
