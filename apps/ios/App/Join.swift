import HushOSKit
import SwiftUI

/*
 * Joining a family on the phone (docs/groups-mobile-plan.md, iOS 3), the web's two pages in the
 * same words: the mailed invitation (/join#invite=<token>, routes/join/route.tsx), opened and
 * accepted here, then the join screen (families/$groupId/join.tsx): read your twelve words to the
 * person letting you in, wait, then compare the join code their screen shows, with two words
 * hidden at positions this phone drew, and type those two as they read them. Every rule is the
 * core's (FamilySync's join steps); this file draws the steps and keeps the person's place.
 */

/* The mailed invitation's token, as a sheet's item; nil is a link whose token was cut off. */
struct InvitationLink: Identifiable, Equatable {
    let token: String?
    let id = UUID()
}

/*
 * The invitation, signed in: who invited you to which family, Accept, and after it the join
 * screen in the same sheet; once in, the family's page. Someone already in a family (one per
 * account) is told to leave theirs first and can't accept; the invitation stays open.
 */
struct InvitationSheet: View {
    @Environment(AppModel.self) private var model
    @Environment(DriveStore.self) private var store
    @Environment(\.dismiss) private var dismiss
    let link: InvitationLink

    private enum Step: Equatable {
        case opening
        /* The link's token was cut off: nothing to open. */
        case incomplete
        case failed(gone: Bool, words: String)
        case invitation(Invitation)
        case joining(String, family: String)
        case joined(String)
    }

    @State private var step: Step = .opening
    @State private var accepting = false
    @State private var error: GroupsAPIError?
    @State private var problem: String?

