import HushOSKit
import SwiftUI
import UIKit

/*
 * Two-step sign-in (docs/two-step-design.md 4 to 7), as the web has it: the step a sign-in stops at,
 * the step a security change asks for, and Account › Two-step sign-in, where it is turned on with an
 * authenticator app, its backup codes are shown once, the app is replaced or removed, new codes are
 * made, and the account's recent security activity is listed. Codes are checked on the server; the
 * recovery phrase is signed on this iPhone and never leaves it. The words are the web's and the
 * server's own.
 */

/* MARK: The answer's field */

private extension StepMethod {
    var label: String {
        switch self {
        case .totp: "Code from your authenticator app"
        case .backup: "Backup code"
        case .phrase: "Recovery phrase"
        }
    }

    var other: String {
        switch self {
        case .totp: "Use your authenticator app"
        case .backup: "Use a backup code"
        case .phrase: "Use your recovery phrase"
        }
    }

    var hint: String {
        switch self {
        case .totp: "The 6-digit code. It changes every 30 seconds."
        case .backup: "One of the ten codes you saved. Each works once."
        case .phrase: "All 24 words, in order. They stay on this device."
        }
    }
}

/* The one field a step's answer is typed in: a code (filled from a password manager or a message), a backup code, or the phrase. */
struct StepField: View {
    let method: StepMethod
    @Binding var draft: StepDraft
    var submit: (() -> Void)?
    @FocusState private var focused: Bool
    var focus = false
    // While the screen is recorded, mirrored or AirPlayed, what is typed is blurred: a code or a phrase in a
    // recording outlives the moment, and a mirrored screen is someone else's (ScreenCapture). The field still works.
    @State private var capture = ScreenCapture.shared

    var body: some View {
        Group {
            switch method {
            case .totp:
                TextField("000000", text: Binding(get: { draft.totp }, set: { draft.totp = String($0.filter { StepDraft.digit($0) || $0 == " " }.prefix(7)) }))
                    .keyboardType(.numberPad).textContentType(.oneTimeCode)
                    .kerning(3)
            case .backup:
                TextField("XXXXX-XXXXX", text: Binding(get: { draft.backup }, set: { draft.backup = String($0.prefix(16)) }))
                    .keyboardType(.asciiCapable).textInputAutocapitalization(.characters)
                    .kerning(1)
            case .phrase:
                // The field the recovery screens type the phrase in (PhraseEntry): no predictions, spelling, smart
                // punctuation or Writing Tools, so the keyboard neither learns the words nor offers them elsewhere.
                PhraseEntry(text: $draft.phrase).frame(minHeight: 112)
            }
        }
        .font(.body.monospaced()).foregroundStyle(Alpine.ink)
        .blur(radius: capture.active ? 10 : 0)
        .autocorrectionDisabled()
        .focused($focused)
        .submitLabel(.go)
        .onSubmit { submit?() }
        .accessibilityLabel(method.label)
        .onAppear { if focus { focused = true } }
        // Another method is another field: it takes the cursor once it is on screen, not in the update that makes it.
        .onChange(of: method) { if focus { Task { @MainActor in focused = true } } }
    }
}

/* What is under the field: the complaint about it, or what to type; and for the phrase, how many words so far. */
private struct StepNote: View {
    let method: StepMethod
    let draft: StepDraft
    let problem: String

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            if method == .phrase {
                let count = StepDraft.words(draft.phrase).count
                Text("\(count) of 24 words").monospacedDigit().foregroundStyle(count == 24 ? Alpine.success : Alpine.inkMuted)
            }
            Text(problem.isEmpty ? method.hint : problem).foregroundStyle(problem.isEmpty ? Alpine.inkMuted : Alpine.danger)
        }
        .font(Theme.Text.footnote)
    }
}

/* The step's fields inside a form that changes the account: under the form's own fields, answered with the same press. */
struct StepUpSections: View {
    @Bindable var step: StepUpModel
    var disabled = false

