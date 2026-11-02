import HushOSKit
import SwiftUI

/*
 * Check it's Sam, in a family (docs/optional-verification.md 3.4, 6.10; the web's
 * components/families/family-check.tsx, in its words): one comparison between two members. The
 * family is synced first ("Getting the latest"), then both screens show the same twelve words,
 * worked out from the member list that let the later of the two in and both accounts. They match
 * on each side writes that side's records; They don't match writes nothing. A phone whose own
 * entry was wrong at that list shows no words and leads to Sam's own twelve words instead.
 */

/* Whom a member row's check is with, and whether it is their own twelve words (an account changed, or a family check over keys since changed). */
struct MemberCheck: Identifiable, Hashable {
    let member: FamilyMemberRef
    let personal: Bool
    var id: String { member.userId + (personal ? "-words" : "-family") }
}

/* A member's check in a sheet of its own: it outlives the row it was started from. */
struct MemberCheckSheet: View {
    let check: MemberCheck
    let summary: GroupSummary
    let me: String
    let organizer: String?
    let checked: () -> Void
    let done: () -> Void

    var body: some View {
        NavigationStack {
            if check.personal {
                CheckContactView(email: check.member.email, name: check.member.name, resolved: checked, done: done)
            } else {
                FamilyCheckView(summary: summary, member: check.member, me: me, organizer: organizer, checked: checked, done: done)
            }
        }
    }
}

struct FamilyCheckView: View {
    @Environment(DriveStore.self) private var store
    let summary: GroupSummary
    let member: FamilyMemberRef
    /* This person's own first name, as the other screen names them. */
    let me: String
    /* Who to ask for help when the words differ: the organizer, or nil when it's this person. */
    let organizer: String?
    let checked: () -> Void
    let done: () -> Void

    private enum Stage { case words, mismatch }

    @State private var code: FamilyCheckCode?
    @State private var failure: String?
    @State private var stage = Stage.words
    @State private var saving = false
    /* The request a button began (They match, Try again): cancelled when the sheet goes, so nothing it answers shows or closes after. */
    @State private var working: Task<Void, Never>?
    @State private var error = ""
    @State private var ownWords = false

    private var who: String { firstName(member.name.isEmpty ? member.email : member.name) }
    private var family: String { summary.name }

    private var shown: (rosterVersion: UInt64, code: [String], rosterDigest: String?)? {
        if case .code(let version, let code, let digest) = code { return (version, code, digest) }
        return nil
    }

    var body: some View {
        List {
            Section {
                if stage == .mismatch {
                    let help = organizer.map { "ask \($0) to help" } ?? "contact support"
                    Text("These don’t match. Make sure you’re both in \(family), reload, and compare again. If they still don’t match, \(help).")
                        .font(Theme.Text.callout).foregroundStyle(Alpine.ink).alpineRow()
                } else if shown != nil {
                    Text("Ask \(who) to open \(family) and choose Check it’s \(me) beside your name. If the twelve words on both screens match, you’ve checked each other.")
                        .font(Theme.Text.callout).foregroundStyle(Alpine.inkMuted).alpineRow()
                }
                if let failure {
                    Text(failure).font(Theme.Text.callout).foregroundStyle(Alpine.danger).alpineRow()
                    Button("Try again") { run { await load() } }.alpineRow()
                } else if code == nil {
                    HStack(spacing: Alpine.Space.s2) { ProgressView(); Text("Getting the latest").foregroundStyle(Alpine.inkMuted) }.alpineRow()
                } else if code == .ownEntryWrong {
                    Text("This device can’t check the family with \(who). You can check \(who)’s own twelve words instead.")
                        .font(Theme.Text.callout).foregroundStyle(Alpine.ink).alpineRow()
                } else if code == .notAdmitted {
                    Text("\(who) isn’t in \(family) on this device yet. Try again in a moment.")
                        .font(Theme.Text.callout).foregroundStyle(Alpine.inkMuted).alpineRow()
                } else if let shown, stage == .words {
                    WordGrid(words: shown.code).padding(.vertical, Alpine.Space.s2).alpineRow()
                    TechnicalDetails {
                        Text("These words are worked out from the family’s member list as it was when \(who) joined, and from your two accounts. When they match, your devices see the same family, and each confirms the other’s keys.")
                        HStack {
                            Text("Member list version")
                            Spacer()
                            Text(String(shown.rosterVersion)).monospacedDigit()
                        }
                        if let digest = shown.rosterDigest {
                            VStack(alignment: .leading, spacing: 2) {
                                Text("Member list digest")
                                Text(digest).font(.footnote.monospaced()).textSelection(.enabled)
                            }
                        }
                    }
                    .alpineRow()
                }
            }
            if !error.isEmpty { Text(error).font(Theme.Text.footnote).foregroundStyle(Alpine.danger).alpineRow() }
            if code == .ownEntryWrong {
                Section {
                    Button { ownWords = true } label: { Text("Check \(who)’s words").frame(maxWidth: .infinity) }.buttonStyle(PrimaryCapsuleStyle())
                }
                .listRowBackground(Color.clear).listRowInsets(EdgeInsets())
            } else if let shown, stage == .words {
                Section {
                    VStack(spacing: Alpine.Space.s2) {
                        Button { match(shown.rosterVersion, shown.code) } label: { Text(saving ? "Saving…" : "They match").frame(maxWidth: .infinity) }
                            .buttonStyle(PrimaryCapsuleStyle()).disabled(saving)
                        Button { stage = .mismatch } label: { Text("They don’t match").frame(maxWidth: .infinity) }
                            .buttonStyle(SecondaryCapsuleStyle()).disabled(saving)
                    }
                }
                .listRowBackground(Color.clear).listRowInsets(EdgeInsets())
            }
        }
        .listStyle(.insetGrouped)
        .alpineGrouped()
        .navigationTitle("Check it’s \(who)")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done", action: done).disabled(saving) } }
        // Their own twelve words, in this sheet's place.
        .navigationDestination(isPresented: $ownWords) {
            CheckContactView(email: member.email, name: member.name, resolved: checked, done: done)
        }
        .interactiveDismissDisabled(saving)
        .task { await load() }
        .onDisappear { working?.cancel() }
    }

