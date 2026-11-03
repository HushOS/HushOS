import HushOSKit
import SwiftUI

/*
 * A manager's side of joining on the family page (iOS 5a, Android's #265, the web's family
 * page): Invite someone, Waiting to join with Not now and Let them in, and Invitations with
 * Cancel invitation. Every decision is HushOSKit's (FamilyManage.swift); this keeps the lists,
 * dialogs and notices in the store and draws them. A list that doesn't load keeps its rows and
 * says why; an answer of an older load never lands; a 401 anywhere is the lost session.
 */

struct WaitingRow: Equatable {
    enum Busy: Equatable { case send, decline }
    var busy: Busy?
    var error: String?
    /* An earlier Let them in for them is kept for keys they had before: drop it first. */
    var keptOther = false
}

struct InviteAsk: Equatable {
    let groupId: String
    var email = ""
    var busy = false
    var error: String?
}

struct TurnDownAsk: Identifiable, Equatable {
    let groupId: String
    let family: String
    let person: PendingPerson
    var id: String { "\(groupId)|\(person.userId)" }
}

/* Let them in stopped at their changed account: resumed once the change is resolved (Continue, or checked); closing only closes. */
struct ManageChangeAsk: Identifiable {
    let change: AccountChange
    let summary: GroupSummary
    let person: PendingPerson
    var id: AccountChange.ID { change.id }
}

struct CancelInvitationAsk: Identifiable, Equatable {
    let groupId: String
    let invitation: FamilyInvitation
    var id: String { invitation.id }
}

extension DriveStore {
    /* Whether this account manages the family (route 2's roles). */
    func manages(_ groupId: String) -> Bool {
        guard let summary = familyList?.first(where: { $0.id == groupId }) else { return false }
        return summary.state == "active" && summary.roles.contains("members")
    }

    static func waitingKey(_ groupId: String, _ userId: String) -> String { "\(groupId)|\(userId.lowercased())" }

    /*
     * The manager lists of a family: calls kept on this phone sent again first, as the session's
     * own work (leaving the page doesn't stop it, and each refusal is handed to the notices before
     * its call goes, said until read), then who waits and the open invitations read again.
     */
    func loadManaged(_ summary: GroupSummary) async {
        let groupId = summary.id
        guard let session = beginSession() else { return }
        do {
            let resumed = try await inFamilyLanding(session, { sync in
                try await sync.resumeOutbox(groupId) { end, route in await self.handOver(end, route: route, groupId: groupId, session: session) }
            }, land: { result in await self.landResumed(summary, result, session: session) })
            guard let ends = resumed, !ends.values.contains(.wiped) else { return }
        } catch {
            // Said (or the session reported) as it landed.
            if endsSession(error) { return }
        }
        await reloadManaged(groupId, session: session)
    }

    /* A pin Let them in made or moved, for the session it began in: signers and shares loaded again, as Contacts does. */
    private func trustMovedByLetIn(_ session: Session) {
        guard current(session) else { return }
        Task { await refreshSigners(); await refreshMounts() }
    }

    /* What a dropped kept call came to, for the session it began in: a refusal, or an admission overtaken, waits until it is read. */
    private func handOver(_ end: CallEnd, route: ChainRoute?, groupId: String, session: Session) {
        guard current(session) else { return }
        let named = { (userId: String) -> String? in
            let id = userId.lowercased()
            let name = self.waitingToJoin[groupId]?.first { $0.userId.lowercased() == id }?.name
                ?? self.familyDetails[groupId]?.members.first { $0.userId.lowercased() == id }?.name
            return name.map { HushOS.firstName($0) }
        }
        if let words = ManageWords.resumed(end, route: route, name: named) { manageNotices.untilRead(words) }
    }

    /* A resume's end, the session's: the family checked again after a call landed or was overtaken; a failure said. */
    private func landResumed(_ summary: GroupSummary, _ result: Result<[String: CallEnd], Error>, session: Session) async {
        guard current(session) else { return }
        switch result {
        case .success(let ends):
            if !ends.values.contains(.wiped), ends.values.contains(where: { $0 == .landed || $0 == .stale }) { await refreshFamily(summary) }
        case .failure(let error):
            if endsSession(error) {
                report(error)
            } else if !FamilySync.unanswered(error) {
                notify(FamilyWords.error(error))
            }
        }
    }

