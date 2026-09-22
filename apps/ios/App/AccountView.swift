import HushOSKit
import SwiftUI

/* Account: who is signed in, the plan and its storage, security, the trash, the Files app, and the way out. */
struct AccountView: View {
    @Environment(AppModel.self) private var model
    @Environment(DriveStore.self) private var store
    @Environment(\.openURL) private var openURL
    @State private var allowance: StorageAllowance?
    @State private var billing: BillingSummary?
    @State private var editingName = false
    @State private var nameDraft = ""
    @State private var changingPassword = false
    @State private var showingPhrase = false
    @State private var rotating = false
    @State private var deleting = false
    @State private var signingOut = false
    @State private var notice: String?

    var body: some View {
        NavigationStack {
            Form {
                if let user = model.user {
                    Section {
                        HStack(spacing: 14) {
                            Image(systemName: "person.crop.circle.fill").font(.system(size: 44)).foregroundStyle(Color.accentColor)
                            VStack(alignment: .leading, spacing: 2) {
                                Text(user.name.isEmpty ? "Signed in" : user.name).font(.headline)
                                Text(user.email.isEmpty ? model.origin : user.email).font(.footnote).foregroundStyle(.secondary)
                            }
                            Spacer()
                            Button("Edit") { nameDraft = user.name; editingName = true }.font(.footnote)
                        }
                        .padding(.vertical, 4)
                    }
                }
                Section {
                    if let allowance {
                        VStack(alignment: .leading, spacing: 6) {
                            HStack {
                                Text(billing?.subscription?.productName ?? "Free")
                                Spacer()
                                Text("\(bytes(allowance.used)) of \(bytes(allowance.quota))").foregroundStyle(.secondary).font(.footnote)
                            }
                            ProgressView(value: Double(allowance.used), total: Double(max(allowance.quota, 1)))
                        }
                        .padding(.vertical, 2)
                    } else {
                        ProgressView()
                    }
                    Button("Manage plan") {
                        if let url = Auth.billingURL(origin: model.origin) { openURL(url) }
                    }
                } header: {
                    Text("Plan and storage")
                } footer: {
                    if let subscription = billing?.subscription {
                        Text(subscription.cancelAtPeriodEnd
                             ? "Ends \(parseDate(subscription.currentPeriodEnd)?.formatted(date: .abbreviated, time: .omitted) ?? "")."
                             : "Renews \(parseDate(subscription.currentPeriodEnd)?.formatted(date: .abbreviated, time: .omitted) ?? "") on the web.")
                    } else {
                        Text("Plans are chosen and paid for on the web.")
                    }
                }
                Section {
                    Button("Change password") { changingPassword = true }
                    Button("Recovery phrase") { showingPhrase = true }
                    Button("Rotate keys") { rotating = true }
                    Button("Delete account", role: .destructive) { deleting = true }
                } header: {
                    Text("Security")
                } footer: {
                    Text("The recovery phrase opens the account without the password; rotating keys replaces the account key and mints a new phrase.")
                }
                Section {
                    NavigationLink { TrashView().environment(store) } label: { Label("Trash", systemImage: "trash") }
                    LabeledContent("HushOS", value: model.origin.replacingOccurrences(of: "https://", with: ""))
                } footer: {
                    Text("HushOS is a location in the Files app: browsing, downloads, uploads and Keep Downloaded work there without opening HushOS.")
                }
                Section {
                    Button("Sign out", role: .destructive) { signingOut = true }
                } footer: {
                    Text("Signing out locks the account key on this device and removes the Files location.")
                }
            }
            .navigationTitle("Account")
            .navigationBarTitleDisplayMode(.inline)
            .alert("Your name", isPresented: $editingName) {
                TextField("Name", text: $nameDraft)
                Button("Cancel", role: .cancel) {}
                Button("Save") {
                    let name = nameDraft.trimmingCharacters(in: .whitespaces)
                    guard !name.isEmpty else { return }
                    Task {
                        do { model.setUser(try await Auth.updateName(name)) } catch { notice = (error as? LocalizedError)?.errorDescription ?? error.localizedDescription }
                    }
                }
            }
            .sheet(isPresented: $changingPassword) { ChangePasswordSheet { notice = $0 } }
            .sheet(isPresented: $showingPhrase) { RecoveryPhraseSheet().environment(store) }
            .sheet(isPresented: $rotating) { RotateKeysSheet() }
            .sheet(isPresented: $deleting) { DeleteAccountSheet { notice = $0 } }
            .confirmationDialog("Sign out of HushOS?", isPresented: $signingOut, titleVisibility: .visible) {
                Button("Sign out", role: .destructive) { Task { await model.signOut() } }
            }
            .alert("Account", isPresented: Binding(get: { notice != nil }, set: { if !$0 { notice = nil } })) {
                Button("OK") { notice = nil }
            } message: {
                Text(notice ?? "")
            }
            .task {
                allowance = try? await Auth.storage()
                billing = try? await Auth.billing()
            }
        }
    }

    private func bytes(_ value: Int64) -> String {
        ByteCountFormatter.string(fromByteCount: value, countStyle: .file)
    }
}

struct ChangePasswordSheet: View {
    @Environment(\.dismiss) private var dismiss
    @Environment(AppModel.self) private var model
    let done: (String) -> Void
    @State private var current = ""
    @State private var new = ""
    @State private var confirm = ""
    @State private var pending = false
    @State private var error = ""

    var body: some View {
        NavigationStack {
            Form {
                if !error.isEmpty { Section { Text(error).foregroundStyle(.red) } }
                Section {
                    SecureField("Current password", text: $current).textContentType(.password)
                } footer: {
                    Text("Proved with OPAQUE; it never leaves this device.")
                }
                Section {
                    SecureField("New password", text: $new).textContentType(.newPassword)
                    SecureField("Repeat new password", text: $confirm).textContentType(.newPassword)
                } footer: {
                    Text("Your account key is opened with the current password and sealed again under the new one. Files, keys and the Files app location stay as they are.")
                }
            }
            .navigationTitle("Change password")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button(pending ? "Changing…" : "Change") { submit() }.disabled(pending || current.isEmpty || new.count < 12 || new != confirm)
                }
            }
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
                done("Your password was changed.")
            } catch {
                self.error = (error as? LocalizedError)?.errorDescription ?? error.localizedDescription
            }
            pending = false
        }
    }
}

struct DeleteAccountSheet: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    let done: (String) -> Void
    @State private var password = ""
    @State private var phrase = ""
    @State private var pending = false
    @State private var error = ""

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    Text("Deleting removes every file, every version and the account itself. Nothing can be recovered afterwards.")
                        .foregroundStyle(.secondary)
                }
                if !error.isEmpty { Section { Text(error).foregroundStyle(.red) } }
                Section {
                    SecureField("Password", text: $password).textContentType(.password)
                    TextField("Type DELETE to confirm", text: $phrase).textInputAutocapitalization(.characters).autocorrectionDisabled()
                }
            }
            .navigationTitle("Delete account")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .destructiveAction) {
                    Button(pending ? "Deleting…" : "Delete", role: .destructive) { submit() }.disabled(pending || password.isEmpty || phrase != "DELETE")
                }
            }
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
                self.error = (error as? LocalizedError)?.errorDescription ?? error.localizedDescription
            }
            pending = false
        }
    }
}
