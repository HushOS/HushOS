import HushOSKit
import SwiftUI
import UIKit

/*
 * The text editor (Editing 1a and 1b; docs/editing-design.md sections 1 and 3, the web's
 * text-editor.tsx): the system's text view over the file's current version, read again from the
 * server. Saving is explicit (Save), a new version through the save path (TextSave over SaveRuns), in
 * the file's own encoding, byte order mark and line breaks (TextEditing.SaveState), with the stale choices
 * when someone else saved first: Save on top, Save as a copy, Open theirs after a confirmation. A file
 * it can't save byte for byte opens read-only with a note. Markdown shows the viewer's rendering (images named, never
 * fetched) beside the source when the window is wide (SideBySide: the iPhone Duo's inner display), following typing and
 * scrolling with it, and Source or Preview when narrow. No colouring on the phone. Its text lives in this screen (and,
 * across a rebuild, the store's EditorWork); what was typed and not saved is also kept as a draft (Editing 1c, Drafts.swift):
 * sealed on this phone about two seconds after a change and on backgrounding, so reopening the file after the app was
 * killed or closed offers it back. Held work taken back after a rebuild never offers a draft (it is the same text, newer).
 */
struct TextEditorScreen: View {
    @Environment(DriveStore.self) private var store
    @Environment(\.dismiss) private var dismiss
    @Environment(\.scenePhase) private var scenePhase
    @Environment(\.horizontalSizeClass) private var sizeClass
    /* The room the editor has: with the size class, whether source and preview sit side by side. */
    @State private var width: CGFloat = 0
    let item: Opened
    /* Moved on by the viewer when something asks it to go: closed at once without changes, asked about with them. */
    var leaveAsked = 0
    /* The person kept editing (Keep editing, or a save a close waited on didn't land): a link held for the editor goes. */
    var onStay: () -> Void = {}
    /* A save landed a new version of the file the viewer shows: the viewer shows it from now on. */
    var onSaved: (Opened) -> Void = { _ in }

    private enum Phase: Equatable {
        case loading
        case failed
        case readOnly(TextReadOnly, String?)
        case editing
    }

    @State private var phase: Phase = .loading
    @State private var editor = TextBox()
    /* The file being written and the version this text started from. */
    @State private var target: Opened?
    @State private var startedFrom: String?
    /*
     * The row the text's bytes were read from: a copy is signed as it is (an Unverified file's copy stays Unverified). Set
     * only when a version is opened; a save or a copy moves `target` on, and the copy's row (which may already carry someone
     * else's version) never stands in for it.
     */
    @State private var source: Opened?
    /* The workspace and folder the file was opened in (EditDestination): every save and copy lists and writes there. */
    @State private var destination: EditDestination?
    /*
     * The row the header names and marks: the one the text was read from, moved on only by a save or a copy whose row
     * lists the very version it published (TextEditing.speaksFor). Its name and its mark always come from this one row.
     */
    @State private var marked: Opened?
    /* The text as last opened or saved: typing then undoing it is no change (Save sends nothing, Close asks nothing). */
    @State private var savedText = ""
    /*
     * The session's saves (TextEditing.SaveState): the format found when the file opened, kept whatever is saved since, and
     * the text and bytes last opened or saved, so a text still as it was writes those bytes again. Nil while nothing
     * editable is open.
     */
    @State private var saveState: TextEditing.SaveState?
    /* The open file's encoding and line breaks: a mixed file says which a save writes. */
    @State private var format: TextFormat?
    /*
     * Markdown shows Source or Preview when narrow (the preview renders the text as it was when Preview was chosen), or
     * both side by side when wide, the preview following typing: a rendering at a time, and one more if the text changed
     * while it rendered, never waiting for typing to stop.
     */
    @State private var pane = Pane.source
    @State private var pieces: [MarkdownPiece]?
    @State private var previewPosition = ScrollPosition(edge: .top)
    @State private var scroll = EditorScroll()
    /* Moved on by Open theirs: a rendering of the text before it lands nowhere. */
    @State private var previewRevision = 0
    /* The text was past what the preview renders when Preview was chosen: it stayed on Source and says so. */
    @State private var previewTooLong = false

    private enum Pane: Hashable { case source, preview }
    @State private var edited = false
    @State private var saving = false
    @State private var status: String?
    @State private var failure: String?
    @State private var stale: StaleVersion?
    /*
     * Whether the conflict choices are on screen. Apart from `stale` (what they are about), which stays until the person
     * picks one or cancels: going to Open theirs' confirmation hides the choices without losing them, and Cancel there
     * shows them again.
     */
    @State private var choosing = false
    @State private var confirmTheirs = false
    @State private var confirmLeave = false
    /*
     * A close asked for while a save or a copy was on its way: never Discard then (it may still publish). The editor says it
     * is finishing, and once the save settles the close goes on (asking first if typed meanwhile) or, if it didn't land, is
     * let go with the reason on screen.
     */
    @State private var closing = false
    @State private var attempt = 0
    @State private var loadFrom: Opened?
    /* The save on its way, cancelled when the screen goes or the session changes. */
    @State private var work: Task<Void, Never>?
    /* This editor's session: the vault it opened under and the opened text; every path checks it (EditSession). */
    @State private var session = EditSession<Vault>()
    /* Ending on purpose (Close, Discard, another session): its work is let go. Otherwise the store keeps it for a rebuild. */
    @State private var ending = false
    /* A draft found at the first open, waiting for Restore or Discard: the alert is up while it waits. */
    @State private var draft: PendingDraft?
    @State private var offering = false
    /* A draft was looked for: once, at the first open (never after Open theirs, never for work taken back). */
    @State private var draftAsked = false
    /* The last draft couldn't be kept: one quiet line. */
    @State private var draftNotKept = false
    @State private var draftTimer = DraftTimer()
    /* Draft writes and removals, one after another in the order asked. */
    @State private var draftChain: Task<Void, Never>?

    private struct StaleVersion: Identifiable, Equatable {
        let currentVersionId: String?
        var id: String { currentVersionId ?? "gone" }
    }

    private var shown: Opened { target ?? item }

