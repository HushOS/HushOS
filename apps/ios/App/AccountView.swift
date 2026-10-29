import HushOSKit
import SafariServices
import SwiftUI
import UIKit

/*
 * Account (DESIGN.md), its own tab by the user's call:
 * who is signed in, the plan with what fills the space, Trash, sign-in and
 * recovery, Advanced for the rare and heavy things, and Sign out last, away from
 * Delete. The app sells nothing and never points to where plans are bought
 * (App Review 3.1.3(f)): it shows the plan's name and storage, and the ways to
 * make room are Empty Trash and Remove earlier versions. A family member whose
 * files draw from the family's pool sees the family's plan and the pool's
 * figures (PlanDisplay, docs/families-shared-pool.md 9).
 */
struct AccountView: View {
    @Environment(AppModel.self) private var model
    @Environment(DriveStore.self) private var store
    @State private var allowance: StorageAllowance?
    @State private var billing: BillingSummary?
    @State private var breakdown: StorageBreakdown?
    @State private var changingPassword = false
    @State private var showingPhrase = false
    @State private var showingPeople = false
    @State private var showingWords = false
    @State private var signingOut = false
    @State private var showingTrash = false

    var body: some View {
        NavigationStack {
            List {
                Section {} header: {
                    VStack(alignment: .leading, spacing: Alpine.Space.s3) {
                        if store.offline { OfflineCapsule() }
                        profile
                    }
                    .textCase(nil)
                    .listRowInsets(EdgeInsets(top: Alpine.Space.s2, leading: 0, bottom: 0, trailing: 0))
                }
                Section {
                    NavigationLink { PlansView(allowance: allowance, billing: billing, breakdown: breakdown) { await load() }.environment(store) } label: { planCard }
                        .alpineRow()
                    NavigationLink { TrashView().environment(store) } label: {
                        row("trash", "Trash", trashSummary)
                    }
                    .alpineRow()
                } header: {
                    sectionLabel("Plan and storage")
                }
                FamiliesSection()
                Section {
                    Button { changingPassword = true } label: { row("key", "Change password", nil, chevron: true) }.alpineRow()
                    Button { showingPhrase = true } label: { row("scroll", "Recovery phrase", "Gets you back in if you forget your password", chevron: true) }.alpineRow()
                    NavigationLink { DevicesView().environment(store) } label: {
                        row("laptopcomputer.and.iphone", "Devices", "Where you’re signed in")
                    }
                    .alpineRow()
                    Button { showingPeople = true } label: { row("person.2", "Contacts", "Check it’s them before you share anything sensitive", chevron: true) }.alpineRow()
                    Button { showingWords = true } label: { row("person.text.rectangle", "Your twelve words", "Read these to someone checking it’s you", chevron: true) }.alpineRow()
                } header: {
                    sectionLabel("Sign-in and recovery")
                }
                Section {
                    NavigationLink { AdvancedView().environment(store).environment(model) } label: {
                        row("gearshape.2", "Advanced", "Sharing keys, account ID, server, delete account", muted: true)
                    }
                    .alpineRow()
                } footer: {
                    Text("HushOS is also a location in the Files app, for opening and saving files from other apps.")
                }
                Section {
                    Button { open(Auth.privacyURL(origin: model.origin)) } label: { row("hand.raised", "Privacy policy", nil, external: true) }.alpineRow()
                    Button { open(Auth.termsURL(origin: model.origin)) } label: { row("doc.text", "Terms", nil, external: true) }.alpineRow()
                } header: {
                    sectionLabel("About")
                }
                Section {
                    Button("Sign out", role: .destructive) { signingOut = true }.foregroundStyle(Alpine.danger).alpineRow()
                } footer: {
                    Text("HushOS \(Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "")")
                        .frame(maxWidth: .infinity, alignment: .center)
                }
            }
            .listStyle(.insetGrouped)
            .alpineGrouped()
            .listSectionSpacing(Alpine.Space.s4)
            .navigationTitle("Account")
            .screenChrome(title: "Account")
            .navigationDestination(isPresented: $showingTrash) { TrashView().environment(store) }
            // Families, a family folder and its subfolders, all pushed by value and declared at the stack's root (FamilyRoute).
            .navigationDestination(for: FamilyRoute.self) { route in
                switch route {
                case .family(let groupId): FamilyPage(groupId: groupId).environment(store)
                case .folder(let id, let title): FolderView(folderId: id, title: title).environment(store)
                }
            }
            .navigationDestination(for: Opened.self) { folder in FolderView(folderId: folder.id, title: folder.name).environment(store) }
            .sheet(isPresented: $changingPassword) { ChangePasswordSheet().environment(store) }
            .sheet(isPresented: $showingPhrase) { RecoveryPhraseSheet().environment(store) }
            .sheet(isPresented: $showingPeople) { PeopleView().environment(store) }
            #if DEBUG
            // Evidence runs: -HushOSPeople YES opens Contacts (DebugStart).
            .task { if DebugStart.people { showingPeople = true } }
            #endif
            .sheet(isPresented: $showingWords) { OwnWordsSheet().environment(store) }
            .alert("Sign out of HushOS?", isPresented: $signingOut) {
                Button("Cancel", role: .cancel) {}
                Button("Sign out", role: .destructive) { Task { await model.signOut() } }
            } message: {
                // Signing out removes the kept copies; say so only when there are some.
                Text("This iPhone leaves your list of devices, and you’ll need your email and password to sign back in on it." + (Offline.entries().isEmpty ? "" : " Files kept on this iPhone are removed."))
            }
            .onChange(of: store.route, initial: true) { _, link in
                if link == .trash {
                    store.route = nil
                    showingTrash = true
                }
            }
            .refreshable {
                await load()
                await store.refreshFamilies()
            }
            .task {
                await store.refreshTrash()
                await load()
                await store.refreshFamilies()
            }
        }
    }

    private func load() async {
        allowance = try? await Auth.storage()
        billing = try? await Auth.billing()
        breakdown = try? await store.vault.storageBreakdown()
    }

    private var profile: some View {
        VStack(spacing: Alpine.Space.s1) {
            PersonAvatar(name: model.user?.name.isEmpty == false ? model.user!.name : (model.user?.email ?? ""), seed: model.user?.id ?? "", size: 76)
            Text(model.user.map { $0.name.isEmpty ? "Signed in" : $0.name } ?? "Signed in").font(.title2.weight(.bold)).foregroundStyle(Alpine.ink).padding(.top, Alpine.Space.s2)
            if let email = model.user?.email, !email.isEmpty { Text(email).font(Theme.Text.callout).foregroundStyle(Alpine.inkMuted) }
            Button("Edit name") { editName() }
                .font(Theme.Text.callout.weight(.semibold)).foregroundStyle(Alpine.primary)
                .padding(.horizontal, Alpine.Space.s4).frame(minHeight: 36)
                .background(Alpine.ink.opacity(0.07), in: Capsule())
                .buttonStyle(.plain).padding(.top, Alpine.Space.s2)
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, Alpine.Space.s2)
    }

