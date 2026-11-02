import Foundation
import HushOSCore
import Testing
@testable import HushOSKit

/*
 * Members' due work (docs/groups-mobile-plan.md iOS 4): a key change a manager's member-list
 * change left in a family folder, walked by the member's phone against the stub server with real
 * rosters and the core's ledger. The folder holds a subfolder (`docs`) with a file under it
 * (`deep`), a file and a photo with content at the top. Each test fails on the defect it names.
 */
extension OnFakeDrive {
    @Suite struct FamilyWalkTests {
        /* The family with a folder and a file under it, and the photo's content on the store. */
        static func walkable() async throws -> (FamilyFixture, FamilyServer, NodeView) {
            // Made on a large stack: the fixture's frame is close to the test thread's limit (ML-DSA keys).
            let family = try await onLargeStack { try FamilyFixture() }
            let server = family.server(chain: [family.r1, family.r2], pin: try family.pin(through: [family.r1, family.r2]))
            let deep = try FamilyFixture.node(id: try newId(kind: .node, scopeId: family.workspaceId).id, in: family.workspaceId, parent: family.docs.id,
                                              parentKey: family.docsKey, key: try randomBytes(length: 32), kind: .file, name: "Packing.txt",
                                              writer: family.creator, parentKeyEpoch: family.docs.keyEpoch)
            server.put(family.docs, deep, family.photo)
            server.objects[family.photo.currentVersion!.id] = family.photoObject
            return (family, server, deep)
        }

        /* The phone accepted at the key change: its walk target, from the folder's row. */
        static func dueWalk(_ phone: FamilyFixture.Phone, _ family: FamilyFixture) async throws -> WalkTarget {
            guard case .accepted(let view) = await phone.sync.sync(family.summary) else { throw FamilyFailure(message: "not accepted at the key change") }
            return try #require(view.areas.first?.walkTarget, "no walk was due")
        }

        /*
         * The member walks the key change they saw to its end: every node of the folder at the new
         * epoch, nothing left pending, and a fresh phone reads every name and the photo's bytes. A
         * second walk finds it finished and sends nothing. Fails if the walk misses a level, leaves a
         * key pending, or sends again what was done.
         */
        @Test func aMemberWalksTheKeyChangeItSawToItsEnd() async throws {
            let (family, server, deep) = try await Self.walkable()
            let phone = try await family.phone(server)
            defer { phone.done() }
            guard case .accepted = await phone.sync.sync(family.summary) else { Issue.record("not accepted"); return }
            _ = try await phone.vault.children(of: family.rootId)
            try server.replaceKeys(target: 100)
            let target = try await Self.dueWalk(phone, family)
            server.lock.withLock { server.rotations.rotationBatch = 1 }
            #expect(try await phone.sync.walk(family.groupId, target) == .walked)
            for id in [family.rootId, family.fileId, family.docs.id, deep.id, family.photo.id] {
                #expect(server.node(id)?.keyEpoch == 100, "\(id) wasn't re-keyed")
            }
            #expect(server.name(of: deep.id) == "Packing.txt")
            #expect(server.name(of: family.photo.id) == "Beach.jpg")
            #expect(phone.vault.areaLedger.rotateDropAll(workspaceId: family.workspaceId) == 0, "a key was left pending")
            #expect(!server.running(family.rootId))

            // A fresh phone, the same account: every name and the photo's bytes under the new keys.
            let fresh = try await family.phone(server, records: phone.records, guards: phone.guards)
            guard case .accepted = await fresh.sync.sync(family.summary) else { Issue.record("not accepted after the walk"); return }
            #expect(try await fresh.vault.children(of: family.rootId).map(\.name).sorted() == ["Beach.jpg", "Docs", "Recipes.txt"])
            #expect(try await fresh.vault.children(of: family.docs.id, in: family.workspaceId).map(\.name) == ["Packing.txt"])
            let photo = try #require(await fresh.vault.item(family.photo.ref))
            let folder = FileManager.default.temporaryDirectory.appendingPathComponent("walked-\(UUID().uuidString)", isDirectory: true)
            defer { try? FileManager.default.removeItem(at: folder) }
            try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
            let (_, file) = try await fresh.vault.downloadCurrent(photo) { _ in folder.appendingPathComponent("photo") }
            #expect(try Data(contentsOf: file) == family.photoBytes, "the photo's bytes changed in the walk")

            let sent = server.rotationBatches.count
            #expect(try await phone.sync.walk(family.groupId, target) == .endedElsewhere)
            #expect(server.rotationBatches.count == sent, "a finished walk sent again")
        }

