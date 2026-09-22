import HushOSKit
import QuickLook
import SwiftUI
import UIKit

/* Sharing one item: the people it is shared with, the links to it, and ways to add either. */
struct ShareItemSheet: View {
    @Environment(DriveStore.self) private var store
    @Environment(\.dismiss) private var dismiss
    let item: Opened
    @State private var links: [LinkView] = []
    @State private var loaded = false
    @State private var withPassword = false
    @State private var password = ""
    @State private var expiry = 0
    @State private var pending = false
    @State private var error = ""
    @State private var copied: String?
    @State private var urls: [String: URL] = [:]
    @State private var shares: [ShareView] = []
    @State private var pins: [ContactPin] = []
    @State private var chosen: ContactPin?
    @State private var role = "viewer"
    @State private var sharing = false
    @State private var showingContacts = false

    private let expiries: [(label: String, days: Int?)] = [("Never expires", nil), ("7 days", 7), ("30 days", 30)]

    var body: some View {
        NavigationStack {
            Form {
                if !error.isEmpty { Section { Text(error).foregroundStyle(.red) } }
                Section {
                    ForEach(shares) { share in
                        HStack {
                            VStack(alignment: .leading, spacing: 2) {
                                Text(share.grantee.name.isEmpty ? share.grantee.email : share.grantee.name)
                                Text("\(share.grantee.email) · \(share.role == "editor" ? "Can edit" : "Can view")\(share.suite == 2 ? " · post-quantum" : "")")
                                    .font(.footnote).foregroundStyle(.secondary)
                            }
                            Spacer()
                            Button("Revoke", role: .destructive) { revoke(share) }.font(.subheadline).buttonStyle(.borderless)
                        }
                    }
                    if pins.isEmpty {
                        Button("Pin a contact to share with them…") { showingContacts = true }
                    } else {
                        Picker("Person", selection: $chosen) {
                            Text("Choose a contact").tag(ContactPin?.none)
                            ForEach(pins) { pin in Text(pin.name.isEmpty ? pin.email : pin.name).tag(ContactPin?.some(pin)) }
                        }
                        Picker("Access", selection: $role) {
                            Text("Can view").tag("viewer")
                            Text("Can edit").tag("editor")
                        }
                        .pickerStyle(.segmented)
                        HStack {
                            Button(sharing ? "Sharing…" : "Share with this person") { shareWithContact() }.disabled(sharing || chosen == nil)
                            Spacer()
                            Button("Contacts") { showingContacts = true }.buttonStyle(.borderless)
                        }
                    }
                } header: {
                    Text("People")
                } footer: {
                    Text("Pick someone from your contacts. You can stop sharing at any time.")
                }
                Section {
                    if loaded && links.isEmpty { Text("No links yet.").foregroundStyle(.secondary) }
                    ForEach(links) { link in
                        VStack(alignment: .leading, spacing: 4) {
                            HStack {
                                Image(systemName: link.hasPassword ? "lock.fill" : "link").foregroundStyle(.secondary)
                                Text(describe(link)).font(.subheadline)
                            }
                            HStack(spacing: 16) {
                                Button(copied == link.id ? "Copied" : "Copy link") { copy(link) }
                                if let url = urls[link.id] {
                                    ShareLink(item: url) { Text("Share") }
                                }
                                Spacer()
                                Button("Revoke", role: .destructive) { revoke(link) }
                            }
                            .font(.subheadline)
                            .buttonStyle(.borderless)
                        }
                        .padding(.vertical, 2)
                    }
                } header: {
                    Text("Links")
                } footer: {
                    Text("Anyone with the link can open this \(item.isFolder ? "folder" : "file") until you turn the link off.")
                }
                Section("New link") {
                    Toggle("Password", isOn: $withPassword)
                    if withPassword { SecureField("Link password", text: $password) }
                    Picker("Expires", selection: $expiry) {
                        ForEach(expiries.indices, id: \.self) { Text(expiries[$0].label).tag($0) }
                    }
                    Button(pending ? "Creating…" : "Create link") { create() }
                        .disabled(pending || (withPassword && password.isEmpty))
                }
            }
            .navigationTitle("Share “\(item.name)”")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } } }
            .sheet(isPresented: $showingContacts, onDismiss: { Task { pins = (try? await store.vault.contacts()) ?? [] } }) {
                ContactsView().environment(store)
            }
            .task { await load() }
        }
        .presentationDetents([.large])
    }

    private func shareWithContact() {
        guard let chosen else { return }
        sharing = true
        error = ""
        Task {
            do {
                _ = try await store.vault.share(item, with: chosen, role: role)
                self.chosen = nil
                await load()
            } catch {
                self.error = (error as? LocalizedError)?.errorDescription ?? error.localizedDescription
            }
            sharing = false
        }
    }

    private func revoke(_ share: ShareView) {
        Task {
            do {
                try await store.revokeAndRotate(share, for: item)
                await load()
            } catch {
                self.error = (error as? LocalizedError)?.errorDescription ?? error.localizedDescription
            }
        }
    }

    private func describe(_ link: LinkView) -> String {
        var parts: [String] = []
        if let created = parseDate(link.createdAt) { parts.append("Made " + created.formatted(date: .abbreviated, time: .shortened)) }
        parts.append(link.useCount == 1 ? "opened once" : "opened \(link.useCount) times")
        if let expires = parseDate(link.expiresAt) { parts.append("expires " + expires.formatted(date: .abbreviated, time: .omitted)) }
        return parts.joined(separator: " · ")
    }

    private func load() async {
        do {
            shares = try await store.vault.shares(of: item)
            pins = try await store.vault.contacts()
            links = try await store.vault.links(for: item)
            var found: [String: URL] = [:]
            for link in links {
                if let url = try? await store.vault.linkURL(link, for: item) { found[link.id] = url }
            }
            urls = found
            error = ""
        } catch {
            self.error = (error as? LocalizedError)?.errorDescription ?? error.localizedDescription
        }
        loaded = true
    }

    private func copy(_ link: LinkView) {
        guard let url = urls[link.id] else {
            error = "This link was made before its secret was kept; revoke it and make a new one."
            return
        }
        UIPasteboard.general.url = url
        copied = link.id
    }

    private func create() {
        pending = true
        error = ""
        Task {
            do {
                let expiresAt = expiries[expiry].days.map { Calendar.current.date(byAdding: .day, value: $0, to: Date()) ?? Date() }
                let made: (link: LinkView, url: URL)
                do {
                    made = try await store.vault.createLink(for: item, password: withPassword ? password : nil, expiresAt: expiresAt)
                } catch let failure as DriveAPIError {
                    // Rotated elsewhere since this device listed it: read it again and seal at the current epoch.
                    guard case .server(409, _) = failure, let fresh = try await store.reload(item) else { throw failure }
                    made = try await store.vault.createLink(for: fresh, password: withPassword ? password : nil, expiresAt: expiresAt)
                }
                UIPasteboard.general.url = made.url
                copied = made.link.id
                password = ""
                withPassword = false
                await load()
            } catch {
                self.error = (error as? LocalizedError)?.errorDescription ?? error.localizedDescription
            }
            pending = false
        }
    }

    private func revoke(_ link: LinkView) {
        Task {
            do {
                try await store.vault.revokeLink(link, for: item)
                await load()
            } catch {
                self.error = (error as? LocalizedError)?.errorDescription ?? error.localizedDescription
            }
        }
    }
}