    /*
     * Decided by the row the text was read from (`source`: set by load, Open theirs included), never `target`, which a
     * save or a copy moves on.
     */
    private var isMarkdown: Bool {
        let read = source ?? item
        return MarkdownDocument.handles(name: read.name, mime: read.metadata.mime)
    }
    private var previewing: Bool { isMarkdown && pane == .preview && !sideBySide }
    /* Both at once: the window is wide (regular width, and room for two panes), never by the screen or the device. */
    private var sideBySide: Bool { isMarkdown && SideBySide.shows(regularWidth: sizeClass == .regular, width: width) }

    var body: some View {
        NavigationStack {
            content
                .onGeometryChange(for: CGFloat.self) { $0.size.width } action: { width = $0 }
                .navigationTitle((marked ?? shown).name)
                .navigationBarTitleDisplayMode(.inline)
                .toolbar { toolbar }
                .background(Alpine.ground.ignoresSafeArea())
        }

        // Changes are never dropped by a swipe: Close asks first.
        .interactiveDismissDisabled(edited || saving)
        .task(id: "\(attempt)-\(ObjectIdentifier(store.vault).hashValue)") { await load() }
        // Reads start only when asked (the first open, Try again, Open theirs: `attempt`), never because restored state
        // names another file: adopting parked work changes nothing this task is keyed on.
        // The file was taken out of reach while on screen (DriveStore.checkEditorWork): the editor ends, its text gone.
        .onChange(of: store.editorAccessEnded) { _, _ in
            // Access confirmed lost: the draft goes with the text.
            if let target { store.dropDraft(of: target) }
            draftTimer.cancel()
            ending = true
            session.close()
            work?.cancel()
            editor.forget()
            savedText = ""
            saveState = nil
            pieces = nil
            edited = false
            dismiss()
        }
        // Another session (a sign-out and in, another account): this text was the last one's. Its draft is left as it is
        // (a sign-out deletes it with the account's other files).
        .onChange(of: ObjectIdentifier(store.vault)) { _, _ in
            draftTimer.cancel()
            ending = true
            store.editorWork.release(key: item.ref)
            session.close()
            work?.cancel()
            editor.forget()
            savedText = ""
            saveState = nil
            pieces = nil
            dismiss()
        }
        .onChange(of: leaveAsked) { _, _ in requestClose() }
        // Going to the background: the text as it is now is kept, in case the app is not brought back.
        .onChange(of: scenePhase) { _, now in
            if now != .active { draftTimer.flush { draftTurn() } }
        }
        // What the editor holds, kept current in the store's EditorWork, so a rebuild (an unfold, a resize) loses none of it.
        .onChange(of: remembered) { _, _ in remember() }
        // Side by side (unfolded, or the window widened): the preview renders the text now and follows from here.
        .onChange(of: sideBySide, initial: true) { _, now in
            scroll.linked = now
            if now, phase != .loading { render() }
        }
        .onAppear {
            scroll.box = editor
            // Only the position's binding: the scroll object never holds this screen (and through it the session).
            let position = $previewPosition
            scroll.movePreview = { target in
                switch target {
                case .y(let y): position.wrappedValue.scrollTo(y: y)
                case .block(let index): position.wrappedValue.scrollTo(id: index, anchor: .top)
                }
            }
        }
        // The header's row keeps its own family verdict, apart from the listing's (another device's newer version judged
        // meanwhile never takes the mark off this text), and is judged again whenever its family's trust dropped it.
        .onChange(of: heldKey, initial: true) { _, _ in store.holdForEditor(marked ?? shown) }
        .task(id: "\(heldKey)-\(unjudged)") { if unjudged { await store.judgeFamilyItems([marked ?? shown]) } }
        .onChange(of: saving) { _, now in
            guard !now, closing else { return }
            closing = false
            // Not landed (it failed, or someone else's version is current): the editor stays, saying why.
            guard failure == nil, stale == nil else { return onStay() }
            if changed() { confirmLeave = true } else { close() }
        }
        // Up: a link or a notification waits for this editor (DriveStore.route), whatever covers or uncovers the viewer.
        .onAppear { store.editorOpen = true }
        .onDisappear {
            // A save still on its way belongs to this screen's session: it stops with it.
            session.close()
            work?.cancel()
            scroll.movePreview = { _ in }
            // Torn down without a close (an unfold): the work waits for this editor presented again, and nothing it held
            // goes on. A link waiting on its Discard or Keep editing is still waiting; the restored editor decides it. Its
            // draft is written now too, in case the app goes before the editor comes back.
            if !ending, heldWork() != nil {
                draftTimer.flush { draftTurn() }
                remember()
                store.editorWork.park(key: item.ref)
                return
            }
            editor.forget()
            savedText = ""
            saveState = nil
            pieces = nil
            draftTimer.cancel()
            // Gone: what waited for it goes on, once; its family row's verdict is the listing's again.
            store.holdForEditor(nil)
            store.editorClosed()
        }
        .confirmationDialog(stale?.currentVersionId == nil ? EditorWords.goneTitle : EditorWords.staleTitle,
                            isPresented: $choosing, titleVisibility: .visible, presenting: stale) { choice in
            if let current = choice.currentVersionId {
                Button(EditorWords.onTop) { stale = nil; begin { await save(onTopOf: current) } }
                Button(EditorWords.copy) { stale = nil; begin { await saveCopy() } }
                Button(EditorWords.theirs, role: .destructive) { choosing = false; confirmTheirs = true }
            } else {
                Button(EditorWords.copy) { stale = nil; begin { await saveCopy() } }
            }
            Button(EditorWords.cancel, role: .cancel) { stale = nil }
        } message: { choice in
            Text(choice.currentVersionId == nil ? EditorWords.goneText : EditorWords.staleText)
        }
        .alert(EditorWords.discardTitle, isPresented: $confirmTheirs) {
            Button(EditorWords.discard, role: .destructive) {
                stale = nil
                Task { await openTheirs() }
            }
            // Back to the three choices: nothing was discarded.
            Button(EditorWords.cancel, role: .cancel) { choosing = stale != nil }
        } message: {
            Text(EditorWords.theirsText)
        }
        .confirmationDialog(EditorWords.discardTitle, isPresented: $confirmLeave, titleVisibility: .visible) {
            Button(EditorWords.discard, role: .destructive) { close() }
            Button(EditorWords.keepEditing, role: .cancel) { onStay() }
        } message: {
            Text(EditorWords.leaveText(shown.name))
        }
        // A draft from an earlier session: answered before the text can be changed.
        .alert(draft.map { EditorWords.restoreOffer(DraftRules.when($0.draft.frame.savedAt)) } ?? "", isPresented: $offering,
               presenting: draft) { _ in
            Button(EditorWords.restore) { restoreDraft() }
            Button(EditorWords.discardDraft, role: .destructive) { discardDraft() }
        }
    }