    var body: some View {
        NavigationStack {
            Group {
                switch step {
                case .joining(let groupId, let family):
                    List {
                        Section {} header: { title("Join \(family)") }
                        JoinSections(groupId: groupId, family: family) { step = .joined(groupId) }
                    }
                    .listStyle(.insetGrouped)
                    .alpineGrouped()
                case .joined(let groupId):
                    FamilyPage(groupId: groupId)
                default:
                    List { invitation }
                        .listStyle(.insetGrouped)
                        .alpineGrouped()
                }
            }
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } } }
            // A family's folders and their subfolders, pushed by value as Account's stack pushes them.
            .navigationDestination(for: FamilyRoute.self) { route in
                switch route {
                case .family(let id): FamilyPage(groupId: id).environment(store)
                case .folder(let id, let name): FolderView(folderId: id, title: name).environment(store)
                }
            }
            .navigationDestination(for: Opened.self) { folder in FolderView(folderId: folder.id, title: folder.name).environment(store) }
        }
        .task { if step == .opening { await open() } }
    }

    private func title(_ text: String) -> some View {
        Text(text).font(Theme.Text.titleLarge).kerning(-1).foregroundStyle(Alpine.ink).accessibilityAddTraits(.isHeader).textCase(nil)
            .listRowInsets(EdgeInsets(top: Alpine.Space.s2, leading: Alpine.Space.s1, bottom: 0, trailing: 0))
    }

    @ViewBuilder private var invitation: some View {
        switch step {
        case .opening:
            Section {} header: { title("Opening your invitation") }
            Section { ProgressView().frame(maxWidth: .infinity).padding(.vertical, Alpine.Space.s4).bareRow() }
        case .incomplete:
            Section {} header: { title("This invitation link is incomplete") }
            Section {
                Text("Open the link from the invitation email again. If it still doesn’t work, ask for a new invitation.")
                    .font(Theme.Text.callout).foregroundStyle(Alpine.ink).alpineRow()
            }
        case .failed(let gone, let words):
            Section {} header: { title(gone ? "This invitation is no longer open" : "This invitation didn’t open") }
            Section {
                Text(gone ? "It was used, cancelled, or it ran out. Ask the person who invited you for a new one." : words)
                    .font(Theme.Text.callout).foregroundStyle(Alpine.ink).alpineRow()
                if !gone {
                    Button("Try again") { Task { await open() } }.foregroundStyle(Alpine.primary).alpineRow()
                }
            } footer: { signedInAs }
        case .invitation(let invitation):
            loaded(invitation)
        default:
            EmptyView()
        }
    }

    @ViewBuilder private func loaded(_ invitation: Invitation) -> some View {
        let inviter = invitation.inviter
        // Theirs as opening the invitation found it, or as accepting did (they joined one meanwhile).
        let yours = invitation.inFamily ?? (error?.code == "in-family" ? error?.family : nil)
        Section {} header: {
            VStack(alignment: .leading, spacing: Alpine.Space.s1) {
                title(inviter.map { "\($0.name) invited you to \(invitation.name)" } ?? "You’re invited to \(invitation.name)")
                if let email = inviter?.email, !email.isEmpty {
                    Text("From \(email)").font(Theme.Text.callout).foregroundStyle(Alpine.inkMuted).textCase(nil)
                }
            }
        }
        Section {
            if yours == nil {
                let them = inviter.map { firstName($0.name) } ?? "they"
                Text("After you accept, you and \(them) check it’s really each other, on a call or in person. Then you’re let in.")
                    .font(Theme.Text.callout).foregroundStyle(Alpine.ink).alpineRow()
            }
            if let yours {
                VStack(alignment: .leading, spacing: Alpine.Space.s2) {
                    Text(JoinWords.inFamily(yours.name, invitedTo: invitation.name, expiresAt: invitation.expiresAt))
                        .font(Theme.Text.callout).foregroundStyle(Alpine.ink)
                    NavigationLink(value: FamilyRoute.family(yours.groupId)) {
                        Text("Open \(yours.name)").font(Theme.Text.callout.weight(.semibold)).foregroundStyle(Alpine.primary)
                    }
                }
                .padding(.vertical, Alpine.Space.s1)
                .listRowBackground(Alpine.tint)
            } else if let error, error.code == "already-member" {
                VStack(alignment: .leading, spacing: Alpine.Space.s2) {
                    Text("You’re already in this family").font(Theme.Text.headline).foregroundStyle(Alpine.ink)
                    NavigationLink(value: FamilyRoute.family(invitation.groupId)) {
                        Text("Open \(invitation.name)").font(Theme.Text.callout.weight(.semibold)).foregroundStyle(Alpine.primary)
                    }
                }
                .padding(.vertical, Alpine.Space.s1)
                .listRowBackground(Alpine.tint)
            } else if let words = problem {
                Text(words).font(Theme.Text.callout).foregroundStyle(Alpine.danger).listRowBackground(Alpine.dangerSoft)
            }
        } footer: { signedInAs }
        Section {
            Button { Task { await accept(invitation) } } label: { Text(accepting ? "Accepting" : "Accept").frame(maxWidth: .infinity) }
                .buttonStyle(PrimaryCapsuleStyle())
                .disabled(accepting || error?.code == "email-mismatch" || yours != nil)
        }
        .listRowBackground(Color.clear).listRowInsets(EdgeInsets())
    }

    private var signedInAs: some View {
        VStack(alignment: .leading, spacing: Alpine.Space.s1) {
            Text("Signed in as \(model.user?.email ?? "you").")
            Button("Use another account") { Task { await switchAccount() } }
                .font(Theme.Text.footnote.weight(.semibold)).foregroundStyle(Alpine.primary).buttonStyle(.borderless)
        }
        .font(Theme.Text.footnote).foregroundStyle(Alpine.inkMuted)
        .padding(.top, Alpine.Space.s1)
    }

    private func open() async {
        guard let token = link.token else {
            step = .incomplete
            return
        }
        step = .opening
        do {
            step = .invitation(try await store.families.openInvitation(token))
        } catch let error as GroupsAPIError where error.code == "gone" {
            step = .failed(gone: true, words: "")
        } catch {
            if endsSession(error) { store.report(error); dismiss(); return }
            step = .failed(gone: false, words: JoinWords.refusal(error))
        }
    }

    private func accept(_ invitation: Invitation) async {
        guard let token = link.token else { return }
        accepting = true
        defer { accepting = false }
        error = nil
        problem = nil
        do {
            let groupId = try await store.families.acceptInvitation(token)
            await store.refreshFamilies(force: true)
            step = .joining(groupId, family: invitation.name)
        } catch let refused as GroupsAPIError {
            error = refused
            if refused.code == "email-mismatch" {
                problem = "This invitation is for another email address than \(model.user?.email ?? "this one"). Sign in with that one."
            } else if refused.code != "in-family" && refused.code != "already-member" {
                problem = JoinWords.refusal(refused, family: invitation.name)
            }
        } catch {
            if endsSession(error) { store.report(error); dismiss(); return }
            problem = JoinWords.refusal(error, family: invitation.name)
        }
    }

    /* Signs out and keeps the link, so it opens again once signed in with the invited address. */
    private func switchAccount() async {
        let token = link.token
        dismiss()
        await model.signOut()
        if let token, let url = URL(string: "\(model.origin)/join#invite=\(token)") { model.pendingLink = url }
    }
}