/* A link someone pasted or opened: the password gate, then the folder or file behind it. */
struct LinkBrowserView: View {
    @Environment(AppModel.self) private var model
    let url: String
    var folder: Opened? = nil
    var vault: LinkVault? = nil

    @State private var linkVault: LinkVault?
    @State private var root: Opened?
    @State private var children: [Opened] = []
    @State private var loaded = false
    @State private var needsPassword = false
    @State private var password = ""
    @State private var failure: String?
    @State private var preview: URL?
    @State private var downloading: String?
    @State private var reporting = false

    private var current: Opened? { folder ?? root }

    var body: some View {
        List {
            if let failure {
                Text(failure).foregroundStyle(.secondary)
            } else if needsPassword {
                Section {
                    SecureField("Link password", text: $password)
                    Button("Open") { Task { await open() } }.disabled(password.isEmpty)
                } footer: {
                    Text("Whoever shared this link set a password on it.")
                }
            } else if let current, !current.isFolder {
                Section {
                    Button { Task { await openFile(current) } } label: { NodeRowPlain(item: current) }
                        .buttonStyle(.plain)
                }
            } else {
                if loaded && children.isEmpty { Text("This folder is empty.").foregroundStyle(.secondary) }
                ForEach(children) { child in
                    if child.isFolder {
                        NavigationLink(value: LinkTarget(url: url, folder: child)) { NodeRowPlain(item: child) }
                    } else {
                        Button { Task { await openFile(child) } } label: {
                            HStack {
                                NodeRowPlain(item: child)
                                if downloading == child.id { Spacer(); ProgressView() }
                            }
                        }
                        .buttonStyle(.plain)
                    }
                }
            }
        }
        .listStyle(.insetGrouped)
        .navigationTitle(current?.name ?? "Shared link")
        .navigationBarTitleDisplayMode(.inline)
        .navigationDestination(for: LinkTarget.self) { target in
            LinkBrowserView(url: target.url, folder: target.folder, vault: linkVault)
        }
        .toolbar {
            if current != nil {
                ToolbarItem(placement: .topBarTrailing) {
                    Menu {
                        Button("Report…", systemImage: "flag") { reporting = true }
                    } label: { Image(systemName: "ellipsis.circle") }
                }
            }
        }
        .sheet(isPresented: $reporting) {
            if let root, let linkVault {
                ReportSheet(item: root) { category, reason, email in
                    try await linkVault.report(root, category: category, reason: reason, email: email)
                }
            }
        }
        .quickLookPreview($preview)
        .task { await start() }
    }

