import CoreImage.CIFilterBuiltins
import HushOSKit
import SwiftUI
import UIKit

/*
 * "Who can open this?" (DESIGN.md, Components; the web's share dialog
 * for the behaviour): a field to add someone first, the people next, the links last.
 * Tapping a person shows what they can do and a labelled red way to stop; stopping and
 * turning a link off ask once and say afterwards what happened. Someone new is added
 * by their email and checked (their twelve words) without leaving the sheet.
 */
struct ShareItemSheet: View {
    @Environment(DriveStore.self) private var store
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    @State var item: Opened
    @State private var shares: [ShareView] = []
    @State private var pins: [ContactPin] = []
    @State private var links: [LinkView] = []
    @State private var urls: [String: URL] = [:]
    @State private var loaded = false
    @State private var error = ""
    @State private var query = ""
    @State private var chosen: ContactPin?
    @State private var role = "viewer"
    @State private var sharing = false
    @State private var adding: String?
    @State private var person: ShareView?
    @State private var making = false

    private var sharedIds: Set<String> { Set(shares.map(\.grantee.id)) }

    private var matches: [ContactPin] {
        let needle = query.trimmingCharacters(in: .whitespaces)
        return pins.filter { !sharedIds.contains($0.userId) }
            .filter { needle.isEmpty || "\($0.name) \($0.email)".localizedCaseInsensitiveContains(needle) }
            .sorted { $0.name.localizedCaseInsensitiveCompare($1.name) == .orderedAscending }
    }

    private var typedEmail: String? {
        let typed = query.trimmingCharacters(in: .whitespaces)
        guard typed.contains("@"), typed.contains("."), !pins.contains(where: { $0.email.caseInsensitiveCompare(typed) == .orderedSame }) else { return nil }
        return typed
    }

    /* People who reach this item through a folder above it, as the share index knows them. */
    private var inherited: [(grantee: ShareView.Grantee, folder: Opened)] {
        var found: [(ShareView.Grantee, Opened)] = []
        var cursor = item.node.parentId
        var steps = 0
        while let id = cursor, steps < 64 {
            if let entry = store.sharing[id], let folder = store.known(id) {
                for grantee in entry.people where !found.contains(where: { $0.0.id == grantee.id }) && !sharedIds.contains(grantee.id) {
                    found.append((grantee, folder))
                }
            }
            cursor = store.known(id)?.node.parentId
            steps += 1
        }
        return found
    }

    /* The nearest folder above with a link: its link opens this item too. */
    private var linkedAbove: Opened? {
        var cursor = item.node.parentId
        var steps = 0
        while let id = cursor, steps < 64 {
            if let entry = store.sharing[id], entry.links > 0, let folder = store.known(id) { return folder }
            cursor = store.known(id)?.node.parentId
            steps += 1
        }
        return nil
    }

