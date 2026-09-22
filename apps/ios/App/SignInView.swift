import HushOSKit
import SwiftUI

/* The web's sign-in card in native form: a grouped form, our words. */
struct SignInView: View {
    @Environment(AppModel.self) private var model
    @State private var email = ""
    @State private var password = ""
    @State private var showPassword = false
    @State private var pending = false
    @State private var error = ""
    @State private var showingServer = false
    @FocusState private var focus: Field?

    private enum Field { case email, password }

    var body: some View {
        @Bindable var model = model
        NavigationStack {
            Form {
                Section {
                    VStack(alignment: .leading, spacing: 6) {
                        Text("EXISTING ACCOUNT").font(.caption.weight(.semibold)).foregroundStyle(.secondary)
                        Text("Welcome back").font(.largeTitle.weight(.bold))
                        Text("Sign in to unlock your account on this device.").foregroundStyle(.secondary)
                    }
                    .padding(.vertical, 8)
                }
                .listRowBackground(Color.clear)
                if !error.isEmpty {
                    Section { Text(error).foregroundStyle(.red) }
                }
                Section {
                    TextField("Email", text: $email)
                        .keyboardType(.emailAddress).textContentType(.username)
                        .textInputAutocapitalization(.never).autocorrectionDisabled()
                        .submitLabel(.next).focused($focus, equals: .email)
                        .onSubmit { focus = .password }
                    HStack {
                        Group {
                            if showPassword {
                                TextField("Password", text: $password)
                            } else {
                                SecureField("Password", text: $password)
                            }
                        }
                        .textContentType(.password).textInputAutocapitalization(.never).autocorrectionDisabled()
                        .submitLabel(.go).focused($focus, equals: .password)
                        .onSubmit { submit() }
                        Button { showPassword.toggle() } label: {
                            Image(systemName: showPassword ? "eye.slash" : "eye").foregroundStyle(.secondary)
                        }
                        .buttonStyle(.plain)
                        .accessibilityLabel(showPassword ? "Hide password" : "Show password")
                    }
                } footer: {
                    VStack(alignment: .leading, spacing: 4) {
                        Text("Password stays on this device.")
                        Text("Your account key is unwrapped here and never sent.")
                    }
                }
                Section {
                    Button(action: submit) {
                        HStack {
                            Spacer()
                            if pending { ProgressView().padding(.trailing, 6) }
                            Text(pending ? "Unlocking…" : "Sign in").fontWeight(.semibold)
                            Spacer()
                        }
                    }
                    .buttonStyle(.borderedProminent).controlSize(.large).disabled(pending)
                    .listRowBackground(Color.clear).listRowInsets(EdgeInsets())
                }
                Section {
                    if let url = Auth.recoveryURL(origin: model.origin) {
                        Link("Forgot your password?", destination: url)
                    }
                } footer: {
                    Text("Recovery uses your recovery phrase and runs on the web.")
                }
            }
            .navigationTitle("HushOS")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                // Advanced: which HushOS this phone talks to, behind a gear so nobody else has to read an address.
                ToolbarItem(placement: .topBarTrailing) {
                    Button { showingServer = true } label: { Image(systemName: "gearshape") }.accessibilityLabel("Advanced")
                }
            }
            .alert("HushOS address", isPresented: $showingServer) {
                TextField("https://hush.example", text: $model.origin)
                    .keyboardType(.URL).textInputAutocapitalization(.never).autocorrectionDisabled()
                Button("Done") {}
            } message: {
                Text("Only for a self-hosted HushOS. Leave it alone otherwise.")
            }
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
                try await model.signIn(email: address, password: password)
                password = ""
            } catch {
                self.error = (error as? LocalizedError)?.errorDescription ?? error.localizedDescription
            }
            pending = false
        }
    }
}
