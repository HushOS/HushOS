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

        /* The row as a received share's listing serves it: with no change order. */
        private func unordered(_ node: NodeView) throws -> NodeView {
            var json = try #require(try JSONSerialization.jsonObject(with: JSONEncoder().encode(node)) as? [String: Any])
            json["changeSeq"] = nil
            return try JSONDecoder().decode(NodeView.self, from: JSONSerialization.data(withJSONObject: json))
        }

        /*
         * A received share's file is restored to an earlier version on another device while this
         * phone's row shows the later one. Shares carry no change order and a restore moves neither
         * key epoch nor metadata version, so the row the latest listing returned is trusted: opening
         * the file brings the restored content. Fails if a tie in the ordering refuses on every try.
         */
        @Test func aSharedFileRestoredToAnEarlierVersionOpensWithTheRestoredContent() async throws {
            let family = try FamilyFixture()
            let server = family.server(chain: [family.r1, family.r2], pin: try family.pin(through: [family.r1, family.r2]))
            let phone = try await family.phone(server)
            defer { phone.done() }
            let vault = phone.vault
            let theirs = UUID().uuidString.lowercased()
            let (sKey, fileKey) = (try randomBytes(length: 32), try randomBytes(length: 32))
            let shared = try FamilyFixture.node(id: try newId(kind: .node, scopeId: theirs).id, in: theirs, parent: nil, parentKey: try randomBytes(length: 32), key: sKey,
                                                kind: .folder, name: "Shared", writer: family.creator)
            let fileId = try newId(kind: .node, scopeId: theirs).id
            let base = try FamilyFixture.node(id: fileId, in: theirs, parent: shared.id, parentKey: sKey, key: fileKey, kind: .file, name: "Plan.txt", writer: family.creator)
            let (earlier, earlierObject) = try sealVersion(Data("earlier".utf8), of: fileId, family, in: theirs, nodeKey: fileKey)
            let (later, laterObject) = try sealVersion(Data("later".utf8), of: fileId, family, in: theirs, nodeKey: fileKey)
            server.objects[earlier.id] = earlierObject
            server.objects[later.id] = laterObject
            server.put(shared, try unordered(base.with(version: later)))
            _ = try await vault.adopt(shared, nodeKey: sKey, metadata: NodeMetadata(name: "Shared", mime: nil, size: nil, modified: nil, attributes: [:]), in: theirs)
            let shown = try #require(try await vault.children(of: shared.id).first)
            #expect(shown.node.currentVersion?.id == later.id)
            // Restored to the earlier version elsewhere; the next listing of the folder serves that row.
            server.put(try unordered(base.with(version: earlier)))
            _ = try await vault.children(of: shared.id)
            let folder = FileManager.default.temporaryDirectory.appendingPathComponent("restored-\(UUID().uuidString)", isDirectory: true)
            try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
            let (copied, file) = try await vault.downloadCurrent(shown) { row in folder.appendingPathComponent(try #require(row.node.currentVersion).id) }
            #expect(copied.node.currentVersion?.id == earlier.id)
            #expect(try Data(contentsOf: file) == Data("earlier".utf8))
        }

        /*
         * Eve re-keys a folder inside the share (a new folder key, its file rewrapped under it) and
         * adds a file under the new key. One listing of the folder takes the folder's new key from
         * its page before its children, so the rewrapped file and the new one both open. Fails if the
         * children open under the folder key held from before.
         */
        @Test func aNestedSharedFolderReKeyedByItsOwnerListsAndOpensAfterOneListing() async throws {
            let family = try FamilyFixture()
            let server = family.server(chain: [family.r1, family.r2], pin: try family.pin(through: [family.r1, family.r2]))
            let phone = try await family.phone(server)
            defer { phone.done() }
            let vault = phone.vault
            let theirs = UUID().uuidString.lowercased()
            let (sKey, oldKey, newKey, planKey) = (try randomBytes(length: 32), try randomBytes(length: 32), try randomBytes(length: 32), try randomBytes(length: 32))
            let shared = try FamilyFixture.node(id: try newId(kind: .node, scopeId: theirs).id, in: theirs, parent: nil, parentKey: try randomBytes(length: 32), key: sKey,
                                                kind: .folder, name: "Shared", writer: family.creator)
            let folderId = try newId(kind: .node, scopeId: theirs).id
            let folder = try FamilyFixture.node(id: folderId, in: theirs, parent: shared.id, parentKey: sKey, key: oldKey, kind: .folder, name: "Trips", writer: family.creator)
            let planId = try newId(kind: .node, scopeId: theirs).id
            let plan = try FamilyFixture.node(id: planId, in: theirs, parent: folderId, parentKey: oldKey, key: planKey, kind: .file, name: "Plan.txt", writer: family.creator)
            server.put(shared, folder, plan)
            _ = try await vault.adopt(shared, nodeKey: sKey, metadata: NodeMetadata(name: "Shared", mime: nil, size: nil, modified: nil, attributes: [:]), in: theirs)
            _ = try await vault.children(of: shared.id)
            #expect(try await vault.children(of: folderId).map(\.name) == ["Plan.txt"])

            // Re-keyed by Eve: the folder at key epoch 2, its file rewrapped under the new key, and a new file under it.
            let rekeyed = try FamilyFixture.node(id: folderId, in: theirs, parent: shared.id, parentKey: sKey, key: newKey, kind: .folder, name: "Trips",
                                                 writer: family.creator, keyEpoch: 2).with(version: nil)
            let rewrapped = try FamilyFixture.node(id: planId, in: theirs, parent: folderId, parentKey: newKey, key: planKey, kind: .file, name: "Plan.txt",
                                                   writer: family.creator, parentKeyEpoch: 2).with(version: nil)
            let added = try FamilyFixture.node(id: try newId(kind: .node, scopeId: theirs).id, in: theirs, parent: folderId, parentKey: newKey,
                                               key: try randomBytes(length: 32), kind: .file, name: "Tickets.txt", writer: family.creator, parentKeyEpoch: 2)
            server.put(rekeyed, rewrapped, added)
            #expect(try await vault.children(of: folderId).map(\.name) == ["Plan.txt", "Tickets.txt"], "the folder's children opened under its old key")
            #expect(await vault.nodeKey(of: try #require(await vault.item(rekeyed.ref))) == newKey)
            #expect(await vault.item(added.ref) != nil)
        }

        /*
         * A share's file is served in a form this version can't open (a later envelope format): the
         * row held stays, still listed and still opened, rather than dropped and left unopenable.
         * Fails if a row is let go of before the page's row has opened.
         */
        @Test func aSharedRowThatFailsToReopenKeepsTheRowHeld() async throws {
            let family = try FamilyFixture()
            let server = family.server(chain: [family.r1, family.r2], pin: try family.pin(through: [family.r1, family.r2]))
            let phone = try await family.phone(server)
            defer { phone.done() }
            let vault = phone.vault
            let theirs = UUID().uuidString.lowercased()
            let (sKey, planKey) = (try randomBytes(length: 32), try randomBytes(length: 32))
            let shared = try FamilyFixture.node(id: try newId(kind: .node, scopeId: theirs).id, in: theirs, parent: nil, parentKey: try randomBytes(length: 32), key: sKey,
                                                kind: .folder, name: "Shared", writer: family.creator)
            let plan = try FamilyFixture.node(id: try newId(kind: .node, scopeId: theirs).id, in: theirs, parent: shared.id, parentKey: sKey, key: planKey,
                                              kind: .file, name: "Plan.txt", writer: family.creator)
            server.put(shared, plan)
            _ = try await vault.adopt(shared, nodeKey: sKey, metadata: NodeMetadata(name: "Shared", mime: nil, size: nil, modified: nil, attributes: [:]), in: theirs)
            #expect(try await vault.children(of: shared.id).map(\.name) == ["Plan.txt"])
            var later = plan.with(version: nil)
            later.envelopeSuite = 2
            server.put(later)
            #expect(try await vault.children(of: shared.id).map(\.name) == ["Plan.txt"], "a row that didn't reopen was dropped")
            #expect(await vault.item(plan.ref)?.node == plan)
            #expect(await vault.nodeKey(of: try #require(await vault.item(plan.ref))) == planKey)
        }

        /* A share Eve's server serves to the member, naming `node` in `workspace`. */
        private func share(into workspace: String, _ node: NodeView) -> SharedWithMeView {
            SharedWithMeView(id: "share-1", workspaceId: workspace, role: "editor", keyEpoch: 1, shareEnvelope: "", prevShareEnvelope: nil, prevKeyEpoch: nil,
                             createdAt: "", granter: .init(id: "eve", name: "Eve", email: "eve@example.com", encryptionPublicKey: ""), node: node)
        }

        /*
         * A share that targets the family's own folder, mounted after route 25 proved it: refused
         * before any key opens, and the family's rows stay the ledger's. Fails if a share mount can
         * put a row and key into a family's folder.
         */
        @Test func aShareIntoAFamilyFolderIsRefusedAtMount() async throws {
            let family = try FamilyFixture()
            let server = family.server(chain: [family.r1, family.r2], pin: try family.pin(through: [family.r1, family.r2]))
            let phone = try await family.phone(server)
            defer { phone.done() }
            let vault = phone.vault
            guard case .accepted = await phone.sync.sync(family.summary) else { Issue.record("not accepted"); return }
            _ = try await vault.children(of: family.rootId)
            await #expect(throws: FamilyFailure.self) { try await vault.admitShare(share(into: family.workspaceId, family.file)) }
            #expect(await vault.ledgerOpened.contains(family.file.ref))
        }

        /*
         * The share was mounted before the family's folder was proven (nothing yet named it a
         * family's). Once route 25 proves it, what the share put there goes, row and key, and the
         * family's file is opened by its ledger alone. Fails if becoming a family folder keeps a
         * share's rows.
         */
        @Test func aShareMountedBeforeTheFolderWasProvenIsEvictedWhenItIs() async throws {
            let family = try FamilyFixture()
            let server = family.server(chain: [family.r1, family.r2], pin: try family.pin(through: [family.r1, family.r2]))
            let phone = try await family.phone(server)
            defer { phone.done() }
            let vault = phone.vault
            // What the mount leaves: the file's row and a key the share handed over, in a workspace nothing names a family's yet.
            try await vault.admitShare(share(into: family.workspaceId, family.file))
            let mounted = try await vault.adopt(family.file, nodeKey: try randomBytes(length: 32),
                                      metadata: NodeMetadata(name: "Recipes.txt", mime: "text/plain", size: nil, modified: nil, attributes: [:]), in: family.workspaceId)
            #expect(await vault.item(family.file.ref) != nil)
            guard case .accepted = await phone.sync.sync(family.summary) else { Issue.record("not accepted"); return }
            #expect(await vault.item(family.file.ref) == nil, "the share's row outlived the folder becoming a family's")
            #expect(await vault.nodeKey(of: mounted) == nil)
            _ = try await vault.children(of: family.rootId)
            #expect(await vault.ledgerOpened.contains(family.file.ref))
            #expect(await vault.nodeKey(of: mounted) == family.fileKey)
        }

        /*
         * After a fork cleared the family, a share refresh can't put its file back, and a row and key
         * held for it any way but its ledger are never served: Info's read finds nothing, a download
         * refuses before it decrypts, and opening it asks the ledger (which refuses the forked family).
         * Fails if a share mount or a cached row stands in for the ledger.
         */
        @Test func afterAForkClearAShareCantRefillTheFamilyAndDownloadRefuses() async throws {
            let family = try FamilyFixture()
            let server = family.server(chain: [family.r1, family.r2, family.r3], pin: try family.pin(through: [family.r1, family.r2]))
            let phone = try await family.phone(server)
            defer { phone.done() }
            let vault = phone.vault
            guard case .accepted = await phone.sync.sync(family.summary) else { Issue.record("not accepted"); return }
            let file = try #require(try await vault.children(of: family.rootId).first { $0.id == family.fileId })
            server.serve(chain: [family.r1, family.r2, family.r3Fork, family.r4Fork])
            guard case .fork = await phone.sync.sync(family.summary) else { Issue.record("no warning"); return }
            await #expect(throws: FamilyFailure.self) { try await vault.admitShare(share(into: family.workspaceId, family.file)) }
            #expect(await vault.item(file.ref) == nil, "the forked family's file was refilled")
            // A row and key held for the family file that its ledger didn't open (as a share mount would leave them).
            await vault.holdUnchecked(file, key: family.fileKey)
            #expect(await vault.item(file.ref) == nil)
            let out = FileManager.default.temporaryDirectory.appendingPathComponent("unchecked-\(UUID().uuidString)")
            await #expect(throws: FamilyFailure.self) { try await vault.download(file.id, ref: file.ref, to: out) }
            #expect(!FileManager.default.fileExists(atPath: out.path))
            await #expect(throws: (any Error).self) { try await vault.open(family.file) }
            #expect(await vault.nodeKey(of: file) == nil, "a key the ledger didn't give stayed after the ledger was asked")
        }

        /*
         * The member list names a received share's workspace. While that family's guard is owed the
         * barrier holds it, so the share isn't mounted; once the guard is stored the list's word
         * counts for nothing, and the share mounts and lists as any other. Fails if the barrier's
         * hold outlasts the guard, or counts as proof a family owns the folder.
         */
        @Test func aShareARosterNamedIsRefusedOnlyWhileItsGuardIsOwed() async throws {
            let theirs = UUID().uuidString.lowercased()
            let family = try await onLargeStack { try FamilyFixture.$naming.withValue(theirs) { try FamilyFixture() } }
            let writes = GuardSwitch()
            writes.writable = false
            let server = family.server(chain: [family.r1, family.r2], pin: try family.pin(through: [family.r1, family.r2]))
            let phone = try await family.phone(server, guards: familyGuards(family.member, writes: writes))
            defer { phone.done() }
            let vault = phone.vault
            let sKey = try randomBytes(length: 32)
            let shared = try FamilyFixture.node(id: try newId(kind: .node, scopeId: theirs).id, in: theirs, parent: nil, parentKey: try randomBytes(length: 32), key: sKey,
                                                kind: .folder, name: "Shared", writer: family.creator)
            let plan = try FamilyFixture.node(id: try newId(kind: .node, scopeId: theirs).id, in: theirs, parent: shared.id, parentKey: sKey,
                                              key: try randomBytes(length: 32), kind: .file, name: "Plan.txt", writer: family.creator)
            server.put(shared, plan)
            #expect(await phone.sync.sync(family.summary) == .failed(GuardWords.unsaved))
            await #expect(throws: FamilyFailure.self) { try await vault.admitShare(share(into: theirs, shared)) }
            writes.writable = true
            guard case .accepted = await phone.sync.sync(family.summary) else { Issue.record("not accepted once the guard stored"); return }
            try await vault.admitShare(share(into: theirs, shared))
            _ = try await vault.adopt(shared, nodeKey: sKey, metadata: NodeMetadata(name: "Shared", mime: nil, size: nil, modified: nil, attributes: [:]), in: theirs)
            #expect(try await vault.children(of: shared.id).map(\.name) == ["Plan.txt"])
        }

        /*
         * Two families' member lists name the same workspace. Each family's barrier holds it while
         * that family's guard is owed, whichever named it first. Fails if only the first family's
         * word is kept.
         */
        @Test func aWorkspaceTwoFamiliesNameIsHeldByEachFamilysBarrier() async throws {
            let family = try FamilyFixture()
            let server = family.server(chain: [family.r1, family.r2], pin: try family.pin(through: [family.r1, family.r2]))
            let phone = try await family.phone(server)
            defer { phone.done() }
            let vault = phone.vault
            let (named, first, second) = (UUID().uuidString.lowercased(), UUID().uuidString.lowercased(), UUID().uuidString.lowercased())
            await vault.holdAsFamilyWorkspaces([named], of: first)
            await vault.holdAsFamilyWorkspaces([named], of: second)
            await vault.oweFamilyGuard(second)
            await #expect(throws: GuardError.unsaved) { try await vault.sendingIntoFamily(named) }
            await vault.familyGuardKept(second)
            await vault.oweFamilyGuard(first)
            await #expect(throws: GuardError.unsaved) { try await vault.sendingIntoFamily(named) }
            await vault.familyGuardKept(first)
            try await vault.sendingIntoFamily(named)
        }

        /*
         * The first account let go of its family's folder (refused), then signed out; another account
         * signs in in the same process. The first account's record of what it let go of is its own:
         * the second account's share into that workspace mounts. Fails if what one session let go of
         * refuses another's shares.
         */
        @Test func anotherAccountsLetGoRecordNeverRefusesThisAccountsShare() async throws {
            let first = try FamilyFixture()
            let account = CopyEpoch()
            let server = first.server(chain: [first.r1, first.r2], pin: try first.pin(through: [first.r1, first.r2]))
            let phone = try await first.phone(server, account: account)
            guard case .accepted = await phone.sync.sync(first.summary) else { Issue.record("not accepted"); phone.done(); return }
            await phone.sync.refuse(first.groupId)
            phone.done()
            TemporaryCopies.endAccount(account)

            let second = try FamilyFixture()
            let otherServer = second.server(chain: [second.r1, second.r2], pin: try second.pin(through: [second.r1, second.r2]))
            let next = try await second.phone(otherServer)
            defer { next.done() }
            let node = try FamilyFixture.node(id: try newId(kind: .node, scopeId: first.workspaceId).id, in: first.workspaceId, parent: nil,
                                              parentKey: try randomBytes(length: 32), key: try randomBytes(length: 32), kind: .folder, name: "Shared",
                                              writer: second.creator)
            try await next.vault.admitShare(share(into: first.workspaceId, node))
        }

        /* Eve's shared folder in her workspace `theirs`, with a file in it, served by `server`. */
        private func eveShare(in theirs: String, _ family: FamilyFixture, _ server: FamilyServer) throws -> (folder: NodeView, key: Data) {
            let key = try randomBytes(length: 32)
            let folder = try FamilyFixture.node(id: try newId(kind: .node, scopeId: theirs).id, in: theirs, parent: nil, parentKey: try randomBytes(length: 32), key: key,
                                                kind: .folder, name: "Shared", writer: family.creator)
            let plan = try FamilyFixture.node(id: try newId(kind: .node, scopeId: theirs).id, in: theirs, parent: folder.id, parentKey: key,
                                              key: try randomBytes(length: 32), kind: .file, name: "Plan.txt", writer: family.creator)
            server.put(folder, plan)
            return (folder, key)
        }

        /*
         * A device record an earlier version wrote saved every folder the member list named, a received
         * share's among them. Those areas are hints: a sync never clears that share's rows or keys, never
         * lets go of its workspace, and its mounts go on; nor does a refusal of the family. Fails if a
         * record's area counts as proof a family owns the folder without route 25 and its id.
         */
        @Test func aLegacyRecordNamingAReceivedSharesWorkspaceLeavesTheShareMounted() async throws {
            let family = try FamilyFixture()
            let server = family.server(chain: [family.r1, family.r2], pin: try family.pin(through: [family.r1, family.r2]))
            let phone = try await family.phone(server)
            defer { phone.done() }
            let vault = phone.vault
            guard case .accepted = await phone.sync.sync(family.summary) else { Issue.record("not accepted"); return }
            let theirs = UUID().uuidString.lowercased()
            let (shared, sKey) = try eveShare(in: theirs, family, server)
            try await vault.admitShare(share(into: theirs, shared))
            let mounted = try await vault.adopt(shared, nodeKey: sKey, metadata: NodeMetadata(name: "Shared", mime: nil, size: nil, modified: nil, attributes: [:]),
                                                in: theirs, fromShare: true)
            // The record as an earlier version left it: the share's workspace among its areas, and no mark that they were proven.
            let row = try #require(phone.records.read(userId: family.member.userId, groupId: family.groupId))
            try phone.records.put(userId: family.member.userId, groupId: family.groupId,
                                  FamilyRecords.Row(envelope: row.envelope, rosterVersion: row.rosterVersion, areas: row.areas + [theirs]))
            guard case .accepted = await phone.sync.sync(family.summary) else { Issue.record("not accepted again"); return }
            #expect(await vault.item(shared.ref) != nil, "a legacy record's area cleared a share")
            #expect(await vault.nodeKey(of: mounted) == sKey)
            try await vault.admitShare(share(into: theirs, shared))
            #expect(try await vault.children(of: shared.id).map(\.name) == ["Plan.txt"])
            let rewritten = try #require(phone.records.read(userId: family.member.userId, groupId: family.groupId))
            #expect(rewritten.areasProven == true && !rewritten.areas.contains(theirs))
            // A refusal of the family lets go of its own folders only.
            await phone.sync.refuse(family.groupId)
            #expect(await vault.item(shared.ref) != nil)
            try await vault.admitShare(share(into: theirs, shared))
        }

        /*
         * A share into a folder that route 25 proves a family's while the share's granter is judged: the
         * mount's check again where it keeps the row refuses it, so nothing of the share is kept, and it
         * is never answered as the ledger's. A write's answer under a key the ledger doesn't hold isn't
         * kept as the ledger's either. Fails if the share is kept on the first check alone, or tagged as
         * the ledger's because its folder is a family's by then.
         */
        @Test func aShareWhoseFolderIsProvenBetweenAdmitAndKeepKeepsNothing() async throws {
            let family = try FamilyFixture()
            let server = family.server(chain: [family.r1, family.r2], pin: try family.pin(through: [family.r1, family.r2]))
            server.put(family.photo)
            let phone = try await family.phone(server)
            defer { phone.done() }
            let vault = phone.vault
            // Admitted while nothing names the folder a family's...
            try await vault.admitShare(share(into: family.workspaceId, family.photo))
            // ...then proven while the granter is judged.
            guard case .accepted = await phone.sync.sync(family.summary) else { Issue.record("not accepted"); return }
            let metadata = NodeMetadata(name: "Beach.jpg", mime: "image/jpeg", size: nil, modified: nil, attributes: [:])
            await #expect(throws: FamilyFailure.self) {
                try await vault.admitShare(share(into: family.workspaceId, family.photo))
                _ = try await vault.adopt(family.photo, nodeKey: family.photoKey, metadata: metadata, in: family.workspaceId, fromShare: true)
            }
            await #expect(throws: FamilyFailure.self) {
                _ = try await vault.adopt(family.photo, nodeKey: family.photoKey, metadata: metadata, in: family.workspaceId, fromShare: true)
            }
            #expect(await vault.item(family.photo.ref) == nil)
            #expect(!(await vault.ledgerOpened.contains(family.photo.ref)))
            // A write's answer sealed under a key the ledger doesn't hold for it: not kept as the ledger's.
            _ = try await vault.adopt(family.photo, nodeKey: try randomBytes(length: 32), metadata: metadata, in: family.workspaceId)
            #expect(!(await vault.ledgerOpened.contains(family.photo.ref)))
            #expect(await vault.item(family.photo.ref) == nil)
        }

        /*
         * A share's download into a folder nothing names a family's yet begins; before its next chunk,
         * route 25 proves the folder a family's. Nothing more comes down under the share's key and no
         * file is left. Fails if a download begun as no family's keeps writing once its folder is proven.
         */
        @Test func aShareDownloadStopsWhenItsFolderIsProven() async throws {
            let family = try FamilyFixture()
            let server = family.server(chain: [family.r1, family.r2], pin: try family.pin(through: [family.r1, family.r2]))
            server.put(family.photo)
            let version = try #require(family.photo.currentVersion)
            server.objects[version.id] = family.photoObject
            let phone = try await family.phone(server)
            defer { phone.done() }
            let vault = phone.vault
            try await vault.admitShare(share(into: family.workspaceId, family.photo))
            _ = try await vault.adopt(family.photo, nodeKey: family.photoKey, metadata: NodeMetadata(name: "Beach.jpg", mime: "image/jpeg", size: nil, modified: nil, attributes: [:]),
                                      in: family.workspaceId, fromShare: true)
            let (sync, summary) = (phone.sync, family.summary)
            await vault.setBeforeChunk { index in if index == 0 { _ = await sync.sync(summary) } }
            let out = FileManager.default.temporaryDirectory.appendingPathComponent("proven-\(UUID().uuidString)")
            await #expect(throws: FamilyFailure.self) { try await vault.download(family.photo.id, ref: family.photo.ref, to: out) }
            #expect(!FileManager.default.fileExists(atPath: out.path))
            let part = out.appendingPathExtension("part")
            let partial = FileManager.default.fileExists(atPath: part.path) ? try Data(contentsOf: part) : Data()
            #expect(partial.isEmpty, "a chunk came down under the share's key after its folder was proven")
            await vault.setBeforeChunk(nil)
        }

        /* The photo held as a share's row before its folder is proven a family's (a share mount's), content served. */
        private func photoAsShare(_ family: FamilyFixture, _ server: FamilyServer, _ vault: Vault) async throws -> Opened {
            server.put(family.photo)
            server.objects[try #require(family.photo.currentVersion).id] = family.photoObject
            try await vault.admitShare(share(into: family.workspaceId, family.photo))
            return try await vault.adopt(family.photo, nodeKey: family.photoKey,
                                         metadata: NodeMetadata(name: "Beach.jpg", mime: "image/jpeg", size: nil, modified: nil, attributes: [:]),
                                         in: family.workspaceId, fromShare: true)
        }

        /*
         * A share's file kept on this phone (and opened in another app) before route 25 proved its folder
         * a family's: once proven, the kept entry, its plaintext and the opened copy all go, and the
         * screens hear which rows went. Fails if a proof purges only the vault's rows and keys.
         */
        @Test func aSharedFileKeptOfflineWhoseFolderIsProvenLeavesNothing() async throws {
            let family = try FamilyFixture()
            let server = family.server(chain: [family.r1, family.r2], pin: try family.pin(through: [family.r1, family.r2]))
            let phone = try await family.phone(server)
            defer { phone.done() }
            let vault = phone.vault
            let photo = try await photoAsShare(family, server, vault)
            defer { Offline.forget(photo.id) }
            try await vault.keepDownloaded(photo)
            let kept = try #require(Offline.localCopy(of: photo))
            let opened = try #require(TemporaryCopies.openedFolder(itemId: photo.id, version: "v1", familyWorkspace: nil, shareWorkspace: family.workspaceId))
            try FileManager.default.createDirectory(at: opened, withIntermediateDirectories: true)
            try Data("plaintext".utf8).write(to: opened.appendingPathComponent("Beach.jpg"))
            guard case .accepted = await phone.sync.sync(family.summary) else { Issue.record("not accepted"); return }
            #expect(!Offline.isKept(photo.id), "a share's kept file outlived its folder becoming a family's")
            #expect(!FileManager.default.fileExists(atPath: kept.path))
            #expect(!FileManager.default.fileExists(atPath: opened.path))
            #expect(await vault.takeEvicted().contains(photo.id))
        }

        /*
         * A copy opened from a share's file, then the app starts again (a fresh vault, which holds none of
         * its rows), then route 25 proves the share's workspace a family's: the copy goes, found by its
         * workspace, not by ids this process holds. A copy an earlier version left flat goes when the vault
         * starts; one of this account's own items stays. Fails if a share's copy can only be found by the
         * ids the vault holds.
         */
        @Test func aSharesCopyGoesWhenItsFolderIsProvenAfterARestart() async throws {
            let family = try FamilyFixture()
            let server = family.server(chain: [family.r1, family.r2], pin: try family.pin(through: [family.r1, family.r2]))
            func copy(_ folder: URL) throws -> URL {
                try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
                let file = folder.appendingPathComponent("copy")
                try Data("plaintext".utf8).write(to: file)
                return file
            }
            let shared = try copy(try #require(TemporaryCopies.openedFolder(itemId: family.fileId, version: "v1", familyWorkspace: nil, shareWorkspace: family.workspaceId)))
            let ownId = UUID().uuidString.lowercased()
            let own = try copy(try #require(TemporaryCopies.openedFolder(itemId: ownId, version: "v1", familyWorkspace: nil)))
            defer { try? FileManager.default.removeItem(at: own.deletingLastPathComponent().deletingLastPathComponent()) }
            let legacy = try copy(FileManager.default.temporaryDirectory.appendingPathComponent("opened/\(UUID().uuidString.lowercased())/v1", isDirectory: true))
            // The app started again: a fresh vault.
            let phone = try await family.phone(server)
            defer { phone.done() }
            #expect(!FileManager.default.fileExists(atPath: legacy.path), "an earlier version's flat copy outlived the start")
            #expect(FileManager.default.fileExists(atPath: own.path), "the own drive's copy was dropped")
            #expect(FileManager.default.fileExists(atPath: shared.path))
            guard case .accepted = await phone.sync.sync(family.summary) else { Issue.record("not accepted"); return }
            #expect(!FileManager.default.fileExists(atPath: shared.path), "a share's copy outlived its folder becoming a family's")
            #expect(FileManager.default.fileExists(atPath: own.path))
        }

        /*
         * Writes that decided at entry not to write as a family's (a share's rename, a trash batch) and
         * a write that declared nothing (as share() and the link and tag writes are) reach the final gate
         * as route 25 proves their folder a family's: each is refused there, and nothing is sent. A write
         * into a folder a family whose guard is owed named is refused too. Fails if any write goes out on
         * its entry check alone.
         */
        @Test func writesDecidedBeforeAProofAreRefusedAtTheFinalGate() async throws {
            let family = try FamilyFixture()
            let server = family.server(chain: [family.r1, family.r2], pin: try family.pin(through: [family.r1, family.r2]))
            let phone = try await family.phone(server)
            defer { phone.done() }
            let vault = phone.vault
            let photo = try await photoAsShare(family, server, vault)
            let (sync, summary) = (phone.sync, family.summary)
            await vault.setBeforeGate { _ in _ = await sync.sync(summary) }
            server.clearRequests()
            await #expect(throws: (any Error).self) { _ = try await vault.rename(photo.id, to: "Renamed.jpg") }
            #expect(server.writes.isEmpty, "a rename begun on a share's path went out: \(server.writes)")
            await vault.setBeforeGate(nil)
            #expect(await vault.isFamilyWorkspace(family.workspaceId))
            // Proven now: a write that declared nothing (as share() and the link and tag writes send) is refused too.
            await #expect(throws: (any Error).self) { _ = try await vault.api.trash(nodeId: photo.id, workspaceId: family.workspaceId) }
            #expect(server.writes.isEmpty)
        }

        /* A trash batch begun on a share's path, its folder proven at the final gate: refused, nothing sent. */
        @Test func aTrashBatchDecidedBeforeAProofIsRefusedAtTheFinalGate() async throws {
            let family = try FamilyFixture()
            let server = family.server(chain: [family.r1, family.r2], pin: try family.pin(through: [family.r1, family.r2]))
            let phone = try await family.phone(server)
            defer { phone.done() }
            let vault = phone.vault
            let photo = try await photoAsShare(family, server, vault)
            let (sync, summary) = (phone.sync, family.summary)
            await vault.setBeforeGate { _ in _ = await sync.sync(summary) }
            server.clearRequests()
            let trashed = await vault.trashMany([photo.id])
            await vault.setBeforeGate(nil)
            #expect(trashed.allSatisfy { if case .failure = $0 { true } else { false } })
            #expect(server.writes.isEmpty, "a trash batch begun on a share's path went out: \(server.writes)")
        }

        /* A workspace a member list named, while that family's guard is owed: any write into it waits, whatever it decided. */
        @Test func aWriteIntoAWorkspaceHeldUnderAnOwedGuardIsRefusedAtTheFinalGate() async throws {
            let family = try FamilyFixture()
            let server = family.server(chain: [family.r1, family.r2], pin: try family.pin(through: [family.r1, family.r2]))
            let phone = try await family.phone(server)
            defer { phone.done() }
            let vault = phone.vault
            let named = UUID().uuidString.lowercased()
            await vault.holdAsFamilyWorkspaces([named], of: family.groupId)
            await vault.oweFamilyGuard(family.groupId)
            server.clearRequests()
            await #expect(throws: GuardError.unsaved) { _ = try await vault.api.trash(nodeId: family.fileId, workspaceId: named) }
            #expect(server.writes.isEmpty)
            await vault.familyGuardKept(family.groupId)
        }

        /*
         * A family file the vault doesn't hold (a new session's vault before its families are checked
         * again): a download of it is refused, to be asked again, and never looked for in the own drive.
         * Fails if a family's row falls through to the own workspace's listing.
         */
        @Test func aFamilyFileNotHeldIsNeverLookedForInTheOwnDrive() async throws {
            let family = try FamilyFixture()
            let server = family.server(chain: [family.r1, family.r2], pin: try family.pin(through: [family.r1, family.r2]))
            let phone = try await family.phone(server)
            defer { phone.done() }
            server.clearRequests()
            let out = FileManager.default.temporaryDirectory.appendingPathComponent("unheld-\(UUID().uuidString)")
            await #expect(throws: FamilyFailure.self) { try await phone.vault.download(family.fileId, ref: family.file.ref, to: out) }
            #expect(!server.traffic.contains { $0.url.contains(family.personal) && $0.url.contains("/children") }, "a family file was looked for in the own drive")
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
                _ = try await vault.children(of: family.rootId, in: family.workspaceId)
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
         * keys (the bytes open there to the photo), naming the photo at the version read (`moveOf`),
         * and the server deletes the photo as the upload completes: nothing is trashed, and the row
         * leaves this phone. Fails if a cross-space move calls the server's in-workspace move or copy,
         * uploads anything but the photo, leaves `moveOf` out, or trashes the original (the move a
         * copy and a trash used to be, which left both or neither when the trash failed).
         */
        @Test func aMoveAcrossSpacesIsOneUploadThatNamesItsSourceAndTrashesNothing() async throws {
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
            let source = try #require(begin.body["moveOf"] as? [String: Any])
            #expect(source["workspaceId"] as? String == family.workspaceId)
            #expect(source["nodeId"] as? String == family.photo.id)
            #expect(source["versionId"] as? String == family.photo.currentVersion?.id)
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
            // The server deleted the photo with the completion; nothing was sent to the Trash, and the row left this phone.
            #expect(server.node(family.photo.id) == nil)
            #expect(!server.writes.contains { $0.hasSuffix("/trash") || $0.hasSuffix("/trash-batch") })
            #expect(await vault.item(NodeRef(workspaceId: family.workspaceId, nodeId: family.photo.id)) == nil)
            #expect(await vault.item(NodeRef(workspaceId: family.personal, nodeId: nodeId)) != nil)
        }

        /*
         * The photo gets a new version on another device after the move's begin: the server fails the
         * completion `stale` and keeps the photo. The move says so in plain words and the photo stays
         * where it was, live and untrashed, on the server and on this phone. Fails if a stale move is
         * taken for done (the row dropped here), or if the phone trashes or deletes the source itself.
         */
        @Test func aMoveWhoseSourceChangedMeanwhileKeepsTheSourceAndSaysSo() async throws {
            let family = try FamilyFixture()
            let server = family.server(chain: [family.r1, family.r2], pin: try family.pin(through: [family.r1, family.r2]))
            server.put(family.photo)
            server.objects[try #require(family.photo.currentVersion).id] = family.photoObject
            let phone = try await family.phone(server)
            defer { phone.done() }
            guard case .accepted = await phone.sync.sync(family.summary) else { Issue.record("not accepted"); return }
            let vault = phone.vault
            _ = try await vault.children(of: family.rootId)
            server.moveSourceChangesAfterBegin = true
            server.clearRequests()

            do {
                _ = try await vault.relocate(family.photo.id, to: family.personalRoot.id)
                Issue.record("a move whose source changed was taken for done")
            } catch {
                #expect(error.localizedDescription == Vault.movedMeanwhile("Beach.jpg"))
            }
            let kept = try #require(server.node(family.photo.id))
            #expect(kept.trashedAt == nil)
            #expect(!server.writes.contains { $0.hasSuffix("/trash") || $0.hasSuffix("/trash-batch") })
            #expect(await vault.item(NodeRef(workspaceId: family.workspaceId, nodeId: family.photo.id)) != nil)
        }

        /*
         * A family folder moved into the member's own files: the folder is made there, its file moved
         * with `moveOf`, and the source folder, left holding nothing, goes to the Trash (never deleted
         * for good). When its file's move fails `stale`, the source folder stays with the file in it.
         * Fails if a folder is trashed while it still holds a file that didn't move, if the file is
         * trashed rather than moved, or if the folder is purged.
         */
        @Test(arguments: [false, true]) func aFolderMovedAcrossGoesToTheTrashOnlyOnceEveryFileInItMoved(changed: Bool) async throws {
            let family = try FamilyFixture()
            let server = family.server(chain: [family.r1, family.r2], pin: try family.pin(through: [family.r1, family.r2]))
            // The photo inside Docs, its key wrapped under Docs'.
            let wrapped = try nodeWrap(ctx: NodeKeyContext(workspaceId: family.workspaceId, nodeId: family.photo.id, parentId: family.docs.id, parentKeyEpoch: 2, keyEpoch: 3),
                                       parentKey: family.docsKey, nodeKey: family.photoKey)
            let photo = family.photo.with(parentId: .some(family.docs.id), parentKeyEpoch: 2, keyEnvelope: base64urlEncode(bytes: wrapped))
            server.put(family.docs, photo)
            server.objects[try #require(family.photo.currentVersion).id] = family.photoObject
            let phone = try await family.phone(server)
            defer { phone.done() }
            guard case .accepted = await phone.sync.sync(family.summary) else { Issue.record("not accepted"); return }
            let vault = phone.vault
            _ = try await vault.children(of: family.rootId)
            _ = try await vault.children(of: family.docs.id, in: family.workspaceId)
            server.moveSourceChangesAfterBegin = changed
            server.clearRequests()

            let moved = try? await vault.relocate(family.docs.id, to: family.personalRoot.id)
            #expect((moved != nil) == !changed)
            let made = try #require(server.sent("/api/drive/folders").first?["folders"] as? [[String: Any]])
            #expect(made.count == 1)
            let begin = try #require(server.allBegins.last)
            #expect((begin.body["moveOf"] as? [String: Any])?["nodeId"] as? String == family.photo.id)
            #expect(!server.requested("/api/drive/nodes/\(family.photo.id)/trash", method: "POST"))
            #expect(!server.writes.contains { $0.contains("/purge") || $0.contains("/empty") })
            if changed {
                #expect(server.node(family.photo.id)?.parentId == family.docs.id)
                #expect(server.node(family.docs.id)?.trashedAt == nil)
                #expect(!server.requested("/api/drive/nodes/\(family.docs.id)/trash", method: "POST"))
            } else {
                #expect(server.node(family.photo.id) == nil)
                #expect(server.node(family.docs.id)?.trashedAt != nil)
            }
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