    var body: some View {
        if step.step.asked {
            if let method = step.step.shown {
                Section {
                    StepField(method: method, draft: Binding(get: { step.step.draft }, set: { step.step.draft = $0; step.step.typed() }))
                        .disabled(disabled).alpineRow()
                    ForEach(step.step.methods.filter { $0 != method }, id: \.self) { other in
                        Button(other.other) { step.step.draft.method = other; step.step.typed() }
                            .foregroundStyle(Alpine.primary).disabled(disabled).alpineRow()
                    }
                } header: {
                    VStack(alignment: .leading, spacing: Alpine.Space.s2) {
                        Text("Two-step sign-in is on, so this needs your second step too.")
                            .font(Theme.Text.footnote).foregroundStyle(Alpine.inkMuted).textCase(nil)
                        FieldLabel(method.label)
                    }
                    .padding(.top, Alpine.Space.s2)
                } footer: {
                    StepNote(method: method, draft: step.step.draft, problem: step.step.problem)
                }
            } else {
                Section { Text(step.step.challenge?.methods.isEmpty == true ? StepWords.cannotAnswer : StepWords.noWayLeft).foregroundStyle(Alpine.danger).alpineRow() }
            }
        }
    }
}

/*
 * A change's step, for the forms: asked for when the form opens if the account has one, proved with
 * the change, and after a refusal either explained beside its field or asked for afresh.
 */
@Observable
@MainActor
final class StepUpModel {
    var step: StepUp

    init(_ purpose: StepPurpose) { step = StepUp(purpose: purpose) }

    /* The form opened: an account with the step sees its fields from the start. Quiet when that can't be told; the change's own refusal asks then. */
    func prepare() async {
        guard !step.asked, let status = try? await TwoStep.status(), status.on else { return }
        if let challenge = try? await TwoStep.challenge(step.purpose) { step.take(challenge) }
    }

    func prove() throws -> StepAnswer? { try step.prove() }

    /* After a failed change: nil when the step's own fields say what happened, else the words for the form. */
    func failed(_ error: Error) async -> String? {
        switch step.failed(error) {
        case .notStep:
            return ErrorWords.say(error)
        case .again:
            return nil
        case .renew:
            do {
                step.take(try await TwoStep.challenge(step.purpose), keep: true)
                return nil
            } catch {
                return ErrorWords.say(error)
            }
        }
    }
}

/* MARK: Signing in */

/*
 * The second step of a sign-in: the password was right, and the account asks for a code, a backup
 * code or the recovery phrase before anything is handed over. A wrong answer stays here; a step
 * that is over goes back to the password with why; a reply that never arrived offers the same
 * answer again. Nothing leaves the person on a screen that can no longer be answered.
 */
struct SignInStepView: View {
    @Environment(AppModel.self) private var model
    let pending: PendingSignIn
    @State private var methods: [StepMethod]
    @State private var draft: StepDraft
    @State private var busy = false
    /* The field's own complaint. */
    @State private var fieldError = ""
    /* What the server, or a lost reply, said: above the field. */
    @State private var notice = ""
    /* The last reply was lost: the same answer goes again. */
    @State private var lost: StepAnswer?

    init(pending: PendingSignIn) {
        self.pending = pending
        _methods = State(initialValue: pending.challenge.methods)
        _draft = State(initialValue: StepDraft(methods: pending.challenge.methods))
    }

    private var method: StepMethod? { draft.shown(among: methods) }