/*
 * The join screen's steps, as sections of the list it sits in (the family page, or the
 * invitation sheet after Accept): waiting (your twelve words, then the wait), the code to compare
 * with two words to type, the alarm, or the hard warning. It owns the family while it is open: the
 * family's background check waits until it closes.
 */
struct JoinSections: View {
    @Environment(DriveStore.self) private var store
    let groupId: String
    let family: String
    var onJoined: (() -> Void)? = nil

    private enum Step: Equatable {
        case loading
        /* `n` tells one entry into waiting from the next, so polling starts again each time. */
        case waiting(Int)
        case compare(JoinShowing, changed: Bool, wrong: Bool)
        case mismatch
        case fork(FamilyFork)
    }

    @State private var step: Step = .loading
    @State private var typed = ["", ""]
    @State private var busy = false
    @State private var error: String?
    @State private var managers: [GroupDetail.Member] = []
    @State private var ownWords: String?
    @State private var ownWordsError: String?
    @FocusState private var focused: Int?

    private var only: GroupDetail.Member? { managers.count == 1 ? managers[0] : nil }
    private var them: String { only.map { firstName($0.name) } ?? "the person letting you in" }
    /* Names are the server's word: the first time one is shown, its address goes beside it. */
    private var themFull: String {
        guard let only else { return "the person letting you in" }
        return only.email.map { $0.isEmpty ? only.name : "\(only.name) (\($0))" } ?? only.name
    }

