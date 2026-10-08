import HushOSKit
import SwiftUI
import UniformTypeIdentifiers
import VisionKit

/*
 * Forgot your password, in the app, with the web's words (apps/web routes/recover):
 * the email step, Check your inbox, the emailed link (which opens here), the kit
 * (scanned, chosen as a file, or typed), a new password, then the new phrase to save
 * and check. The link still works on the web too, on any device.
 */
struct RecoveryView: View {
    @Environment(AppModel.self) private var model
    @State private var step: Step = .email
    @State private var email = ""
    @State private var pending = false
    @State private var error = ""
    @State private var resent = false

    enum Step: Equatable {
        case email, inbox(String), checking, linkFailed(String), kit(RecoveryEnrollment), done(RecoveredAccount)

        static func == (a: Step, b: Step) -> Bool {
            switch (a, b) {
            case (.email, .email), (.checking, .checking): return true
            case let (.inbox(x), .inbox(y)), let (.linkFailed(x), .linkFailed(y)): return x == y
            case let (.kit(x), .kit(y)): return x == y
            case let (.done(x), .done(y)): return x.phrase == y.phrase
            default: return false
            }
        }
    }

    private var finished: Bool { if case .done = step { return true } else { return false } }

    var body: some View {
        NavigationStack {
            Group {
                switch step {
                case .email: emailStep
                case let .inbox(address): inbox(address)
                case .checking: checking
                case let .linkFailed(why): linkFailed(why)
                case let .kit(enrollment): RecoverKitStep(enrollment: enrollment) { step = .done($0) }
                case let .done(account): NewPhraseStep(account: account) { model.recoveryDone() }
                }
            }
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                if !finished {
                    ToolbarItem(placement: .cancellationAction) { Button("Cancel") { model.recoveryDone() } }
                }
            }
        }
        .interactiveDismissDisabled()
        .onAppear { if email.isEmpty { email = model.lastEmail } }
        .task(id: model.recoveryLink) { await openLink() }
    }

    /* The emailed link arrived (or opened the app): trade its token for the enrollment. */
    private func openLink() async {
        guard let token = model.recoveryLink else { return }
        step = .checking
        // Cleared only once the check is done: clearing it first changes the task's id, which
        // cancels this task and its request mid-flight.
        defer { if model.recoveryLink == token { model.recoveryLink = nil } }
        do {
            step = .kit(try await Auth.verifyRecoveryLink(origin: model.origin, token: token))
        } catch is CancellationError {
        } catch {
            step = .linkFailed((error as? LocalizedError)?.errorDescription ?? "Please try again.")
        }
    }

    private var emailStep: some View {
        Form {
            Section {} header: {
                Text("You’ll need your recovery kit, or the 24 words on it. We’ll email you a link to start.")
                    .font(Theme.Text.callout).foregroundStyle(Alpine.inkMuted).textCase(nil)
            }
            if !error.isEmpty { Section { Text(error).foregroundStyle(Alpine.danger).alpineRow() } }
            Section {
                TextField("name@example.com", text: $email)
                    .keyboardType(.emailAddress).textContentType(.username)
                    .textInputAutocapitalization(.never).autocorrectionDisabled()
                    .onSubmit(send).alpineRow()
            } header: {
                Text("Email").font(Theme.Text.label).foregroundStyle(Alpine.inkMuted)
            }
            Section {
                Button(action: send) { Text(pending ? "Sending…" : "Send link").frame(maxWidth: .infinity) }
                    .buttonStyle(PrimaryCapsuleStyle()).disabled(pending)
                    .listRowBackground(Color.clear).listRowInsets(EdgeInsets())
            }
        }
        .alpineGrouped()
        .navigationTitle("Reset your password")
    }

    private func send() {
        let address = email.trimmingCharacters(in: .whitespaces)
        guard address.contains("@") else { error = "Enter your email address."; return }
        pending = true
        error = ""
        Task {
            do {
                try await Auth.requestRecoveryEmail(origin: model.origin, email: address)
                if case .inbox = step { resent = true }
                step = .inbox(address)
            } catch {
                self.error = (error as? LocalizedError)?.errorDescription ?? "Please try again."
            }
            pending = false
        }
    }

    private func inbox(_ address: String) -> some View {
        Form {
            Section {} header: {
                Text("We sent a link to \(Text(address).fontWeight(.semibold)). Open it to reset your password. It works once, for 30 minutes.")
                    .font(Theme.Text.callout).foregroundStyle(Alpine.inkMuted).textCase(nil)
            }
            if resent { Section { Text("New link sent to \(address).").foregroundStyle(Alpine.success).alpineRow() } }
            if !error.isEmpty { Section { Text(error).foregroundStyle(Alpine.danger).alpineRow() } }
            Section {
                Button(action: send) { Text(pending ? "Sending…" : "Send a new link").frame(maxWidth: .infinity) }
                    .buttonStyle(SecondaryCapsuleStyle()).disabled(pending)
                    .listRowBackground(Color.clear).listRowInsets(EdgeInsets())
                Button("Use another email") { resent = false; step = .email }
                    .font(Theme.Text.callout.weight(.semibold)).foregroundStyle(Alpine.primary)
                    .frame(maxWidth: .infinity).listRowBackground(Color.clear)
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
                Text(otherFlow ? "It creates an account rather than resetting a password. Open the newest email, or ask for a new link here."
                     : expired ? "Links work once, for 30 minutes. Send yourself a new one and open the newest email." : why)
                    .font(Theme.Text.callout).foregroundStyle(Alpine.inkMuted).textCase(nil)
            }
            Section {
                Button { step = .email } label: { Text("Send a new link").frame(maxWidth: .infinity) }
                    .buttonStyle(PrimaryCapsuleStyle())
                    .listRowBackground(Color.clear).listRowInsets(EdgeInsets())
            }
        }
        .alpineGrouped()
        .navigationTitle(otherFlow ? "This link is for something else" : expired ? "This link has expired" : "This link didn’t work")
    }
}