    private func start() async {
        if let vault, let folder {
            linkVault = vault
            root = folder
            await list(folder)
            return
        }
        do {
            let vault = try LinkVault(origin: model.origin, url: url)
            linkVault = vault
            if try await vault.needsPassword() {
                needsPassword = true
            } else {
                await open()
            }
        } catch {
            failure = (error as? LocalizedError)?.errorDescription ?? error.localizedDescription
        }
    }

    private func open() async {
        guard let linkVault else { return }
        do {
            let opened = try await linkVault.open(password: needsPassword ? password : nil)
            root = opened
            needsPassword = false
            failure = nil
            if opened.isFolder { await list(opened) } else { loaded = true }
        } catch {
            failure = needsPassword ? nil : ((error as? LocalizedError)?.errorDescription ?? error.localizedDescription)
            if needsPassword { password = "" }
        }
    }

    private func list(_ folder: Opened) async {
        guard let linkVault else { return }
        do {
            children = try await linkVault.children(of: folder.id)
        } catch {
            failure = (error as? LocalizedError)?.errorDescription ?? error.localizedDescription
        }
        loaded = true
    }

    private func openFile(_ item: Opened) async {
        guard let linkVault else { return }
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent("links/\(item.id)", isDirectory: true)
        try? FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let file = directory.appendingPathComponent(item.name)
        if !FileManager.default.fileExists(atPath: file.path) {
            downloading = item.id
            do {
                try await linkVault.download(item, to: file)
            } catch {
                failure = (error as? LocalizedError)?.errorDescription ?? error.localizedDescription
                downloading = nil
                return
            }
            downloading = nil
        }
        preview = file
    }
}

struct LinkTarget: Hashable {
    let url: String
    let folder: Opened
}

/* A row without the store's tags or thumbnails: link and report views have neither. */
struct NodeRowPlain: View {
    let item: Opened

    var body: some View {
        HStack(spacing: 12) {
            Image(systemName: item.isFolder ? "folder.fill" : "doc")
                .font(.title2).foregroundStyle(item.isFolder ? Color.accentColor : Color.secondary).frame(width: 40, height: 40)
            VStack(alignment: .leading, spacing: 2) {
                Text(item.name).lineLimit(1)
                Text(subtitle).font(.footnote).foregroundStyle(.secondary).lineLimit(1)
            }
        }
    }

    private var subtitle: String {
        var parts: [String] = []
        if let modified = item.modified { parts.append(modified.formatted(date: .abbreviated, time: .shortened)) }
        if item.isFolder { parts.append("Folder") } else if let size = item.size { parts.append(formatBytes(Int64(size))) }
        return parts.joined(separator: " · ")
    }
}

/* Reporting something shared or linked: the category, the reason, and the key sealed to the operators. */
struct ReportSheet: View {
    @Environment(\.dismiss) private var dismiss
    let item: Opened
    let submit: (String, String, String?) async throws -> Bool
    @State private var category = "other"
    @State private var reason = ""
    @State private var email = ""
    @State private var pending = false
    @State private var error = ""
    @State private var done = false