    private var plan: PlanDisplay { PlanDisplay(allowance: allowance, billing: billing) }

    /* The plan at a glance: its name, how full, when it renews or whose it is. The breakdown is one tap in. */
    private var planCard: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(alignment: .firstTextBaseline) {
                Text(plan.name).font(Theme.Text.headline).foregroundStyle(Alpine.ink)
                Spacer()
                if let allowance {
                    Text("\(formatSpace(allowance.used)) of \(formatQuota(allowance.quota))").font(Theme.Text.callout).foregroundStyle(Alpine.inkMuted)
                }
            }
            StorageMeter(used: allowance?.used ?? 0, quota: allowance?.quota ?? 1, simple: true, height: 6)
            Text(planLine).font(Theme.Text.footnote).foregroundStyle(plan.lineColour)
        }
        .padding(.vertical, Alpine.Space.s1)
    }

    private var planLine: String {
        if let source = plan.source { return "\(source) · Trash and earlier versions count too" }
        if let lapsed = plan.lapsed { return lapsed.line }
        guard let subscription = plan.subscription else { return "Trash and earlier versions count too" }
        if subscription.status == "past_due" { return "Payment overdue" }
        let date = parseDate(subscription.currentPeriodEnd).map { $0.formatted(.dateTime.day().month(.abbreviated).locale(.dayMonth)) } ?? ""
        return "\(subscription.cancelAtPeriodEnd ? "Ends" : "Renews") \(date) · Trash and earlier versions count too"
    }

    private var trashSummary: String {
        let roots = store.trash.filter { !$0.parentTrashed }
        guard !roots.isEmpty else { return "Empty · items stay 30 days" }
        let count = roots.count == 1 ? "1 item" : "\(roots.count) items"
        let size = store.trash.compactMap(\.item.size).reduce(0, +)
        return size > 0 ? "\(count) · \(formatBytes(Int64(size))) · removed after 30 days" : "\(count) · removed after 30 days"
    }

    private func sectionLabel(_ text: String) -> some View {
        Text(text).font(Theme.Text.label).foregroundStyle(Alpine.inkMuted)
    }

    private func open(_ url: URL?) { if let url { PolicyLinks.present(url) } }

    private func row(_ symbol: String, _ title: String, _ detail: String?, chevron: Bool = false, muted: Bool = false, external: Bool = false) -> some View {
        HStack(spacing: Alpine.Space.s3) {
            SettingsGlyph(symbol: symbol, muted: muted)
            VStack(alignment: .leading, spacing: 2) {
                Text(title).foregroundStyle(Alpine.ink)
                if let detail { Text(detail).font(Theme.Text.footnote).foregroundStyle(Alpine.inkMuted) }
            }
            Spacer(minLength: 0)
            if chevron { Image(systemName: "chevron.right").font(.footnote.weight(.semibold)).foregroundStyle(Alpine.inkMuted) }
            if external { Image(systemName: "arrow.up.right").font(.footnote.weight(.semibold)).foregroundStyle(Alpine.inkMuted) }
        }
        .contentShape(Rectangle())
    }

    private func editName() {
        TextPrompt.present(
            title: "Your name", message: "Shown to people you share with.", text: model.user?.name ?? "", placeholder: "Name", action: "Save", selectStem: false,
            validate: { $0.trimmingCharacters(in: .whitespaces).isEmpty ? "Enter a name." : nil }
        ) { name in
            Task {
                do {
                    model.setUser(try await Auth.updateName(name))
                    store.notify("Name saved")
                } catch {
                    if let words = ErrorWords.say(error) { store.notify(words) }
                }
            }
        }
    }
}

/* The board's settings glyph: a small tinted square, the way iOS Settings marks its rows. */
struct SettingsGlyph: View {
    let symbol: String
    var muted = false
    var danger = false

    var body: some View {
        Image(systemName: symbol).font(.system(size: 15, weight: .semibold))
            .foregroundStyle(danger ? Alpine.danger : muted ? Alpine.ink : Alpine.onTint)
            .frame(width: 30, height: 30)
            .background(danger ? Alpine.dangerSoft : muted ? Alpine.ink.opacity(0.07) : Alpine.tint, in: RoundedRectangle(cornerRadius: 9, style: .continuous))
            .accessibilityHidden(true)
    }
}

/* A meter, plain or split into files, earlier versions and trash. */
struct StorageMeter: View {
    var used: Int64
    var quota: Int64
    var versions: Int64 = 0
    var trash: Int64 = 0
    var simple = false
    var height: CGFloat = 10

    var body: some View {
        GeometryReader { geo in
            let total = Double(max(quota, 1))
            let width = geo.size.width
            let files = max(0, used - versions - trash)
            HStack(spacing: simple ? 0 : 2) {
                if simple {
                    Capsule().fill(Alpine.primary).frame(width: width * min(1, Double(used) / total))
                } else {
                    Rectangle().fill(Alpine.primary).frame(width: width * min(1, Double(files) / total))
                    Rectangle().fill(Alpine.primary.opacity(0.45)).frame(width: width * min(1, Double(versions) / total))
                    Rectangle().fill(Alpine.inkMuted).frame(width: width * min(1, Double(trash) / total))
                }
                Spacer(minLength: 0)
            }
            .frame(height: height)
            .background(Alpine.rule)
            .clipShape(Capsule())
        }
        .frame(height: height)
        .accessibilityElement()
        .accessibilityLabel("\(formatSpace(used)) of \(formatQuota(quota)) used")
    }
}

/* MARK: Plan and storage */

extension PlanDisplay {
    /* The plan's line: the danger colour while a payment is overdue or failed, ink while paused. */
    var lineColour: Color {
        if subscription?.status == "past_due" || lapsed?.paused == false { return Alpine.danger }
        return lapsed != nil ? Alpine.ink : Alpine.inkMuted
    }
}

/* What fills the space, not just a bar: trash and earlier versions are their own lines with a way to clear them. */
struct PlansView: View {
    @Environment(DriveStore.self) private var store
    let allowance: StorageAllowance?
    let billing: BillingSummary?
    let breakdown: StorageBreakdown?
    let reload: () async -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var removing = false
    @State private var working = false

    private var versions: Int64 { Int64(breakdown?.supersededBytes ?? "0") ?? 0 }
    private var trash: Int64 { Int64(breakdown?.trashBytes ?? "0") ?? 0 }
    private var used: Int64 { allowance?.used ?? 0 }
    private var plan: PlanDisplay { PlanDisplay(allowance: allowance, billing: billing) }

