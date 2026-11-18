import HushOSKit
import SwiftUI
import UIKit

/*
 * The text editor (Editing 1a; docs/editing-design.md sections 1 and 3, the web's text-editor.tsx):
 * the system's text view over the file's current version, read again from the server. Saving is
 * explicit (Save), a new version through the save path (TextSave over SaveRuns), with the stale
 * choices when someone else saved first: Save on top, Save as a copy, Open theirs after a
 * confirmation. A file it can't save byte for byte opens read-only with a note. No colouring on the
 * phone. Its text lives in this screen only: leaving it, a sign-out or another session drops it, and
 * nothing is kept on the phone (drafts are Editing 1c).
 */
struct TextEditorScreen: View {
    @Environment(DriveStore.self) private var store
    @Environment(\.dismiss) private var dismiss
    let item: Opened

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
    @State private var edited = false
    @State private var saving = false
    @State private var status: String?
    @State private var failure: String?
    @State private var stale: StaleVersion?
    @State private var confirmTheirs = false
    @State private var confirmLeave = false
    @State private var attempt = 0
    @State private var loadFrom: Opened?

    private struct StaleVersion: Identifiable, Equatable {
        let currentVersionId: String?
        var id: String { currentVersionId ?? "gone" }
    }

    private var shown: Opened { target ?? item }

