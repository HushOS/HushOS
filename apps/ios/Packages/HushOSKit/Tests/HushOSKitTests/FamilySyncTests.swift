import CryptoKit
import Foundation
import HushOSCore
import Testing
@testable import HushOSKit

/*
 * A family synced on the phone against a stub of the group routes, with real member lists the
 * core signs and accepts (docs/groups-mobile-plan.md, iOS 1): a served chain short of the device
 * record is refused, a fork shows the warning and leaves nothing open, a not-member answer wipes
 * what the phone kept but keeps the settings pin, and a late acceptance never writes an older
 * record over a newer one. Each fails if its guard in FamilySync or FamilyRecords is removed.
 */
extension OnFakeDrive {
    @Suite struct FamilySyncTests {
        @Test func aMembersFolderOpensAndItsCreatorsFileIsVerifiedByTheFamily() async throws {
            let family = try FamilyFixture()
            let server = family.server(chain: [family.r1, family.r2], pin: try family.pin(through: [family.r1, family.r2]))
            let phone = try await family.phone(server)
            defer { phone.done() }

            guard case .accepted(let view) = await phone.sync.sync(family.summary) else { Issue.record("not accepted"); return }
            #expect(view.rosterVersion == 2)
            #expect(view.members.map(\.userId).sorted() == [family.creator.userId, family.member.userId].sorted())
            let area = try #require(view.areas.first)
            #expect(area.name == "Photos" && area.openable && area.write == .writable)
            #expect(phone.records.read(userId: family.member.userId, groupId: family.groupId)?.rosterVersion == 2)

            let children = try await phone.vault.children(of: family.rootId)
            #expect(children.map(\.name) == ["Recipes.txt"])
            let verdict = await phone.sync.verdict(of: try #require(children.first).node, groupId: family.groupId)
            // The member never compared the creator's words: the family's member list vouches for them.
            #expect(verdict.mark == nil)
            #expect(verdict.verifiedBy == "Verified by Lindqvist family")
        }

        /*
         * The record is at roster 3 and the settings pin only at 2 (an older save from another
         * device). The server serves roster 2 as the head again: from version 1 the record's own
         * pin must still be a mark, so it is a rollback, and nothing opens.
         */
        @Test func aChainShortOfTheDeviceRecordIsRefusedAndTheFamilyCouldntBeChecked() async throws {
            let family = try FamilyFixture()
            let server = family.server(chain: [family.r1, family.r2, family.r3], pin: try family.pin(through: [family.r1, family.r2]))
            let first = try await family.phone(server)
            guard case .accepted = await first.sync.sync(family.summary) else { Issue.record("not accepted"); return }
            #expect(first.records.read(userId: family.member.userId, groupId: family.groupId)?.rosterVersion == 3)
            first.done()

            // Later, a fresh start of the app: the settings pin is back at roster 2, and the server serves only that far.
            try server.storeSettings(pin: try family.pin(through: [family.r1, family.r2]))
            server.serve(chain: [family.r1, family.r2], ignoringAfter: true)
            server.clearRequests()
            let later = try await family.phone(server, records: first.records)
            defer { later.done() }
            guard case .failed = await later.sync.sync(family.summary) else { Issue.record("a rollback below the record was accepted"); return }
            #expect(!server.requested("/api/drive/spaces"))
            #expect(!later.vault.areaLedger.isArea(workspaceId: family.workspaceId))
            #expect(later.records.read(userId: family.member.userId, groupId: family.groupId)?.rosterVersion == 3)
        }

        /*
         * The server replays older settings (a rollback) after the family was accepted: the sync is
         * refused before the core is asked, and the core stops opening the family too, so neither a
         * listing nor a queued upload goes through the chain the earlier sync committed. Fails if a
         * refusal only clears the app's own rows.
         */
        @Test func aSettingsRollbackStopsTheCoreOpeningTheFamily() async throws {
            let family = try FamilyFixture()
            let server = family.server(chain: [family.r1, family.r2], pin: try family.pin(through: [family.r1, family.r2]))
            let phone = try await family.phone(server)
            defer { phone.done() }
            guard case .accepted = await phone.sync.sync(family.summary) else { Issue.record("not accepted"); return }
            #expect(try await phone.vault.children(of: family.rootId).map(\.name) == ["Recipes.txt"])
            // Another device saves; this phone reads it, then the server serves the copy from before.
            let older = server.settingsSnapshot()
            try server.editSettings { _ in }
            guard case .accepted = await phone.sync.sync(family.summary) else { Issue.record("the newer settings weren't read"); return }
            older()
            guard case .failed(let words) = await phone.sync.sync(family.summary), words != FamilyWords.noAnswer else {
                Issue.record("a settings rollback wasn't refused")
                return
            }
            do {
                _ = try await phone.vault.children(of: family.rootId)
                Issue.record("the refused family's folder was listed again")
            } catch {}
            #expect(await phone.vault.item(family.fileId) == nil)
            // The upload queue opens the family for its write, then writes: neither goes.
            server.clearRequests()
            let source = try temporaryFile("note.txt", Data("x".utf8))
            await #expect(throws: (any Error).self) { try await phone.sync.ensureOpen(family.groupId) }
            await #expect(throws: (any Error).self) {
                _ = try await phone.vault.upload(fileURL: source, name: "note.txt", mime: "text/plain", in: family.rootId, replacing: nil)
            }
            #expect(server.writes.isEmpty)
        }

        /*
         * The member list names the member's own drive as a family folder as well. Route 25 and the
         * folder ids decide what is the family's: the own drive is never handed to the screens as a
         * family folder, never saved in the device record, and a refusal of the family lets go of
         * its folder only. Fails if a roster's word alone makes a folder the family's.
         */
        @Test func aRosterNamingThePersonalDriveLeavesItPersonal() async throws {
            let family = try FamilyFixture(namingPersonal: true)
            let server = family.server(chain: [family.r1, family.r2], pin: try family.pin(through: [family.r1, family.r2]))
            let phone = try await family.phone(server)
            defer { phone.done() }
            // Accepted, its folders not opened yet (route 25 fails): the record names none of what the roster alone says.
            server.spacesFail = true
            _ = await phone.sync.sync(family.summary)
            #expect(phone.records.read(userId: family.member.userId, groupId: family.groupId)?.areas.contains(family.personal) == false,
                    "the device record saved the own drive on a roster's word")
            server.spacesFail = false
            guard case .accepted = await phone.sync.sync(family.summary) else { Issue.record("not accepted"); return }
            #expect(await phone.sync.familyAreas()[family.personal] == nil, "the own drive was handed to the screens as a family folder")
            #expect(!(await phone.vault.isFamilyWorkspace(family.personal)))
            #expect(phone.records.read(userId: family.member.userId, groupId: family.groupId)?.areas == [family.workspaceId])
            #expect(await phone.sync.knownAreas(family.groupId) == [family.workspaceId])
            // Refused (a fork after roster 3): the family's folder goes, the own drive stays out of it.
            server.serve(chain: [family.r1, family.r2, family.r3])
            guard case .accepted = await phone.sync.sync(family.summary) else { Issue.record("roster 3 not accepted"); return }
            server.serve(chain: [family.r1, family.r2, family.r3Fork, family.r4Fork])
            guard case .fork = await phone.sync.sync(family.summary) else { Issue.record("no warning"); return }
            #expect(await phone.sync.familyAreas()[family.personal] == nil)
            #expect(phone.records.read(userId: family.member.userId, groupId: family.groupId)?.areas == [family.workspaceId])
        }

        /*
         * This phone holds a record of another family whose saved folders name this family's folder
         * (its member list listed it). Refusing or wiping that other family leaves this family's rows,
         * keys and opened copies alone. Fails if a saved record lets one family clear another's.
         */
        @Test func lettingGoOfAnotherFamilyLeavesThisFamilysFolder() async throws {
            let family = try FamilyFixture()
            let server = family.server(chain: [family.r1, family.r2], pin: try family.pin(through: [family.r1, family.r2]))
            let phone = try await family.phone(server)
            defer { phone.done() }
            guard case .accepted = await phone.sync.sync(family.summary) else { Issue.record("not accepted"); return }
            #expect(phone.records.read(userId: family.member.userId, groupId: family.groupId)?.areas == [family.workspaceId])
            _ = try await phone.vault.children(of: family.rootId)
            let folder = try #require(TemporaryCopies.openedFolder(itemId: family.fileId, version: "v1", familyWorkspace: family.workspaceId, in: phone.temporary))
            let copy = folder.appendingPathComponent("Recipes.txt")
            try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
            try Data("Pancakes".utf8).write(to: copy)
            let other = try newId(kind: .group, scopeId: family.creator.userId).id
            try phone.records.put(userId: family.member.userId, groupId: other, FamilyRecords.Row(envelope: "e30", rosterVersion: 1, areas: [family.workspaceId], areasProven: true))
            await phone.sync.refuse(other)
            try? await phone.sync.wipe(other)
            #expect(FileManager.default.fileExists(atPath: copy.path), "the other family's cleanup deleted this family's copy")
            #expect(await phone.vault.item(family.rootId) != nil, "the other family's cleanup dropped this family's rows")
            #expect(try await phone.vault.children(of: family.rootId).map(\.name) == ["Recipes.txt"])
        }

        /*
         * A family file was opened, then its folder deleted elsewhere while the app was closed. After
         * the relaunch the sync finds the folder gone: its copy goes then, before the record lets go of
         * it, and a later removal leaves no copy anywhere. Fails if a relaunch's acceptance replaces
         * the record's folders (nothing is proven yet), or a folder leaves the record before its copies.
         */
        @Test func aFolderDeletedWhileTheAppWasClosedLeavesNoCopy() async throws {
            let family = try FamilyFixture()
            let server = family.server(chain: [family.r1, family.r2], pin: try family.pin(through: [family.r1, family.r2]))
            let first = try await family.phone(server)
            guard case .accepted = await first.sync.sync(family.summary) else { Issue.record("not accepted"); return }
            _ = try await first.vault.children(of: family.rootId)
            let folder = try #require(TemporaryCopies.openedFolder(itemId: family.fileId, version: "v1", familyWorkspace: family.workspaceId, in: first.temporary))
            try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
            let copy = folder.appendingPathComponent("Recipes.txt")
            try Data("Pancakes".utf8).write(to: copy)
            first.done()

            // Deleted elsewhere while the app was closed; relaunched over the same records, guard and temporary folder.
            server.areaListed = false
            let later = try await family.phone(server, records: first.records, guards: first.guards)
            defer { later.done() }
            guard case .accepted = await later.sync.sync(family.summary) else { Issue.record("not accepted after the relaunch"); return }
            #expect(!FileManager.default.fileExists(atPath: copy.path), "the deleted folder's copy outlived it")
            #expect(later.records.read(userId: family.member.userId, groupId: family.groupId)?.areas == [])
            server.notMember = true
            #expect(await later.sync.sync(family.summary) == .wiped)
            #expect(!FileManager.default.fileExists(atPath: folder.path))
        }

        /* A decrypted copy of `itemId` in a family folder's copies under `temporary`, as an earlier open left it. */
        private func copy(_ itemId: String, in workspaceId: String, under temporary: URL) throws -> URL {
            let folder = try #require(TemporaryCopies.openedFolder(itemId: itemId, version: "v1", familyWorkspace: workspaceId, in: temporary))
            try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
            let file = folder.appendingPathComponent("copy.txt")
            try Data("plaintext".utf8).write(to: file)
            return file
        }

        /*
         * Copies are swept by what families hold, not by what a record remembers: one in a folder no
         * family holds goes when the families start and after every sync that finds a folder set,
         * while an accepted family's own copy stays; after a not-member nothing of it stays. Fails
         * if a copy outlives the families when no record names its folder.
         */
        @Test func copiesOfFoldersNoFamilyHoldsAreSweptAndAnAcceptedFamilysStay() async throws {
            let family = try FamilyFixture()
            let server = family.server(chain: [family.r1, family.r2], pin: try family.pin(through: [family.r1, family.r2]))
            let guards = familyGuards(family.member)
            let temporary = guards.folder.deletingLastPathComponent().appendingPathComponent(guards.folder.lastPathComponent + "-tmp", isDirectory: true)
            // Left by an earlier run, in a folder nothing remembers.
            let leftover = try copy(family.fileId, in: UUID().uuidString.lowercased(), under: temporary)
            let phone = try await family.phone(server, guards: guards)
            defer { phone.done() }
            #expect(!FileManager.default.fileExists(atPath: leftover.path), "a copy no family holds outlived the start")
            guard case .accepted = await phone.sync.sync(family.summary) else { Issue.record("not accepted"); return }
            _ = try await phone.vault.children(of: family.rootId)
            let own = try copy(family.fileId, in: family.workspaceId, under: temporary)
            let stray = try copy(family.fileId, in: UUID().uuidString.lowercased(), under: temporary)
            guard case .accepted = await phone.sync.sync(family.summary) else { Issue.record("not accepted again"); return }
            #expect(FileManager.default.fileExists(atPath: own.path), "the accepted family's copy was swept")
            #expect(!FileManager.default.fileExists(atPath: stray.path), "a copy no family holds outlived a sync")
            let another = try copy(family.fileId, in: UUID().uuidString.lowercased(), under: temporary)
            server.notMember = true
            #expect(await phone.sync.sync(family.summary) == .wiped)
            #expect(!FileManager.default.fileExists(atPath: own.path))
            #expect(!FileManager.default.fileExists(atPath: another.path))
        }