/*
 * "Use your recovery kit": scan the printed kit, choose the kit file, or type the 24 words;
 * then the new password. The kit is read on this phone and never uploaded.
 */
private struct RecoverKitStep: View {
    @Environment(AppModel.self) private var model
    let enrollment: RecoveryEnrollment
    let done: (RecoveredAccount) -> Void

    private enum Source: Equatable { case kit(String), typed }
    @State private var source: Source?
    @State private var words: [String] = []
    @State private var typed = ""
    @State private var notKit = false
    @State private var choosingFile = false
    @State private var scanning = false
    @State private var password = ""
    @State private var confirm = ""
    @State private var tried = false
    @State private var pending = false
    @State private var error = ""
    // Where a failed submit scrolls, so the reason isn't left above the keyboard, out of sight.
    @State private var reveal: String?

    private var typedWords: [String] { Recovery.typedWords(typed) }
    private var phrase: [String] { source == .typed ? typedWords : words }

    private var typedProblem: String? {
        guard source == .typed, typedWords.count != Recovery.words else { return nil }
        let count = typedWords.count
        return "\(count < Recovery.words ? "\(Recovery.words - count) \(Recovery.words - count == 1 ? "word" : "words") missing." : "Too many words.") Type all \(Recovery.words), in order, with spaces between them."
    }

    private var passwordProblem: String? { password.count < 12 ? "Use at least 12 characters." : nil }
    private var confirmProblem: String? { confirm == password ? nil : "The passwords don’t match." }

    var body: some View {
        ScrollViewReader { proxy in form.onChange(of: reveal) {
            guard let reveal else { return }
            withAnimation { proxy.scrollTo(reveal, anchor: .top) }
            self.reveal = nil
        } }
    }

    private var form: some View {
        Form {
            if source == nil {
                Section {} header: {
                    Text("Your email is confirmed. Your kit shows the account is yours; then you choose a new password.")
                        .font(Theme.Text.callout).foregroundStyle(Alpine.inkMuted).textCase(nil)
                }
                if notKit {
                    Section { Text("That isn’t a HushOS recovery kit. Choose hushos-recovery-kit.txt, or type the words.").foregroundStyle(Alpine.danger).alpineRow() }
                }
                Section {
                    choice("qrcode.viewfinder", "Scan your kit", "Point the camera at the printed kit.") { scanning = true }
                    choice("doc.text", "Choose the kit file", "hushos-recovery-kit.txt") { choosingFile = true }
                    choice("character.cursor.ibeam", "Type the 24 words", "For a kit written by hand.") { source = .typed; notKit = false }
                } footer: {
                    Text("It’s read on this phone and never uploaded.")
                }
            } else {
                Section {} header: {
                    Text("Resetting gives you a new recovery phrase; you’ll save it next.").font(Theme.Text.callout).foregroundStyle(Alpine.inkMuted).textCase(nil)
                }
                if !error.isEmpty { Section { Text(error).foregroundStyle(Alpine.danger).alpineRow() }.id("error") }
                if case let .kit(name) = source {
                    Section {
                        Label { Text("\(Text("24 of 24 words read").fontWeight(.semibold)) from \(name)") } icon: { Image(systemName: "checkmark.circle") }
                            .foregroundStyle(Alpine.success).alpineRow()
                        PhraseGrid(phrase: words.joined(separator: " ")).padding(.vertical, Alpine.Space.s2).alpineRow()
                        Button("Use a different kit") { source = nil; words = []; error = "" }.foregroundStyle(Alpine.primary).alpineRow()
                    }
                } else {
                    typing
                }
                Section {
                    PasswordField(label: "New password", text: $password, content: .newPassword).alpineRow()
                    PasswordField(label: "Confirm new password", text: $confirm, content: .newPassword).alpineRow()
                } footer: {
                    if tried, let passwordProblem { Text(passwordProblem).foregroundStyle(Alpine.danger) }
                    else if tried || confirm.count >= password.count, !confirm.isEmpty, let confirmProblem { Text(confirmProblem).foregroundStyle(Alpine.danger) }
                    else { PasswordHint(password).text }
                }
                Section {
                    Button(action: submit) { Text(pending ? "Resetting…" : "Reset password").frame(maxWidth: .infinity) }
                        .buttonStyle(PrimaryCapsuleStyle()).disabled(pending)
                        .listRowBackground(Color.clear).listRowInsets(EdgeInsets())
                }
            }
        }
        .alpineGrouped()
        .navigationTitle(source == nil ? "Use your recovery kit" : "Choose a new password")
        .fileImporter(isPresented: $choosingFile, allowedContentTypes: [.plainText, .text, .data]) { result in
            guard case let .success(url) = result else { return }
            read(url)
        }
        .sheet(isPresented: $scanning) {
            KitScanner { found in
                scanning = false
                words = found
                notKit = false
                error = ""
                source = .kit("your kit’s code")
            }
        }
    }