    /* The header's exact row, as the family verdicts know it. */
    private var heldKey: String {
        let row = marked ?? shown
        return "\(row.ref.workspaceId)/\(row.id)/\(row.node.changeSeq ?? 0)/\(row.node.metadataVersion)/\(row.node.currentVersion?.id ?? "")"
    }

    /* A family row whose verdict isn't held (not judged yet, or dropped by a trust change). */
    private var unjudged: Bool {
        let row = marked ?? shown
        return store.isFamily(row) && store.familyVerdict(of: row) == nil
    }

    /* The name and, under it, the verdict on the version the text is, as the viewer's title marks a file. */
    private var header: some View {
        let row = marked ?? shown
        return VStack(spacing: 1) {
            Text(row.name).font(Theme.Text.callout.weight(.semibold)).foregroundStyle(Alpine.ink).lineLimit(1)
            if let provenance = store.provenance(of: row) {
                UnverifiedMark(provenance: provenance).frame(minHeight: 16)
            } else if let saved = store.savedCopy(of: row) {
                Text(saved.line).font(.caption).foregroundStyle(Alpine.inkMuted).multilineTextAlignment(.center)
                    .fixedSize(horizontal: false, vertical: true)
            } else if let seen = store.seenBy(of: row) {
                Text("Added by \(seen.shown) · Not verified").font(.caption).foregroundStyle(Alpine.inkMuted).lineLimit(1).truncationMode(.middle)
            }
        }
        .padding(.horizontal, Alpine.Space.s2)
    }

    @ToolbarContentBuilder private var toolbar: some ToolbarContent {
        ToolbarItem(placement: .principal) { header }
        ToolbarItem(placement: .cancellationAction) {
            Button { requestClose() } label: { HeaderWord(text: EditorWords.close) }
        }
        if phase == .editing {
            ToolbarItem(placement: .confirmationAction) {
                Button { begin { await save() } } label: {
                    if saving { ProgressView() } else { HeaderWord(text: EditorWords.save) }
                }
                .disabled(!edited || saving || accessUnsure)
                .accessibilityLabel(saving ? EditorWords.saving : EditorWords.save)
            }
        }
    }

    @ViewBuilder private var content: some View {
        switch phase {
        case .loading:
            ProgressView().tint(Alpine.primary).frame(maxWidth: .infinity, maxHeight: .infinity)
        case .failed:
            EmptyStateView(title: EditorWords.failed) {
                Button(EditorWords.tryAgain) { phase = .loading; attempt += 1 }.buttonStyle(PrimaryCapsuleStyle())
            }
            .frame(maxHeight: .infinity)
        case .readOnly(let reason, let text):
            VStack(spacing: 0) {
                if text != nil, isMarkdown, !sideBySide { panes }
                if previewTooLong, !sideBySide { note(EditorWords.previewTooLong) }
                note(TextEditing.words(reason))
                if let text {
                    sourceAndPreview(PlainTextView(box: editor, text: text, editable: false, onChange: {}, onScroll: sourceScrolled))
                } else { Spacer() }
            }
        case .editing:
            VStack(spacing: 0) {
                if isMarkdown, !sideBySide { panes }
                if previewTooLong, !sideBySide { note(EditorWords.previewTooLong) }
                if let line = closing ? EditorWords.finishing : failure ?? (edited ? nil : status) {
                    note(line, failed: !closing && failure != nil)
                }
                if let mixed = format.flatMap(TextEditing.mixedNote) { note(mixed) }
                if draftNotKept { note(EditorWords.draftNotKept) }
                if accessUnsure { accessNote }
                // The text view stays while the preview shows: it holds the text and its undo.
                sourceAndPreview(PlainTextView(box: editor, text: editor.opening, editable: draft == nil, onChange: {
                    if !edited { edited = true }
                    draftTimer.changed { draftTurn() }
                    status = nil
                    scroll.revision += 1
                    // Said of the text as it was when Preview was chosen; the size is asked again at the next one.
                    if previewTooLong { previewTooLong = false }
                    if sideBySide { render() }
                }, onScroll: sourceScrolled))
            }
        }
    }

    /*
     * The text view and the preview: side by side when wide, else one over the other (the text view kept underneath).
     * One layout that changes its arrangement, so a fold, an unfold or a resize keeps the same text view: its text, its
     * cursor and where it was scrolled.
     */
    private func sourceAndPreview(_ source: PlainTextView) -> some View {
        let layout = sideBySide ? AnyLayout(HStackLayout(spacing: 0)) : AnyLayout(ZStackLayout())
        return layout {
            source.hiddenWhile(previewing)
            if sideBySide || previewing {
                preview.overlay(alignment: .leading) {
                    if sideBySide { Rectangle().fill(Alpine.rule).frame(width: 1) }
                }
            }
        }
    }

    /* The person scrolled the source (dragging it, or its fling still gliding): side by side, the preview follows. */
    private func sourceScrolled(_ view: UIScrollView) {
        if view.isTracking || view.isDragging || view.isDecelerating { scroll.sourceScrolled() }
    }