        /*
         * Only a key change this device saw re-key the top folder is walked: a run from another node,
         * to another epoch, or one route 25 names in a form that doesn't read is never walked on the
         * server's word, and a malformed one never keeps the list from loading. Fails if the walk
         * rule trusts the server's naming of a run.
         */
        @Test func onlyAKeyChangeThisDeviceSawIsWalked() async throws {
            let family = try await onLargeStack { try FamilyFixture() }
            let root = family.root
            func area(_ rotation: SpaceList.Rotation?, listed: Bool = true) -> FamilyArea {
                FamilyArea(workspaceId: family.workspaceId, name: "Photos", root: root, opened: true, rootListed: listed, rotating: rotation != nil,
                           write: .writable, rotation: rotation)
            }
            #expect(area(SpaceList.Rotation(id: "r", nodeId: root.id, targetEpoch: root.keyEpoch)).walkTarget != nil)
            #expect(area(SpaceList.Rotation(id: "r", nodeId: family.fileId, targetEpoch: root.keyEpoch)).walkTarget == nil, "a run from another node was walked")
            #expect(area(SpaceList.Rotation(id: "r", nodeId: root.id, targetEpoch: 99)).walkTarget == nil, "a run to another epoch was walked")
            #expect(area(SpaceList.Rotation(id: "r", nodeId: root.id, targetEpoch: root.keyEpoch), listed: false).walkTarget == nil)
            #expect(area(nil).walkTarget == nil)
            let served = #"{"workspaceId":"\#(family.workspaceId)","workspaceKeyVersion":1,"root":null,"rotation":{"nodeId":7}}"#
            let decoded = try JSONDecoder().decode(SpaceList.Area.self, from: Data(served.utf8))
            #expect(decoded.rotation != nil, "a run that doesn't read stopped reading as a key change")
            #expect(area(decoded.rotation).walkTarget == nil, "a run that doesn't read was walked")
        }

        /*
         * Parent first. Another device of the family re-keys `docs` while this phone's batch is on
         * its way: no batch ever holds `docs` beside the file under it, so the file is never sealed
         * under a key of `docs` that this phone then drops. Fails if a batch holds a node beside its
         * parent (the file lands under a key nobody kept, and its name no longer opens).
         */
        @Test func aParentAnotherDeviceWinsNeverLeavesItsChildUnderAKeyNobodyKept() async throws {
            let (family, server, deep) = try await Self.walkable()
            let phone = try await family.phone(server)
            defer { phone.done() }
            guard case .accepted = await phone.sync.sync(family.summary) else { Issue.record("not accepted"); return }
            try server.replaceKeys(target: 100)
            let target = try await Self.dueWalk(phone, family)
            let (root, docs) = (family.rootId, family.docs.id)
            server.lock.withLock {
                server.rotations.beforeRotationSend = { ids in
                    if ids.contains(docs), server.node(docs)?.keyEpoch != 100 { server.rekeyedElsewhere(root, docs) }
                }
            }
            #expect(try await phone.sync.walk(family.groupId, target) == .walked)
            #expect(!server.rotationBatches.contains { $0.contains(docs) && $0.contains(deep.id) }, "a batch held a folder and the file under it")
            #expect(server.node(deep.id)?.keyEpoch == 100)
            #expect(server.name(of: deep.id) == "Packing.txt", "the file was sealed under a key of its folder nobody kept")
        }