    var body: some View {
        NavigationStack {
            Form {
                if done {
                    Section {
                        Text("Thank you. The operators can now open “\(item.name)” and act on it.")
                    }
                } else {
                    if !error.isEmpty { Section { Text(error).foregroundStyle(.red) } }
                    Section {
                        Picker("Category", selection: $category) {
                            ForEach(Reports.categories, id: \.id) { Text($0.label).tag($0.id) }
                        }
                    }
                    Section {
                        TextField("What is wrong with it?", text: $reason, axis: .vertical).lineLimit(3 ... 8)
                    } footer: {
                        Text("Reporting seals the key of “\(item.name)” to the HushOS operators, and to nobody else, so they can look at it.")
                    }
                    Section {
                        TextField("Email (optional)", text: $email).keyboardType(.emailAddress).textInputAutocapitalization(.never)
                    } footer: {
                        Text("Only if you want to hear back.")
                    }
                }
            }
            .navigationTitle("Report")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button(done ? "Done" : "Cancel") { dismiss() } }
                if !done {
                    ToolbarItem(placement: .confirmationAction) {
                        Button(pending ? "Sending…" : "Send") { send() }
                            .disabled(pending || reason.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
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
                _ = try await submit(category, reason.trimmingCharacters(in: .whitespacesAndNewlines), email.isEmpty ? nil : email)
                done = true
            } catch {
                self.error = (error as? LocalizedError)?.errorDescription ?? error.localizedDescription
            }
            pending = false
        }
    }
}

/* The 24 words, laid out to be copied by hand. */
struct PhraseView: View {
    let phrase: String

    var body: some View {
        let words = phrase.split(separator: " ").map(String.init)
        LazyVGrid(columns: [GridItem(.flexible()), GridItem(.flexible())], alignment: .leading, spacing: 6) {
            ForEach(words.indices, id: \.self) { index in
                HStack(spacing: 6) {
                    Text("\(index + 1).").font(.caption.monospacedDigit()).foregroundStyle(.secondary).frame(width: 24, alignment: .trailing)
                    Text(words[index]).font(.body.monospaced())
                }
            }
        }
    }
}

struct RecoveryPhraseSheet: View {
    @Environment(DriveStore.self) private var store
    @Environment(\.dismiss) private var dismiss
    @State private var phrase: String?
    @State private var error = ""

    var body: some View {
        NavigationStack {
            Form {
                if let phrase {
                    Section {
                        PhraseView(phrase: phrase)
                        Button("Copy") { UIPasteboard.general.string = phrase }
                    } footer: {
                        Text("These 24 words open your account if you forget your password. Keep them somewhere safe and offline; anyone who has them has your files.")
                    }
                } else if !error.isEmpty {
                    Text(error).foregroundStyle(.red)
                } else {
                    ProgressView("Opening…")
                }
            }
            .navigationTitle("Recovery phrase")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } } }
            .task {
                do { phrase = try await store.vault.recoveryPhrase() } catch {
                    self.error = (error as? LocalizedError)?.errorDescription ?? error.localizedDescription
                }
            }
        }
    }
}

struct RotateKeysSheet: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    @State private var password = ""
    @State private var pending = false
    @State private var error = ""
    @State private var phrase: String?

    var body: some View {
        NavigationStack {
            Form {
                if let phrase {
                    Section {
                        PhraseView(phrase: phrase)
                        Button("Copy") { UIPasteboard.general.string = phrase }
                    } header: {
                        Text("Your new recovery phrase")
                    } footer: {
                        Text("Your keys were rotated. The old recovery phrase no longer works; write these 24 words down before you leave.")
                    }
                } else {
                    if !error.isEmpty { Section { Text(error).foregroundStyle(.red) } }
                    Section {
                        SecureField("Password", text: $password).textContentType(.password)
                    } footer: {
                        Text("A fresh account key replaces the current one. Your identity and workspace keys are sealed again under it, a new recovery phrase is made, and every other session is signed out. Files, shares and links do not change.")
                    }
                }
            }
            .navigationTitle("Rotate keys")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                if phrase != nil {
                    ToolbarItem(placement: .confirmationAction) { Button("I wrote it down") { dismiss() } }
                } else {
                    ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                    ToolbarItem(placement: .confirmationAction) {
                        Button(pending ? "Rotating…" : "Rotate") { rotate() }.disabled(pending || password.isEmpty)
                    }
                }
            }
            .interactiveDismissDisabled(phrase != nil)
        }
    }

    private func rotate() {
        pending = true
        error = ""
        Task {
            do {
                let made = try await Auth.rotateKeys(password: password)
                // Every session ended with the rotation; sign in again under the new key.
                if let email = model.user?.email { try await model.signIn(email: email, password: password) }
                phrase = made
            } catch {
                self.error = (error as? LocalizedError)?.errorDescription ?? error.localizedDescription
            }
            pending = false
        }
    }
}

