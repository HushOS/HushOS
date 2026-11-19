import Foundation
import Testing
@testable import HushOSKit

/*
 * An unfold tears down the screens under an open editor without a word; its work, held by the store, must be there
 * for the editor presented again. Fails if the text is lost across the rebuild, if another file's editor or another
 * session's (a sign-out and in, another account) gets it, or if it outlives a Close or the session.
 */
@MainActor @Suite struct EditorParkingTests {
    final class Session {}
    final class Work {
        var text: String
        init(_ text: String) { self.text = text }
    }

    private let notes = NodeRef(workspaceId: "w", nodeId: "notes")
    private let other = NodeRef(workspaceId: "w", nodeId: "other")

    @Test func theEditorPresentedAgainFindsTheSameWork() {
        let parking = EditorParking<Session, Work>()
        let session = Session()
        let work = Work("typed, not saved")
        parking.hold(work, key: notes, owner: session)
        // The screens holding the editor are gone; the store still has its work, the very same object.
        let found = parking.held(key: notes, owner: session)
        #expect(found === work)
        // Found again after another rebuild: held until the editor ends on purpose.
        #expect(parking.held(key: notes, owner: session) === work)
        // A file's id in another casing is the same file (NodeRef lowercases).
        #expect(parking.held(key: NodeRef(workspaceId: "W", nodeId: "NOTES"), owner: session) === work)
    }

    @Test func anotherFileGetsNothingAndLeavesItHeld() {
        let parking = EditorParking<Session, Work>()
        let session = Session()
        let work = Work("a")
        parking.hold(work, key: notes, owner: session)
        #expect(parking.held(key: other, owner: session) == nil)
        #expect(parking.release(key: other) == nil)
        #expect(parking.held(key: notes, owner: session) === work)
    }

    @Test func anotherSessionNeverGetsItAndItIsLetGo() {
        let parking = EditorParking<Session, Work>()
        let first = Session(), second = Session()
        parking.hold(Work("first account's words"), key: notes, owner: first)
        #expect(parking.held(key: notes, owner: second) == nil)
        // Gone, not merely hidden: the first session asking again finds nothing either.
        #expect(parking.isEmpty)
        #expect(parking.held(key: notes, owner: first) == nil)
    }

    @Test func aCloseOrTheSessionsEndLeavesNothing() {
        let parking = EditorParking<Session, Work>()
        let session = Session()
        let work = Work("a")
        parking.hold(work, key: notes, owner: session)
        #expect(parking.release(key: notes) === work)
        #expect(parking.held(key: notes, owner: session) == nil)
        parking.hold(Work("b"), key: notes, owner: session)
        #expect(parking.drop()?.text == "b")
        #expect(parking.isEmpty)
    }

    @Test func aNewEditReplacesWhatWasHeld() {
        let parking = EditorParking<Session, Work>()
        let session = Session()
        parking.hold(Work("old"), key: notes, owner: session)
        parking.hold(Work("new"), key: other, owner: session)
        #expect(parking.held(key: notes, owner: session) == nil)
        #expect(parking.held(key: other, owner: session)?.text == "new")
    }
}