    private var typing: some View {
        Section {
            TextField("", text: $typed, axis: .vertical)
                .font(.body.monospaced()).lineLimit(4 ... 8)
                .textInputAutocapitalization(.never).autocorrectionDisabled()
                .onChange(of: typed) { error = "" }
                .disabled(pending).alpineRow()
            // The word being typed, completed from the BIP-39 list.
            let last = typed.last.map { !$0.isWhitespace } == true ? (typedWords.last ?? "") : ""
            let options = Recovery.completions(last)
            if !options.isEmpty, options != [last] {
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: Alpine.Space.s2) {
                        ForEach(options, id: \.self) { word in
                            Button(word) { complete(with: word) }
                                .font(.callout.monospaced().weight(.semibold)).foregroundStyle(Alpine.onTint)
                                .padding(.horizontal, 12).frame(height: 32).background(Alpine.tint, in: Capsule()).buttonStyle(.plain)
                        }
                    }
                }
                .alpineRow()
            }
            Button("Use your recovery kit instead") { source = nil }.foregroundStyle(Alpine.primary).alpineRow()
        } header: {
            HStack {
                Text("Recovery phrase").font(Theme.Text.label).foregroundStyle(Alpine.inkMuted)
                Spacer()
                Text("\(typedWords.count) of \(Recovery.words) words").font(Theme.Text.label.monospacedDigit())
                    .foregroundStyle(typedWords.count == Recovery.words ? Alpine.success : Alpine.inkMuted)
            }
            .textCase(nil)
        } footer: {
            if tried, let typedProblem { Text(typedProblem).foregroundStyle(Alpine.danger) } else { Text("All \(Recovery.words) words, in order.") }
        }
        .id("phrase")
    }

    private func choice(_ symbol: String, _ title: String, _ detail: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            HStack(spacing: Alpine.Space.s3) {
                SettingsGlyph(symbol: symbol)
                VStack(alignment: .leading, spacing: 2) {
                    Text(title).foregroundStyle(Alpine.ink)
                    Text(detail).font(Theme.Text.footnote).foregroundStyle(Alpine.inkMuted)
                }
                Spacer(minLength: 0)
                Image(systemName: "chevron.right").font(.footnote.weight(.semibold)).foregroundStyle(Alpine.inkMuted)
            }
            .frame(minHeight: Theme.row).contentShape(Rectangle())
        }
        .buttonStyle(.plain).alpineRow()
    }

    private func complete(with word: String) {
        var parts = typed.split(whereSeparator: \.isWhitespace).map(String.init)
        if !parts.isEmpty { parts.removeLast() }
        typed = (parts + [word]).joined(separator: " ") + " "
    }

    /* A kit is a few kilobytes; anything much larger isn't one. */
    private func read(_ url: URL) {
        let scoped = url.startAccessingSecurityScopedResource()
        defer { if scoped { url.stopAccessingSecurityScopedResource() } }
        let size = (try? url.resourceValues(forKeys: [.fileSizeKey]).fileSize) ?? 0
        guard size < 64 * 1024, let data = try? Data(contentsOf: url), let found = Recovery.phrase(fromKit: String(decoding: data, as: UTF8.self)) else {
            notKit = true
            return
        }
        notKit = false
        error = ""
        words = found
        source = .kit(url.lastPathComponent)
    }

    private func submit() {
        tried = true
        UIApplication.shared.sendAction(#selector(UIResponder.resignFirstResponder), to: nil, from: nil, for: nil)
        if typedProblem != nil { reveal = "phrase"; return }
        guard passwordProblem == nil, confirmProblem == nil, phrase.count == Recovery.words else { return }
        pending = true
        error = ""
        Task {
            do {
                let account = try await model.recover(enrollment, password: password, phrase: phrase)
                done(account)
            } catch {
                self.error = (error as? LocalizedError)?.errorDescription ?? "Please try again."
                reveal = "error"
                pending = false
            }
        }
    }
}