    var body: some View {
        NavigationStack {
            content
                .navigationTitle(shown.name)
                .navigationBarTitleDisplayMode(.inline)
                .toolbar { toolbar }
                .background(Alpine.ground.ignoresSafeArea())
        }
        // Changes are never dropped by a swipe: Close asks first.
        .interactiveDismissDisabled(edited)
        .task(id: "\((loadFrom ?? item).id)-\(attempt)-\(ObjectIdentifier(store.vault).hashValue)") { await load() }
        // Another session (a sign-out and in, another account): this text was the last one's.
        .onChange(of: ObjectIdentifier(store.vault)) { _, _ in
            editor.drop()
            dismiss()
        }
        .onDisappear { editor.drop() }
        .confirmationDialog(stale?.currentVersionId == nil ? EditorWords.goneTitle : EditorWords.staleTitle,
                            isPresented: Binding(get: { stale != nil && !confirmTheirs }, set: { if !$0 { stale = nil } }),
                            titleVisibility: .visible, presenting: stale) { choice in
            if let current = choice.currentVersionId {
                Button(EditorWords.onTop) { stale = nil; Task { await save(onTopOf: current) } }
                Button(EditorWords.copy) { stale = nil; Task { await saveCopy() } }
                Button(EditorWords.theirs, role: .destructive) { confirmTheirs = true }
            } else {
                Button(EditorWords.copy) { stale = nil; Task { await saveCopy() } }
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
            Button(EditorWords.cancel, role: .cancel) {}
        } message: {
            Text(EditorWords.theirsText)
        }
        .confirmationDialog(EditorWords.discardTitle, isPresented: $confirmLeave, titleVisibility: .visible) {
            Button(EditorWords.discard, role: .destructive) { close() }
            Button(EditorWords.keepEditing, role: .cancel) {}
        } message: {
            Text(EditorWords.leaveText(shown.name))
        }
    }

    @ToolbarContentBuilder private var toolbar: some ToolbarContent {
        ToolbarItem(placement: .cancellationAction) {
            Button { if edited { confirmLeave = true } else { close() } } label: { HeaderWord(text: EditorWords.close) }
        }
        if phase == .editing {
            ToolbarItem(placement: .confirmationAction) {
                Button { Task { await save() } } label: {
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
                note(TextEditing.words(reason))
                if let text { PlainTextView(box: editor, text: text, editable: false, onChange: {}) } else { Spacer() }
            }
        case .editing:
            VStack(spacing: 0) {
                if let line = failure ?? (edited ? nil : status) {
                    note(line, failed: failure != nil)
                }
                PlainTextView(box: editor, text: editor.opening, editable: true) {
                    if !edited { edited = true }
                    status = nil
                }
            }
        }
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

    private func close() {
        editor.drop()
        edited = false
        dismiss()
    }

    /* The file as the server lists it now, read afresh: what a save writes is these bytes, edited. */
    private func load() async {
        let from = loadFrom ?? item
        do {
            let (_, listed) = try await store.vault.editTarget(from)
            let file = listed ?? from
            if let size = file.size, size > TextEditing.limit {
                phase = .readOnly(.tooLarge, nil)
                return
            }
            let url = try await store.fetch(file)
            let data = try Data(contentsOf: url)
            try Task.checkCancellation()
            target = file
            startedFrom = file.node.currentVersion?.id
            edited = false
            switch TextEditing.open(data) {
            case .editable(let text):
                editor.open(text)
                phase = .editing
            case .readOnly(let reason, let text):
                phase = .readOnly(reason, text)
            }
        } catch where !ErrorWords.isCancellation(error) {
            phase = .failed
        } catch {}
    }

    /* Save, and Save on top (`onTopOf`: the version current now). */
    private func save(onTopOf: String? = nil) async {
        guard phase == .editing, !saving, let file = target else { return }
        let text = editor.text
        saving = true
        failure = nil
        status = nil
        defer { saving = false }
        do {
            let (folder, listed) = try await store.vault.editTarget(file)
            guard let listed else {
                stale = StaleVersion(currentVersionId: nil)
                return
            }
            let saved = try await TextSave.version(text, of: listed, in: folder, startedFrom: onTopOf ?? startedFrom,
                                                   start: TextSave.runs(store.vault))
            switch saved {
            case .stale(let current):
                stale = StaleVersion(currentVersionId: current)
            case .saved(let landed):
                target = landed
                startedFrom = landed.node.currentVersion?.id
                // Typed while it saved: still changed.
                edited = editor.text != text
                status = EditorWords.saved
                if let parent = landed.node.parentId { await store.refresh(folder: parent) }
            }
        } catch {
            failure = ErrorWords.say(error) ?? EditorWords.saveFailed
        }
    }

    private func saveCopy() async {
        guard let file = target else { return }
        let text = editor.text
        saving = true
        failure = nil
        defer { saving = false }
        do {
            let (folder, _) = try await store.vault.editTarget(file)
            let sources = try await store.vault.copySources(of: file)
            let made = try await TextSave.copy(text, of: file, in: folder, sources: sources, start: TextSave.runs(store.vault))
            // From here on the editor writes the copy; the file someone else saved stays theirs.
            target = made
            startedFrom = made.node.currentVersion?.id
            edited = editor.text != text
            status = EditorWords.savedCopy(made.name)
            await store.refresh(folder: folder.id)
        } catch {
            failure = ErrorWords.say(error) ?? EditorWords.saveFailed
        }
    }

    private func openTheirs() async {
        guard let file = target else { return }
        editor.drop()
        edited = false
        status = nil
        failure = nil
        phase = .loading
        loadFrom = file
        attempt += 1
    }
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
    static let keepEditing = "Keep editing"
}

/*
 * The text view the editor holds: read only at save, never copied into SwiftUI state on every
 * keystroke (an 8 MiB file would be copied each time). `drop` empties it, so no text outlives the screen.
 */
@MainActor final class TextBox {
    weak var view: UITextView?
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
    }
}

/*
 * UITextView as a SwiftUI view: monospaced at the reader's text size, wrapped, no autocorrection,
 * capitals, smart punctuation, predictions or Writing Tools (each would change what the person
 * didn't type, or send their words to a model). A line break typed or pasted goes in as LF.
 */
struct PlainTextView: UIViewRepresentable {
    let box: TextBox
    let text: String
    let editable: Bool
    let onChange: () -> Void

    func makeCoordinator() -> Coordinator { Coordinator(onChange: onChange) }

    func makeUIView(context: Context) -> UITextView {
        let view = UITextView(usingTextLayoutManager: true)
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
        return view
    }

    func updateUIView(_ view: UITextView, context: Context) {
        context.coordinator.onChange = onChange
        view.isEditable = editable
        if box.view !== view { box.view = view }
    }

    final class Coordinator: NSObject, UITextViewDelegate {
        var onChange: () -> Void
        init(onChange: @escaping () -> Void) { self.onChange = onChange }

        func textViewDidChange(_ textView: UITextView) { onChange() }

        func textView(_ textView: UITextView, shouldChangeTextIn range: NSRange, replacementText text: String) -> Bool {
            guard text.contains("\r") else { return true }
            // Put in as LF, as CodeMirror does: the file never gains a carriage return from the phone.
            guard let start = textView.position(from: textView.beginningOfDocument, offset: range.location),
                  let end = textView.position(from: start, offset: range.length),
                  let replaced = textView.textRange(from: start, to: end) else { return false }
            textView.replace(replaced, withText: TextEditing.lineFeeds(text))
            return false
        }
    }
}
