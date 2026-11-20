import Foundation
import Testing
@testable import HushOSKit

/*
 * The app coming back on screen after a sign-in from the Files sheet. The same account under a
 * new session keeps its screens (a teardown dropped them for nothing); another account first
 * stops the last one's queue and notices (skipping that ran one account's transfers under the
 * other's session); an ended session the app already turned down isn't followed again.
 */
struct SessionChangeTests {
    let origin = "https://hushos.com"
    func session(_ user: String, _ token: String) -> SharedKeychain.Session { .init(origin: origin, token: token, userId: user) }

    @Test func theSameSessionChangesNothing() {
        #expect(SessionChange.decide(shown: session("u1", "a"), last: nil, stored: session("u1", "a"), declined: nil) == .none)
    }

    @Test func theSameAccountUnderANewSessionIsAdoptedNotRestarted() {
        #expect(SessionChange.decide(shown: session("u1", "a"), last: nil, stored: session("u1", "b"), declined: nil) == .adopt)
    }

    @Test func anotherAccountStopsTheLastOnesWorkFirst() {
        #expect(SessionChange.decide(shown: session("u1", "a"), last: nil, stored: session("u2", "c"), declined: nil) == .another)
        // The same user id on another server is another account.
        let elsewhere = SharedKeychain.Session(origin: "https://other.example", token: "a", userId: "u1")
        #expect(SessionChange.decide(shown: session("u1", "a"), last: nil, stored: elsewhere, declined: nil) == .another)
    }

    @Test func aSessionThatWentStartsAgainWithoutClearingAnyone() {
        #expect(SessionChange.decide(shown: session("u1", "a"), last: nil, stored: nil, declined: nil) == .restart)
    }

    @Test func signedOutFollowsASignInFromTheSheet() {
        let last = AccountOwner(userId: "u1", origin: origin)
        #expect(SessionChange.decide(shown: nil, last: last, stored: session("u1", "b"), declined: "a") == .restart)
        #expect(SessionChange.decide(shown: nil, last: last, stored: session("u2", "c"), declined: "a") == .another)
        #expect(SessionChange.decide(shown: nil, last: nil, stored: session("u2", "c"), declined: nil) == .restart)
    }

    @Test func signedOutNeverFollowsTheSessionItTurnedDown() {
        #expect(SessionChange.decide(shown: nil, last: nil, stored: session("u1", "a"), declined: "a") == .none)
        #expect(SessionChange.decide(shown: nil, last: nil, stored: nil, declined: nil) == .none)
    }
}