/* The camera on a printed kit: the numbered words (or a QR code holding the phrase), read live. */
private struct KitScanner: View {
    let found: ([String]) -> Void
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            Group {
                if DataScannerViewController.isSupported && DataScannerViewController.isAvailable {
                    ScannerView(found: found)
                        .ignoresSafeArea()
                        .overlay(alignment: .bottom) {
                            Text("Hold your kit’s code inside the frame.")
                                .font(Theme.Text.callout).foregroundStyle(.white).multilineTextAlignment(.center)
                                .padding(Alpine.Space.s3).background(.black.opacity(0.6), in: Capsule()).padding(Alpine.Space.s6)
                        }
                } else {
                    EmptyStateView(symbol: "camera", title: "This phone can’t scan here",
                                   message: "Choose the kit file or type the 24 words instead.")
                }
            }
            .navigationTitle("Scan your kit")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } } }
        }
    }
}

private struct ScannerView: UIViewControllerRepresentable {
    let found: ([String]) -> Void

    func makeCoordinator() -> Coordinator { Coordinator(found: found) }

    func makeUIViewController(context: Context) -> DataScannerViewController {
        let scanner = DataScannerViewController(recognizedDataTypes: [.text(), .barcode(symbologies: [.qr])], qualityLevel: .accurate,
                                                recognizesMultipleItems: true, isHighFrameRateTrackingEnabled: false, isHighlightingEnabled: true)
        scanner.delegate = context.coordinator
        try? scanner.startScanning()
        return scanner
    }

    func updateUIViewController(_ controller: DataScannerViewController, context: Context) {}

    final class Coordinator: NSObject, DataScannerViewControllerDelegate {
        let found: ([String]) -> Void
        private var done = false
        // What each frame read, kept across frames: one frame rarely shows all 24 words clearly.
        private var tally = Recovery.ScanTally()
        init(found: @escaping ([String]) -> Void) { self.found = found }

        func dataScanner(_ scanner: DataScannerViewController, didUpdate _: [RecognizedItem], allItems: [RecognizedItem]) { look(allItems) }
        func dataScanner(_ scanner: DataScannerViewController, didAdd _: [RecognizedItem], allItems: [RecognizedItem]) { look(allItems) }

        private func look(_ items: [RecognizedItem]) {
            guard !done else { return }
            let text = items.map { item -> String in
                switch item {
                case let .text(text): return text.transcript
                case let .barcode(code): return code.payloadStringValue ?? ""
                @unknown default: return ""
                }
            }.joined(separator: "\n")
            guard let words = tally.add(text) else { return }
            done = true
            Task { @MainActor in found(words) }
        }
    }
}

/* After the reset: the new phrase, Save the kit, then the three-word check, as after Reset sharing keys. */
private struct NewPhraseStep: View {
    @Environment(AppModel.self) private var model
    let account: RecoveredAccount
    let finish: () -> Void
    @State private var saved = false
    @State private var checking = false

    var body: some View {
        Form {
            Section {} header: {
                Text("Your old phrase no longer works. Save these 24 words before you leave this page.")
                    .font(Theme.Text.callout).foregroundStyle(Alpine.inkMuted).textCase(nil)
            }
            Section { PhraseGrid(phrase: account.phrase, columns: 3).padding(.vertical, Alpine.Space.s2).alpineRow() }
            Section {
                Button {
                    Task { await KitShare.present(phrase: account.phrase, email: account.user.email, accountId: account.user.id) }
                } label: { Text("Save the kit").frame(maxWidth: .infinity) }
                    .buttonStyle(PrimaryCapsuleStyle())
                    .listRowBackground(Color.clear).listRowInsets(EdgeInsets())
            }
            SavedCheck(saved: $saved, title: "Continue") { checking = true }
        }
        .alpineGrouped()
        .navigationTitle("Your new recovery phrase")
        .navigationDestination(isPresented: $checking) {
            CheckWordsView(phrase: account.phrase, recoveryVersion: account.recoveryVersion) {
                NoticeCenter.shared.show("Recovery phrase saved")
                finish()
            }
        }
    }
}