        /* An ended session's sweep deletes nothing: the copies there now may be the next session's. */
        @Test func anEndedSessionSweepsNothing() async throws {
            let family = try FamilyFixture()
            let server = family.server(chain: [family.r1, family.r2], pin: try family.pin(through: [family.r1, family.r2]))
            let account = CopyEpoch()
            let phone = try await family.phone(server, account: account)
            defer { phone.done() }
            guard case .accepted = await phone.sync.sync(family.summary) else { Issue.record("not accepted"); return }
            TemporaryCopies.endAccount(account)
            let next = try copy(family.fileId, in: UUID().uuidString.lowercased(), under: phone.temporary)
            await phone.sync.sweepCopies()
            await phone.sync.refuse(family.groupId)
            #expect(FileManager.default.fileExists(atPath: next.path), "an ended session swept the next one's copy")
        }

        /*
         * A sync of the last session answers not-member after the account signed in again (its session
         * ended; its task can't be cancelled). Its wipe deletes nothing the new session wrote: not the
         * copy it opened, not the record it saved. Fails if an ended session's cleanup reaches the
         * shared paths.
         */
        @Test func aClosedSessionsLateWipeDeletesNothingTheNewSessionWrote() async throws {
            let family = try FamilyFixture()
            let server = family.server(chain: [family.r1, family.r2], pin: try family.pin(through: [family.r1, family.r2]))
            let account = CopyEpoch()
            let old = try await family.phone(server, account: account)
            defer { old.done() }
            guard case .accepted = await old.sync.sync(family.summary) else { Issue.record("not accepted"); return }
            // Signed out, then in again: a new vault and sync over the same records, guard and temporary folder.
            TemporaryCopies.endAccount(account)
            let now = try await family.phone(server, records: old.records, guards: old.guards, account: account)
            guard case .accepted = await now.sync.sync(family.summary) else { Issue.record("not accepted again"); return }
            _ = try await now.vault.children(of: family.rootId)
            let folder = try #require(TemporaryCopies.openedFolder(itemId: family.fileId, version: "v1", familyWorkspace: family.workspaceId, in: now.temporary))
            try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
            let copy = folder.appendingPathComponent("Recipes.txt")
            try Data("Pancakes".utf8).write(to: copy)
            // The old session's late not-member, wiped by its own sync.
            try? await old.sync.wipe(family.groupId)
            #expect(FileManager.default.fileExists(atPath: copy.path), "the old session's wipe deleted the new session's copy")
            #expect(now.records.read(userId: family.member.userId, groupId: family.groupId) != nil, "the old session's wipe deleted the new session's record")
            #expect(await now.vault.item(family.rootId) != nil)
            // Nor does it write one.
            let row = FamilyRecords.Row(envelope: "e30", rosterVersion: 99, areas: [])
            let oldRecords = await old.sync.records
            #expect(throws: (any Error).self) { try oldRecords.put(userId: family.member.userId, groupId: family.groupId, row) }
            #expect(now.records.read(userId: family.member.userId, groupId: family.groupId)?.rosterVersion == 2)
        }

        /*
         * The creator is pinned first-seen and this phone's contact guard took their keys, the ones
         * the member list serves. Another device then saves the creator first-seen with other keys
         * (Continue over a change there); this phone's guard still holds the member list's. Judging
         * goes by the pins the guard allows, so the creator's files read as they did, never "Keys
         * don't match". Fails if a judgement takes the settings' pins over the guard's.
         */
        @Test func aPinAnotherDeviceChangedNeverJudgesAgainstThisPhonesGuard() async throws {
            let family = try FamilyFixture()
            let server = family.server(chain: [family.r1, family.r2], pin: try family.pin(through: [family.r1, family.r2]))
            func firstSeen(_ keys: IdentityKeys) throws -> ContactPin {
                let served = ServedKeys(keyVersion: keys.keyVersion, encryptionPublicKey: keys.encryptionPublicKey, signingPublicKey: keys.signingPublicKey,
                                        mlDsaPublicKey: keys.mlDsaPublicKey!, kemPublicKey: keys.kemPublicKey!)
                return ContactPin(userId: family.creator.userId, email: "sam@example.com", name: "Sam", keys: try pinOfServed(served: served, verified: false),
                                  pinnedAt: "2026-10-28T00:00:00.000Z", firstSeen: "family")
            }
            try server.editSettings { $0.setPin(try firstSeen(family.creator.keys)) }
            let phone = try await family.phone(server)
            defer { phone.done() }
            guard case .accepted = await phone.sync.sync(family.summary) else { Issue.record("not accepted"); return }
            // This phone's guard takes the creator's keys on first use.
            #expect(try await phone.vault.effectivePins().contains { $0.userId == family.creator.userId })
            let before = try #require(await phone.sync.verdicts(of: [family.file], groupId: family.groupId).first)
            #expect(before.mark?.label != "Keys don’t match")

            // Another device's save: the creator first-seen under other keys. This phone's guard is untouched.
            let other = try FamilyPerson()
            try server.editSettings { $0.setPin(try firstSeen(other.keys)) }
            await phone.vault.forgetSigners()
            // Read again (the settings come with the guard's view), so the settings' pin is the other device's now.
            _ = try await phone.vault.effectivePins()
            #expect(await phone.vault.knownPins()[family.creator.userId]?.signingPublicKey == other.keys.signingPublicKey)
            let after = try #require(await phone.sync.verdicts(of: [family.file], groupId: family.groupId).first)
            #expect(after.mark?.label != "Keys don’t match", "the creator's file was judged against keys this phone's guard never accepted")
            #expect(after == before)
        }

        /*
         * A family opened on this phone, then the server shows another history from version 3:
         * the hard warning, and what was opened of its folders is gone, so nothing in them opens.
         */
        @Test func aForkShowsTheWarningAndOpensNothing() async throws {
            let family = try FamilyFixture()
            let server = family.server(chain: [family.r1, family.r2, family.r3], pin: try family.pin(through: [family.r1, family.r2]))
            let phone = try await family.phone(server)
            defer { phone.done() }
            guard case .accepted = await phone.sync.sync(family.summary) else { Issue.record("not accepted"); return }
            _ = try await phone.vault.children(of: family.rootId)

            // The continuation names a head this device never saw; from version 1 it branches at 3.
            server.serve(chain: [family.r1, family.r2, family.r3Fork, family.r4Fork])
            server.clearRequests()
            guard case .fork(let fork) = await phone.sync.sync(family.summary) else { Issue.record("no warning"); return }
            #expect(fork.memberList && fork.version == 3)
            #expect(Set(fork.sides.flatMap(\.from)).contains("what the server shows now"))
            #expect(!server.requested("/api/drive/spaces"))
            #expect(await phone.vault.item(family.rootId) == nil)
            #expect(await phone.vault.item(family.fileId) == nil)
            // The core holds the family's keys back after the fork: the listing, asked in the family's workspace, is refused
            // there, not by the app.
            do {
                _ = try await phone.vault.children(of: family.rootId, in: family.workspaceId)
                Issue.record("a forked family's folder listed")
            } catch {
                #expect(FamilyWords.error(error) == FamilyWords.openAgain)
            }
            #expect(phone.records.read(userId: family.member.userId, groupId: family.groupId)?.rosterVersion == 3)
        }

        /*
         * The grant opened the folder's current key, so the ledger wrapped it as this account's
         * self-grant and the phone stored it (route 23). Later the creator's account is gone (route 6
         * serves no identity for the granter): a fresh start opens the folder from the self-grant,
         * and stores nothing again. Fails without the self-grant opener or without storing it.
         */
        @Test func aFolderWhoseGranterIsGoneOpensFromTheSelfGrantThisPhoneStored() async throws {
            let family = try FamilyFixture()
            let server = family.server(chain: [family.r1, family.r2], pin: try family.pin(through: [family.r1, family.r2]))
            let route23 = "/api/groups/\(family.groupId)/areas/\(family.workspaceId)/self-grant"
            let first = try await family.phone(server)
            guard case .accepted = await first.sync.sync(family.summary) else { Issue.record("not accepted"); return }
            #expect(server.count(route23, method: "PUT") == 1)
            let stored = try #require(server.selfGrant)
            #expect((stored["workspaceId"] as? String) == family.workspaceId && (stored["keyVersion"] as? NSNumber)?.intValue == 1)
            first.done()

            server.granterGone = true
            server.clearRequests()
            let later = try await family.phone(server, records: first.records)
            defer { later.done() }
            guard case .accepted(let view) = await later.sync.sync(family.summary) else { Issue.record("not accepted"); return }
            let area = try #require(view.areas.first)
            #expect(area.name == "Photos" && area.openable)
            #expect(try await later.vault.children(of: family.rootId).map(\.name) == ["Recipes.txt"])
            #expect(!server.requested(route23, method: "PUT"))
        }

        /*
         * A grant envelope and a granter key that don't decode (a server's junk) are no reason to stop:
         * the stored self-grant still opens the folder, as on the web. Fails if a decode error aborts
         * the folder before the ledger is asked.
         */
        @Test func aGrantThatDoesNotDecodeStillLetsTheSelfGrantOpenTheFolder() async throws {
            let family = try FamilyFixture()
            let server = family.server(chain: [family.r1, family.r2], pin: try family.pin(through: [family.r1, family.r2]))
            let first = try await family.phone(server)
            guard case .accepted = await first.sync.sync(family.summary) else { Issue.record("not accepted"); return }
            #expect(server.selfGrant != nil)
            first.done()

            server.malformedGrant = true
            let later = try await family.phone(server, records: first.records)
            defer { later.done() }
            guard case .accepted(let view) = await later.sync.sync(family.summary) else { Issue.record("not accepted"); return }
            let area = try #require(view.areas.first)
            #expect(area.name == "Photos" && area.openable)
        }

        /* The break-check's other half: with the granter gone and no self-grant stored, nothing of the folder opens. */
        @Test func aFolderWhoseGranterIsGoneAndNoSelfGrantDoesNotOpen() async throws {
            let family = try FamilyFixture()
            let server = family.server(chain: [family.r1, family.r2], pin: try family.pin(through: [family.r1, family.r2]))
            server.granterGone = true
            let phone = try await family.phone(server)
            defer { phone.done() }
            guard case .accepted(let view) = await phone.sync.sync(family.summary) else { Issue.record("not accepted"); return }
            let area = try #require(view.areas.first)
            #expect(area.name == nil && !area.openable && area.write == .readOnly)
            #expect(server.selfGrant == nil)
        }

        /* Only 404 `not-member` wipes: the record, the ledger's keys and the opened folders go; the settings pin stays. */
        @Test func aNotMemberAnswerWipesWhatThePhoneKeptButKeepsTheSettingsPin() async throws {
            let family = try FamilyFixture()
            let server = family.server(chain: [family.r1, family.r2], pin: try family.pin(through: [family.r1, family.r2]))
            let phone = try await family.phone(server)
            defer { phone.done() }
            guard case .accepted = await phone.sync.sync(family.summary) else { Issue.record("not accepted"); return }
            _ = try await phone.vault.children(of: family.rootId)
            let pinBefore = try #require(try server.storedPin(family))

            server.notMember = true
            server.clearRequests()
            #expect(await phone.sync.sync(family.summary) == .wiped)
            #expect(phone.records.read(userId: family.member.userId, groupId: family.groupId) == nil)
            #expect(!phone.vault.areaLedger.isArea(workspaceId: family.workspaceId))
            #expect(await phone.vault.item(family.rootId) == nil)
            #expect(try server.storedPin(family) == pinBefore)
            #expect(!server.requested("/api/auth/settings", method: "PUT"))
        }

