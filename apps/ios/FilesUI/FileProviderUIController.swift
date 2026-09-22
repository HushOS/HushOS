import FileProvider
import FileProviderUI
import HushOSKit
import SwiftUI
import UIKit

/*
 * Signing in from inside the Files app, when the session is gone: the same
 * OPAQUE flow the app runs, done here in the Rust core, and the result left in
 * the shared keychain for the File Provider extension. The main app is not
 * involved and need not be running.
 */
final class FileProviderUIController: FPUIActionExtensionViewController {
    override func prepare(forError error: Error) {
        show(SignInView(onDone: { [weak self] in self?.extensionContext.completeRequest() },
                        onCancel: { [weak self] in self?.cancel() }))
    }

    override func prepare(forAction actionIdentifier: String, itemIdentifiers: [NSFileProviderItemIdentifier]) {
        cancel()
    }

    private func cancel() {
        extensionContext.cancelRequest(withError: NSError(domain: FPUIErrorDomain, code: Int(FPUIExtensionErrorCode.userCancelled.rawValue)))
    }

    private func show<V: View>(_ view: V) {
        let host = UIHostingController(rootView: view)
        addChild(host)
        host.view.frame = self.view.bounds
        host.view.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        self.view.addSubview(host.view)
        host.didMove(toParent: self)
    }
}

struct SignInView: View {
    let onDone: () -> Void
    let onCancel: () -> Void
    @State private var email = ""
    @State private var password = ""
    @State private var pending = false
    @State private var error = ""

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    VStack(alignment: .leading, spacing: 6) {
                        Text("EXISTING ACCOUNT").font(.caption.weight(.semibold)).foregroundStyle(.secondary)
                        Text("Welcome back").font(.title.weight(.bold))
                        Text("Sign in to unlock your files in the Files app.").foregroundStyle(.secondary)
                    }
                }
                .listRowBackground(Color.clear)
                if !error.isEmpty {
                    Section { Text(error).foregroundStyle(.red) }
                }
                Section(footer: Text("Password stays on this device. Your account key is unwrapped here and never sent.")) {
                    TextField("Email", text: $email)
                        .keyboardType(.emailAddress).textContentType(.username)
                        .textInputAutocapitalization(.never).autocorrectionDisabled()
                    SecureField("Password", text: $password)
                        .textContentType(.password).textInputAutocapitalization(.never).autocorrectionDisabled()
                        .onSubmit { submit() }
                }
                Section {
                    Button(action: submit) {
                        Text(pending ? "Unlocking…" : "Sign in").frame(maxWidth: .infinity).fontWeight(.semibold)
                    }
                    .buttonStyle(.borderedProminent).controlSize(.large).disabled(pending)
                    .listRowBackground(Color.clear)
                }
            }
            .scrollContentBackground(.hidden)
            .background(Color(red: 0.902, green: 0.886, blue: 0.851))
            .tint(Color(red: 0.173, green: 0.259, blue: 0.557))
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Cancel", action: onCancel) } }
        }
    }

    private func submit() {
        guard !pending else { return }
        let address = email.trimmingCharacters(in: .whitespaces)
        guard address.contains("@") else { error = "Enter your email address."; return }
        guard !password.isEmpty else { error = "Enter your password."; return }
        error = ""
        pending = true
        Task {
            do {
                guard let origin = SharedKeychain.config?.origin else {
                    throw AuthError.message("Open HushOS once on this device before signing in from Files.")
                }
                try await Auth.signIn(origin: origin, email: address, password: password)
                onDone()
            } catch {
                self.error = (error as? LocalizedError)?.errorDescription ?? error.localizedDescription
            }
            pending = false
        }
    }
}