    var body: some View {
        VStack(spacing: 0) {
            ScrollView {
                VStack(alignment: .leading, spacing: Alpine.Space.s6) {
                    Text("This account has two-step sign-in on.").font(.body).foregroundStyle(Alpine.inkMuted)
                        .padding(.horizontal, Alpine.Space.s1)
                    if !notice.isEmpty {
                        HStack(alignment: .firstTextBaseline, spacing: 10) {
                            Image(systemName: "exclamationmark.circle").font(Theme.Text.callout.weight(.semibold))
                            Text(notice).font(Theme.Text.callout).frame(maxWidth: .infinity, alignment: .leading)
                        }
                        .foregroundStyle(Alpine.warning)
                        .padding(.horizontal, Alpine.Space.s4).padding(.vertical, Alpine.Space.s3)
                        .background(Alpine.warningSoft, in: RoundedRectangle(cornerRadius: 20, style: .continuous))
                        .highContrastEdge(RoundedRectangle(cornerRadius: 20, style: .continuous))
                        .accessibilityElement(children: .combine)
                    }
                    if let method {
                        VStack(alignment: .leading, spacing: Alpine.Space.s2) {
                            FieldLabel(method.label).padding(.horizontal, Alpine.Space.s4)
                            StepField(method: method, draft: $draft, submit: submit, focus: true)
                                .disabled(busy)
                                .padding(.horizontal, Alpine.Space.s4).padding(.vertical, Alpine.Space.s3)
                                .frame(minHeight: 52)
                                .background(Alpine.surface, in: RoundedRectangle(cornerRadius: 26, style: .continuous))
                                .alpineCardEdge(RoundedRectangle(cornerRadius: 26, style: .continuous))
                            StepNote(method: method, draft: draft, problem: fieldError).padding(.horizontal, Alpine.Space.s4)
                        }
                        VStack(alignment: .leading, spacing: 0) {
                            ForEach(methods.filter { $0 != method }, id: \.self) { other in
                                Button(other.other) { draft.method = other }
                                    .font(Theme.Text.callout.weight(.semibold)).foregroundStyle(Alpine.primary)
                                    .frame(minHeight: Theme.control).disabled(busy)
                            }
                        }
                        .padding(.horizontal, Alpine.Space.s4)
                    } else {
                        // Nothing this build knows was offered: update. The ways ran out after refusals: updating would not help.
                        Text(pending.challenge.methods.isEmpty ? StepWords.cannotAnswer : StepWords.noWayLeft)
                            .font(Theme.Text.callout).foregroundStyle(Alpine.danger).padding(.horizontal, Alpine.Space.s4)
                    }
                }
                .padding(.horizontal, Alpine.Space.s4).padding(.top, Alpine.Space.s2)
            }
            .scrollDismissesKeyboard(.interactively)

            VStack(spacing: Alpine.Space.s2) {
                if method != nil {
                    Button(action: submit) {
                        Text(busy ? "Checking" : lost == nil ? "Continue" : "Try again").font(.body.weight(.semibold)).frame(maxWidth: .infinity, minHeight: 52)
                    }
                    .buttonStyle(PrimaryCapsuleStyle())
                    .disabled(busy)
                }
                Button("Start again") { model.cancelStep() }
                    .font(.body.weight(.semibold)).foregroundStyle(Alpine.primary).frame(minHeight: Theme.control)
                    .disabled(busy)
            }
            .padding(.horizontal, Alpine.Space.s4).padding(.top, Alpine.Space.s3).padding(.bottom, Alpine.Space.s4)
        }
        .background(Alpine.ground.ignoresSafeArea())
        .navigationTitle("One more step")
        .navigationBarTitleDisplayMode(.inline)
        .navigationBarBackButtonHidden(busy)
        .onChange(of: draft) { fieldError = ""; lost = nil }
    }

    private func submit() {
        guard !busy, let method else { return }
        let answer: StepAnswer
        if let lost {
            answer = lost
        } else {
            if let problem = draft.problem(for: method) { fieldError = problem; return }
            do {
                answer = try draft.answer(to: pending.challenge, method: method)
            } catch {
                // A mistyped phrase, refused here before anything is sent.
                if case .again(let message, _, _)? = StepOutcome.after(error, methods: methods) { fieldError = message }
                return
            }
        }
        fieldError = ""
        notice = ""
        busy = true
        Task {
            do {
                try await model.answerStep(answer.proof)
            } catch {
                lost = nil
                switch StepOutcome.after(error, methods: methods, tried: answer.method) {
                case .again(let message, let field, let left)?:
                    methods = left
                    if field { fieldError = message } else { notice = message }
                case .retry(let message)?:
                    notice = message
                    lost = answer
                case .over(let message)?:
                    model.cancelStep(message, token: pending.challenge.token)
                case nil:
                    break
                }
            }
            busy = false
        }
    }
}

/* MARK: Account › Two-step sign-in */

struct TwoStepView: View {
    @Environment(AppModel.self) private var model
    @Environment(DriveStore.self) private var store
    @State private var status: TwoStepStatus?
    @State private var loaded = false
    @State private var problem = ""
    @State private var events: [SecurityEvent] = []
    @State private var allEvents = false
    @State private var open: Open?

    enum Open: String, Identifiable {
        case on, replace, off, codes
        var id: String { rawValue }
    }

    private static let shown = 5