        /*
         * Removed on another device: route 2 stops listing the family, and asked about it, the server
         * says not-member. The phone drops it then, without a relaunch: the device record, the
         * ledger's keys and the folders opened here go, and it is named as removed. Fails if a family
         * route 2 no longer lists is never asked about.
         */
        @Test func aFamilyNoLongerListedAndNotMemberIsWiped() async throws {
            let family = try FamilyFixture()
            let server = family.server(chain: [family.r1, family.r2], pin: try family.pin(through: [family.r1, family.r2]))
            let phone = try await family.phone(server)
            defer { phone.done() }
            guard case .accepted = await phone.sync.sync(family.summary) else { Issue.record("not accepted"); return }
            _ = try await phone.vault.children(of: family.rootId)

            server.listed = false
            server.notMember = true
            let (listed, removed, failed) = try await phone.sync.listReconciling()
            #expect(failed.isEmpty)
            #expect(listed.isEmpty)
            #expect(removed == [family.groupId])
            #expect(phone.records.read(userId: family.member.userId, groupId: family.groupId) == nil)
            #expect(!phone.vault.areaLedger.isArea(workspaceId: family.workspaceId))
            #expect(await phone.vault.item(family.rootId) == nil)
            // Asked once: the next pass doesn't ask again.
            server.clearRequests()
            #expect(try await phone.sync.listReconciling().removed.isEmpty)
            #expect(!server.requested("/api/groups/\(family.groupId)/rosters"))
        }

        /*
         * Route 25 names one of this account's own folders as the family area's top folder: refused
         * as the family's Couldn't check, never opened through the personal key path, and nothing
         * personal becomes a family folder. Fails if the root is opened by its own workspace's path.
         */
        @Test func aRootFromAnotherWorkspaceIsRefusedAndNothingPersonalBecomesAFamilyFolder() async throws {
            let family = try FamilyFixture()
            let server = family.server(chain: [family.r1, family.r2], pin: try family.pin(through: [family.r1, family.r2]))
            server.servedRootId = family.personalRoot.id
            let phone = try await family.phone(server)
            defer { phone.done() }
            guard case .accepted(let view) = await phone.sync.sync(family.summary) else { Issue.record("not accepted"); return }
            let area = try #require(view.areas.first)
            #expect(area.root == nil, "a personal folder was handed out as the family's top folder")
            #expect(area.name == nil && !area.openable)
            #expect(area.line == "Couldn’t check this folder’s keys")
            #expect(!(await phone.vault.isFamilyWorkspace(family.personal)))
            #expect(await phone.sync.familyAreas()[family.personal.lowercased()] == nil)
        }

        /* Route 25 names a file inside the area, not its top folder: refused the same way. */
        @Test func aRootThatIsNotTheAreasTopFolderIsRefused() async throws {
            let family = try FamilyFixture()
            let server = family.server(chain: [family.r1, family.r2], pin: try family.pin(through: [family.r1, family.r2]))
            server.servedRootId = family.fileId
            let phone = try await family.phone(server)
            defer { phone.done() }
            guard case .accepted(let view) = await phone.sync.sync(family.summary) else { Issue.record("not accepted"); return }
            let area = try #require(view.areas.first)
            #expect(area.root == nil && !area.openable)
        }

        /*
         * Route 25 names a folder inside the area whose key this phone already holds (listed after an
         * earlier sync): it opens, but it isn't the area's top, so it is refused all the same. Fails if
         * only the opening decides what the top folder is.
         */
        @Test func aFolderInsideTheAreaIsNotItsTopFolder() async throws {
            let family = try FamilyFixture()
            let server = family.server(chain: [family.r1, family.r2], pin: try family.pin(through: [family.r1, family.r2]))
            server.put(family.docs)
            let phone = try await family.phone(server)
            defer { phone.done() }
            guard case .accepted = await phone.sync.sync(family.summary) else { Issue.record("not accepted"); return }
            #expect(try await phone.vault.children(of: family.rootId).contains { $0.id == family.docs.id })

            server.servedRootId = family.docs.id
            guard case .accepted(let view) = await phone.sync.sync(family.summary) else { Issue.record("not accepted"); return }
            #expect(view.areas.first?.root == nil)
        }

        /* Only a folder of the area's own workspace, at its top, is the area's top folder. */
        @Test func anAreasTopFolderIsAFolderAtTheTopOfItsOwnWorkspace() async throws {
            let family = try FamilyFixture()
            #expect(FamilySync.isAreaRoot(family.root, of: family.workspaceId))
            #expect(!FamilySync.isAreaRoot(family.root, of: family.personal))
            #expect(!FamilySync.isAreaRoot(family.personalRoot, of: family.workspaceId))
            #expect(!FamilySync.isAreaRoot(family.docs, of: family.workspaceId))
            #expect(!FamilySync.isAreaRoot(family.file, of: family.workspaceId))
            // A file at the area's top is no top folder either.
            let topFile = try FamilyFixture.node(id: try newId(kind: .node, scopeId: family.workspaceId).id, in: family.workspaceId, parent: nil,
                                                 parentKey: family.areaKey, key: try randomBytes(length: 32), kind: .file, name: "Loose.txt", writer: family.creator)
            #expect(!FamilySync.isAreaRoot(topFile, of: family.workspaceId))
        }

        /* The ledger's own path refuses a node of any workspace not known as a family folder, before it touches a cache. */
        @Test func aFamilyListingNeverOpensAPersonalNode() async throws {
            let family = try FamilyFixture()
            let server = family.server(chain: [family.r1, family.r2], pin: try family.pin(through: [family.r1, family.r2]))
            let phone = try await family.phone(server)
            defer { phone.done() }
            guard case .accepted = await phone.sync.sync(family.summary) else { Issue.record("not accepted"); return }
            await #expect(throws: (any Error).self) { _ = try await phone.vault.openListed(family.personalRoot) }
            // The family's own top folder still opens through it.
            #expect(try await phone.vault.openListed(family.root).name == "Photos")
        }

        /*
         * A listing of the family folder was waiting on the server when the family's check found it
         * shown differently: the core committed the newer member list, then the settings pin (saved
         * meanwhile from another device) named another history, so the core still holds the keys it
         * just took. The listing then resumes: it keeps neither rows nor keys, and asking for the file
         * afterwards is refused rather than answered from the cache. Fails if an open puts back what
         * a fork's forget cleared.
         */
        @Test func anOpenThatResumesAfterAForkKeepsNothingAndResolveRefuses() async throws {
            let family = try FamilyFixture()
            let server = family.server(chain: [family.r1, family.r2], pin: try family.pin(through: [family.r1, family.r2]))
            let phone = try await family.phone(server)
            defer { phone.done() }
            guard case .accepted = await phone.sync.sync(family.summary) else { Issue.record("not accepted"); return }

            server.serve(chain: [family.r1, family.r2, family.r3])
            let other = try family.pin(through: [family.r1, family.r2, family.r3Fork])
            server.afterRosters = { try? server.storeSettings(pin: other) }
            let (sync, summary) = (phone.sync, family.summary)
            let found = FoundState()
            await phone.vault.listingPage {
                guard found.value == nil else { return }
                found.value = await sync.sync(summary)
            }
            await #expect(throws: (any Error).self) { _ = try await phone.vault.listChildren(of: family.rootId) }
            await phone.vault.listingPage(nil)
            guard case .fork? = found.value else { Issue.record("no fork in between: \(String(describing: found.value))"); return }
            #expect(await phone.vault.item(family.fileId) == nil, "the opened row came back after the fork")
            #expect(await phone.vault.nodeKey(family.fileId) == nil)
            await #expect(throws: (any Error).self) { _ = try await phone.vault.resolve(family.fileId) }
        }

        /*
         * Removed between route 5 and route 3: the member list still served, then route 3 says
         * not-member. The family is wiped as any not-member answer wipes it, never kept accepted with
         * its keys and rows until the next sync. Fails if route 3's answer is swallowed.
         */
        @Test func routeThreeNotMemberWipes() async throws {
            let family = try FamilyFixture()
            let server = family.server(chain: [family.r1, family.r2], pin: try family.pin(through: [family.r1, family.r2]))
            let phone = try await family.phone(server)
            defer { phone.done() }
            server.detailNotMember = true
            #expect(await phone.sync.sync(family.summary) == .wiped)
            #expect(phone.records.read(userId: family.member.userId, groupId: family.groupId) == nil)
        }

        /* A 401 there ends the session as any other request's does: handed to the app, not said as "couldn't check" only. */
        @Test func aSessionThatEndedDuringASyncIsHandedOn() async throws {
            let family = try FamilyFixture()
            let server = family.server(chain: [family.r1, family.r2], pin: try family.pin(through: [family.r1, family.r2]))
            let phone = try await family.phone(server)
            defer { phone.done() }
            #expect(await phone.sync.takeEnded() == nil)
            server.unauthorized = true
            if case .accepted = await phone.sync.sync(family.summary) { Issue.record("accepted under an ended session") }
            let ended = await phone.sync.takeEnded()
            #expect(ended.map { endsSession($0) } == true)
            #expect(await phone.sync.takeEnded() == nil, "handed on twice")
        }

        /* A plaintext copy opened before: in its place, a file in it. */
        func copy(_ phone: FamilyFixture.Phone, item: String, family: String?) throws -> URL {
            let folder = try #require(TemporaryCopies.openedFolder(itemId: item, version: "v1", familyWorkspace: family, in: phone.temporary))
            try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
            let file = folder.appendingPathComponent("Recipes.txt")
            try Data("pancakes".utf8).write(to: file)
            return file
        }

        /*
         * A family file opened in an earlier session (this one never listed it) leaves its plaintext
         * copy on the phone. The server says not-member: the copy goes, found by the device record's
         * folders, not by what this session listed; a personal copy stays. Fails if the wipe misses
         * copies it didn't list, or takes personal ones.
         */
        @Test func aNotMemberWipeDeletesFamilyCopiesFromAnEarlierSessionOnly() async throws {
            let family = try FamilyFixture()
            let server = family.server(chain: [family.r1, family.r2], pin: try family.pin(through: [family.r1, family.r2]))
            let first = try await family.phone(server)
            guard case .accepted = await first.sync.sync(family.summary) else { Issue.record("not accepted"); return }
            let familyCopy = try copy(first, item: family.fileId, family: family.workspaceId)
            let personalCopy = try copy(first, item: family.personalRoot.id, family: nil)
            first.done()

            // A relaunch: a new session that hasn't listed anything of the family.
            server.notMember = true
            let later = try await family.phone(server, records: first.records, guards: first.guards)
            defer { later.done() }
            #expect(await later.sync.sync(family.summary) == .wiped)
            #expect(!FileManager.default.fileExists(atPath: familyCopy.path), "a family copy outlived the removal")
            #expect(FileManager.default.fileExists(atPath: personalCopy.path))
        }

        /*
         * The same when the wipe has to wait for the guard (it can't be stored): nothing of the
         * family stays open here, its copies included, though its device record does.
         */
        @Test func aWipeThatWaitsForTheGuardStillDeletesTheCopies() async throws {
            let family = try FamilyFixture()
            let writes = GuardSwitch()
            let server = family.server(chain: [family.r1, family.r2], pin: try family.pin(through: [family.r1, family.r2]))
            let phone = try await family.phone(server, guards: familyGuards(family.member, writes: writes))
            defer { phone.done() }
            guard case .accepted = await phone.sync.sync(family.summary) else { Issue.record("not accepted"); return }
            let familyCopy = try copy(phone, item: family.fileId, family: family.workspaceId)
            server.serve(chain: [family.r1, family.r2, family.r3])
            writes.writable = false
            server.notMember = true
            _ = await phone.sync.sync(family.summary)
            #expect(phone.records.read(userId: family.member.userId, groupId: family.groupId) != nil)
            #expect(!FileManager.default.fileExists(atPath: familyCopy.path))
        }