    var body: some View {
        Group {
            Section {} header: {
                Text("Do this with \(themFull) on a call or in person. It takes a minute.")
                    .font(Theme.Text.callout).foregroundStyle(Alpine.inkMuted).textCase(nil)
            }
            if let error {
                Section {
                    Text(error).font(Theme.Text.callout).foregroundStyle(Alpine.ink).listRowBackground(Alpine.warningSoft)
                    if step == .loading {
                        Button { Task { await resume() } } label: { Label("Try again", systemImage: "arrow.counterclockwise") }
                            .foregroundStyle(Alpine.primary).alpineRow()
                    }
                }
            }
            switch step {
            case .loading:
                if error == nil {
                    Section {
                        HStack(spacing: Alpine.Space.s2) {
                            ProgressView()
                            Text("Opening").foregroundStyle(Alpine.inkMuted)
                        }
                        .alpineRow()
                    }
                }
            case .waiting:
                waiting
            case .compare(let shown, let changed, let wrong):
                compare(shown, changed: changed, wrong: wrong)
            case .mismatch:
                mismatch
            case .fork(let fork):
                FamilyForkSection(name: family, fork: fork)
            }
        }
        .task {
            store.familyJoining.insert(groupId)
            await resume()
        }
        .onDisappear { store.familyJoining.remove(groupId) }
        // Route 3 answers someone who accepted: who manages the family, read again every few seconds.
        .task(id: groupId) {
            while !Task.isCancelled {
                if let detail = try? await store.families.members(groupId) {
                    managers = detail.members.filter { $0.state == "active" && $0.roles.contains("members") }
                }
                try? await Task.sleep(for: .seconds(5))
            }
        }
        // Waiting: route 2 polled through the join status until the person is let in.
        .task(id: waitingEntry) {
            guard waitingEntry != 0 else { return }
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(3))
                if Task.isCancelled { return }
                do {
                    let outcome = try await store.families.joinStatus(groupId)
                    if outcome != .waiting { show(outcome); return }
                    error = nil
                } catch {
                    if endsSession(error) { store.report(error); return }
                    self.error = FamilyWords.error(error)
                }
            }
        }
    }

    private var waitingEntry: Int {
        if case .waiting(let n) = step { return n }
        return 0
    }

    // MARK: Steps

    @ViewBuilder private var waiting: some View {
        Section {
            if let ownWords {
                FingerprintWordsView(fingerprint: ownWords).padding(.vertical, Alpine.Space.s2).alpineRow()
            } else if let ownWordsError {
                Text(ownWordsError).foregroundStyle(Alpine.danger).alpineRow()
            } else {
                ProgressView().accessibilityLabel("Opening your words").alpineRow()
            }
        } header: {
            VStack(alignment: .leading, spacing: 2) {
                Text("Read your twelve words to \(them)").font(Theme.Text.headline).foregroundStyle(Alpine.ink).accessibilityAddTraits(.isHeader)
                Text("They check them against what their screen shows for you.").font(Theme.Text.callout).foregroundStyle(Alpine.inkMuted)
            }
            .textCase(nil)
        } footer: {
            guidance
        }
        .task {
            guard ownWords == nil else { return }
            do { ownWords = try await store.vault.currentOwnFingerprint() } catch {
                if endsSession(error) { store.report(error); return }
                ownWordsError = FamilyWords.error(error)
            }
        }
        Section {
            VStack(alignment: .leading, spacing: Alpine.Space.s2) {
                HStack(spacing: Alpine.Space.s2) {
                    ProgressView()
                    Text("Waiting for \(them) to let you in").font(Theme.Text.headline).foregroundStyle(Alpine.ink)
                }
                Text("Keep this page open. When \(them)’s screen shows a join code, they’ll read it to you. Check the words match and type the two that are hidden.")
                    .font(Theme.Text.callout).foregroundStyle(Alpine.inkMuted)
            }
            .padding(.vertical, Alpine.Space.s1)
            .alpineRow()
        }
    }

    @ViewBuilder private func compare(_ shown: JoinShowing, changed: Bool, wrong: Bool) -> some View {
        if changed {
            Section {
                Text("\(family)’s member list changed since the code you compared. Compare this one with \(them).")
                    .font(Theme.Text.callout).foregroundStyle(Alpine.ink).listRowBackground(Alpine.warningSoft)
            }
        }
        Section {
            HiddenCode(shown: shown, typed: $typed, wrong: wrong, focused: $focused) {
                if case .compare(let current, let changed, true) = step { step = .compare(current, changed: changed, wrong: false) }
            }
            .padding(.vertical, Alpine.Space.s2)
            .alpineRow()
            if wrong {
                // The calm retry: a typo is likely, so a line by the fields, never the alarm.
                Text(JoinWords.checkMessage(again: false, them: them)).font(Theme.Text.callout).foregroundStyle(Alpine.danger).alpineRow()
            }
        } header: {
            VStack(alignment: .leading, spacing: 2) {
                Text("Compare the join code").font(Theme.Text.headline).foregroundStyle(Alpine.ink).accessibilityAddTraits(.isHeader)
                Text("\(them.prefix(1).uppercased() + them.dropFirst())’s screen shows the join code now. Ask them to read it to you, check the words match, and type the two that are hidden.")
                    .font(Theme.Text.callout).foregroundStyle(Alpine.inkMuted)
            }
            .textCase(nil)
        } footer: {
            guidance
        }
        Section {
            VStack(spacing: Alpine.Space.s2) {
                Button { Task { await match(shown) } } label: { Label(busy ? "Joining" : "They match", systemImage: "checkmark.shield").frame(maxWidth: .infinity) }
                    .buttonStyle(PrimaryCapsuleStyle())
                    .disabled(busy || typed.contains { $0.trimmingCharacters(in: .whitespaces).isEmpty })
                Button { step = .mismatch } label: { Text("They don’t match").frame(maxWidth: .infinity) }
                    .buttonStyle(SecondaryCapsuleStyle())
                    .disabled(busy)
            }
        }
        .listRowBackground(Color.clear).listRowInsets(EdgeInsets())
    }

    @ViewBuilder private var mismatch: some View {
        Section {
            VStack(alignment: .leading, spacing: Alpine.Space.s2) {
                Label("Don’t use \(family) yet", systemImage: "exclamationmark.triangle.fill")
                    .font(Theme.Text.headline).foregroundStyle(Alpine.danger).accessibilityAddTraits(.isHeader)
                Text(JoinWords.checkMessage(again: true, them: them)).font(Theme.Text.callout).foregroundStyle(Alpine.ink)
                Text("First check that \(them) is reading your join code, not someone else’s, and that you typed the two hidden words as they read them. Then compare again: nothing was saved on this device.")
                    .font(Theme.Text.callout).foregroundStyle(Alpine.ink)
                Button("Compare again") {
                    step = .loading
                    Task { await resume() }
                }
                .font(Theme.Text.callout.weight(.semibold)).foregroundStyle(Alpine.primary).buttonStyle(.borderless)
            }
            .padding(.vertical, Alpine.Space.s1)
            .listRowBackground(Alpine.dangerSoft)
        }
    }

    private var guidance: some View {
        Text("Compare these in person or on a call through another app, never in a message sent through HushOS.")
            .font(Theme.Text.footnote).foregroundStyle(Alpine.inkMuted)
    }

    // MARK: Actions

    /* Each answer from the join steps, as a step. */
    private func show(_ outcome: JoinOutcome) {
        error = nil
        switch outcome {
        case .joined(let state):
            store.notify("You’re in \(family)")
            Task {
                await store.joined(groupId, state)
                onJoined?()
            }
        case .member:
            // This phone already holds the family: nothing to join.
            store.familyJoining.remove(groupId)
            Task {
                await store.refreshFamilies(force: true)
                onJoined?()
            }
        case .waiting:
            if case .waiting = step { return }
            step = .waiting(Int(Date().timeIntervalSince1970 * 1000))
        case .compare(let shown, let changed):
            typed = ["", ""]
            step = .compare(shown, changed: changed, wrong: false)
            focused = 0
        case .wrongWords:
            // Most likely misheard: the same showing stays, both words to be read again.
            if case .compare(let shown, let changed, _) = step { step = .compare(shown, changed: changed, wrong: true) }
        case .mismatch:
            // Wrong again: the alarm, not a typo.
            step = .mismatch
        case .fork(let fork):
            step = .fork(fork)
        }
    }

    private func resume() async {
        error = nil
        do {
            show(try await store.families.joinStatus(groupId))
        } catch {
            if endsSession(error) { store.report(error); return }
            // The retry belongs to the loading step, whatever step this came from.
            step = .loading
            self.error = FamilyWords.error(error)
        }
    }

    private func match(_ shown: JoinShowing) async {
        busy = true
        defer { busy = false }
        error = nil
        do {
            show(try await store.families.confirmJoin(groupId, shown, typed: typed))
        } catch {
            if endsSession(error) { store.report(error); return }
            self.error = FamilyWords.error(error)
        }
    }
}