    /* A manager's action of `session` against its family sync: dropped when the session ended or changed, never success. */
    private func familyAnswer<T: Sendable>(_ session: Session, _ work: @escaping @Sendable (FamilySync) async throws -> T) async throws -> Answered<T> {
        try await sessionGate.answer(session) { vault -> T? in
            guard let families = FamilySync.shared(for: vault) else { return nil }
            return try await work(families)
        }
    }

    /* Who waits and the open invitations, read again; an answer of a load begun before the last one is dropped. */
    func reloadManaged(_ groupId: String, session begun: Session? = nil) async {
        let load = managedLoads.begin(groupId)
        guard let session = begun ?? beginSession() else { return }
        var failures: [Error] = []
        var people: [PendingPerson]?
        var invitations: [FamilyInvitation]?
        do { people = try await inFamily(session, { try await $0.waitingToJoin(groupId) }) } catch { failures.append(error) }
        do { invitations = try await inFamily(session, { try await $0.openInvitations(groupId) }) } catch { failures.append(error) }
        guard current(session), managedLoads.admits(groupId, load) else { return }
        if let ended = failures.first(where: { endsSession($0) }) {
            report(ended)
            return
        }
        if let people { waitingToJoin[groupId] = people }
        if let invitations { familyInvitations[groupId] = invitations }
        // A list that didn't load keeps its rows and says why; the next one that loads clears it.
        managedErrors[groupId] = failures.first.map { FamilyWords.error($0) }
    }

    /* Pull to refresh: the families checked again, and the manager lists read again. */
    func refreshManagedPage(_ groupId: String) async {
        await refreshFamilies(force: true)
        if manages(groupId), let summary = familyList?.first(where: { $0.id == groupId }) { await loadManaged(summary) }
    }

    func letIn(_ summary: GroupSummary, _ person: PendingPerson, dropKept: Bool = false) {
        let key = Self.waitingKey(summary.id, person.userId)
        guard waitingRows[key]?.busy == nil else { return }
        guard let session = beginSession() else { return }
        _ = managedLoads.begin(summary.id)
        waitingRows[key, default: WaitingRow()].busy = .send
        waitingRows[key]?.error = nil
        let first = HushOS.firstName(person.name)
        Task {
            defer { if current(session) { waitingRows[key]?.busy = nil } }
            do {
                if dropKept {
                    guard case .answered = try await familyAnswer(session, { try await $0.dropKeptAdmission(summary.id, userId: person.userId) }) else { return }
                    waitingRows[key]?.keptOther = false
                }
                // Pinning them may have moved trust: what they and anyone else signed is judged again, as after Contacts' add.
                let trustMoved: @Sendable () async -> Void = { await self.trustMovedByLetIn(session) }
                guard case .answered(let outcome) = try await familyAnswer(session, { try await $0.letIn(summary, person, trustMoved: trustMoved) }) else { return }
                if let words = ManageWords.letIn(outcome, first: first, family: summary.name) { notify(words) }
                switch outcome {
                case .landed:
                    await reloadManaged(summary.id, session: session)
                    guard current(session) else { return }
                    await refreshFamily(summary)
                case .pending:
                    break
                case .refused(let words):
                    waitingRows[key]?.error = words
                case .changed(let change):
                    manageChange = ManageChangeAsk(change: change, summary: summary, person: person)
                case .keptOther:
                    waitingRows[key]?.keptOther = true
                case .wiped:
                    await refreshFamilies(force: true)
                }
            } catch {
                guard current(session) else { return }
                if endsSession(error) {
                    report(error)
                    return
                }
                waitingRows[key]?.error = FamilyWords.error(error)
            }
        }
    }

    func turnDown(_ ask: TurnDownAsk) {
        let key = Self.waitingKey(ask.groupId, ask.person.userId)
        guard waitingRows[key]?.busy == nil, let session = beginSession() else { return }
        _ = managedLoads.begin(ask.groupId)
        waitingRows[key, default: WaitingRow()].busy = .decline
        waitingRows[key]?.error = nil
        Task {
            do {
                // Dropped (the session ended or changed): nothing was turned down as far as this screen knows.
                guard case .answered = try await familyAnswer(session, { try await $0.turnDown(ask.groupId, userId: ask.person.userId) }) else {
                    if current(session) { waitingRows[key]?.busy = nil }
                    return
                }
                waitingRows[key] = nil
                waitingToJoin[ask.groupId]?.removeAll { $0.userId == ask.person.userId }
                notify("\(HushOS.firstName(ask.person.name)) won’t join \(ask.family). You can invite them again.")
                await reloadManaged(ask.groupId, session: session)
            } catch {
                guard current(session) else { return }
                if endsSession(error) {
                    waitingRows[key] = nil
                    report(error)
                    return
                }
                waitingRows[key]?.busy = nil
                waitingRows[key]?.error = FamilyWords.error(error)
            }
        }
    }

