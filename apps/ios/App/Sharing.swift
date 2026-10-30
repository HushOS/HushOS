import CoreImage.CIFilterBuiltins
import HushOSKit
import SwiftUI
import UIKit

/*
 * "Who can open this?" (DESIGN.md, Components; the web's share dialog
 * for the behaviour): a field to add someone first, the people next, the links last.
 * Tapping a person shows what they can do and a labelled red way to stop; stopping and
 * turning a link off ask once and say afterwards what happened. Someone new is added by
 * their email and shared with in one step, with the role chosen beside the field
 * (docs/optional-verification.md 6.3); an account that changed waits for Review, which
 * takes the sheet's place, and what it stopped runs again once Review settled it.
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
    @State private var person: ShareView?
    @State private var making = false
    /* Review or Check it's Maya, in the sheet's place; the act a changed account stopped, and whether Review settled it. */
    @State private var step: ContactStep?
    @State private var interrupted: Interrupted?
    @State private var settled = false
    /* People on this item whose account changed (2.4): their row says so, and their role waits. */
    @State private var changed: Set<String> = []

    enum Interrupted: Equatable {
        case share(ContactPin, role: String)
        case new(email: String, role: String)
    }

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
                        let change = changed.contains(share.grantee.id.lowercased())
                        // Always their sheet: Stop sharing never waits on Review (only a new role does), as on the web.
                        Button { person = share } label: {
                            HStack(spacing: Alpine.Space.s3) {
                                PersonAvatar(name: share.grantee.name, seed: share.grantee.id)
                                VStack(alignment: .leading, spacing: 2) {
                                    Text(share.grantee.name.isEmpty ? share.grantee.email : share.grantee.name).foregroundStyle(Alpine.ink).lineLimit(1)
                                    if change {
                                        // Their account changed (6.3): said on the row in Contacts' words (the name is the row's title),
                                        // and their role waits for Review. One line; "· Review" never starts a line of its own.
                                        HStack(spacing: 0) {
                                            Text("Account changed").lineLimit(1).truncationMode(.tail)
                                            Text(" · ") + Text("Review").foregroundStyle(Alpine.primary).fontWeight(.semibold)
                                        }
                                        .font(Theme.Text.footnote).foregroundStyle(Alpine.inkMuted)
                                        .lineLimit(1)
                                    } else {
                                        Text(share.grantee.email).font(Theme.Text.footnote).foregroundStyle(Alpine.inkMuted).lineLimit(1)
                                    }
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
                        // On the first line's baseline at the text's size, as the sign-in banner's icon.
                        HStack(alignment: .firstTextBaseline, spacing: Alpine.Space.s3) {
                            Image(systemName: "link").font(Theme.Text.callout).foregroundStyle(Alpine.inkMuted)
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
            .contactSteps($step) { settled = true }
            .onChange(of: step) { _, now in if now == nil { flowDone() } }
            .sheet(item: $person) { share in
                PersonAccessSheet(item: item, share: share, pin: pins.first { $0.userId.lowercased() == share.grantee.id.lowercased() },
                                  changed: changed.contains(share.grantee.id.lowercased())) { await load() }
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
                Button { self.chosen = nil } label: { Image(systemName: "xmark").foregroundStyle(Alpine.inkMuted).frame(width: 32, height: 32) }
                    .buttonStyle(.plain).accessibilityLabel("Choose someone else")
            }
            .frame(minHeight: Theme.row).itemRow()
            roleLine
        } else {
            HStack(spacing: Alpine.Space.s2) {
                Image(systemName: "person.badge.plus").foregroundStyle(Alpine.inkMuted)
                TextField("Add a name or email", text: $query)
                    .textInputAutocapitalization(.never).autocorrectionDisabled().keyboardType(.emailAddress)
                    .foregroundStyle(Alpine.ink)
                    .onSubmit { if let typedEmail { shareWithNew(typedEmail) } else if matches.count == 1 { chosen = matches[0] } }
            }
            .padding(.horizontal, Alpine.Space.s4).frame(minHeight: Theme.control)
            .background(Alpine.surface, in: Capsule())
            // A field keeps a visible edge: faint normally, solid in high contrast.
            .overlay(Capsule().strokeBorder(Alpine.field.opacity(0.35), lineWidth: 1))
            .highContrastEdge(Capsule())
            .bareRow(top: 0, bottom: Alpine.Space.s1)
            roleLine
            if !query.trimmingCharacters(in: .whitespaces).isEmpty || pins.isEmpty {
                // Someone not in Contacts by their full email: the list's first row, added and shared with in one step (6.3).
                if let typedEmail {
                    Button { shareWithNew(typedEmail) } label: {
                        HStack(spacing: Alpine.Space.s3) {
                            Image(systemName: "person.badge.plus").font(.system(size: 14, weight: .semibold)).foregroundStyle(Alpine.primary)
                                .frame(width: 32, height: 32).background(Alpine.tint, in: Circle())
                            Text(sharing ? "Sharing…" : "Share with \(typedEmail)").foregroundStyle(Alpine.ink).lineLimit(1)
                        }
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain).disabled(sharing).alpineRow()
                }
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
                if typedEmail == nil && matches.isEmpty {
                    Text(pins.isEmpty ? "Type their email to share with someone new." : "No one by that name yet. Type their full email to add them.")
                        .font(Theme.Text.footnote).foregroundStyle(Alpine.inkMuted).alpineRow()
                }
            }
        }
    }

    /*
     * What they can do, chosen before anything is shared (6.3): on a phone a line of its own under
     * the field, so "Add a name or email" is never cut off.
     */
    private var roleLine: some View {
        HStack {
            Text("What they can do").foregroundStyle(Alpine.inkMuted)
            Spacer()
            Picker("What they can do", selection: $role) {
                Text("Can view").tag("viewer")
                Text("Can edit").tag("editor")
            }
            .pickerStyle(.menu).tint(Alpine.primary).labelsHidden()
        }
        .font(Theme.Text.callout)
        .bareRow(top: 0, bottom: 0)
    }

    /* Review settled the change: what it stopped runs again, with the keys looked up afresh. */
    private func flowDone() {
        let act = settled ? interrupted : nil
        settled = false
        interrupted = nil
        Task { await load() }
        switch act {
        case .share(let pin, let role)?: self.role = role; share(with: pin)
        case .new(let email, let role)?: self.role = role; shareWithNew(email)
        case nil: break
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
            // Met here too (2.4): who on this item has an account that changed, from the keys served now.
            var moved: Set<String> = []
            for share in shares {
                guard let pin = pins.first(where: { $0.userId.lowercased() == share.grantee.id.lowercased() }) else { continue }
                if (try? await store.vault.shareeChanged(pin)) == true { moved.insert(pin.userId.lowercased()) }
            }
            changed = moved
            links = try await store.vault.links(for: item).sorted { $0.createdAt < $1.createdAt }
            var found: [String: URL] = [:]
            for link in links { if let url = try? await store.vault.linkURL(link, for: item) { found[link.id] = url } }
            urls = found
            error = ""
        } catch {
            if let words = ErrorWords.say(error) { self.error = words }
        }
        loaded = true
        await store.refreshSharing()
    }

    private func share(with pin: ContactPin) {
        sharing = true
        error = ""
        let role = role
        Task {
            do {
                _ = try await store.vault.share(item, with: pin, role: role)
                store.notify("\(pin.name.isEmpty ? pin.email : pin.name) \(role == "editor" ? "can edit" : "can view") “\(item.name)” now")
                chosen = nil
                self.role = "viewer"
                await load()
            } catch let changed as AccountChangedError {
                // Waits for Review, in the sheet's place; runs again once it settled.
                interrupted = .share(pin, role: role)
                step = .changed(changed.change)
            } catch {
                if let words = ErrorWords.say(error) { self.error = words }
            }
            sharing = false
        }
    }

    /* Someone new by their email (6.3): added as Add someone adds them, and shared with, in one step. */
    private func shareWithNew(_ email: String) {
        sharing = true
        error = ""
        let role = role
        Task {
            do {
                let pin: ContactPin
                switch try await store.vault.addContact(email: email) {
                case .added(let added):
                    pin = added
                    Task { await store.refreshSigners() }
                case .already(let known):
                    pin = known
                case .changed(let change):
                    interrupted = .new(email: email, role: role)
                    step = .changed(change)
                    sharing = false
                    return
                }
                _ = try await store.vault.share(item, with: pin, role: role)
                store.notify("Shared with \(pin.firstName)")
                query = ""
                self.role = "viewer"
                await load()
            } catch let changed as AccountChangedError {
                interrupted = .new(email: email, role: role)
                step = .changed(changed.change)
            } catch {
                if let words = ErrorWords.say(error) { self.error = words }
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
                    let conflict: Bool
                    switch failure {
                    case .server(409, _), .stale: conflict = true
                    default: conflict = false
                    }
                    guard conflict, let fresh = try await store.reload(item) else { throw failure }
                    item = fresh
                    made = try await store.vault.createLink(for: fresh, password: nil, expiresAt: nil)
                }
                urls[made.link.id] = made.url
                await load()
            } catch {
                if let words = ErrorWords.say(error, otherwise: "Try again.") { self.error = "Couldn’t make a link. " + words }
            }
            making = false
        }
    }
}

