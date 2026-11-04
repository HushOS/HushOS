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

/* A manager's role change of someone (the web's MemberList menu), and the handover's last step left half done. */
enum RoleKind: Equatable { case manage, stop, organizer, finish }

struct RoleAsk: Identifiable, Equatable {
    let groupId: String
    let member: FamilyMemberRef
    let kind: RoleKind
    var id: String { "\(groupId)|\(member.userId.lowercased())|\(kind)" }
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
     * own work (leaving the page doesn't stop it; what each call let go of came to is kept on this
     * phone until said, and said until read), then who waits and the open invitations read again.
     */
    func loadManaged(_ summary: GroupSummary) async {
        let groupId = summary.id
        guard let session = beginSession() else { return }
        do {
            let names = memberNames(groupId)
            let resumed = try await inFamilyLanding(session, { sync in
                try await sync.resumeOutbox(groupId, names: names, handed: { to, end in await self.handed(to, end, summary: summary, session: session) })
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
        let family: String = familyNames[groupId] ?? familyList?.first(where: { $0.id == groupId })?.name ?? "The family"
        if let words = ManageWords.resumed(end, route: route, family: family, name: named) {
            manageNotices.untilRead(words)
        }
    }

    /* First names by user id, for sentences about members and those waiting (whoever else holds billing). */
    func memberNames(_ groupId: String) -> [String: String] {
        var out: [String: String] = [:]
        for member in familyDetails[groupId]?.members ?? [] { out[member.userId.lowercased()] = HushOS.firstName(member.name) }
        for person in waitingToJoin[groupId] ?? [] where out[person.userId.lowercased()] == nil { out[person.userId.lowercased()] = HushOS.firstName(person.name) }
        return out
    }

    /* A handover the resume finished (or tried to): said as Make them the organizer's own outcome, the family read again. */
    private func handed(_ to: String, _ end: RoleEnd, summary: GroupSummary, session: Session) async {
        guard current(session) else { return }
        let who = memberNames(summary.id)[to.lowercased()] ?? "They"
        if end == .checkFirst {
            // Their pin was no longer verified when it went on (removed on another device): the same check a fresh
            // Make them the organizer asks for, then they can be asked again.
            let member = familyDetails[summary.id]?.members.first { $0.userId.lowercased() == to.lowercased() }
            let ref = FamilyMemberRef(userId: to, email: member?.email ?? "", name: member?.name ?? who)
            checkFirstAsk = RoleAsk(groupId: summary.id, member: ref, kind: .organizer)
        }
        sayRole(end, kind: .organizer, who: who)
        await refreshFamily(summary, session: session)
    }

    /*
     * What kept calls let go of came to (the resume's, the staging gate's), said as the resume says
     * them, then let go of: only by the session that looked and is still current, so ends a reset
     * came between stay kept on this phone for the next look (said twice at worst, never lost).
     */
    private func sayKeptEnds(_ session: Session) async {
        guard current(session), let ends = try? await inFamily(session, { try await $0.keptEnds() }), !ends.isEmpty, current(session) else { return }
        for kept in ends { handOver(kept.end, route: kept.route, groupId: kept.groupId, session: session) }
        _ = try? await inFamily(session, { try await $0.dropKeptEnds(ends) })
    }

    // MARK: Roles

    /*
     * A member's role change from their row: a promotion (managing the family, or its billing) over
     * someone not verified on this phone asks for a check first (the web's needsCheckFor); the data
     * layer reads their standing again before anything is signed.
     */
    func askRole(_ ask: RoleAsk, verified: Bool) {
        guard roleChanges.busy == nil else { return }
        if (ask.kind == .manage || ask.kind == .organizer) && !verified { checkFirstAsk = ask } else { roleAsk = ask }
    }

    /* Finish handing over to {first}: the step the person already asked for, asked again to confirm. */
    func finishHandingOver(_ groupId: String, member: FamilyMemberRef) {
        guard roleChanges.busy == nil else { return }
        roleAsk = RoleAsk(groupId: groupId, member: member, kind: .finish)
    }

    /*
     * The confirmed change, as the session's own work: said once it lands, kept on this phone when no
     * answer came; an ended session's answer lands nothing. The family is read again after anything
     * short of a landing too: part of a handover may have landed (billing given before its last step).
     */
    func confirmRole(_ ask: RoleAsk) {
        roleAsk = nil
        guard roleChanges.busy == nil, let summary = familyList?.first(where: { $0.id == ask.groupId }), let session = beginSession() else { return }
        _ = managedLoads.begin(ask.groupId)
        let who = HushOS.firstName(ask.member.name)
        let names = memberNames(ask.groupId)
        let person = ask.member.userId
        guard let token = roleChanges.begin(person) else { return }
        Task {
            // Its own session's only: a reset meanwhile already let the page go on (RoleChanges).
            defer { roleChanges.end(token) }
            var answer: Answered<RoleEnd>?
            var failure: Error?
            do {
                answer = try await familyAnswer(session, { sync -> RoleEnd in
                    switch ask.kind {
                    case .manage: return try await sync.changeRole(summary, userId: person, first: who, change: .grant)
                    case .stop: return try await sync.changeRole(summary, userId: person, first: who, change: .take)
                    case .organizer: return try await sync.handOver(summary, to: person, first: who, names: names)
                    case .finish: return try await sync.finishHandingOver(summary, to: person, first: who, names: names)
                    }
                })
            } catch {
                failure = error
            }
            // What the gate's kept calls came to, before this one's own words, answered or thrown (kept until said).
            await sayKeptEnds(session)
            guard current(session) else { return }
            if let failure {
                if endsSession(failure) {
                    report(failure)
                    return
                }
                notify("Couldn’t change that. \(FamilyWords.error(failure))")
                await refreshFamily(summary, session: session)
                return
            }
            guard case .answered(let end)? = answer else { return }
            if end == .checkFirst { checkFirstAsk = ask; return }
            sayRole(end, kind: ask.kind, who: who)
            if end == .wiped { await refreshFamilies(force: true, session: session); return }
            await refreshFamily(summary, session: session)
        }
    }

    /* A role change's outcome in its words (Android #276's). */
    private func sayRole(_ end: RoleEnd, kind: RoleKind, who: String) {
        switch end {
        case .landed:
            switch kind {
            case .manage: notify("\(who) can manage the family")
            case .stop: notify("\(who) no longer manages the family")
            case .organizer, .finish: notify("\(who) is the organizer")
            }
        case .pending(let reason): notify("Saved on this device. \(reason)")
        case .refused(let words), .waiting(let words): notify("Couldn’t change that. \(words)")
        case .checkFirst, .wiped: break
        }
    }

    /* A resume's end, the session's: the family checked again after a call landed or was overtaken; a failure said. */
    private func landResumed(_ summary: GroupSummary, _ result: Result<[String: CallEnd], Error>, session: Session) async {
        // What the calls it let go of came to, first, whether or not it then failed.
        await sayKeptEnds(session)
        guard current(session) else { return }
        switch result {
        case .success(let ends):
            if !ends.values.contains(.wiped), ends.values.contains(where: { $0 == .landed || $0 == .stale }) { await refreshFamily(summary, session: session) }
        case .failure(let error):
            if endsSession(error) {
                report(error)
            } else if !FamilySync.transient(error) {
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
        guard let session = beginSession() else { return }
        await refreshFamilies(force: true, session: session)
        guard current(session) else { return }
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
            var answer: Answered<LetIn>?
            var failure: Error?
            do {
                if dropKept {
                    guard case .answered = try await familyAnswer(session, { try await $0.dropKeptAdmission(summary.id, userId: person.userId) }) else { return }
                    waitingRows[key]?.keptOther = false
                }
                // Pinning them may have moved trust: what they and anyone else signed is judged again, as after Contacts' add.
                let trustMoved: @Sendable () async -> Void = { await self.trustMovedByLetIn(session) }
                answer = try await familyAnswer(session, { try await $0.letIn(summary, person, trustMoved: trustMoved) })
            } catch {
                failure = error
            }
            // What the gate's kept calls came to, before this one's own words, answered or thrown (kept until said).
            await sayKeptEnds(session)
            guard current(session) else { return }
            if let failure {
                if endsSession(failure) {
                    report(failure)
                    return
                }
                waitingRows[key]?.error = FamilyWords.error(failure)
                return
            }
            guard case .answered(let outcome)? = answer else { return }
            if let words = ManageWords.letIn(outcome, first: first, family: summary.name) { notify(words) }
            switch outcome {
            case .landed:
                await reloadManaged(summary.id, session: session)
                guard current(session) else { return }
                await refreshFamily(summary, session: session)
            case .pending:
                break
            case .refused(let words):
                waitingRows[key]?.error = words
            case .changed(let change):
                manageChange = ManageChangeAsk(change: change, summary: summary, person: person)
            case .keptOther:
                waitingRows[key]?.keptOther = true
            case .wiped:
                await refreshFamilies(force: true, session: session)
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

/* A manager's role dialogs on the family page: RoleConfirm, and the manager rule's check first. */
struct FamilyRoleDialogs: ViewModifier {
    @Environment(DriveStore.self) private var store
    let groupId: String
    /* Opens the member's check (Check it's {first}), as their row does. */
    var check: (FamilyMemberRef) -> Void = { _ in }

    private var familyName: String {
        if let name = store.familyNames[groupId] { return name }
        return store.familyList?.first(where: { $0.id == groupId })?.name ?? "the family"
    }

    private var checkFirstTitle: String {
        guard let ask = store.checkFirstAsk else { return "" }
        return "Check it’s \(firstName(ask.member.name)) first"
    }

    /* The web's RoleConfirm: what the change means, and its own action (Android #276's words). */
    static func roleTitle(_ ask: RoleAsk) -> String {
        let who = firstName(ask.member.name)
        switch ask.kind {
        case .manage: return "Let \(who) manage the family?"
        case .stop: return "Stop \(who) managing the family?"
        case .organizer, .finish: return "Make \(who) the organizer?"
        }
    }

    static func roleBody(_ ask: RoleAsk, family: String) -> String {
        let who = firstName(ask.member.name)
        switch ask.kind {
        case .manage: return "\(who) can invite people, let them in and change who manages \(family)."
        case .stop: return "\(who) stays in \(family) and keeps the family folders, but can’t change who’s in it any more."
        case .organizer, .finish: return "\(who) takes over the family’s billing. You keep managing the family."
        }
    }

    static func roleAction(_ ask: RoleAsk) -> String {
        switch ask.kind {
        case .manage: return "Let them manage"
        case .stop: return "Stop managing"
        case .organizer, .finish: return "Make organizer"
        }
    }

    func body(content: Self.Content) -> some View {
        content
            .alert(store.roleAsk.map { Self.roleTitle($0) } ?? "",
                   isPresented: Binding(get: { store.roleAsk?.groupId == groupId }, set: { if !$0 { store.roleAsk = nil } }),
                   presenting: store.roleAsk) { ask in
                Button(Self.roleAction(ask)) { store.confirmRole(ask) }
                Button("Cancel", role: .cancel) {}
            } message: { ask in
                Text(Self.roleBody(ask, family: familyName))
            }
            .alert(checkFirstTitle,
                   isPresented: Binding(get: { store.checkFirstAsk?.groupId == groupId }, set: { if !$0 { store.checkFirstAsk = nil } }),
                   presenting: store.checkFirstAsk) { ask in
                Button("Check it’s \(firstName(ask.member.name))") { store.checkFirstAsk = nil; check(ask.member) }
                Button("Cancel", role: .cancel) {}
            } message: { ask in
                Text("Managers can let people in and change the family, so check it’s \(firstName(ask.member.name)) before they manage it. It takes a minute on a call or in person.")
            }
    }
}
