import HushOSKit
import SwiftUI

/*
 * Contacts without comparing words (docs/optional-verification.md 6.2, 6.6, 6.7; the web's
 * add-someone.tsx, check-contact.tsx and account-changed.tsx, in their words): Add someone is an
 * email and Add; Check it's Maya is the optional door to the twelve words; "Maya's account changed"
 * is the one calm notice for keys that changed with no signed chain. Each is a step that takes the
 * place of whatever it was met in (pushed in that sheet's stack), never a sheet over a sheet.
 */
enum ContactStep: Hashable, Identifiable {
    case check(email: String, name: String)
    case changed(AccountChange)
    /* Add someone, from an Unverified mark: `writer` is the account that wrote the item, which the address must be. */
    case add(writer: String?)

    var id: String {
        switch self {
        case .check(let email, _): "check-\(email)"
        case .changed(let change): "changed-\(change.id)"
        case .add(let writer): "add-\(writer ?? "")"
        }
    }
}

/* One step and those it leads to, in place: Review's Check it's Maya replaces the notice; a mark's Add someone leads to the check. */
struct ContactStepView: View {
    @State var step: ContactStep
    /* Continue or They match went through: what waited on them may run now. */
    var resolved: () -> Void = {}
    /* In a sheet of its own rather than pushed in another's stack. */
    var presented = false
    /* Told each step this shows, so a sheet can grow for the words. */
    var shown: (ContactStep) -> Void = { _ in }
    let done: () -> Void

    var body: some View {
        Group { current }.onChange(of: step, initial: true) { _, now in shown(now) }
    }

    @ViewBuilder private var current: some View {
        switch step {
        case .check(let email, let name):
            CheckContactView(email: email, name: name, resolved: resolved, done: done)
        case .changed(let change):
            AccountChangedView(change: change, check: { step = .check(email: change.email, name: change.name) }, resolved: resolved, presented: presented, done: done)
        case .add(let writer):
            // Added, and done: no words. Only from a mark (Check who wrote this) do the words come next, if they like, as on the web.
            AddSomeoneView(writer: writer, added: { pin in if writer != nil { step = .check(email: pin.email, name: pin.name) } else { done() } },
                           changed: { step = .changed($0) }, cancel: done)
        }
    }
}

/* Add someone (6.2): their email, Add, and they are a contact at once. No words, no second step. */
struct AddSomeoneView: View {
    @Environment(DriveStore.self) private var store
    var writer: String? = nil
    let added: (ContactPin) -> Void
    let changed: (AccountChange) -> Void
    let cancel: () -> Void
    @State private var email = ""
    @State private var adding = false
    @State private var hint: (text: String, error: Bool)?
    @FocusState private var focused: Bool

    var body: some View {
        List {
            if writer != nil {
                Text("Enter the email they use for HushOS. Once they’re in your contacts, what they add and change shows as theirs.")
                    .font(Theme.Text.callout).foregroundStyle(Alpine.inkMuted).listRowBackground(Color.clear)
                    .listRowInsets(EdgeInsets(top: 0, leading: Alpine.Space.s1, bottom: 0, trailing: Alpine.Space.s1))
            }
            Section {
                LabeledContent("Email") {
                    TextField("them@example.com", text: $email)
                        .keyboardType(.emailAddress).textContentType(.emailAddress).textInputAutocapitalization(.never).autocorrectionDisabled()
                        .multilineTextAlignment(.trailing).focused($focused)
                        .onSubmit(add)
                        .onChange(of: email) { _, _ in hint = nil }
                }
                .alpineRow()
            } footer: {
                Text(hint?.text ?? "The email they use for HushOS.").foregroundStyle(hint?.error == true ? Alpine.danger : Alpine.inkMuted)
            }
        }
        .listStyle(.insetGrouped)
        .alpineGrouped()
        .navigationTitle(writer == nil ? "Add someone" : "Check who wrote this")
        .navigationBarTitleDisplayMode(.inline)
        .navigationBarBackButtonHidden()
        .toolbar {
            ToolbarItem(placement: .cancellationAction) { Button("Cancel", action: cancel) }
            ToolbarItem(placement: .confirmationAction) {
                Button(adding ? "Adding…" : "Add", action: add).fontWeight(.semibold)
                    .disabled(adding || email.trimmingCharacters(in: .whitespaces).isEmpty)
            }
        }
        .onAppear { focused = true }
    }