        /* A family copy goes only under a family folder id that is one: never somewhere a forget can't find. */
        @Test func aFamilyCopyNeedsAWorkspaceIdThatIsAUUID() async throws {
            let temporary = FileManager.default.temporaryDirectory.appendingPathComponent("copies-\(UUID().uuidString)")
            #expect(TemporaryCopies.openedFolder(itemId: "a", version: "v", familyWorkspace: "../personal", in: temporary) == nil)
            let ws = UUID().uuidString.lowercased()
            #expect(TemporaryCopies.openedFolder(itemId: "a", version: "v", familyWorkspace: ws, in: temporary)?.path
                == temporary.appendingPathComponent("opened/family/\(ws)/a/v").path)
        }

        /*
         * A day on, the sweep removes family copies as it does personal ones, and leaves a fresh one,
         * the `family` folder read as the folder it is, not as an item. Fails if the sweep misreads it.
         */
        @Test func theSweepReadsFamilyCopies() async throws {
            let temporary = FileManager.default.temporaryDirectory.appendingPathComponent("copies-\(UUID().uuidString)")
            let ws = UUID().uuidString.lowercased()
            let files = FileManager.default
            func make(_ folder: URL?, age: TimeInterval) throws -> URL {
                let folder = try #require(folder)
                try files.createDirectory(at: folder, withIntermediateDirectories: true)
                let file = folder.appendingPathComponent("f.txt")
                try Data("x".utf8).write(to: file)
                try files.setAttributes([.modificationDate: Date().addingTimeInterval(-age)], ofItemAtPath: folder.path)
                return file
            }
            let oldFamily = try make(TemporaryCopies.openedFolder(itemId: "old", version: "v", familyWorkspace: ws, in: temporary), age: 2 * 86400)
            let freshFamily = try make(TemporaryCopies.openedFolder(itemId: "fresh", version: "v", familyWorkspace: ws, in: temporary), age: 60)
            let oldPersonal = try make(TemporaryCopies.openedFolder(itemId: "mine", version: "v", familyWorkspace: nil, in: temporary), age: 2 * 86400)
            // The family folders as old as a copy in them could make them look, as a node's folder would.
            try files.setAttributes([.modificationDate: Date().addingTimeInterval(-3 * 86400)], ofItemAtPath: temporary.appendingPathComponent("opened/family").path)
            TemporaryCopies.sweep(in: temporary)
            #expect(!files.fileExists(atPath: oldFamily.path))
            #expect(files.fileExists(atPath: freshFamily.path))
            #expect(!files.fileExists(atPath: oldPersonal.path))
        }

        /*
         * Route 2 doesn't load (a 503), or the server doesn't answer about the family (a 503 on route
         * 5): nothing is taken away. Only the server's not-member is a removal. Fails if a failed list
         * or a failed question counts as one.
         */
        @Test func aListOrAnAnswerThatFailsWipesNothing() async throws {
            let family = try FamilyFixture()
            let server = family.server(chain: [family.r1, family.r2], pin: try family.pin(through: [family.r1, family.r2]))
            let phone = try await family.phone(server)
            defer { phone.done() }
            guard case .accepted = await phone.sync.sync(family.summary) else { Issue.record("not accepted"); return }

            server.groupsFail = true
            server.notMember = true
            await #expect(throws: GroupsAPIError.self) { _ = try await phone.sync.listReconciling() }
            #expect(phone.records.read(userId: family.member.userId, groupId: family.groupId) != nil)
            #expect(phone.vault.areaLedger.isArea(workspaceId: family.workspaceId))

            server.groupsFail = false
            server.notMember = false
            server.listed = false
            server.rostersFail = true
            #expect(try await phone.sync.listReconciling().removed.isEmpty)
            #expect(phone.records.read(userId: family.member.userId, groupId: family.groupId) != nil)
            #expect(phone.vault.areaLedger.isArea(workspaceId: family.workspaceId))
        }

        /*
         * Route 2 stops listing the family but the server still serves it (route 2 caught mid-change):
         * a race, never a removal, so nothing is wiped. Fails if absence from the list alone wipes.
         */
        @Test func aFamilyUnlistedButStillServedIsKept() async throws {
            let family = try FamilyFixture()
            let server = family.server(chain: [family.r1, family.r2], pin: try family.pin(through: [family.r1, family.r2]))
            let phone = try await family.phone(server)
            defer { phone.done() }
            guard case .accepted = await phone.sync.sync(family.summary) else { Issue.record("not accepted"); return }

            server.listed = false
            #expect(try await phone.sync.listReconciling().removed.isEmpty)
            #expect(phone.records.read(userId: family.member.userId, groupId: family.groupId) != nil)
            #expect(phone.vault.areaLedger.isArea(workspaceId: family.workspaceId))
            #expect(try await phone.vault.children(of: family.rootId).map(\.name) == ["Recipes.txt"])
        }

        /*
         * Another device saves a later pin (roster 3, an earlier words check) the moment this one
         * saves: this one's pin, merged against what it read before, must not land over it. The
         * family is accepted again against the stored pin, and only what that adds is saved.
         */
        @Test func aPinAnotherDeviceSavedFirstIsNeverWrittenOver() async throws {
            let family = try FamilyFixture()
            let server = family.server(chain: [family.r1, family.r2, family.r3], pin: try family.pin(through: [family.r1, family.r2]))
            let phone = try await family.phone(server)
            defer { phone.done() }
            let theirs = try family.pin(through: [family.r1, family.r2, family.r3], checkedAt: "2026-10-18T08:00:00.000Z")
            server.beforePut = { try? server.storeSettings(pin: theirs) }

            guard case .accepted(let view) = await phone.sync.sync(family.summary) else { Issue.record("not accepted"); return }
            #expect(view.rosterVersion == 3)
            let stored = try #require(try server.storedPin(family))
            // Their earlier check stands; this device only adds the folder it opened.
            #expect(stored.checkedAt == theirs.checkedAt && stored.rosterVersion == 3)
            #expect(stored.areas == [family.workspaceId: 1])
        }

        /*
         * This device accepted roster 2; before it saves, another device saved a pin at roster 3.
         * The stored pin is ahead: never lowered, and the family is accepted again with it as a
         * mark, reaching roster 3.
         */
        @Test func aStoredPinAheadIsNeverLoweredAndTheFamilyIsAcceptedAgainUpToIt() async throws {
            let family = try FamilyFixture()
            let server = family.server(chain: [family.r1, family.r2], pin: try family.pin(through: [family.r1, family.r2]))
            let phone = try await family.phone(server)
            defer { phone.done() }
            let ahead = try family.pin(through: [family.r1, family.r2, family.r3], checkedAt: "2026-10-18T08:00:00.000Z")
            server.afterRosters = {
                server.serve(chain: [family.r1, family.r2, family.r3])
                try? server.storeSettings(pin: ahead)
            }

            guard case .accepted(let view) = await phone.sync.sync(family.summary) else { Issue.record("not accepted"); return }
            #expect(view.rosterVersion == 3)
            #expect(try server.storedPin(family)?.rosterVersion == 3)
            #expect(phone.records.read(userId: family.member.userId, groupId: family.groupId)?.rosterVersion == 3)
        }

        /*
         * This session committed roster 3; the server then keeps serving roster 2 as the head. Each
         * run is overtaken (short of the chain held), read again quietly, and after the third the
         * family says the server keeps serving an older member list.
         */
        @Test func threeOvertakenRunsSayTheServerKeepsServingAnOlderList() async throws {
            let family = try FamilyFixture()
            let server = family.server(chain: [family.r1, family.r2, family.r3], pin: try family.pin(through: [family.r1, family.r2]))
            let phone = try await family.phone(server)
            defer { phone.done() }
            guard case .accepted = await phone.sync.sync(family.summary) else { Issue.record("not accepted"); return }

            server.serve(chain: [family.r1, family.r2], ignoringAfter: true)
            server.clearRequests()
            #expect(await phone.sync.sync(family.summary) == .failed(servedRaceMessage(split: false)))
            // Three runs, each the continuation and then version 1.
            #expect(server.count("/api/groups/\(family.groupId)/rosters") == 6)
            #expect(phone.records.read(userId: family.member.userId, groupId: family.groupId)?.rosterVersion == 3)
        }

        /* A record that no longer opens (a master-key rotation) is deleted, and the family accepted again against the settings pin. */
        @Test func anUnreadableRecordIsResetAndTheFamilyAcceptedAgainstTheSettingsPin() async throws {
            let family = try FamilyFixture()
            let server = family.server(chain: [family.r1, family.r2], pin: try family.pin(through: [family.r1, family.r2]))
            let phone = try await family.phone(server)
            defer { phone.done() }
            guard case .accepted = await phone.sync.sync(family.summary) else { Issue.record("not accepted"); return }
            let row = try #require(phone.records.read(userId: family.member.userId, groupId: family.groupId))
            // One character of the sealed body changed: still base64url, no longer opens.
            var chars = Array(row.envelope)
            let at = chars.count / 2
            chars[at] = chars[at] == "A" ? "B" : "A"
            let damaged = FamilyRecords.Row(envelope: String(chars), rosterVersion: row.rosterVersion, areas: row.areas)
            try phone.records.put(userId: family.member.userId, groupId: family.groupId, damaged)

            let later = try await family.phone(server, records: phone.records)
            guard case .accepted(let view) = await later.sync.sync(family.summary) else { Issue.record("not accepted again"); return }
            #expect(view.recordReset)
            let fresh = try #require(later.records.read(userId: family.member.userId, groupId: family.groupId))
            #expect(fresh.envelope != damaged.envelope && fresh.rosterVersion == 2)
        }

        /*
         * The member pinned the creator after a words check over other keys than the ones the
         * member list names: the creator's file reads "Keys don't match", in the danger colour,
         * and the family vouches for nothing.
         */
        @Test func aKeyConflictMarksTheFileAndTheFamilyVouchesForNothing() async throws {
            let family = try FamilyFixture()
            let other = try FamilyPerson()
            let conflicting = try pinned(family.creator.userId, other.keys, name: "Maya Lindqvist")
            let server = family.server(chain: [family.r1, family.r2], pin: try family.pin(through: [family.r1, family.r2]))
            try server.storeSettings(pin: try family.pin(through: [family.r1, family.r2]), contacts: [conflicting])
            let phone = try await family.phone(server)
            defer { phone.done() }
            guard case .accepted = await phone.sync.sync(family.summary) else { Issue.record("not accepted"); return }
            let file = try #require(try await phone.vault.children(of: family.rootId).first)
            let verdict = await phone.sync.verdict(of: file.node, groupId: family.groupId)
            let mark = try #require(verdict.mark)
            #expect(mark.label == "Keys don’t match" && mark.danger)
            #expect(mark.lines == ["Maya’s keys don’t match the ones you checked. Check it’s them again."])
            #expect(verdict.verifiedBy == nil)
        }

        /*
         * What family folders don't offer (sharing, links, reports, keeping, earlier versions, a
         * rotation of one's own, a restore under the top folder) is refused before anything reaches
         * the server, whatever the screens offer. Fails if any of their gates is removed.
         */
        @Test func shareLinkReportKeepAndVersionsStayRefusedInAFamilyFolder() async throws {
            let family = try FamilyFixture()
            let server = family.server(chain: [family.r1, family.r2], pin: try family.pin(through: [family.r1, family.r2]))
            let phone = try await family.phone(server)
            defer { phone.done() }
            guard case .accepted = await phone.sync.sync(family.summary) else { Issue.record("not accepted"); return }
            let vault = phone.vault
            let file = try #require(try await vault.children(of: family.rootId).first)
            let anyone = try pinned(family.creator.userId, family.creator.keys)
            server.clearRequests()

            await #expect(throws: FamilyWriteError.unavailable) { _ = try await vault.share(file, with: anyone, role: "viewer") }
            await #expect(throws: FamilyWriteError.unavailable) { _ = try await vault.createLink(for: file, password: nil, expiresAt: nil) }
            await #expect(throws: FamilyWriteError.unavailable) { _ = try await vault.rotate(file) }
            await #expect(throws: FamilyWriteError.unavailable) { _ = try await vault.report(file, category: "spam", reason: "x", email: nil) }
            await #expect(throws: FamilyWriteError.unavailable) { try await vault.keepDownloaded(file) }
            await #expect(throws: FamilyWriteError.unavailable) { _ = try await vault.restore(file, parentTrashed: true) }
            let version = VersionListView(id: UUID().uuidString.lowercased(), objectId: UUID().uuidString.lowercased(), contentKeyEnvelope: "AA", status: "ready",
                                          contentSuite: 3, contentNonce: "AA", plaintextSize: nil, ciphertextSize: nil, current: false, supersededAt: nil,
                                          createdAt: "2026-10-18T10:00:00.000Z")
            await #expect(throws: FamilyWriteError.unavailable) { _ = try await vault.restoreVersion(version, of: file.id) }
            await #expect(throws: FamilyWriteError.unavailable) { _ = try await vault.planKeep(file) }
            #expect(server.writes.isEmpty)
        }

        /*
         * Another process finished a later acceptance (roster 3) while this one was fetching
         * roster 2: this one's record lands second and must not replace the later one.
         */
        /*
         * A route 2 row read before the join finished can still say `accepted`: with a device record on
         * this phone the family is synced as a member (never forgetting what the join opened); without
         * one it is still waiting to be let in.
         */
        @Test func anAcceptedRowWithADeviceRecordSyncsAsAMemberAndWithoutOneWaits() async throws {
            let family = try FamilyFixture()
            let server = family.server(chain: [family.r1, family.r2], pin: try family.pin(through: [family.r1, family.r2]))
            let phone = try await family.phone(server)
            defer { phone.done() }
            let s = family.summary
            let stale = GroupSummary(id: s.id, kind: s.kind, name: s.name, roles: s.roles, state: "accepted", rosterVersion: s.rosterVersion, groupKeyVersion: s.groupKeyVersion)

            #expect(await phone.sync.sync(stale) == .waiting)
            guard case .accepted = await phone.sync.sync(family.summary) else { Issue.record("not accepted"); return }
            #expect(phone.records.read(userId: family.member.userId, groupId: family.groupId) != nil)
            guard case .accepted = await phone.sync.sync(stale) else { Issue.record("a member's family forgotten on a stale row"); return }
            #expect(try await phone.vault.children(of: family.rootId).map(\.name) == ["Recipes.txt"])
        }

        @Test func aLateAcceptanceNeverWritesAnOlderRecordOverANewerOne() async throws {
            let family = try FamilyFixture()
            let server = family.server(chain: [family.r1, family.r2], pin: try family.pin(through: [family.r1, family.r2]))
            let phone = try await family.phone(server)
            defer { phone.done() }
            let newer = FamilyRecords.Row(envelope: "sealed-at-roster-3", rosterVersion: 3, areas: [family.workspaceId], areasProven: true)
            server.onRosters = { try? phone.records.put(userId: family.member.userId, groupId: family.groupId, newer) }

            guard case .accepted(let view) = await phone.sync.sync(family.summary) else { Issue.record("not accepted"); return }
            #expect(view.rosterVersion == 2)
            #expect(phone.records.read(userId: family.member.userId, groupId: family.groupId) == newer)
        }
    }
}