    /* A button's request, tied to the sheet: closed meanwhile, it shows and closes nothing. */
    private func run(_ request: @escaping @MainActor () async -> Void) {
        working?.cancel()
        working = Task { await request() }
    }

    private func load() async {
        // Closed already: nothing to load, show or close.
        guard !Task.isCancelled else { return }
        failure = nil
        code = nil
        do {
            // One session for the whole check: if it ends (a sign-out, the same account signed in again), nothing of it shows.
            guard let session = store.beginSession() else { done(); return }
            let (summary, memberId) = (summary, member.userId)
            // Nil: dropped, its session ended (the sheet closes) or the sheet closed already (nothing more to do).
            guard let start = try await store.inFamily(session, { try await $0.checkCode(summary, with: memberId) }) else {
                if !Task.isCancelled { done() }
                return
            }
            // The sync it ran is shown as after any sync (a warning, a refusal, a removal) when it is a later look than what is shown.
            await store.adopt(start.state, of: summary, revision: start.revision, session: session)
            guard !Task.isCancelled else { return }
            guard store.current(session) else { done(); return }
            // The family as it is shown now decides: words worked out over a chain it has since left don't show.
            if let problem = start.problem ?? FamilySync.checkProblem(store.familyStates[summary.id] ?? start.state) {
                failure = problem
            } else {
                code = start.code
            }
        } catch {
            if endsSession(error) { store.report(error); done(); return }
            failure = FamilyWords.error(error)
        }
    }

    private func match(_ rosterVersion: UInt64, _ words: [String]) {
        saving = true
        error = ""
        run {
            do {
                let (groupId, member) = (summary.id, member)
                // Nil: dropped with its session (the sheet closes), or the sheet closed already. A match saved meanwhile stays
                // saved; only nothing of it is said or closed from a closed sheet.
                guard let saved = try await store.inFamily(nil, { try await $0.checkMatch(groupId, member: member, rosterVersion: rosterVersion, code: words) }) else {
                    saving = false
                    if !Task.isCancelled { done() }
                    return
                }
                guard saved.checked else {
                    // The family moved on here since the words were shown: worked out again.
                    error = "The family changed meanwhile. Compare these words again."
                    saving = false
                    await load()
                    return
                }
                store.notify(saved.verified ? "You and \(who) checked each other" : "You and \(who) see the same family")
                // What this phone trusts moved: what is on screen is judged again now.
                Task { await store.refreshSigners(); await store.rejudgeFamilies(summary.id) }
                checked()
                done()
            } catch let removed as FamilyRemovedNow {
                // Removed meanwhile: the family shows what checkMatch's removal left, in its order (a later look stands). Wiped: out
                // of the family. Refused with the storage words (its guard couldn't be stored, nothing cleared): said with Try again.
                if let session = store.beginSession() {
                    await store.adopt(removed.removed.state, of: summary, revision: removed.removed.revision, session: session)
                }
                guard !Task.isCancelled else { return }
                if case .failed(let words) = removed.removed.state {
                    failure = words
                } else {
                    self.error = FamilyWords.notInFamily
                }
            } catch {
                if endsSession(error) { store.report(error); done(); return }
                self.error = ErrorWords.say(error, otherwise: "That wasn’t saved. Try again.") ?? ""
            }
            saving = false
        }
    }
}

/* Twelve words in two columns, numbered, for reading aloud (one column at the largest text sizes). */
struct WordGrid: View {
    let words: [String]
    @Environment(\.dynamicTypeSize) private var typeSize

    var body: some View {
        LazyVGrid(columns: Array(repeating: GridItem(.flexible()), count: typeSize.isAccessibilitySize ? 1 : 2), alignment: .leading, spacing: Alpine.Space.s2) {
            ForEach(words.indices, id: \.self) { index in
                HStack(spacing: 6) {
                    Text("\(index + 1)").font(.caption.monospacedDigit()).foregroundStyle(Alpine.inkMuted).frame(width: 18, alignment: .trailing)
                    Text(words[index]).font(.body.weight(.medium)).foregroundStyle(Alpine.ink)
                }
                .padding(.horizontal, Alpine.Space.s2).padding(.vertical, 6)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(Alpine.ground, in: RoundedRectangle(cornerRadius: Alpine.Radius.control))
            }
        }
        .accessibilityElement(children: .combine)
        .accessibilityLabel(words.joined(separator: ", "))
    }
}