    /*
     * The preview renders the text as it is now, off the main thread: one rendering at a time, and one more once it lands
     * if the text changed meanwhile (never a wait for typing to stop). Past what the viewer renders, it says so instead.
     */
    private func render() {
        if scroll.rendering {
            scroll.again = true
            return
        }
        let text = editor.text
        // Past what the viewer renders: no preview at all (no spinner, no old blocks, nothing scrolled by it) until it fits.
        if text.utf8.count > MarkdownDocument.limit {
            previewTooLong = true
            pieces = nil
            scroll.unrendered()
            return
        }
        scroll.rendering = true
        let revision = previewRevision
        Task {
            // Parsed and its lines counted off the main actor.
            let (parsed, lines) = await Task.detached(priority: .userInitiated) {
                (MarkdownDocument.parseLined(text), text.utf8.lazy.filter { $0 == 0x0A }.count + 1)
            }.value
            scroll.rendering = false
            // Another text since (Open theirs, a close), or past the limit since it began: this rendering is not shown,
            // and one asked for meanwhile (the new text's) runs now rather than waiting for the next edit.
            guard revision == previewRevision, phase != .loading, !previewTooLong else {
                if scroll.again {
                    scroll.again = false
                    if phase != .loading { render() }
                }
                return
            }
            pieces = parsed
            scroll.rendered(parsed, lines: lines)
            if scroll.again {
                scroll.again = false
                render()
            }
            // Laid out first, then placed: at the line a narrow switch kept, or beside the source (typing keeps the cursor in
            // view in the source, and the preview follows it).
            Task { @MainActor in
                if let line = scroll.kept, !sideBySide {
                    scroll.kept = nil
                    if let target = scroll.previewTarget(for: line) { scroll.movePreview(target) }
                } else if sideBySide {
                    scroll.sourceScrolled()
                }
            }
        }
    }

    /* Source or Preview, the system's segmented control. */
    private var panes: some View {
        Picker(EditorWords.show, selection: $pane) {
            Text(EditorWords.source).tag(Pane.source)
            Text(EditorWords.preview).tag(Pane.preview)
        }
        .pickerStyle(.segmented)
        .labelsHidden()
        .padding(.horizontal, Alpine.Space.s4)
        .padding(.vertical, Alpine.Space.s2)
        .onChange(of: pane) { _, now in
                guard now == .preview else {
                // Back to Source at the line the preview showed at its top.
                if let line = scroll.previewLine(at: scroll.previewTop) {
                    Task { @MainActor in scroll.showSource(line) }
                }
                return
            }
            let text = editor.text
            // Past what the viewer renders (MarkdownDocument.limit, in UTF-8 bytes): Source stays, and says why.
            if text.utf8.count > MarkdownDocument.limit {
                previewTooLong = true
                pane = .source
                return
            }
            previewTooLong = false
            // The words as they are now; the keyboard goes, since nothing is typed into a preview.
            editor.endEditing()
            // Shown at the line the source had at its top.
            scroll.kept = scroll.sourceLine()
            pieces = nil
            render()
        }
    }

    /*
     * The viewer's rendering: raw HTML dropped, links only on a tap, images named and never fetched. Not selectable: a copy
     * from here would skip the editor's local-only, expiring one.
     */
    private var preview: some View {
        EditorPreviewPane(pieces: pieces, unavailable: sideBySide && previewTooLong, position: $previewPosition, scroll: scroll)
    }

    /*
     * Whether access to this file couldn't be confirmed (DriveStore.editAccess: a share listed but not opened, a
     * listing or a family check that failed, a family folder not writable here right now): the text stays, and
     * nothing is saved until access is confirmed again. Read from the store's observed shares and families.
     */
    private var accessUnsure: Bool {
        guard let work = heldWork() else { return false }
        return store.editAccess(work) == .uncertain
    }

    /* Saves are off while access is unconfirmed: said once, with Try again (the shares' listing or the family's check). */
    private var accessNote: some View {
        HStack(spacing: Alpine.Space.s3) {
            Text(EditorWords.accessUnsure)
                .font(Theme.Text.footnote)
                .foregroundStyle(Alpine.inkMuted)
                .frame(maxWidth: .infinity, alignment: .leading)
            Button(EditorWords.tryAgain) {
                let file = item
                Task { await store.recheckEditorAccess(file) }
            }
            .font(Theme.Text.footnote)
            .tint(Alpine.primary)
        }
        .padding(.horizontal, Alpine.Space.s4).padding(.vertical, Alpine.Space.s2)
        .background(Alpine.surface)
    }

