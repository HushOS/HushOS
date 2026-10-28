import HushOSKit
import SwiftUI

/*
 * Create an account, in the app, with the web's words (apps/web routes/register): the email and
 * the terms, Check your inbox, the emailed link (which opens here), then a name and a password.
 * The keys are made on this phone (Auth.register over the core's accountCreate). Once signed
 * in, the recovery kit comes next (FirstKitView), and the drive opens once it is checked. No
 * plans, prices or codes anywhere here: those stay on the web.
 */
struct SignupView: View {
    @Environment(AppModel.self) private var model
    @State private var step: Step = .email
    @State private var email = ""
    @State private var agreed = false
    @State private var tried = false
    @State private var pending = false
    @State private var error = ""
    @State private var resent = false

    enum Step: Equatable { case email, inbox(String), checking, linkFailed(String), details(SignupEnrollment), created }

    var body: some View {
        NavigationStack {
            Group {
                switch step {
                case .email: emailStep
                case let .inbox(address): inbox(address)
                case .checking: checking
                case let .linkFailed(why): linkFailed(why)
                case let .details(enrollment): SignupDetails(enrollment: enrollment) { step = .created }
                case .created: created
                }
            }
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                if step != .checking {
                    ToolbarItem(placement: .cancellationAction) { Button("Cancel") { model.signupDone() } }
                }
            }
        }
        .interactiveDismissDisabled()
        .task(id: model.signupLink) { await openLink() }
    }

    /* The emailed link arrived (or opened the app): trade its token for the enrollment. */
    private func openLink() async {
        guard let token = model.signupLink else { return }
        step = .checking
        // Cleared only once the check is done: clearing it first changes the task's id and cancels this request.
        defer { if model.signupLink == token { model.signupLink = nil } }
        do {
            step = .details(try await Auth.verifySignupLink(origin: model.origin, token: token))
        } catch is CancellationError {
        } catch {
            step = .linkFailed(ErrorWords.say(error, otherwise: "Please try again.") ?? "Please try again.")
        }
    }

    private var emailProblem: String? { SignupRules.email(email) }
    private var agreeProblem: String? { SignupRules.agreed(agreed) }

    private var emailStep: some View {
        Form {
            Section {} header: {
                VStack(alignment: .leading, spacing: Alpine.Space.s1) {
                    Text("We’ll email you a link to confirm it’s you.")
                    if let host = model.selfHostedName { Text("On \(host)") }
                }
                .font(Theme.Text.callout).foregroundStyle(Alpine.inkMuted).textCase(nil)
            }
            if !error.isEmpty { Section { Text(error).foregroundStyle(Alpine.danger).alpineRow() } }
            Section {
                TextField("Email", text: $email, prompt: Text("Email"))
                    .keyboardType(.emailAddress).textContentType(.username)
                    .textInputAutocapitalization(.never).autocorrectionDisabled()
                    .onSubmit(send).alpineRow()
            } footer: {
                if tried, let emailProblem { Text(emailProblem).foregroundStyle(Alpine.danger) }
            }
            Section {
                Button { agreed.toggle() } label: {
                    HStack(alignment: .top, spacing: Alpine.Space.s3) {
                        // Round, as iOS's own agree rows are (Reminders, Apple's terms).
                        Image(systemName: agreed ? "checkmark.circle.fill" : "circle").font(.title3).foregroundStyle(agreed ? Alpine.primary : Alpine.field)
                        Text("I agree to the Terms of Service and Privacy Policy").foregroundStyle(Alpine.ink).frame(maxWidth: .infinity, alignment: .leading)
                    }
                    .frame(minHeight: Theme.control).contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityAddTraits(agreed ? .isSelected : [])
                .alpineRow()
                .listRowSeparator(.hidden)
                // The server's own terms and policy, the app=1 pages that link to nothing that sells.
                HStack(spacing: Alpine.Space.s4) {
                    Button("Terms of Service") { if let url = Auth.termsURL(origin: model.origin) { PolicyLinks.present(url) } }
                    Button("Privacy Policy") { if let url = Auth.privacyURL(origin: model.origin) { PolicyLinks.present(url) } }
                }
                .font(Theme.Text.callout.weight(.semibold)).foregroundStyle(Alpine.primary).buttonStyle(.plain)
                .frame(minHeight: Theme.control).alpineRow()
                .listRowSeparator(.hidden)
            } footer: {
                if tried, let agreeProblem { Text(agreeProblem).foregroundStyle(Alpine.danger) }
            }
            Section {
                Button(action: send) { Text(pending ? "Sending…" : "Send link").frame(maxWidth: .infinity) }
                    .buttonStyle(PrimaryCapsuleStyle()).disabled(pending)
                    .listRowBackground(Color.clear).listRowInsets(EdgeInsets()).listRowSeparator(.hidden)
                Button("Already have an account? Sign in") { model.signupDone() }
                    .font(Theme.Text.callout.weight(.semibold)).foregroundStyle(Alpine.primary)
                    .frame(maxWidth: .infinity, minHeight: Theme.control).listRowBackground(Color.clear).listRowSeparator(.hidden)
            }
        }
        .alpineGrouped()
        .navigationTitle("Create your account")
    }

    private func send() {
        tried = true
        guard emailProblem == nil, agreeProblem == nil, !pending else { return }
        let address = email.trimmingCharacters(in: .whitespacesAndNewlines)
        pending = true
        error = ""
        Task {
            do {
                try await Auth.requestSignupEmail(origin: model.origin, email: address)
                if case .inbox = step { resent = true }
                step = .inbox(address)
            } catch {
                if let words = ErrorWords.say(error, otherwise: "Please try again.") { self.error = words }
            }
            pending = false
        }
    }

    private func inbox(_ address: String) -> some View {
        Form {
            Section {} header: {
                Text("We sent a link to \(Text(address).fontWeight(.semibold)). Open it to carry on. It works once, for 30 minutes.")
                    .font(Theme.Text.callout).foregroundStyle(Alpine.inkMuted).textCase(nil)
            }
            if resent { Section { Text("New link sent to \(address).").foregroundStyle(Alpine.success).alpineRow() } }
            if !error.isEmpty { Section { Text(error).foregroundStyle(Alpine.danger).alpineRow() } }
            Section {
                Button(action: send) { Text(pending ? "Sending…" : "Send a new link").frame(maxWidth: .infinity) }
                    .buttonStyle(SecondaryCapsuleStyle()).disabled(pending)
                    .listRowBackground(Color.clear).listRowInsets(EdgeInsets()).listRowSeparator(.hidden)
                Button("Use another email") { resent = false; step = .email }
                    .font(Theme.Text.callout.weight(.semibold)).foregroundStyle(Alpine.primary)
                    .frame(maxWidth: .infinity, minHeight: Theme.control).listRowBackground(Color.clear).listRowSeparator(.hidden)
            } footer: {
                Text("Not there? Check your spam folder. The link opens HushOS on this phone, or the web anywhere else.")
            }
        }
        .alpineGrouped()
        .navigationTitle("Check your inbox")
    }

    private var checking: some View {
        VStack(spacing: Alpine.Space.s3) {
            ProgressView()
            Text("This only takes a moment.").font(Theme.Text.callout).foregroundStyle(Alpine.inkMuted)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Alpine.ground)
        .navigationTitle("Checking your link…")
    }

    private func linkFailed(_ why: String) -> some View {
        let otherFlow = why.contains("different account flow")
        let expired = why.range(of: "expired|invalid|used|not valid|no longer", options: [.regularExpression, .caseInsensitive]) != nil
        return Form {
            Section {} header: {
                Text(otherFlow ? "It resets a password rather than creating an account. Open the newest email, or ask for a new link here."
                     : expired ? "Links work once, for 30 minutes. Send yourself a new one and open the newest email." : why)
                    .font(Theme.Text.callout).foregroundStyle(Alpine.inkMuted).textCase(nil)
            }
            Section {
                Button { step = .email } label: { Text("Send a new link").frame(maxWidth: .infinity) }
                    .buttonStyle(PrimaryCapsuleStyle())
                    .listRowBackground(Color.clear).listRowInsets(EdgeInsets()).listRowSeparator(.hidden)
            }
        }
        .alpineGrouped()
        .navigationTitle(otherFlow ? "This link is for something else" : expired ? "This link has expired" : "This link didn’t work")
    }

    /* The account exists but the sign-in after it didn't happen: sign in, and the kit comes first. */
    private var created: some View {
        Form {
            Section {} header: {
                Text("Sign in with your new password to carry on. You’ll save your recovery kit next.")
                    .font(Theme.Text.callout).foregroundStyle(Alpine.inkMuted).textCase(nil)
            }
            Section {
                Button { model.signupDone() } label: { Text("Sign in").frame(maxWidth: .infinity) }
                    .buttonStyle(PrimaryCapsuleStyle())
                    .listRowBackground(Color.clear).listRowInsets(EdgeInsets()).listRowSeparator(.hidden)
            }
        }
        .alpineGrouped()
        .navigationTitle("Your account is ready")
    }
}