/* Who this account trusts: pins made after comparing fingerprints, and a way to look someone up. */
struct ContactsView: View {
    @Environment(DriveStore.self) private var store
    @Environment(\.dismiss) private var dismiss
    @State private var own: String?
    @State private var pins: [ContactPin] = []
    @State private var email = ""
    @State private var lookup: Lookup?
    @State private var busy = false
    @State private var error = ""

    var body: some View {
        NavigationStack {
            Form {
                if !error.isEmpty { Section { Text(error).foregroundStyle(.red) } }
                Section {
                    Text(own ?? "…").font(.body.monospaced())
                } header: {
                    Text("Your fingerprint")
                } footer: {
                    Text("Read it to the other person over a call or in person; they compare it with what HushOS shows them for you.")
                }
                Section("Look someone up") {
                    HStack {
                        TextField("Email", text: $email).keyboardType(.emailAddress).textInputAutocapitalization(.never).autocorrectionDisabled()
                        Button(busy ? "…" : "Look up") { find() }.disabled(busy || !email.contains("@"))
                    }
                    if let lookup {
                        VStack(alignment: .leading, spacing: 6) {
                            Text(lookup.contact.name.isEmpty ? lookup.contact.email : lookup.contact.name).font(.headline)
                            Text(lookup.contact.email).font(.footnote).foregroundStyle(.secondary)
                            Text(lookup.contact.fingerprint).font(.footnote.monospaced())
                            Text(lookup.contact.kem == nil ? "No post-quantum key yet" : (lookup.contact.kemSigned ? "Post-quantum key signed by this identity" : "Post-quantum key not signed: ignored"))
                                .font(.footnote).foregroundStyle(lookup.contact.kem != nil && !lookup.contact.kemSigned ? .red : .secondary)
                            if lookup.changed {
                                Text("This key differs from the one you pinned. Check the fingerprint with them before pinning again.").font(.footnote).foregroundStyle(.red)
                            } else if lookup.pinned != nil {
                                Text("Pinned").font(.footnote).foregroundStyle(.green)
                            }
                            Button(lookup.pinned == nil ? "Pin contact" : "Pin again") { pin(lookup.contact) }.disabled(busy)
                        }
                    }
                }
                Section("Pinned") {
                    if pins.isEmpty { Text("Nobody yet.").foregroundStyle(.secondary) }
                    ForEach(pins) { pin in
                        VStack(alignment: .leading, spacing: 2) {
                            Text(pin.name.isEmpty ? pin.email : pin.name)
                            Text(pin.email).font(.footnote).foregroundStyle(.secondary)
                            Text(pin.fingerprint).font(.caption.monospaced()).foregroundStyle(.secondary)
                        }
                        .swipeActions { Button("Unpin", role: .destructive) { unpin(pin) } }
                    }
                }
            }
            .navigationTitle("Contacts")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } } }
            .task { await load() }
        }
    }

    private func load() async {
        do {
            own = try await store.vault.ownFingerprint()
            pins = try await store.vault.contacts()
        } catch {
            self.error = (error as? LocalizedError)?.errorDescription ?? error.localizedDescription
        }
    }

    private func find() {
        busy = true
        error = ""
        Task {
            do { lookup = try await store.vault.lookup(email: email.trimmingCharacters(in: .whitespaces)) } catch {
                lookup = nil
                self.error = (error as? LocalizedError)?.errorDescription ?? error.localizedDescription
            }
            busy = false
        }
    }

    private func pin(_ contact: Contact) {
        busy = true
        Task {
            do {
                try await store.vault.pin(contact)
                lookup = try await store.vault.lookup(email: contact.email)
                pins = try await store.vault.contacts()
            } catch {
                self.error = (error as? LocalizedError)?.errorDescription ?? error.localizedDescription
            }
            busy = false
        }
    }

    private func unpin(_ pin: ContactPin) {
        Task {
            do {
                try await store.vault.unpin(pin)
                pins = try await store.vault.contacts()
            } catch {
                self.error = (error as? LocalizedError)?.errorDescription ?? error.localizedDescription
            }
        }
    }
}