    private func note(_ text: String, failed: Bool = false) -> some View {
        Text(text)
            .font(Theme.Text.footnote)
            .foregroundStyle(failed ? Alpine.danger : Alpine.inkMuted)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.horizontal, Alpine.Space.s4).padding(.vertical, Alpine.Space.s2)
            .background(Alpine.surface)
            .accessibilityAddTraits(.updatesFrequently)
    }

    /* Close: while a save is on its way it waits for it (`closing`); with changes it asks first. */
    private func requestClose() {
        if saving { closing = true } else if changed() { confirmLeave = true } else { close() }
    }

    /* Changes to lose or save: typed, and not back to what was last opened or saved (typed, then undone). */
    private func changed() -> Bool {
        guard edited else { return false }
        if TextEditing.same(editor.text, savedText) {
            edited = false
            return false
        }
        return true
    }

    /*
     * The session ends here, at once (a save not yet started never starts, nothing begun lands on screen), not only when
     * the screen goes (onDisappear stays the fallback).
     */
    private func close() {
        // Closed by choice (Discard, nothing to keep, or saved): the draft goes. An offer still unanswered keeps its draft.
        draftTimer.cancel()
        if draft == nil, let target { removeDraft(of: target) }
        ending = true
        store.editorWork.release(key: item.ref)
        session.close()
        work?.cancel()
        editor.forget()
        savedText = ""
        saveState = nil
        pieces = nil
        edited = false
        dismiss()
    }

    /* What changes the state the store keeps for this editor (EditorWork.state). */
    private var remembered: String {
        "\(phase)|\(edited)|\(pane)|\(confirmLeave)|\(status ?? "")|\(startedFrom ?? "")|\(target?.id ?? "")|\(target?.node.currentVersion?.id ?? "")|\(marked?.node.currentVersion?.id ?? "")|\(loadFrom?.id ?? "")|\(format?.mixed ?? false)|\(draft != nil)"
    }

    /* The editor's state, held by the store with its text view (DriveStore.editorWork), for the editor presented again. */
    private func remember() {
        guard !ending, let target, let destination else { return }
        let held: EditorState.Held
        switch phase {
        case .editing: held = .editing
        case .readOnly(let reason, let text): held = .readOnly(reason, text)
        case .loading, .failed: return
        }
        let state = EditorState(held: held, loadFrom: loadFrom, target: target, startedFrom: startedFrom, source: source,
                                destination: destination, marked: marked, savedText: savedText, saveState: saveState,
                                format: format, edited: edited, status: status, previewing: pane == .preview,
                                askingLeave: confirmLeave, draft: draft)
        // The share that let this person edit, recorded once: a later listing says whether that grant itself went.
        let work = heldWork() ?? EditorWork(file: item, box: editor, grant: store.editGrant(for: item))
        work.remember(state)
        store.editorWork.hold(work, key: item.ref, owner: store.vault)
    }

    /* This editor's work as the store holds it (the same text box), if it does. */
    private func heldWork() -> EditorWork? {
        store.editorWork.held(key: item.ref, owner: store.vault).flatMap { $0.box === editor ? $0 : nil }
    }

    /* Presented again after a rebuild: the same text view (its text, cursor, scroll and undo) and the state it had. */
    private func adopt(_ work: EditorWork, _ state: EditorState) {
        take(work)
        loadFrom = state.loadFrom
        target = state.target
        startedFrom = state.startedFrom
        source = state.source
        destination = state.destination
        marked = state.marked
        savedText = state.savedText
        saveState = state.saveState
        format = state.format
        edited = state.edited
        status = state.status
        pane = state.previewing ? .preview : .source
        scroll.revision += 1
        // The same session's text, taken back: no draft is looked for. An offer that was up when the screens went is up again.
        draftAsked = true
        draft = state.draft
        offering = state.draft != nil
        // "Discard your changes?" was open when the screens went, or a link still waits on it: asked again, and the link
        // goes on only once it is answered.
        if state.askingLeave || store.editorHoldsSomething { confirmLeave = true }
        switch state.held {
        case .editing: phase = .editing
        case .readOnly(let reason, let text): phase = .readOnly(reason, text)
        }
        if sideBySide || pane == .preview { render() }
    }

    /* The held work's text box, as this editor's from here. */
    private func take(_ work: EditorWork) {
        editor = work.box
        scroll.box = work.box
    }

    /* The file as the server lists it now, read afresh: what a save writes is these bytes, edited. */
    private func load() async {
        // Presented again after a rebuild: the work the store held, never a fresh read of the old version (which would
        // drop what was typed); after Open theirs, their version is read again, never the old baseline over an empty box.
        // Not once access to the file is confirmed lost: the held text is emptied and this editor ends (its close lets a
        // held link go on). Access that couldn't be confirmed keeps it, with saves stopped (accessUnsure).
        var lost = false
        if loadFrom == nil, phase == .loading,
           let work = store.editorWork.held(key: item.ref, owner: store.vault, access: { _, work in store.editAccess(work) },
                                            dropped: { [ref = item.ref] work in
                                                work.box.forget()
                                                if work.file.ref == ref { lost = true }
                                            }),
           work.box !== editor {
            switch work.restore {
            case .adopt(let state):
                adopt(work, state)
                return
            case .read(let theirs):
                take(work)
                loadFrom = theirs
            case .fresh:
                take(work)
            }
        }
        if lost {
            ending = true
            dismiss()
            return
        }
        let from = loadFrom ?? item
        // Read under the vault this editor opened with, and shown only while its session lasts.
        guard let token = session.take(store.vault) else { return }
        let vault = token.owner
        do {
            // The row in the file's own folder and workspace, and its bytes read for that row's version in that
            // workspace (never a kept copy of whatever version, never another drive's row of the same id).
            // The folder it opens in is where it writes from now on: fixed here, at the first open, never from a later row.
            let at = destination ?? EditDestination(of: from)
            let (_, listed) = try await vault.editTarget(from, at: at)
            guard session.live(token, current: store.vault) else { return }
            guard let file = listed else {
                phase = .failed
                return
            }
            if let size = file.size, size > TextEditing.limit {
                phase = .readOnly(.tooLarge, nil)
                return
            }
            let data = try await vault.editBytes(file, limit: TextEditing.limit)
            guard session.live(token, current: store.vault) else { return }
            target = file
            startedFrom = file.node.currentVersion?.id
            source = file
            destination = at
            marked = file
            edited = false
            switch TextEditing.open(data) {
            case .editable(let text, let opened):
                // The first open only (not Open theirs, not work taken back): a draft of this file from an earlier
                // session, answered before the text can be changed.
                var found: PendingDraft?
                if loadFrom == nil, !draftAsked {
                    draftAsked = true
                    if let kept = await vault.readDraft(of: file) {
                        guard session.live(token, current: store.vault) else { return }
                        let versionId = file.node.currentVersion?.id
                        switch DraftRules.offer(kept, openedVersionId: versionId, openedText: text) {
                        case .same: removeDraft(of: file)
                        case let kind: found = PendingDraft(draft: kept, kind: kind, openedVersionId: versionId, file: file)
                        }
                    }
                }
                draft = found
                offering = found != nil
                editor.open(text)
                savedText = text
                // From what was just opened, never decoded again.
                saveState = TextEditing.SaveState(format: opened, text: text, bytes: data)
                format = opened
                phase = .editing
                if sideBySide { render() }
            case .readOnly(let reason, let text):
                saveState = nil
                format = nil
                editor.open(text ?? "")
                phase = .readOnly(reason, text)
                if sideBySide, text != nil { render() }
            }
        } catch where !ErrorWords.isCancellation(error) {
            if sessionRefused(error) { return }
            if session.live(token, current: store.vault) { phase = .failed }
        } catch {}
    }

    /*
     * A 401 under this editor's work (a listing, a read, a run stopped by one): the app's session check, never a line in
     * the editor. DriveStore.report ends the session in use only, and says nothing of one a later sign-in replaced.
     */
    private func sessionRefused(_ error: Error) -> Bool {
        let refusal: Error? = endsSession(error) ? error : (error as? SaveRunStopped)?.sessionRefusal
        guard let refusal else { return false }
        store.report(refusal)
        return true
    }

    private func begin(_ job: @escaping @MainActor () async -> Void) {
        work?.cancel()
        work = Task { await job() }
    }

    /* Whether work begun with `token` may still go on (EditSession.live): asked before a run starts and before the screen changes. */
    private func stillOn(_ token: EditSession<Vault>.Token) -> Bool {
        session.live(token, current: store.vault)
    }

    /* Save, and Save on top (`onTopOf`: the version current now). */
    private func save(onTopOf: String? = nil) async {
        guard phase == .editing, !saving, !accessUnsure, let file = target else { return }
        // Back to the text as opened or saved: nothing to send, and no version that pushes out an older one.
        if onTopOf == nil, !changed() { return }
        // The session it starts in: the vault the editor opened with and its journal, never a replacement's.
        guard let token = session.take(store.vault) else { return }
        let vault = token.owner
        // The text and the session's format, taken here; written out off the main actor.
        let text = editor.text
        guard let state = saveState else { return }
        saving = true
        failure = nil
        status = nil
        defer { saving = false }
        // In the file's encoding, byte order mark and line breaks; unchanged, the bytes it opened as.
        let bytes = await Self.encoded(text, in: state)
        guard stillOn(token) else { return }
        do {
            let (folder, listed) = try await vault.editTarget(file, at: destination)
            guard stillOn(token) else { return }
            guard let listed else {
                stale = StaleVersion(currentVersionId: nil)
                choosing = true
                return
            }
            let saved = try await TextSave.version(bytes, of: listed, in: folder, startedFrom: onTopOf ?? startedFrom,
                                                   start: TextSave.runs(vault), stillOn: { @MainActor in stillOn(token) })
            guard stillOn(token) else { return }
            switch saved {
            case .stale(let current):
                stale = StaleVersion(currentVersionId: current)
                choosing = true
            case .saved(let landed, let versionId):
                // The version this save published, never the reply row's (which may already be someone else's):
                // unknown, the next save asks the stale question. Only a row still in the editor's folder sets it: one
                // that shows the file moved since it landed leaves the next save to find it gone from here.
                if destination?.holds(landed) == true {
                    target = landed
                    startedFrom = versionId
                    onSaved(landed)
                }
                if TextEditing.speaksFor(landed, versionId: versionId, at: destination) { marked = landed }
                savedText = text
                settle(text, as: bytes)
                // Typed while it saved: still changed (by bytes: "é" and "e" with an accent are different text here).
                edited = !TextEditing.same(editor.text, text)
                // The text is the file's now: its draft goes (or holds only what was typed meanwhile).
                draftTimer.flush { draftTurn() }
                status = EditorWords.saved
                if let parent = landed.node.parentId { await store.refresh(folder: parent) }
            }
        } catch {
            if sessionRefused(error) { return }
            guard stillOn(token) else { return }
            failure = ErrorWords.say(error) ?? EditorWords.saveFailed
        }
    }

    private func saveCopy() async {
        guard !accessUnsure, let file = target, let from = source, let token = session.take(store.vault) else { return }
        let vault = token.owner
        let text = editor.text
        guard let state = saveState else { return }
        saving = true
        failure = nil
        defer { saving = false }
        // The copy keeps the file's encoding and line breaks too, written out off the main actor.
        let bytes = await Self.encoded(text, in: state)
        guard stillOn(token) else { return }
        do {
            let (folder, _) = try await vault.editTarget(file, at: destination)
            let sources = try await vault.copySources(of: from, named: file)
            guard stillOn(token) else { return }
            let made = try await TextSave.copy(bytes, of: file, in: folder, sources: sources, start: TextSave.runs(vault),
                                               stillOn: { @MainActor in stillOn(token) })
            guard stillOn(token) else { return }
            // From here on the editor writes the copy, by the run's own row and version; the file someone else saved
            // stays theirs.
            // The copy went into the editor's folder: a row answered from elsewhere sets no version to go on from, and
            // the next save finds it gone from here.
            // The text went into the copy: the file it came from keeps no draft of it.
            removeDraft(of: file)
            target = made.file
            startedFrom = destination?.holds(made.file) == true ? made.versionId : nil
            if TextEditing.speaksFor(made.file, versionId: made.versionId, at: destination) { marked = made.file }
            savedText = text
            settle(text, as: bytes)
            edited = !TextEditing.same(editor.text, text)
            draftTimer.flush { draftTurn() }
            status = EditorWords.savedCopy(made.file.name)
            await store.refresh(folder: folder.id)
        } catch {
            if sessionRefused(error) { return }
            guard stillOn(token) else { return }
            failure = ErrorWords.say(error) ?? EditorWords.saveFailed
        }
    }

    /*
     * What a save of `text` writes (SaveState.bytes), worked out off the main actor: encoding up to 8 MiB never holds up
     * typing or the screen.
     */
    private nonisolated static func encoded(_ text: String, in state: TextEditing.SaveState) async -> Data {
        await Task.detached(priority: .userInitiated) { state.bytes(for: text) }.value
    }

    /* A save or a copy of `text` landed as `bytes`: in one line break from here, unless it sent the bytes it had. */
    private func settle(_ text: String, as bytes: Data) {
        guard let state = saveState else { return }
        if bytes != state.bytes { format?.mixed = false }
        saveState = state.saved(text, as: bytes)
    }

    private func openTheirs() async {
        guard let file = target else { return }
        // This session's changes are discarded (the person confirmed it): so is their draft.
        draftTimer.cancel()
        removeDraft(of: file)
        // Another text opens: nothing begun on this one publishes over it.
        session.reopened()
        work?.cancel()
        // What the store holds for a rebuild is their version being read, never this text's baseline over an empty box.
        heldWork()?.reload(from: file)
        editor.drop()
        savedText = ""
        saveState = nil
        // Their text opens on Source: the preview showed the text just discarded.
        pane = .source
        pieces = nil
        previewRevision += 1
        previewTooLong = false
        edited = false
        status = nil
        failure = nil
        phase = .loading
        loadFrom = file
        attempt += 1
    }
}