    var body: some View {
        List {
            if !problem.isEmpty {
                Section {
                    Text(problem).foregroundStyle(Alpine.danger).alpineRow()
                    Button("Try again") { Task { await load() } }.foregroundStyle(Alpine.primary).alpineRow()
                }
            } else if !loaded {
                Section { ProgressView().frame(maxWidth: .infinity).alpineRow() }
            } else if let status {
                Section {} header: {
                    Text("A second step stops someone who has your password from signing in. It doesn’t change how your files are encrypted.")
                        .font(Theme.Text.callout).foregroundStyle(Alpine.inkMuted).textCase(nil)
                }
                if status.on {
                    methods(status)
                    Section {
                        Text(status.codesLeft).foregroundStyle(Alpine.inkMuted).alpineRow()
                        Button("New codes") { open = .codes }.foregroundStyle(Alpine.primary).alpineRow()
                    } header: {
                        SectionTitle("Backup codes")
                    }
                } else {
                    Section {
                        Text("Off. Your password alone signs you in.").foregroundStyle(Alpine.inkMuted).alpineRow()
                        Button("Turn on") { open = .on }.foregroundStyle(Alpine.primary).alpineRow()
                    }
                }
                activity
            }
        }
        .listStyle(.insetGrouped)
        .alpineGrouped()
        .navigationTitle("Two-step sign-in")
        .screenChrome(title: "Two-step sign-in")
        .task { await load() }
        .refreshable { await load() }
        .sheet(item: $open) { which in
            switch which {
            case .on, .replace:
                AuthenticatorSheet(replacing: which == .replace, email: model.user?.email ?? "") { said in finish(said) }
            case .off:
                TurnOffSheet(methodId: status?.app?.id ?? status?.methods.first?.id) { said in finish(said) }
            case .codes:
                NewCodesSheet(email: model.user?.email ?? "") { said in finish(said) }
            }
        }
    }

    @ViewBuilder private func methods(_ status: TwoStepStatus) -> some View {
        Section {
            ForEach(status.methods) { method in
                // The app is the section's own name; a kind added later (a security key) is listed by its name.
                let paused = method.kind == "totp" && status.totpFrozen
                VStack(alignment: .leading, spacing: 2) {
                    HStack(spacing: Alpine.Space.s2) {
                        if method.kind != "totp" { Text(method.name ?? "Security key").foregroundStyle(Alpine.ink) }
                        Text(paused ? "Paused" : "On").fontWeight(.semibold).foregroundStyle(paused ? Alpine.warning : Alpine.ink)
                    }
                    Text(used(method)).font(Theme.Text.footnote).foregroundStyle(Alpine.inkMuted)
                }
                .alpineRow()
            }
            if status.app != nil {
                Button("Replace") { open = .replace }.foregroundStyle(Alpine.primary).alpineRow()
            }
            Button("Turn off", role: .destructive) { open = .off }.foregroundStyle(Alpine.danger).alpineRow()
        } header: {
            SectionTitle("Authenticator app")
        } footer: {
            if status.totpFrozen {
                Text("Its codes are refused on devices HushOS doesn’t recognise, after many wrong ones. A backup code or your recovery phrase works there, and lifts the pause.")
            }
        }
    }

    @ViewBuilder private var activity: some View {
        if !events.isEmpty {
            Section {
                ForEach(allEvents ? events : Array(events.prefix(Self.shown))) { event in
                    VStack(alignment: .leading, spacing: 2) {
                        Text(event.words).foregroundStyle(Alpine.ink)
                        Text([event.device, event.createdAt.map(Self.when)].compactMap { $0 }.joined(separator: " · "))
                            .font(Theme.Text.footnote).foregroundStyle(Alpine.inkMuted)
                    }
                    .alpineRow()
                }
                if events.count > Self.shown {
                    Button(allEvents ? "Show fewer" : "Show all \(events.count)") { allEvents.toggle() }.foregroundStyle(Alpine.primary).alpineRow()
                }
            } header: {
                SectionTitle("Recent security activity")
            }
        }
    }

    private func used(_ method: TwoStepStatus.Method) -> String {
        let added = method.createdAt.map { "Added \(Self.day($0))" }
        let last = method.lastUsedAt.map { "Last used \(Self.day($0))" }
        return [added, last].compactMap { $0 }.joined(separator: " · ")
    }

    /* "13 Nov", and the minute as the emails carry it: "13 Nov, 14:08". */
    private static func day(_ date: Date) -> String { date.formatted(Date.FormatStyle().day().month(.abbreviated).locale(.dayMonth)) }
    private static func when(_ date: Date) -> String { "\(day(date)), \(date.formatted(date: .omitted, time: .shortened))" }

