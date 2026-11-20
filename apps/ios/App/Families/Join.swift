import HushOSKit
import SwiftUI

/*
 * Joining a family on the phone (docs/optional-verification.md 6.8), the web's two pages in the
 * same words: the mailed invitation (/join#invite=<token>, routes/join/route.tsx), opened and
 * joined here, then the wait (families/$groupId/join.tsx) until someone who manages the family lets
 * this person in, when the phone joins on first use and the family's page follows. No words on
 * either side: checking each other is for later, from the members list. Every rule is the core's
 * (FamilySync's join steps); this file draws the steps and keeps the person's place.
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
    }

    @State private var step: Step = .opening
    @State private var accepting = false
    @State private var error: GroupsAPIError?
    @State private var problem: String?
    /* The wait's title, as the step below says it ("Waiting for Sam"): the sheet's own title. */
    @State private var waitTitle: String?
    @State private var detent = InvitationSheet.short
    /* A button's request (Join, Try again): cancelled when the sheet closes, so nothing it answers shows or navigates after. */
    @State private var working: Task<Void, Never>?
    @Environment(\.dynamicTypeSize) private var typeSize

    /* As tall as these steps need: the invitation and the wait are a few lines, so the sheet opens part way up. */
    static let short = PresentationDetent.fraction(0.5)

    var body: some View {
        NavigationStack {
            Group {
                switch step {
                case .joining(let groupId, let family):
                    List {
                        JoinSections(groupId: groupId, family: family, title: { waitTitle = $0 }) { open(family: groupId) }
                    }
                    .listStyle(.insetGrouped)
                    .alpineGrouped()
                    .navigationTitle(waitTitle ?? "Join \(family)")
                    .navigationBarTitleDisplayMode(.inline)
                default:
                    List { invitation }
                        .listStyle(.insetGrouped)
                        .alpineGrouped()
                }
            }
            // The invitation's Not now is the sheet's own close (the web's Not now link); every other step closes with Done.
            .toolbar {
                if showsInvitation {
                    ToolbarItem(placement: .cancellationAction) { Button("Not now") { dismiss() }.disabled(accepting) }
                } else {
                    ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } }
                }
            }
        }
        // Part way up for these few lines; the whole height at the largest text sizes, and always one drag away.
        .presentationDetents(typeSize.isAccessibilitySize ? [.large] : [Self.short, .large], selection: $detent)
        .onChange(of: typeSize, initial: true) { _, size in if size.isAccessibilitySize { detent = .large } }
        .task { if step == .opening { await open() } }
        .onDisappear { working?.cancel() }
    }

    /* A button's request, tied to the sheet: closed meanwhile, it shows and closes nothing. */
    private func run(_ request: @escaping @MainActor () async -> Void) {
        working?.cancel()
        working = Task { await request() }
    }

    /* The family's page, pushed in Account where its row is (never inside this sheet), once in or already in. */
    private func open(family groupId: String) {
        store.familyToOpen = groupId
        dismiss()
    }

    private var showsInvitation: Bool {
        if case .invitation = step { return true }
        return false
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
                    Button("Try again") { run { await open() } }.foregroundStyle(Alpine.primary).alpineRow()
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
        let notice = InvitationNotice.of(invitation, refusal: error, email: model.user?.email)
        // No answer, or something other than a refusal: said as such, and Join stays to try again.
        let note = notice.note ?? problem.map { InvitationNotice.Note.problem($0) }
        // Names are the server's word (D10): the address goes beside the inviter's.
        let invited = inviter.map { inviter in
            let email = inviter.email.flatMap { $0.isEmpty ? nil : $0 }
            return "\(inviter.name)\(email.map { " (\($0))" } ?? "") invited you."
        } ?? "You’re invited."
        Section {} header: {
            VStack(alignment: .leading, spacing: Alpine.Space.s1) {
                title("Join \(invitation.name)")
                Text("\(invited) Family folders are shared with everyone in the family.")
                    .font(Theme.Text.callout).foregroundStyle(Alpine.inkMuted).textCase(nil)
            }
        }
        if let note {
            Section {
                switch note {
                case .inFamily(let words, let yours):
                    VStack(alignment: .leading, spacing: Alpine.Space.s2) {
                        Text(words).font(Theme.Text.callout).foregroundStyle(Alpine.ink)
                        Button { open(family: yours.groupId) } label: {
                            Text("Open \(yours.name)").font(Theme.Text.callout.weight(.semibold)).foregroundStyle(Alpine.primary)
                        }
                        .buttonStyle(.borderless)
                    }
                    .padding(.vertical, Alpine.Space.s1)
                    .listRowBackground(Alpine.tint)
                case .alreadyMember:
                    VStack(alignment: .leading, spacing: Alpine.Space.s2) {
                        Text("You’re already in this family").font(Theme.Text.headline).foregroundStyle(Alpine.ink)
                        Button { open(family: invitation.groupId) } label: {
                            Text("Open \(invitation.name)").font(Theme.Text.callout.weight(.semibold)).foregroundStyle(Alpine.primary)
                        }
                        .buttonStyle(.borderless)
                    }
                    .padding(.vertical, Alpine.Space.s1)
                    .listRowBackground(Alpine.tint)
                case .problem(let words):
                    Text(words).font(Theme.Text.callout).foregroundStyle(Alpine.danger).listRowBackground(Alpine.dangerSoft)
                }
            } footer: { signedInAs }
        }
        Section {
            Button { run { await accept(invitation) } } label: { Text(accepting ? "Joining" : "Join").frame(maxWidth: .infinity) }
                .buttonStyle(PrimaryCapsuleStyle())
                .disabled(accepting || !notice.canAccept)
        } footer: {
            if note == nil { signedInAs }
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
            // Nil: dropped, its session ended (the sheet closes) or the sheet closed already (nothing more to do).
            guard let invitation = try await store.inFamily(nil, { try await $0.openInvitation(token) }) else {
                if !Task.isCancelled { dismiss() }
                return
            }
            step = .invitation(invitation)
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
            // Accepted: the families are read again for the session whether or not this sheet is still open (inFamilyLanding).
            let store = store
            guard let groupId = try await store.inFamilyLanding(nil, { try await $0.acceptInvitation(token) }, land: { result in
                if case .success = result { await store.refreshFamilies(force: true) }
            }) else {
                if !Task.isCancelled { dismiss() }
                return
            }
            // Closed meanwhile: no join screen opens from a closed sheet.
            guard !Task.isCancelled else { return }
            step = .joining(groupId, family: invitation.name)
        } catch let refused as GroupsAPIError where refused.status != 0 {
            // Said under the invitation in the web's words (InvitationNotice), Accept off where it can't help.
            error = refused
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
 * The newcomer's side after Join (6.8), as sections of the list it sits in (the family page, or
 * the invitation sheet after Join): waiting until someone who manages the family lets them in,
 * route 2 polled meanwhile; then the phone joins on first use and the family's page follows. The
 * hard warning when this person's own marks disagree with what is served. It owns the family while
 * it is open: the family's background check waits until it closes.
 */
struct JoinSections: View {
    @Environment(DriveStore.self) private var store
    let groupId: String
    let family: String
    /* The wait's title ("Waiting for Sam"), for the screen it sits in to show as its own title; nil while not waiting. */
    var title: ((String?) -> Void)? = nil
    var onJoined: (() -> Void)? = nil

    private enum Step: Equatable {
        case loading
        /* `n` tells one entry into waiting from the next, so polling starts again each time. */
        case waiting(Int)
        case fork(FamilyFork)
    }

    @State private var step: Step = .loading
    @State private var error: String?
    @State private var managers: [GroupDetail.Member] = []
    /* Try again's count: each starts the step check again as the screen's own task, cancelled when the screen goes. */
    @State private var attempt = 0

    /* One manager is named; with more, whoever manages the family lets them in. */
    private var only: String? { managers.count == 1 ? firstName(managers[0].name) : nil }

    var body: some View {
        Group {
            if let error {
                Section {
                    Text(error).font(Theme.Text.callout).foregroundStyle(Alpine.ink).listRowBackground(Alpine.warningSoft)
                    if step == .loading {
                        Button { attempt += 1 } label: { Label("Try again", systemImage: "arrow.counterclockwise") }
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
            case .fork(let fork):
                FamilyForkSection(name: family, fork: fork)
            }
        }
        .task { store.openJoin(groupId) }
        // Keyed on the session's vault too: a new session (the same account signed in again from Files) drops what the last
        // one asked, and the screen asks again under the new one rather than staying where it was.
        .task(id: "\(ObjectIdentifier(store.vault).hashValue)-\(attempt)") { await resume() }
        .onDisappear { store.closeJoin(groupId) }
        .onChange(of: "\(waitingEntry != 0)-\(waitingTitle)", initial: true) { _, _ in title?(waitingEntry != 0 ? waitingTitle : nil) }
        // Route 3 answers someone who accepted: who manages the family, read again every few seconds.
        .task(id: groupId) {
            while !Task.isCancelled {
                if let detail = try? await store.inFamily(nil, { try await $0.members(groupId) }) {
                    managers = detail.members.filter { $0.state == "active" && $0.roles.contains("members") }
                }
                try? await Task.sleep(for: .seconds(5))
            }
        }
        // Waiting: route 2 polled through the join status until the person is let in.
        // Keyed on the session's vault too: a poll the last session's end dropped starts again under the new one.
        .task(id: "\(waitingEntry)-\(ObjectIdentifier(store.vault).hashValue)") {
            guard waitingEntry != 0 else { return }
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(3))
                if Task.isCancelled { return }
                do {
                    // Dropped when the session it began in ended: the screen goes with it.
                    guard let outcome = try await nextStep() else { return }
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

    private var waitingTitle: String { only.map { "Waiting for \($0)" } ?? "Waiting to be let in" }

    /* The web's waiting screen: the title is the screen's, then one line of what happens, with a spinner beside it. */
    @ViewBuilder private var waiting: some View {
        let words = only.map { "\($0) lets you in from the family’s page. This page updates when you’re in." }
            ?? "Someone who manages \(family) lets you in from the family’s page. This page updates when you’re in."
        Section {
            HStack(alignment: .firstTextBaseline, spacing: Alpine.Space.s2) {
                ProgressView().accessibilityHidden(true)
                Text(words).font(Theme.Text.callout).foregroundStyle(Alpine.ink)
            }
            .padding(.vertical, Alpine.Space.s1)
            .alpineRow()
            .accessibilityElement(children: .combine)
            .accessibilityLabel("\(waitingTitle). \(words)")
        }
    }

    // MARK: Actions

    /*
     * The join's next step. What it found for the session (in, its state published; already a
     * member, the family checked) lands whether or not this screen is still open (inFamilyLanding,
     * DriveStore.landJoin); the step reaches the screen only while it is.
     */
    private func nextStep() async throws -> JoinOutcome? {
        let groupId = groupId
        let store = store
        return try await store.inFamilyLanding(nil, { try await $0.joinStatusRevised(groupId) }, land: { result in
            if case .success(let found) = result { await store.landJoin(groupId, found.outcome, revision: found.revision) }
        })?.outcome
    }

    /* Each answer from the join steps, as the screen shows it: never from a closed screen (the session took what it found). */
    private func show(_ outcome: JoinOutcome) {
        guard !Task.isCancelled else { return }
        error = nil
        switch outcome {
        case .joined:
            store.notify("You’re in \(family)")
            onJoined?()
        case .member:
            // This phone already holds the family: nothing to join. Checked as a member (landJoin), from this screen.
            onJoined?()
        case .waiting:
            if case .waiting = step { return }
            step = .waiting(Int(Date().timeIntervalSince1970 * 1000))
        case .fork(let fork):
            step = .fork(fork)
        }
    }

    private func resume() async {
        error = nil
        do {
            guard let outcome = try await nextStep() else { return }
            show(outcome)
        } catch {
            if endsSession(error) { store.report(error); return }
            // The retry belongs to the loading step, whatever step this came from.
            step = .loading
            self.error = FamilyWords.error(error)
        }
    }
}

/* A person by their first name, as the web's firstName. */
func firstName(_ name: String) -> String {
    name.split(whereSeparator: \.isWhitespace).first.map(String.init) ?? name
}
