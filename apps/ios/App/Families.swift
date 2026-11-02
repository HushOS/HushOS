import HushOSKit
import SwiftUI

/*
 * Families on the phone (docs/groups-mobile-plan.md, iOS 1 and 2): a row per family in Account
 * (the web's Families list and sidebar row), the family's page with its folders and members, and
 * each family folder as the same Files list: new folders, uploads, renames, moves and copies
 * within it, and the trash, while this device may write there (the web's areaWrite), and nothing
 * that shares, links, reports or keeps. Every family is checked on this phone first
 * (FamilySync); a member list shown differently is the hard warning and nothing of the family
 * opens. The words are the web's.
 */

extension DriveStore {
    /* The session an operation begins in (SessionGate): taken once at its outermost entry and passed down. */
    func beginSession() -> Session? { sessionGate.begin() }

    /* Whether an operation's session is still the current one: checked at every step after a suspension. */
    func current(_ session: Session) -> Bool { sessionGate.current(session) }

    /*
     * Work of `session` (or of the session now, for an operation of one step), through its gate,
     * against that session's own vault: nil when it ended or changed before the work started or
     * answered (dropped, its failure and any 401 too), the failure thrown otherwise.
     */
    func inSession<T: Sendable>(_ session: Session?, _ work: @escaping @Sendable (Vault) async throws -> T) async throws -> T? {
        guard let session = session ?? beginSession(), let result = await sessionGate.run(session, work) else { return nil }
        return try result.get()
    }

    /* A family request of `session` (`inSession`), against that session's family sync: nil, as dropped, when its vault has none (replaced). */
    func inFamily<T: Sendable>(_ session: Session?, _ work: @escaping @Sendable (FamilySync) async throws -> T) async throws -> T? {
        try await inSession(session) { vault -> T? in
            guard let families = FamilySync.shared(for: vault) else { return nil }
            return try await work(families)
        } ?? nil
    }

    /*
     * The session ended or is replaced (the same account signed in again, a sign-out, a deletion):
     * everything drawn of its families goes, and what it still has out is cancelled and dropped.
     * Which folders are family folders stays (`familyRoots`, `familyAreaGroups`, `familyFolders`):
     * never read under a personal key, whatever the new session finds.
     */
    func resetFamilies() {
        sessionGate.reset()
        for groupId in familyStates.keys { familyGenerations.published(groupId) }
        familyRevisions = FamilyRevisions()
        familyList = nil
        familiesServed = nil
        familiesSyncedAt = nil
        familyStates = [:]
        familyShown = [:]
        familyDetails = [:]
        familyNames = [:]
        familySyncing = []
        familyBook.reset()
        familyCheckedAt = [:]
        familyToOpen = nil
        for (id, problem) in folderProblems {
            if case .family = problem { folderProblems[id] = nil } else if problem == .removed { folderProblems[id] = nil }
        }
        for groupId in familyRefreshed.keys { familyRefreshed[groupId, default: 0] += 1 }
    }

    /* A family folder's item: decided by every family folder this session learned of, never by the last sync's answer. */
    func isFamily(_ item: Opened) -> Bool { familyAreaGroups[item.node.workspaceId.lowercased()] != nil }

    func family(of item: Opened) -> GroupSummary? {
        guard let groupId = familyAreaGroups[item.node.workspaceId.lowercased()] else { return nil }
        return familyList?.first { $0.id == groupId }
    }

    /* Whether a folder on screen is in a family folder: its own row, or a family folder's top. */
    func isFamilyFolder(_ id: String) -> Bool {
        if familyRoots[id.lowercased()] != nil || familyFolders[id.lowercased()] != nil { return true }
        if let item = known(id) { return isFamily(item) }
        return false
    }

    /*
     * Whether this device may write in the family folder an item or folder is in (the web's
     * `writable`: its family accepted here, the folder's keys checked at its latest version and its
     * top folder opened). The vault asks the ledger again on every write; this only decides what
     * the screens offer.
     */
    func familyWritable(workspace: String) -> Bool {
        let workspace = workspace.lowercased()
        guard let groupId = familyAreaGroups[workspace], let view = familyShown[groupId],
              let area = view.areas.first(where: { $0.workspaceId.lowercased() == workspace }) else { return false }
        return area.openable && area.write == .writable
    }

    func familyWritable(_ item: Opened) -> Bool { familyWritable(workspace: item.node.workspaceId) }

    /* A family folder's top folder: its name and its family's, as the family's page shows them; nil for any other folder. */
    func familyRoot(_ id: String) -> (name: String, family: String)? {
        guard let groupId = familyRoots[id.lowercased()],
              let area = familyShown[groupId]?.areas.first(where: { $0.root?.id.lowercased() == id.lowercased() }) else { return nil }
        return (area.name ?? "Family folder", familyList?.first { $0.id == groupId }?.name ?? "the family")
    }