/* Base64url of SHA-256, as rosters name ML-DSA and ML-KEM keys. */
private func digest(_ value: String) throws -> String {
    base64urlEncode(bytes: Data(SHA256.hash(data: try base64urlDecode(value: value))))
}

struct FamilyPerson {
    let userId: String
    let root: Data
    let keys: IdentityKeys
    let envelope: IdentityEnvelope

    init(keyVersion: UInt64 = 1) throws {
        userId = UUID().uuidString.lowercased()
        root = try randomBytes(length: 32)
        envelope = try identityCreate(userId: userId, accountKey: root, keyVersion: keyVersion)
        keys = try identityOpen(userId: userId, accountKey: root, envelope: envelope)
    }

    var served: ServedKeys {
        ServedKeys(keyVersion: keys.keyVersion, encryptionPublicKey: keys.encryptionPublicKey, signingPublicKey: keys.signingPublicKey,
                   mlDsaPublicKey: keys.mlDsaPublicKey!, kemPublicKey: keys.kemPublicKey!)
    }

    var own: OwnIdentities { OwnIdentities(userId: userId, identities: [served]) }

    func entry(_ roles: [GroupRole], since: UInt64) throws -> RosterMember {
        RosterMember(userId: userId, keyVersion: keys.keyVersion, encryptionPublicKey: keys.encryptionPublicKey, signingPublicKey: keys.signingPublicKey,
                     mlDsaPublicKeyDigest: try digest(keys.mlDsaPublicKey!), kemPublicKeyDigest: try digest(keys.kemPublicKey!),
                     status: .active, roles: roles, sinceVersion: since)
    }
}

/*
 * A family as the web makes one: the creator signs roster 1 (one family folder, its key and its
 * top folder's key committed), lets the member in at roster 2 with a grant of the folder's key,
 * and makes them the organizer at roster 3 (or, on a server's other branch, a guardian, then
 * roster 4 on top). The creator wrote a file into the folder.
 */
struct FamilyFixture {
    let creator: FamilyPerson
    let member: FamilyPerson
    let groupId: String
    let groupSeed: Data
    let workspaceId: String
    let workspaceSeed: String
    let areaKey: Data
    let rootKey: Data
    let rootId: String
    let fileId: String
    let r1: SignedGroupStatement
    let r2: SignedGroupStatement
    let r3: SignedGroupStatement
    let r3Fork: SignedGroupStatement
    /* Another roster 2 on the same roster 1 (the member let in with another role): what a server shows instead of r2. */
    let r2Other: SignedGroupStatement
    let r4Fork: SignedGroupStatement
    let grant: Data
    let root: NodeView
    let file: NodeView
    let fileKey: Data
    let personal = UUID().uuidString.lowercased()
    /* The member's own drive: its key and top folder, where a move out of the family folder lands. */
    let personalKey: Data
    let personalRootKey: Data
    let personalRoot: NodeView
    /* A folder in the family folder (not served unless a test adds it) and a photo with content the creator uploaded. */
    let docsKey: Data
    let docs: NodeView
    let photoKey: Data
    let photo: NodeView
    let photoBytes: Data
    let photoObject: Data

    var summary: GroupSummary { GroupSummary(id: groupId, kind: "family", name: "Lindqvist family", roles: [], state: "active", rosterVersion: 2, groupKeyVersion: 1) }
    var firstKeys: GroupPublicKey { get throws { try groupPublicKey(seed: groupSeed) } }
    /* The creator's keys, and the member's, who signs a manager's calls once made one (memberManages). */
    var signerKeys: [String: String] { get throws {
        [try digest(creator.keys.mlDsaPublicKey!): creator.keys.mlDsaPublicKey!, try digest(member.keys.mlDsaPublicKey!): member.keys.mlDsaPublicKey!]
    } }

    /* `namingPersonal`: roster 1 also names the member's own drive as a family folder (a server or creator lying). */
    /*
     * Roster 1 also names this workspace (another's, a received share's) as a family folder, for a
     * fixture made inside `FamilyFixture.$naming.withValue`. A task-local, not a parameter: this
     * initializer's frame is close to the test thread's stack limit (ML-DSA keys), and one more
     * parameter crashed an unrelated test.
     */
    @TaskLocal static var naming: String?

    /* Every area key roster 1 names: the family folder's, and any other workspace a test has it name. */
    private static func areaKeys(_ workspaceId: String, _ areaKey: Data, _ rootKey: Data, also others: [String]) throws -> [AreaKey] {
        try [AreaKey(workspaceId: workspaceId, workspaceKey: areaKey, rootKey: rootKey)]
            + others.map { AreaKey(workspaceId: $0, workspaceKey: try randomBytes(length: 32), rootKey: try randomBytes(length: 32)) }
    }

    init(namingPersonal: Bool = false) throws {
        creator = try FamilyPerson()
        member = try FamilyPerson()
        groupId = try newId(kind: .group, scopeId: creator.userId).id
        groupSeed = groupSeedCreate()
        let area = try newId(kind: .workspace, scopeId: groupId)
        workspaceId = area.id
        workspaceSeed = area.seed
        areaKey = try randomBytes(length: 32)
        rootKey = try randomBytes(length: 32)
        let owner = try creator.entry([.billing, .members], since: 1)
        let first = try rosterFirst(groupId: groupId, kind: .family, creator: owner,
                                    areaKeys: try Self.areaKeys(workspaceId, areaKey, rootKey, also: [namingPersonal ? personal : nil, Self.naming].compactMap { $0 }),
                                    format: 2)
        r1 = try rosterSign(roster: first, groupSeed: groupSeed, signer: creator.keys)
        let (group, seed, signer) = (groupId, groupSeed, creator)
        func next(_ previous: SignedGroupStatement, version: UInt64, _ memberEntry: RosterMember) throws -> SignedGroupStatement {
            let members = [owner, memberEntry].sorted { $0.userId < $1.userId }
            let roster = Roster(groupId: group, kind: .family, rosterVersion: version, previousRosterDigest: rosterDigest(statement: previous.statement),
                                groupKeyVersion: 1, signerUserId: signer.userId, members: members, areas: [], format: 2)
            return try rosterSign(roster: roster, groupSeed: seed, signer: signer.keys)
        }
        r2 = try next(r1, version: 2, try member.entry([], since: 2))
        r3 = try next(r2, version: 3, try member.entry([.billing], since: 3))
        r3Fork = try next(r2, version: 3, try member.entry([.guardian], since: 3))
        r2Other = try next(r1, version: 2, try member.entry([.guardian], since: 2))
        r4Fork = try next(r3Fork, version: 4, try member.entry([], since: 4))

        // The creator's device grants the folder's key to the member at roster 2.
        guard case .accepted(let chain) = try acceptRosters(
            groupId: groupId, firstKeys: try groupPublicKey(seed: groupSeed), anchor: .created, pins: [], rosters: [r1, r2],
            successions: [], mlDsaKeys: [try digest(creator.keys.mlDsaPublicKey!): creator.keys.mlDsaPublicKey!], me: creator.own, cache: nil
        ) else { throw FamilyFailure(message: "the creator's chain didn't accept") }
        grant = try areaGrantSeal(
            workspaceKey: areaKey,
            ctx: AreaGrantContext(groupId: groupId, workspaceId: workspaceId, workspaceKeyVersion: 1, granteeUserId: member.userId,
                                  granteeKeyVersion: member.keys.keyVersion, granterUserId: creator.userId, rosterVersion: 2,
                                  rosterDigest: rosterDigest(statement: r2.statement)),
            chain: chain, areaIdSeed: workspaceSeed, granteeKemPublicKey: try base64urlDecode(value: member.keys.kemPublicKey!), granter: creator.keys
        )

        rootId = try newId(kind: .node, scopeId: workspaceId).id
        fileId = try newId(kind: .node, scopeId: workspaceId).id
        root = try Self.node(id: rootId, in: workspaceId, parent: nil, parentKey: areaKey, key: rootKey, kind: .folder, name: "Photos", writer: creator)
        fileKey = try randomBytes(length: 32)
        file = try Self.node(id: fileId, in: workspaceId, parent: rootId, parentKey: rootKey, key: fileKey, kind: .file,
                             name: "Recipes.txt", writer: creator, attributes: Self.attributes)
        personalKey = try randomBytes(length: 32)
        personalRootKey = try randomBytes(length: 32)
        personalRoot = try Self.node(id: try newId(kind: .node, scopeId: personal).id, in: personal, parent: nil, parentKey: personalKey, key: personalRootKey,
                                     kind: .folder, name: "Drive", writer: member)
        docsKey = try randomBytes(length: 32)
        docs = try Self.node(id: try newId(kind: .node, scopeId: workspaceId).id, in: workspaceId, parent: rootId, parentKey: rootKey, key: docsKey,
                             kind: .folder, name: "Docs", writer: creator, keyEpoch: 2)
        // The creator's photo: real content, sealed as an upload seals it, with a signed version.
        photoKey = try randomBytes(length: 32)
        let photoId = try newId(kind: .node, scopeId: workspaceId).id
        let bare = try Self.node(id: photoId, in: workspaceId, parent: rootId, parentKey: rootKey, key: photoKey, kind: .file, name: "Beach.jpg", writer: creator, keyEpoch: 3,
                                 attributes: Self.attributes)
        photoBytes = Data((0 ..< 3000).map { UInt8($0 % 251) })
        let versionId = try newId(kind: .version, scopeId: workspaceId).id
        let objectId = try newId(kind: .object, scopeId: workspaceId).id
        let contentKey = try randomBytes(length: 32)
        let nonce = try randomBytes(length: 16)
        let suite = HushOSCore.contentSuite()
        let size = UInt64(photoBytes.count)
        let content = Content(workspaceId: workspaceId, objectId: objectId, suite: suite, key: contentKey, nonce: nonce, plaintextSize: size, thumbnailBytes: 0)
        let layout = try contentLayout(suite: suite, plaintextSize: size, thumbnailBytes: 0)
        var object = Data()
        var at = 0
        for index in 0 ..< layout.chunkCount {
            let length = Int(chunkLength(plaintextSize: size, index: index))
            object.append(try chunkEncrypt(content: content, index: index, plaintext: photoBytes.subdata(in: at ..< at + length)))
            at += length
        }
        photoObject = object
        let sealed = try versionSeal(ctx: VersionContext(workspaceId: workspaceId, nodeId: photoId, versionId: versionId, objectId: objectId),
                                     nodeKey: photoKey, contentKey: contentKey, plaintextSize: size, thumbnailBytes: 0)
        let versionSignature = try versionSign(signingSeed: creator.keys.signingSeed,
                                               statement: VersionStatement(workspaceId: workspaceId, nodeId: photoId, versionId: versionId, objectId: objectId, contentSuite: suite),
                                               contentKeyEnvelope: sealed.envelope)
        var version = VersionView(id: versionId, objectId: objectId, contentKeyEnvelope: base64urlEncode(bytes: sealed.envelope), status: "ready", contentSuite: suite,
                                  chunkCount: Int(layout.chunkCount), contentNonce: base64urlEncode(bytes: nonce), plaintextSize: nil,
                                  ciphertextSize: String(object.count), readyAt: "2026-10-18T10:00:00.000Z")
        version.signer = Signer(id: creator.userId)
        version.signature = base64urlEncode(bytes: versionSignature)
        photo = bare.with(version: version)
    }

    /* What the fixture's file and photo carry beside their names: a colour, and a key no client knows yet. */
    static let attributes = ["colour": "green", "zz-unknown": "from a newer client"]