    private func finish(_ said: String) {
        if !said.isEmpty { store.notify(said) }
        Task { await load() }
    }

    private func load() async {
        do {
            let next = try await TwoStep.status()
            status = next
            problem = ""
            loaded = true
            // The log is beside the settings, never instead of them: a failure there leaves it out.
            if next != nil { events = (try? await TwoStep.securityEvents()) ?? events }
        } catch {
            // An ended session is said as everywhere (the signed-out alert), not swallowed here.
            if endsSession(error) { store.report(error); return }
            if let words = ErrorWords.say(error, otherwise: "Two-step sign-in couldn’t be loaded.") { problem = words }
        }
    }
}

/* The password, asked again before any change to the step. */
private struct ConfirmPassword: View {
    @Binding var password: String
    let tried: Bool

    var body: some View {
        Section {
            PasswordField(label: "Password", text: $password, content: nil).alpineRow()
        } footer: {
            if tried && password.isEmpty { Text("Enter your password.").foregroundStyle(Alpine.danger) } else { Text("Enter your password to confirm.") }
        }
    }
}

private struct FormProblem: View {
    let text: String
    var body: some View {
        if !text.isEmpty { Section { Text(text).foregroundStyle(Alpine.danger).alpineRow() } }
    }
}

/* A sheet's opening words, as the other account sheets say theirs. */
private struct SheetIntro: View {
    let text: String
    var body: some View {
        Section {} header: { Text(text).font(Theme.Text.callout).foregroundStyle(Alpine.ink).textCase(nil) }
    }
}

private func primaryRow(_ title: String, disabled: Bool, action: @escaping () -> Void) -> some View {
    Section {
        Button(action: action) { Text(title).frame(maxWidth: .infinity) }
            .buttonStyle(PrimaryCapsuleStyle()).disabled(disabled)
            .listRowBackground(Color.clear).listRowInsets(EdgeInsets())
    }
}

/* This phone only, and gone in two minutes (the pasteboard's own expiry, as the recovery phrase's copy sets): not Universal Clipboard, not every app that reads the board later. */
@MainActor private func copyBriefly(_ text: String) {
    UIPasteboard.general.setItems([["public.utf8-plain-text": text]], options: [.localOnly: true, .expirationDate: Date().addingTimeInterval(120)])
}

/* The ten codes, shown once: to copy, or to share to wherever the person keeps such things. */
private struct BackupCodesList: View {
    let codes: [String]
    let email: String
    @State private var capture = ScreenCapture.shared

    var body: some View {
        Section {
            if capture.active {
                Label("Hidden while your screen is recorded or shared. Stop that to see the codes.", systemImage: "eye.slash")
                    .font(Theme.Text.callout).foregroundStyle(Alpine.inkMuted).alpineRow()
            } else {
                LazyVGrid(columns: Array(repeating: GridItem(.flexible(), spacing: Alpine.Space.s2), count: 2), alignment: .leading, spacing: Alpine.Space.s2) {
                    ForEach(codes, id: \.self) { code in
                        Text(code).font(.body.monospaced()).foregroundStyle(Alpine.ink).lineLimit(1).minimumScaleFactor(0.7)
                            .padding(.horizontal, Alpine.Space.s2).padding(.vertical, 6)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .background(Alpine.ground, in: RoundedRectangle(cornerRadius: Alpine.Radius.control))
                    }
                }
                .padding(.vertical, Alpine.Space.s2)
                .accessibilityElement(children: .contain).accessibilityLabel("Backup codes")
                .alpineRow()
            }
        } footer: {
            Text("Each code works once, when you can’t use your authenticator app. They aren’t shown again, so keep them somewhere apart from your password.")
        }
        Section {
            Button("Copy") {
                copyBriefly(codes.joined(separator: "\n"))
                NoticeCenter.shared.show("Backup codes copied. Cleared from the clipboard in two minutes.")
            }
            .foregroundStyle(Alpine.primary).alpineRow()
            // The share sheet without its own Copy: that one puts the codes on the general pasteboard for good, where
            // every app reads them and Universal Clipboard carries them to other devices. Copy above is the only way
            // they reach the clipboard, on this phone only and for two minutes (`copyBriefly`).
            Button("Share") { CodesShare.present(TwoStep.codesNote(codes, email: email)) }
                .foregroundStyle(Alpine.primary).alpineRow()
        }
    }
}