    /* Family folders this device may write in, for the move picker's top level beside Files. */
    var writableFamilyRoots: [(id: String, name: String, family: String)] {
        familyShown.flatMap { groupId, view in
            view.areas.filter { $0.openable && $0.write == .writable }.compactMap { area in
                area.root.map { ($0.id, area.name ?? "Family folder", familyList?.first { $0.id == groupId }?.name ?? "the family") }
            }
        }.sorted { $0.name.localizedStandardCompare($1.name) == .orderedAscending }
    }

    func familyFolderWritable(_ id: String) -> Bool {
        if let item = known(id) { return familyWritable(item) }
        // A family folder's top folder before its row is known: by route 25's root.
        guard let groupId = familyRoots[id.lowercased()],
              let area = familyShown[groupId]?.areas.first(where: { $0.root?.id.lowercased() == id.lowercased() }) else { return false }
        return familyWritable(workspace: area.workspaceId)
    }

    /* The family's verdict for an item as it is now; nil while it is being judged. */
    func familyVerdict(of item: Opened) -> FamilyVerdict? { familyBook.verdict(of: item.ref, node: item.node) }

    /*
     * Each family folder item's mark and Info lines, judged once per version of its row, a family
     * at a time. A judgement publishes only for the session and the family's trust generation it
     * began under (FamilyVerdictBook): one that finishes after the family synced, was cleared or
     * judged again, or after trust changed, is dropped, and the newer one stands.
     */
    func judgeFamilyItems(_ items: [Opened], session: Session? = nil) async {
        guard let session = session ?? beginSession() else { return }
        let due = items.filter { isFamily($0) && familyVerdict(of: $0) == nil }
        for (groupId, group) in Dictionary(grouping: due, by: { familyAreaGroups[$0.node.workspaceId.lowercased()] ?? "" }) where !groupId.isEmpty {
            guard current(session) else { return }
            let trust = familyBook.capture(groupId)
            let nodes = group.map(\.node)
            guard let verdicts = try? await inFamily(session, { await $0.verdicts(of: nodes, groupId: groupId) }) else { continue }
            guard current(session) else { return }
            familyBook.publish(groupId, trust: trust, zip(group, verdicts).map { ($0.ref, $0.node, $1) })
        }
    }

    /* Every family mark judged again (a sync accepted, pins or identities changed): what is on screen now, under a new trust generation. */
    func rejudgeFamilies(_ groupId: String? = nil, session: Session? = nil) async {
        guard let session = session ?? beginSession(), current(session) else { return }
        familyBook.moved(groupId)
        let shown = folders.values.flatMap { $0 }.filter { isFamily($0) }
        await judgeFamilyItems(shown, session: session)
    }

    /*
     * Route 2, then every family checked on this phone. Opening Account again within a minute
     * reuses what the last pass found; pulling to refresh always checks. A server without
     * families shows none.
     */
    func refreshFamilies(force: Bool = false, session: Session? = nil) async {
        guard let session = session ?? beginSession(), current(session) else { return }
        if !force, let at = familiesSyncedAt, Date().timeIntervalSince(at) < 60, familyList != nil { return }
        do {
            // A family this phone holds that the list no longer names is asked about, and wiped only on the server's
            // not-member, so an open family page or folder leaves at once rather than at the next launch.
            guard let (list, gone, unsaved) = try await inFamily(session, { try await $0.listReconciling() }) else { return }
            for summary in list { familyNames[summary.id] = summary.name }
            familyList = list
            familiesServed = true
            familiesSyncedAt = Date()
            for groupId in gone { removed(groupId) }
            for (groupId, words) in unsaved { couldntRemove(groupId, words) }
            for summary in list {
                guard current(session) else { return }
                await refreshFamily(summary, session: session)
            }
        } catch let error as GroupsAPIError where error.status == 404 || error.status == 501 {
            familyList = nil
            familiesServed = false
        } catch {
            // No answer: what was shown stays.
        }
    }

    /*
     * One family checked again, and who route 3 names in it. Skipped while a join screen is open
     * for it (that screen checks it), unless the join screen itself asks (`fromJoin`).
     */
    func refreshFamily(_ summary: GroupSummary, fromJoin: Bool = false, session: Session? = nil) async {
        guard let session = session ?? beginSession(), current(session) else { return }
        guard !familySyncing.contains(summary.id), fromJoin || familyJoining[summary.id] == nil else { return }
        familySyncing.insert(summary.id)
        // A reset cleared it already; the next session may be checking the same family by now.
        defer { if current(session) { familySyncing.remove(summary.id) } }
        let previous = familyStates[summary.id]
        guard let (revised, ended) = try? await inFamily(session, { sync in (await sync.syncRevised(summary), await sync.takeEnded()) }) else { return }
        // A 401 the sync met is any request's: the app asks whether the session ended.
        if let ended { report(ended) }
        await show(revised.state, of: summary, previous: previous, revision: revised.revision, session: session)
    }