/* "Opened 3 times · ends 12 October · password", or "Not opened yet". */
func describeLink(_ link: LinkView) -> String {
    [
        link.useCount == 0 ? "Not opened yet" : "Opened \(link.useCount == 1 ? "once" : "\(link.useCount) times")",
        parseDate(link.expiresAt).map { "ends " + $0.formatted(.dateTime.day().month(.wide).locale(.dayMonth)) },
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
                    if let url { Button("Send the link", systemImage: "square.and.arrow.up") { LinkShare.present(url) } }
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
        UIPasteboard.general.setItems([["public.url": url]], options: [.localOnly: true, .expirationDate: Date().addingTimeInterval(120)])
        copied = true
        let until = parseDate(link.expiresAt).map { " until \($0.formatted(.dateTime.day().month(.wide).locale(.dayMonth)))" } ?? ""
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
                if let words = ErrorWords.say(error, otherwise: "Try again.") { store.notify("Couldn’t turn the link off. " + words) }
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

    /* Whoever holds the link can guess its password offline: the core refuses fewer than 8 characters (counted as it counts them). */
    private var shortPassword: Bool { !removePassword && !password.isEmpty && password.unicodeScalars.count < 8 }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    RevealingSecureField(placeholder: link.hasPassword ? "Keep the current password" : "None", text: $password, content: nil)
                        .disabled(removePassword).alpineRow()
                    if link.hasPassword { Toggle("Remove the password", isOn: $removePassword).alpineRow() }
                } header: {
                    Text("Password")
                } footer: {
                    Text(shortPassword ? "At least 8 characters." : "At least 8 characters. Whoever opens the link types it on their device. It never reaches us.")
                        .foregroundStyle(shortPassword ? Alpine.danger : Alpine.inkMuted)
                }
                Section("Ends") {
                    if let current = parseDate(link.expiresAt) {
                        choice("keep", current.formatted(.dateTime.day().month(.wide).locale(.dayMonth)))
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
                ToolbarItem(placement: .confirmationAction) { Button(saving ? "Saving…" : "Save") { save() }.disabled(saving || shortPassword) }
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
                if let words = ErrorWords.say(error) { self.error = words }
            }
            saving = false
        }
    }
}