    func cancelInvitation(_ ask: CancelInvitationAsk) {
        guard let session = beginSession() else { return }
        _ = managedLoads.begin(ask.groupId)
        Task {
            do {
                guard case .answered = try await familyAnswer(session, { try await $0.cancelInvitation(ask.groupId, invitationId: ask.invitation.id) }) else { return }
                notify(ask.invitation.email.isEmpty ? "Invitation cancelled" : "Invitation to \(ask.invitation.email) cancelled")
            } catch {
                guard current(session) else { return }
                if endsSession(error) {
                    report(error)
                    return
                }
                notify("Couldn’t cancel it. \(FamilyWords.error(error))")
            }
            await reloadManaged(ask.groupId, session: session)
        }
    }

    func askInvite(_ groupId: String) {
        guard inviting?.busy != true else { return }
        inviting = InviteAsk(groupId: groupId)
    }

    func dismissInvite() {
        guard inviting?.busy != true else { return }
        inviting = nil
    }

    func typeInvite(_ text: String) {
        guard inviting?.busy == false else { return }
        inviting?.email = text
        inviting?.error = nil
    }

    func sendInvite() {
        guard var ask = inviting, !ask.busy else { return }
        let address = ask.email.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !address.isEmpty, let session = beginSession() else { return }
        ask.busy = true
        ask.error = nil
        inviting = ask
        let groupId = ask.groupId
        _ = managedLoads.begin(groupId)
        Task {
            do {
                // Dropped (the session ended or changed): never "sent"; the sheet stays as typed, or went with the session.
                guard case .answered = try await familyAnswer(session, { try await $0.invite(groupId, email: address) }) else {
                    if current(session) { inviting?.busy = false }
                    return
                }
                inviting = nil
                notify("Invitation sent to \(address)")
                await reloadManaged(groupId, session: session)
            } catch {
                guard current(session) else { return }
                if endsSession(error) {
                    inviting = nil
                    report(error)
                    return
                }
                inviting?.busy = false
                inviting?.error = ManageWords.invite(error)
            }
        }
    }
}

/* The manager's sections on the family page, above Members: invite, why a list didn't load, who waits. */
struct FamilyManageSections: View {
    @Environment(DriveStore.self) private var store
    let summary: GroupSummary

    private var groupId: String { summary.id }

    var body: some View {
        Section {
            Button { store.askInvite(groupId) } label: { Label("Invite someone", systemImage: "person.badge.plus") }
                .foregroundStyle(Alpine.primary).alpineRow()
        }
        if let error = store.managedErrors[groupId] {
            Section {
                Text(error).font(Theme.Text.callout).foregroundStyle(Alpine.danger).alpineRow()
                Button("Try again") { Task { await store.loadManaged(summary) } }.foregroundStyle(Alpine.primary).alpineRow()
            }
        }
        if let waiting = store.waitingToJoin[groupId], !waiting.isEmpty {
            Section {
                ForEach(waiting) { person in waitingRow(person) }
            } header: {
                Text("Waiting to join").font(Theme.Text.label).foregroundStyle(Alpine.inkMuted)
            }
        }
    }