/* The backup codes as a note, through the share sheet (Save to Files, Print, a password manager), never its Copy. */
@MainActor
enum CodesShare {
    /* What the sheet may not do with them. */
    static let excluded: [UIActivity.ActivityType] = [.copyToPasteboard]

    static func present(_ note: String) {
        let sheet = UIActivityViewController(activityItems: [CodesNote(text: note)], applicationActivities: nil)
        sheet.excludedActivityTypes = excluded
        TextPrompt.topController()?.present(sheet, animated: true)
    }
}

/* The note with its subject, as the share sheet takes them. */
private final class CodesNote: NSObject, UIActivityItemSource {
    let text: String
    init(text: String) { self.text = text }
    func activityViewControllerPlaceholderItem(_: UIActivityViewController) -> Any { "" }
    func activityViewController(_: UIActivityViewController, itemForActivityType _: UIActivity.ActivityType?) -> Any? { text }
    func activityViewController(_: UIActivityViewController, subjectForActivityType _: UIActivity.ActivityType?) -> String { "HushOS backup codes" }
}

/*
 * Turning the step on, or replacing the app: the password (and the step, once it is on), the key to
 * add to an authenticator app, a code from the app to confirm, and, the first time, the backup codes.
 */
struct AuthenticatorSheet: View {
    let replacing: Bool
    let email: String
    let done: (String) -> Void
    @Environment(\.dismiss) private var dismiss
    @Environment(\.openURL) private var openURL
    @State private var step = StepUpModel(.twoStep)
    @State private var password = ""
    @State private var tried = false
    @State private var pending = false
    @State private var error = ""
    @State private var app: TotpEnrolment?
    @State private var code = ""
    /* How many other devices are signed in, for the words only: nil until the list answers, or when it doesn't. */
    @State private var others: Int?
    @State private var signOutOthers = true
    @State private var codes: [String]?
    /* The removal of other devices, which runs behind the codes and never holds them or this sheet. */
    @State private var removing = Removing.no
    private enum Removing { case no, running, failed }
    @State private var capture = ScreenCapture.shared

    private var codeReady: Bool {
        let digits = code.filter { !$0.isWhitespace }
        return digits.count == 6 && digits.allSatisfy(StepDraft.digit)
    }

