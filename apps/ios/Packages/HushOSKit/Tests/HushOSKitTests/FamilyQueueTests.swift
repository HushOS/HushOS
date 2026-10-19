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
         * The plaintext and the sealed parts live only in the record's folder, which is out of
         * backups under the queue's protection class; a discarded (cancelled) upload is aborted and
         * its folder removed. Sign-out and another account's sign-in remove the whole queue
         * (AccountStoreTests). Fails if discarding leaves the plaintext or the server's half.
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

        private func queue(_ phone: FamilyFixture.Phone) -> FamilyUploads {
            FamilyUploads(vault: phone.vault, families: phone.sync, pause: { _ in })
        }

        /* A queued record's folder, as the app makes it: in a queue folder out of backups, the plaintext given the folder's class. */
        private func queued(_ bytes: Data) throws -> URL {
            let queue = Unbacked.folder(FileManager.default.temporaryDirectory.appendingPathComponent("family-queue-\(UUID().uuidString)", isDirectory: true))
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