    var body: some View {
        List {
            Section {} header: {
                VStack(alignment: .leading, spacing: Alpine.Space.s3) {
                    HStack(alignment: .firstTextBaseline, spacing: Alpine.Space.s2) {
                        Text(formatSpace(used)).font(Theme.Text.titleLarge).foregroundStyle(Alpine.ink)
                        Text("of \(formatQuota(allowance?.quota ?? 0)) used").font(.body).foregroundStyle(Alpine.inkMuted)
                    }
                    .padding(.horizontal, Alpine.Space.s1)
                    // In a pool the total is counted in whole GB, part by part, and is everyone's: one plain bar.
                    StorageMeter(used: used, quota: allowance?.quota ?? 1, versions: versions, trash: trash, simple: plan.family != nil).padding(.horizontal, Alpine.Space.s1)
                }
                .textCase(nil)
                .listRowInsets(EdgeInsets(top: 0, leading: 0, bottom: Alpine.Space.s2, trailing: 0))
            }
            Section {
                // No Files row in a pool: the rest is everyone's (the family folders and each member's
                // own files), and this person's exact bytes taken off a rounded total mean nothing.
                if plan.family == nil {
                    line(Alpine.primary, "Files", nil, trailing: Text(formatSpace(max(0, used - versions - trash))))
                }
                HStack {
                    swatch(Alpine.primary.opacity(0.45))
                    VStack(alignment: .leading, spacing: 2) {
                        Text("Earlier versions").foregroundStyle(Alpine.ink)
                        let count = breakdown?.supersededVersions ?? 0
                        Text(count == 0 ? "None" : count == 1 ? "1 earlier version" : "\(count) earlier versions").font(Theme.Text.footnote).foregroundStyle(Alpine.inkMuted)
                    }
                    Spacer()
                    if versions > 0 {
                        Button(working ? "Removing…" : "Remove · \(formatSpace(versions))") { removing = true }
                            .font(Theme.Text.callout.weight(.semibold)).foregroundStyle(Alpine.primary).buttonStyle(.borderless).disabled(working)
                    } else {
                        Text("0 GB").font(Theme.Text.callout).foregroundStyle(Alpine.inkMuted)
                    }
                }
                .alpineRow()
                NavigationLink { TrashView().environment(store) } label: {
                    HStack { swatch(Alpine.inkMuted); Text("Trash").foregroundStyle(Alpine.ink); Spacer(); Text(formatSpace(trash)).foregroundStyle(Alpine.inkMuted) }
                }
                .alpineRow()
            } footer: {
                if let family = plan.family {
                    Text("Shared with \(family), counted in whole GB. Your trash and earlier versions count until they’re removed. Trash empties itself after 30 days.")
                } else {
                    Text("Trash and earlier versions count until they’re removed. Trash empties itself after 30 days.")
                }
            }
            Section {
                if let source = plan.source {
                    VStack(alignment: .leading, spacing: 2) {
                        Text(plan.name).font(Theme.Text.headline).foregroundStyle(Alpine.ink)
                        Text("\(source) · \(formatQuota(allowance?.quota ?? 0))").font(Theme.Text.footnote).foregroundStyle(Alpine.inkMuted)
                    }
                    .alpineRow()
                } else if let subscription = plan.subscription {
                    VStack(alignment: .leading, spacing: 2) {
                        Text(subscription.productName).font(Theme.Text.headline).foregroundStyle(Alpine.ink)
                        Text(planDetail(subscription)).font(Theme.Text.footnote).foregroundStyle(plan.lineColour)
                    }
                    .alpineRow()
                } else {
                    VStack(alignment: .leading, spacing: 2) {
                        Text("Free").font(Theme.Text.headline).foregroundStyle(Alpine.ink)
                        Text([formatQuota(allowance?.quota ?? 0), plan.lapsed?.line].compactMap { $0 }.joined(separator: " · ")).font(Theme.Text.footnote).foregroundStyle(plan.lineColour)
                    }
                    .alpineRow()
                }
            } header: {
                Text("Your plan").font(Theme.Text.label).foregroundStyle(Alpine.inkMuted)
            } footer: {
                // Said, never linked: the app holds no way to where plans are paid for (App Review 3.1.3(f)).
                if let lapsed = plan.lapsed { Text("\(lapsed.room) Nothing is deleted, and uploads pause while you’re over it.") }
            }
        }
        .listStyle(.insetGrouped)
        .alpineGrouped()
        .navigationTitle("Plan and storage")
        .screenChrome(title: "Plan and storage")
        .alert("Remove earlier versions?", isPresented: $removing) {
            Button("Cancel", role: .cancel) {}
            Button("Remove", role: .destructive) { removeVersions() }
        } message: {
            Text("Every file keeps its current version. The \(formatSpace(versions)) of earlier versions is deleted and can’t be restored.")
        }
        .refreshable { await reload() }
    }

    private func planDetail(_ subscription: BillingSubscription) -> String {
        let quota = Int64(subscription.quotaBytes).map(formatQuota) ?? ""
        if subscription.status == "past_due" { return "\(quota) · payment overdue" }
        let date = parseDate(subscription.currentPeriodEnd).map { $0.formatted(.dateTime.day().month(.abbreviated).locale(.dayMonth)) } ?? ""
        return "\(quota) · \(subscription.cancelAtPeriodEnd ? "ends" : "renews") \(date)"
    }

    private func swatch(_ colour: Color) -> some View { Circle().fill(colour).frame(width: 10, height: 10).accessibilityHidden(true) }

    private func line(_ colour: Color, _ title: String, _ detail: String?, trailing: Text) -> some View {
        HStack { swatch(colour); Text(title).foregroundStyle(Alpine.ink); Spacer(); trailing.foregroundStyle(Alpine.inkMuted) }.alpineRow()
    }

    private func removeVersions() {
        working = true
        let freed = versions
        let count = breakdown?.supersededVersions ?? 0
        Task {
            if await store.discardEarlierVersions() {
                store.notify("Removed \(count == 1 ? "1 earlier version" : "\(count) earlier versions") · \(formatSpace(freed)) freed")
            }
            await reload()
            working = false
        }
    }
}

/*
 * Not enough room, when an upload doesn't fit: Empty trash or Remove earlier versions,
 * which free space here and send the failed uploads again. Unlike the web there is no
 * way to a bigger plan (App Review 3.1.3(f)).
 */
struct StorageFullSheet: View {
    @Environment(DriveStore.self) private var store
    @Environment(\.dismiss) private var dismiss
    let rows: [TransferRowModel]
    @State private var allowance: StorageAllowance?
    @State private var billing: BillingSummary?
    @State private var breakdown: StorageBreakdown?
    @State private var busy: String?