    /*
     * A join that finished on the join screen: the family as its acceptance left it, shown as a
     * sync's would be, with route 2 read again so the row says it is in (no second acceptance).
     */
    /* `revision`: the join's, taken in the family's turn: a fork or removal found since by a check or sync is never covered. */
    func joined(_ groupId: String, _ state: FamilyState, revision: UInt64? = nil, session: Session? = nil) async {
        guard let session = session ?? beginSession(), current(session) else { return }
        // Dropped (the session it began in ended) is not "no list": nothing of the old session is shown in the new one.
        guard let listed = await sessionGate.run(session, { vault -> [GroupSummary]? in try await FamilySync.shared(for: vault)?.list() }) else { return }
        if let list = (try? listed.get()) ?? nil {
            familyList = list
            familiesSyncedAt = Date()
        }
        guard current(session) else { return }
        guard let summary = familyList?.first(where: { $0.id == groupId }) else {
            if publishFamily(state, of: groupId, revision: revision) { familyBook.moved(groupId) }
            return
        }
        await show(state, of: summary, previous: familyStates[groupId], revision: revision, session: session)
    }

    /*
     * A sync's outcome a screen ran itself (Check it's Sam's "Getting the latest"), shown as any
     * sync's is when it is a later look at the family than what is shown (its revision, taken inside
     * the family's turn): a check queued behind a refresh shows what it found after it, a refusal as
     * much as a fork or a removal, and an older answer of any kind never covers a newer one.
     */
    func adopt(_ state: FamilyState, of summary: GroupSummary, revision: UInt64?, session: Session) async {
        guard current(session) else { return }
        await show(state, of: summary, previous: familyStates[summary.id], revision: revision, session: session)
    }

    /*
     * Every family state shown goes through here, so each publication is counted (`familyGenerations`)
     * and ordered (`familyRevisions`): false, and nothing shown, when what is shown is a later look.
     * Without a revision (a join, a removal the list found) it is the latest now.
     */
    @discardableResult
    func publishFamily(_ state: FamilyState, of groupId: String, revision: UInt64? = nil) -> Bool {
        guard familyRevisions.admits(revision, of: groupId) else { return false }
        familyStates[groupId] = state
        familyGenerations.published(groupId)
        return true
    }

    /*
     * A member check and a refresh can show the same family at once: after every suspension this
     * goes on only while its publication is still the latest (`stillShown`), so an older result
     * never clears, deletes or redraws over a newer one.
     */
    private func show(_ state: FamilyState, of summary: GroupSummary, previous: FamilyState?, revision: UInt64? = nil, session: Session) async {
        guard current(session), publishFamily(state, of: summary.id, revision: revision) else { return }
        let shownAs = familyGenerations.current(summary.id)
        func stillShown() -> Bool { current(session) && familyGenerations.current(summary.id) == shownAs }
        familyCheckedAt[summary.id] = Date()
        // Moved once this showing is done, its folders listed again (or a newer showing took over): a family page reads its
        // labels again on it, and a viewer whose file failed while the family wasn't open asks again.
        defer { familyRefreshed[summary.id, default: 0] += 1 }
        // Every family sync that found something moves its trust generation: a judgement from before it never publishes
        // after it. No answer says nothing new, so the marks already judged stay (the rows are still shown, read only).
        if FamilyVerdictBook.moves(after: state) { familyBook.moved(summary.id) }
        guard let areas = try? await inFamily(session, { await $0.familyAreas() }) else { return }
        // Rows a proof or a forget let go of with their workspace (a share's, kept or opened before): off the screens, with
        // their pictures.
        if let gone = try? await inSession(session, { await $0.takeEvicted() }), !gone.isEmpty {
            for id in gone { thumbnails[id] = nil }
            dropRows(gone)
            offlineVersion += 1
        }
        // Which folders are family folders is only ever learned, never undone: kept whoever shows the family now.
        for (area, groupId) in areas { familyAreaGroups[area] = groupId }
        guard stillShown() else { return }
        if case .accepted(let view) = state {
            familyShown[summary.id] = view
            for root in view.areas.compactMap({ $0.root?.id.lowercased() }) { familyRoots[root] = summary.id }
            let groupId = summary.id
            guard let detail = await sessionGate.run(session, { await FamilySync.shared(for: $0)?.detail(groupId) }), stillShown() else { return }
            familyDetails[summary.id] = (try? detail.get()) ?? nil
            // Listed again, not only judged again: a walk since may have re-keyed every row on screen.
            let areas = Set(familyAreaGroups.filter { $0.value == summary.id }.map(\.key))
            let roots = Set(view.areas.compactMap { $0.root?.id })
            let shown = folders.filter { id, items in roots.contains(id) || items.contains { areas.contains($0.node.workspaceId.lowercased()) } }.map(\.key)
            for id in shown {
                guard stillShown() else { return }
                await refresh(folder: id, session: session)
            }
            // Folders a refusal or fork took off screen open again now.
            for (id, problem) in folderProblems where familyGroup(ofFolder: id) == summary.id {
                guard stillShown() else { return }
                if case .family = problem { await refresh(folder: id, session: session) } else if problem == .removed { await refresh(folder: id, session: session) }
            }
            guard stillShown() else { return }
            await rejudgeFamilies(summary.id, session: session)
        } else if case .failed(let message) = state, message == FamilyWords.noAnswer {
            // No answer: what this phone opened before stays on screen, read only.
        } else {
            var roots: [String] = []
            if case .accepted(let view)? = previous { roots = view.areas.compactMap { $0.root?.id } }
            clearFamily(summary.id, roots: roots, details: state == .wiped,
                        problem: state == .wiped ? .removed : .family(FamilyWords.openAgain))
            // Removed from the family: what was queued into its folders fails now, its plaintext removed.
            if state == .wiped { BackgroundTransfers.shared.endFamily(summary.id) }
        }
    }