    private func add() {
        let address = email.trimmingCharacters(in: .whitespaces)
        guard !address.isEmpty, !adding else { return }
        adding = true
        hint = nil
        Task {
            do {
                switch try await store.vault.addContact(email: address, writer: writer) {
                case .added(let pin):
                    store.notify("\(pin.firstName) added")
                    // What they wrote now reads as theirs, and what they shared opens.
                    Task { await store.refreshSigners(); await store.refreshMounts() }
                    added(pin)
                case .already(let pin):
                    hint = ("\(pin.firstName) is already in your contacts.", false)
                case .changed(let change):
                    changed(change)
                }
            } catch {
                if let words = ErrorWords.say(error, otherwise: "Check the address and try again.") { hint = (words, true) }
            }
            adding = false
        }
    }
}

/*
 * Check it's Maya (6.6), the advanced door: the twelve words over the keys HushOS serves for them
 * now. They match makes the pin verified; They don't match saves nothing and offers Remove Maya
 * from contacts, which asks once in the check's place.
 */
struct CheckContactView: View {
    @Environment(DriveStore.self) private var store
    let email: String
    let name: String
    var resolved: () -> Void = {}
    let done: () -> Void
    @State private var found: Lookup?
    @State private var failure: String?
    @State private var stage = Stage.words
    @State private var removing = false
    @State private var saving = false
    @State private var error = ""

    enum Stage { case words, mismatch }

    private var first: String { firstName(found.map { $0.contact.name.isEmpty ? $0.contact.email : $0.contact.name } ?? name) }

    /* They don't match (6.6), awaiting the owner's approval, as on the web. */
    private var mismatchWords: String {
        "These don’t match. Check \(first)’s email address with them. If it’s right and they still don’t match, remove \(first) for now and add them again once they do. To stop sharing something with \(first), open Share on it."
    }