    var body: some View {
        NavigationStack {
            List {
                if !error.isEmpty {
                    Text(error).font(Theme.Text.callout).foregroundStyle(Alpine.danger).alpineRow()
                }
                Section { addPeople } header: { EmptyView() }
                if let chosen {
                    Section {
                        Button { share(with: chosen) } label: { Text(sharing ? "Sharing…" : "Share").frame(maxWidth: .infinity) }
                            .buttonStyle(PrimaryCapsuleStyle()).disabled(sharing)
                            .bareRow(top: 0, bottom: 0)
                    }
                }
                Section {
                    HStack(spacing: Alpine.Space.s3) {
                        PersonAvatar(name: model.user?.name ?? "You", seed: model.user?.id ?? "")
                        VStack(alignment: .leading, spacing: 2) {
                            Text(model.user.map { $0.name.isEmpty ? "You" : "\($0.name) (you)" } ?? "You").foregroundStyle(Alpine.ink).lineLimit(1)
                            if let email = model.user?.email, !email.isEmpty { Text(email).font(Theme.Text.footnote).foregroundStyle(Alpine.inkMuted).lineLimit(1) }
                        }
                        Spacer()
                        Text("Owner").font(Theme.Text.callout).foregroundStyle(Alpine.inkMuted)
                    }
                    .frame(minHeight: Theme.row).itemRow()
                    ForEach(inherited, id: \.grantee.id) { entry in
                        HStack(spacing: Alpine.Space.s3) {
                            PersonAvatar(name: entry.grantee.name, seed: entry.grantee.id)
                            VStack(alignment: .leading, spacing: 2) {
                                Text(entry.grantee.name.isEmpty ? entry.grantee.email : entry.grantee.name).foregroundStyle(Alpine.ink).lineLimit(1)
                                Text("From the folder “\(entry.folder.name)”").font(Theme.Text.footnote).foregroundStyle(Alpine.inkMuted).lineLimit(1)
                            }
                        }
                        .frame(minHeight: Theme.row).itemRow()
                    }
                    // A link on a folder above opens this too: said here, and a tap shows that folder's sharing.
                    if let folder = linkedAbove {
                        Button { retarget(to: folder) } label: {
                            HStack(spacing: Alpine.Space.s3) {
                                Image(systemName: "link").font(.system(size: 15, weight: .semibold)).foregroundStyle(Alpine.primary)
                                    .frame(width: Theme.mark, height: Theme.mark).background(Alpine.tint, in: Circle())
                                VStack(alignment: .leading, spacing: 2) {
                                    Text("Anyone with the link").foregroundStyle(Alpine.ink)
                                    Text("From the folder “\(folder.name)”: its link opens everything inside").font(Theme.Text.footnote).foregroundStyle(Alpine.inkMuted)
                                }
                                Spacer(minLength: 0)
                                Image(systemName: "chevron.right").font(.footnote.weight(.semibold)).foregroundStyle(Alpine.inkMuted)
                            }
                            .frame(minHeight: Theme.row).contentShape(Rectangle())
                        }
                        .buttonStyle(.plain).itemRow()
                        .accessibilityHint("Shows who can open “\(folder.name)”")
                    }
                    ForEach(shares) { share in
                        Button { person = share } label: {
                            HStack(spacing: Alpine.Space.s3) {
                                PersonAvatar(name: share.grantee.name, seed: share.grantee.id)
                                VStack(alignment: .leading, spacing: 2) {
                                    Text(share.grantee.name.isEmpty ? share.grantee.email : share.grantee.name).foregroundStyle(Alpine.ink).lineLimit(1)
                                    Text(share.grantee.email).font(Theme.Text.footnote).foregroundStyle(Alpine.inkMuted).lineLimit(1)
                                }
                                Spacer(minLength: 0)
                                Text(share.role == "editor" ? "Can edit" : "Can view").font(Theme.Text.callout).foregroundStyle(Alpine.inkMuted)
                                Image(systemName: "chevron.right").font(.footnote.weight(.semibold)).foregroundStyle(Alpine.inkMuted)
                            }
                            .frame(minHeight: Theme.row).contentShape(Rectangle())
                        }
                        .buttonStyle(.plain).itemRow()
                    }
                } header: {
                    sectionTitle("People")
                }
                Section {
                    if loaded && links.isEmpty {
                        HStack(alignment: .top, spacing: Alpine.Space.s3) {
                            Image(systemName: "link").foregroundStyle(Alpine.inkMuted)
                            Text(linkedAbove == nil ? "No links. A link lets anyone who has it view “\(item.name)”, with a password or an end date if you like." : "No links of its own. A link here would open only “\(item.name)”.")
                                .font(Theme.Text.callout).foregroundStyle(Alpine.inkMuted)
                        }
                        .padding(.vertical, Alpine.Space.s2).alpineRow()
                    }
                    ForEach(links) { link in
                        LinkCard(item: item, link: link, url: urls[link.id], several: links.count > 1) { await load() }
                            .alpineRow()
                    }
                } header: {
                    HStack {
                        sectionTitle("Links")
                        Spacer()
                        Button { newLink() } label: { Label(making ? "Making…" : "New link", systemImage: "link.badge.plus") }
                            .font(Theme.Text.callout.weight(.semibold)).foregroundStyle(Alpine.primary)
                            .disabled(making || !loaded)
                            .textCase(nil)
                    }
                }
            }
            .listStyle(.insetGrouped)
            .alpineGrouped()
            .environment(\.defaultMinListRowHeight, 1)
            .navigationTitle("Who can open this?")
            .navigationSubtitle(Text(item.name))
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } } }
            .navigationDestination(item: $adding) { email in
                CheckContactView(email: email, intro: "Then you can share “\(item.name)” with them.") { pin in
                    adding = nil
                    query = ""
                    pins.append(pin)
                    chosen = pin
                    store.notify("\(pin.name.isEmpty ? pin.email : pin.name) added to people you share with")
                }
                .environment(store)
            }
            .sheet(item: $person) { share in
                PersonAccessSheet(item: item, share: share, pinned: pins.contains { $0.userId == share.grantee.id }) { await load() }
                    .environment(store)
            }
            .task { await load() }
        }
        .presentationDetents([.large])
    }

    private func sectionTitle(_ text: String) -> some View {
        Text(text).font(Theme.Text.title).foregroundStyle(Alpine.ink).textCase(nil).padding(.leading, -Alpine.Space.s1)
    }

    /* Type a name or an email; pick a contact, or add someone new by their email. */
    @ViewBuilder private var addPeople: some View {
        if let chosen {
            HStack(spacing: Alpine.Space.s3) {
                PersonAvatar(name: chosen.name, seed: chosen.userId)
                VStack(alignment: .leading, spacing: 2) {
                    Text(chosen.name.isEmpty ? chosen.email : chosen.name).foregroundStyle(Alpine.ink).lineLimit(1)
                    Text(chosen.email).font(Theme.Text.footnote).foregroundStyle(Alpine.inkMuted).lineLimit(1)
                }
                Spacer(minLength: 0)
                Menu {
                    Picker("What \(chosen.name) can do", selection: $role) {
                        Text("Can view").tag("viewer")
                        Text("Can edit").tag("editor")
                    }
                } label: {
                    HStack(spacing: 4) { Text(role == "editor" ? "Can edit" : "Can view"); Image(systemName: "chevron.up.chevron.down").font(.caption) }
                        .font(Theme.Text.callout.weight(.semibold)).foregroundStyle(Alpine.primary)
                }
                Button { self.chosen = nil } label: { Image(systemName: "xmark").foregroundStyle(Alpine.inkMuted).frame(width: 32, height: 32) }
                    .buttonStyle(.plain).accessibilityLabel("Choose someone else")
            }
            .frame(minHeight: Theme.row).itemRow()
        } else {
            HStack(spacing: Alpine.Space.s2) {
                Image(systemName: "person.badge.plus").foregroundStyle(Alpine.inkMuted)
                TextField("Add a name or email", text: $query)
                    .textInputAutocapitalization(.never).autocorrectionDisabled().keyboardType(.emailAddress)
                    .foregroundStyle(Alpine.ink)
                    .onSubmit { if let typedEmail { adding = typedEmail } else if matches.count == 1 { chosen = matches[0] } }
            }
            .padding(.horizontal, Alpine.Space.s4).frame(minHeight: Theme.control)
            .background(Alpine.surface, in: Capsule())
            // A field keeps a visible edge: faint normally, solid in high contrast.
            .overlay(Capsule().strokeBorder(Alpine.field.opacity(0.35), lineWidth: 1))
            .highContrastEdge(Capsule())
            .bareRow(top: 0, bottom: Alpine.Space.s1)
            if !query.trimmingCharacters(in: .whitespaces).isEmpty || pins.isEmpty {
                ForEach(matches.prefix(6)) { pin in
                    Button { chosen = pin; query = "" } label: {
                        HStack(spacing: Alpine.Space.s3) {
                            PersonAvatar(name: pin.name, seed: pin.userId, size: 32)
                            VStack(alignment: .leading, spacing: 1) {
                                Text(pin.name.isEmpty ? pin.email : pin.name).foregroundStyle(Alpine.ink)
                                Text(pin.email).font(Theme.Text.footnote).foregroundStyle(Alpine.inkMuted)
                            }
                        }
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain).alpineRow()
                }
                if let typedEmail {
                    Button { adding = typedEmail } label: { Label("Add \(typedEmail)", systemImage: "plus").foregroundStyle(Alpine.primary) }
                        .alpineRow()
                } else if matches.isEmpty {
                    Text(pins.isEmpty ? "Type their email to share with someone new." : "No one by that name yet. Type their full email to add them.")
                        .font(Theme.Text.footnote).foregroundStyle(Alpine.inkMuted).alpineRow()
                }
            }
        }
    }

    /* The same sheet, for the folder whose link or people reach this item. */
    private func retarget(to folder: Opened) {
        item = folder
        shares = []
        links = []
        urls = [:]
        loaded = false
        chosen = nil
        Task { await load() }
    }

    private func load() async {
        do {
            // Not `store.reload`: forgetting the item drops it from the catalogue until the next build.
            shares = try await store.vault.shares(of: item)
            pins = try await store.vault.contacts()
            links = try await store.vault.links(for: item).sorted { $0.createdAt < $1.createdAt }
            var found: [String: URL] = [:]
            for link in links { if let url = try? await store.vault.linkURL(link, for: item) { found[link.id] = url } }
            urls = found
            error = ""
        } catch {
            self.error = (error as? LocalizedError)?.errorDescription ?? error.localizedDescription
        }
        loaded = true
        await store.refreshSharing()
    }

    private func share(with pin: ContactPin) {
        sharing = true
        error = ""
        Task {
            do {
                _ = try await store.vault.share(item, with: pin, role: role)
                store.notify("\(pin.name.isEmpty ? pin.email : pin.name) \(role == "editor" ? "can edit" : "can view") “\(item.name)” now")
                chosen = nil
                role = "viewer"
                await load()
            } catch {
                self.error = (error as? LocalizedError)?.errorDescription ?? error.localizedDescription
            }
            sharing = false
        }
    }

    /* A link with no password and no end date, as the web makes it; Password and end date change it after. */
    private func newLink() {
        making = true
        error = ""
        Task {
            do {
                let made: (link: LinkView, url: URL)
                do {
                    made = try await store.vault.createLink(for: item, password: nil, expiresAt: nil)
                } catch let failure as DriveAPIError {
                    // Rotated elsewhere since this device listed it: read it again and seal at the current epoch.
                    guard case .server(409, _) = failure, let fresh = try await store.reload(item) else { throw failure }
                    item = fresh
                    made = try await store.vault.createLink(for: fresh, password: nil, expiresAt: nil)
                }
                urls[made.link.id] = made.url
                await load()
            } catch {
                self.error = "Couldn’t make a link. " + ((error as? LocalizedError)?.errorDescription ?? error.localizedDescription)
            }
            making = false
        }
    }
}

