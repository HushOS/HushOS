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
              text: text, selection: DraftSelection(from: 2, to: 4))
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
        #expect(!kept.contains(place.nodeId))
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
        // Another base version beside the same sealed text: the associated data no longer holds.
        record = record.replacingOccurrences(of: Self.base, with: "1c2d3e4f-5a6b-4c7d-8e9f-a0b1c2d3e4f5")
        try Data(record.utf8).write(to: file)
        #expect(store().read(at: place, key: key) == nil)
        #expect(store().count == 0)
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

    @Test func aWriteAskedForBeforeASignOutsWipeKeepsNothing() {
        store().write(draft("before"), at: place, key: key)
        let asked = store().generation
        DraftStore.wipe(folder: folder)
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

    @Test func aTurnWritesOnlyEditableAnsweredTextAndRemovesAtTheBaseline() {
        #expect(DraftRules.step(editable: false, offering: false, startedFrom: Self.base, atBaseline: false) == .none)
        #expect(DraftRules.step(editable: true, offering: true, startedFrom: Self.base, atBaseline: false) == .none)
        #expect(DraftRules.step(editable: true, offering: false, startedFrom: nil, atBaseline: false) == .none)
        #expect(DraftRules.step(editable: true, offering: false, startedFrom: Self.base, atBaseline: true) == .remove)
        #expect(DraftRules.step(editable: true, offering: false, startedFrom: Self.base, atBaseline: false) == .write)
    }

    @Test @MainActor func aBurstOfTypingIsOneWriteAndFlushWritesAtOnce() async throws {
        let timer = DraftTimer(delay: .milliseconds(150))
        var turns = 0
        for _ in 0..<5 {
            timer.changed { turns += 1 }
            try await Task.sleep(for: .milliseconds(10))
        }
        #expect(turns == 0)
        try await Task.sleep(for: .milliseconds(400))
        #expect(turns == 1)
        timer.changed { turns += 1 }
        timer.flush { turns += 1 }
        #expect(turns == 2)
        // The flush took the pending turn with it.
        try await Task.sleep(for: .milliseconds(400))
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
