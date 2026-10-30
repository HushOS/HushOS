import HushOSKit
import SwiftUI

/*
 * Devices (docs/devices-design.md, step 1): this iPhone, then every other
 * device signed in to the account, with how each got in and when it was last
 * seen. Rename any of them; remove any but this one (signing out is how this
 * one leaves). Removing signs a device out at once; what it already holds may
 * stay on it, and the words say so.
 */
struct DevicesView: View {
    @Environment(DriveStore.self) private var store
    @Environment(\.dismiss) private var dismiss
    @State private var devices: [AccountDevice]?
    @State private var problem: String?
    @State private var removing: AccountDevice?
    @State private var removingOthers = false
    @State private var password = ""

    private var current: AccountDevice? { devices?.first(where: \.current) }
    private var others: [AccountDevice] { devices?.filter { !$0.current } ?? [] }

    var body: some View {
        List {
            if let problem {
                Section {
                    Text(problem).foregroundStyle(Alpine.danger)
                    Button("Try again") { Task { await load() } }.foregroundStyle(Alpine.primary)
                }
            } else if devices == nil {
                Section { ProgressView().frame(maxWidth: .infinity) }
            } else {
                if let current {
                    Section {
                        row(current)
                    } header: {
                        SectionTitle(UIDevice.current.userInterfaceIdiom == .pad ? "This iPad" : "This iPhone")
                    }
                }
                Section {
                    if others.isEmpty {
                        Text("No other devices are signed in.").foregroundStyle(Alpine.inkMuted)
                    }
                    ForEach(others) { device in
                        row(device)
                            .swipeActions {
                                Button("Remove", role: .destructive) { removing = device }
                            }
                    }
                } header: {
                    SectionTitle("Other devices")
                }
                if !others.isEmpty {
                    Section {
                        Button("Remove all other devices", role: .destructive) { removingOthers = true }
                            .foregroundStyle(Alpine.danger).alpineRow()
                    } footer: {
                        Text("They’re signed out at once and need your password to sign in again.")
                    }
                }
            }
        }
        .listStyle(.insetGrouped)
        .alpineGrouped()
        .navigationTitle("Devices")
        .screenChrome(title: "Devices")
        .refreshable { await load() }
        .task { await load() }
        .alert(removing.map { "Remove \($0.label)?" } ?? "", isPresented: Binding(get: { removing != nil }, set: { if !$0 { removing = nil } })) {
            SecureField("Your password", text: $password).textContentType(.password)
            Button("Cancel", role: .cancel) { password = "" }
            Button("Remove", role: .destructive) {
                let typed = password
                password = ""
                if let device = removing { Task { await remove(device, password: typed) } }
            }
            .disabled(password.isEmpty)
        } message: {
            Text("It’s signed out at once and needs your password to sign in again. Anything already on it, such as files kept there, may stay there. If it was lost or stolen, change your password too. Enter your password to remove it.")
        }
        .alert("Remove all other devices?", isPresented: $removingOthers) {
            SecureField("Your password", text: $password).textContentType(.password)
            Button("Cancel", role: .cancel) { password = "" }
            Button("Remove all other devices", role: .destructive) {
                let typed = password
                password = ""
                Task { await removeOthers(password: typed) }
            }
            .disabled(password.isEmpty)
        } message: {
            Text("They’re signed out at once and need your password to sign in again. Anything already on them, such as files kept there, may stay there. If one was lost or stolen, change your password too. Enter your password to remove them.")
        }
    }


    private func row(_ device: AccountDevice) -> some View {
        HStack(spacing: Alpine.Space.s3) {
            VStack(alignment: .leading, spacing: 2) {
                Text(device.label).foregroundStyle(Alpine.ink)
                Text(details(device)).font(Theme.Text.footnote).foregroundStyle(Alpine.inkMuted)
            }
            Spacer(minLength: 0)
            Menu {
                Button("Rename") { rename(device) }
                if !device.current {
                    Button("Remove", role: .destructive) { removing = device }
                }
            } label: {
                Image(systemName: "ellipsis").foregroundStyle(Alpine.inkMuted).frame(width: 44, height: 44)
            }
            .accessibilityLabel("Actions for \(device.label)")
        }
        .alpineRow()
    }

    /* The day only: the server rounds last-seen to the hour, and a time of day would say when the owner is up. */
    private func seenOn(_ date: Date?) -> String {
        guard let date else { return "" }
        if Calendar.current.isDateInToday(date) { return "today" }
        if Calendar.current.isDateInYesterday(date) { return "yesterday" }
        return changedLabel(date) ?? ""
    }

    private func details(_ device: AccountDevice) -> String {
        let seen = seenOn(parseDate(device.lastSeenAt))
        let activity = device.signedIn ? "Active \(seen)" : "Signed out · Last active \(seen)"
        return [device.approval, activity].compactMap { $0 }.joined(separator: " · ")
    }

    private func load() async {
        do {
            devices = try await Devices.list()
            problem = nil
        } catch {
            // A lost session goes where every other one goes: the removed check, then sign-in.
            if endsSession(error) { store.report(error); return }
            if ErrorWords.isCancellation(error) { return }
            problem = "Your devices couldn’t be loaded. Check your connection, then try again."
        }
    }

    private func rename(_ device: AccountDevice) {
        TextPrompt.present(
            title: "Rename device", message: "Shown in your list of devices. Device names aren’t encrypted.", text: device.name ?? "",
            placeholder: "Name", action: "Save", selectStem: false,
            validate: { value in
                let name = value.trimmingCharacters(in: .whitespaces)
                if name.isEmpty { return "Enter a name." }
                return name.count > 40 ? "Use no more than 40 characters." : nil
            }
        ) { name in
            Task {
                do {
                    try await Devices.rename(device.id, to: name.trimmingCharacters(in: .whitespaces))
                    await load()
                } catch {
                    if endsSession(error) { store.report(error) } else {
                        if let words = ErrorWords.say(error) { store.notify(words) }
                    }
                }
            }
        }
    }

    private func remove(_ device: AccountDevice, password: String) async {
        do {
            try await Devices.remove(device.id, password: password)
            store.notify("Device removed")
            await load()
        } catch {
            if endsSession(error) { store.report(error) } else {
                if let words = ErrorWords.say(error) { store.notify(words) }
            }
        }
    }

    private func removeOthers(password: String) async {
        do {
            try await Devices.removeOthers(password: password)
            store.notify("Other devices removed")
            await load()
        } catch {
            if endsSession(error) { store.report(error) } else {
                if let words = ErrorWords.say(error) { store.notify(words) }
            }
        }
    }
}
