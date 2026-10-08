import HushOSKit
import QuickLook
import SwiftUI
import UIKit

/*
 * Shared (DESIGN.md): With me is what others gave this account,
 * each row "From Sam · can edit", with Save a copy and Report on a long-press; a share
 * that won't open says to ask that person again. By me is what this account gave,
 * people and links in two sections, each stoppable with one question. A pasted
 * HushOS link opens here too.
 */
struct SharedView: View {
    @Environment(DriveStore.self) private var store
    @Environment(AppModel.self) private var model
    @State private var byMe = false
    @State private var mine: [SharedByMe] = []
    @State private var mineLoaded = false
    @State private var mineError: String?
    @State private var linkText = ""
    @State private var openingLink: String?
    @State private var showingPeople = false
    @State private var action: NodeAction?
    @State private var viewing: Opened?
    @State private var stopping: SharedByMe?

    var body: some View {
        NavigationStack {
            List {
                Section {} header: { header }
                if byMe { sharedByMe } else { sharedWithMe }
            }
            .listStyle(.insetGrouped)
            .alpineGrouped()
            .environment(\.defaultMinListRowHeight, 1)
            .listSectionSpacing(Alpine.Space.s4)
            .navigationTitle("Shared")
            .screenChrome(title: "Shared") { peopleButton }
            .sheet(isPresented: $showingPeople) { PeopleView().environment(store) }
            .navigationDestination(for: Opened.self) { folder in FolderView(folderId: folder.id, title: folder.name) }
            .navigationDestination(item: $openingLink) { url in LinkBrowserView(url: url) }
            .nodeActionSheets(action: $action, store: store)
            .fileViewer($viewing, among: store.mounts.compactMap(\.root), store: store)
            .alert(stopTitle, isPresented: Binding(get: { stopping != nil }, set: { if !$0 { stopping = nil } })) {
                Button("Cancel", role: .cancel) { stopping = nil }
                Button(stopping?.link != nil ? "Turn off link" : "Stop sharing", role: .destructive) { stop() }
            } message: {
                Text(stopMessage)
            }
            .onChange(of: byMe) { _, _ in Task { await load() } }
            .onChange(of: store.route, initial: true) { _, link in
                switch link {
                case .shared(let mine):
                    store.route = nil
                    openingLink = nil
                    byMe = mine
                case .share(let url):
                    store.route = nil
                    byMe = false
                    show(link: url)
                case .incompleteShare:
                    store.route = nil
                    byMe = false
                    // No key to open it with: the browser says the link is incomplete and asks for the whole one.
                    show(link: "incomplete")
                default:
                    break
                }
            }
            .refreshable { await load() }
            .task { await load() }
        }
    }

    /* A link from outside replaces one already open: back out of it first, then push the new one. */
    private func show(link: String) {
        guard openingLink != nil else { openingLink = link; return }
        openingLink = nil
        Task {
            try? await Task.sleep(for: .milliseconds(450))
            openingLink = link
        }
    }