/*
 * The join code with two words hidden: a field for each, typed as the person letting you in reads
 * them. The hidden words are not on screen at all. The fields read nothing back to the keyboard:
 * no autocorrection, predictions or Writing Tools (as the recovery phrase's entry).
 */
private struct HiddenCode: View {
    let shown: JoinShowing
    @Binding var typed: [String]
    let wrong: Bool
    var focused: FocusState<Int?>.Binding
    let onType: () -> Void
    @Environment(\.dynamicTypeSize) private var typeSize

    var body: some View {
        LazyVGrid(columns: Array(repeating: GridItem(.flexible()), count: typeSize.isAccessibilitySize ? 1 : 2), alignment: .leading, spacing: Alpine.Space.s2) {
            ForEach(shown.code.indices, id: \.self) { at in
                let slot = shown.hidden.firstIndex(of: at)
                HStack(spacing: 6) {
                    Text("\(at + 1)").font(.caption.monospacedDigit()).foregroundStyle(Alpine.inkMuted).frame(width: 18, alignment: .trailing)
                        .accessibilityHidden(true)
                    if let slot {
                        TextField("Word \(at + 1)", text: Binding(get: { typed[slot] }, set: { typed[slot] = $0; onType() }))
                            .font(.body.weight(.medium))
                            .textInputAutocapitalization(.never)
                            .autocorrectionDisabled()
                            .keyboardType(.asciiCapable)
                            .textContentType(nil)
                            .writingToolsBehavior(.disabled)
                            .submitLabel(slot == 0 ? .next : .done)
                            .focused(focused, equals: slot)
                            .onSubmit { focused.wrappedValue = slot == 0 ? 1 : nil }
                            .accessibilityLabel("Word \(at + 1)")
                            .padding(.horizontal, 6).padding(.vertical, 2)
                            .background(Alpine.surface, in: RoundedRectangle(cornerRadius: Alpine.Radius.control - 2))
                            .overlay(RoundedRectangle(cornerRadius: Alpine.Radius.control - 2).stroke(wrong ? Alpine.danger : Alpine.rule, lineWidth: 1))
                    } else {
                        Text(shown.code[at]).font(.body.weight(.medium)).foregroundStyle(Alpine.ink)
                    }
                }
                .padding(.horizontal, Alpine.Space.s2).padding(.vertical, 6)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(Alpine.ground, in: RoundedRectangle(cornerRadius: Alpine.Radius.control))
            }
        }
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Join code")
    }
}

/* A person by their first name, as the web's firstName. */
func firstName(_ name: String) -> String {
    name.split(whereSeparator: \.isWhitespace).first.map(String.init) ?? name
}