/* "Opened 3 times · ends 12 October · password", or "Not opened yet". */
func describeLink(_ link: LinkView) -> String {
    [
        link.useCount == 0 ? "Not opened yet" : "Opened \(link.useCount == 1 ? "once" : "\(link.useCount) times")",
        parseDate(link.expiresAt).map { "ends " + $0.formatted(.dateTime.day().month(.wide)) },
        link.hasPassword ? "password" : nil,
    ].compactMap { $0 }.joined(separator: " · ")
}

/* One link: what it does, how it has been used, Copy link, and the rest in a menu. */
private struct LinkCard: View {
    @Environment(DriveStore.self) private var store
    let item: Opened
    let link: LinkView
    let url: URL?
    let several: Bool
    let changed: () async -> Void
    @State private var copied = false
    @State private var qr = false
    @State private var options = false
    @State private var confirmOff = false
    @State private var busy = false

    var body: some View {
        VStack(alignment: .leading, spacing: Alpine.Space.s3) {
            HStack(spacing: Alpine.Space.s3) {
                // The link icon is the brand blue; the words stay ink.
                Image(systemName: "link").font(.body.weight(.semibold)).foregroundStyle(Alpine.primary)
                VStack(alignment: .leading, spacing: 2) {
                    Text("Anyone with the link can view").font(Theme.Text.callout.weight(.semibold)).foregroundStyle(Alpine.ink)
                    Text((several ? "Made \(changedLabel(parseDate(link.createdAt)) ?? "") · " : "") + describeLink(link))
                        .font(Theme.Text.footnote).foregroundStyle(Alpine.inkMuted).lineLimit(2)
                }
                Spacer(minLength: 0)
                Menu {
                    Button("Password and end date", systemImage: "key") { options = true }
                    Button(qr ? "Hide QR code" : "Show as QR code", systemImage: "qrcode") { qr.toggle() }.disabled(url == nil)
                    if let url { ShareLink(item: url) { Label("Send the link", systemImage: "square.and.arrow.up") } }
                    Divider()
                    Button("Turn off link", systemImage: "minus.circle", role: .destructive) { confirmOff = true }.tint(Alpine.danger)
                } label: {
                    Image(systemName: "ellipsis").font(.body.weight(.semibold)).foregroundStyle(Alpine.primary).frame(width: 36, height: 36)
                }
                .accessibilityLabel("More for this link")
            }
            Button { copy() } label: {
                Label(copied ? "Copied" : "Copy link", systemImage: copied ? "checkmark" : "doc.on.doc").frame(maxWidth: .infinity)
            }
            .buttonStyle(SecondaryCapsuleStyle())
            .disabled(busy)
            if qr, let url {
                VStack(spacing: Alpine.Space.s2) {
                    QRCodeView(text: url.absoluteString).frame(width: 180, height: 180)
                    Text("Whoever scans it can open “\(item.name)”\(link.hasPassword ? " with the password" : "").")
                        .font(Theme.Text.footnote).foregroundStyle(Alpine.inkMuted).multilineTextAlignment(.center)
                }
                .frame(maxWidth: .infinity).padding(Alpine.Space.s4)
                .background(Alpine.ground, in: RoundedRectangle(cornerRadius: Alpine.Radius.card))
            }
        }
        .padding(.vertical, Alpine.Space.s2)
        .sheet(isPresented: $options) {
            LinkOptionsSheet(item: item, link: link, turnOff: { options = false; confirmOff = true }, changed: changed).environment(store)
        }
        .alert("Turn off this link?", isPresented: $confirmOff) {
            Button("Cancel", role: .cancel) {}
            Button("Turn off link", role: .destructive) { turnOff() }
        } message: {
            Text("Anyone who has it can’t open “\(item.name)” any more. Other links keep working.")
        }
    }