/*
 * What tapping a person shows: the two roles with what they mean, Check it's Maya, and stopping
 * as a labelled red button, last (6.3).
 */
private struct PersonAccessSheet: View {
    @Environment(DriveStore.self) private var store
    @Environment(\.dismiss) private var dismiss
    let item: Opened
    let share: ShareView
    /* Their pin, when they are in Contacts: what a new role is sealed to. */
    let pin: ContactPin?
    /* Their account changed: the role waits for Review; stopping never does. */
    @State var changed: Bool
    let reload: () async -> Void
    @State private var stopping = false
    @State private var busy = false
    @State private var step: ContactStep?
    @State private var waiting: String?
    @State private var settled = false

    private var first: String { firstName(share.grantee.name.isEmpty ? share.grantee.email : share.grantee.name) }

    var body: some View {
        NavigationStack {
            List {
                Section {
                    role("viewer", "Can view", "Open and download")
                    role("editor", "Can edit", item.isFolder ? "Add, rename and delete inside" : "Open, download and replace")
                } footer: {
                    if pin == nil { Text("Add \(first) to Contacts to change what they can do.").font(Theme.Text.footnote).foregroundStyle(Alpine.inkMuted) }
                }
                if changed {
                    Section {
                        Button { step = .changed(AccountChange(contactId: share.grantee.id, name: share.grantee.name, email: share.grantee.email)) } label: {
                            HStack {
                                Text("\(first)’s account changed").foregroundStyle(Alpine.ink).lineLimit(1)
                                Spacer(minLength: Alpine.Space.s2)
                                Text("Review").fontWeight(.semibold).foregroundStyle(Alpine.primary)
                            }
                            .contentShape(Rectangle())
                        }
                        .buttonStyle(.plain).alpineRow()
                    }
                }
                if pin != nil {
                    Section {
                        Button("Check it’s \(first)") { step = .check(email: share.grantee.email, name: share.grantee.name) }
                            .foregroundStyle(Alpine.primary).alpineRow()
                    }
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
            .contactSteps($step) { settled = true }
            .onChange(of: step) { _, now in
                // Review settled the change: the role may change again, and one it stopped runs again.
                guard now == nil, settled else { return }
                settled = false
                changed = false
                if let value = waiting { waiting = nil; change(to: value) } else { Task { await reload() } }
            }
            .alert("Stop sharing with \(first)?", isPresented: $stopping) {
                Button("Cancel", role: .cancel) {}
                Button("Stop sharing", role: .destructive) { stop() }
            } message: {
                Text("They can’t open “\(item.name)” in HushOS any more. Copies they already downloaded stay with them. You can share it again later.")
            }
        }
        // Taller while their account changed, so Stop sharing (which never waits on Review) is in view without scrolling.
        .presentationDetents(changed ? [.fraction(0.72), .large] : [.medium, .large])
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
        .disabled(busy || ((pin == nil || changed) && share.role != value))
        .accessibilityAddTraits(share.role == value ? .isSelected : [])
        .alpineRow()
    }

    /* A new role is the same share sealed again with it; the server replaces the old one. */
    private func change(to value: String) {
        guard value != share.role else { return }
        busy = true
        Task {
            do {
                guard let pin = try await store.vault.contacts().first(where: { $0.userId.lowercased() == share.grantee.id.lowercased() }) else { return }
                _ = try await store.vault.share(item, with: pin, role: value)
                store.notify("\(first) \(value == "editor" ? "can edit" : "can view") “\(item.name)” now")
                await reload()
                dismiss()
            } catch let change as AccountChangedError {
                waiting = value
                step = .changed(change.change)
            } catch {
                if let words = ErrorWords.say(error, otherwise: "Try again.") { store.notify("Couldn’t change what they can do. " + words) }
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
                if let words = ErrorWords.say(error, otherwise: "Try again.") { store.notify("Couldn’t stop sharing. " + words) }
            }
            await reload()
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

/*
 * Twelve words in two columns, numbered, for reading aloud. Show as code gives the
 * same fingerprint as hex, as the web does, for checking against an app that still
 * shows it that way; the words are drawn from that code, so either matching means the same.
 */
struct FingerprintWordsView: View {
    let fingerprint: String
    @State private var code = false
    // At accessibility text sizes a long word doesn't fit half the width: one column, never a truncated word.
    @Environment(\.dynamicTypeSize) private var typeSize

    var body: some View {
        let words = FingerprintWords.words(fingerprint) ?? []
        VStack(alignment: .leading, spacing: Alpine.Space.s2) {
            if code {
                Text(fingerprint).font(.body.monospaced()).foregroundStyle(Alpine.ink).textSelection(.enabled).speechSpellsOutCharacters()
                    .padding(.horizontal, Alpine.Space.s3).padding(.vertical, Alpine.Space.s2)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(Alpine.ground, in: RoundedRectangle(cornerRadius: Alpine.Radius.control))
            } else {
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
            // Borderless, so only the words of the button toggle inside a list row.
            Button(code ? "Show as words" : "Show as code") { code.toggle() }
                .font(Theme.Text.footnote.weight(.semibold)).foregroundStyle(Alpine.primary).buttonStyle(.borderless)
        }
    }
}

/*
 * Contacts (docs/optional-verification.md 6.5): Add someone and Your twelve words first, so
 * neither is buried under a long list, then everyone added (Find someone from eight of them),
 * each with Verified or Not verified, an account that changed with Review, and Check it's Maya
 * (Check again once verified) and Remove in its menu.
 */
struct PeopleView: View {
    @Environment(AppModel.self) private var model
    @Environment(DriveStore.self) private var store
    @Environment(\.dismiss) private var dismiss
    @State private var pins: [ContactPin] = []
    /* Where each stands on this phone, by lowercased id; nil until read, and when the guard couldn't be. */
    @State private var standings: [String: (verified: Bool, changed: Bool)]?
    @State private var standingsError: String?
    @State private var loaded = false
    @State private var error: String?
    @State private var step: ContactStep?
    @State private var removing: ContactPin?
    @State private var showingWords = false
    @State private var query = ""

    /* What the list shows under the filter, and what VoiceOver hears once typing pauses. */
    private var shown: [ContactPin] { PeopleFilter.shown(pins, query: query) }
    private var result: String? { PeopleFilter.result(shown: shown.count, of: pins.count, query: query) }
    /*
     * The session ended (a request found it gone, or the app left the signed-in state): People
     * closes, so MainView's "You've been signed out" isn't hidden behind it.
     */
    private var sessionOver: Bool { model.state != .signedIn || store.error == DriveStore.sessionEnded }

    var body: some View {
        NavigationStack {
            List {
                Section {
                    Button { step = .add(writer: nil) } label: { Label("Add someone", systemImage: "person.badge.plus").foregroundStyle(Alpine.primary) }.alpineRow()
                    Button { showingWords = true } label: { Label("Your twelve words", systemImage: "person.text.rectangle").foregroundStyle(Alpine.primary) }.alpineRow()
                } header: {
                    Text("People you share with. Add someone by the email they use for HushOS.").font(Theme.Text.callout).foregroundStyle(Alpine.inkMuted).textCase(nil)
                }
                Section {
                    if loaded && pins.isEmpty {
                        VStack(alignment: .leading, spacing: 4) {
                            Text("Nobody here yet").font(Theme.Text.headline).foregroundStyle(Alpine.ink)
                            Text("Add someone by their email, or add them while you share.").font(Theme.Text.footnote).foregroundStyle(Alpine.inkMuted)
                        }
                        .padding(.vertical, Alpine.Space.s2).alpineRow()
                    }
                    if let error { Text(error).foregroundStyle(Alpine.danger).alpineRow() }
                    // What this phone remembers couldn't be read: nobody is shown as verified, and acts wait.
                    if let standingsError {
                        VStack(alignment: .leading, spacing: Alpine.Space.s2) {
                            Text(standingsError).font(Theme.Text.callout).foregroundStyle(Alpine.ink)
                            Button("Try again") { Task { await load() } }.font(Theme.Text.callout.weight(.semibold)).buttonStyle(.borderless)
                        }
                        .padding(.vertical, Alpine.Space.s2).alpineRow()
                    }
                    if let result, shown.isEmpty {
                        Text(result).font(Theme.Text.callout).foregroundStyle(Alpine.inkMuted).padding(.vertical, Alpine.Space.s2).alpineRow()
                    }
                    ForEach(shown) { pin in row(pin) }
                }
            }
            .listStyle(.insetGrouped)
            .alpineGrouped()
            .environment(\.defaultMinListRowHeight, 1)
            .findSomeone(offered: PeopleFilter.offered(count: pins.count, query: query), query: $query)
            // Said once typing pauses, not at every letter VoiceOver already echoes.
            .task(id: result) {
                guard let result else { return }
                try? await Task.sleep(for: .milliseconds(600))
                if !Task.isCancelled { AccessibilityNotification.Announcement(result).post() }
            }
            .navigationTitle("Contacts")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } } }
            .sheet(isPresented: $showingWords) { OwnWordsSheet().environment(store) }
            .contactSteps($step)
            .onChange(of: step) { _, now in if now == nil { Task { await load() } } }
            .alert(removing.map { "Remove \($0.firstName)?" } ?? "", isPresented: Binding(get: { removing != nil }, set: { if !$0 { removing = nil } })) {
                Button("Cancel", role: .cancel) { removing = nil }
                Button("Remove", role: .destructive) {
                    guard let pin = removing else { return }
                    removing = nil
                    Task {
                        do {
                            try await store.vault.remove(pin.userId)
                            store.notify("\(pin.firstName) removed")
                            await store.refreshSigners()
                        } catch {
                            if let words = ErrorWords.say(error, otherwise: "Try again.") { store.notify("Couldn’t remove them. " + words) }
                        }
                        await load()
                    }
                }
            } message: {
                if let removing { Text("\(removing.firstName) keeps access to anything you’ve already shared.") }
            }
            .task { await load() }
        }
        .onChange(of: sessionOver, initial: true) { _, over in if over { dismiss() } }
    }

    private func row(_ pin: ContactPin) -> some View {
        let standing = standings?[pin.userId.lowercased()]
        let changed = standing?.changed == true
        let change = AccountChange(contactId: pin.userId, name: pin.name, email: pin.email)
        return Menu {
            if changed {
                Button("Review", systemImage: "person.crop.circle.badge.exclamationmark") { step = .changed(change) }
            }
            Button(standing?.verified == true ? "Check again" : "Check it’s \(pin.firstName)", systemImage: "checkmark.shield") {
                step = .check(email: pin.email, name: pin.name)
            }
            Divider()
            Button("Remove", systemImage: "person.badge.minus", role: .destructive) { removing = pin }.tint(Alpine.danger)
        } label: {
            HStack(spacing: Alpine.Space.s3) {
                PersonAvatar(name: pin.name, seed: pin.userId)
                VStack(alignment: .leading, spacing: 2) {
                    Text(pin.name.isEmpty ? pin.email : pin.name).foregroundStyle(Alpine.ink).lineLimit(1)
                    if changed {
                        Text("Account changed · \(Text("Review").foregroundStyle(Alpine.primary).fontWeight(.semibold))").font(Theme.Text.footnote).foregroundStyle(Alpine.inkMuted)
                    } else {
                        Text(pin.email).font(Theme.Text.footnote).foregroundStyle(Alpine.inkMuted).lineLimit(1)
                    }
                }
                Spacer(minLength: 0)
                if let standing, !standing.changed { VerifiedLabel(verified: standing.verified) }
            }
            .frame(minHeight: Theme.row).contentShape(Rectangle())
        }
        .accessibilityLabel("More for \(pin.name)")
        .itemRow()
    }

    private func load() async {
        do {
            pins = try await store.vault.contacts().sorted { $0.name.localizedCaseInsensitiveCompare($1.name) == .orderedAscending }
            error = nil
        } catch {
            // A session that ended is the store's to say (it closes People); anything else is said here.
            if endsSession(error) { store.report(error); return }
            if let words = ErrorWords.say(error, otherwise: "Try again.") { self.error = "This list couldn’t be opened. " + words }
        }
        do {
            var found = try await store.vault.contactStandings()
            // A change met this session (sharing, a share they made) is said too, until Continue or a check.
            for change in await store.vault.accountChanges().values { found[change.id] = (false, true) }
            standings = found
            standingsError = nil
        } catch {
            standings = nil
            standingsError = ErrorWords.say(error, otherwise: GuardWords.unreadable)
        }
        loaded = true
    }
}

private extension View {
    /* People's search field, only while it is offered (PeopleFilter.offered): `.searchable` has no hidden state. */
    @ViewBuilder func findSomeone(offered: Bool, query: Binding<String>) -> some View {
        if offered {
            searchable(text: query, placement: .navigationBarDrawer(displayMode: .always), prompt: "Find someone")
        } else {
            self
        }
    }
}

/*
 * Your twelve words: what others check when they add this person, read aloud from
 * here. A sheet from a row at the top of People and from Account, so it is a tap away
 * while someone waits on a call.
 *
 * What is guaranteed: each opening asks the server which identity it serves and, if
 * that is not the one this phone opened (keys replaced on another device), opens the
 * served one first (`Vault.currentOwnFingerprint`). The words are always computed from
 * the public keys the core re-derived from the private halves, never from served keys.
 * Without the server it says it couldn't reach HushOS rather than show words it can't
 * confirm. The sheet closes when the app leaves the signed-in state, another account
 * takes the phone, or a request (its own read included) finds the session ended; it is
 * not reopened by anything.
 */
struct OwnWordsSheet: View {
    @Environment(AppModel.self) private var model
    @Environment(DriveStore.self) private var store
    @Environment(\.dismiss) private var dismiss
    @State private var words: String?
    @State private var error: String?
    /* The account the words were opened for. */
    @State private var account: String?

    /* Signed in as whom; nil once signed out, checking or deleted, or once a request found the session ended. */
    private var signedIn: String? { model.state == .signedIn && store.error != DriveStore.sessionEnded ? model.user?.id : nil }

    var body: some View {
        NavigationStack {
            List {
                Section {
                    if let words {
                        FingerprintWordsView(fingerprint: words).padding(.vertical, Alpine.Space.s2).alpineRow()
                    } else if let error {
                        Text(error).foregroundStyle(Alpine.danger).alpineRow()
                    } else {
                        ProgressView().accessibilityLabel("Opening your words").alpineRow()
                    }
                } header: {
                    Text("When someone checks it’s you, read these to them. They’re the same on all your devices.")
                        .font(Theme.Text.callout).foregroundStyle(Alpine.inkMuted).textCase(nil)
                }
            }
            .listStyle(.insetGrouped)
            .alpineGrouped()
            .navigationTitle("Your twelve words")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } } }
        }
        .presentationDetents([.medium, .large])
        .task {
            account = signedIn
            guard account != nil else { dismiss(); return }
            do { words = try await store.vault.currentOwnFingerprint() } catch {
                // A session that ended is the store's to say (and closes this sheet); anything else is said here.
                if endsSession(error) { store.report(error); return }
                if let words = ErrorWords.say(error, otherwise: "Couldn’t open them. Try again.") { self.error = words }
            }
        }
        .onChange(of: signedIn) { _, now in if now == nil || now != account { dismiss() } }
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
