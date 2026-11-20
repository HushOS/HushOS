import Foundation
import HushOSCore
import Testing
@testable import HushOSKit

/*
 * Drafts on the phone: the store keeps only sealed records, within the caps, and drops what can never be shown; the
 * restore decision follows the version the text started from; the write turn carries a burst of typing into one write.
 * The sign-out wipe is AccountStoreTests' (local/drafts is one of the account's files).
 */
@Suite final class DraftsTests {
    let folder = FileManager.default.temporaryDirectory.appendingPathComponent("drafts-" + UUID().uuidString, isDirectory: true)
    let key = Data((1...32).map { UInt8($0) })
    let place = DraftPlace(userId: "6B1A3F0E-2C4D-4E5F-8A9B-0C1D2E3F4A5B", workspaceId: "0d4f2a1b-9c8e-4f7a-b6d5-e4c3b2a1f0e9",
                           nodeId: "5f0c1d2e-3a4b-4c5d-9e6f-7a8b9c0d1e2f")
    static let base = "9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d"
    static let now: UInt64 = 1_763_650_440_000
    static let day: UInt64 = 24 * 60 * 60 * 1000

    deinit { try? FileManager.default.removeItem(at: folder) }

    func store(now: UInt64 = DraftsTests.now) -> DraftStore { DraftStore(folder: folder, now: { now }) }

    func draft(_ text: String, savedAt: UInt64 = DraftsTests.now) -> Draft {
        Draft(frame: DraftFrame(baseVersionId: Self.base, format: TextFormat(encoding: .utf8, lineEnding: .lf, mixed: false),
                                savedAt: savedAt),
              text: text, selection: DraftSelection(from: 2, to: 4), sourceVersionId: Self.base)
    }

    func node(_ n: Int) -> DraftPlace {
        DraftPlace(userId: place.userId, workspaceId: place.workspaceId, nodeId: String(format: "5f0c1d2e-3a4b-4c5d-9e6f-%012d", n))
    }

    func everything() -> String {
        let files = (try? FileManager.default.contentsOfDirectory(at: folder, includingPropertiesForKeys: nil)) ?? []
        return files.map { (try? String(contentsOf: $0, encoding: .utf8)) ?? "" }.joined(separator: "\n")
    }

    @Test func keepsOnlyCiphertextAndGivesTheTextBackToTheSameAccountAndFile() throws {
        #expect(store().write(draft("draft canary"), at: place, key: key))
        let kept = everything()
        #expect(!kept.contains("canary"))
        // Nothing that names the file: no node id, no version id.
        #expect(!kept.contains(place.nodeId))
        #expect(!kept.contains(Self.base))
        let read = try #require(store().read(at: place, key: key))
        #expect(read.text == "draft canary")
        #expect(read.selection == DraftSelection(from: 2, to: 4))
        #expect(read.frame.baseVersionId == Self.base)
        // Another file, or another account's key: nothing found.
        #expect(store().read(at: node(9), key: key) == nil)
        #expect(store().read(at: place, key: Data(repeating: 9, count: 32)) == nil)
    }

    @Test func oneDraftPerFileTheLastWriteWins() throws {
        store().write(draft("first"), at: place, key: key)
        store().write(draft("second", savedAt: Self.now + 1), at: place, key: key)
        #expect(try #require(store().read(at: place, key: key)).text == "second")
        #expect(store().count == 1)
    }

    @Test func aChangedRecordIsDeletedNeverOffered() throws {
        store().write(draft("mine"), at: place, key: key)
        let file = try #require(try FileManager.default.contentsOfDirectory(at: folder, includingPropertiesForKeys: nil).first)
        var record = try String(contentsOf: file, encoding: .utf8)
        // Another time beside the same sealed text: the associated data no longer holds.
        record = record.replacingOccurrences(of: String(Self.now), with: String(Self.now - 1))
        try Data(record.utf8).write(to: file)
        #expect(store().read(at: place, key: key) == nil)
        #expect(store().count == 0)
    }