    private func copy() {
        guard let url else {
            store.notify("This link was made before links could be shown again. Turn it off and make a new one.")
            return
        }
        UIPasteboard.general.url = url
        copied = true
        let until = parseDate(link.expiresAt).map { " until \($0.formatted(.dateTime.day().month(.wide)))" } ?? ""
        store.notify("Link copied. Anyone with it can view “\(item.name)”\(until).")
        Task {
            try? await Task.sleep(for: .seconds(2))
            copied = false
        }
    }

    private func turnOff() {
        busy = true
        Task {
            do {
                try await store.turnOffLink(link, for: item)
                store.notify("Link turned off. Anyone who has it can’t open “\(item.name)” any more.")
            } catch {
                store.notify("Couldn’t turn the link off. " + ((error as? LocalizedError)?.errorDescription ?? error.localizedDescription))
            }
            await changed()
            busy = false
        }
    }
}

/* Password and end date for one link. The address doesn't change; the password is typed on the opener's device. */
struct LinkOptionsSheet: View {
    @Environment(DriveStore.self) private var store
    @Environment(\.dismiss) private var dismiss
    let item: Opened
    let link: LinkView
    let turnOff: () -> Void
    let changed: () async -> Void
    @State private var password = ""
    @State private var removePassword = false
    /* "keep" leaves the end date as it is; the rest set a new one from today. */
    @State private var ends = "keep"
    @State private var saving = false
    @State private var error = ""