/* Name and password, the web's "Set up your account". The password stays in this view's memory only. */
private struct SignupDetails: View {
    @Environment(AppModel.self) private var model
    let enrollment: SignupEnrollment
    let createdWithoutSignIn: () -> Void
    @State private var name = ""
    @State private var password = ""
    @State private var confirm = ""
    @State private var tried = false
    @State private var pending = false
    @State private var error = ""

    private var nameProblem: String? { SignupRules.name(name) }
    private var passwordProblem: String? { SignupRules.password(password) }
    private var confirmProblem: String? { SignupRules.confirm(password, confirm) }

    var body: some View {
        Form {
            Section {} header: {
                Text("Your email is confirmed: \(Text(enrollment.email).fontWeight(.semibold))")
                    .font(Theme.Text.callout).foregroundStyle(Alpine.inkMuted).textCase(nil)
            }
            if !error.isEmpty { Section { Text(error).foregroundStyle(Alpine.danger).alpineRow() } }
            Section {
                TextField("Name", text: $name).textContentType(.name).textInputAutocapitalization(.words).disabled(pending).alpineRow()
            } footer: {
                if tried, let nameProblem { Text(nameProblem).foregroundStyle(Alpine.danger) } else { Text("Shown to people you share with.") }
            }
            Section {
                PasswordField(label: "Password", text: $password, content: .newPassword).disabled(pending).alpineRow()
                PasswordField(label: "Confirm password", text: $confirm, content: .newPassword).disabled(pending).alpineRow()
            } footer: {
                if tried, let passwordProblem { Text(passwordProblem).foregroundStyle(Alpine.danger) }
                else if tried || (!confirm.isEmpty && confirm.utf16.count >= password.utf16.count), let confirmProblem { Text(confirmProblem).foregroundStyle(Alpine.danger) }
                else { PasswordHint(password).text }
            }
            Section {
                Button(action: submit) { Text(pending ? "Creating your account…" : "Create account").frame(maxWidth: .infinity) }
                    .buttonStyle(PrimaryCapsuleStyle()).disabled(pending)
                    .listRowBackground(Color.clear).listRowInsets(EdgeInsets()).listRowSeparator(.hidden)
            }
        }
        .alpineGrouped()
        .navigationTitle("Set up your account")
    }