    private var waiting: [TransferRowModel] { rows.filter(\.noRoom) }
    private var versions: Int64 { Int64(breakdown?.supersededBytes ?? "0") ?? 0 }
    private var trash: Int64 { Int64(breakdown?.trashBytes ?? "0") ?? 0 }

    var body: some View {
        NavigationStack {
            List {
                Section {} header: {
                    Text(explanation).font(Theme.Text.callout).foregroundStyle(Alpine.inkMuted).textCase(nil)
                }
                Section {
                    if trash > 0 {
                        Button { free("trash") } label: { option("trash", "Empty trash", busy == "trash" ? "Emptying…" : "Frees \(formatSpace(trash))") }
                            .disabled(busy != nil).alpineRow()
                    }
                    if versions > 0 {
                        Button { free("versions") } label: { option("clock.arrow.circlepath", "Remove earlier versions", busy == "versions" ? "Removing…" : "Frees \(formatSpace(versions))") }
                            .disabled(busy != nil).alpineRow()
                    }
                } footer: {
                    if trash == 0 && versions == 0 && breakdown != nil {
                        Text("Nothing in the trash or earlier versions to remove. Move files you don’t need to the Trash first, then empty it.")
                    }
                }
            }
            .listStyle(.insetGrouped)
            .alpineGrouped()
            .navigationTitle("Not enough room")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Not now") { dismiss() } } }
            // Separate tasks, so a slow billing answer never holds back the ways to free room.
            .task { allowance = try? await Auth.storage() }
            .task { billing = try? await Auth.billing() }
            .task { breakdown = try? await store.vault.storageBreakdown() }
        }
        .presentationDetents([.medium, .large])
    }

    private var explanation: String {
        // What the server checks uploads against (StorageAllowance.free), never quota less used.
        let free = allowance.map { formatSpace($0.free) + ($0.pool == nil ? "" : " in the family’s storage") } ?? "little room"
        let needed = waiting.compactMap(\.size).reduce(0, +)
        let what = waiting.count == 1 ? "“\(waiting[0].name)”" : waiting.isEmpty ? "This upload" : "These \(waiting.count) files"
        let needs = needed > 0 ? " need\(waiting.count == 1 ? "s" : "") \(formatSpace(needed))," : " doesn’t fit, "
        // A plan whose payment failed, or that is paused, is why the room is Free's: said first (never while pooled).
        let lapsed = allowance.flatMap { PlanDisplay(allowance: $0, billing: billing).lapsed }.map { $0.room + " " } ?? ""
        return "\(lapsed)\(what)\(needs) and \(free) is free. Trash and earlier versions count until they’re removed."
    }

    private func option(_ symbol: String, _ title: String, _ detail: String) -> some View {
        HStack(spacing: Alpine.Space.s3) {
            Image(systemName: symbol).foregroundStyle(Alpine.ink).frame(width: 24)
            VStack(alignment: .leading, spacing: 2) {
                Text(title).foregroundStyle(Alpine.ink)
                Text(detail).font(Theme.Text.footnote).foregroundStyle(Alpine.inkMuted)
            }
            Spacer()
        }
        .contentShape(Rectangle())
    }

    /* Frees the space, then sends what didn't fit again. */
    private func free(_ what: String) {
        busy = what
        Task {
            let ok: Bool
            if what == "trash" {
                await store.emptyTrash()
                ok = true
            } else {
                ok = await store.discardEarlierVersions()
            }
            busy = nil
            guard ok else { return }
            for row in waiting {
                if let id = row.queuedId { BackgroundTransfers.shared.retry(id) } else if let id = row.foregroundId { store.retry(id) }
            }
            let names = waiting.count == 1 ? "“\(waiting[0].name)”" : "\(waiting.count) files"
            store.notify((what == "trash" ? "Trash emptied" : "Earlier versions removed") + (waiting.isEmpty ? "" : " · uploading \(names) again"))
            dismiss()
        }
    }
}

/* MARK: Advanced */

/* The rare, heavy things: replacing sharing keys, rotating the account key, the account ID support may ask for, the server, and deleting the account. */
struct AdvancedView: View {
    @Environment(AppModel.self) private var model
    @Environment(DriveStore.self) private var store
    @Environment(\.dismiss) private var dismiss
    @State private var resetting = false
    @State private var replacing = false
    @State private var deleting = false

    var body: some View {
        List {
            Section {
                Button { replacing = true } label: {
                    HStack(spacing: Alpine.Space.s3) {
                        SettingsGlyph(symbol: "key")
                        Text("Replace sharing keys").foregroundStyle(Alpine.ink)
                        Spacer()
                        Image(systemName: "chevron.right").font(.footnote.weight(.semibold)).foregroundStyle(Alpine.inkMuted)
                    }
                    .contentShape(Rectangle())
                }
                .alpineRow()
            } footer: {
                Text("New keys for sharing, signed by your old ones, so people you share with don’t need to compare words from scratch.")
            }
            Section {
                Button { resetting = true } label: {
                    HStack(spacing: Alpine.Space.s3) {
                        SettingsGlyph(symbol: "exclamationmark.shield")
                        Text("Rotate account key").foregroundStyle(Alpine.ink)
                        Spacer()
                        Image(systemName: "chevron.right").font(.footnote.weight(.semibold)).foregroundStyle(Alpine.inkMuted)
                    }
                    .contentShape(Rectangle())
                }
                .alpineRow()
            } footer: {
                Text("A new master key for your account. Your files, sharing keys and links stay as they are.")
            }
            Section {
                if let id = model.user?.id {
                    HStack {
                        VStack(alignment: .leading, spacing: 2) {
                            Text("Account ID").foregroundStyle(Alpine.ink)
                            Text(id).font(.footnote.monospaced()).foregroundStyle(Alpine.inkMuted).lineLimit(1).truncationMode(.middle)
                        }
                        Spacer()
                        Button("Copy") {
                            // This phone only, and gone in two minutes: not Universal Clipboard, not every app that reads the board later.
                            UIPasteboard.general.setItems([["public.utf8-plain-text": id]], options: [.localOnly: true, .expirationDate: Date().addingTimeInterval(120)])
                            store.notify("Account ID copied")
                        }
                        .font(Theme.Text.callout.weight(.semibold)).foregroundStyle(Alpine.primary).buttonStyle(.borderless)
                    }
                    .alpineRow()
                }
                // The server this account signed in to; changed from sign-in, shown here read-only.
                NavigationLink { SelfHostingView(readOnly: true) } label: {
                    HStack(spacing: Alpine.Space.s3) {
                        SettingsGlyph(symbol: "server.rack", muted: true)
                        VStack(alignment: .leading, spacing: 2) {
                            Text("Server address").foregroundStyle(Alpine.ink)
                            Text(model.selfHostedName.map { "\($0) · self-hosted" } ?? (URL(string: model.origin)?.host() ?? model.origin))
                                .font(Theme.Text.footnote).foregroundStyle(Alpine.inkMuted)
                        }
                    }
                }
                .alpineRow()
            } header: {
                Text("About this account").font(Theme.Text.label).foregroundStyle(Alpine.inkMuted)
            } footer: {
                Text("Support may ask for your account ID.")
            }
            BackgroundAccessSection()
            Section {
                Button("Delete account", role: .destructive) { deleting = true }.foregroundStyle(Alpine.danger).alpineRow()
            } footer: {
                Text("Deletes every file, every earlier version and the account. It can’t be undone.")
            }
        }
        .listStyle(.insetGrouped)
        .alpineGrouped()
        .navigationTitle("Advanced")
        .screenChrome(title: "Advanced")
        .sheet(isPresented: $resetting) { ResetKeysSheet().environment(store) }
        .sheet(isPresented: $replacing) { ReplaceKeysSheet().environment(store) }
        .sheet(isPresented: $deleting) { DeleteAccountSheet() }
    }
}

