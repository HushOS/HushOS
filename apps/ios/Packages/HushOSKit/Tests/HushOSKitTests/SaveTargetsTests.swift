import Foundation
import HushOSCore
import Testing
@testable import HushOSKit

/*
 * Save to HushOS into a family folder (SaveTargets, Android's SaveTargets), against the stub server: Maya is in the
 * Lindqvist family and shares a file from another app. What is offered, what is opened and what is sealed are what these
 * tests check: the folder, and the family and workspace the queue's family upload is sealed in.
 */
extension OnFakeDrive {
    @Suite struct SaveTargetsTests {
        /* The sheet over `phone`, with `signedIn` the keychain's session (the phone's own, as FamilyFixture.phone makes it, by default). */
        private func sheet(_ phone: FamilyFixture.Phone, _ family: FamilyFixture, signedIn: SharedKeychain.Session? = nil) -> SaveTargets {
            let session = signedIn ?? SharedKeychain.Session(origin: "https://family.test", token: "t", userId: family.member.userId)
            return SaveTargets(vault: phone.vault, families: phone.sync, signedIn: { session })
        }

        private func shared(_ bytes: Data = Data("receipt".utf8)) throws -> URL {
            let directory = Unbacked.folder(Unbacked.transfers).appendingPathComponent(UUID().uuidString, isDirectory: true)
            try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
            try bytes.write(to: FamilyUpload.content(in: directory))
            return directory
        }

        /*
         * The family Maya is in is offered by its name, with its folder in the family folder's own workspace, and a file is
         * sealed into it as the family's upload, its plaintext kept for the queue. Fails if a family folder is offered
         * without its family (it would be sealed under the personal keys) or under another workspace than the folder's.
         */
        @Test func aFamilyFolderIsOfferedAndSealedAsItsFamilysUpload() async throws {
            let family = try FamilyFixture()
            let server = family.server(chain: [family.r1, family.r2], pin: try family.pin(through: [family.r1, family.r2]))
            let phone = try await family.phone(server)
            defer { phone.done() }
            let targets = sheet(phone, family)
            let offered = try await targets.listFamilies()
            #expect(offered.map(\.name) == ["Lindqvist family"])
            let folder = try #require(offered.first?.folders.first)
            #expect(folder.id == family.rootId)
            #expect(folder.family == FamilyUpload.Family(groupId: family.groupId, workspaceId: family.workspaceId.lowercased()))
            let directory = try shared()
            var upload = FamilyUpload(family: try #require(folder.family), folderId: folder.id, name: "receipt.txt", mime: "text/plain",
                                      replacingId: nil, replacingVersionId: nil)
            try await targets.sealFamily(&upload, in: directory, thumbnail: nil)
            let sealed = try #require(upload.sealed)
            #expect(sealed.family == true, "begun as the family's, under its ledger's keys")
            #expect(sealed.workspaceId.lowercased() == family.workspaceId.lowercased())
            #expect(sealed.parentId == family.rootId)
            #expect(FileManager.default.fileExists(atPath: FamilyUpload.content(in: directory).path), "the plaintext the queue seals again from")
        }