    /*
     * A family the server says this account is no longer in, found while it wasn't listed: shown as
     * a sync's `.wiped` is (the page says so in the web's words), everything drawn of it dropped, its
     * queued uploads failed and their plaintext removed. Its folders on screen say the web's words.
     */
    func removed(_ groupId: String) {
        var roots: [String] = []
        if case .accepted(let view)? = familyStates[groupId] { roots = view.areas.compactMap { $0.root?.id } }
        roots += familyRoots.filter { $0.value == groupId }.map(\.key)
        publishFamily(.wiped, of: groupId)
        familyCheckedAt[groupId] = Date()
        clearFamily(groupId, roots: roots, details: true, problem: .removed)
        BackgroundTransfers.shared.endFamily(groupId)
    }

    /*
     * A family the server says this account is no longer in, whose wipe waits for the guard it hands
     * back to be stored: shown as a sync's failed wipe is (the storage words), nothing of it left open
     * here, and its device record and guard kept, so the next pass asks again.
     */
    func couldntRemove(_ groupId: String, _ words: String) {
        var roots: [String] = []
        if case .accepted(let view)? = familyStates[groupId] { roots = view.areas.compactMap { $0.root?.id } }
        roots += familyRoots.filter { $0.value == groupId }.map(\.key)
        publishFamily(.failed(words), of: groupId)
        familyCheckedAt[groupId] = Date()
        clearFamily(groupId, roots: roots, details: false)
    }

    /*
     * What this phone drew and decrypted of a family that isn't accepted now (the web's
     * deleteMirrors): its folders' lists, names, thumbnails and marks, and the plaintext copies
     * opened from them. The folders stay family folders, read only, for the session.
     */
    func clearFamily(_ groupId: String, roots: [String], details: Bool, problem: FolderProblem = .family(FamilyWords.openAgain)) {
        let areas = Set(familyAreaGroups.filter { $0.value == groupId }.map(\.key))
        guard !areas.isEmpty else { return }
        var ids: Set<String> = []
        var folderIds = Set(roots)
        for (folderId, items) in folders {
            let family = items.filter { areas.contains($0.node.workspaceId.lowercased()) }
            ids.formUnion(family.map(\.id))
            folderIds.formUnion(family.filter(\.isFolder).map(\.id))
            if !family.isEmpty { ids.insert(folderId); folderIds.insert(folderId) }
        }
        ids.formUnion(roots)
        // Folders an earlier clear already dropped (a refusal, a fork) are still this family's, and are said anew.
        let cleared = familyFolders.filter { $0.value == groupId }.map(\.key)
        folderIds.formUnion(cleared)
        ids.formUnion(cleared)
        // Their rows go below; which family each folder was in stays, for the removal to stay said on a
        // refresh. Folders only: a file kept here would be asked for as a folder by every later recovery.
        for id in folderIds { familyFolders[id.lowercased()] = groupId }
        for id in ids {
            folders[id] = nil
            // Said in the folder's place, never as an empty folder.
            folderProblems[id] = problem
            names[id] = nil
            thumbnails[id] = nil
            try? FileManager.default.removeItem(at: FileManager.default.temporaryDirectory.appendingPathComponent("opened/own/\(id)", isDirectory: true))
        }
        // Every opened copy of the family's folders, those this session never listed included: never once this session ended.
        TemporaryCopies.forgetFamily(Array(areas), session: vault.copySession)
        // A listing of its folders that is out now never undoes this clear.
        familyListings.cleared(groupId)
        familyBook.moved(groupId)
        familyShown[groupId] = nil
        if details { familyDetails[groupId] = nil }
    }

    /* Which family a folder on screen belongs to: a top folder by route 25, anything else by its workspace. */
    func familyGroup(ofFolder id: String) -> String? {
        if let group = familyRoots[id.lowercased()] ?? familyFolders[id.lowercased()] { return group }
        return known(id).flatMap { familyAreaGroups[$0.node.workspaceId.lowercased()] }
    }

    /* A folder listed, and the folders in it, kept against their family for the session (see `familyFolders`). */
    func noteFamilyFolders(_ id: String, children: [Opened]) {
        if let groupId = familyGroup(ofFolder: id) { familyFolders[id.lowercased()] = groupId }
        for child in children where child.node.isFolder {
            if let groupId = familyAreaGroups[child.node.workspaceId.lowercased()] { familyFolders[child.id.lowercased()] = groupId }
        }
    }