    @Test func aFailedWriteEvictsNothingAndARecordThatCantBeReadIsNoReasonToEvict() throws {
        for n in 0..<50 { store().write(draft("d\(n)", savedAt: Self.now - 50_000 + UInt64(n)), at: node(n), key: key) }
        // Past the limit: not written, and so nothing is pushed out for it.
        let tooLong = String(repeating: "a", count: Int(draftLimits().textBytes) + 1)
        #expect(!store().write(draft(tooLong), at: node(60), key: key))
        #expect(store().count == 50)
        #expect(store().read(at: node(0), key: key)?.text == "d0")
        // A record whose bytes can't be parsed, recent by its date: the caps go by dates, never by reading it.
        let unreadable = folder.appendingPathComponent("unreadable.json")
        try Data("not a record".utf8).write(to: unreadable)
        store().remove(at: node(1), key: key)
        store().write(draft("new"), at: node(61), key: key)
        #expect(FileManager.default.fileExists(atPath: unreadable.path))
    }

    @Test func draftsKeepCompleteProtectionWhenLaunchReappliesTheGroupsClass() throws {
        let local = folder.appendingPathComponent("local", isDirectory: true)
        let drafts = DraftStore(folder: local.appendingPathComponent("drafts", isDirectory: true), now: { Self.now })
        #expect(drafts.write(draft("protected"), at: place, key: key))
        let other = local.appendingPathComponent("files-parents.json")
        try FileManager.default.createDirectory(at: local, withIntermediateDirectories: true)
        try Data("{}".utf8).write(to: other)
        var reclassed: [String] = []
        Unbacked.protectAll(local) { reclassed.append($0.standardizedFileURL.path) }
        let record = try #require(try FileManager.default.contentsOfDirectory(at: drafts.folder, includingPropertiesForKeys: nil).first)
        // The group's class goes on everything else in local/, never on a draft (written with complete protection).
        #expect(reclassed.contains(other.standardizedFileURL.path))
        #expect(!reclassed.contains(record.standardizedFileURL.path))
        #expect(!reclassed.contains { $0.hasPrefix(drafts.folder.standardizedFileURL.path + "/") })
    }

    @Test func thirtyDaysOldIsOfferedAndAMillisecondMoreIsDropped() throws {
        let limit = draftLimits().maxAgeMs
        store().write(draft("edge", savedAt: Self.now - limit), at: node(1), key: key)
        store().write(draft("past", savedAt: Self.now - limit - 1), at: node(2), key: key)
        #expect(store().read(at: node(1), key: key)?.text == "edge")
        #expect(store().read(at: node(2), key: key) == nil)
        #expect(store().count == 1)
    }

    @Test func fiftyAtMostTheOldestGoFirst() {
        for n in 0..<50 { store().write(draft("d\(n)", savedAt: Self.now - 50_000 + UInt64(n)), at: node(n), key: key) }
        #expect(store().count == 50)
        store().write(draft("newest"), at: node(50), key: key)
        #expect(store().count == 50)
        #expect(store().read(at: node(0), key: key) == nil)
        #expect(store().read(at: node(1), key: key)?.text == "d1")
        #expect(store().read(at: node(50), key: key)?.text == "newest")
    }

    @Test func textPastTheEditorsLimitIsNotKeptAndTheLastDraftStays() {
        store().write(draft("kept"), at: place, key: key)
        let tooLong = String(repeating: "a", count: Int(draftLimits().textBytes) + 1)
        #expect(!store().write(draft(tooLong), at: place, key: key))
        #expect(store().read(at: place, key: key)?.text == "kept")
    }

    @Test func aWriteAskedForBeforeASignOutsWipeInAnotherProcessKeepsNothing() {
        store().write(draft("before"), at: place, key: key)
        let asked = store().generation
        // Another process's store over the same folder (the Files sign-in sheet's): only what is on disk is shared.
        DraftStore(folder: folder).wipe()
        #expect(store().count == 0)
        #expect(!store().write(draft("late"), at: place, key: key, asked: asked))
        #expect(store().count == 0)
        // Asked after the wipe: kept.
        #expect(store().write(draft("after"), at: place, key: key))
    }