/* MARK: Password and recovery */

/* "At least 12 characters…", reacting as you type, as the board's strength hint does. */
struct PasswordHint {
    let label: String
    let hint: String
    let score: Int

    init(_ password: String) {
        if password.isEmpty { (label, hint, score) = ("", "At least 12 characters. A few unrelated words work well.", 0); return }
        if password.count < 12 {
            let left = 12 - password.count
            (label, hint, score) = ("Too short", "\(left) more \(left == 1 ? "character" : "characters") to go.", 0)
            return
        }
        let kinds = [password.contains(where: \.isLowercase), password.contains(where: \.isUppercase), password.contains(where: \.isNumber),
                     password.contains { !$0.isLetter && !$0.isNumber && !$0.isWhitespace }, password.contains(where: \.isWhitespace)].filter { $0 }.count
        if password.count >= 20 || (password.count >= 14 && kinds >= 3) { (label, hint, score) = ("Strong", "Hard to guess. Make sure you can remember it.", 3); return }
        if kinds >= 2 { (label, hint, score) = ("Good", "Longer is stronger. Another word would help.", 2); return }
        (label, hint, score) = ("Weak", "Easy to guess. Add another word or two.", 1)
    }

    var text: Text {
        guard !label.isEmpty else { return Text(hint) }
        let colour = score >= 2 ? Alpine.success : score == 1 ? Alpine.warning : Alpine.danger
        return Text("\(Text(label).foregroundStyle(colour).fontWeight(.semibold)) · \(hint)")
    }
}

struct ChangePasswordSheet: View {
    @Environment(\.dismiss) private var dismiss
    @Environment(AppModel.self) private var model
    @Environment(DriveStore.self) private var store
    @State private var current = ""
    @State private var new = ""
    @State private var confirm = ""
    @State private var pending = false
    @State private var error = ""

    private var mismatch: Bool { !confirm.isEmpty && confirm != new }

    var body: some View {
        NavigationStack {
            Form {
                if !error.isEmpty { Section { Label(error, systemImage: "exclamationmark.circle").foregroundStyle(Alpine.danger).listRowBackground(Alpine.dangerSoft) } }
                Section {
                    PasswordField(label: "Current", text: $current, content: .password).alpineRow()
                }
                Section {
                    PasswordField(label: "New", text: $new, content: .newPassword).alpineRow()
                    PasswordField(label: "Repeat", text: $confirm, content: .newPassword).alpineRow()
                } footer: {
                    if mismatch { Text("The new passwords don’t match.").foregroundStyle(Alpine.danger) } else { PasswordHint(new).text }
                }
                Section {
                    Text("Your other devices will be signed out. Your recovery phrase stays the same.").font(Theme.Text.footnote).foregroundStyle(Alpine.inkMuted)
                        .listRowBackground(Color.clear).listRowInsets(EdgeInsets(top: 0, leading: Alpine.Space.s4, bottom: 0, trailing: Alpine.Space.s4))
                        .listRowSeparator(.hidden)
                    Button { submit() } label: { Text(pending ? "Changing…" : "Change password").frame(maxWidth: .infinity) }
                        .buttonStyle(PrimaryCapsuleStyle())
                        .disabled(pending || current.isEmpty || new.count < 12 || new != confirm)
                        .listRowBackground(Color.clear).listRowInsets(EdgeInsets())
                }
            }
            .alpineGrouped()
            .navigationTitle("Change password")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } } }
        }
    }

    private func submit() {
        pending = true
        error = ""
        Task {
            do {
                try await Auth.changePassword(current: current, new: new)
                // The server ends every session on a password change, as on the web; sign in again with the new one.
                if let email = model.user?.email { try await model.signIn(email: email, password: new) }
                dismiss()
                store.notify("Password changed. Other devices are signed out.")
            } catch {
                if let words = ErrorWords.say(error) { self.error = words }
            }
            pending = false
        }
    }
}

/* A labelled secure field with an eye, as the sign-in screen has. */
struct PasswordField: View {
    let label: String
    @Binding var text: String
    /* Nil for a password typed only to confirm (Rotate account key, Delete account): not a sign-in, so nothing to save. */
    var content: UITextContentType? = .password

    var body: some View {
        HStack {
            Text(label).foregroundStyle(Alpine.ink).frame(width: 90, alignment: .leading)
            RevealingSecureField(placeholder: "Required", text: $text, content: content)
        }
    }
}

/*
 * A secure field with the eye at its end, as on sign-in. Typing always goes into the secure
 * field (the system keyboard, no autocorrection, nothing learned); the eye only lays the
 * characters over it as text, so a revealed password is never in a plain, editable field a
 * keyboard could read or learn from. Swapping the fields out made iOS offer to save a password.
 */
struct RevealingSecureField: View {
    let placeholder: String
    @Binding var text: String
    var content: UITextContentType? = .password
    var submit: (() -> Void)? = nil
    @State private var shown = false

    var body: some View {
        HStack {
            SecureField(placeholder, text: $text)
                .textContentType(content).textInputAutocapitalization(.never).autocorrectionDisabled()
                .onSubmit { submit?() }
                .revealed(shown ? text : nil, placeholder: placeholder)
            Button { shown.toggle() } label: {
                Image(systemName: shown ? "eye.slash" : "eye").foregroundStyle(Alpine.inkMuted)
            }
            .buttonStyle(.plain).accessibilityLabel(shown ? "Hide password" : "Show password")
        }
    }
}