    /* A family folder on screen checks its family again when the last check is older than `maxAge`. */
    func refreshFamilyIfStale(folder id: String, maxAge: TimeInterval, session: Session? = nil) async {
        guard let groupId = familyGroup(ofFolder: id), let summary = familyList?.first(where: { $0.id == groupId }) else { return }
        if let at = familyCheckedAt[groupId], Date().timeIntervalSince(at) < maxAge { return }
        await refreshFamily(summary, session: session)
    }

    /* Check it's <name> for someone in a family, as its page opens it (Info's "Added by" on a first-seen writer). */
    struct FamilyMemberCheck: Identifiable {
        let check: MemberCheck
        let summary: GroupSummary
        let me: String
        let organizer: String?
        var id: String { check.id }
    }

    /* Nil when they aren't in the family's accepted member list now, or the family isn't listed: their own check instead. */
    func memberCheck(groupId: String, userId: String) -> FamilyMemberCheck? {
        guard let summary = familyList?.first(where: { $0.id == groupId }) else { return nil }
        let view: FamilyView? = if case .accepted(let accepted)? = familyStates[groupId] { accepted } else { familyShown[groupId] }
        guard let view, view.members.contains(where: { $0.userId.lowercased() == userId.lowercased() }) else { return nil }
        let me = vault.api.session.userId.lowercased()
        let named = familyDetails[groupId]?.members.filter { $0.state == "active" } ?? []
        func served(_ id: String) -> GroupDetail.Member? { named.first { $0.userId.lowercased() == id.lowercased() } }
        let who = served(userId)
        let organizer = view.members.first { $0.roles.contains("billing") && $0.userId.lowercased() != me }.flatMap { served($0.userId) }.map { HushOS.firstName($0.name) }
        return FamilyMemberCheck(check: MemberCheck(member: FamilyMemberRef(userId: userId, email: who?.email ?? "", name: who?.name ?? "Someone"), personal: false),
                                 summary: summary, me: served(me).map { HushOS.firstName($0.name) } ?? "you", organizer: organizer)
    }

    /* Try again on a family folder that couldn't be opened: the family checked again, then the folder, in one session. */
    func reopenFamilyFolder(_ id: String) async {
        guard let session = beginSession() else { return }
        if let groupId = familyGroup(ofFolder: id), let summary = familyList?.first(where: { $0.id == groupId }) {
            await refreshFamily(summary, session: session)
        }
        guard current(session) else { return }
        await refresh(folder: id, session: session)
    }

    /* How a member reads in a list: the roles in words, never colour alone (the web's rolesLine). */
    static func rolesLine(_ roles: [String]) -> String {
        let organizer = roles.contains("billing")
        let manages = roles.contains("members")
        if organizer && manages { return "Organizer · Manages the family" }
        if organizer { return "Organizer" }
        if manages { return "Manages the family" }
        return "Member"
    }
}

/*
 * Where Account's stack goes in a family: its page, then a family folder. Pushed by value, as a
 * family folder's own rows push their subfolders (`Opened`): a value link in a view pushed with
 * NavigationLink(destination:) pops that view instead of pushing, so a family folder's
 * subfolders never opened. AccountView declares the destinations at the stack's root.
 */
enum FamilyRoute: Hashable {
    case family(String)
    case folder(String, String)
}

/* Account's Families: one row per family, as the web's list draws it. Absent on a server without families, or with none. */
struct FamiliesSection: View {
    @Environment(DriveStore.self) private var store

    var body: some View {
        if let list = store.familyList, !list.isEmpty {
            Section {
                ForEach(list) { family in
                    NavigationLink(value: FamilyRoute.family(family.id)) { FamilyRow(family: family) }
                        .alpineRow()
                }
            } header: {
                Text("Families").font(Theme.Text.label).foregroundStyle(Alpine.inkMuted)
            }
        }
    }
}

private struct FamilyRow: View {
    @Environment(DriveStore.self) private var store
    let family: GroupSummary

    var body: some View {
        HStack(spacing: Alpine.Space.s3) {
            PersonAvatar(name: family.name, seed: family.id)
            VStack(alignment: .leading, spacing: 2) {
                Text(family.name).foregroundStyle(Alpine.ink).lineLimit(1)
                Text(family.state == "accepted" ? "Waiting to join" : DriveStore.rolesLine(family.roles))
                    .font(Theme.Text.footnote).foregroundStyle(Alpine.inkMuted).lineLimit(1)
            }
            Spacer(minLength: 0)
            switch store.familyStates[family.id] {
            case .fork: StateBadge(text: "Shown differently", danger: true)
            case .failed: StateBadge(text: "Couldn’t check", danger: false)
            default: EmptyView()
            }
        }
        .frame(minHeight: Theme.row - 12)
        .contentShape(Rectangle())
    }
}

/*
 * The hard warning (docs/optional-verification.md 6.11, the web's ForkAlert): the family's member
 * list was shown differently to this person. Calm words in the warning colours, never the danger
 * ones, with both sides under Technical details.
 */