    private static let expiries: [(value: String, label: String, days: Int?)] = [("", "Never", nil), ("7", "7 days", 7), ("30", "30 days", 30), ("365", "A year", 365)]

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    SecureField(link.hasPassword ? "Keep the current password" : "None", text: $password)
                        .textContentType(.newPassword).disabled(removePassword).alpineRow()
                    if link.hasPassword { Toggle("Remove the password", isOn: $removePassword).alpineRow() }
                } header: {
                    Text("Password")
                } footer: {
                    Text("Whoever opens the link types it on their device. It never reaches us.")
                }
                Section("Ends") {
                    if let current = parseDate(link.expiresAt) {
                        choice("keep", current.formatted(.dateTime.day().month(.wide)))
                    }
                    ForEach(Self.expiries, id: \.value) { option in choice(option.value, option.label) }
                }
                if !error.isEmpty { Section { Text(error).foregroundStyle(Alpine.danger).alpineRow() } }
                Section {
                    Button("Turn off link", role: .destructive) { dismiss(); turnOff() }.alpineRow()
                }
            }
            .alpineGrouped()
            .navigationTitle("Password and end date")
            .navigationSubtitle(Text(item.name))
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) { Button(saving ? "Saving…" : "Save") { save() }.disabled(saving) }
            }
            .onAppear { ends = link.expiresAt == nil ? "" : "keep" }
        }
    }

    private func choice(_ value: String, _ label: String) -> some View {
        Button { ends = value } label: {
            HStack {
                Text(label).foregroundStyle(Alpine.ink)
                Spacer()
                if ends == value { Image(systemName: "checkmark").fontWeight(.semibold).foregroundStyle(Alpine.primary) }
            }
            .contentShape(Rectangle())
        }
        .accessibilityAddTraits(ends == value ? .isSelected : [])
        .alpineRow()
    }

    private func save() {
        saving = true
        error = ""
        let newPassword: String?? = removePassword ? .some(nil) : (password.isEmpty ? nil : .some(password))
        let expires: Date?? = {
            if ends == "keep" { return nil }
            if ends == (link.expiresAt == nil ? "" : "__") { return nil }
            guard let days = Self.expiries.first(where: { $0.value == ends })?.days else { return .some(nil) }
            return .some(Calendar.current.date(byAdding: .day, value: days, to: .now))
        }()
        Task {
            do {
                _ = try await store.vault.updateLink(link, for: item, password: newPassword, expiresAt: expires)
                store.notify("Link updated. The link itself is the same.")
                await changed()
                dismiss()
            } catch {
                self.error = (error as? LocalizedError)?.errorDescription ?? error.localizedDescription
            }
            saving = false
        }
    }
}

/* What tapping a person shows: the two roles with what they mean, and stopping as a labelled red button. */
private struct PersonAccessSheet: View {
    @Environment(DriveStore.self) private var store
    @Environment(\.dismiss) private var dismiss
    let item: Opened
    let share: ShareView
    let pinned: Bool
    let changed: () async -> Void
    @State private var stopping = false
    @State private var busy = false

    private var first: String { (share.grantee.name.isEmpty ? share.grantee.email : share.grantee.name).split(separator: " ").first.map(String.init) ?? "them" }

    var body: some View {
        NavigationStack {
            List {
                Section {
                    role("viewer", "Can view", "Open and download")
                    role("editor", "Can edit", item.isFolder ? "Add, rename and delete inside" : "Open, download and replace")
                } header: {
                    Text("Can open").font(Theme.Text.label).foregroundStyle(Alpine.inkMuted)
                } footer: {
                    if !pinned { Text("Add \(first) to people you share with to change what they can do.").font(Theme.Text.footnote).foregroundStyle(Alpine.inkMuted) }
                }
                Section {
                    Button { stopping = true } label: {
                        Text("Stop sharing with \(first)").font(.body.weight(.semibold)).foregroundStyle(Alpine.danger).frame(maxWidth: .infinity)
                    }
                    .disabled(busy)
                    .listRowBackground(Alpine.dangerSoft)
                }
            }
            .listStyle(.insetGrouped)
            .alpineGrouped()
            .navigationTitle(share.grantee.name.isEmpty ? share.grantee.email : share.grantee.name)
            .navigationSubtitle(Text(share.grantee.email))
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Back") { dismiss() } } }
            .alert("Stop sharing with \(first)?", isPresented: $stopping) {
                Button("Cancel", role: .cancel) {}
                Button("Stop sharing", role: .destructive) { stop() }
            } message: {
                Text("They can’t open “\(item.name)” in HushOS any more. Copies they already downloaded stay with them. You can share it again later.")
            }
        }
        .presentationDetents([.medium])
    }

    private func role(_ value: String, _ label: String, _ detail: String) -> some View {
        Button { change(to: value) } label: {
            HStack {
                VStack(alignment: .leading, spacing: 2) {
                    Text(label).foregroundStyle(Alpine.ink)
                    Text(detail).font(Theme.Text.footnote).foregroundStyle(Alpine.inkMuted)
                }
                Spacer()
                if share.role == value { Image(systemName: "checkmark").fontWeight(.semibold).foregroundStyle(Alpine.primary) }
            }
            .contentShape(Rectangle())
        }
        .disabled(busy || (!pinned && share.role != value))
        .accessibilityAddTraits(share.role == value ? .isSelected : [])
        .alpineRow()
    }

