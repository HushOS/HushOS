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
            // The core holds the family's keys back after the fork: the listing is refused there, not by the app.
            do {
                _ = try await phone.vault.children(of: family.rootId)
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
            let newer = FamilyRecords.Row(envelope: "sealed-at-roster-3", rosterVersion: 3, areas: [family.workspaceId])
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
    var signerKeys: [String: String] { get throws { [try digest(creator.keys.mlDsaPublicKey!): creator.keys.mlDsaPublicKey!] } }

    init() throws {
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
                                    areaKeys: [AreaKey(workspaceId: workspaceId, workspaceKey: areaKey, rootKey: rootKey)], format: 2)
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
                             name: "Recipes.txt", writer: creator)
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
        let bare = try Self.node(id: photoId, in: workspaceId, parent: rootId, parentKey: rootKey, key: photoKey, kind: .file, name: "Beach.jpg", writer: creator, keyEpoch: 3)
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

    /* A node wrapped under its parent (the area key at version 1 for the top folder) and signed by its writer. */
    static func node(id: String, in workspaceId: String, parent: String?, parentKey: Data, key: Data, kind: NodeKind, name: String, writer: FamilyPerson,
                     keyEpoch: UInt64 = 1, parentKeyEpoch: UInt64 = 1) throws -> NodeView {
        let wrapped = try nodeWrap(ctx: NodeKeyContext(workspaceId: workspaceId, nodeId: id, parentId: parent ?? workspaceId, parentKeyEpoch: parentKeyEpoch, keyEpoch: keyEpoch),
                                   parentKey: parentKey, nodeKey: key)
        let sealed = try metadataSeal(ctx: MetadataContext(workspaceId: workspaceId, nodeId: id, metadataVersion: 1), nodeKey: key,
                                      metadata: NodeMetadata(name: name, mime: kind == .file ? "text/plain" : nil, size: nil, modified: nil))
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
    func phone(_ server: FamilyServer, records: FamilyRecords? = nil) async throws -> Phone {
        let session = SharedKeychain.Session(origin: "https://family.test", token: "t", userId: member.userId)
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [FamilyServerProtocol.self]
        FamilyServer.current = server
        Auth.testSession = session
        Auth.testTransport = configuration
        let api = DriveAPI(session: session, configuration: configuration)
        let vault = Vault(api: api, session: session)
        await vault.adopt(accountKey: member.root)
        await vault.adopt(identity: member.keys, envelope: member.envelope)
        // The personal workspace's grant names the account key's version, which a self-grant names too.
        let grant = GrantView(version: 1, workspaceId: personal, keyVersion: 1, workspaceKeyVersion: 1, wrappingSalt: "", wrappingNonce: "", encryptedKey: "")
        await vault.adopt(workspace: WorkspaceView(workspaceId: personal, changeSeq: nil, grant: grant, root: personalRoot), key: personalKey)
        let store = records ?? FamilyRecords(folder: FileManager.default.temporaryDirectory.appendingPathComponent("family-records-\(UUID().uuidString)"), activity: .expired)
        return Phone(vault: vault, sync: FamilySync(vault: vault, api: GroupsAPI(drive: api), records: store), records: store)
    }

    struct Phone {
        let vault: Vault
        let sync: FamilySync
        let records: FamilyRecords
        func done() { Auth.testSession = nil; Auth.testTransport = nil; FamilyServer.current = nil }
    }
}

/* The group routes, the settings routes, and the family folder's and the member's own drive's tree, as the server has them. */
final class FamilyServer: @unchecked Sendable {
    nonisolated(unsafe) static var current: FamilyServer?
    let family: FamilyFixture
    private let lock = NSLock()
    private var chain: [SignedGroupStatement] = []
    private var ignoringAfter = false
    var notMember = false
    /* Route 2's state for the member: `accepted` (waiting to be let in) or `active`. */
    var groupState = "active"
    /* Routes 14 and 15, answered with these when set (the invitation the member opens from the mailed link). */
    var invitationAnswer: (Int, Any)?
    var acceptAnswer: (Int, Any)?
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

    /* A folder's listing from the tree: its ancestors top first, and its children not in the trash. */
    private func listing(_ id: String) -> (Int, Any) {
        lock.withLock {
            guard let folder = tree[id] else { return (404, ["message": "This item no longer exists."]) }
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
            onRosters?()
            let after = Int(query.first { $0.name == "after" }?.value ?? "0") ?? 0
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
            return (200, ["groups": [["id": f.groupId, "kind": "family", "name": "Lindqvist family", "roles": [String](), "state": lock.withLock { groupState },
                                      "rosterVersion": lock.withLock { chain.count }, "groupKeyVersion": 1]]])
        case ("GET", "/api/groups/\(f.groupId)"):
            return (200, ["members": lock.withLock { members }, "seats": ["used": 2, "limit": 6]])
        case ("GET", "/api/groups/\(f.groupId)/identities"):
            var creator = identity(f.creator)
            if lock.withLock({ granterGone }) { creator["identity"] = NSNull() }
            if lock.withLock({ malformedGrant }), var keys = creator["identity"] as? [String: Any] {
                keys["mlDsaPublicKey"] = "not base64url!"
                creator["identity"] = keys
            }
            return (200, ["identities": [creator, identity(f.member)].sorted { ($0["userId"] as! String) < ($1["userId"] as! String) }, "next": NSNull()])
        case ("PUT", "/api/groups/\(f.groupId)/areas/\(f.workspaceId)/self-grant"):
            return lock.withLock {
                guard let grant = sent["grant"] as? [String: Any], (grant["workspaceKeyVersion"] as? NSNumber)?.uint64Value == areaVersion else {
                    return (409, ["code": "area-moved", "message": "This folder's key changed."])
                }
                selfGrant = grant
                return (200, ["ok": true])
            }
        case ("GET", "/api/drive/spaces"):
            return lock.withLock {
                (200, ["spaces": [
                    ["space": ["kind": "personal"], "areas": [["workspaceId": f.personal, "workspaceKeyVersion": 1, "changeSeq": 0, "root": NSNull(), "rotation": NSNull()]]],
                    ["space": ["kind": "group", "groupId": f.groupId, "name": "Lindqvist family"], "areas": [[
                        "workspaceId": f.workspaceId, "idSeed": f.workspaceSeed, "workspaceKeyVersion": areaVersion, "changeSeq": 2,
                        "root": tree[f.rootId].map(json) ?? NSNull(), "rotation": NSNull(),
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
            return listing(rest[1])
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
        let (status, json) = FamilyServer.current?.answer(request, body: body) ?? (500, ["message": "No server"])
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