extension TextEditorScreen {
    /*
     * A write turn (DraftRules.step): the text as it is now sealed and kept for the file being written, or removed once it
     * is back at what was last opened or saved. Never for read-only text, an unanswered offer, or no version to start from.
     */
    fileprivate func draftTurn() {
        guard !ending, let file = target else { return }
        let text = editor.text
        let step = DraftRules.step(editable: phase == .editing, offering: draft != nil, startedFrom: startedFrom,
                                   atBaseline: TextEditing.same(text, savedText))
        switch step {
        case .none:
            return
        case .remove:
            removeDraft(of: file)
        case .write:
            guard let state = saveState, let startedFrom else { return }
            let selected = editor.view?.selectedRange
            let kept = Draft(frame: DraftFrame(baseVersionId: startedFrom, format: state.format, savedAt: DraftStore.clock()),
                             text: text,
                             selection: selected.map {
                                 DraftSelection(from: UInt32(clamping: $0.location), to: UInt32(clamping: $0.location + $0.length))
                             })
            let vault = store.vault
            let previous = draftChain
            // Asked now: a sign-out's wipe before it lands keeps nothing of it.
            let asked = DraftStore.shared.generation
            draftChain = Task {
                await previous?.value
                let written = await vault.writeDraft(kept, of: file, asked: asked)
                draftNotKept = !written
            }
        }
    }