struct FamilyForkSection: View {
    let name: String
    let fork: FamilyFork
    /* The organizer's first name, when it is someone else: who to tell. */
    var organizer: String? = nil

    var body: some View {
        Section {
            VStack(alignment: .leading, spacing: Alpine.Space.s2) {
                Label("\(name) looks different on this device", systemImage: "exclamationmark.triangle")
                    .font(Theme.Text.headline).foregroundStyle(Alpine.warning)
                Text("HushOS has paused changes to the family here. Let \(organizer ?? "the others") know, and check each other from the family page.")
                    .font(Theme.Text.callout).foregroundStyle(Alpine.ink)
            }
            .padding(.vertical, Alpine.Space.s1)
            .listRowBackground(Alpine.warningSoft)
            DisclosureGroup("Technical details") {
                fact(fork.memberList ? "Member list version" : "Family key version", String(fork.version))
                ForEach(fork.sides, id: \.digest) { side in
                    VStack(alignment: .leading, spacing: 2) {
                        Text("From \(side.from.joined(separator: ", "))").font(Theme.Text.footnote).foregroundStyle(Alpine.inkMuted)
                        Text(side.digest).font(.footnote.monospaced()).foregroundStyle(Alpine.ink).textSelection(.enabled)
                    }
                }
            }
            .tint(Alpine.ink)
            .listRowBackground(Alpine.warningSoft)
        }
    }

    private func fact(_ label: String, _ value: String) -> some View {
        HStack {
            Text(label).foregroundStyle(Alpine.inkMuted)
            Spacer()
            Text(value).monospacedDigit().foregroundStyle(Alpine.ink)
        }
    }
}

/* A status in words on its soft fill, drawn as the Unverified mark is: never colour alone. */
private struct StateBadge: View {
    let text: String
    let danger: Bool

    var body: some View {
        HStack(spacing: 3) {
            Image(systemName: danger ? "exclamationmark.triangle" : "exclamationmark.shield").accessibilityHidden(true)
            Text(text)
        }
        .font(Theme.Text.footnote.weight(.semibold))
        .foregroundStyle(danger ? Alpine.danger : Alpine.warning)
        .lineLimit(1)
        .fixedSize()
        .padding(.horizontal, 6).padding(.vertical, 2)
        .background(danger ? Alpine.dangerSoft : Alpine.warningSoft, in: RoundedRectangle(cornerRadius: Alpine.Radius.chip, style: .continuous))
    }
}

/*
 * One family: what its check on this phone found (the hard warning, Couldn't check, not in it
 * any more), its folders, who is in it with their roles, and the member list's technical
 * details. Nothing here changes the family: managing it is on the web for now.
 */
struct FamilyPage: View {
    @Environment(DriveStore.self) private var store
    @Environment(\.dismiss) private var dismiss
    let groupId: String

    private var summary: GroupSummary? { store.familyList?.first { $0.id == groupId } }
    /* Its name as route 2 last named it: a family it no longer lists (a removal) keeps its name on the page that says so. */
    private var name: String { summary?.name ?? store.familyNames[groupId] ?? "Family" }
    private var state: FamilyState? { store.familyStates[groupId] }
    private var view: Accepted? {
        if case .accepted(let view) = state { return view }
        // No answer at all: what was accepted last is still what this phone holds open, read only.
        if case .failed(let message) = state, message == FamilyWords.noAnswer { return store.familyShown[groupId] }
        return nil
    }

    typealias Accepted = HushOSKit.FamilyView

    private var joining: Bool { state == .waiting || state == .unchecked }

    /* Who this person checked in the family, on this phone (3.8), as read for one member list and trust load: nil until read, or when it couldn't be (no labels then). */
    @State private var labels: MemberLabels?
    /* Whom this person's family check was with: their own words check them once their keys changed since (6.10). */
    @State private var checkedWith: String?
    /* Moved after every check, so the labels are read again. */
    @State private var checks = 0
    @State private var checking: MemberCheck?
    /* "Waiting for Sam" while the join below waits: the page's title, as the web's. */
    @State private var waitTitle: String?

    private var me: String { store.vault.api.session.userId.lowercased() }
    private var named: [GroupDetail.Member] { store.familyDetails[groupId]?.members.filter { $0.state == "active" } ?? [] }

    private func served(_ userId: String) -> GroupDetail.Member? { named.first { $0.userId.lowercased() == userId.lowercased() } }

    /* The organizer's first name, when it is someone else. */
    private var organizer: String? {
        guard let view, let entry = view.members.first(where: { $0.roles.contains("billing") && $0.userId.lowercased() != me }),
              let member = served(entry.userId) else { return nil }
        return firstName(member.name)
    }