        /*
         * Writes never take a walk's pending keys. While the batch that re-keys `docs` is on its way,
         * another device re-keys `docs` first (so this phone's fresh key for it will be dropped), and
         * the phone, listing again, sees `docs` at the new epoch and makes a folder in it. The folder
         * waits until the batch is committed or dropped; the core would otherwise wrap it under the
         * pending key, which nobody keeps. Fails if a write in the folder can take a key while a
         * walk's batch holds fresh ones pending.
         */
        @Test func aNewFolderDuringAWalkBatchWaitsForItsKeys() async throws {
            let (family, server, _) = try await Self.walkable()
            let phone = try await family.phone(server)
            defer { phone.done() }
            guard case .accepted = await phone.sync.sync(family.summary) else { Issue.record("not accepted"); return }
            try server.replaceKeys(target: 100)
            let target = try await Self.dueWalk(phone, family)
            _ = try await phone.vault.children(of: family.rootId)
            let (vault, docs, root, groupId) = (phone.vault, family.docs.id, family.rootId, family.groupId)
            server.lock.withLock {
                server.rotations.beforeRotationSend = { ids in if ids.contains(docs) { server.rekeyedElsewhere(root, docs) } }
                server.rotations.holdSendWith = docs
            }
            let sync = phone.sync
            let walk = Task { try await sync.walk(groupId, target) }
            let held = await withCheckedContinuation { done in
                DispatchQueue.global().async { done.resume(returning: server.rotations.arrived.wait(timeout: .now() + 20) == .success) }
            }
            #expect(held, "the batch that re-keys the folder never went")
            // Listed again while the batch's answer is on its way: `docs` at the new epoch, then a folder made in it.
            _ = try? await vault.children(of: root)
            let create = Task { _ = try? await vault.createFolder(in: docs, name: "Tickets") }
            for _ in 0 ..< 30 {
                if server.requested("/api/drive/folders", method: "POST") { break }
                try await Task.sleep(for: .milliseconds(50))
            }
            let early = server.requested("/api/drive/folders", method: "POST")
            server.rotations.release.signal()
            #expect(try await walk.value == .walked)
            _ = await create.value
            #expect(!early, "a new folder took a key while the walk's batch held its fresh ones pending")
            #expect(server.requested("/api/drive/folders", method: "POST"), "the new folder was never made once the batch was done")
        }

        /*
         * Opening parents on resume. `docs` is in the trash and another device already re-keyed it; a
         * fresh phone (which never opened `docs`) resumes the walk. Its listing is refused (in the
         * trash), so `docs` is found through the folder's change feed, past dozens of one-row pages.
         * Fails if the walk can't open a parent under the trash, or stops reading the feed at a page
         * bound.
         */
        @Test func aResumeFindsATrashedParentThroughTheChangeFeedWithNoPageCap() async throws {
            let (family, server, deep) = try await Self.walkable()
            // Rows of the folder's workspace outside the walked top folder: never re-keyed, so ahead of `docs` in the feed in every round.
            for index in 0 ..< 40 {
                server.put(try FamilyFixture.node(id: try newId(kind: .node, scopeId: family.workspaceId).id, in: family.workspaceId, parent: nil,
                                                  parentKey: family.areaKey, key: try randomBytes(length: 32), kind: .folder, name: "Old \(index)",
                                                  writer: family.creator))
            }
            let phone = try await family.phone(server)
            defer { phone.done() }
            guard case .accepted = await phone.sync.sync(family.summary) else { Issue.record("not accepted"); return }
            try server.replaceKeys(target: 100)
            server.lock.withLock { server.change(family.docs.id) { $0["trashedAt"] = "2026-10-20T10:00:00.000Z" } }
            server.rekeyedElsewhere(family.rootId, family.docs.id)
            server.lock.withLock { server.rotations.changesPage = 1 }
            let fresh = try await family.phone(server, records: phone.records, guards: phone.guards)
            let target = try await Self.dueWalk(fresh, family)
            #expect(try await fresh.sync.walk(family.groupId, target) == .walked)
            #expect(server.node(deep.id)?.keyEpoch == 100)
            #expect(server.name(of: deep.id) == "Packing.txt")
        }

        /*
         * A batch that doesn't land (the connection drops) leaves no key pending, and the next walk
         * sends what it missed again, under fresh keys, to the end. Fails if a failed batch keeps its
         * fresh keys pending or the walk can't resume.
         */
        @Test func aWalkResumesAfterAStopMidBatch() async throws {
            let (family, server, _) = try await Self.walkable()
            let phone = try await family.phone(server)
            defer { phone.done() }
            guard case .accepted = await phone.sync.sync(family.summary) else { Issue.record("not accepted"); return }
            try server.replaceKeys(target: 100)
            let target = try await Self.dueWalk(phone, family)
            server.lock.withLock {
                server.rotations.rotationBatch = 1
                server.rotations.failRotationSends = [2]
            }
            await #expect(throws: (any Error).self) { _ = try await phone.sync.walk(family.groupId, target) }
            #expect(phone.vault.areaLedger.rotateDropAll(workspaceId: family.workspaceId) == 0, "a failed batch left its keys pending")
            let missed = try #require(server.rotationBatches.last)
            #expect(try await phone.sync.walk(family.groupId, target) == .walked)
            #expect(server.rotationBatches.filter { $0 == missed }.count == 2, "the batch that didn't land wasn't sent again")
            #expect(!server.running(family.rootId))
        }