    @Test func theRestoreFollowsTheVersionTheTextStartedFrom() {
        let mine = draft("mine")
        #expect(DraftRules.offer(mine, openedVersionId: Self.base, openedText: "theirs") == .current)
        #expect(DraftRules.offer(mine, openedVersionId: "1c2d3e4f-5a6b-4c7d-8e9f-a0b1c2d3e4f5", openedText: "theirs") == .stale)
        #expect(DraftRules.offer(mine, openedVersionId: nil, openedText: "theirs") == .stale)
        #expect(DraftRules.offer(mine, openedVersionId: "1c2d3e4f-5a6b-4c7d-8e9f-a0b1c2d3e4f5", openedText: "mine") == .same)
    }

    @Test func aTurnWritesOnlyEditableAnsweredTextAndRemovesOnlyAnOwnedDraftAtTheBaseline() {
        #expect(DraftRules.step(editable: false, offering: false, startedFrom: Self.base, atBaseline: false, owns: true) == .none)
        #expect(DraftRules.step(editable: true, offering: true, startedFrom: Self.base, atBaseline: false, owns: true) == .none)
        #expect(DraftRules.step(editable: true, offering: false, startedFrom: nil, atBaseline: false, owns: true) == .none)
        #expect(DraftRules.step(editable: true, offering: false, startedFrom: Self.base, atBaseline: true, owns: true) == .remove)
        // An editor that wrote nothing (opened and left, closed while loading) removes nothing.
        #expect(DraftRules.step(editable: true, offering: false, startedFrom: Self.base, atBaseline: true, owns: false) == .none)
        #expect(DraftRules.step(editable: true, offering: false, startedFrom: Self.base, atBaseline: false, owns: false) == .write)
    }

    @Test func aCopyOfARestoredDraftFromAnotherVersionIsReSealedNeverVouchedFor() throws {
        let verified = SaveSource.file(metadata: .verified, version: .verified, fromLink: false)
        let vouched = try SaveRuns.signing(.from([verified]))
        let restored = try SaveRuns.signing(.from([TextEditing.contentUnknown(verified)]))
        let unchecked = try SaveRuns.signing(.from([.file(metadata: .verified, version: .unchecked, fromLink: false)]))
        #expect(restored.version != vouched.version)
        #expect(restored.version == unchecked.version)
        // The name record still checks: only the content is unknown.
        #expect(restored.metadata == vouched.metadata)
    }

    @Test @MainActor func aRemovalAskedForAfterAWriteRunsAfterIt() async {
        var order: [String] = []
        DraftLane.enqueue {
            try? await Task.sleep(for: .milliseconds(100))
            order.append("write")
        }
        DraftLane.enqueue { order.append("remove") }
        await DraftLane.settled()
        #expect(order == ["write", "remove"])
    }

    @Test @MainActor func aBurstOfTypingIsOneWriteAndFlushWritesAtOnce() async throws {
        let timer = DraftTimer(delay: .milliseconds(600))
        var turns = 0
        // A burst: every change rides on the turn the first one scheduled.
        for _ in 0..<5 { timer.changed { turns += 1 } }
        #expect(turns == 0)
        #expect(timer.scheduled)
        // Waited for, not timed: other suites can hold the main actor for seconds.
        for _ in 0..<200 where turns == 0 { try await Task.sleep(for: .milliseconds(50)) }
        #expect(turns == 1)
        timer.changed { turns += 1 }
        timer.flush { turns += 1 }
        #expect(turns == 2)
        // The flush took the pending turn with it.
        #expect(!timer.scheduled)
        try await Task.sleep(for: .milliseconds(1_200))
        #expect(turns == 2)
    }

    @Test func saysTheTimeTodayAndTheDateOnAnotherDay() {
        let utc = TimeZone(identifier: "UTC")!
        let locale = Locale(identifier: "en_US")
        let at = UInt64(Date(timeIntervalSince1970: 1_763_648_040).timeIntervalSince1970 * 1000) // 2025-11-20 14:14 UTC
        let sameDay = Date(timeIntervalSince1970: 1_763_660_000)
        let nextDay = Date(timeIntervalSince1970: 1_763_740_000)
        #expect(DraftRules.when(at, now: sameDay, locale: locale, timeZone: utc).replacingOccurrences(of: "\u{202F}", with: " ") == "2:14 PM")
        #expect(DraftRules.when(at, now: nextDay, locale: locale, timeZone: utc).replacingOccurrences(of: "\u{202F}", with: " ") == "Nov 20, 2:14 PM")
    }
}