    /* A node wrapped under its parent (the area key at version 1 for the top folder) and signed by its writer. */
    static func node(id: String, in workspaceId: String, parent: String?, parentKey: Data, key: Data, kind: NodeKind, name: String, writer: FamilyPerson,
                     keyEpoch: UInt64 = 1, parentKeyEpoch: UInt64 = 1, attributes: [String: String] = [:]) throws -> NodeView {
        let wrapped = try nodeWrap(ctx: NodeKeyContext(workspaceId: workspaceId, nodeId: id, parentId: parent ?? workspaceId, parentKeyEpoch: parentKeyEpoch, keyEpoch: keyEpoch),
                                   parentKey: parentKey, nodeKey: key)
        let sealed = try metadataSeal(ctx: MetadataContext(workspaceId: workspaceId, nodeId: id, metadataVersion: 1), nodeKey: key,
                                      metadata: NodeMetadata(name: name, mime: kind == .file ? "text/plain" : nil, size: nil, modified: nil, attributes: attributes))
        let signature = try metadataSign(signingSeed: writer.keys.signingSeed,
                                         statement: MetadataStatement(workspaceId: workspaceId, nodeId: id, kind: kind, metadataVersion: 1), metadataEnvelope: sealed)
        var node = NodeView(id: id, workspaceId: workspaceId, parentId: parent, kind: kind == .folder ? "folder" : "file", keyEpoch: keyEpoch, parentKeyEpoch: parentKeyEpoch,
                            keyEnvelope: base64urlEncode(bytes: wrapped), metadataVersion: 1, metadataEnvelope: base64urlEncode(bytes: sealed),
                            currentVersion: nil, trashedAt: nil, changeSeq: 1, createdAt: "2026-10-18T10:00:00.000Z", updatedAt: "2026-10-18T10:00:00.000Z")
        node.metadataSigner = Signer(id: writer.userId)
        node.metadataSignature = base64urlEncode(bytes: signature)
        return node
    }

    /* The member's settings pin over `rosters`, as joining on the web left it. */
    func pin(through rosters: [SignedGroupStatement], checkedAt: String = "2026-10-18T09:00:00.000Z") throws -> GroupPin {
        guard case .accepted(let chain) = try acceptRosters(groupId: groupId, firstKeys: try firstKeys, anchor: .created, pins: [], rosters: rosters,
                                                           successions: [], mlDsaKeys: try signerKeys, me: member.own, cache: nil)
        else { throw FamilyFailure(message: "the member's chain didn't accept") }
        return try pinAfter(pins: [], chain: chain, checkedAt: checkedAt)
    }

    func server(chain: [SignedGroupStatement], pin: GroupPin) -> FamilyServer {
        let server = FamilyServer(family: self)
        server.serve(chain: chain)
        try? server.storeSettings(pin: pin)
        return server
    }

    /* The member's phone: a vault with their keys and drive, its own ledger, and FamilySync over the stub. */
    /* `account`: the session epoch its vault and sync are kept to (a test's own, so ending it touches no other test). */
    func phone(_ server: FamilyServer, records: FamilyRecords? = nil, guards: FamilyGuardStore? = nil, account: CopyEpoch = CopyEpoch()) async throws -> Phone {
        let session = SharedKeychain.Session(origin: "https://family.test", token: "t", userId: member.userId)
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [FamilyServerProtocol.self]
        FamilyServer.current = server
        Auth.testSession = session
        Auth.testTransport = configuration
        let api = DriveAPI(session: session, configuration: configuration)
        let vault = Vault(api: api, session: session, account: account)
        await vault.adopt(accountKey: member.root)
        await vault.adopt(identity: member.keys, envelope: member.envelope)
        // The personal workspace's grant names the account key's version, which a self-grant names too.
        let grant = GrantView(version: 1, workspaceId: personal, keyVersion: 1, workspaceKeyVersion: 1, wrappingSalt: "", wrappingNonce: "", encryptedKey: "")
        await vault.adopt(workspace: WorkspaceView(workspaceId: personal, changeSeq: nil, grant: grant, root: personalRoot), key: personalKey)
        let store = records ?? FamilyRecords(folder: FileManager.default.temporaryDirectory.appendingPathComponent("family-records-\(UUID().uuidString)"), activity: .expired)
        // The phone's family guard in a folder of the test's own: a relaunch passes the same one.
        let guards = guards ?? familyGuards(member)
        await vault.adopt(familyGuard: guards)
        // The contact guard in the same folder (a family check moves it): never the app group's.
        await vault.adopt(guard: ContactGuardStore(folder: guards.folder, owner: guards.owner, activity: .expired, generation: GuardGeneration()))
        var held = guards
        held.key = server.guardKey
        // Opened copies in a folder of the test's own, beside the guard: a relaunch passing the same guard finds them.
        let temporary = guards.folder.deletingLastPathComponent().appendingPathComponent(guards.folder.lastPathComponent + "-tmp", isDirectory: true)
        return Phone(vault: vault, sync: FamilySync(vault: vault, api: GroupsAPI(drive: api), records: store, temporary: temporary),
                     records: store, guards: guards, held: held, temporary: temporary)
    }

    struct Phone {
        let vault: Vault
        let sync: FamilySync
        let records: FamilyRecords
        let guards: FamilyGuardStore
        /* The same store under the settings key the phone seals it with: what a test reads it through. */
        let held: FamilyGuardStore
        let temporary: URL
        func done() { Auth.testSession = nil; Auth.testTransport = nil; FamilyServer.current = nil }
    }
}

/* A phone's family guard in a folder of the test's own, which a test can make refuse writes, as a full disk would. */
/*
 * `body` on a thread with an 8 MB stack: FamilyFixture's initializer (ML-DSA keys) sits close to a
 * test thread's limit, and a fixture made under a task-local's closure goes over it.
 */
func onLargeStack<T: Sendable>(_ body: @escaping @Sendable () throws -> T) async throws -> T {
    try await withCheckedThrowingContinuation { done in
        let thread = Thread { done.resume(with: Result { try body() }) }
        thread.stackSize = 8 << 20
        thread.start()
    }
}

func familyGuards(_ person: FamilyPerson, writes: GuardSwitch = GuardSwitch()) -> FamilyGuardStore {
    let folder = FileManager.default.temporaryDirectory.appendingPathComponent("family-guard-\(UUID().uuidString)", isDirectory: true)
    return FamilyGuardStore(folder: folder, owner: AccountOwner(userId: person.userId, origin: "https://family.test"), activity: .expired,
                            generation: GuardGeneration()) { writes.writable }
}

/* The group routes, the settings routes, and the family folder's and the member's own drive's tree, as the server has them. */
final class FamilyServer: @unchecked Sendable {
    nonisolated(unsafe) static var current: FamilyServer?
    let family: FamilyFixture
    let lock = NSLock()
    var chain: [SignedGroupStatement] = []
    /* Key changes, the change feed and route 20 (FamilyRotationStub). */
    let rotations = RotationStub()
    /* A manager's routes (FamilyManageStub). */
    let manage = ManageStub()
    private var ignoringAfter = false
    var notMember = false
    /* Route 2 lists the family (false: the server stopped listing it); `groupsFail` answers route 2 with a 503. */
    var listed = true
    var groupsFail = false
    /* Route 5 answers with a 503 (a server in trouble, never a refusal). */
    var rostersFail = false
    /* Route 3 answers not-member while route 5 still serves: removed between the two. */
    var detailNotMember = false
    /* Route 25 lists the family's folder (false: it was deleted, and the family's space lists no folder). */
    var areaListed = true
    /* Route 25 (the account's spaces) answers with a 503: a family accepted but its folders not opened yet. */
    var spacesFail = false
    /* Route 5 from version 1 answers not-member (a member check's own read), while a continuation still serves. */
    var notMemberFromStart = false
    var unauthorized = false
    /* Route 2's state for the member: `accepted` (waiting to be let in) or `active`. */
    var groupState = "active"
    /* Routes 14 and 15, answered with these when set (the invitation the member opens from the mailed link). */
    var invitationAnswer: (Int, Any)?
    var acceptAnswer: (Int, Any)?
    /*
     * Holds the answer to a key epoch request (a new folder's first await) until signalled, answered
     * off the loading thread so other requests go on meanwhile; `epochsArrived` is signalled as it comes in.
     */
    var holdEpochs: DispatchSemaphore?

    let epochsArrived = DispatchSemaphore(value: 0)
    /* Every request as it went out: method, the whole URL (query included) and the body's bytes. */
    private(set) var traffic: [(method: String, url: String, body: Data)] = []
    /* Every settings document a PUT stored, sealed as sent. */
    private(set) var savedSettings: [SettingsEnvelope] = []
    /* Runs as route 5 is answered: another process at work meanwhile. */
    var onRosters: (@Sendable () -> Void)?
    /* Runs once, after the first route 5 answer is built: the server or another device moves on meanwhile. */
    var afterRosters: (@Sendable () -> Void)?
    /* Runs once, as the first settings save arrives: another device saved first. */
    var beforePut: (@Sendable () -> Void)?
    /* Route 3's members, as a manager's view names them. */
    var members: [[String: Any]] = []
    /* Route 6 without the creator's identity: their account is gone (the folder's granter). */
    var granterGone = false
    /* The member's self-grant as route 23 stored it, served back on route 25. */
    var selfGrant: [String: Any]?
    /* Route 25's grant envelope and route 6's granter key as something that doesn't decode. */
    var malformedGrant = false
    /* The family folder's key version and the member's grant at it, as route 25 serves them. */
    var areaVersion: UInt64 = 1
    var areaGrant: (rosterVersion: UInt64, rosterDigest: String, envelope: Data)
    /* Every node either drive holds, by id: listings, route 25's top folder and every write go through it. */
    var tree: [String: NodeView] = [:]
    /* The node route 25 names as the family area's top folder (a server's choice): the family's own unless a test names another. */
    var servedRootId: String?
    /* Upload begins answered 409 `rotating` (a key change the server knows of), then 409 `stale`, before one is taken. */
    var rotatingBegins = 0
    var staleBegins = 0
    /* What the phone sent: each upload begin's body, by upload id, and each part it PUT, by upload and part. */
    private(set) var begins: [(id: String, body: [String: Any])] = []
    private(set) var parts: [String: [Int: Data]] = [:]
    private(set) var bodies: [(method: String, path: String, body: [String: Any])] = []
    /* Stored objects, by version id: what a ranged read of a version's URL is answered from. */
    var objects: [String: Data] = [:]
    /* Every part PUT, in order, by upload id and part number. */
    private(set) var putLog: [(uploadId: String, part: Int)] = []
    /* The completed node served with a key envelope nothing opens: an upload that lands but whose row won't open here. */
    var corruptCompletedNode = false
    /* Canned answers, taken one per request before the route's own: begins, completions, name records. */
    var beginAnswers: [(Int, [String: Any])] = []
    var completeAnswers: [(Int, [String: Any])] = []
    var metadataAnswers: [(Int, [String: Any])] = []
    /* Completions made but answered with a 503, as if the answer was lost on the way. */
    var loseCompletions = 0
    /* Uploads completed: a second completion answers `completed` with the node as it is, as the server's startCompleting. */
    private var completed: Set<String> = []
    private var nextEpoch: UInt64 = 10
    private var requests: [(method: String, path: String)] = []
    private let settingsKey: Data
    private let settingsKeyEnvelope: SettingsKeyEnvelope
    private var settings: SettingsEnvelope?

    init(family: FamilyFixture) {
        self.family = family
        let made = try! settingsKeyCreate(userId: family.member.userId, accountKey: family.member.root)
        settingsKey = made.key
        settingsKeyEnvelope = made.envelope
        areaGrant = (2, rosterDigest(statement: family.r2.statement), family.grant)
        for node in [family.root, family.file, family.personalRoot] { tree[node.id] = node }
    }

    func serve(chain: [SignedGroupStatement], ignoringAfter: Bool = false) {
        lock.withLock { self.chain = chain; self.ignoringAfter = ignoringAfter }
    }

    func put(_ nodes: NodeView...) { lock.withLock { for node in nodes { tree[node.id] = node } } }
    func node(_ id: String) -> NodeView? { lock.withLock { tree[id] } }

    func clearRequests() { lock.withLock { requests = []; bodies = [] } }

    func requested(_ path: String, method: String = "GET") -> Bool {
        lock.withLock { requests.contains { $0.path == path && $0.method == method } }
    }

    func count(_ path: String, method: String = "GET") -> Int {
        lock.withLock { requests.filter { $0.path == path && $0.method == method }.count }
    }

    /* The bodies sent to `path` with `method`, in order. */
    func sent(_ path: String, method: String = "POST") -> [[String: Any]] {
        lock.withLock { bodies.filter { $0.path == path && $0.method == method }.map(\.body) }
    }