        /*
         * A batch that landed but whose answer was lost, then the app killed: the next process finishes
         * the walk and never sends the landed node again. Fails if the next process resends what the
         * server already applied, or can't read it at its new key.
         */
        @Test func aWalkKilledAfterABatchLandedIsFinishedByTheNextProcess() async throws {
            let (family, server, deep) = try await Self.walkable()
            let phone = try await family.phone(server)
            defer { phone.done() }
            guard case .accepted = await phone.sync.sync(family.summary) else { Issue.record("not accepted"); return }
            try server.replaceKeys(target: 100)
            let target = try await Self.dueWalk(phone, family)
            server.lock.withLock {
                server.rotations.rotationBatch = 1
                server.rotations.loseRotationAnswers = [1]
            }
            await #expect(throws: (any Error).self) { _ = try await phone.sync.walk(family.groupId, target) }
            let landed = try #require(server.rotationBatches.first)
            let next = try await family.phone(server, records: phone.records, guards: phone.guards)
            #expect(try await next.sync.walk(family.groupId, try await Self.dueWalk(next, family)) == .walked)
            #expect(server.rotationBatches.filter { $0 == landed }.count == 1, "the next process sent a landed node again")
            #expect(server.name(of: deep.id) == "Packing.txt")
        }

        /*
         * The background pass, with the app closed: a removal's key change is walked; a batch that
         * fails makes the pass come back (retry), and the next pass finishes it. Fails if the pass
         * walks nothing, or gives up on a failure worth trying again.
         */
        @Test func aKeyChangeSeenWhileTheAppIsClosedIsWalkedByTheBackgroundPass() async throws {
            let (family, server, deep) = try await Self.walkable()
            let phone = try await family.phone(server)
            defer { phone.done() }
            guard case .accepted = await phone.sync.sync(family.summary) else { Issue.record("not accepted"); return }
            try server.replaceKeys(target: 100)
            server.lock.withLock { server.rotations.failRotationSends = [1] }
            #expect(await phone.sync.backgroundPass(current: { true }, checkStop: {}) == .retry)
            #expect(await phone.sync.backgroundPass(current: { true }, checkStop: {}) == .done)
            #expect(!server.running(family.rootId))
            #expect(server.node(deep.id)?.keyEpoch == 100)
        }

        /*
         * Reconciling removals. Route 2 stops listing the family and the member list doesn't answer
         * (503): nothing is wiped and the pass comes back. Once the server says not-member, the family
         * is wiped, the screens are told, and the background check is let go of. Fails if an
         * unconfirmed removal wipes, or ends the background check, or a wipe isn't published.
         */
        @Test func onlyAConfirmedRemovalWipesAndEveryWipeIsPublished() async throws {
            let (family, server, _) = try await Self.walkable()
            let phone = try await family.phone(server)
            defer { phone.done() }
            guard case .accepted = await phone.sync.sync(family.summary) else { Issue.record("not accepted"); return }
            let work = Calls()
            phone.sync.familyWork.set { work.append($0) }
            _ = phone.sync.releases.take()
            server.listed = false
            server.lock.withLock { server.rostersFail = true }
            #expect(await phone.sync.backgroundPass(current: { true }, checkStop: {}) == .retry)
            #expect(phone.records.read(userId: family.member.userId, groupId: family.groupId) != nil, "an unconfirmed removal wiped the family")
            #expect(!work.values.contains(false), "the background check was let go of before the removal was confirmed")
            #expect(phone.sync.releases.take().isEmpty)
            server.lock.withLock { server.rostersFail = false }
            server.notMember = true
            #expect(await phone.sync.backgroundPass(current: { true }, checkStop: {}) == .done)
            #expect(phone.records.read(userId: family.member.userId, groupId: family.groupId) == nil)
            #expect(work.values.last == false)
            let released = phone.sync.releases.take()
            #expect(released.count == 1 && released.first?.groupId == family.groupId)
            if case .wiped? = released.first?.revised.state {} else { Issue.record("the wipe wasn't published to the screens") }
        }

