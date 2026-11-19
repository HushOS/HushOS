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
 * scrolling with it, and Source or Preview when narrow. No colouring on the phone. Its text
 * lives in this screen only: leaving it, a sign-out or another session drops it, and nothing is kept
 * on the phone (drafts are Editing 1c).
 */
struct TextEditorScreen: View {
    @Environment(DriveStore.self) private var store
    @Environment(\.dismiss) private var dismiss
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
        .task(id: "\((loadFrom ?? item).id)-\(attempt)-\(ObjectIdentifier(store.vault).hashValue)") { await load() }
        // Another session (a sign-out and in, another account): this text was the last one's.
        .onChange(of: ObjectIdentifier(store.vault)) { _, _ in
            ending = true
            store.editorWork.release(key: item.ref)
            session.close()
            work?.cancel()
            editor.drop()
            savedText = ""
            saveState = nil
            pieces = nil
            dismiss()
        }
        .onChange(of: leaveAsked) { _, _ in requestClose() }
        // What the editor holds, kept current in the store's EditorWork, so a rebuild (an unfold, a resize) loses none of it.
        .onChange(of: remembered) { _, _ in remember() }
        // Side by side (unfolded, or the window widened): the preview renders the text now and follows from here.
        .onChange(of: sideBySide, initial: true) { _, now in
            scroll.linked = now
            if now, phase != .loading { render() }
        }
        .onAppear {
            scroll.box = editor
            scroll.movePreview = { target in
                switch target {
                case .y(let y): previewPosition.scrollTo(y: y)
                case .block(let index): previewPosition.scrollTo(id: index, anchor: .top)
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
            // The text stays only while the store holds it for this editor presented again (a rebuild, not a close).
            if ending || store.editorWork.held(key: item.ref, owner: store.vault)?.box !== editor { editor.drop() }
            savedText = ""
            saveState = nil
            pieces = nil
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
                .disabled(!edited || saving)
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
                if previewTooLong { note(EditorWords.previewTooLong) }
                note(TextEditing.words(reason))
                if let text {
                    sourceAndPreview(PlainTextView(box: editor, text: text, editable: false, onChange: {}, onScroll: sourceScrolled))
                } else { Spacer() }
            }
        case .editing:
            VStack(spacing: 0) {
                if isMarkdown, !sideBySide { panes }
                if previewTooLong { note(EditorWords.previewTooLong) }
                if let line = closing ? EditorWords.finishing : failure ?? (edited ? nil : status) {
                    note(line, failed: !closing && failure != nil)
                }
                if let mixed = format.flatMap(TextEditing.mixedNote) { note(mixed) }
                // The text view stays while the preview shows: it holds the text and its undo.
                sourceAndPreview(PlainTextView(box: editor, text: editor.opening, editable: true, onChange: {
                    if !edited { edited = true }
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
        if text.utf8.count > MarkdownDocument.limit {
            previewTooLong = true
            return
        }
        scroll.rendering = true
        let revision = previewRevision
        Task {
            let lines = text.utf8.lazy.filter { $0 == 0x0A }.count + 1
            let parsed = await Task.detached(priority: .userInitiated) { MarkdownDocument.parseLined(text) }.value
            scroll.rendering = false
            // Another text since (Open theirs, a close): this rendering is the last one's.
            guard revision == previewRevision, phase != .loading else { return }
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
        EditorPreviewPane(pieces: pieces, position: $previewPosition, scroll: scroll)
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
        ending = true
        store.editorWork.release(key: item.ref)
        session.close()
        work?.cancel()
        editor.drop()
        savedText = ""
        saveState = nil
        pieces = nil
        edited = false
        dismiss()
    }

    /* What changes the state the store keeps for this editor (EditorWork.state). */
    private var remembered: String {
        "\(phase)|\(edited)|\(pane)|\(status ?? "")|\(startedFrom ?? "")|\(target?.id ?? "")|\(target?.node.currentVersion?.id ?? "")|\(marked?.node.currentVersion?.id ?? "")|\(loadFrom?.id ?? "")|\(format?.mixed ?? false)"
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
                                format: format, edited: edited, status: status, previewing: pane == .preview)
        let work = store.editorWork.held(key: item.ref, owner: store.vault).flatMap { $0.box === editor ? $0 : nil } ?? EditorWork(box: editor)
        work.state = state
        store.editorWork.hold(work, key: item.ref, owner: store.vault)
    }

    /* Presented again after a rebuild: the same text view (its text, cursor, scroll and undo) and the state it had. */
    private func adopt(_ work: EditorWork, _ state: EditorState) {
        editor = work.box
        scroll.box = work.box
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
        switch state.held {
        case .editing: phase = .editing
        case .readOnly(let reason, let text): phase = .readOnly(reason, text)
        }
        if sideBySide || pane == .preview { render() }
    }

    /* The file as the server lists it now, read afresh: what a save writes is these bytes, edited. */
    private func load() async {
        // Presented again after a rebuild: the work the store held, never a fresh read (which would drop what was typed).
        if loadFrom == nil, phase == .loading, let work = store.editorWork.held(key: item.ref, owner: store.vault),
           work.box !== editor, let state = work.state {
            adopt(work, state)
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
        guard phase == .editing, !saving, let file = target else { return }
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
        guard let file = target, let from = source, let token = session.take(store.vault) else { return }
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
            target = made.file
            startedFrom = destination?.holds(made.file) == true ? made.versionId : nil
            if TextEditing.speaksFor(made.file, versionId: made.versionId, at: destination) { marked = made.file }
            savedText = text
            settle(text, as: bytes)
            edited = !TextEditing.same(editor.text, text)
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
        // Another text opens: nothing begun on this one publishes over it.
        session.reopened()
        work?.cancel()
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

/* An open editor's work, held by the store (DriveStore.editorWork) so a rebuild of the screens loses none of it. */
@MainActor final class EditorWork {
    /* The text view's box: the view itself, with its text, cursor, scroll and undo, is handed to the editor presented again. */
    let box: TextBox
    var state: EditorState?

    init(box: TextBox) {
        self.box = box
    }
}

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
     * again takes this very view back, with its text, cursor, scroll and undo. Let go by drop.
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

    func open(_ text: String) {
        opening = text
        view?.text = text
    }

    func drop() {
        opening = ""
        view?.text = ""
        view?.undoManager?.removeAllActions()
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