extension View {
    /*
     * A secure field's characters drawn over it while revealed: the field stays underneath (and
     * stays the one typed into), only its dots are hidden. Not hit-testable, so a tap still lands
     * on the field. The field is faded rather than hidden: UIKit stops delivering touches to a
     * view below 1% alpha.
     */
    func revealed(_ value: String?, placeholder: String) -> some View {
        opacity(value == nil ? 1 : 0.011)
            .overlay(alignment: .leading) {
                if let value {
                    Text(value.isEmpty ? placeholder : value)
                        .foregroundStyle(value.isEmpty ? Alpine.inkMuted : Alpine.ink)
                        .lineLimit(1).truncationMode(.head)
                        .privacySensitive().allowsHitTesting(false).accessibilityHidden(true)
                }
            }
    }
}

/* The 24 words, numbered, in two or three columns; not drawn while the screen is recorded or mirrored. */
struct PhraseGrid: View {
    let phrase: String
    var columns = 2
    @State private var capture = ScreenCapture.shared

    var body: some View {
        if capture.active {
            Label("Hidden while your screen is recorded or shared. Stop that to see the words.", systemImage: "eye.slash")
                .font(Theme.Text.callout).foregroundStyle(Alpine.inkMuted)
        } else {
            grid
        }
    }

    @ViewBuilder private var grid: some View {
        let words = phrase.split(separator: " ").map(String.init)
        LazyVGrid(columns: Array(repeating: GridItem(.flexible(), spacing: Alpine.Space.s2), count: columns), alignment: .leading, spacing: Alpine.Space.s2) {
            ForEach(words.indices, id: \.self) { index in
                HStack(spacing: 6) {
                    Text("\(index + 1)").font(.caption.monospacedDigit()).foregroundStyle(Alpine.inkMuted).frame(width: 18, alignment: .trailing)
                    Text(words[index]).font(.body.monospaced()).foregroundStyle(Alpine.ink).lineLimit(1).minimumScaleFactor(0.7)
                }
                .padding(.horizontal, Alpine.Space.s2).padding(.vertical, 6)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(Alpine.ground, in: RoundedRectangle(cornerRadius: Alpine.Radius.control))
            }
        }
        .accessibilityElement(children: .combine)
    }
}

/* Save the kit: the web's kit file through the share sheet (Print, Save to Files, AirDrop). */
@MainActor
enum KitShare {
    static func present(phrase: String, email: String, accountId: String) async {
        let envelope = (try? await Auth.recoveryEnvelopeJSON()) ?? [:]
        let text = RecoveryKit.text(email: email, accountId: accountId, phrase: phrase, recovery: envelope)
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent("kit-" + UUID().uuidString, isDirectory: true)
        try? FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let file = directory.appendingPathComponent(RecoveryKit.fileName)
        guard (try? text.write(to: file, atomically: true, encoding: .utf8)) != nil else { return }
        let sheet = UIActivityViewController(activityItems: [file], applicationActivities: nil)
        // Not onto the clipboard: every app can read it, and Universal Clipboard takes it to the person's other devices.
        sheet.excludedActivityTypes = [.copyToPasteboard]
        // The kit holds the phrase in plain text: gone once the sheet has handed it on or was dismissed.
        sheet.completionWithItemsHandler = { _, _, _, _ in try? FileManager.default.removeItem(at: directory) }
        guard let top = TextPrompt.topController() else { try? FileManager.default.removeItem(at: directory); return }
        top.present(sheet, animated: true)
    }
}

struct RecoveryPhraseSheet: View {
    @Environment(DriveStore.self) private var store
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    @State private var phrase: String?
    @State private var error = ""
    @State private var copied = false
    /* Whether the server has this phrase marked as saved, and the version to confirm; nil until known. */
    @State private var confirmed: Bool?
    @State private var version: UInt64 = 0
    @State private var saved = false
    @State private var checking = false

    var body: some View {
        NavigationStack {
            List {
                Section {} header: {
                    Text("These 24 words get you back in if you forget your password. Keep them somewhere private and offline.")
                        .font(Theme.Text.callout).foregroundStyle(Alpine.inkMuted).textCase(nil)
                }
                if let phrase {
                    Section { PhraseGrid(phrase: phrase).padding(.vertical, Alpine.Space.s2).alpineRow() }
                    Section {
                        HStack(spacing: Alpine.Space.s2) {
                            Button { Task { await KitShare.present(phrase: phrase, email: model.user?.email ?? "", accountId: model.user?.id ?? "") } } label: {
                                Text("Save the kit").frame(maxWidth: .infinity)
                            }
                            .buttonStyle(PrimaryCapsuleStyle())
                            Button {
                                UIPasteboard.general.setItems([["public.utf8-plain-text": phrase]], options: [.localOnly: true, .expirationDate: Date().addingTimeInterval(120)])
                                copied = true
                                Task { try? await Task.sleep(for: .seconds(1.6)); copied = false }
                            } label: { Label(copied ? "Copied" : "Copy", systemImage: copied ? "checkmark" : "doc.on.doc") }
                                .buttonStyle(SecondaryCapsuleStyle())
                        }
                        .bareRow(top: 0, bottom: 0)
                    }
                    // Not yet marked as saved: say so, then pick three words back, as on the web and Android.
                    if confirmed == false {
                        SavedCheck(saved: $saved, title: "Check three words") { checking = true }
                    }
                } else if !error.isEmpty {
                    Text(error).foregroundStyle(Alpine.danger).alpineRow()
                } else {
                    ProgressView("Opening…").frame(maxWidth: .infinity).listRowBackground(Color.clear)
                }
            }
            .listStyle(.insetGrouped)
            .alpineGrouped()
            .navigationTitle("Recovery phrase")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } } }
            .navigationDestination(isPresented: $checking) {
                if let phrase {
                    CheckWordsView(phrase: phrase, recoveryVersion: version) { store.notify("Recovery phrase saved"); dismiss() }
                }
            }
            .task {
                do { phrase = try await store.vault.recoveryPhrase() } catch {
                    if let words = ErrorWords.say(error) { self.error = words }
                }
                if let key = try? await Auth.recoveryKey() { confirmed = key.confirmed; version = key.envelope.recoveryVersion }
            }
        }
    }
}