    var body: some View {
        List {
            if joining {
                // Accepted but not let in, or let in with nothing on this phone or account checking the family yet:
                // the join screen is where that goes on (the web's family page redirects to it too).
                JoinSections(groupId: groupId, family: name, title: { waitTitle = $0 })
            } else if let view {
                alerts
                folders(view)
                members(view)
                technical(view)
            } else if state == nil || store.familySyncing.contains(groupId) {
                alerts
                Section { ProgressView().frame(maxWidth: .infinity).padding(.vertical, Alpine.Space.s4).bareRow() }
            } else {
                alerts
            }
        }
        .listStyle(.insetGrouped)
        .alpineGrouped()
        .listSectionSpacing(Alpine.Space.s4)
        .screenChrome(title: joining ? (waitTitle ?? "Join \(name)") : name)
        .refreshable { await store.refreshFamilies(force: true) }
        .task {
            if store.familyList == nil { await store.refreshFamilies() } else if let summary { await store.refreshFamily(summary) }
        }
        // The labels are read again after every finished check of the family (pull to refresh included), every trust
        // reload and every check made here: a pin changed on another device never leaves someone shown Verified.
        .task(id: "\(view?.rosterDigest ?? "")-\(checks)-\(store.familyRefreshed[groupId] ?? 0)-\(store.trustGeneration)") {
            guard let view else { return }
            let trust = store.trustGeneration
            let groupId = groupId
            guard let session = store.beginSession() else { return }
            let read = (try? await store.inFamily(session, { try await $0.memberStandings(view) })).map { MemberLabels($0, of: view, trust: trust) }
            let with = (try? await store.inFamily(session, { await $0.checkedFamilyWith(groupId) })) ?? nil
            // A newer read began (the list, a check or trust moved) or the session ended: an older read never lands last.
            guard !Task.isCancelled, store.current(session) else { return }
            labels = read
            checkedWith = with
        }
        .sheet(item: $checking) { check in
            if let summary {
                MemberCheckSheet(check: check, summary: summary, me: served(me).map { HushOS.firstName($0.name) } ?? "you", organizer: organizer,
                                 checked: { checks += 1; Task { await store.refreshSigners(); await store.rejudgeFamilies(groupId) } },
                                 done: { checking = nil })
                    .environment(store)
            }
        }
    }

    @ViewBuilder private var alerts: some View {
        switch state {
        case .fork(let fork):
            FamilyForkSection(name: name, fork: fork, organizer: organizer)
        case .failed(let message):
            notice(title: "Couldn’t check \(name)", message: message, danger: false) {
                // A family route 2 no longer lists (a removal that couldn't be saved yet) is asked about by listing again.
                Button("Try again") { Task { if let summary { await store.refreshFamily(summary) } else { await store.refreshFamilies(force: true) } } }
                    .font(Theme.Text.callout.weight(.semibold)).foregroundStyle(Alpine.primary)
            }
        case .wiped:
            notice(title: "You’re not in \(name) any more", message: "What this device kept of the family has been cleared.", danger: false) { EmptyView() }
        case .unchecked, .waiting:
            // The join screen takes the page's place (body).
            EmptyView()
        case .accepted(let view):
            if view.ownEntryWrong {
                // The web's words (family-page.tsx), in the warning colours.
                notice(title: "\(name) has your account wrong on this device", message: "Ask someone who manages the family to check it’s you, from the family’s page.",
                       danger: false) { EmptyView() }
            }
            if !view.ownEntryWrong && view.ownEntryBehind {
                Section {
                    Text("\(name) still has your account as it was before you updated it. A manager’s device catches up the next time they open the family.")
                        .font(Theme.Text.callout).foregroundStyle(Alpine.ink).listRowBackground(Alpine.tint)
                }
            }
            ForEach(view.foreign, id: \.owner) { notice in
                self.notice(title: notice.title(family: name),
                            message: notice.body(family: name) { owner in store.familyList?.first { $0.id == owner }?.name },
                            danger: false) { EmptyView() }
            }
            if view.recordReset {
                Section {
                    Text("This device’s saved check of \(name) couldn’t be opened, so HushOS checked the family again from the start.")
                        .font(Theme.Text.callout).foregroundStyle(Alpine.ink).listRowBackground(Alpine.tint)
                }
            }
        case nil:
            EmptyView()
        }
    }

    private func notice<Action: View>(title: String, message: String?, danger: Bool, @ViewBuilder action: () -> Action) -> some View {
        Section {
            VStack(alignment: .leading, spacing: Alpine.Space.s2) {
                Label(title, systemImage: danger ? "exclamationmark.triangle.fill" : "exclamationmark.circle")
                    .font(Theme.Text.headline).foregroundStyle(danger ? Alpine.danger : Alpine.warning)
                if let message { Text(message).font(Theme.Text.callout).foregroundStyle(Alpine.ink) }
                action()
            }
            .padding(.vertical, Alpine.Space.s1)
            .listRowBackground(danger ? Alpine.dangerSoft : Alpine.warningSoft)
        }
    }

