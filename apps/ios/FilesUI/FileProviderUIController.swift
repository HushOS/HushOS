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

/* The board's "Signing in from Files": one heading, one reason, the same fields and words as the app. */
struct SignInView: View {
    let onDone: () -> Void
    let onCancel: () -> Void
    @State private var email = ""
    @State private var password = ""
    @State private var showPassword = false
    @State private var pending = false
    @State private var error = ""

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(spacing: Alpine.Space.s6) {
                    VStack(spacing: Alpine.Space.s3) {
                        Image("BrandMark").resizable().frame(width: 64, height: 64)
                            .clipShape(RoundedRectangle(cornerRadius: 18, style: .continuous)).accessibilityHidden(true)
                        Text("Sign in to HushOS").font(.title2.weight(.bold)).foregroundStyle(Alpine.ink).accessibilityAddTraits(.isHeader)
                        Text("To see your files here and in other apps.").font(.subheadline).foregroundStyle(Alpine.inkMuted)
                    }
                    .multilineTextAlignment(.center).padding(.horizontal, Alpine.Space.s8).padding(.top, Alpine.Space.s4)

                    VStack(alignment: .leading, spacing: Alpine.Space.s2) {
                        VStack(spacing: 0) {
                            row("Email") {
                                TextField("name@example.com", text: $email)
                                    .keyboardType(.emailAddress).textContentType(.username)
                                    .textInputAutocapitalization(.never).autocorrectionDisabled()
                            }
                            Alpine.rule.frame(height: 1).padding(.leading, Alpine.Space.s4)
                            row("Password") {
                                HStack {
                                    Group {
                                        if showPassword { TextField("Required", text: $password) } else { SecureField("Required", text: $password) }
                                    }
                                    .textContentType(.password).textInputAutocapitalization(.never).autocorrectionDisabled()
                                    .onSubmit { submit() }
                                    Button { showPassword.toggle() } label: {
                                        Image(systemName: showPassword ? "eye.slash" : "eye").foregroundStyle(Alpine.inkMuted).frame(width: 36, height: 36)
                                    }
                                    .buttonStyle(.plain).accessibilityLabel(showPassword ? "Hide password" : "Show password")
                                }
                            }
                        }
                        .background(Alpine.surface, in: RoundedRectangle(cornerRadius: 26, style: .continuous))
                        .overlay(RoundedRectangle(cornerRadius: 26, style: .continuous).strokeBorder(Alpine.edge))
                        if !error.isEmpty {
                            Text(error).font(.footnote).foregroundStyle(Alpine.danger).padding(.horizontal, Alpine.Space.s4)
                        }
                    }

                    Button(action: submit) {
                        Text(pending ? "Signing in…" : "Sign in").font(.body.weight(.semibold))
                            .foregroundStyle(Alpine.onPrimary).frame(maxWidth: .infinity, minHeight: 52)
                            .background(pending ? Alpine.primary.opacity(0.4) : Alpine.primary, in: Capsule())
                    }
                    .buttonStyle(.plain).disabled(pending)
                }
                .padding(.horizontal, Alpine.Space.s4)
            }
            .background(Alpine.ground.ignoresSafeArea())
            .navigationTitle("HushOS")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Cancel", action: onCancel) } }
        }
        .tint(Alpine.primary)
    }

    private func row(_ label: String, @ViewBuilder field: () -> some View) -> some View {
        HStack(spacing: Alpine.Space.s3) {
            Text(label).foregroundStyle(Alpine.ink).frame(width: 84, alignment: .leading)
            field().foregroundStyle(Alpine.ink)
        }
        .padding(.horizontal, Alpine.Space.s4).frame(minHeight: 52)
    }

    private func submit() {
        guard !pending else { return }
        let address = email.trimmingCharacters(in: .whitespaces)
        guard !address.isEmpty else { error = "Enter your email address."; return }
        guard !password.isEmpty else { error = "Enter your password."; return }
        error = ""
        pending = true
        Task {
            do {
                guard let origin = SharedKeychain.config?.origin else {
                    throw AuthError.message("Open the HushOS app once on this iPhone, then sign in here.")
                }
                let previous = AccountStore.shared.owner()
                let user = try await Auth.signIn(origin: origin, email: address, password: password)
                // Another account signed in here: Files forgets what it listed for the last one.
                if previous?.caseInsensitiveCompare(user.id) != .orderedSame { await FilesDomain.reimport() }
                onDone()
            } catch {
                self.error = (error as? LocalizedError)?.errorDescription ?? error.localizedDescription
            }
            pending = false
        }
    }
}
