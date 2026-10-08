import HushOSKit
import SwiftUI

/*
 * Sign in (DESIGN.md): "Welcome back", the server named under it
 * only when it isn't HushOS's own, one message above the fields when the server says
 * no, and a line under them when one is empty. The gear opens Self-hosting › Server address;
 * Forgot opens the reset in the app (RecoveryView). Creating an account stays on the web:
 * the hosted service says where in plain text, never pointing at plans (App Review 3.1.3(f)).
 * The privacy policy and terms are a tap away before signing in (5.1.1(i)).
 */
struct SignInView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.openURL) private var openURL
    @State private var email = ""
    @State private var password = ""
    @State private var showPassword = false
    @State private var pending = false
    @State private var formError = ""
    @State private var fieldError: Field?
    @State private var showingServer = false
    @FocusState private var focus: Field?

    private enum Field { case email, password, shown }

    var body: some View {
        NavigationStack { form.toolbar(.hidden, for: .navigationBar).navigationDestination(isPresented: $showingServer) { SelfHostingView() } }
    }

    private var form: some View {
        VStack(spacing: 0) {
            HStack {
                Spacer()
                Button { showingServer = true } label: {
                    Image(systemName: "gearshape").font(.system(size: 19, weight: .semibold)).foregroundStyle(Alpine.ink)
                        .frame(width: Theme.control, height: Theme.control).contentShape(Circle())
                }
                .buttonStyle(.plain)
                .glassEffect(.regular.interactive(), in: .circle)
                .highContrastEdge(Circle())
                .accessibilityLabel("Self-hosting")
            }
            .padding(.horizontal, Alpine.Space.s4).frame(height: 52)

            ScrollView {
                VStack(alignment: .leading, spacing: Alpine.Space.s6) {
                    VStack(alignment: .leading, spacing: Alpine.Space.s2) {
                        Text("Welcome back").font(.system(size: 32, weight: .heavy)).kerning(-1).foregroundStyle(Alpine.ink)
                            .accessibilityAddTraits(.isHeader)
                        if let host = model.selfHostedName {
                            Text("Signing in to \(Text(host).foregroundStyle(Alpine.ink).fontWeight(.semibold))").font(.body).foregroundStyle(Alpine.inkMuted)
                        }
                    }
                    .padding(.horizontal, Alpine.Space.s1)

                    if !formError.isEmpty {
                        HStack(alignment: .top, spacing: 10) {
                            Image(systemName: "exclamationmark.circle").font(.body.weight(.semibold))
                            Text(formError).font(Theme.Text.callout).frame(maxWidth: .infinity, alignment: .leading)
                        }
                        .foregroundStyle(Alpine.danger)
                        .padding(.horizontal, Alpine.Space.s4).padding(.vertical, Alpine.Space.s3)
                        .background(Alpine.dangerSoft, in: RoundedRectangle(cornerRadius: 20, style: .continuous))
                        .highContrastEdge(RoundedRectangle(cornerRadius: 20, style: .continuous))
                        .accessibilityElement(children: .combine)
                    }

                    VStack(alignment: .leading, spacing: Alpine.Space.s2) {
                        VStack(spacing: 0) {
                            fieldRow("Email", error: fieldError == .email) {
                                TextField("name@example.com", text: $email)
                                    .keyboardType(.emailAddress).textContentType(.username)
                                    .textInputAutocapitalization(.never).autocorrectionDisabled()
                                    .submitLabel(.next).focused($focus, equals: .email)
                                    .onSubmit { focus = .password }
                            }
                            Theme.divider.frame(height: 1).padding(.leading, Alpine.Space.s4)
                            fieldRow("Password", error: fieldError == .password) {
                                HStack {
                                    // Both fields stay on screen and the eye swaps which one shows: removing the secure
                                    // field makes iOS think the form was sent and offer to save the password.
                                    ZStack {
                                        SecureField("Required", text: $password)
                                            .focused($focus, equals: .password).opacity(showPassword ? 0 : 1)
                                        TextField("Required", text: $password)
                                            .focused($focus, equals: .shown).opacity(showPassword ? 1 : 0)
                                    }
                                    .textContentType(.password).textInputAutocapitalization(.never).autocorrectionDisabled()
                                    .submitLabel(.go)
                                    .onSubmit { submit() }
                                    Button {
                                        showPassword.toggle()
                                        if focus == .password || focus == .shown { focus = showPassword ? .shown : .password }
                                    } label: {
                                        Image(systemName: showPassword ? "eye.slash" : "eye").foregroundStyle(Alpine.inkMuted).frame(width: 36, height: 36)
                                    }
                                    .buttonStyle(.plain)
                                    .accessibilityLabel(showPassword ? "Hide password" : "Show password")
                                }
                            }
                        }
                        .background(Alpine.surface, in: RoundedRectangle(cornerRadius: 26, style: .continuous))
                        .alpineCardEdge(RoundedRectangle(cornerRadius: 26, style: .continuous))

                        if let fieldError {
                            Label(fieldError == .email ? "Enter your email address." : "Enter your password.", systemImage: "exclamationmark.circle")
                                .font(Theme.Text.footnote).foregroundStyle(Alpine.danger)
                                .padding(.horizontal, Alpine.Space.s4)
                        }
                    }

                    // Where accounts come from: hushos.com, or the self-hosted server's own address (as Android says it).
                    Text("New to HushOS? Create an account at \(model.selfHostedName ?? "hushos.com").")
                        .font(Theme.Text.callout).foregroundStyle(Alpine.inkMuted)
                        .padding(.horizontal, Alpine.Space.s4)
                }
                .padding(.horizontal, Alpine.Space.s4).padding(.top, Alpine.Space.s2)
            }
            .scrollDismissesKeyboard(.interactively)

            VStack(spacing: Alpine.Space.s2) {
                Button(action: submit) {
                    Text(pending ? "Signing in…" : "Sign in").font(.body.weight(.semibold)).frame(maxWidth: .infinity, minHeight: 52)
                }
                .buttonStyle(PrimaryCapsuleStyle())
                .disabled(pending)
                Button("Forgot your password?") { model.startRecovery() }
                    .font(.body.weight(.semibold)).foregroundStyle(Alpine.primary).frame(minHeight: Theme.control)
                PolicyLinks()
            }
            .padding(.horizontal, Alpine.Space.s4).padding(.top, Alpine.Space.s3).padding(.bottom, Alpine.Space.s4)
        }
        .background(Alpine.ground.ignoresSafeArea())
        .onAppear { if email.isEmpty { email = model.lastEmail } }
        .onChange(of: email) { clearErrors() }
        .onChange(of: password) { clearErrors() }
    }

    private func fieldRow(_ label: String, error: Bool, @ViewBuilder field: () -> some View) -> some View {
        HStack(spacing: Alpine.Space.s3) {
            Text(label).foregroundStyle(error ? Alpine.danger : Alpine.ink).frame(width: 84, alignment: .leading)
            field().foregroundStyle(Alpine.ink)
        }
        .padding(.horizontal, Alpine.Space.s4)
        .frame(minHeight: 52)
    }

    private func clearErrors() {
        formError = ""
        fieldError = nil
    }

    private func submit() {
        guard !pending else { return }
        let address = email.trimmingCharacters(in: .whitespaces)
        guard !address.isEmpty else { fieldError = .email; focus = .email; return }
        guard !password.isEmpty else { fieldError = .password; focus = .password; return }
        clearErrors()
        pending = true
        Task {
            do {
                try await model.signIn(email: address, password: password)
                password = ""
            } catch {
                formError = (error as? LocalizedError)?.errorDescription ?? error.localizedDescription
            }
            pending = false
        }
    }
}