    /* A new role is the same share sealed again with it; the server replaces the old one. */
    private func change(to value: String) {
        guard value != share.role else { return }
        busy = true
        Task {
            do {
                guard let pin = try await store.vault.contacts().first(where: { $0.userId == share.grantee.id }) else { return }
                _ = try await store.vault.share(item, with: pin, role: value)
                store.notify("\(first) \(value == "editor" ? "can edit" : "can view") “\(item.name)” now")
                await changed()
                dismiss()
            } catch {
                store.notify("Couldn’t change what they can do. " + ((error as? LocalizedError)?.errorDescription ?? error.localizedDescription))
            }
            busy = false
        }
    }

    private func stop() {
        busy = true
        Task {
            do {
                try await store.revokeAndRotate(share, for: item)
                store.notify("\(share.grantee.name.isEmpty ? share.grantee.email : share.grantee.name) can’t open “\(item.name)” any more")
            } catch {
                store.notify("Couldn’t stop sharing. " + ((error as? LocalizedError)?.errorDescription ?? error.localizedDescription))
            }
            await changed()
            busy = false
            dismiss()
        }
    }
}

/* MARK: People */

/* A person as initials on one of the four avatar tints, picked from their id so it never changes. */
struct PersonAvatar: View {
    let name: String
    let seed: String
    var size: CGFloat = 36

    private var initials: String {
        let words = name.split(whereSeparator: { $0 == " " || $0 == "." || $0 == "@" })
        let letters = words.prefix(2).compactMap(\.first).map { String($0).uppercased() }.joined()
        return letters.isEmpty ? "?" : letters
    }

    private var tone: (Color, Color) {
        let tones = [(Alpine.avatar1, Alpine.onAvatar1), (Alpine.avatar2, Alpine.onAvatar2), (Alpine.avatar3, Alpine.onAvatar3), (Alpine.avatar4, Alpine.onAvatar4)]
        // The web's hash (31 * h + UTF-16 unit, 32-bit) and |h| mod n, so a person has one colour everywhere.
        let hash = seed.utf16.reduce(Int32(0)) { $0 &* 31 &+ Int32($1) }
        return tones[abs(Int(hash % Int32(tones.count)))]
    }

    var body: some View {
        Text(initials).font(.system(size: size * 0.38, weight: .semibold)).foregroundStyle(tone.1)
            .frame(width: size, height: size).background(tone.0, in: Circle())
            .accessibilityHidden(true)
    }
}

/* Twelve words in two columns, numbered, for reading aloud. */
struct FingerprintWordsView: View {
    let fingerprint: String