/* Rotate account key (was "Rotate keys", then "Reset sharing keys"). Says when to use it and what changes, then shows the new phrase until it's saved. */
struct ResetKeysSheet: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    @State private var password = ""
    @State private var pending = false
    @State private var error = ""
    @State private var phrase: String?
    @State private var saved = false
    @State private var checking = false

    var body: some View {
        NavigationStack {
            Form {
                if let phrase {
                    Section {} header: {
                        Text("Your old phrase and any printed kit no longer work. Save these 24 words instead.").font(Theme.Text.callout).foregroundStyle(Alpine.inkMuted).textCase(nil)
                    }
                    Section { PhraseGrid(phrase: phrase, columns: 3).padding(.vertical, Alpine.Space.s2).alpineRow() }
                    Section {
                        VStack(spacing: Alpine.Space.s2) {
                            Button { Task { await KitShare.present(phrase: phrase, email: model.user?.email ?? "", accountId: model.user?.id ?? "") } } label: {
                                Text("Save the kit").frame(maxWidth: .infinity)
                            }
                            .buttonStyle(PrimaryCapsuleStyle())
                        }
                        .listRowBackground(Color.clear).listRowInsets(EdgeInsets())
                    }
                    SavedCheck(saved: $saved, title: "I’ve saved it") { checking = true }
                } else {
                    Section {} header: {
                        VStack(alignment: .leading, spacing: Alpine.Space.s2) {
                            Text("A new master key for your account. Your files, sharing keys and links stay as they are.").foregroundStyle(Alpine.ink)
                            Text("• Use it if you think someone saw your password or recovery phrase.\n• You get a new recovery phrase. The old one stops working.\n• Your other devices are signed out.")
                                .foregroundStyle(Alpine.inkMuted)
                        }
                        .font(Theme.Text.callout).textCase(nil)
                    }
                    if !error.isEmpty { Section { Text(error).foregroundStyle(Alpine.danger).alpineRow() } }
                    Section {
                        PasswordField(label: "Password", text: $password, content: nil).alpineRow()
                    } footer: {
                        Text("Enter your password to confirm.")
                    }
                    Section {
                        Button { reset() } label: { Text(pending ? "Rotating…" : "Rotate account key").frame(maxWidth: .infinity) }
                            .buttonStyle(PrimaryCapsuleStyle()).disabled(pending || password.isEmpty)
                            .listRowBackground(Color.clear).listRowInsets(EdgeInsets())
                    }
                }
            }
            .alpineGrouped()
            .navigationTitle(phrase == nil ? "Rotate account key" : "Your new recovery phrase")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { if phrase == nil { ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } } } }
            .interactiveDismissDisabled(phrase != nil || pending)
            .navigationDestination(isPresented: $checking) {
                if let phrase {
                    // The new phrase's version: read after the reset, since the server made it.
                    CheckWordsView(phrase: phrase, recoveryVersion: nil) { NoticeCenter.shared.show("Recovery phrase saved"); dismiss() }
                }
            }
        }
    }

    private func reset() {
        pending = true
        error = ""
        Task {
            do {
                let made = try await Auth.rotateKeys(password: password)
                // The rotation happened: the new phrase is shown whatever follows, since the old one no longer opens the
                // account and this is the only time the new one is shown.
                phrase = made
                // Every session ended with the reset; sign in again under the new key. If that fails, the session alert
                // asks for it later; the phrase stays on screen.
                if let email = model.user?.email { try? await model.signIn(email: email, password: password) }
            } catch {
                if let words = ErrorWords.say(error) { self.error = words }
            }
            pending = false
        }
    }
}

/*
 * Replacing the sharing keys by a succession: new keys signed by the old ones. People who
 * checked the old words follow the signature; what was shared is sealed again under the new
 * keys. Distinct from Rotate account key, which replaces the master key and the phrase.
 */
struct ReplaceKeysSheet: View {
    @Environment(DriveStore.self) private var store
    @Environment(\.dismiss) private var dismiss
    @State private var pending = false
    @State private var error = ""
    @State private var outcome: RotationOutcome?

    var body: some View {
        NavigationStack {
            Form {
                Section {} header: {
                    VStack(alignment: .leading, spacing: Alpine.Space.s2) {
                        Text("New keys for sharing, signed by your old ones, so people you share with don’t need to compare words from scratch.").foregroundStyle(Alpine.ink)
                        Text("• Your twelve words change. People who checked the old ones see that your new keys are signed by them.\n• Everything you shared is sealed again under the new keys.\n• Your password, recovery phrase and devices stay as they are.")
                            .foregroundStyle(Alpine.inkMuted)
                    }
                    .font(Theme.Text.callout).textCase(nil)
                }
                if let outcome {
                    Section {
                        Text(outcome.rotated == 1 ? "Done. 1 share was sealed again." : "Done. \(outcome.rotated) shares were sealed again.").foregroundStyle(Alpine.ink).alpineRow()
                        ForEach(outcome.skipped, id: \.self) { reason in
                            Text(reason).font(Theme.Text.footnote).foregroundStyle(Alpine.danger).alpineRow()
                        }
                    } footer: {
                        if !outcome.skipped.isEmpty { Text("Those shares still open with your old keys until you share again.") }
                    }
                } else {
                    if !error.isEmpty { Section { Text(error).foregroundStyle(Alpine.danger).alpineRow() } }
                    Section {
                        Button { replace() } label: { Text(pending ? "Replacing…" : "Replace sharing keys").frame(maxWidth: .infinity) }
                            .buttonStyle(PrimaryCapsuleStyle()).disabled(pending)
                            .listRowBackground(Color.clear).listRowInsets(EdgeInsets())
                    }
                }
            }
            .alpineGrouped()
            .navigationTitle("Replace sharing keys")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                if outcome != nil {
                    ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } }
                } else {
                    ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() }.disabled(pending) }
                }
            }
            .interactiveDismissDisabled(pending)
        }
    }

    private func replace() {
        pending = true
        error = ""
        Task {
            do {
                outcome = try await store.vault.replaceSharingKeys()
                await store.refreshSigners()
                await store.refreshSharing()
            } catch {
                if let words = ErrorWords.say(error) { self.error = words }
            }
            pending = false
        }
    }
}

/* Password and DELETE, as on every client; then "Your account is deleted". */
struct DeleteAccountSheet: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    @State private var password = ""
    @State private var phrase = ""
    @State private var pending = false
    @State private var error = ""

    var body: some View {
        NavigationStack {
            Form {
                Section {} header: {
                    Text("Deleting removes every file, every earlier version, every share and link, and the account itself. \(Text("It can’t be undone.").fontWeight(.semibold))")
                        .font(Theme.Text.callout).foregroundStyle(Alpine.ink).textCase(nil)
                }
                if !error.isEmpty { Section { Text(error).foregroundStyle(Alpine.danger).alpineRow() } }
                Section { PasswordField(label: "Password", text: $password, content: nil).alpineRow() }
                Section("Type DELETE to confirm") {
                    TextField("DELETE", text: $phrase).font(.body.monospaced()).textInputAutocapitalization(.characters).autocorrectionDisabled().alpineRow()
                }
                Section {
                    Button { submit() } label: {
                        // Off, it fades to the same quiet fill as every other button, never a washed-out red.
                        let ready = !pending && !password.isEmpty && phrase == "DELETE"
                        Text(pending ? "Deleting…" : "Delete forever").font(.body.weight(.semibold))
                            .foregroundStyle(ready ? Color.white : Alpine.inkMuted).frame(maxWidth: .infinity, minHeight: Theme.control)
                            .background(ready ? Alpine.danger : Alpine.ink.opacity(0.08), in: Capsule())
                    }
                    .buttonStyle(.plain)
                    .disabled(pending || password.isEmpty || phrase != "DELETE")
                    .listRowBackground(Color.clear).listRowInsets(EdgeInsets())
                }
            }
            .alpineGrouped()
            .navigationTitle("Delete account")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } } }
        }
    }

    private func submit() {
        pending = true
        error = ""
        Task {
            do {
                try await Auth.deleteAccount(password: password)
                dismiss()
                await model.deleted()
            } catch {
                if let words = ErrorWords.say(error) { self.error = words }
            }
            pending = false
        }
    }
}

