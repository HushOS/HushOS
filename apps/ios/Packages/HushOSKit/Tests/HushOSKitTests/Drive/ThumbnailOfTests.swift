import Foundation
import HushOSCore
import Testing
@testable import HushOSKit

/*
 * A row's thumbnail from the row a list holds (`Vault.thumbnail(of:)`), against the family stub:
 * a row a batch just forgot still shows its thumbnail without its folder being listed again, and
 * a row whose keys this phone dropped (a family it is no longer in) shows none. Each fails on its
 * defect: a lookup by id lists the folder; a key the wipe left behind would open what it was
 * meant to close.
 */
extension OnFakeDrive {
    @Suite struct ThumbnailOfTests {
        /* A photo with a sealed thumbnail trailer under the family's top folder, its object in the stub's store. */
        static func photo(_ family: FamilyFixture, _ server: FamilyServer, thumbnail: Data) throws -> String {
            let key = try randomBytes(length: 32)
            let id = try newId(kind: .node, scopeId: family.workspaceId).id
            let bare = try FamilyFixture.node(id: id, in: family.workspaceId, parent: family.rootId, parentKey: family.rootKey, key: key, kind: .file,
                                              name: "Dunes.jpg", writer: family.creator, keyEpoch: 4)
            let bytes = Data((0 ..< 2000).map { UInt8($0 % 241) })
            let versionId = try newId(kind: .version, scopeId: family.workspaceId).id
            let objectId = try newId(kind: .object, scopeId: family.workspaceId).id
            let contentKey = try randomBytes(length: 32)
            let nonce = try randomBytes(length: 16)
            let suite = HushOSCore.contentSuite()
            let size = UInt64(bytes.count)
            let thumbnailBytes = UInt32(thumbnail.count)
            let content = Content(workspaceId: family.workspaceId, objectId: objectId, suite: suite, key: contentKey, nonce: nonce,
                                  plaintextSize: size, thumbnailBytes: thumbnailBytes)
            let layout = try contentLayout(suite: suite, plaintextSize: size, thumbnailBytes: thumbnailBytes)
            var object = Data()
            var at = 0
            for index in 0 ..< layout.chunkCount {
                let length = Int(chunkLength(plaintextSize: size, index: index))
                object.append(try chunkEncrypt(content: content, index: index, plaintext: bytes.subdata(in: at ..< at + length)))
                at += length
            }
            // As an upload seals it: the trailer after the last chunk.
            object.append(try thumbnailEncrypt(content: content, thumbnail: thumbnail))
            let context = VersionContext(workspaceId: family.workspaceId, nodeId: id, versionId: versionId, objectId: objectId)
            let sealed = try versionSeal(ctx: context, nodeKey: key, contentKey: contentKey, plaintextSize: size, thumbnailBytes: thumbnailBytes)
            let signature = try versionSign(signingSeed: family.creator.keys.signingSeed,
                                            statement: VersionStatement(workspaceId: family.workspaceId, nodeId: id, versionId: versionId, objectId: objectId,
                                                                        contentSuite: suite),
                                            contentKeyEnvelope: sealed.envelope)
            var version = VersionView(id: versionId, objectId: objectId, contentKeyEnvelope: base64urlEncode(bytes: sealed.envelope), status: "ready",
                                      contentSuite: suite, chunkCount: Int(layout.chunkCount), contentNonce: base64urlEncode(bytes: nonce), plaintextSize: nil,
                                      ciphertextSize: String(object.count), readyAt: "2026-10-18T10:00:00.000Z")
            version.signer = Signer(id: family.creator.userId)
            version.signature = base64urlEncode(bytes: signature)
            server.put(bare.with(version: version))
            server.objects[versionId] = object
            return id
        }

        /*
         * A batch forgets each row once the lists drop it; a row still on screen for a moment asks
         * for its thumbnail with the row the list holds. Fails if that looks the row up again (the
         * folder is listed once more, as it was a row at a time after the first 200 of a batch).
         */
        @Test func aRowABatchForgotStillShowsItsThumbnailWithoutListingItsFolder() async throws {
            let family = try FamilyFixture()
            let server = family.server(chain: [family.r1, family.r2], pin: try family.pin(through: [family.r1, family.r2]))
            let thumbnail = Data((0 ..< 600).map { UInt8($0 % 199) })
            let id = try Self.photo(family, server, thumbnail: thumbnail)
            let phone = try await family.phone(server)
            defer { phone.done() }
            guard case .accepted = await phone.sync.sync(family.summary) else { Issue.record("not accepted"); return }
            let vault = phone.vault
            _ = try await vault.children(of: family.rootId)
            let row = try #require(await vault.item(id))
            #expect(row.hasThumbnail)
            await vault.forget([id])
            server.clearRequests()

            #expect(try await vault.thumbnail(of: row) == thumbnail)
            #expect(server.count("/api/drive/nodes/\(family.rootId)/children") == 0)
        }

        /*
         * The family is gone from this phone (not a member any more: its keys were dropped), but a
         * list still holds a row of it. Fails if its thumbnail opens anyway: the row is the list's,
         * but the key must be the vault's, and the wipe dropped it.
         */
        @Test func aRowOfAFamilyThisPhoneDroppedHasNoThumbnail() async throws {
            let family = try FamilyFixture()
            let server = family.server(chain: [family.r1, family.r2], pin: try family.pin(through: [family.r1, family.r2]))
            let id = try Self.photo(family, server, thumbnail: Data(repeating: 9, count: 400))
            let phone = try await family.phone(server)
            defer { phone.done() }
            guard case .accepted = await phone.sync.sync(family.summary) else { Issue.record("not accepted"); return }
            let vault = phone.vault
            _ = try await vault.children(of: family.rootId)
            let row = try #require(await vault.item(id))
            #expect(try await vault.thumbnail(of: row) != nil)

            _ = await vault.forgetWorkspaces([family.workspaceId])
            await #expect(throws: (any Error).self) { _ = try await vault.thumbnail(of: row) }
        }
    }
}