    var body: some View {
        List {
            Group {
                Section {
                    Text(stage == .mismatch ? mismatchWords
                        : "Ask \(first) to open Contacts in HushOS and choose Your twelve words. If theirs match these, it’s really them. Do it in person or on a call.")
                        .font(Theme.Text.callout).foregroundStyle(stage == .mismatch ? Alpine.ink : Alpine.inkMuted).alpineRow()
                    if let failure {
                        Text(failure).font(Theme.Text.callout).foregroundStyle(Alpine.danger).alpineRow()
                        Button("Try again") { Task { await look() } }.alpineRow()
                    } else if found == nil {
                        HStack(spacing: Alpine.Space.s2) { ProgressView(); Text("Getting their words").foregroundStyle(Alpine.inkMuted) }.alpineRow()
                    } else if let found, !found.upgraded {
                        Text("\(first) needs to sign in to HushOS once more before you can share with them.").font(Theme.Text.callout).foregroundStyle(Alpine.inkMuted).alpineRow()
                    }
                    if let found, let fingerprint = found.contact.fingerprint, stage == .words {
                        if let replaced = parseDate(found.pinned?.keysReplacedAt) {
                            Text("\(first) updated their account on \(replaced.formatted(.dateTime.day().month(.wide).locale(.dayMonth))).")
                                .font(Theme.Text.footnote).foregroundStyle(Alpine.inkMuted).alpineRow()
                        }
                        FingerprintWordsView(fingerprint: fingerprint).padding(.vertical, Alpine.Space.s2).alpineRow()
                        TechnicalDetails {
                            Text("These words are worked out from \(first)’s four public keys. Comparing them confirms the keys HushOS gave your device are theirs.")
                            Text(fingerprint).font(.footnote.monospaced()).textSelection(.enabled)
                        }
                        .alpineRow()
                    }
                }
                if !error.isEmpty { Text(error).font(Theme.Text.footnote).foregroundStyle(Alpine.danger).alpineRow() }
                if let found, found.contact.fingerprint != nil {
                    Section {
                        VStack(spacing: Alpine.Space.s2) {
                            if stage == .mismatch {
                                // As the changed-account notice lays them out on a phone: full width and stacked, Done on top.
                                Button(action: done) { Text("Done").frame(maxWidth: .infinity) }.buttonStyle(PrimaryCapsuleStyle())
                                if found.pinned != nil {
                                    Button { removing = true } label: { Text("Remove \(first) from contacts").frame(maxWidth: .infinity) }
                                        .buttonStyle(SecondaryCapsuleStyle()).disabled(saving)
                                }
                            } else {
                                Button { match(found) } label: { Text(saving ? "Saving…" : "They match").frame(maxWidth: .infinity) }
                                    .buttonStyle(PrimaryCapsuleStyle()).disabled(saving)
                                Button { stage = .mismatch } label: { Text("They don’t match").frame(maxWidth: .infinity) }
                                    .buttonStyle(SecondaryCapsuleStyle()).disabled(saving)
                            }
                        }
                    }
                    .listRowBackground(Color.clear).listRowInsets(EdgeInsets())
                }
            }
        }
        .listStyle(.insetGrouped)
        .alpineGrouped()
        .navigationTitle("Check it’s \(first)")
        .navigationBarTitleDisplayMode(.inline)
        // On a mismatch Done is the screen's own blue button.
        .toolbar { if stage == .words { ToolbarItem(placement: .confirmationAction) { Button("Done", action: done) } } }
        // Asked once, as Contacts asks (6.5); Cancel comes back to the check.
        .alert("Remove \(first)?", isPresented: $removing) {
            Button("Cancel", role: .cancel) {}
            Button("Remove", role: .destructive) { remove() }
        } message: {
            Text("\(first) keeps access to anything you’ve already shared.")
        }
        .task { await look() }
    }

    private func look() async {
        failure = nil
        do { found = try await store.vault.lookup(email: email) } catch {
            if let words = ErrorWords.say(error) { failure = words }
        }
    }

    private func match(_ lookup: Lookup) {
        saving = true
        error = ""
        Task {
            do {
                _ = try await store.vault.theyMatch(lookup)
                store.notify("\(first) verified")
                Task { await store.refreshSigners(); await store.refreshMounts() }
                resolved()
                done()
            } catch {
                self.error = ErrorWords.say(error, otherwise: "That wasn’t saved. Try again.") ?? ""
                if case ContactError.moved = error { await look() }
            }
            saving = false
        }
    }

    private func remove() {
        guard let found else { return }
        saving = true
        error = ""
        Task {
            do {
                try await store.vault.remove(found.contact.userId)
                store.notify("\(first) removed")
                Task { await store.refreshSigners() }
                done()
            } catch {
                self.error = ErrorWords.say(error, otherwise: "That wasn’t saved. Try again.") ?? ""
            }
            saving = false
        }
    }
}

/*
 * "Maya's account changed" (6.7): until Continue or a check, nothing new is shared with them,
 * nothing is sealed to them again and nothing they shared opens. Continue takes the keys HushOS
 * serves now, and what was shared with them is sealed again, to those keys only. For someone this
 * phone had checked, the check leads.
 */
struct AccountChangedView: View {
    @Environment(DriveStore.self) private var store
    let change: AccountChange
    let check: () -> Void
    var resolved: () -> Void = {}
    var presented = false
    let done: () -> Void
    @State private var found: Lookup?
    @State private var failure: String?
    @State private var busy = false
    @State private var error = ""

    private var name: String { change.firstName }