    @ViewBuilder private func folders(_ view: Accepted) -> some View {
        Section {
            if view.areas.isEmpty {
                VStack(alignment: .leading, spacing: 2) {
                    Text("No family folders yet").foregroundStyle(Alpine.ink)
                    Text("Someone who manages the family can make one.").font(Theme.Text.footnote).foregroundStyle(Alpine.inkMuted)
                }
                .frame(minHeight: Theme.row - 12, alignment: .leading)
                .alpineRow()
            }
            ForEach(view.areas.sorted { ($0.name ?? "").localizedStandardCompare($1.name ?? "") == .orderedAscending }) { area in
                if area.openable, let root = area.root {
                    NavigationLink(value: FamilyRoute.folder(root.id, area.name ?? "Family folder")) { folderRow(area) }
                        .itemRow()
                } else {
                    folderRow(area).itemRow()
                }
            }
        } header: {
            Text("Family folders").font(Theme.Text.label).foregroundStyle(Alpine.inkMuted)
        }
    }

    private func folderRow(_ area: FamilyArea) -> some View {
        HStack(spacing: Alpine.Space.s3) {
            FolderGlyph().frame(width: Theme.mark, height: Theme.mark * 46 / 56).frame(width: Theme.mark, height: Theme.mark).accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 2) {
                Text(area.name ?? "Family folder").font(Theme.Text.headline).foregroundStyle(Alpine.ink).lineLimit(1)
                Text(area.line).font(Theme.Text.footnote).foregroundStyle(Alpine.inkMuted).lineLimit(2)
            }
            Spacer(minLength: 0)
        }
        .frame(minHeight: Theme.row)
        .contentShape(Rectangle())
    }

    @ViewBuilder private func members(_ view: Accepted) -> some View {
        Section {
            // The member list this phone accepted says who is in the family and with what roles; route 3 gives the names.
            ForEach(view.members) { member in
                if member.userId.lowercased() == me {
                    memberRow(member, you: true).alpineRow()
                } else {
                    let standing = label(member, in: view)
                    let who = served(member.userId)
                    let ref = FamilyMemberRef(userId: member.userId, email: who?.email ?? "", name: who?.name ?? "Someone")
                    Menu {
                        Button(standing == .verified ? "Check again" : "Check it’s \(firstName(ref.name))", systemImage: "checkmark.shield") {
                            // An account that changed, or a family check over keys that changed since: their own twelve words (6.10).
                            let personal = standing == .changed || (checkedWith?.lowercased() == member.userId.lowercased() && standing != .verified)
                            checking = MemberCheck(member: ref, personal: personal)
                        }
                        .disabled(ref.email.isEmpty)
                    } label: {
                        memberRow(member, you: false)
                    }
                    .accessibilityLabel("More for \(ref.name)")
                    .alpineRow()
                }
            }
        } header: {
            Text("Members").font(Theme.Text.label).foregroundStyle(Alpine.inkMuted)
        }
    }

    /* A member's label as the list on screen and the trust loaded now stand: none while it is read again (MemberLabels). */
    private func label(_ member: FamilyMember, in view: Accepted) -> MemberStanding? {
        labels?.label(of: member, in: view, trust: store.trustGeneration)
    }

    private func memberRow(_ member: FamilyMember, you: Bool) -> some View {
        let served = served(member.userId)
        let name = served?.name ?? "Someone"
        let standing = view.flatMap { label(member, in: $0) }
        return HStack(spacing: Alpine.Space.s3) {
            PersonAvatar(name: name, seed: member.userId)
            VStack(alignment: .leading, spacing: 2) {
                Text(you ? "\(name) (you)" : name).foregroundStyle(Alpine.ink).lineLimit(1)
                if let email = served?.email, !email.isEmpty {
                    Text(email).font(Theme.Text.footnote).foregroundStyle(Alpine.inkMuted).lineLimit(1)
                }
                Text(DriveStore.rolesLine(member.roles)).font(Theme.Text.footnote).foregroundStyle(Alpine.inkMuted)
                if standing == .changed {
                    Text("Account changed").font(Theme.Text.footnote).foregroundStyle(Alpine.inkMuted)
                }
            }
            Spacer(minLength: 0)
            if !you, let standing, standing != .changed { VerifiedLabel(verified: standing == .verified) }
        }
        .padding(.vertical, Alpine.Space.s1)
        .frame(minHeight: Theme.row)
        .contentShape(Rectangle())
        .accessibilityElement(children: .combine)
    }

    private func technical(_ view: Accepted) -> some View {
        Section {
            DisclosureGroup("Technical details") {
                fact("Member list version", String(view.rosterVersion))
                VStack(alignment: .leading, spacing: 2) {
                    Text("Member list digest").foregroundStyle(Alpine.inkMuted)
                    Text(view.rosterDigest).font(.footnote.monospaced()).foregroundStyle(Alpine.ink).textSelection(.enabled)
                }
                fact("Family key version", String(view.groupKeyVersion))
                fact("Family folders", String(view.areas.count))
            }
            .tint(Alpine.ink)
            .alpineRow()
        }
    }

    private func fact(_ label: String, _ value: String) -> some View {
        HStack {
            Text(label).foregroundStyle(Alpine.inkMuted)
            Spacer()
            Text(value).monospacedDigit().foregroundStyle(Alpine.ink)
        }
    }
}