    /* The file's draft deleted, after any write asked for before. */
    fileprivate func removeDraft(of file: Opened) {
        let vault = store.vault
        let previous = draftChain
        draftChain = Task {
            await previous?.value
            await vault.removeDraft(of: file)
        }
    }

    /*
     * Restore: the draft's text in place of the opened one as an unsaved edit (Undo goes back), in the format it was typed
     * under. Someone saved since: the stale choices at once, and a save still starts from the draft's version, so nothing
     * lands over theirs without asking.
     */
    fileprivate func restoreDraft() {
        guard let pending = draft, let state = saveState else { return }
        draft = nil
        let found = pending.draft
        saveState = TextEditing.SaveState(format: found.frame.format, text: state.text, bytes: state.bytes)
        format = found.frame.format
        if pending.kind == .stale { startedFrom = found.frame.baseVersionId }
        editor.replaceAll(found.text, selection: found.selection)
        edited = !TextEditing.same(found.text, savedText)
        scroll.revision += 1
        if sideBySide { render() }
        if pending.kind == .stale {
            stale = StaleVersion(currentVersionId: pending.openedVersionId)
            choosing = true
        }
    }

    /* Discard: the draft goes, nothing more is asked; the text stays as the file holds it. */
    fileprivate func discardDraft() {
        guard let pending = draft else { return }
        draft = nil
        removeDraft(of: pending.file)
    }
}

/* A draft found at the first open: what it holds, how it is restored, and the file and version it opened at. */
struct PendingDraft {
    let draft: Draft
    let kind: DraftOffer
    let openedVersionId: String?
    let file: Opened
}

/*
 * An open editor's work, held by the store (DriveStore.editorWork) so a rebuild of the screens loses none of it: the
 * file it was opened on, the text box (the view itself, with its text, cursor, scroll and undo), and its state.
 */
typealias EditorWork = ParkedEdit<TextBox, EditorState>

/* What an editor knows besides its text: the file, the version its text started from, the baseline and the format. */
struct EditorState {
    enum Held {
        case editing
        case readOnly(TextReadOnly, String?)
    }

    let held: Held
    let loadFrom: Opened?
    let target: Opened
    let startedFrom: String?
    let source: Opened?
    let destination: EditDestination
    let marked: Opened?
    let savedText: String
    let saveState: TextEditing.SaveState?
    let format: TextFormat?
    let edited: Bool
    let status: String?
    let previewing: Bool
    /* "Discard your changes?" was open. */
    let askingLeave: Bool
    /* The draft offer was up, unanswered: up again in the editor presented after the rebuild. */
    let draft: PendingDraft?
}

/* The editor's words, the web's (text-editor.tsx editorWords). */
enum EditorWords {
    static let edit = "Edit"
    static let save = "Save"
    static let saving = "Saving"
    static let saved = "Saved"
    static func savedCopy(_ name: String) -> String { "Saved as “\(name)”" }
    static let saveFailed = "This couldn’t be saved, so nothing was kept."
    static let failed = "This file couldn’t be opened for editing."
    static let tryAgain = "Try again"
    static let close = "Close"
    static let staleTitle = "This file changed"
    static let staleText = "Someone saved a newer version while you were editing. Your changes aren’t saved yet."
    static let goneTitle = "This file was moved or deleted"
    static let goneText = "Your changes aren’t saved yet. Save them as a new file to keep them."
    static let onTop = "Save on top"
    static let copy = "Save as a copy"
    static let theirs = "Open theirs"
    static let cancel = "Cancel"
    static let discardTitle = "Discard your changes?"
    static let theirsText = "The newer version opens instead, and your changes are lost."
    static func leaveText(_ name: String) -> String { "Your changes to “\(name)” aren’t saved." }
    static let discard = "Discard changes"
    static let finishing = "Finishing your save, then closing"
    static let keepEditing = "Keep editing"
    static let show = "Show"
    static let source = "Source"
    static let preview = "Preview"
    static let previewTooLong = "This file is too long to preview while you edit."
    static let accessUnsure = "Your access to this file couldn’t be checked. Saving is off until it can be."
    static func restoreOffer(_ when: String) -> String { "Restore your unsaved changes from \(when)" }
    static let restore = "Restore"
    static let discardDraft = "Discard"
    static let draftNotKept = "Your unsaved changes couldn’t be kept on this device."
}

private extension View {
    /* Kept in place but out of sight, touch and VoiceOver (the text view under the preview keeps its text and undo). */
    func hiddenWhile(_ hidden: Bool) -> some View {
        opacity(hidden ? 0 : 1).allowsHitTesting(!hidden).accessibilityHidden(hidden)
    }
}

/*
 * The text view the editor holds: read only at save, never copied into SwiftUI state on every
 * keystroke (an 8 MiB file would be copied each time). `drop` empties it, so no text outlives the screen.
 */
@MainActor final class TextBox {
    /*
     * Held strongly while the editor is open: when a rebuild tears the screen down (EditorWork), the editor presented
     * again takes this very view back, with its text, cursor, scroll and undo. Let go by forget.
     */
    var view: UITextView?
    /* The keyboard is up in it. */
    var focused = false
    /* When editing last ended. A rebuild's dismissal ends it a moment before the editor is presented again. */
    var endedEditing: Date?
    /* Whether the keyboard was up when the screens were torn down: up, or put away by the teardown itself just now. */
    var keyboardWasUp: Bool {
        focused || endedEditing.map { Date().timeIntervalSince($0) < 1 } ?? false
    }
    /* The text the view opens with, until it has one. */
    private(set) var opening = ""

    var text: String { view?.text ?? opening }

    /* Moved on by every replacement of the whole text (open, Open theirs, a drop): line indexes of the old text are stale. */
    private(set) var changes = 0

    func open(_ text: String) {
        opening = text
        view?.text = text
        changes += 1
    }