    var body: some View {
        NavigationStack {
            Form {
                if let codes {
                    SheetIntro(text: "Two-step sign-in is on.")
                    BackupCodesList(codes: codes, email: email)
                    if removing == .running {
                        Section {} footer: { Text("Removing your other devices") }
                    } else if removing == .failed {
                        Section {} footer: { Text(StepWords.othersNotRemoved).foregroundStyle(Alpine.danger) }
                    }
                    primaryRow("Done", disabled: false) {
                        done("Two-step sign-in is on.")
                        dismiss()
                    }
                } else if let app {
                    SheetIntro(text: "Add HushOS to your authenticator app, then enter the code it shows.")
                    Section {
                        if let link = app.link {
                            Button("Open in authenticator app") {
                                openURL(link) { opened in
                                    if !opened { error = "No authenticator app on this iPhone opened it. Type the key into your app instead." }
                                }
                            }
                            .foregroundStyle(Alpine.primary).alpineRow()
                        }
                        HStack {
                            VStack(alignment: .leading, spacing: 2) {
                                Text("Or type this key into the app").font(Theme.Text.footnote).foregroundStyle(Alpine.inkMuted)
                                if capture.active {
                                    Text("Hidden while your screen is recorded or shared.").font(Theme.Text.footnote).foregroundStyle(Alpine.inkMuted)
                                } else {
                                    // Not selectable: the system's own Copy would put the key on a clipboard nothing clears. Copy key does.
                                    Text(app.grouped).font(.callout.monospaced()).foregroundStyle(Alpine.ink)
                                }
                            }
                            Spacer()
                            Button("Copy key") {
                                copyBriefly(app.secret)
                                NoticeCenter.shared.show("Key copied. Cleared from the clipboard in two minutes.")
                            }
                            .font(Theme.Text.callout.weight(.semibold)).foregroundStyle(Alpine.primary).buttonStyle(.borderless)
                        }
                        .alpineRow()
                    }
                    Section {
                        TextField("000000", text: Binding(get: { code }, set: { code = String($0.filter { StepDraft.digit($0) || $0 == " " }.prefix(7)); error = "" }))
                            .keyboardType(.numberPad).textContentType(.oneTimeCode).font(.body.monospaced()).kerning(3)
                            .disabled(pending).alpineRow()
                    } header: {
                        FieldLabel("Code from your authenticator app")
                    } footer: {
                        if tried && !codeReady { Text("Enter the 6-digit code the app shows.").foregroundStyle(Alpine.danger) }
                    }
                    // Offered whenever the step is being turned on, whatever the device list said or didn't.
                    if !replacing {
                        Section {
                            Toggle("Remove my other devices", isOn: $signOutOthers).tint(Alpine.primary).disabled(pending).alpineRow()
                        } footer: {
                            Text(TotpEnrolment.othersLine(others))
                        }
                    }
                    FormProblem(text: error)
                    primaryRow(pending ? "Checking" : replacing ? "Replace app" : "Turn on", disabled: pending) { confirm() }
                } else {
                    SheetIntro(text: replacing
                        ? "The new app takes over once you confirm it. Your backup codes stay as they are."
                        : "After your password, HushOS will ask for a code from an authenticator app on your phone. Your recovery phrase works as the second step too, so keep it apart from your password.")
                    ConfirmPassword(password: $password, tried: tried)
                    StepUpSections(step: step, disabled: pending)
                    FormProblem(text: error)
                    primaryRow(pending ? "Checking" : "Continue", disabled: pending) { start() }
                }
            }
            .alpineGrouped()
            .scrollDismissesKeyboard(.interactively)
            .navigationTitle(title)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { if codes == nil { ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() }.disabled(pending) } } }
            .interactiveDismissDisabled(codes != nil || pending)
            // Replacing needs the step from the start: its fields are there when the sheet opens.
            .task { if replacing { await step.prepare() } }
            .task { if !replacing { others = (try? await Devices.list())?.filter { !$0.current }.count } }
        }
    }

    private var title: String {
        if codes != nil { return "Save your backup codes" }
        if app != nil { return replacing ? "Add your new authenticator app" : "Add your authenticator app" }
        return replacing ? "Replace your authenticator app?" : "Turn on two-step sign-in?"
    }

    private func start() {
        tried = true
        guard !password.isEmpty else { return }
        let twoStep: StepAnswer?
        do { twoStep = try step.prove() } catch { if !(error is StepUp.Unready) { self.error = ErrorWords.say(error) ?? "" }; return }
        pending = true
        error = ""
        Task {
            do {
                app = try await TwoStep.startAuthenticator(password: password, twoStep: twoStep)
                tried = false
            } catch {
                if let words = await step.failed(error) { self.error = words }
            }
            pending = false
        }
    }

    private func confirm() {
        guard let app else { return }
        tried = true
        guard codeReady else { return }
        pending = true
        error = ""
        Task {
            do {
                guard case .turnedOn(let made) = try await TwoStep.confirmAuthenticator(id: app.id, code: code) else {
                    // Turning the step on always comes back with the codes. An answer without them is not the
                    // server's answer to that: nothing is claimed, and the settings behind are read again.
                    if !replacing { throw StepError.lost(StepWords.lostTurnedOn) }
                    done("Authenticator app replaced.")
                    dismiss()
                    return
                }
                // The codes first: they are shown once, and nothing that follows may cost them.
                codes = made
                done("")
                // Then the other devices, which signed in before the step was on: removed whenever the box is ticked,
                // whatever the list said (the server removes none when there are none). It runs behind the codes and
                // never holds them or this sheet: Done closes it meanwhile, and a failure is then a notice.
                // Only when turning the step on: replacing an app never removes a device, whatever the box last said.
                if signOutOthers && !replacing {
                    removing = .running
                    let typed = password
                    Task {
                        do {
                            try await Devices.removeOthers(password: typed)
                            removing = .no
                            done("")
                        } catch {
                            removing = .failed
                            NoticeCenter.shared.show(StepWords.othersNotRemoved, important: true)
                        }
                    }
                }
                password = ""
            } catch let timedOut as TwoStep.SetupTimedOut {
                // The setup ran out (ten minutes): back to the start, with why.
                self.app = nil
                code = ""
                tried = false
                error = timedOut.message
            } catch StepError.lost(let said) {
                // Nothing says whether the app was added: said so, and the settings behind are read again to show which.
                self.error = said
                done("")
            } catch {
                if let words = ErrorWords.say(error) { self.error = words }
                // Any failure may hide a change that went through (a dropped connection, a gateway's 502): read them again too.
                done("")
            }
            pending = false
        }
    }
}

