import Foundation
import HushOSCore
import Testing
@testable import HushOSKit

/*
 * The background queue's decisions for a family folder's upload (FamilyUploads), against the stub
 * server: finished from the stored record in a fresh process, sealed again under the new keys
 * when a key change refused the completion in flight, landed exactly once when its row won't
 * open, and its folder removed when it lands or is discarded. The app only sends the parts; the
 * tests send them the same way (each part file PUT to its address).
 */
extension OnFakeDrive {
    @Suite struct FamilyQueueTests {
        /*
         * A new version of Recipes.txt is sealed and its parts sent; then the app is gone. A fresh
         * process (its own vault and ledger, nothing of the family open) finishes it from the stored
         * record: the version goes live once, the name is signed again under the file's key with the
         * new size, nothing is aborted, and the record's folder is gone. Fails if finishing doesn't
         * open the family first (the replacement's name can't be written without the ledger).
         */
        @Test func aReplacementFinishesFromTheStoredRecordAfterABackgroundRelaunch() async throws {
            let family = try FamilyFixture()
            let server = family.server(chain: [family.r1, family.r2], pin: try family.pin(through: [family.r1, family.r2]))
            let first = try await family.phone(server)
            guard case .accepted = await first.sync.sync(family.summary) else { Issue.record("not accepted"); return }
            let recipes = try #require(try await first.vault.children(of: family.rootId).first { $0.id == family.fileId })
            let bytes = Data("Rye bread, the long way.".utf8)
            let directory = try queued(bytes)
            var upload = FamilyUpload(family: .init(groupId: family.groupId, workspaceId: family.workspaceId), folderId: family.rootId,
                                      name: "Recipes.txt", mime: "text/plain", replacingId: recipes.id, replacingVersionId: nil)
            guard case .send = await queue(first).seal(&upload, in: directory, thumbnail: nil) else { Issue.record("not sealed"); return }
            try await send(&upload, from: directory, with: first.vault)
            let stored = try JSONEncoder().encode(upload)
            first.done()

            let later = try await family.phone(server, records: first.records)
            defer { later.done() }
            var restored = try JSONDecoder().decode(FamilyUpload.self, from: stored)
            server.clearRequests()
            guard case .landed = await queue(later).finish(&restored, in: directory) else { Issue.record("not finished after the relaunch"); return }
            #expect(server.count("/api/drive/uploads/\(try #require(upload.sealed).uploadId)/complete", method: "POST") == 1)
            #expect(server.writes.filter { $0.hasSuffix("/abort") }.isEmpty)
            let renamed = try #require(server.sent("/api/drive/nodes/\(family.fileId)/metadata").first)
            let metadata = try metadataOpen(ctx: MetadataContext(workspaceId: family.workspaceId, nodeId: family.fileId, metadataVersion: 2), nodeKey: family.fileKey,
                                            envelope: try base64urlDecode(value: try #require(renamed["metadataEnvelope"] as? String)))
            #expect(metadata.size == UInt64(bytes.count))
            #expect(server.node(family.fileId)?.currentVersion != nil)
            #expect(!FileManager.default.fileExists(atPath: directory.path))
        }

        /*
         * The parts of an upload into Docs are in flight when the family folder's key is replaced
         * and the walk re-keys Docs. The completion is refused (409 conflicted): the upload is
         * aborted, its parts and addresses dropped with only the plaintext kept, and sealed again
         * under Docs' new key once the family is checked; no part of the old upload is sent after
         * the refusal, and the file lands under the walked key. Fails if the refusal fails the upload.
         */
        @Test func aKeyChangeLandingMidFlightSealsAgainUnderTheNewKeyAndSendsNoOldPart() async throws {
            let family = try FamilyFixture()
            let rotation = try FamilyRotation(family)
            let server = family.server(chain: [family.r1, family.r2], pin: try family.pin(through: [family.r1, family.r2]))
            server.put(family.docs)
            let phone = try await family.phone(server)
            defer { phone.done() }
            guard case .accepted = await phone.sync.sync(family.summary) else { Issue.record("not accepted"); return }
            _ = try await phone.vault.children(of: family.rootId)
            let bytes = Data((0 ..< 5000).map { UInt8($0 % 200) })
            let directory = try queued(bytes)
            var upload = FamilyUpload(family: .init(groupId: family.groupId, workspaceId: family.workspaceId), folderId: family.docs.id,
                                      name: "ledger.csv", mime: "text/csv", replacingId: nil, replacingVersionId: nil)
            let uploads = queue(phone)
            guard case .send = await uploads.seal(&upload, in: directory, thumbnail: nil) else { Issue.record("not sealed"); return }
            let old = try #require(upload.sealed).uploadId
            try await send(&upload, from: directory, with: phone.vault)

            // The key change lands while the parts are in flight: roster 3, the top folder re-keyed, the walk through Docs.
            server.serve(chain: [family.r1, family.r2, rotation.r3])
            server.areaVersion = 2
            server.areaGrant = (3, rosterDigest(statement: rotation.r3.statement), rotation.grant)
            server.put(rotation.root, rotation.docsWalked)
            guard case .reseal = await uploads.finish(&upload, in: directory) else { Issue.record("a refused completion wasn't sealed again"); return }
            #expect(server.requested("/api/drive/uploads/\(old)/abort", method: "POST"))
            #expect(upload.sealed == nil && upload.etags.isEmpty && upload.keyChangeSince != nil)
            #expect(try FileManager.default.contentsOfDirectory(atPath: directory.path) == ["content"])
            let sentBefore = server.putLog.filter { $0.uploadId == old }.count

            guard case .send = await uploads.seal(&upload, in: directory, thumbnail: nil) else { Issue.record("not sealed again"); return }
            let fresh = try #require(upload.sealed)
            #expect(fresh.uploadId != old)
            let node = try #require(server.allBegins.last?.body["node"] as? [String: Any])
            #expect((node["parentKeyEpoch"] as? NSNumber)?.uint64Value == 9)
            _ = try nodeOpen(ctx: NodeKeyContext(workspaceId: family.workspaceId, nodeId: fresh.nodeId, parentId: family.docs.id, parentKeyEpoch: 9,
                                                 keyEpoch: try #require((node["keyEpoch"] as? NSNumber)?.uint64Value)),
                             parentKey: rotation.docsWalkedKey, keyEnvelope: try base64urlDecode(value: try #require(node["keyEnvelope"] as? String)))
            try await send(&upload, from: directory, with: phone.vault)
            guard case .landed = await uploads.finish(&upload, in: directory) else { Issue.record("not landed"); return }
            #expect(server.putLog.filter { $0.uploadId == old }.count == sentBefore)
            #expect(server.node(fresh.nodeId)?.parentKeyEpoch == 9)
        }

        /*
         * The server completes the upload but its row won't open in the process finishing it (a
         * background launch): it has landed. Finished once, never aborted, never sealed or sent
         * again, and its folder removed. Fails if that is taken for a failure (the old path aborted
         * it and left a Retry that uploaded a duplicate).
         */
        @Test func aCompletedUploadWhoseRowWontOpenLandsExactlyOnce() async throws {
            let family = try FamilyFixture()
            let server = family.server(chain: [family.r1, family.r2], pin: try family.pin(through: [family.r1, family.r2]))
            let first = try await family.phone(server)
            guard case .accepted = await first.sync.sync(family.summary) else { Issue.record("not accepted"); return }
            _ = try await first.vault.children(of: family.rootId)
            let directory = try queued(Data("receipt".utf8))
            var upload = FamilyUpload(family: .init(groupId: family.groupId, workspaceId: family.workspaceId), folderId: family.rootId,
                                      name: "receipt.txt", mime: "text/plain", replacingId: nil, replacingVersionId: nil)
            guard case .send = await queue(first).seal(&upload, in: directory, thumbnail: nil) else { Issue.record("not sealed"); return }
            try await send(&upload, from: directory, with: first.vault)
            first.done()

            server.corruptCompletedNode = true
            let later = try await family.phone(server, records: first.records)
            defer { later.done() }
            server.clearRequests()
            guard case .landed = await queue(later).finish(&upload, in: directory) else { Issue.record("a landed upload wasn't taken as landed"); return }
            let id = try #require(upload.sealed).uploadId
            #expect(server.count("/api/drive/uploads/\(id)/complete", method: "POST") == 1)
            #expect(!server.requested("/api/drive/uploads/\(id)/abort", method: "POST"))
            #expect(!server.requested("/api/drive/uploads", method: "POST"))
            #expect(server.allBegins.count == 1)
            #expect(!FileManager.default.fileExists(atPath: directory.path))
        }

        /*
         * The plaintext and the sealed parts live only in the record's folder, in the queue's own
         * folder (`Unbacked.transfers`), which is out of backups; a discarded (cancelled) upload is
         * aborted and its folder removed. Sign-out and another account's sign-in remove the whole
         * queue (AccountStoreTests). Fails if discarding leaves the plaintext or the server's half.
         * The protection class (`Unbacked.protection`) is not asserted: the simulator has no data
         * protection, and `attributesOfItem` answers no `.protectionKey` there.
         */
        @Test func aDiscardedUploadIsAbortedAndItsPlaintextRemoved() async throws {
            let family = try FamilyFixture()
            let server = family.server(chain: [family.r1, family.r2], pin: try family.pin(through: [family.r1, family.r2]))
            let phone = try await family.phone(server)
            defer { phone.done() }
            guard case .accepted = await phone.sync.sync(family.summary) else { Issue.record("not accepted"); return }
            _ = try await phone.vault.children(of: family.rootId)
            let directory = try queued(Data(repeating: 1, count: 3000))
            #expect(try directory.deletingLastPathComponent().resourceValues(forKeys: [.isExcludedFromBackupKey]).isExcludedFromBackup == true)
            var upload = FamilyUpload(family: .init(groupId: family.groupId, workspaceId: family.workspaceId), folderId: family.rootId,
                                      name: "scan.pdf", mime: "application/pdf", replacingId: nil, replacingVersionId: nil)
            guard case .send = await queue(phone).seal(&upload, in: directory, thumbnail: nil) else { Issue.record("not sealed"); return }
            let names = Set(try FileManager.default.contentsOfDirectory(atPath: directory.path))
            #expect(names == Set(["content"] + (1 ... (upload.sealed?.partCount ?? 0)).map { "part-\($0)" }))

            await queue(phone).discard(upload, in: directory)
            #expect(server.requested("/api/drive/uploads/\(try #require(upload.sealed).uploadId)/abort", method: "POST"))
            #expect(!FileManager.default.fileExists(atPath: directory.path))
        }

        /*
         * A new version of Recipes.txt goes live, then re-signing its name record is refused (409
         * `stale`, a key change's walk reaching the file in between). It has landed: never aborted,
         * sealed or sent again, its plaintext gone, and the record kept (`published`) until the name is
         * repaired: the next pass signs it again with the new size, and it lands once. Fails if the
         * refusal after the completion is taken for a refusal in flight (the old path aborted a
         * finished upload, sealed it again, and failed it for good on the version that moved).
         */
        @Test func aReplacementWhoseNameIsRefusedAfterItWentLiveLandsAndItsNameIsRepaired() async throws {
            let family = try FamilyFixture()
            let server = family.server(chain: [family.r1, family.r2], pin: try family.pin(through: [family.r1, family.r2]))
            let phone = try await family.phone(server)
            defer { phone.done() }
            guard case .accepted = await phone.sync.sync(family.summary) else { Issue.record("not accepted"); return }
            let recipes = try #require(try await phone.vault.children(of: family.rootId).first { $0.id == family.fileId })
            let bytes = Data("Rye bread, the long way, with a second rise.".utf8)
            let directory = try queued(bytes)
            var upload = FamilyUpload(family: .init(groupId: family.groupId, workspaceId: family.workspaceId), folderId: family.rootId,
                                      name: "Recipes.txt", mime: "text/plain", replacingId: recipes.id, replacingVersionId: recipes.node.currentVersion?.id)
            let uploads = queue(phone)
            guard case .send = await uploads.seal(&upload, in: directory, thumbnail: nil) else { Issue.record("not sealed"); return }
            try await send(&upload, from: directory, with: phone.vault)
            let sealed = try #require(upload.sealed)

            server.metadataAnswers = [(409, ["code": "stale", "message": "This item changed since you last saw it. Refresh and try again."])]
            guard case .retry = await uploads.finish(&upload, in: directory) else { Issue.record("a version that went live wasn't kept to repair its name"); return }
            #expect(upload.published != nil && upload.sealed == sealed)
            #expect(server.node(family.fileId)?.currentVersion?.id == server.allBegins.last?.body["versionId"] as? String)
            #expect(!FileManager.default.fileExists(atPath: directory.path))

            guard case .landed = await uploads.finish(&upload, in: directory) else { Issue.record("the name wasn't repaired"); return }
            #expect(server.count("/api/drive/uploads/\(sealed.uploadId)/complete", method: "POST") == 1)
            #expect(!server.requested("/api/drive/uploads/\(sealed.uploadId)/abort", method: "POST"))
            #expect(server.allBegins.count == 1)
            let renamed = try #require(server.sent("/api/drive/nodes/\(family.fileId)/metadata").last)
            let metadata = try metadataOpen(ctx: MetadataContext(workspaceId: family.workspaceId, nodeId: family.fileId,
                                                                 metadataVersion: try #require(server.node(family.fileId)?.metadataVersion)),
                                            nodeKey: family.fileKey, envelope: try base64urlDecode(value: try #require(renamed["metadataEnvelope"] as? String)))
            #expect(metadata.size == UInt64(bytes.count))
        }

        /*
         * A group manager paused this member's writes: the server answers 403 `forbidden`. The begin
         * and the completion each fail with the server's words, at once, never retried (an expired
         * part address shares the status, without a code); the plaintext stays for Retry. Fails if
         * the API's 403 is taken for an expired address (the upload retried every 30 s for ever).
         */
        @Test func aPausedMembersUploadFailsWithTheServersWordsAndIsNotRetried() async throws {
            let family = try FamilyFixture()
            let server = family.server(chain: [family.r1, family.r2], pin: try family.pin(through: [family.r1, family.r2]))
            let phone = try await family.phone(server)
            defer { phone.done() }
            guard case .accepted = await phone.sync.sync(family.summary) else { Issue.record("not accepted"); return }
            _ = try await phone.vault.children(of: family.rootId)
            let directory = try queued(Data("minutes".utf8))
            var upload = FamilyUpload(family: .init(groupId: family.groupId, workspaceId: family.workspaceId), folderId: family.rootId,
                                      name: "minutes.txt", mime: "text/plain", replacingId: nil, replacingVersionId: nil)
            let uploads = queue(phone)
            let held: (Int, [String: Any]) = (403, ["code": "forbidden", "message": "A group manager has paused changes to this folder."])

            server.beginAnswers = [held]
            guard case .failed(let refused) = await uploads.seal(&upload, in: directory, thumbnail: nil) else { Issue.record("a held begin wasn't a failure"); return }
            #expect(!Resumable.retryable(refused))
            #expect((refused as? LocalizedError)?.errorDescription == "A group manager has paused changes to this folder.")
            #expect(FileManager.default.fileExists(atPath: FamilyUpload.content(in: directory).path))

            guard case .send = await uploads.seal(&upload, in: directory, thumbnail: nil) else { Issue.record("not sealed"); return }
            try await send(&upload, from: directory, with: phone.vault)
            server.completeAnswers = [held]
            guard case .failed(let finished) = await uploads.finish(&upload, in: directory) else { Issue.record("a held completion wasn't a failure"); return }
            #expect(!Resumable.retryable(finished))
            #expect(server.allBegins.count == 1)
            #expect(FileManager.default.fileExists(atPath: FamilyUpload.content(in: directory).path))
        }

        /*
         * Completions refused for reasons a key change isn't: a plain 409 `conflict` (the upload was
         * cancelled) and a 404 (it no longer exists) fail, with nothing sealed or begun again. Fails if
         * any 409 or a 404 is taken for a refusal in flight (a cancelled upload would come back).
         */
        @Test func aPlainConflictOrAMissingUploadFailsWithoutSealingAgain() async throws {
            let family = try FamilyFixture()
            let server = family.server(chain: [family.r1, family.r2], pin: try family.pin(through: [family.r1, family.r2]))
            let phone = try await family.phone(server)
            defer { phone.done() }
            guard case .accepted = await phone.sync.sync(family.summary) else { Issue.record("not accepted"); return }
            _ = try await phone.vault.children(of: family.rootId)
            let uploads = queue(phone)
            for answer: (Int, [String: Any]) in [(409, ["code": "conflict", "message": "This upload was cancelled."]),
                                                 (404, ["code": "not-found", "message": "This upload no longer exists."])] {
                let directory = try queued(Data("receipt \(answer.0)".utf8))
                var upload = FamilyUpload(family: .init(groupId: family.groupId, workspaceId: family.workspaceId), folderId: family.rootId,
                                          name: "receipt-\(answer.0).txt", mime: "text/plain", replacingId: nil, replacingVersionId: nil)
                guard case .send = await uploads.seal(&upload, in: directory, thumbnail: nil) else { Issue.record("not sealed"); return }
                try await send(&upload, from: directory, with: phone.vault)
                let begun = server.allBegins.count
                server.completeAnswers = [answer]
                guard case .failed = await uploads.finish(&upload, in: directory) else { Issue.record("a \(answer.0) wasn't a failure"); return }
                #expect(upload.sealed != nil && upload.keyChangeSince == nil)
                #expect(server.allBegins.count == begun)
            }
        }

        /*
         * The app is killed after the server completed an upload but before the queue saved it: the
         * relaunch completes it again from the record it had. The server answers `completed` with the
         * node as it is; the upload lands, once, with one node and one begin. Fails if a second
         * completion is taken for anything but landed (a duplicate, or a failure on a file that's up).
         */
        @Test func completingTwiceLandsOnce() async throws {
            let family = try FamilyFixture()
            let server = family.server(chain: [family.r1, family.r2], pin: try family.pin(through: [family.r1, family.r2]))
            let phone = try await family.phone(server)
            defer { phone.done() }
            guard case .accepted = await phone.sync.sync(family.summary) else { Issue.record("not accepted"); return }
            _ = try await phone.vault.children(of: family.rootId)
            let directory = try queued(Data("boarding pass".utf8))
            var upload = FamilyUpload(family: .init(groupId: family.groupId, workspaceId: family.workspaceId), folderId: family.rootId,
                                      name: "boarding.txt", mime: "text/plain", replacingId: nil, replacingVersionId: nil)
            let uploads = queue(phone)
            guard case .send = await uploads.seal(&upload, in: directory, thumbnail: nil) else { Issue.record("not sealed"); return }
            try await send(&upload, from: directory, with: phone.vault)
            var unsaved = upload
            guard case .landed = await uploads.finish(&upload, in: directory) else { Issue.record("not landed"); return }
            guard case .landed = await uploads.finish(&unsaved, in: directory) else { Issue.record("a second completion wasn't landed"); return }
            let sealed = try #require(upload.sealed)
            #expect(server.count("/api/drive/uploads/\(sealed.uploadId)/complete", method: "POST") == 2)
            #expect(!server.requested("/api/drive/uploads/\(sealed.uploadId)/abort", method: "POST"))
            #expect(server.allBegins.count == 1)
            #expect(server.node(sealed.nodeId)?.currentVersion != nil)
        }

        /*
         * This person was removed from the family while an upload waited: the background launch that
         * seals it finds them not in it (not-member), and the upload fails with its folder, plaintext
         * included, removed at once. (A process that already had the family open learns it from its
         * next sync, and the app ends the family's uploads then.) Fails if the plaintext of a family
         * one no longer belongs to stays on the phone for a Retry.
         */
        @Test func anUploadIntoAFamilyThePersonLeftFailsAndItsPlaintextGoes() async throws {
            let family = try FamilyFixture()
            let server = family.server(chain: [family.r1, family.r2], pin: try family.pin(through: [family.r1, family.r2]))
            let first = try await family.phone(server)
            guard case .accepted = await first.sync.sync(family.summary) else { Issue.record("not accepted"); return }
            first.done()
            let later = try await family.phone(server, records: first.records)
            defer { later.done() }
            let directory = try queued(Data("letter".utf8))
            var upload = FamilyUpload(family: .init(groupId: family.groupId, workspaceId: family.workspaceId), folderId: family.rootId,
                                      name: "letter.txt", mime: "text/plain", replacingId: nil, replacingVersionId: nil)
            server.notMember = true
            guard case .failed(let error) = await queue(later).seal(&upload, in: directory, thumbnail: nil) else { Issue.record("not failed"); return }
            #expect((error as? LocalizedError)?.errorDescription == "You’re not in this family any more.")
            #expect(!FileManager.default.fileExists(atPath: directory.path))
            #expect(server.allBegins.isEmpty)
        }

        /*
         * A new version of Recipes.txt is completed but the answer is lost (or the app died before it
         * saved), so the queue completes again later. In between, another member renamed the file, or
         * put a newer version on it. The repeat is answered `completed` with the node as it is now: the
         * upload has landed, and nothing is re-signed, so their name record and their version stay as
         * they are. Fails if the repeat re-signs the name from the sealed name (their rename overwritten,
         * or their version given this upload's size).
         */
        @Test func aRepeatedCompletionNeverOverwritesAnotherMembersRenameOrNewerVersion() async throws {
            for change in ["rename", "version"] {
                let family = try FamilyFixture()
                let server = family.server(chain: [family.r1, family.r2], pin: try family.pin(through: [family.r1, family.r2]))
                let phone = try await family.phone(server)
                defer { phone.done() }
                guard case .accepted = await phone.sync.sync(family.summary) else { Issue.record("not accepted"); return }
                let recipes = try #require(try await phone.vault.children(of: family.rootId).first { $0.id == family.fileId })
                let directory = try queued(Data("Rye bread, the long way, \(change).".utf8))
                var upload = FamilyUpload(family: .init(groupId: family.groupId, workspaceId: family.workspaceId), folderId: family.rootId,
                                          name: "Recipes.txt", mime: "text/plain", replacingId: recipes.id, replacingVersionId: recipes.node.currentVersion?.id)
                let uploads = queue(phone)
                guard case .send = await uploads.seal(&upload, in: directory, thumbnail: nil) else { Issue.record("not sealed"); return }
                try await send(&upload, from: directory, with: phone.vault)
                let sealed = try #require(upload.sealed)

                server.loseCompletions = 1
                guard case .retry = await uploads.finish(&upload, in: directory) else { Issue.record("a lost answer wasn't looked at again"); return }
                let landed = try #require(server.node(family.fileId))
                #expect(landed.currentVersion?.id == sealed.landing?.versionId)
                let theirs: NodeView
                if change == "rename" {
                    let envelope = try metadataSeal(ctx: MetadataContext(workspaceId: family.workspaceId, nodeId: family.fileId, metadataVersion: landed.metadataVersion + 1),
                                                    nodeKey: family.fileKey, metadata: NodeMetadata(name: "Recipes (Ana).txt", mime: "text/plain", size: 3, modified: nil, attributes: [:]))
                    theirs = landed.with(metadataVersion: landed.metadataVersion + 1, metadataEnvelope: base64urlEncode(bytes: envelope))
                } else {
                    let ours = try #require(landed.currentVersion)
                    theirs = landed.with(version: VersionView(id: UUID().uuidString.lowercased(), objectId: UUID().uuidString.lowercased(),
                                                              contentKeyEnvelope: ours.contentKeyEnvelope, status: "ready", contentSuite: ours.contentSuite,
                                                              chunkCount: ours.chunkCount, contentNonce: ours.contentNonce, plaintextSize: nil,
                                                              ciphertextSize: ours.ciphertextSize, readyAt: "2026-10-19T10:05:00.000Z"))
                }
                server.put(theirs)

                guard case .landed = await uploads.finish(&upload, in: directory) else { Issue.record("the repeat (\(change)) wasn't landed"); return }
                #expect(server.sent("/api/drive/nodes/\(family.fileId)/metadata").isEmpty, "\(change): the name record was re-signed")
                #expect(server.node(family.fileId)?.metadataEnvelope == theirs.metadataEnvelope)
                #expect(server.node(family.fileId)?.metadataVersion == theirs.metadataVersion)
                #expect(server.node(family.fileId)?.currentVersion?.id == theirs.currentVersion?.id)
                #expect(server.count("/api/drive/uploads/\(sealed.uploadId)/complete", method: "POST") == 2)
                #expect(!server.requested("/api/drive/uploads/\(sealed.uploadId)/abort", method: "POST"))
                #expect(server.allBegins.count == 1)
            }
        }

        private func queue(_ phone: FamilyFixture.Phone) -> FamilyUploads {
            FamilyUploads(vault: phone.vault, families: phone.sync, pause: { _ in })
        }

        /* A queued record's folder, as the app makes it: in the queue's own folder, out of backups, the plaintext given the folder's class. */
        private func queued(_ bytes: Data) throws -> URL {
            let queue = Unbacked.folder(Unbacked.transfers)
            let directory = queue.appendingPathComponent(UUID().uuidString, isDirectory: true)
            try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
            let content = FamilyUpload.content(in: directory)
            try bytes.write(to: content)
            Unbacked.protectFile(content)
            return directory
        }

        /* What the background session does: each sealed part PUT to its address, its ETag kept. */
        private func send(_ upload: inout FamilyUpload, from directory: URL, with vault: Vault) async throws {
            let sealed = try #require(upload.sealed)
            for part in 1 ... sealed.partCount {
                let url = try #require(sealed.urls[part].flatMap(URL.init(string:)))
                upload.etags[part] = try await vault.api.putPart(url, data: try Data(contentsOf: directory.appendingPathComponent("part-\(part)")))
            }
        }
    }
}