/* "I’ve saved my kit…" and the button that goes on to the check, as on the web and Android. */
struct SavedCheck: View {
    @Binding var saved: Bool
    let title: String
    let next: () -> Void

    var body: some View {
        Section {
            Button { saved.toggle() } label: {
                HStack(alignment: .top, spacing: Alpine.Space.s3) {
                    Image(systemName: saved ? "checkmark.square.fill" : "square").font(.title3).foregroundStyle(saved ? Alpine.primary : Alpine.field)
                    Text("I’ve saved my kit or written the words down, somewhere private.").foregroundStyle(Alpine.ink).frame(maxWidth: .infinity, alignment: .leading)
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityAddTraits(saved ? .isSelected : [])
            .alpineRow()
            Button(action: next) { Text(title).frame(maxWidth: .infinity) }
                .buttonStyle(PrimaryCapsuleStyle()).disabled(!saved)
                .listRowBackground(Color.clear).listRowInsets(EdgeInsets())
        }
    }
}

/*
 * Check you saved it (apps/web components/recovery-phrase.tsx CheckWords): three words picked
 * back out of the kit, each among two other words of the same phrase; Finish marks the phrase
 * saved on the server. A wrong pick says which word it isn't.
 */
struct CheckWordsView: View {
    let phrase: String
    /* The version to confirm, or nil to read it from the server (a phrase just made). */
    let recoveryVersion: UInt64?
    let done: () -> Void
    @Environment(\.dismiss) private var back
    @State private var questions: [RecoveryCheck.Question] = []
    @State private var picks: [Int: String] = [:]
    @State private var pending = false
    @State private var error = ""

    private var words: [String] { phrase.split(whereSeparator: \.isWhitespace).map(String.init) }
    private func right(_ position: Int) -> Bool { picks[position] == words[position - 1] }

    var body: some View {
        List {
            Section {} header: {
                Text("Pick the missing words from your kit.").font(Theme.Text.callout).foregroundStyle(Alpine.inkMuted).textCase(nil)
            }
            if !error.isEmpty { Section { Text(error).foregroundStyle(Alpine.danger).alpineRow() } }
            ForEach(questions, id: \.position) { question in
                let pick = picks[question.position]
                let wrong = pick != nil && !right(question.position)
                Section {
                    HStack(spacing: 4) {
                        ForEach(question.options, id: \.self) { word in
                            let chosen = pick == word
                            Button { picks[question.position] = word } label: {
                                Text(word).font(.body.monospaced().weight(chosen ? .semibold : .regular))
                                    .foregroundStyle(chosen ? (wrong ? Alpine.danger : Alpine.primary) : Alpine.ink)
                                    .lineLimit(1).minimumScaleFactor(0.7)
                                    .frame(maxWidth: .infinity, minHeight: 40)
                                    .background(chosen ? (wrong ? Alpine.dangerSoft : Alpine.surface) : Color.clear, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
                                    .overlay {
                                        if chosen { RoundedRectangle(cornerRadius: 10, style: .continuous).strokeBorder(wrong ? Alpine.danger : Alpine.primary, lineWidth: 1) }
                                    }
                                    .contentShape(Rectangle())
                            }
                            .buttonStyle(.plain)
                            .accessibilityAddTraits(chosen ? .isSelected : [])
                        }
                    }
                    .padding(4)
                    .background(Alpine.ground, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
                    .alpineRow()
                    if wrong {
                        Text("That isn’t word \(question.position). Look at your kit again.").font(Theme.Text.footnote).foregroundStyle(Alpine.danger).alpineRow()
                    }
                } header: {
                    Text("Word \(question.position)").font(Theme.Text.label).foregroundStyle(Alpine.ink)
                }
            }
            Section {
                Button(action: finish) { Text(pending ? "Saving…" : "Finish").frame(maxWidth: .infinity) }
                    .buttonStyle(PrimaryCapsuleStyle())
                    .disabled(pending || questions.isEmpty || !questions.allSatisfy { right($0.position) })
                    .listRowBackground(Color.clear).listRowInsets(EdgeInsets())
                Button("Show my words again") { back() }
                    .font(Theme.Text.callout.weight(.semibold)).foregroundStyle(Alpine.primary)
                    .frame(maxWidth: .infinity).listRowBackground(Color.clear)
            }
        }
        .listStyle(.insetGrouped)
        .alpineGrouped()
        .navigationTitle("Check you saved it")
        .navigationBarTitleDisplayMode(.inline)
        .onAppear { if questions.isEmpty { questions = RecoveryCheck.questions(words) } }
    }

    private func finish() {
        pending = true
        error = ""
        Task {
            do {
                let version: UInt64
                if let recoveryVersion { version = recoveryVersion } else { version = try await Auth.recoveryKey().envelope.recoveryVersion }
                try await Auth.confirmRecovery(recoveryVersion: version)
                done()
            } catch {
                self.error = "Couldn’t record that. Check your connection and try again."
            }
            pending = false
        }
    }
}

/*
 * Privacy policy and Terms, as the sign-in screen shows them before an account exists:
 * the server's own pages (hushos.com's for the hosted service), in Safari inside the app.
 */
struct PolicyLinks: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        HStack(spacing: Alpine.Space.s4) {
            Button("Privacy policy") { if let url = Auth.privacyURL(origin: model.origin) { Self.present(url) } }
            Button("Terms") { if let url = Auth.termsURL(origin: model.origin) { Self.present(url) } }
        }
        .font(Theme.Text.footnote.weight(.semibold)).foregroundStyle(Alpine.inkMuted)
        .buttonStyle(.plain)
        .frame(minHeight: Theme.control)
    }

    @MainActor static func present(_ url: URL) {
        guard url.scheme == "https" || url.scheme == "http" else { return }
        let safari = SFSafariViewController(url: url)
        safari.preferredControlTintColor = UIColor(Alpine.primary)
        TextPrompt.topController()?.present(safari, animated: true)
    }
}