    private var peopleButton: some View {
        Button { showingPeople = true } label: {
            HStack(spacing: 6) { Image(systemName: "person.2"); Text("People") }
                .font(.body.weight(.semibold)).padding(.horizontal, 14).frame(minHeight: Theme.control).contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel("People you share with")
    }

    private var header: some View {
        VStack(alignment: .leading, spacing: Alpine.Space.s3) {
            ScreenHeader(title: "Shared") { peopleButton }
            if store.offline { OfflineCapsule() }
            Picker("Which", selection: $byMe) {
                Text("With me").tag(false)
                Text("By me").tag(true)
            }
            .pickerStyle(.segmented)
            if !byMe { pasteField }
        }
        .textCase(nil)
        .listRowInsets(EdgeInsets(top: Alpine.Space.s2, leading: 0, bottom: 0, trailing: 0))
    }

    private var pasteField: some View {
        HStack(spacing: Alpine.Space.s2) {
            Image(systemName: "doc.on.clipboard").foregroundStyle(Alpine.inkMuted)
            TextField("Paste a HushOS link", text: $linkText)
                .textInputAutocapitalization(.never).autocorrectionDisabled().foregroundStyle(Alpine.ink)
                .onSubmit(openPasted)
            Button("Open", action: openPasted).buttonStyle(PrimaryCapsuleStyle())
                .disabled(linkText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
        }
        .padding(.leading, Alpine.Space.s4).padding(.trailing, 4).padding(.vertical, 4)
        .background(Alpine.surface, in: Capsule())
        .highContrastEdge(Capsule())
    }

    /* A pasted link opens here only if it is this server's; another server's says so plainly. */
    private func openPasted() {
        let text = linkText.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return }
        guard let url = URL(string: text) else { openingLink = text; return }
        switch AppLinks.parse(url, server: model.origin) {
        case .success(.share(let rebuilt)): openingLink = rebuilt
        case .failure(.otherServer(let host)): store.notify("This link is for another HushOS server (\(host)). Sign in to that server to open it.")
        default: openingLink = text
        }
    }

    /* MARK: With me */

    @ViewBuilder private var sharedWithMe: some View {
        if let failure = store.mountsError, store.mounts.isEmpty {
            EmptyStateView(symbol: "exclamationmark.triangle", danger: true, title: "Couldn’t load what’s shared", message: "Check your connection and try again.") {
                Button("Try again") { Task { await load() } }.buttonStyle(PrimaryCapsuleStyle())
            }
            .bareRow(top: Alpine.Space.s8)
            .accessibilityHint(failure)
        } else if store.mountsLoaded && store.mounts.isEmpty {
            EmptyStateView(symbol: "person.2", title: "Nothing shared with you yet", message: "When someone shares a folder or file with you, it shows up here.")
                .bareRow(top: Alpine.Space.s8)
        } else if !store.mountsLoaded {
            ProgressView().frame(maxWidth: .infinity).listRowBackground(Color.clear)
        } else {
            Section {
                ForEach(store.mounts) { mount in received(mount) }
            }
        }
    }

    private func granter(_ mount: ShareMount) -> String {
        mount.share.granter.name.isEmpty ? mount.share.granter.email : mount.share.granter.name
    }

    @ViewBuilder private func received(_ mount: ShareMount) -> some View {
        let from = "From \(granter(mount).split(separator: " ").first.map(String.init) ?? granter(mount)) · \(mount.share.role == "editor" ? "can edit" : "can view")"
        if let root = mount.root {
            Group {
                if root.isFolder {
                    NavigationLink(value: root) { NodeRow(item: root, note: from, access: false) }
                } else {
                    Button { Opener.open(root, store: store) { viewing = $0 } } label: { NodeRow(item: root, note: from, access: false) }
                        .buttonStyle(.plain)
                }
            }
            .contextMenu {
                if root.isFolder {
                    NavigationLink(value: root) { Label("Open", systemImage: "folder") }
                } else {
                    Button("Open", systemImage: "eye") { Opener.open(root, store: store) { viewing = $0 } }
                    Button("Send a copy", systemImage: "square.and.arrow.up") { action = .sendCopy(root) }
                }
                if root.isFolder {
                    if Offline.isFolderKept(root.id) {
                        Button("Remove from this phone", systemImage: "iphone.slash") {
                            store.removeKeptFolder(root.id)
                            store.notify("Removed “\(root.name)” from this phone. It’s still in HushOS.")
                        }
                    } else {
                        Button("Keep on this phone", systemImage: "arrow.down.circle") { Task { await store.keepFolder(root) } }
                    }
                }
                Button("Save a copy to my files", systemImage: "plus.square.on.square") { Task { await store.saveCopy(root) } }
                Button("Info", systemImage: "info.circle") { action = .info(root) }
                Divider()
                Button("Report", systemImage: "flag") { action = .report(root) }
            }
            .itemRow()
        } else {
            HStack(spacing: Alpine.Space.s3) {
                Image(systemName: "exclamationmark.triangle").foregroundStyle(Alpine.danger)
                    .frame(width: Theme.mark, height: Theme.mark).background(Alpine.dangerSoft, in: Circle())
                VStack(alignment: .leading, spacing: 2) {
                    Text("Shared by \(granter(mount))").foregroundStyle(Alpine.ink)
                    Text("Couldn’t open this. Ask \(granter(mount).split(separator: " ").first.map(String.init) ?? granter(mount)) to share it again.")
                        .font(Theme.Text.footnote).foregroundStyle(Alpine.danger)
                }
            }
            .frame(minHeight: Theme.row).itemRow()
        }
    }

    /* MARK: By me */

    @ViewBuilder private var sharedByMe: some View {
        let people = mine.filter { $0.share != nil }
        let links = mine.filter { $0.link != nil }
        if let mineError, mine.isEmpty {
            EmptyStateView(symbol: "exclamationmark.triangle", danger: true, title: "Couldn’t load what’s shared", message: "Check your connection and try again.") {
                Button("Try again") { Task { await load() } }.buttonStyle(PrimaryCapsuleStyle())
            }
            .bareRow(top: Alpine.Space.s8)
            .accessibilityHint(mineError)
        } else if mineLoaded && mine.isEmpty {
            EmptyStateView(symbol: "person.2", title: "You haven’t shared anything yet", message: "Choose Share on any folder or file to let someone open it.")
                .bareRow(top: Alpine.Space.s8)
        } else if !mineLoaded {
            ProgressView().frame(maxWidth: .infinity).listRowBackground(Color.clear)
        } else {
            Section {
                if people.isEmpty { Text("Nobody").foregroundStyle(Alpine.inkMuted).alpineRow() }
                ForEach(people) { row in outgoing(row) }
            } header: {
                Text("With people").font(Theme.Text.label).foregroundStyle(Alpine.inkMuted)
            }
            Section {
                if links.isEmpty { Text("No links on").foregroundStyle(Alpine.inkMuted).alpineRow() }
                ForEach(links) { row in outgoing(row) }
            } header: {
                Text("Links").font(Theme.Text.label).foregroundStyle(Alpine.inkMuted)
            } footer: {
                Text("Long-press to copy a link or turn it off.").font(Theme.Text.footnote).foregroundStyle(Alpine.inkMuted)
            }
        }
    }

    private func detail(_ row: SharedByMe) -> String {
        if let share = row.share {
            let who = "\(share.grantee.name.isEmpty ? share.grantee.email : share.grantee.name) · \(share.role == "editor" ? "can edit" : "can view")"
            // "since today, 14:02" mid-sentence, as on the web and Android.
            guard let since = changedLabel(parseDate(share.createdAt)) else { return who }
            return who + " · since " + since.prefix(1).lowercased() + since.dropFirst()
        }
        if let link = row.link { return "Anyone with the link · " + describeLink(link) }
        return ""
    }

    @ViewBuilder private func outgoing(_ row: SharedByMe) -> some View {
        Button { if let item = row.item { action = .share(item) } } label: {
            HStack(spacing: Alpine.Space.s3) {
                if let item = row.item { FileMark(item: item) } else { Image(systemName: "questionmark.folder").frame(width: Theme.mark) }
                VStack(alignment: .leading, spacing: 2) {
                    Text(row.item?.name ?? "Item outside this drive").foregroundStyle(Alpine.ink).lineLimit(1)
                    AccessText.line(detail(row), link: row.link != nil).font(Theme.Text.footnote).lineLimit(1)
                }
                Spacer(minLength: 0)
            }
            .frame(minHeight: Theme.row).contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .contextMenu {
            if let link = row.link, let item = row.item {
                Button("Copy link", systemImage: "doc.on.doc") {
                    Task {
                        if let url = try? await store.vault.linkURL(link, for: item) {
                            UIPasteboard.general.url = url
                            store.notify("Link copied")
                        } else {
                            store.notify("This link was made before links could be shown again. Turn it off and make a new one.")
                        }
                    }
                }
            }
            if let item = row.item { Button("Who can open", systemImage: "person.2") { action = .share(item) } }
            if let item = row.item, !item.isFolder { Button("Send a copy", systemImage: "square.and.arrow.up") { action = .sendCopy(item) } }
            Divider()
            Button(row.link != nil ? "Turn off link" : "Stop sharing", systemImage: row.link != nil ? "minus.circle" : "person.badge.minus", role: .destructive) { stopping = row }
                .tint(Alpine.danger)
                .disabled(row.item == nil)
        }
        .itemRow()
    }

    private var stopTitle: String {
        guard let stopping else { return "" }
        if stopping.link != nil { return "Turn off this link?" }
        return "Stop sharing “\(stopping.item?.name ?? "")”?"
    }

    private var stopMessage: String {
        guard let stopping else { return "" }
        if stopping.link != nil { return "Anyone who has it can’t open “\(stopping.item?.name ?? "")” any more. Other links keep working." }
        let who = stopping.share.map { $0.grantee.name.isEmpty ? $0.grantee.email : $0.grantee.name } ?? ""
        return "\(who) can’t open it any more. You can share it again later."
    }

    private func stop() {
        guard let row = stopping, let item = row.item else { return }
        stopping = nil
        Task {
            do {
                if let share = row.share {
                    try await store.revokeAndRotate(share, for: item)
                    store.notify("\(share.grantee.name.isEmpty ? share.grantee.email : share.grantee.name) can’t open “\(item.name)” any more")
                } else if let link = row.link {
                    try await store.turnOffLink(link, for: item)
                    store.notify("Link turned off")
                }
            } catch {
                store.notify((row.link != nil ? "Couldn’t turn the link off. " : "Couldn’t stop sharing. ") + "Check your connection and try again.")
            }
            await store.refreshSharing()
            await load()
        }
    }

    private func load() async {
        if byMe {
            do {
                mine = try await store.vault.sharedByMe()
                mineError = nil
            } catch {
                mineError = (error as? LocalizedError)?.errorDescription ?? error.localizedDescription
            }
            mineLoaded = true
        } else {
            await store.refreshMounts()
        }
    }
}

/* MARK: A link someone pasted or opened */

/*
 * The password gate, then the folder or file behind the link: "Opened from a link",
 * Save a copy up front, Report in the More menu. Files open in Quick Look as before.
 * A link that won't open says why: turned off or ended, cut short, or no connection.
 */
struct LinkBrowserView: View {
    @Environment(AppModel.self) private var model
    @Environment(DriveStore.self) private var store
    @Environment(\.dismiss) private var dismiss
    let url: String
    var folder: Opened? = nil
    var vault: LinkVault? = nil

    enum Problem { case gone, incomplete, failed }

    @State private var linkVault: LinkVault?
    @State private var root: Opened?
    @State private var children: [Opened] = []
    @State private var loaded = false
    @State private var needsPassword = false
    @State private var wrongPassword = false
    @State private var password = ""
    @State private var problem: Problem?
    @State private var preview: URL?
    @State private var downloading: String?
    @State private var reporting = false
    @State private var retyped = ""
    /* The whole link pasted on "This link is incomplete", which replaces the one that came in. */
    @State private var replaced: String?

    private var current: Opened? { folder ?? root }
    private var address: String { replaced ?? url }

    private func reopen() {
        let text = retyped.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return }
        // A hushos:// link is rebuilt on this server's address; anything else is taken as typed.
        if let link = URL(string: text), case .success(.share(let rebuilt)) = AppLinks.parse(link, server: model.origin) {
            replaced = rebuilt
        } else {
            replaced = text
        }
        retyped = ""
        problem = nil
        loaded = false
        Task { await start() }
    }

    var body: some View {
        List {
            Section {} header: {
                ScreenHeader(title: current?.name ?? "Shared link", back: { dismiss() }) {
                    if current != nil {
                        Menu {
                            Button("Save a copy to my files", systemImage: "plus.square.on.square") { save() }
                            Divider()
                            Button("Report", systemImage: "flag") { reporting = true }
                        } label: { HeaderIcon(symbol: "ellipsis") }
                        .accessibilityLabel("More")
                    }
                }
                .textCase(nil)
                .listRowInsets(EdgeInsets(top: Alpine.Space.s2, leading: 0, bottom: 0, trailing: 0))
            }
            if let problem {
                problemView(problem).bareRow(top: Alpine.Space.s8)
            } else if needsPassword {
                gate
            } else if let current {
                Section {
                    VStack(alignment: .leading, spacing: Alpine.Space.s3) {
                        AccessText.line("Opened from a link\(current.isFolder && loaded ? " · \(children.count == 1 ? "1 item" : "\(children.count) items")" : "")", link: true)
                            .font(Theme.Text.footnote)
                        Button { save() } label: { Label("Save a copy to my files", systemImage: "plus.square.on.square").frame(maxWidth: .infinity) }
                            .buttonStyle(PrimaryCapsuleStyle())
                    }
                    .padding(.horizontal, Alpine.Space.s1)
                    .bareRow(top: Alpine.Space.s1)
                }
                Section {
                    if !current.isFolder {
                        fileRow(current)
                    } else if !loaded {
                        ProgressView().frame(maxWidth: .infinity).listRowBackground(Color.clear)
                    } else if children.isEmpty {
                        Text("Nothing in this folder.").foregroundStyle(Alpine.inkMuted).alpineRow()
                    }
                    if current.isFolder {
                        ForEach(children) { child in
                            if child.isFolder {
                                NavigationLink(value: LinkTarget(url: address, folder: child)) { linkRow(child) }.itemRow()
                            } else {
                                fileRow(child)
                            }
                        }
                    }
                }
            } else {
                ProgressView("Opening the link").frame(maxWidth: .infinity).listRowBackground(Color.clear)
            }
        }
        .listStyle(.insetGrouped)
        .alpineGrouped()
        .environment(\.defaultMinListRowHeight, 1)
        .navigationTitle(current?.name ?? "Shared link")
        .screenChrome(title: current?.name ?? "Shared link", back: { dismiss() })
        .navigationDestination(for: LinkTarget.self) { target in
            LinkBrowserView(url: target.url, folder: target.folder, vault: linkVault)
        }
        .sheet(isPresented: $reporting) {
            if let report = current, let linkVault {
                ReportSheet(item: report, from: nil) { category, reason, email in
                    try await linkVault.report(report, category: category, reason: reason, email: email)
                }
            }
        }
        .quickLookPreview($preview)
        .task { await start() }
    }

    private var gate: some View {
        Group {
            Section {
                VStack(spacing: Alpine.Space.s3) {
                    Image(systemName: "lock").font(.title2).foregroundStyle(Alpine.onTint)
                        .frame(width: 64, height: 64).background(Alpine.tint, in: Circle())
                    Text("This link has a password").font(Theme.Text.title).foregroundStyle(Alpine.ink)
                    Text("Whoever shared it set one. Ask them if you don’t have it.").font(Theme.Text.callout).foregroundStyle(Alpine.inkMuted)
                        .multilineTextAlignment(.center)
                }
                .frame(maxWidth: .infinity).padding(.horizontal, Alpine.Space.s6)
                .bareRow(top: Alpine.Space.s8)
            }
            Section {
                SecureField("Password", text: $password).onSubmit { Task { await open() } }.alpineRow()
            } footer: {
                if wrongPassword { Text("That password didn’t work. Check it and try again.").foregroundStyle(Alpine.danger) }
            }
            Section {
                Button { Task { await open() } } label: { Text("Open").frame(maxWidth: .infinity) }
                    .buttonStyle(PrimaryCapsuleStyle()).disabled(password.isEmpty)
                    .bareRow()
            }
        }
    }

    @ViewBuilder private func problemView(_ problem: Problem) -> some View {
        switch problem {
        case .gone:
            EmptyStateView(symbol: "link", title: "This link no longer works",
                           message: "Whoever shared it turned it off, or it reached its end date. Ask them for a new link.")
        case .incomplete:
            EmptyStateView(symbol: "exclamationmark.triangle", danger: true, title: "This link is incomplete",
                           message: "The end of the link is missing, usually because it was cut off while copying. Paste the whole link.") {
                // The same paste field as Shared's: the whole link opens here, in place of the broken one.
                HStack(spacing: Alpine.Space.s2) {
                    Image(systemName: "doc.on.clipboard").foregroundStyle(Alpine.inkMuted).accessibilityHidden(true)
                    TextField("Paste the whole link", text: $retyped)
                        .textInputAutocapitalization(.never).autocorrectionDisabled().keyboardType(.URL)
                        .foregroundStyle(Alpine.ink)
                        .onSubmit(reopen)
                    Button("Open", action: reopen).buttonStyle(PrimaryCapsuleStyle())
                        .disabled(retyped.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                }
                .padding(.leading, Alpine.Space.s4).padding(.trailing, 4).padding(.vertical, 4)
                .background(Alpine.surface, in: Capsule())
                .highContrastEdge(Capsule())
            }
        case .failed:
            EmptyStateView(symbol: "exclamationmark.triangle", danger: true, title: "This link couldn’t be opened",
                           message: "Check your connection and try again. If it keeps happening, ask for a new link.") {
                Button("Try again") { self.problem = nil; Task { await start() } }.buttonStyle(PrimaryCapsuleStyle())
            }
        }
    }

    private func linkRow(_ item: Opened) -> some View {
        HStack(spacing: Alpine.Space.s3) {
            if item.isFolder {
                FolderGlyph().frame(width: Theme.mark * 0.9, height: Theme.mark * 0.9 * 46 / 56).frame(width: Theme.mark, height: Theme.mark)
            } else {
                PageGlyph(label: FileMark.label(for: item)).frame(width: Theme.mark * 0.66, height: Theme.mark * 0.66 * 54 / 44).frame(width: Theme.mark, height: Theme.mark)
            }
            VStack(alignment: .leading, spacing: 2) {
                Text(item.name).foregroundStyle(Alpine.ink).lineLimit(1)
                Text([item.size.map { formatBytes(Int64($0)) }, changedLabel(item.modified)].compactMap { $0 }.joined(separator: " · "))
                    .font(Theme.Text.footnote).foregroundStyle(Alpine.inkMuted).lineLimit(1)
            }
            Spacer(minLength: 0)
            if downloading == item.id { ProgressView().controlSize(.small) }
        }
        .frame(minHeight: Theme.row).contentShape(Rectangle())
    }

    private func fileRow(_ item: Opened) -> some View {
        Button { Task { await openFile(item) } } label: { linkRow(item) }
            .buttonStyle(.plain)
            .contextMenu {
                Button("Send a copy", systemImage: "square.and.arrow.up") {
                    Task {
                        guard let file = await linkFile(item) else { return }
                        TextPrompt.topController()?.present(UIActivityViewController(activityItems: [file], applicationActivities: nil), animated: true)
                    }
                }
                Button("Save a copy to my files", systemImage: "plus.square.on.square") {
                    if let linkVault { Task { await store.saveCopy(item, from: linkVault) } }
                }
            }
            .itemRow()
    }

    private func save() {
        guard let current, let linkVault else { return }
        Task { await store.saveCopy(current, from: linkVault) }
    }

    private func classify(_ error: Error) -> Problem {
        if case DriveAPIError.notFound = error { return .gone }
        if case DriveAPIError.transport = error { return .failed }
        if case DriveAPIError.server(let status, _) = error, status == 404 || status == 410 { return .gone }
        return .failed
    }

    private func start() async {
        if let vault, let folder {
            linkVault = vault
            root = folder
            await list(folder)
            return
        }
        let made: LinkVault
        do { made = try LinkVault(origin: model.origin, url: address) } catch {
            // The URL itself didn't parse: usually the key after the # was cut off.
            problem = .incomplete
            return
        }
        linkVault = made
        do {
            if try await made.needsPassword() { needsPassword = true } else { await open() }
        } catch {
            problem = classify(error)
        }
    }

    private func open() async {
        guard let linkVault else { return }
        do {
            let opened = try await linkVault.open(password: needsPassword ? password : nil)
            root = opened
            needsPassword = false
            wrongPassword = false
            if opened.isFolder { await list(opened) } else { loaded = true }
        } catch {
            if needsPassword {
                wrongPassword = true
                password = ""
            } else {
                problem = classify(error)
            }
        }
    }

    private func list(_ folder: Opened) async {
        guard let linkVault else { return }
        do { children = try await linkVault.children(of: folder.id) } catch { problem = classify(error) }
        loaded = true
    }

    private func openFile(_ item: Opened) async {
        if let file = await linkFile(item) { preview = file }
    }

    /* The plain file behind a link's row, fetched once per version. */
    private func linkFile(_ item: Opened) async -> URL? {
        guard let linkVault else { return nil }
        // Per version: a replaced file is fetched anew, and a resumed partial never mixes two versions.
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent("links/\(item.id)/\(item.node.currentVersion?.id ?? "none")", isDirectory: true)
        try? FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let file = directory.appendingPathComponent(item.name)
        if !FileManager.default.fileExists(atPath: file.path) {
            downloading = item.id
            defer { downloading = nil }
            do { try await linkVault.download(item, to: file) } catch {
                store.notify("Couldn’t open “\(item.name)”. Check your connection and try again.")
                return nil
            }
        }
        return file
    }
}

struct LinkTarget: Hashable {
    let url: String
    let folder: Opened?
}

/* MARK: Report */

/*
 * Reporting something shared or linked, with the web's words: the people who run this
 * HushOS can then open it, and whoever shared it isn't told who reported it.
 */
struct ReportSheet: View {
    @Environment(\.dismiss) private var dismiss
    let item: Opened
    var from: String?
    let submit: (String, String, String?) async throws -> Bool

    static let categories: [(id: String, label: String)] = [
        ("csam", "Child sexual abuse material"),
        ("terrorism", "Terrorist or violent extremist content"),
        ("ncii", "Intimate images shared without consent"),
        ("malware", "Malware or phishing"),
        ("copyright", "Copyright infringement"),
        ("harassment", "Harassment or threats"),
        ("other", "Something else"),
    ]

    @State private var category = ""
    @State private var reason = ""
    @State private var email = ""
    @State private var pending = false
    @State private var error = ""
    @State private var done: Bool?

    var body: some View {
        NavigationStack {
            Form {
                if let duplicate = done {
                    Section {
                        VStack(spacing: Alpine.Space.s3) {
                            Image(systemName: "checkmark.circle").font(.largeTitle).foregroundStyle(Alpine.success)
                                .frame(width: 64, height: 64).background(Alpine.successSoft, in: Circle())
                            Text(duplicate ? "Already reported" : "Report sent").font(Theme.Text.title).foregroundStyle(Alpine.ink)
                            Text(duplicate
                                 ? "You’ve reported “\(item.name)” before. They have it; there’s nothing more to do."
                                 : "Thank you. The people who run this HushOS can now open “\(item.name)” and will look at it.")
                                .font(Theme.Text.callout).foregroundStyle(Alpine.inkMuted).multilineTextAlignment(.center)
                        }
                        .frame(maxWidth: .infinity).listRowBackground(Color.clear)
                    }
                } else {
                    Section {} header: {
                        Text("Reporting lets the people who run this HushOS open \(item.isFolder ? "this folder and everything inside it" : "this file"), so they can look. \(from.map { "\($0.split(separator: " ").first.map(String.init) ?? $0) isn’t" } ?? "Whoever shared it isn’t") told who reported it.")
                            .font(Theme.Text.callout).foregroundStyle(Alpine.inkMuted).textCase(nil)
                    }
                    Section {
                        Picker("What is it?", selection: $category) {
                            Text("Choose what it is").tag("")
                            ForEach(Self.categories, id: \.id) { Text($0.label).tag($0.id) }
                        }
                        .pickerStyle(.menu)
                        .alpineRow()
                    }
                    Section("What’s wrong with it?") {
                        TextField("What you saw, and where inside it", text: $reason, axis: .vertical).lineLimit(3 ... 8).alpineRow()
                    }
                    Section {
                        TextField("Your email (optional)", text: $email).keyboardType(.emailAddress).textInputAutocapitalization(.never).alpineRow()
                    } footer: {
                        Text("Only if you want to hear back.")
                    }
                    if !error.isEmpty { Section { Text("Couldn’t send the report. \(error)").foregroundStyle(Alpine.danger).alpineRow() } }
                    Section {
                        Button { send() } label: { Text(pending ? "Sending…" : "Send report").frame(maxWidth: .infinity) }
                            .buttonStyle(PrimaryCapsuleStyle())
                            .disabled(pending || category.isEmpty || reason.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                    }
                    .listRowBackground(Color.clear).listRowInsets(EdgeInsets())
                }
            }
            .alpineGrouped()
            .scrollDismissesKeyboard(.immediately)
            .navigationTitle("Report “\(item.name)”")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: done == nil ? .cancellationAction : .confirmationAction) { Button(done == nil ? "Cancel" : "Done") { dismiss() } }
                if done == nil {
                    ToolbarItem(placement: .confirmationAction) {
                        Button(pending ? "Sending…" : "Send") { send() }
                            .disabled(pending || category.isEmpty || reason.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                    }
                }
            }
        }
        .presentationDetents([.large])
    }

    private func send() {
        pending = true
        error = ""
        Task {
            do {
                done = try await submit(category, reason.trimmingCharacters(in: .whitespacesAndNewlines), email.isEmpty ? nil : email)
            } catch {
                self.error = (error as? LocalizedError)?.errorDescription ?? error.localizedDescription
            }
            pending = false
        }
    }
}