        /*
         * Retryable errors. No answer, a timeout, too many requests and any server error come back by
         * themselves, from the groups and the drive routes alike; a refusal doesn't. And a pass whose
         * route 2 answers 503 comes back. Fails if any of them is taken as final.
         */
        @Test func noAnswerTimeoutsLimitsAndServerErrorsAreTriedAgain() async throws {
            for status in [0, 408, 429, 500, 502, 503] {
                #expect(FamilySync.transient(GroupsAPIError(status: status, code: nil, message: "")), "groups \(status) taken as final")
                if status != 0 { #expect(FamilySync.transient(DriveAPIError.server(status, "")), "drive \(status) taken as final") }
            }
            #expect(FamilySync.transient(URLError(.timedOut)))
            for status in [400, 403, 404, 409] {
                #expect(!FamilySync.transient(GroupsAPIError(status: status, code: nil, message: "")))
                #expect(!FamilySync.transient(DriveAPIError.server(status, "")))
            }
            let (family, server, _) = try await Self.walkable()
            let phone = try await family.phone(server)
            defer { phone.done() }
            guard case .accepted = await phone.sync.sync(family.summary) else { Issue.record("not accepted"); return }
            server.groupsFail = true
            #expect(await phone.sync.backgroundPass(current: { true }, checkStop: {}) == .retry)
        }

        /*
         * Background work is bound to its session. The session ends while the pass reads route 2: the
         * pass stops there, touches nothing more and leaves the next session's schedule alone. Fails
         * if a pass goes on after its session ended.
         */
        @Test func aPassWhoseSessionEndedStopsAndLeavesTheNextSessionAlone() async throws {
            let (family, server, _) = try await Self.walkable()
            let phone = try await family.phone(server)
            defer { phone.done() }
            guard case .accepted = await phone.sync.sync(family.summary) else { Issue.record("not accepted"); return }
            try server.replaceKeys(target: 100)
            let work = Calls()
            phone.sync.familyWork.set { work.append($0) }
            let asked = Calls()
            // Current for the pass's first check only: the session ended while route 2 was read.
            let current: @Sendable () -> Bool = {
                asked.append(true)
                return asked.values.count < 2
            }
            #expect(await phone.sync.backgroundPass(current: current, checkStop: {}) == .signedOut)
            #expect(server.rotationBatches.isEmpty, "a pass of an ended session walked")
            #expect(!work.values.contains(false), "a pass of an ended session let the next one's schedule go")

            // A phone in no family whose session ends while route 2 is read: the pass that finds nothing never lets go of the
            // check for the session that comes next.
            let other = try await family.phone(server)
            defer { other.done() }
            let next = Calls()
            other.sync.familyWork.set { next.append($0) }
            server.listed = false
            let ended = Calls()
            let endedNow: @Sendable () -> Bool = {
                ended.append(true)
                return ended.values.count < 2
            }
            #expect(await other.sync.backgroundPass(current: endedNow, checkStop: {}) == .signedOut)
            #expect(!next.values.contains(false), "a pass of an ended session let the next one's schedule go")
        }

        /*
         * The task's time runs out after the first batch: the pass stops between batches, sends
         * nothing more, leaves no folder locked and no key pending, and the run is still there for
         * the next pass. Fails if a stopped pass sends again, or stops holding a lock or keys.
         */
        @Test func aStoppedPassSendsNothingMoreAndLeavesNoFolderLocked() async throws {
            let (family, server, _) = try await Self.walkable()
            let phone = try await family.phone(server)
            defer { phone.done() }
            guard case .accepted = await phone.sync.sync(family.summary) else { Issue.record("not accepted"); return }
            try server.replaceKeys(target: 100)
            server.lock.withLock { server.rotations.rotationBatch = 1 }
            let stop: @Sendable () throws -> Void = { if !server.rotationBatches.isEmpty { throw FamilyWalkStopped() } }
            #expect(await phone.sync.backgroundPass(current: { true }, checkStop: stop) == .stopped)
            #expect(server.rotationBatches.count == 1, "a stopped pass sent again")
            let (walksFree, keysFree) = (await FamilyLocks.walks.isFree(family.workspaceId), await FamilyLocks.keys.isFree(family.workspaceId))
            #expect(walksFree && keysFree, "a stopped pass left the folder locked")
            #expect(phone.vault.areaLedger.rotateDropAll(workspaceId: family.workspaceId) == 0, "a stopped pass left keys pending")
            #expect(server.running(family.rootId))
        }
    }
}

/* A flag a server hook sets, read by the test. */
final class Flag: @unchecked Sendable {
    private let lock = NSLock()
    private var held = false
    private var early = false
    var set: Bool {
        get { lock.withLock { held } }
        set { lock.withLock { held = newValue } }
    }
    var arrivedEarly: Bool {
        get { lock.withLock { early } }
        set { lock.withLock { early = newValue } }
    }
}

/* What a hook was called with, in order. */
final class Calls: @unchecked Sendable {
    private let lock = NSLock()
    private var held: [Bool] = []
    func append(_ value: Bool) { lock.withLock { held.append(value) } }
    var values: [Bool] { lock.withLock { held } }
}