    private func submit() {
        tried = true
        UIApplication.shared.sendAction(#selector(UIResponder.resignFirstResponder), to: nil, from: nil, for: nil)
        guard nameProblem == nil, passwordProblem == nil, confirmProblem == nil, !pending else { return }
        pending = true
        error = ""
        Task {
            do {
                // Signed in, the model closes this screen and the kit shows; only a missed sign-in comes back here.
                if try await !model.createAccount(enrollment, name: name.trimmingCharacters(in: .whitespacesAndNewlines), password: password) {
                    createdWithoutSignIn()
                }
            } catch {
                if let words = ErrorWords.say(error, otherwise: "Please try again.") { self.error = words }
            }
            pending = false
        }
    }
}

/*
 * The new account's recovery kit, before the drive (the web's /setup/recovery-key): the words read
 * back from the account, Save the kit, Copy is left out (the web's kit and check are the way), "I’ve
 * saved…", then three words picked back. No way past it but the check; the server's own answer
 * (saved already, on the web) lets the drive open too.
 */
struct FirstKitView: View {
    @Environment(AppModel.self) private var model
    @State private var phrase: String?
    @State private var error = ""
    @State private var saved = false
    @State private var checking = false
    @State private var attempt = 0

    var body: some View {
        NavigationStack {
            Form {
                Section {} header: {
                    Text("If you forget your password, these words are the only way back into your account.")
                        .font(Theme.Text.callout).foregroundStyle(Alpine.inkMuted).textCase(nil)
                }
                if let phrase {
                    Section { PhraseGrid(phrase: phrase, columns: 3).padding(.vertical, Alpine.Space.s2).alpineRow() }
                    Section {
                        // Not filled: the screen's one filled button is Continue, below.
                        Button {
                            Task { await KitShare.present(phrase: phrase, email: model.user?.email ?? "", accountId: model.user?.id ?? "") }
                        } label: { Text("Save the kit").frame(maxWidth: .infinity) }
                            .buttonStyle(SecondaryCapsuleStyle())
                            .listRowBackground(Color.clear).listRowInsets(EdgeInsets()).listRowSeparator(.hidden)
                    } footer: {
                        Text("Print it, save it to Files, or write the words down, and keep it somewhere safe.")
                    }
                    SavedCheck(saved: $saved, title: "Continue") { checking = true }
                } else if !error.isEmpty {
                    Section { Text(error).foregroundStyle(Alpine.danger).alpineRow() }
                    Section {
                        Button { attempt += 1 } label: { Text("Try again").frame(maxWidth: .infinity) }
                            .buttonStyle(PrimaryCapsuleStyle())
                            .listRowBackground(Color.clear).listRowInsets(EdgeInsets()).listRowSeparator(.hidden)
                    }
                } else {
                    Section { ProgressView().frame(maxWidth: .infinity).alpineRow() }
                }
            }
            .alpineGrouped()
            .navigationTitle("Save your recovery kit")
            .navigationBarTitleDisplayMode(.inline)
            .navigationDestination(isPresented: $checking) {
                if let phrase {
                    CheckWordsView(phrase: phrase, recoveryVersion: nil) {
                        NoticeCenter.shared.show("Recovery phrase saved")
                        model.wordsChecked()
                    }
                }
            }
            .task(id: attempt) { await load() }
        }
    }

    private func load() async {
        error = ""
        // Checked already (on the web, or before this phone was stopped): nothing waits.
        if let key = try? await Auth.recoveryKey(), key.confirmed { model.wordsChecked(); return }
        guard let vault = model.vault else { error = "Your recovery phrase didn’t open. Try again."; return }
        do { phrase = try await vault.recoveryPhrase() } catch {
            self.error = ErrorWords.say(error, otherwise: "Your recovery phrase didn’t open. Try again.") ?? ""
        }
    }
}