    var allBegins: [(id: String, body: [String: Any])] { lock.withLock { begins } }
    func putParts(_ uploadId: String) -> [Int: Data] { lock.withLock { parts[uploadId] ?? [:] } }

    /* Anything but a read: a write the phone must never send. */
    var writes: [String] { lock.withLock { requests.filter { $0.method != "GET" && !$0.path.hasPrefix("/api/auth/settings") && !$0.path.hasSuffix("/self-grant") }.map(\.path) } }

    /* The member's settings document, sealed one version above what is stored, holding `pin` for the family. */
    func storeSettings(pin: GroupPin?, contacts: [ContactPin] = []) throws {
        var document = Settings()
        if let pin { document.setGroupPin(family.groupId, pin) }
        for contact in contacts { document.setPin(contact) }
        let next = (lock.withLock { settings?.settingsVersion } ?? 0) + 1
        let sealed = try settingsSeal(userId: family.member.userId, settingsKey: settingsKey, settingsVersion: next, json: try document.json())
        lock.withLock { settings = sealed }
    }

    /* The settings key and its envelope, as the phone's guards are sealed under it. */
    var guardKey: MarksKey { MarksKey(key: settingsKey, envelope: settingsKeyEnvelope) }

    /* A whole settings document, sealed one version above what is stored (fields other clients write included). */
    func storeSettings(document: Settings) throws {
        let next = (lock.withLock { settings?.settingsVersion } ?? 0) + 1
        let sealed = try settingsSeal(userId: family.member.userId, settingsKey: settingsKey, settingsVersion: next, json: try document.json())
        lock.withLock { settings = sealed }
    }

    /* What the server holds now, served again when the returned call runs: a server replaying an older copy (a rollback). */
    func settingsSnapshot() -> @Sendable () -> Void {
        let held = lock.withLock { settings }
        return { self.lock.withLock { self.settings = held } }
    }

    /* Another device's save: the stored settings opened, changed, and sealed one version above. */
    func editSettings(_ change: (inout Settings) throws -> Void) throws {
        guard let envelope = lock.withLock({ settings }),
              let json = try settingsOpen(userId: family.member.userId, settingsKey: settingsKey, envelope: envelope) else { return }
        var document = try Settings(json: json, version: envelope.settingsVersion)
        try change(&document)
        try storeSettings(document: document)
    }

    /* The stored settings document, opened. */
    func storedDocument() throws -> [String: Any]? {
        guard let envelope = lock.withLock({ settings }),
              let json = try settingsOpen(userId: family.member.userId, settingsKey: settingsKey, envelope: envelope) else { return nil }
        return try JSONSerialization.jsonObject(with: Data(json.utf8)) as? [String: Any]
    }

    /* Every settings document the phone saved, opened: what it wrote into the account's own sealed settings. */
    func savedDocuments() throws -> [String] {
        try lock.withLock { savedSettings }.compactMap { try settingsOpen(userId: family.member.userId, settingsKey: settingsKey, envelope: $0) }
    }

    /* The family's pin as the stored settings hold it. */
    func storedPin(_ family: FamilyFixture) throws -> GroupPin? {
        guard let envelope = lock.withLock({ settings }),
              let json = try settingsOpen(userId: family.member.userId, settingsKey: settingsKey, envelope: envelope) else { return nil }
        return try Settings(json: json, version: envelope.settingsVersion).groupPin(family.groupId)
    }

    private func wire(_ signed: SignedGroupStatement, version: Int) -> [String: Any] {
        ["version": version, "statement": base64urlEncode(bytes: signed.statement),
         "signature": ["ed25519": base64urlEncode(bytes: signed.signature.ed25519), "mlDsa": base64urlEncode(bytes: signed.signature.mlDsa)],
         "signerSignature": base64urlEncode(bytes: signed.signerSignature)]
    }

    private func json(_ node: NodeView) -> Any {
        (try? JSONSerialization.jsonObject(with: JSONEncoder().encode(node))) ?? [:]
    }

    private func identity(_ person: FamilyPerson) -> [String: Any] {
        let keys = person.keys
        return ["userId": person.userId, "links": [Any](),
                "identity": ["keyVersion": keys.keyVersion, "encryptionPublicKey": keys.encryptionPublicKey, "signingPublicKey": keys.signingPublicKey,
                             "mlDsaPublicKey": keys.mlDsaPublicKey!, "kemPublicKey": keys.kemPublicKey!, "keysSignature": ""]]
    }

    /*
     * A folder's listing from the tree: its ancestors top first, and its children not in the trash.
     * Asked in another workspace than the folder's, none, as the server answers (no such node there).
     */
    private func listing(_ id: String, in workspaceId: String) -> (Int, Any) {
        lock.withLock {
            guard let folder = tree[id], workspaceId.isEmpty || folder.workspaceId.lowercased() == workspaceId.lowercased() else {
                return (404, ["message": "This item no longer exists."])
            }
            // In or under the trash: the server lists none of it.
            if underTrash(id) { return (409, ["code": "trashed", "message": "This item is in the trash. Restore it first."]) }
            var ancestors: [NodeView] = []
            var cursor = folder.parentId
            while let parent = cursor, let node = tree[parent] { ancestors.insert(node, at: 0); cursor = node.parentId }
            let children = tree.values.filter { $0.parentId == id && $0.trashedAt == nil }.sorted { $0.id < $1.id }
            return (200, ["folder": json(folder), "ancestors": ancestors.map(json), "children": children.map(json), "nextCursor": NSNull()])
        }
    }

    /* A node a write made, as the server stores it: the envelopes it was sent, signed by the member. */
    private func made(_ body: [String: Any], workspaceId: String, kind: String, version: VersionView? = nil) -> NodeView {
        var node = NodeView(id: body["id"] as? String ?? "", workspaceId: workspaceId, parentId: body["parentId"] as? String, kind: kind,
                            keyEpoch: (body["keyEpoch"] as? NSNumber)?.uint64Value ?? 0, parentKeyEpoch: (body["parentKeyEpoch"] as? NSNumber)?.uint64Value ?? 0,
                            keyEnvelope: body["keyEnvelope"] as? String ?? "", metadataVersion: 1, metadataEnvelope: body["metadataEnvelope"] as? String ?? "",
                            currentVersion: version, trashedAt: nil, changeSeq: 3, createdAt: "2026-10-19T10:00:00.000Z", updatedAt: "2026-10-19T10:00:00.000Z")
        node.metadataSigner = Signer(id: family.member.userId)
        node.metadataSignature = body["metadataSignature"] as? String
        return node
    }

