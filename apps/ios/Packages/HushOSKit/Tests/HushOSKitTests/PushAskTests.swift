import Foundation
import Testing
@testable import HushOSKit

/*
 * Asking once, the decision and the record: each test fails on a question asked twice, a
 * registration made with no question where the person may have said no (to iOS, or with the
 * Account switch), a retry taken twice, the switch losing a race with the app's own asking, or a
 * record that outlives the account or reaches another one.
 */
@Suite struct PushAskTests {
    let relay = "https://push.hushos.com"
    let maya = SharedKeychain.Session(origin: "https://hushos.com", token: "t1", userId: "U1")
    let folder: URL

    init() {
        folder = FileManager.default.temporaryDirectory.appendingPathComponent("push-ask-" + UUID().uuidString, isDirectory: true)
    }

    func step(_ mark: PushAsk.Mark?, _ permission: PushAsk.Permission, registered: Bool = false, relay: String? = "https://push.hushos.com", available: Bool = true) -> PushAsk.Step {
        PushAsk.step(available: available, registered: registered, mark: mark, relay: relay, permission: permission)
    }

    @Test func aFirstSignInWhereIOSHasNotBeenAskedAsks() {
        #expect(step(nil, .undecided) == .ask)
    }

    @Test func iOSAllowingAlreadyIsOfferedNeverTurnedOnWithoutATap() {
        // Allowed for the switch then switched off, for background uploads, or before a sign-out: no way to tell, so the app asks.
        #expect(step(nil, .allowed) == .offer)
        #expect(step(nil, .denied) == .markOnly)
    }

    @Test func onceAskedOrDecidedNothingHappensWhateverIOSSays() {
        for mark in [PushAsk.Mark.asked, .decided] {
            for permission in [PushAsk.Permission.undecided, .allowed, .denied] {
                #expect(step(mark, permission) == .nothing)
            }
        }
    }

    @Test func aYesWhoseRegistrationFailedIsMadeAtTheNextStartWithNoQuestion() {
        #expect(step(.retry, .allowed) == .register)
        // Turned off in Settings since: no registration, and no question either.
        #expect(step(.retry, .denied) == .markOnly)
        #expect(step(.retry, .undecided) == .markOnly)
    }

    @Test func aRegisteredPhoneNoRelayOrNoPushesMeansNothing() {
        #expect(step(nil, .undecided, registered: true) == .nothing)
        #expect(step(nil, .undecided, relay: nil) == .nothing)
        #expect(step(nil, .undecided, available: false) == .nothing)
    }

    @Test func theMarkBelongsToOneAccountOnOneServer() {
        let record = PushAsk.Record(folder: folder)
        defer { try? FileManager.default.removeItem(at: folder) }
        #expect(record.set(maya, to: .asked, ifStill: nil))
        #expect(record.mark(maya) == .asked)
        // The same account under another token, and its id in another case, are the same account.
        #expect(record.mark(SharedKeychain.Session(origin: "https://hushos.com", token: "t2", userId: "u1")) == .asked)
        #expect(record.mark(SharedKeychain.Session(origin: "https://hushos.com", token: "t1", userId: "U2")) == nil)
        #expect(record.mark(SharedKeychain.Session(origin: "https://drive.example", token: "t1", userId: "U1")) == nil)
    }

    @Test func aSecondRunNeverAsksAgainAndTheSwitchAlwaysWins() {
        let record = PushAsk.Record(folder: folder)
        defer { try? FileManager.default.removeItem(at: folder) }
        #expect(record.set(maya, to: .asked, ifStill: nil))
        // Another run that read "nothing asked" before this one marked it doesn't get to ask.
        #expect(!record.set(maya, to: .asked, ifStill: nil))
        // The switch turned off during the question: a failed registration doesn't leave a retry behind.
        record.decided(maya)
        #expect(!record.set(maya, to: .retry, ifStill: .asked))
        #expect(record.mark(maya) == .decided)
    }

    @Test func theSwitchUsedWhileTheSettingsWereReadStopsTheAsk() {
        let record = PushAsk.Record(folder: folder)
        defer { try? FileManager.default.removeItem(at: folder) }
        let read = record.mark(maya)
        record.decided(maya)
        #expect(!record.set(maya, to: .asked, ifStill: read))
        #expect(record.mark(maya) == .decided)
    }

    @Test func aRetryIsTakenOnceSoTwoStartsDoNotBothRegister() {
        let record = PushAsk.Record(folder: folder)
        defer { try? FileManager.default.removeItem(at: folder) }
        record.set(maya, to: .asked, ifStill: nil)
        #expect(record.set(maya, to: .retry, ifStill: .asked))
        #expect(record.set(maya, to: .asked, ifStill: .retry))
        #expect(!record.set(maya, to: .asked, ifStill: .retry))
    }

    @Test func signingOutWipesTheRecord() {
        let base = FileManager.default.temporaryDirectory.appendingPathComponent("push-ask-wipe-" + UUID().uuidString, isDirectory: true)
        defer { try? FileManager.default.removeItem(at: base) }
        let root = base.appendingPathComponent("group", isDirectory: true)
        let record = PushAsk.Record(folder: root.appendingPathComponent("state", isDirectory: true))
        record.set(maya, to: .asked, ifStill: nil)
        #expect(record.mark(maya) == .asked)
        AccountStore(root: root, temporary: base.appendingPathComponent("tmp", isDirectory: true)).wipe()
        #expect(record.mark(maya) == nil)
    }
}