    @ViewBuilder private func waitingRow(_ person: PendingPerson) -> some View {
        let row = store.waitingRows[DriveStore.waitingKey(groupId, person.userId)] ?? WaitingRow()
        let first = firstName(person.name)
        VStack(alignment: .leading, spacing: Alpine.Space.s2) {
            VStack(alignment: .leading, spacing: 2) {
                Text(person.name).font(Theme.Text.body).foregroundStyle(Alpine.ink)
                Text(person.email).font(Theme.Text.footnote).foregroundStyle(Alpine.inkMuted).lineLimit(1).truncationMode(.middle)
            }
            if person.inFamily {
                Text("Already in a family").font(Theme.Text.footnote).foregroundStyle(Alpine.inkMuted)
            } else {
                if row.keptOther {
                    VStack(alignment: .leading, spacing: Alpine.Space.s2) {
                        Text("An earlier Let them in for \(first) hasn’t reached the server, and it was made before \(first)’s account changed. Drop it and let \(first) in again.")
                            .font(Theme.Text.callout).foregroundStyle(Alpine.ink)
                        Button("Drop it and let them in") { store.letIn(summary, person, dropKept: true) }
                            .font(Theme.Text.callout.weight(.semibold)).foregroundStyle(Alpine.primary).buttonStyle(.borderless)
                    }
                    .padding(Alpine.Space.s2)
                    .background(Alpine.warningSoft, in: RoundedRectangle(cornerRadius: 10))
                }
                HStack(spacing: Alpine.Space.s4) {
                    Button(row.busy == .decline ? "Turning down" : "Not now") {
                        store.turningDown = TurnDownAsk(groupId: groupId, family: summary.name, person: person)
                    }
                    .foregroundStyle(Alpine.ink).buttonStyle(.borderless).disabled(row.busy != nil)
                    Button(row.busy == .send ? "Letting them in" : "Let them in") { store.letIn(summary, person) }
                        .fontWeight(.semibold).foregroundStyle(Alpine.primary).buttonStyle(.borderless)
                        .disabled(row.busy != nil || row.keptOther)
                }
                .font(Theme.Text.callout)
            }
            if let error = row.error { Text(error).font(Theme.Text.callout).foregroundStyle(Alpine.danger) }
        }
        .padding(.vertical, Alpine.Space.s1)
        .alpineRow()
    }
}

/* The open invitations, below Members. */
struct FamilyInvitationsSection: View {
    @Environment(DriveStore.self) private var store
    let groupId: String

    var body: some View {
        if let invitations = store.familyInvitations[groupId], !invitations.isEmpty {
            Section {
                ForEach(invitations) { invitation in
                    VStack(alignment: .leading, spacing: 2) {
                        Text(invitation.email.isEmpty ? "Someone invited" : invitation.email).font(Theme.Text.body).foregroundStyle(Alpine.ink)
                            .lineLimit(1).truncationMode(.middle)
                        if let until = Self.until(invitation.expiresAt) {
                            Text("Open until \(until)").font(Theme.Text.footnote).foregroundStyle(Alpine.inkMuted)
                        }
                        Text("Invited by \(Self.inviter(invitation, among: store.familyDetails[groupId]?.members ?? []))").font(Theme.Text.footnote).foregroundStyle(Alpine.inkMuted).lineLimit(1)
                        Button("Cancel invitation") { store.cancellingInvitation = CancelInvitationAsk(groupId: groupId, invitation: invitation) }
                            .font(Theme.Text.callout).foregroundStyle(Alpine.danger).buttonStyle(.borderless).padding(.top, Alpine.Space.s1)
                    }
                    .padding(.vertical, Alpine.Space.s1)
                    .alpineRow()
                }
            } header: {
                Text("Invitations").font(Theme.Text.label).foregroundStyle(Alpine.inkMuted)
            }
        }
    }

    /* "Name (address)" for a member who invited, else "a manager" (the web's inviter()). */
    static func inviter(_ invitation: FamilyInvitation, among members: [GroupDetail.Member]) -> String {
        guard let id = invitation.invitedBy?.lowercased(),
              let member = members.first(where: { $0.userId.lowercased() == id }), !member.name.isEmpty else { return "a manager" }
        return member.email.flatMap { $0.isEmpty ? nil : "\(member.name) (\($0))" } ?? member.name
    }

    /* "12 Nov", or "12 Nov 2027" in another year, as the web says it. */
    static func until(_ iso: String) -> String? {
        let parse = ISO8601DateFormatter()
        parse.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        guard let date = parse.date(from: iso) ?? ISO8601DateFormatter().date(from: iso) else { return nil }
        if Calendar.current.isDate(date, equalTo: .now, toGranularity: .year) {
            return date.formatted(.dateTime.day().month(.abbreviated).locale(.dayMonth))
        }
        return date.formatted(.dateTime.day().month(.abbreviated).year().locale(.dayMonth))
    }
}