    var body: some View {
        List {
            Section {
                Text("This happens when someone starts their HushOS account over, for example after losing their phone.")
                    .font(Theme.Text.callout).foregroundStyle(Alpine.inkMuted).alpineRow()
                if let failure {
                    Text(failure).font(Theme.Text.callout).foregroundStyle(Alpine.danger).alpineRow()
                    Button("Try again") { Task { await look() } }.alpineRow()
                } else if found == nil {
                    HStack(spacing: Alpine.Space.s2) { ProgressView(); Text("Checking").foregroundStyle(Alpine.inkMuted) }.alpineRow()
                } else if let found, !found.changed {
                    Text("Nothing needs doing: you can share with \(name) as before.").font(Theme.Text.callout).foregroundStyle(Alpine.ink).alpineRow()
                } else if let found {
                    Text(found.wasVerified ? "You’d checked it was \(name) before. You may want to check again." : "You can keep sharing with \(name) as before.")
                        .font(Theme.Text.callout).foregroundStyle(Alpine.ink).alpineRow()
                    TechnicalDetails {
                        Text("\(name)’s keys are different from the ones your device remembered, and their previous keys didn’t sign the change.")
                        VStack(alignment: .leading, spacing: 2) {
                            Text("Remembered").foregroundStyle(Alpine.inkMuted)
                            Text(found.heldFingerprint ?? "None").font(.footnote.monospaced()).textSelection(.enabled)
                        }
                        VStack(alignment: .leading, spacing: 2) {
                            Text("Now").foregroundStyle(Alpine.inkMuted)
                            Text(found.contact.fingerprint ?? "None").font(.footnote.monospaced()).textSelection(.enabled)
                        }
                    }
                    .alpineRow()
                }
            }
            if !error.isEmpty { Text(error).font(Theme.Text.footnote).foregroundStyle(Alpine.danger).alpineRow() }
            if let found {
                Section {
                    VStack(spacing: Alpine.Space.s2) {
                        if !found.changed {
                            Button(action: done) { Text("Done").frame(maxWidth: .infinity) }.buttonStyle(PrimaryCapsuleStyle())
                        } else if found.wasVerified {
                            checkButton(found, primary: true)
                            continueButton(found, primary: false)
                        } else {
                            continueButton(found, primary: true)
                            checkButton(found, primary: false)
                        }
                    }
                }
                .listRowBackground(Color.clear).listRowInsets(EdgeInsets())
            }
        }
        .listStyle(.insetGrouped)
        .alpineGrouped()
        .navigationTitle("\(name)’s account changed")
        .navigationBarTitleDisplayMode(.inline)
        // In a sheet of its own (Shared, a mark), Done at the trailing edge as the app's other sheets have it, the
        // title centred between; pushed, Back is the way out.
        .toolbar { if presented { ToolbarItem(placement: .confirmationAction) { Button("Done", action: done) } } }
        .task { await look() }
    }

    @ViewBuilder private func continueButton(_ found: Lookup, primary: Bool) -> some View {
        let label = Text(busy ? "Continuing…" : "Continue").frame(maxWidth: .infinity)
        if primary {
            Button { proceed() } label: { label }.buttonStyle(PrimaryCapsuleStyle()).disabled(busy)
        } else {
            Button { proceed() } label: { label }.buttonStyle(SecondaryCapsuleStyle()).disabled(busy)
        }
    }

    @ViewBuilder private func checkButton(_ found: Lookup, primary: Bool) -> some View {
        let label = Text("Check it’s \(name)").frame(maxWidth: .infinity)
        if primary {
            Button(action: check) { label }.buttonStyle(PrimaryCapsuleStyle()).disabled(busy || !found.upgraded)
        } else {
            Button(action: check) { label }.buttonStyle(SecondaryCapsuleStyle()).disabled(busy || !found.upgraded)
        }
    }

    private func look() async {
        failure = nil
        do { found = try await store.vault.lookup(email: change.email) } catch {
            if let words = ErrorWords.say(error) { failure = words }
        }
    }