    /* The whole text replaced as one edit the person can undo (a draft restored), with its selection put back. */
    func replaceAll(_ text: String, selection: DraftSelection?) {
        guard let view else {
            opening = text
            changes += 1
            return
        }
        if let all = view.textRange(from: view.beginningOfDocument, to: view.endOfDocument) {
            view.replace(all, withText: text)
        } else {
            view.text = text
        }
        changes += 1
        guard let selection else { return }
        let length = (view.text as NSString).length
        let from = min(Int(selection.from), length)
        let to = min(Int(selection.to), length)
        view.selectedRange = NSRange(location: min(from, to), length: abs(to - from))
        view.scrollRangeToVisible(view.selectedRange)
    }

    /* Emptied, the view kept (Open theirs puts their text in it). */
    func drop() {
        opening = ""
        view?.text = ""
        view?.undoManager?.removeAllActions()
        changes += 1
    }

    /* Emptied and let go: the editor ended, or its held work did. */
    func forget() {
        drop()
        view = nil
        focused = false
        endedEditing = nil
    }

    /* The keyboard goes (the preview takes nothing typed). */
    func endEditing() {
        view?.resignFirstResponder()
    }
}

/*
 * UITextView as a SwiftUI view: monospaced at the reader's text size, wrapped, no autocorrection,
 * capitals, smart punctuation, predictions or Writing Tools (each would change what the person
 * didn't type, or send their words to a model). A line break typed or pasted goes in as LF; a save
 * writes each as the file's own line break.
 */
struct PlainTextView: UIViewRepresentable {
    let box: TextBox
    let text: String
    let editable: Bool
    let onChange: () -> Void
    /* It scrolled: the side-by-side preview follows a person's scroll (EditorScroll). */
    var onScroll: (UIScrollView) -> Void = { _ in }

    func makeCoordinator() -> Coordinator { Coordinator(onChange: onChange, onScroll: onScroll) }

    func makeUIView(context: Context) -> UITextView {
        // The editor presented again after a rebuild: the same view, moved here, as it was.
        if let held = box.view {
            held.removeFromSuperview()
            held.delegate = context.coordinator
            held.isEditable = editable
            context.coordinator.box = box
            // The cursor stays where it was (the view keeps its selection); the keyboard comes back once it is on screen.
            (held as? EditorTextView)?.focusOnWindow = box.keyboardWasUp
            return held
        }
        let view = EditorTextView(usingTextLayoutManager: true)
        view.font = UIFontMetrics(forTextStyle: .body).scaledFont(for: .monospacedSystemFont(ofSize: 15, weight: .regular))
        view.adjustsFontForContentSizeCategory = true
        view.textColor = UIColor(Alpine.ink)
        view.backgroundColor = UIColor(Alpine.ground)
        view.tintColor = UIColor(Alpine.primary)
        view.autocorrectionType = .no
        view.autocapitalizationType = .none
        view.spellCheckingType = .no
        view.smartQuotesType = .no
        view.smartDashesType = .no
        view.smartInsertDeleteType = .no
        view.inlinePredictionType = .no
        view.writingToolsBehavior = .none
        view.dataDetectorTypes = []
        view.alwaysBounceVertical = true
        view.keyboardDismissMode = .interactive
        view.textContainerInset = UIEdgeInsets(top: 12, left: 12, bottom: 24, right: 12)
        view.isEditable = editable
        view.text = text
        view.delegate = context.coordinator
        view.accessibilityLabel = editable ? "Text" : "Text, read only"
        box.view = view
        context.coordinator.box = box
        return view
    }

    func updateUIView(_ view: UITextView, context: Context) {
        context.coordinator.onChange = onChange
        context.coordinator.onScroll = onScroll
        view.isEditable = editable
        if box.view !== view { box.view = view }
    }

    final class Coordinator: NSObject, UITextViewDelegate {
        var onChange: () -> Void
        var onScroll: (UIScrollView) -> Void
        weak var box: TextBox?
        init(onChange: @escaping () -> Void, onScroll: @escaping (UIScrollView) -> Void) {
            self.onChange = onChange
            self.onScroll = onScroll
        }

        func textViewDidChange(_ textView: UITextView) { onChange() }

        func scrollViewDidScroll(_ scrollView: UIScrollView) { onScroll(scrollView) }

        func textViewDidBeginEditing(_ textView: UITextView) { box?.focused = true }

        // A rebuild's dismissal ends editing first, a moment before the view comes back: see TextBox.keyboardWasUp.
        func textViewDidEndEditing(_ textView: UITextView) {
            box?.focused = false
            box?.endedEditing = Date()
        }

        func textView(_ textView: UITextView, shouldChangeTextIn range: NSRange, replacementText text: String) -> Bool {
            guard TextEditing.hasCarriageReturn(text) else { return true }
            // Put in as LF, as CodeMirror does: the file never gains a carriage return from the phone.
            guard let start = textView.position(from: textView.beginningOfDocument, offset: range.location),
                  let end = textView.position(from: start, offset: range.length),
                  let replaced = textView.textRange(from: start, to: end) else { return false }
            textView.replace(replaced, withText: TextEditing.lineFeeds(text))
            return false
        }
    }
}

/*
 * Copy and Cut put the text on this phone's pasteboard only, gone in two minutes, as every copy the app
 * makes is (not Universal Clipboard, not every app that reads the board later).
 */
final class EditorTextView: UITextView {
    /* Moved into the editor presented again after a rebuild with the keyboard up: up again once in its window. */
    var focusOnWindow = false

    override func didMoveToWindow() {
        super.didMoveToWindow()
        guard window != nil, focusOnWindow else { return }
        focusOnWindow = false
        // After the presentation settles: asked while the cover is still sliding in, UIKit refuses it.
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.6) { [weak self] in
            guard let self, self.window != nil else { return }
            self.becomeFirstResponder()
        }
    }

    override func copy(_ sender: Any?) {
        guard let range = selectedTextRange, let text = text(in: range), !text.isEmpty else { return }
        UIPasteboard.general.setItems([["public.utf8-plain-text": text]], options: [.localOnly: true, .expirationDate: Date().addingTimeInterval(120)])
    }

    override func cut(_ sender: Any?) {
        guard isEditable, let range = selectedTextRange, !range.isEmpty else { return }
        copy(sender)
        replace(range, withText: "")
    }
}