/*
 * Self-hosting › Server address (DESIGN.md): the HushOS server this app
 * signs in to. Changed from sign-in only; signed in, Account › Advanced shows it read-only,
 * since the session, keys and kept files all belong to the server it was opened on.
 */
struct SelfHostingView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    var readOnly = false
    @State private var address = ""
    @State private var problem: String?

    var body: some View {
        List {
            Section {
                TextField("https://hush.example.org", text: $address)
                    .keyboardType(.URL).textInputAutocapitalization(.never).autocorrectionDisabled()
                    .foregroundStyle(readOnly ? Alpine.inkMuted : Alpine.ink)
                    .disabled(readOnly)
                    .onChange(of: address) { problem = nil }
                    .onSubmit(save)
                    .alpineRow()
                if let problem {
                    Label(problem, systemImage: "exclamationmark.circle").font(Theme.Text.footnote).foregroundStyle(Alpine.danger).alpineRow()
                }
            } header: {
                Text("Server address").font(Theme.Text.label).foregroundStyle(Alpine.inkMuted)
            } footer: {
                Text(readOnly ? "Use this only if you or your organisation runs your own HushOS server. Sign out to change it."
                              : "Use this only if you or your organisation runs your own HushOS server.")
            }
            if !readOnly {
                Section {
                    // Literally hushos.com on every build, as on Android; developers type their local address.
                    Button("Use hushos.com") {
                        model.origin = "https://hushos.com"
                        address = "https://hushos.com"
                        problem = nil
                    }
                    .foregroundStyle(Alpine.primary).alpineRow()
                    .disabled(model.origin == "https://hushos.com" && address == "https://hushos.com")
                }
            }
        }
        .listStyle(.insetGrouped)
        .alpineGrouped()
        .navigationTitle("Self-hosting")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            if !readOnly { ToolbarItem(placement: .confirmationAction) { Button("Save", action: save).disabled(address.trimmingCharacters(in: .whitespaces).isEmpty) } }
        }
        .onAppear { address = model.origin }
    }

    private func save() {
        switch AppModel.checkedOrigin(address) {
        case .success(let origin):
            model.origin = origin
            dismiss()
        case .failure(let why):
            problem = why.message
        }
    }
}