    private func proceed() {
        busy = true
        error = ""
        Task {
            do {
                _ = try await store.vault.continueWith(change)
                // What was shared with them is sealed again, to these keys.
                Task { _ = try? await store.vault.upgradeShares(); await store.refreshSigners(); await store.refreshMounts() }
                store.notify("You’re sharing with \(name) again")
                resolved()
                done()
            } catch {
                self.error = ErrorWords.say(error, otherwise: "That wasn’t saved. Try again.") ?? ""
                if case ContactError.moved = error { await look() }
            }
            busy = false
        }
    }
}

/* A closed disclosure, "Technical details", for the words a person looks for (6.1). */
struct TechnicalDetails<Content: View>: View {
    @ViewBuilder let content: () -> Content
    @State private var open = false
    @Environment(\.growSheet) private var growSheet

    var body: some View {
        DisclosureGroup(isExpanded: $open.onSet { if $0 { growSheet() } }) {
            VStack(alignment: .leading, spacing: Alpine.Space.s2) { content() }
                .font(Theme.Text.footnote).foregroundStyle(Alpine.inkMuted)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.top, Alpine.Space.s1)
        } label: {
            Text("Technical details").font(Theme.Text.footnote.weight(.semibold)).foregroundStyle(Alpine.ink)
        }
        .tint(Alpine.inkMuted)
    }
}

/* "Verified" with a small check, or "Not verified": muted 13pt text, never a badge (6.1). */
struct VerifiedLabel: View {
    let verified: Bool

    var body: some View {
        HStack(spacing: 3) {
            if verified { Image(systemName: "checkmark").font(.caption2.weight(.bold)) }
            Text(verified ? "Verified" : "Not verified")
        }
        .font(Theme.Text.footnote).foregroundStyle(Alpine.inkMuted)
    }
}

extension View {
    /* A contact step pushed in this stack, taking the place of what it was met in. */
    func contactSteps(_ step: Binding<ContactStep?>, resolved: @escaping () -> Void = {}) -> some View {
        navigationDestination(item: step) { shown in
            ContactStepView(step: shown, resolved: resolved) { step.wrappedValue = nil }
        }
    }

    /* A contact step in a sheet of its own, from a screen that isn't a sheet (Shared, a mark, Info). */
    func contactSheet(_ step: Binding<ContactStep?>, store: DriveStore, resolved: @escaping () -> Void = {}) -> some View {
        sheet(item: step) { shown in
            ContactSheet(step: shown, resolved: resolved) { step.wrappedValue = nil }
                .environment(store)
        }
    }
}

/*
 * A contact step in a sheet of its own, as tall as it needs: the changed-account notice and Add
 * someone are short and open part way up; the twelve words, Technical details opened, and the
 * largest text sizes take the whole height.
 */
private struct ContactSheet: View {
    let step: ContactStep
    let resolved: () -> Void
    let done: () -> Void
    @State private var detent = PresentationDetent.large
    @Environment(\.dynamicTypeSize) private var typeSize

    private static let short = PresentationDetent.fraction(0.66)

    var body: some View {
        NavigationStack {
            ContactStepView(step: step, resolved: resolved, presented: true, shown: { now in
                if case .check = now { detent = .large }
            }, done: done)
        }
        .environment(\.growSheet, { detent = .large })
        .presentationDetents([Self.short, .large], selection: $detent)
        .onAppear {
            if case .check = step { return }
            if !typeSize.isAccessibilitySize { detent = Self.short }
        }
    }
}

private struct GrowSheetKey: EnvironmentKey {
    static let defaultValue: @MainActor () -> Void = {}
}

extension EnvironmentValues {
    /* A sheet that opened part way up grows to its full height (Technical details opened). */
    var growSheet: @MainActor () -> Void {
        get { self[GrowSheetKey.self] }
        set { self[GrowSheetKey.self] = newValue }
    }
}

extension Binding where Value == Bool {
    /* The same binding, telling `then` each value set. */
    func onSet(_ then: @escaping (Bool) -> Void) -> Binding<Bool> {
        Binding(get: { wrappedValue }, set: { wrappedValue = $0; then($0) })
    }
}