/* Invite someone: an address, and the server's words when it refuses. */
struct InviteSheet: View {
    @Environment(DriveStore.self) private var store

    var body: some View {
        let ask = store.inviting
        let busy = ask?.busy == true
        VStack(alignment: .leading, spacing: Alpine.Space.s3) {
            Text("Invite someone").font(Theme.Text.headline).foregroundStyle(Alpine.ink)
            Text("We’ll email them a link. Once they accept, you let them in.").font(Theme.Text.callout).foregroundStyle(Alpine.ink)
            VStack(alignment: .leading, spacing: Alpine.Space.s1) {
                TextField("them@example.com", text: Binding(get: { store.inviting?.email ?? "" }, set: { store.typeInvite($0) }))
                    .textContentType(.emailAddress).keyboardType(.emailAddress).textInputAutocapitalization(.never).autocorrectionDisabled()
                    .submitLabel(.send).onSubmit { store.sendInvite() }
                    .padding(Alpine.Space.s2)
                    .background(Alpine.ground, in: RoundedRectangle(cornerRadius: 10))
                    .accessibilityLabel("Email")
                    .disabled(busy)
                Text("The invitation is open for 7 days.").font(Theme.Text.footnote).foregroundStyle(Alpine.inkMuted)
            }
            if let error = ask?.error { Text(error).font(Theme.Text.callout).foregroundStyle(Alpine.danger) }
            Spacer(minLength: 0)
            VStack(spacing: Alpine.Space.s2) {
                Button { store.sendInvite() } label: { Text(busy ? "Sending" : "Send invitation").frame(maxWidth: .infinity) }
                    .buttonStyle(PrimaryCapsuleStyle())
                    .disabled(busy || (ask?.email.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ?? true))
                Button { store.dismissInvite() } label: { Text("Cancel").frame(maxWidth: .infinity) }
                    .buttonStyle(SecondaryCapsuleStyle()).disabled(busy)
            }
        }
        .padding(Alpine.Space.s4)
        .presentationDetents([.medium, .large])
        .interactiveDismissDisabled(busy)
    }
}

/* What the family page adds for its managers: the dialogs, the changed-account steps and the notices to read. */
struct FamilyManageDialogs: ViewModifier {
    @Environment(DriveStore.self) private var store
    let groupId: String

    func body(content: Self.Content) -> some View {
        content
            .sheet(isPresented: Binding(get: { store.inviting?.groupId == groupId }, set: { if !$0 { store.dismissInvite() } })) {
                InviteSheet().environment(store)
            }
            .alert(store.turningDown.map { "Turn \(firstName($0.person.name)) down?" } ?? "",
                   isPresented: Binding(get: { store.turningDown?.groupId == groupId }, set: { if !$0 { store.turningDown = nil } }),
                   presenting: store.turningDown) { ask in
                Button("Turn down", role: .destructive) { store.turnDown(ask) }
                Button("Cancel", role: .cancel) {}
            } message: { ask in
                Text("They’ll need a new invitation to join \(ask.family). To decide later, close this instead: nothing is lost.")
            }
            .alert(store.cancellingInvitation.map { $0.invitation.email.isEmpty ? "Cancel this invitation?" : "Cancel the invitation to \($0.invitation.email)?" } ?? "",
                   isPresented: Binding(get: { store.cancellingInvitation?.groupId == groupId }, set: { if !$0 { store.cancellingInvitation = nil } }),
                   presenting: store.cancellingInvitation) { ask in
                Button("Cancel invitation", role: .destructive) { store.cancelInvitation(ask) }
                Button("Keep invitation", role: .cancel) {}
            } message: { _ in
                Text("The link in their email stops working. You can invite them again.")
            }
            .sheet(item: Binding(get: { store.manageChange }, set: { store.manageChange = $0 })) { ask in
                NavigationStack {
                    // Resolved (Continue, or checked): Let them in goes on for them. Closing only closes.
                    ContactStepView(step: .changed(ask.change), resolved: { store.letIn(ask.summary, ask.person) }, presented: true) { store.manageChange = nil }
                }
                .environment(store)
            }
            .alert(store.manageNotices.shown?.text ?? "",
                   isPresented: Binding(get: { store.manageNotices.shown?.untilRead == true }, set: { if !$0 { store.manageNotices.dismiss() } })) {
                Button("OK", role: .cancel) {}
            }
    }
}