        /*
         * Maya is removed from the family after the sheet listed it. Opening the folder to save checks the family again and
         * stops in its words, nothing sealed, and the family is no longer offered. Fails if a removed family's folder is
         * still saved into, or still offered.
         */
        @Test func aFamilyRemovedMidSheetIsNeitherSealedIntoNorOffered() async throws {
            let family = try FamilyFixture()
            let server = family.server(chain: [family.r1, family.r2], pin: try family.pin(through: [family.r1, family.r2]))
            let phone = try await family.phone(server)
            defer { phone.done() }
            let targets = sheet(phone, family)
            let folder = try #require(try await targets.listFamilies().first?.folders.first)
            server.notMember = true
            await #expect(throws: (any Error).self) { _ = try await targets.open(folder) }
            do { _ = try await targets.open(folder) } catch { #expect(SaveTargets.notInFamily(error)) }
            server.clearRequests()
            var upload = FamilyUpload(family: try #require(folder.family), folderId: folder.id, name: "receipt.txt", mime: "text/plain",
                                      replacingId: nil, replacingVersionId: nil)
            await #expect(throws: (any Error).self) { try await targets.sealFamily(&upload, in: try shared(), thumbnail: nil) }
            #expect(upload.sealed == nil)
            #expect(server.writes.filter { $0.contains("/uploads") }.isEmpty, "nothing begun on the server")
            #expect(try await targets.listFamilies().isEmpty)
        }

        /*
         * Route 2 stops listing the family after the sheet listed it (its removal reached the list first): the folder isn't
         * opened to save into. Fails if a family the server no longer lists is still saved into.
         */
        @Test func aFamilyNoLongerListedIsNotOpened() async throws {
            let family = try FamilyFixture()
            let server = family.server(chain: [family.r1, family.r2], pin: try family.pin(through: [family.r1, family.r2]))
            let phone = try await family.phone(server)
            defer { phone.done() }
            let targets = sheet(phone, family)
            let folder = try #require(try await targets.listFamilies().first?.folders.first)
            server.listed = false
            do {
                _ = try await targets.open(folder)
                Issue.record("opened a family the server no longer lists")
            } catch {
                #expect(SaveTargets.notInFamily(error))
            }
        }

        /*
         * Another account signs in while the sheet is open. Nothing is listed, opened or sealed under the session the sheet
         * began in, in either drive. Fails if a sheet saves the last account's file into its folders under the next one.
         */
        @Test func anAccountSwitchedMidSheetSealsNothing() async throws {
            let family = try FamilyFixture()
            let server = family.server(chain: [family.r1, family.r2], pin: try family.pin(through: [family.r1, family.r2]))
            let phone = try await family.phone(server)
            defer { phone.done() }
            let folder = try #require(try await sheet(phone, family).listFamilies().first?.folders.first)
            let switched = sheet(phone, family, signedIn: SharedKeychain.Session(origin: "https://family.test", token: "other", userId: "0f0f0f0f-0f0f-4f0f-8f0f-0f0f0f0f0f0f"))
            #expect(!switched.stands())
            await #expect(throws: SaveTargets.SessionEnded.self) { _ = try await switched.listFamilies() }
            await #expect(throws: SaveTargets.SessionEnded.self) { _ = try await switched.open(folder) }
            var upload = FamilyUpload(family: try #require(folder.family), folderId: folder.id, name: "receipt.txt", mime: "text/plain",
                                      replacingId: nil, replacingVersionId: nil)
            server.clearRequests()
            await #expect(throws: SaveTargets.SessionEnded.self) { try await switched.sealFamily(&upload, in: try shared(), thumbnail: nil) }
            #expect(upload.sealed == nil)
            #expect(server.writes.isEmpty)
        }

        /*
         * A Save to HushOS note keeps its family (the app adopts it as the queue's family upload), and one from before
         * family folders reads as your own drive's. The last folder is kept with its family, and only whole. Fails if a
         * family folder's note or last folder comes back as one of your own drive.
         */
        @Test func notesAndTheLastFolderKeepTheirFamily() throws {
            let sealed = try JSONDecoder().decode(Vault.SealedUpload.self, from: Data("""
            {"uploadId":"u","workspaceId":"w","nodeId":"n","parentId":"p","partCount":1,"replacing":false,"name":"a.txt","urls":{"1":"https://example.test/1"}}
            """.utf8))
            let family = FamilyUpload.Family(groupId: "g", workspaceId: "w")
            let note = ShareHandoff(id: UUID(), name: "a.txt", folderId: "p", mime: nil, size: 1, sealed: sealed,
                                    owner: AccountOwner(SharedKeychain.Session(origin: "https://family.test", token: "t", userId: "u")), family: family)
            #expect(try JSONDecoder().decode(ShareHandoff.self, from: try JSONEncoder().encode(note)).family == family)
            var older = try #require(try JSONSerialization.jsonObject(with: try JSONEncoder().encode(note)) as? [String: Any])
            older.removeValue(forKey: "family")
            #expect(try JSONDecoder().decode(ShareHandoff.self, from: try JSONSerialization.data(withJSONObject: older)).family == nil)
            #expect(Places.Folder(id: "f", name: "Photos", groupId: "g", workspaceId: "w").whole)
            #expect(!Places.Folder(id: "f", name: "Photos", groupId: "g", workspaceId: nil).whole)
            #expect(Places.Folder(id: "f", name: "Files").family == nil)
        }
    }
}