    var body: some View {
        let words = FingerprintWords.words(fingerprint) ?? []
        LazyVGrid(columns: [GridItem(.flexible()), GridItem(.flexible())], alignment: .leading, spacing: Alpine.Space.s2) {
            ForEach(words.indices, id: \.self) { index in
                HStack(spacing: 6) {
                    Text("\(index + 1)").font(.caption.monospacedDigit()).foregroundStyle(Alpine.inkMuted).frame(width: 18, alignment: .trailing)
                    Text(words[index]).font(.body.monospaced()).foregroundStyle(Alpine.ink)
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

/*
 * Adding someone: their email, then their twelve words to compare on a call or in
 * person. They match adds them; a changed account is a warning to accept, never
 * applied quietly; a key their account didn't sign can't be added.
 */
struct CheckContactView: View {
    @Environment(DriveStore.self) private var store
    @Environment(\.dismiss) private var dismiss
    @State var email: String
    var intro: String = "Then you can share with them. You’ll check it’s them first."
    let added: (ContactPin) -> Void
    @State private var found: Lookup?
    @State private var looking = false
    @State private var adding = false
    @State private var mismatch = false
    @State private var error = ""

    private var first: String { found.map { ($0.contact.name.isEmpty ? $0.contact.email : $0.contact.name).split(separator: " ").first.map(String.init) ?? "them" } ?? "them" }
    private var unsignedKem: Bool { found.map { $0.contact.kem != nil && !$0.contact.kemSigned } ?? false }

    var body: some View {
        List {
            if let found {
                Section {
                    HStack(spacing: Alpine.Space.s3) {
                        PersonAvatar(name: found.contact.name, seed: found.contact.userId, size: 44)
                        VStack(alignment: .leading, spacing: 2) {
                            Text(found.contact.name.isEmpty ? found.contact.email : found.contact.name).font(Theme.Text.headline).foregroundStyle(Alpine.ink)
                            Text(found.contact.email).font(Theme.Text.footnote).foregroundStyle(Alpine.inkMuted)
                        }
                    }
                    .alpineRow()
                }
                Section {
                    if found.changed {
                        Label("\(first)’s account has changed since you added them. That can be a new phone or a reset, or someone pretending. Check it’s them before you accept.", systemImage: "exclamationmark.shield")
                            .font(Theme.Text.callout).foregroundStyle(Alpine.danger).listRowBackground(Alpine.dangerSoft)
                    } else {
                        Text("Ask \(first) to open People you share with in HushOS and read you their twelve words, on a call or in person. If they match these, it’s really them.")
                            .font(Theme.Text.callout).foregroundStyle(Alpine.inkMuted).alpineRow()
                    }
                    FingerprintWordsView(fingerprint: found.contact.fingerprint).padding(.vertical, Alpine.Space.s2).alpineRow()
                    if unsignedKem {
                        Text("\(first)’s newest key isn’t signed by their account. Don’t add them; ask them to sign in again first.")
                            .font(Theme.Text.footnote).foregroundStyle(Alpine.danger).alpineRow()
                    }
                    if mismatch {
                        Text("Don’t share with this account. Check the email address with \(first), then try again.")
                            .font(Theme.Text.footnote).foregroundStyle(Alpine.danger).alpineRow()
                    }
                }
                if !error.isEmpty { Text(error).foregroundStyle(Alpine.danger).alpineRow() }
                Section {
                    if found.pinned != nil && !found.changed {
                        Button { if let pinned = found.pinned { added(pinned) } } label: { Text("Already in people you share with").frame(maxWidth: .infinity) }
                            .buttonStyle(PrimaryCapsuleStyle())
                    } else {
                        VStack(spacing: Alpine.Space.s2) {
                            Button { add() } label: {
                                Label(adding ? "Adding…" : found.changed ? "Accept change" : "They match", systemImage: "checkmark.shield").frame(maxWidth: .infinity)
                            }
                            .buttonStyle(PrimaryCapsuleStyle())
                            .disabled(adding || unsignedKem || mismatch)
                            Button { if mismatch { dismiss() } else { mismatch = true } } label: { Text(mismatch ? "Back" : "They don’t match").frame(maxWidth: .infinity) }
                                .buttonStyle(SecondaryCapsuleStyle())
                        }
                    }
                }
                .listRowBackground(Color.clear).listRowInsets(EdgeInsets())
            } else {
                Section {
                    TextField("them@example.com", text: $email)
                        .keyboardType(.emailAddress).textInputAutocapitalization(.never).autocorrectionDisabled()
                        .onSubmit(lookUp).alpineRow()
                } header: {
                    Text(intro).textCase(nil)
                } footer: {
                    Text(error.isEmpty ? "The email they use for HushOS." : error).foregroundStyle(error.isEmpty ? Alpine.inkMuted : Alpine.danger)
                }
                Section {
                    Button { lookUp() } label: { Text(looking ? "Looking up…" : "Look up").frame(maxWidth: .infinity) }
                        .buttonStyle(PrimaryCapsuleStyle()).disabled(looking || email.trimmingCharacters(in: .whitespaces).isEmpty)
                }
                .listRowBackground(Color.clear).listRowInsets(EdgeInsets())
            }
        }
        .listStyle(.insetGrouped)
        .alpineGrouped()
        .navigationTitle("Add someone")
        .navigationBarTitleDisplayMode(.inline)
        .task { if !email.isEmpty, found == nil { lookUp() } }
    }

    private func lookUp() {
        looking = true
        error = ""
        Task {
            do { found = try await store.vault.lookup(email: email.trimmingCharacters(in: .whitespaces)) } catch {
                self.error = (error as? LocalizedError)?.errorDescription ?? "Check the address and try again."
            }
            looking = false
        }
    }

    private func add() {
        guard let found else { return }
        adding = true
        Task {
            do {
                try await store.vault.pin(found.contact)
                guard let pin = try await store.vault.contacts().first(where: { $0.userId == found.contact.userId }) else { throw ContactError.unpinned }
                added(pin)
            } catch {
                self.error = "They weren’t saved. Try again."
            }
            adding = false
        }
    }
}

/* People you share with: your contacts, checking it's them, removing someone, and your own twelve words. */
struct PeopleView: View {
    @Environment(DriveStore.self) private var store
    @Environment(\.dismiss) private var dismiss
    @State private var pins: [ContactPin] = []
    @State private var own: String?
    @State private var loaded = false
    @State private var error: String?
    @State private var checking: ContactPin?
    @State private var removing: ContactPin?
    @State private var adding = false

    var body: some View {
        NavigationStack {
            List {
                Section {
                    if loaded && pins.isEmpty {
                        VStack(alignment: .leading, spacing: 4) {
                            Text("Nobody here yet").font(Theme.Text.headline).foregroundStyle(Alpine.ink)
                            Text("Add someone by their email, or add them while you share.").font(Theme.Text.footnote).foregroundStyle(Alpine.inkMuted)
                        }
                        .padding(.vertical, Alpine.Space.s2).alpineRow()
                    }
                    if let error { Text(error).foregroundStyle(Alpine.danger).alpineRow() }
                    ForEach(pins) { pin in
                        Menu {
                            Button("Check it’s them", systemImage: "checkmark.shield") { checking = pin }
                            Divider()
                            Button("Remove", systemImage: "person.badge.minus", role: .destructive) { removing = pin }.tint(Alpine.danger)
                        } label: {
                            HStack(spacing: Alpine.Space.s3) {
                                PersonAvatar(name: pin.name, seed: pin.userId)
                                VStack(alignment: .leading, spacing: 2) {
                                    Text(pin.name.isEmpty ? pin.email : pin.name).foregroundStyle(Alpine.ink).lineLimit(1)
                                    Text(pin.email).font(Theme.Text.footnote).foregroundStyle(Alpine.inkMuted).lineLimit(1)
                                }
                                Spacer(minLength: 0)
                                if let added = parseDate(pin.pinnedAt) {
                                    Text("Added \(changedLabel(added) ?? "")").font(Theme.Text.footnote).foregroundStyle(Alpine.inkMuted)
                                }
                            }
                            .frame(minHeight: Theme.row).contentShape(Rectangle())
                        }
                        .accessibilityLabel("More for \(pin.name)")
                        .itemRow()
                    }
                } header: {
                    Text("People you can share with. Check it’s them before you share anything sensitive.").font(Theme.Text.callout).foregroundStyle(Alpine.inkMuted).textCase(nil)
                }
                Section {
                    Button { adding = true } label: { Label("Add someone", systemImage: "person.badge.plus").foregroundStyle(Alpine.primary) }.alpineRow()
                }
                Section {
                    if let own { FingerprintWordsView(fingerprint: own).padding(.vertical, Alpine.Space.s2).alpineRow() } else { ProgressView().alpineRow() }
                } header: {
                    Text("Your twelve words").font(Theme.Text.label).foregroundStyle(Alpine.inkMuted)
                } footer: {
                    Text("When someone adds you, they’ll ask you to read these. They’re the same on all your devices.").font(Theme.Text.footnote).foregroundStyle(Alpine.inkMuted)
                }
            }
            .listStyle(.insetGrouped)
            .alpineGrouped()
            .environment(\.defaultMinListRowHeight, 1)
            .navigationTitle("People you share with")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } } }
            .navigationDestination(isPresented: $adding) {
                CheckContactView(email: "") { pin in
                    adding = false
                    store.notify("\(pin.name.isEmpty ? pin.email : pin.name) added")
                    Task { await load() }
                }
                .environment(store)
            }
            .sheet(item: $checking) { pin in CheckItsThemSheet(pin: pin) }
            .alert(removing.map { "Remove \(firstName($0))?" } ?? "", isPresented: Binding(get: { removing != nil }, set: { if !$0 { removing = nil } })) {
                Button("Cancel", role: .cancel) { removing = nil }
                Button("Remove", role: .destructive) {
                    guard let pin = removing else { return }
                    removing = nil
                    Task {
                        do {
                            try await store.vault.unpin(pin)
                            store.notify("\(firstName(pin)) removed")
                        } catch {
                            store.notify("Couldn’t remove them. " + ((error as? LocalizedError)?.errorDescription ?? error.localizedDescription))
                        }
                        await load()
                    }
                }
            } message: {
                if let removing { Text("\(firstName(removing)) keeps access to anything you’ve already shared. If you add them again, you’ll check it’s them again.") }
            }
            .task { await load() }
        }
    }

    private func firstName(_ pin: ContactPin) -> String {
        (pin.name.isEmpty ? pin.email : pin.name).split(separator: " ").first.map(String.init) ?? pin.email
    }

    private func load() async {
        do {
            pins = try await store.vault.contacts().sorted { $0.name.localizedCaseInsensitiveCompare($1.name) == .orderedAscending }
            own = try await store.vault.ownFingerprint()
            error = nil
        } catch {
            self.error = "This list couldn’t be opened. " + ((error as? LocalizedError)?.errorDescription ?? error.localizedDescription)
        }
        loaded = true
    }
}

/* Comparing a contact's twelve words again, from what was kept when they were added. */
private struct CheckItsThemSheet: View {
    @Environment(\.dismiss) private var dismiss
    let pin: ContactPin

    private var first: String { (pin.name.isEmpty ? pin.email : pin.name).split(separator: " ").first.map(String.init) ?? "them" }

    var body: some View {
        NavigationStack {
            List {
                Section {
                    FingerprintWordsView(fingerprint: pin.fingerprint).padding(.vertical, Alpine.Space.s2).alpineRow()
                } header: {
                    Text("Ask \(first) to open People you share with in HushOS and read you their twelve words, on a call or in person. If they match these, it’s really them.")
                        .font(Theme.Text.callout).foregroundStyle(Alpine.inkMuted).textCase(nil)
                } footer: {
                    Text("If they don’t match, don’t share anything new with them. Remove them, and add them again once they’ve signed in.")
                        .font(Theme.Text.footnote).foregroundStyle(Alpine.inkMuted)
                }
            }
            .listStyle(.insetGrouped)
            .alpineGrouped()
            .navigationTitle("Check it’s \(first)")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } } }
        }
        .presentationDetents([.medium, .large])
    }
}

/* A link as a QR code, drawn crisp at any size. */
struct QRCodeView: View {
    let text: String

    var body: some View {
        if let image = Self.render(text) {
            Image(uiImage: image).interpolation(.none).resizable().scaledToFit()
                .padding(Alpine.Space.s2).background(Color.white, in: RoundedRectangle(cornerRadius: Alpine.Radius.control))
                .accessibilityLabel("QR code for the link")
        }
    }

    static func render(_ text: String) -> UIImage? {
        let filter = CIFilter.qrCodeGenerator()
        filter.message = Data(text.utf8)
        filter.correctionLevel = "M"
        guard let output = filter.outputImage?.transformed(by: CGAffineTransform(scaleX: 8, y: 8)),
              let cg = CIContext().createCGImage(output, from: output.extent) else { return nil }
        return UIImage(cgImage: cg)
    }
}