/* Turning the step off is removing its last method: the password and the step itself. */
struct TurnOffSheet: View {
    let methodId: String?
    let done: (String) -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var step = StepUpModel(.twoStep)
    @State private var password = ""
    @State private var tried = false
    @State private var pending = false
    @State private var error = ""

    var body: some View {
        NavigationStack {
            Form {
                SheetIntro(text: "Your password alone will sign you in, and your backup codes will stop working.")
                ConfirmPassword(password: $password, tried: tried)
                StepUpSections(step: step, disabled: pending)
                FormProblem(text: error)
                Section {
                    Button { submit() } label: {
                        Text(pending ? "Turning off" : "Turn off").font(.body.weight(.semibold))
                            .foregroundStyle(pending ? Alpine.inkMuted : Color.white).frame(maxWidth: .infinity, minHeight: Theme.control)
                            .background(pending ? Alpine.ink.opacity(0.08) : Alpine.danger, in: Capsule())
                    }
                    .buttonStyle(.plain).disabled(pending)
                    .listRowBackground(Color.clear).listRowInsets(EdgeInsets())
                }
            }
            .alpineGrouped()
            .scrollDismissesKeyboard(.interactively)
            .navigationTitle("Turn off two-step sign-in?")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() }.disabled(pending) } }
            .interactiveDismissDisabled(pending)
            .task { await step.prepare() }
        }
    }

    private func submit() {
        tried = true
        guard !password.isEmpty, let methodId else { return }
        let twoStep: StepAnswer?
        do { twoStep = try step.prove() } catch { if !(error is StepUp.Unready) { self.error = ErrorWords.say(error) ?? "" }; return }
        pending = true
        error = ""
        Task {
            do {
                let on = try await TwoStep.removeMethod(methodId, password: password, twoStep: twoStep)
                done(on ? "Authenticator app removed." : "Two-step sign-in is off.")
                dismiss()
            } catch {
                // Any failure may hide a removal that went through (a lost reply, a dropped connection, a gateway's 502): the
                // settings behind are read again, so they never keep saying On on a guess.
                done("")
                if let words = await step.failed(error) { self.error = words }
            }
            pending = false
        }
    }
}

/* A new set of ten, which replaces the old one: the password and the step, then the codes once. */
struct NewCodesSheet: View {
    let email: String
    let done: (String) -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var step = StepUpModel(.twoStep)
    @State private var password = ""
    @State private var tried = false
    @State private var pending = false
    @State private var error = ""
    @State private var codes: [String]?

    var body: some View {
        NavigationStack {
            Form {
                if let codes {
                    SheetIntro(text: "Your earlier codes no longer work.")
                    BackupCodesList(codes: codes, email: email)
                    primaryRow("Done", disabled: false) {
                        done("New backup codes made.")
                        dismiss()
                    }
                } else {
                    SheetIntro(text: "You get ten new codes, and the ones you have now stop working.")
                    ConfirmPassword(password: $password, tried: tried)
                    StepUpSections(step: step, disabled: pending)
                    FormProblem(text: error)
                    primaryRow(pending ? "Making" : "Make new codes", disabled: pending) { submit() }
                }
            }
            .alpineGrouped()
            .scrollDismissesKeyboard(.interactively)
            .navigationTitle(codes == nil ? "Make new backup codes?" : "Save your new backup codes")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { if codes == nil { ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() }.disabled(pending) } } }
            .interactiveDismissDisabled(codes != nil || pending)
            .task { await step.prepare() }
        }
    }

    private func submit() {
        tried = true
        guard !password.isEmpty else { return }
        let twoStep: StepAnswer?
        do { twoStep = try step.prove() } catch { if !(error is StepUp.Unready) { self.error = ErrorWords.say(error) ?? "" }; return }
        pending = true
        error = ""
        Task {
            do {
                codes = try await TwoStep.newBackupCodes(password: password, twoStep: twoStep)
                password = ""
                done("")
            } catch {
                // New codes may have been made whatever the failure: how many are left is read again.
                done("")
                if let words = await step.failed(error) { self.error = words }
            }
            pending = false
        }
    }
}
