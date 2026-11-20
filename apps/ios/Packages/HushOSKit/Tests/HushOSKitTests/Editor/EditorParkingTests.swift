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

    /* A file as the store lists it. */
    private func file(_ id: String, workspace: String = "w") -> Opened {
        let node = NodeView(id: id, workspaceId: workspace, parentId: "p", kind: "file", keyEpoch: 1, parentKeyEpoch: 1,
                            keyEnvelope: "", metadataVersion: 1, metadataEnvelope: "", currentVersion: nil, trashedAt: nil,
                            changeSeq: 1, createdAt: nil, updatedAt: nil)
        return Opened(node: node, metadata: NodeMetadata(name: "\(id).md", mime: nil, size: 3, modified: nil, attributes: [:]), nodeKey: nil)
    }

    /* The viewer paged from A to B and B is being edited: what waits is B's, whichever file the viewer starts on. */
    @Test func aRebuiltViewerFindsTheFileBeingEditedNotTheOneItStartedOn() throws {
        let parking = EditorParking<Session, Work>()
        let session = Session()
        let b = file("b")
        parking.hold(Work("B's unsaved words"), key: b.ref, owner: session)
        // The viewer comes back on A, the file it was opened on.
        #expect(parking.held(key: file("a").ref, owner: session) == nil)
        // What waits, whichever file: B, for the viewer to page back to and present.
        let waiting = try #require(parking.waiting(owner: session))
        #expect(waiting.key == b.ref)
        #expect(waiting.value.text == "B's unsaved words")
    }

    /* A family's removal processed while nothing is on screen: the work goes, and a rebuild finds nothing to present. */
    @Test func accessLostWhileNothingIsPresentedDropsTheWork() {
        let parking = EditorParking<Session, Work>()
        let session = Session()
        let family = file("notes", workspace: "family-area")
        let work = Work("family plaintext")
        parking.hold(work, key: family.ref, owner: session)
        // The store hears of the removal: files in that workspace may no longer be edited.
        parking.park(key: family.ref)
        let gone = parking.check { key, _ in key.workspaceId == "family-area" ? .lost : .allowed }
        #expect(gone?.value === work)
        #expect(gone?.presented == false)
        #expect(parking.waiting(owner: session) == nil)
        // A check that still allows the file keeps it.
        let kept = Work("own")
        parking.hold(kept, key: notes, owner: session)
        #expect(parking.check { _, _ in .allowed } == nil)
        #expect(parking.held(key: notes, owner: session) === kept)
    }

    /* The restore asks again: a file it may no longer edit is not handed over, and its work is handed to be emptied. */
    @Test func theRestoreChecksAccessAndEmptiesWhatItRefuses() {
        let parking = EditorParking<Session, Work>()
        let session = Session()
        let work = Work("words")
        parking.hold(work, key: notes, owner: session)
        var emptied: Work?
        #expect(parking.held(key: notes, owner: session, access: { _, _ in .lost }, dropped: { emptied = $0 }) == nil)
        #expect(emptied === work)
        #expect(parking.isEmpty)
    }

    /* Open theirs empties the box and reads their version: a rebuild meanwhile reads it again, never the old baseline. */
    @Test func afterOpenTheirsARebuildReadsTheirVersionNotTheOldBaseline() {
        let mine = file("notes")
        let parked = ParkedEdit<Work, String>(file: mine, box: Work(""))
        parked.remember("baseline of my version")
        guard case .adopt(let state) = parked.restore else { Issue.record("expected the state"); return }
        #expect(state == "baseline of my version")
        let theirs = file("notes")
        parked.reload(from: theirs)
        guard case .read(let reading) = parked.restore else { Issue.record("expected a fresh read"); return }
        #expect(reading.ref == theirs.ref)
        #expect(parked.state == nil)
        // Their version opened: what the editor shows from here is theirs.
        parked.remember("baseline of their version")
        guard case .adopt(let next) = parked.restore else { Issue.record("expected the state"); return }
        #expect(next == "baseline of their version")
    }

    /*
     * The family of the file being edited goes while its editor is on screen, over a viewer showing another page: the
     * check follows the work's own file, drops it, and says the editor on screen must end.
     */
    @Test func accessLostWhileTheEditorIsOnScreenEndsIt() {
        let parking = EditorParking<Session, Work>()
        let session = Session()
        let family = file("notes", workspace: "family-area")
        let work = Work("family plaintext")
        parking.hold(work, key: family.ref, owner: session)
        // Whatever page a viewer shows, the check is asked of the work's file.
        let gone = parking.check { key, _ in key.workspaceId == "family-area" ? .lost : .allowed }
        #expect(gone?.value === work)
        #expect(gone?.presented == true)
        #expect(parking.isEmpty)
        #expect(!parking.presented)
    }

    /*
     * Save as a copy, Open theirs on the copy, their text opened: the work the store holds is the copy's text and state,
     * and a rebuild adopts it as it is. It never reads again (which would put the copy's saved text over what was typed).
     */
    @Test func aRestoredCopyIsAdoptedNotReadAgain() {
        let original = file("notes")
        let copy = file("notes-copy")
        let parked = ParkedEdit<Work, String>(file: original, box: Work("typed after Open theirs"))
        parked.remember("editing the copy")
        parked.reload(from: copy)
        guard case .read(let reading) = parked.restore else { Issue.record("expected their read"); return }
        #expect(reading.ref == copy.ref)
        // Their version opened, and typed into since.
        parked.remember("editing their copy, typed")
        guard case .adopt(let state) = parked.restore else { Issue.record("expected the state, not another read"); return }
        #expect(state == "editing their copy, typed")
        #expect(parked.reloadFrom == nil)
    }

    /*
     * A refresh that couldn't tell (the share listed but its folder not opened, the guard unreadable, a network error):
     * the text stays, on screen or parked, and a rebuild still hands it over. Only a confirmed loss empties it.
     */
    @Test func aRefreshThatCouldNotTellKeepsTheText() {
        let parking = EditorParking<Session, Work>()
        let session = Session()
        let shared = file("notes", workspace: "theirs")
        let work = Work("typed into their file, not saved")
        parking.hold(work, key: shared.ref, owner: session)
        // The listing answered with the grant, but its folder couldn't be opened this time.
        let listing = [EditAccess.Grant(id: "grant-1", role: "editor", opened: false)]
        #expect(parking.check { _, _ in EditAccess.share(grant: "grant-1", listing: listing) } == nil)
        #expect(work.text == "typed into their file, not saved")
        #expect(parking.presented)
        // Parked by an unfold, then a restore while still unsure: handed over, not emptied.
        parking.park(key: shared.ref)
        var emptied: Work?
        let back = parking.held(key: shared.ref, owner: session,
                                access: { _, _ in EditAccess.share(grant: "grant-1", listing: listing) },
                                dropped: { emptied = $0 })
        #expect(back === work)
        #expect(emptied == nil)
        // The next listing that answers without the grant: confirmed revoked, and only now it goes.
        let gone = parking.check { _, _ in EditAccess.share(grant: "grant-1", listing: []) }
        #expect(gone?.value === work)
        #expect(parking.isEmpty)
    }

    /* What counts as a confirmed loss of a share, and what only couldn't be checked. */
    @Test func aShareIsLostOnlyWhenAListingSaysSo() {
        let editor = EditAccess.Grant(id: "g", role: "editor", opened: true)
        #expect(EditAccess.share(grant: "g", listing: [editor]) == .allowed)
        // Revoked: a listing that answered no longer has it.
        #expect(EditAccess.share(grant: "g", listing: [EditAccess.Grant(id: "other", role: "editor", opened: true)]) == .lost)
        // Made a viewer's.
        #expect(EditAccess.share(grant: "g", listing: [EditAccess.Grant(id: "g", role: "viewer", opened: true)]) == .lost)
        // Listed but not opened (the guard unreadable, the granter not checked): can't tell.
        #expect(EditAccess.share(grant: "g", listing: [EditAccess.Grant(id: "g", role: "editor", opened: false)]) == .uncertain)
        // No listing has answered yet, or no grant was recorded: can't tell.
        #expect(EditAccess.share(grant: "g", listing: nil) == .uncertain)
        #expect(EditAccess.share(grant: nil, listing: [editor]) == .uncertain)
    }

    /* A family folder: removal is a loss; a folder not writable here right now only stops saves (never offered Save back). */
    @Test func aFamilyFileIsLostOnlyWhenTheFamilyIsRemoved() {
        #expect(EditAccess.family(removed: true, writable: true) == .lost)
        #expect(EditAccess.family(removed: false, writable: true) == .allowed)
        #expect(EditAccess.family(removed: false, writable: false) == .uncertain)
    }
}