    func answer(_ request: URLRequest, body: Data?) -> (Int, Any) {
        let path = request.url?.path ?? ""
        let method = request.httpMethod ?? "GET"
        let sent = body.flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: Any] } ?? [:]
        lock.withLock {
            requests.append((method, path))
            traffic.append((method, request.url?.absoluteString ?? "", body ?? Data()))
            if method != "GET" { bodies.append((method, path, sent)) }
        }
        let query = URLComponents(url: request.url!, resolvingAgainstBaseURL: false)?.queryItems ?? []
        let f = family
        let parts = path.split(separator: "/").map(String.init)
        // The object store: a part PUT, a ranged read of a version.
        if request.url?.host == "store.test" {
            if method == "PUT", parts.count == 2 {
                lock.withLock {
                    self.parts[parts[0], default: [:]][Int(parts[1]) ?? 0] = body ?? Data()
                    putLog.append((parts[0], Int(parts[1]) ?? 0))
                }
                return (200, Data())
            }
            guard parts.count == 1, let object = lock.withLock({ objects[parts[0]] }) else { return (404, Data()) }
            let range = (request.value(forHTTPHeaderField: "Range") ?? "").dropFirst("bytes=".count).split(separator: "-").compactMap { Int($0) }
            guard range.count == 2 else { return (200, object) }
            return (206, object.subdata(in: range[0] ..< min(range[1] + 1, object.count)))
        }
        // The session ended: every group route answers 401.
        if path.hasPrefix("/api/groups"), lock.withLock({ unauthorized }) { return (401, ["message": "Sign in."]) }
        if let routed = rotationRoute(method: method, path: path, sent: sent, query: query) { return routed }
        if let routed = manageRoute(request, method: method, path: path, body: body, sent: sent) { return routed }
        switch (method, path) {
        case ("GET", "/api/auth/settings"):
            return lock.withLock {
                guard let settings else { return (200, ["settingsVersion": 0]) }
                return (200, ["settingsVersion": settings.settingsVersion,
                              "settings": ["version": settings.version, "settingsVersion": settings.settingsVersion, "nonce": settings.nonce, "ciphertext": settings.ciphertext],
                              "settingsKey": Auth.json(settingsKeyEnvelope)])
            }
        case ("PUT", "/api/auth/settings"):
            let hook = lock.withLock { () -> (@Sendable () -> Void)? in defer { beforePut = nil }; return beforePut }
            hook?()
            return lock.withLock {
                let expected = (sent["expectedVersion"] as? NSNumber)?.uint64Value ?? 0
                guard expected == (settings?.settingsVersion ?? 0) else { return (409, ["message": "Your settings changed on another device."]) }
                settings = SettingsEnvelope(version: UInt32((sent["version"] as? NSNumber)?.intValue ?? 2), settingsVersion: expected + 1,
                                            nonce: sent["nonce"] as? String ?? "", ciphertext: sent["ciphertext"] as? String ?? "")
                savedSettings.append(settings!)
                return (200, ["settingsVersion": expected + 1])
            }
        case ("GET", "/api/groups/\(f.groupId)/rosters"):
            if notMember { return (404, ["code": "not-member", "message": "You are not in this group."]) }
            if lock.withLock({ rostersFail }) { return (503, ["message": "Drive is temporarily unavailable. Please try again."]) }
            let after = Int(query.first { $0.name == "after" }?.value ?? "0") ?? 0
            if after == 0, lock.withLock({ notMemberFromStart }) { return (404, ["code": "not-member", "message": "You are not in this group."]) }
            onRosters?()
            let answer: (Int, Any) = lock.withLock {
                let rosters = chain.enumerated().filter { ignoringAfter || $0.offset + 1 > after }.map { wire($0.element, version: $0.offset + 1) }
                return (200, ["rosters": rosters, "successions": [Any](),
                              "firstKeys": ["ed25519PublicKey": (try? f.firstKeys.ed25519PublicKey) ?? "", "mlDsaPublicKey": (try? f.firstKeys.mlDsaPublicKey) ?? ""],
                              "signerKeys": (try? f.signerKeys) ?? [:], "head": ["version": chain.count, "digest": ""], "next": NSNull()])
            }
            let next = lock.withLock { () -> (@Sendable () -> Void)? in defer { afterRosters = nil }; return afterRosters }
            next?()
            return answer
        case ("POST", "/api/invitations/open"):
            return lock.withLock { invitationAnswer } ?? (410, ["code": "gone", "message": "This invitation is no longer open."] as [String: Any])
        case ("POST", "/api/invitations/accept"):
            return lock.withLock { acceptAnswer } ?? (410, ["code": "gone", "message": "This invitation is no longer open."] as [String: Any])
        case ("GET", "/api/groups"):
            if lock.withLock({ groupsFail }) { return (503, ["message": "Drive is temporarily unavailable. Please try again."]) }
            if !lock.withLock({ listed }) { return (200, ["groups": [Any]()]) }
            return (200, ["groups": [["id": f.groupId, "kind": "family", "name": "Lindqvist family", "roles": lock.withLock { manage.listedRoles }, "state": lock.withLock { groupState },
                                      "rosterVersion": lock.withLock { chain.count }, "groupKeyVersion": 1]]])
        case ("GET", "/api/groups/\(f.groupId)"):
            if lock.withLock({ detailNotMember }) { return (404, ["code": "not-member", "message": "You are not in this group."]) }
            return (200, ["members": lock.withLock { members }, "seats": ["used": 2, "limit": 6],
                          "head": lock.withLock { ["version": chain.count, "revision": chain.count] }])
        case ("GET", "/api/groups/\(f.groupId)/identities"):
            var creator = identity(f.creator)
            if lock.withLock({ granterGone }) { creator["identity"] = NSNull() }
            if lock.withLock({ malformedGrant }), var keys = creator["identity"] as? [String: Any] {
                keys["mlDsaPublicKey"] = "not base64url!"
                creator["identity"] = keys
            }
            let others = lock.withLock { manage.people.values.map { identity($0.person) } }
            return (200, ["identities": ([creator, identity(f.member)] + others).sorted { ($0["userId"] as! String) < ($1["userId"] as! String) }, "next": NSNull()])
        case ("PUT", "/api/groups/\(f.groupId)/areas/\(f.workspaceId)/self-grant"):
            return lock.withLock {
                guard let grant = sent["grant"] as? [String: Any], (grant["workspaceKeyVersion"] as? NSNumber)?.uint64Value == areaVersion else {
                    return (409, ["code": "area-moved", "message": "This folder's key changed."])
                }
                selfGrant = grant
                return (200, ["ok": true])
            }
        case ("GET", "/api/drive/spaces"):
            if lock.withLock({ spacesFail }) { return (503, ["message": "Drive is temporarily unavailable. Please try again."]) }
            return lock.withLock {
                (200, ["spaces": [
                    ["space": ["kind": "personal"], "areas": [["workspaceId": f.personal, "workspaceKeyVersion": 1, "changeSeq": 0, "root": NSNull(), "rotation": NSNull()]]],
                    ["space": ["kind": "group", "groupId": f.groupId, "name": "Lindqvist family"], "areas": !areaListed ? [] : [[
                        "workspaceId": f.workspaceId, "idSeed": f.workspaceSeed, "workspaceKeyVersion": areaVersion, "changeSeq": 2,
                        "root": tree[servedRootId ?? f.rootId].map(json) ?? NSNull(), "rotation": rotationJSON(),
                        "grant": ["workspaceKeyVersion": areaVersion, "granteeKeyVersion": f.member.keys.keyVersion, "granterUserId": f.creator.userId,
                                  "rosterVersion": areaGrant.rosterVersion, "rosterDigest": areaGrant.rosterDigest,
                                  "envelope": malformedGrant ? "not base64url!" : base64urlEncode(bytes: areaGrant.envelope)],
                        "selfGrant": (selfGrant as Any?) ?? NSNull(),
                    ]]],
                ]])
            }
        default:
            break
        }
        // Drive: listings, the writes a family folder takes, uploads and versions.
        let workspaceId = sent["workspaceId"] as? String ?? query.first { $0.name == "workspaceId" }?.value ?? ""
        switch (method, parts.count >= 3 ? Array(parts.dropFirst(2)) : []) {
        case ("GET", let rest) where rest.count == 3 && rest[0] == "nodes" && rest[2] == "children":
            return listing(rest[1], in: workspaceId)
        case ("POST", let rest) where rest.count == 3 && rest[0] == "workspaces" && rest[2] == "epochs":
            return lock.withLock {
                let count = (sent["count"] as? NSNumber)?.uint64Value ?? 1
                defer { nextEpoch += count }
                return (200, ["from": nextEpoch, "to": nextEpoch + count - 1])
            }
        case ("POST", ["folders"]):
            let folders = (sent["folders"] as? [[String: Any]] ?? []).map { made($0, workspaceId: workspaceId, kind: "folder") }
            lock.withLock { for folder in folders { tree[folder.id] = folder } }
            return (200, ["nodes": folders.map(json)])
        case ("POST", let rest) where rest.count == 3 && rest[0] == "nodes":
            return lock.withLock {
                guard let node = tree[rest[1]] else { return (404, ["message": "This item no longer exists."]) }
                let changed: NodeView
                if rest[2] == "metadata", !metadataAnswers.isEmpty { return metadataAnswers.removeFirst() }
                switch rest[2] {
                case "metadata":
                    changed = node.with(metadataVersion: node.metadataVersion + 1, metadataEnvelope: sent["metadataEnvelope"] as? String ?? "",
                                        signature: sent["metadataSignature"] as? String)
                case "parent":
                    changed = node.with(parentId: sent["parentId"] as? String, parentKeyEpoch: (sent["parentKeyEpoch"] as? NSNumber)?.uint64Value ?? 0,
                                        keyEnvelope: sent["keyEnvelope"] as? String ?? "")
                case "trash":
                    changed = node.with(trashedAt: "2026-10-19T10:00:00.000Z")
                case "restore":
                    changed = node.with(trashedAt: nil)
                default:
                    return (404, ["message": "Not here."])
                }
                tree[changed.id] = changed
                return (200, ["node": json(changed)])
            }
        case ("POST", let rest) where rest.count == 3 && rest[0] == "workspaces" && (rest[2] == "trash-batch" || rest[2] == "restore-batch"):
            // A selection to the trash, or back in place: per-item answers, as the server's batch routes give them.
            return lock.withLock {
                let trashing = rest[2] == "trash-batch"
                let at: String? = trashing ? "2026-10-19T10:00:00.000Z" : nil
                let results: [[String: Any]] = (sent["nodeIds"] as? [String] ?? []).map { id in
                    guard let node = tree[id], node.workspaceId.lowercased() == rest[1].lowercased() else {
                        return ["id": id, "status": "refused", "reason": "not-found", "message": "This item no longer exists."]
                    }
                    let changed = node.with(trashedAt: .some(at))
                    tree[id] = changed
                    let seq = changed.changeSeq ?? 0
                    return trashing ? ["id": id, "status": "trashed", "trashedAt": at ?? "", "changeSeq": seq] : ["id": id, "status": "restored", "changeSeq": seq]
                }
                return (200, ["results": results])
            }
        case ("POST", ["uploads"]):
            return lock.withLock {
                if rotatingBegins > 0 {
                    rotatingBegins -= 1
                    return (409, ["code": "rotating", "message": "Keys are being rotated for this folder. Try again in a moment."])
                }
                if staleBegins > 0 {
                    staleBegins -= 1
                    return (409, ["code": "stale", "message": "This item changed since you last saw it. Refresh and try again."])
                }
                if !beginAnswers.isEmpty { return beginAnswers.removeFirst() }
                let id = UUID().uuidString.lowercased()
                begins.append((id, sent))
                let count = (sent["chunkCount"] as? NSNumber)?.intValue ?? 1
                let node = sent["node"] as? [String: Any] ?? [:]
                return (200, ["upload": ["id": id, "nodeId": node["id"] as? String ?? "", "versionId": sent["versionId"] as? String ?? "", "status": "pending", "chunkCount": count],
                              "parts": (1 ... count).map { ["partNumber": $0, "length": 0, "url": "https://store.test/\(id)/\($0)"] },
                              "urlExpiresAt": "2026-10-19T11:00:00.000Z"])
            }
        case ("POST", let rest) where rest.count == 3 && rest[0] == "uploads" && rest[2] == "complete":
            return lock.withLock {
                guard let begun = begins.first(where: { $0.id == rest[1] })?.body, let node = begun["node"] as? [String: Any] else { return (404, ["message": "No upload."]) }
                if !completeAnswers.isEmpty { return completeAnswers.removeFirst() }
                if completed.contains(rest[1]) { return (200, ["status": "completed", "node": json(tree[node["id"] as? String ?? ""]!)]) }
                // As the server's finishCompleting: a node (or its folder) re-keyed while the parts were in flight is conflicted.
                let existing = node["existing"] as? Bool == true
                let id = node["id"] as? String ?? ""
                let moved: Bool
                if existing {
                    moved = tree[id]?.keyEpoch != (node["keyEpoch"] as? NSNumber)?.uint64Value
                } else {
                    moved = tree[node["parentId"] as? String ?? ""]?.keyEpoch != (node["parentKeyEpoch"] as? NSNumber)?.uint64Value
                }
                if moved { return (409, ["code": "conflict", "message": "This file changed while it was uploading.", "data": ["conflicted": true]]) }
                let version = VersionView(id: begun["versionId"] as? String ?? "", objectId: begun["objectId"] as? String ?? "",
                                          contentKeyEnvelope: begun["contentKeyEnvelope"] as? String ?? "", status: "ready",
                                          contentSuite: UInt32((begun["contentSuite"] as? NSNumber)?.intValue ?? 3), chunkCount: (begun["chunkCount"] as? NSNumber)?.intValue ?? 1,
                                          contentNonce: begun["contentNonce"] as? String ?? "", plaintextSize: nil, ciphertextSize: begun["ciphertextSize"] as? String,
                                          readyAt: "2026-10-19T10:00:00.000Z")
                var landed = existing ? tree[id]!.with(version: version) : made(node, workspaceId: begun["workspaceId"] as? String ?? "", kind: "file", version: version)
                tree[landed.id] = landed
                completed.insert(rest[1])
                if loseCompletions > 0 {
                    loseCompletions -= 1
                    return (503, ["message": "Drive is temporarily unavailable. Please try again."])
                }
                if corruptCompletedNode { landed = landed.with(keyEnvelope: base64urlEncode(bytes: Data(repeating: 0, count: 72))) }
                return (200, ["status": "complete", "node": json(landed)])
            }
        case ("POST", let rest) where rest.count == 3 && rest[0] == "uploads" && rest[2] == "abort":
            return (200, ["status": "aborted"])
        case ("GET", ["thumbnails"]):
            // Where each version's object is: its thumbnail trailer is read from the tail of it.
            let ids = (query.first { $0.name == "versions" }?.value ?? "").split(separator: ",").map(String.init)
            return (200, ["urls": ids.map { ["versionId": $0, "url": "https://store.test/\($0)"] }])
        case ("GET", let rest) where rest.count == 3 && rest[0] == "versions" && rest[2] == "url":
            return (200, ["url": "https://store.test/\(rest[1])", "urlExpiresAt": "2026-10-19T11:00:00.000Z"])
        default:
            return (404, ["message": "Not here."])
        }
    }
}

extension NodeView {
    /* The same row with some of its fields as a write left them. */
    func with(parentId: String?? = nil, parentKeyEpoch: UInt64? = nil, keyEpoch: UInt64? = nil, keyEnvelope: String? = nil, metadataVersion: UInt64? = nil,
              metadataEnvelope: String? = nil, signature: String?? = nil, version: VersionView?? = nil, trashedAt: String?? = nil,
              prev: (envelope: String, epoch: UInt64, parentEpoch: UInt64)?? = nil) -> NodeView {
        var node = NodeView(id: id, workspaceId: workspaceId, parentId: parentId ?? self.parentId, kind: kind, keyEpoch: keyEpoch ?? self.keyEpoch,
                            parentKeyEpoch: parentKeyEpoch ?? self.parentKeyEpoch, keyEnvelope: keyEnvelope ?? self.keyEnvelope,
                            metadataVersion: metadataVersion ?? self.metadataVersion, metadataEnvelope: metadataEnvelope ?? self.metadataEnvelope,
                            currentVersion: version ?? currentVersion, trashedAt: trashedAt ?? self.trashedAt, changeSeq: (changeSeq ?? 0) + 1,
                            createdAt: createdAt, updatedAt: updatedAt)
        node.envelopeSuite = envelopeSuite
        node.metadataSigner = metadataSigner
        node.metadataSignature = signature ?? metadataSignature
        node.metadataRekey = metadataRekey
        let previous = prev ?? (prevKeyEnvelope.map { ($0, prevKeyEpoch ?? 0, prevParentKeyEpoch ?? 0) })
        node.prevKeyEnvelope = previous?.envelope
        node.prevKeyEpoch = previous?.epoch
        node.prevParentKeyEpoch = previous?.parentEpoch
        return node
    }
}

final class FamilyServerProtocol: URLProtocol {
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
        let server = FamilyServer.current
        let (status, json) = server?.answer(request, body: body) ?? (500, ["message": "No server"])
        if let server, request.httpMethod == "POST", request.url?.path.hasSuffix("/rotation/nodes") == true,
           server.lock.withLock({ () -> Bool in defer { server.rotations.holding = false }; return server.rotations.holding }) {
            server.rotations.arrived.signal()
            DispatchQueue.global().async {
                server.rotations.release.wait()
                self.deliver(status, json)
            }
            return
        }
        if let server, let hold = server.holdEpochs, request.httpMethod == "POST", request.url?.path.hasSuffix("/epochs") == true {
            server.epochsArrived.signal()
            DispatchQueue.global().async {
                hold.wait()
                self.deliver(status, json)
            }
            return
        }
        deliver(status, json)
    }

    private func deliver(_ status: Int, _ json: Any) {
        var headers = ["Content-Type": json is Data ? "application/octet-stream" : "application/json"]
        // The store answers a part PUT with its ETag.
        if request.url?.host == "store.test", request.httpMethod == "PUT" { headers["ETag"] = "\"etag-\(request.url?.lastPathComponent ?? "")\"" }
        let response = HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: "HTTP/1.1", headerFields: headers)!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: (json as? Data) ?? (try? JSONSerialization.data(withJSONObject: json)) ?? Data())
        client?.urlProtocolDidFinishLoading(self)
    }

    override func stopLoading() {}
}

final class FoundState: @unchecked Sendable {
    private let lock = NSLock()
    private var held: FamilyState?
    var value: FamilyState? {
        get { lock.withLock { held } }
        set { lock.withLock { held = newValue } }
    }
}

extension Vault {
    /* Tests: a step run after a listing page arrives and before it is opened. */
    func listingPage(_ hook: (@Sendable () async -> Void)?) { afterListingPage = hook }
}
