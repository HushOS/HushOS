import HushOSKit
import SwiftUI
import UIKit

/*
 * Two-step sign-in (docs/two-step-design.md 3 to 7 and 12), as the web has it: the step a sign-in
 * stops at, the step a security change asks for, and Account › Two-step sign-in, where a passkey or
 * security key or an authenticator app is added, renamed, removed or made the default, the backup
 * codes are shown once and made again, and the account's recent security activity is listed. Codes
 * are checked on the server; the recovery phrase is signed on this iPhone and never leaves it; a
 * passkey or security key is asked by the system's sheet (PasskeySheet), only when a button is
 * pressed. The words are the web's and the server's own.
 */

/* MARK: The answer's field */

private extension StepMethod {
    var label: String {
        switch self {
        case .totp: "Code from your authenticator app"
        case .backup: "Backup code"
        case .phrase: "Recovery phrase"
        case .webauthn: "Passkey or security key"
        case .device: "Another device"
        }
    }

    var other: String {
        switch self {
        case .totp: "Use your authenticator app"
        case .backup: "Use a backup code"
        case .phrase: "Use your recovery phrase"
        case .webauthn: "Use your passkey or security key"
        case .device: "Use another device"
        }
    }

    var hint: String {
        switch self {
        case .totp: "The 6-digit code. It changes every 30 seconds."
        case .backup: "One of the ten codes you saved. Each works once."
        case .phrase: "All 24 words, in order. They stay on this device."
        case .webauthn: "Your phone asks for it when you continue."
        // Nothing is typed: the request's own panel says what to do (DeviceAskView).
        case .device: ""
        }
    }
}

/* The other ways to answer a step, behind one control: the system's menu, in the server's order. */
private struct OtherWays: View {
    let others: [StepMethod]
    let choose: (StepMethod) -> Void

    var body: some View {
        if !others.isEmpty {
            Menu("Use another way") {
                ForEach(others, id: \.self) { other in
                    Button(other.other) { choose(other) }
                }
            }
            .foregroundStyle(Alpine.primary)
        }
    }
}

/* The one field a step's answer is typed in: a code (filled from a password manager or a message), a backup code, or the phrase. A passkey or security key has none. */
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
            case .webauthn, .device:
                // Nothing to type: the step's own button asks the key, or the other device.
                EmptyView()
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
                    if method == .webauthn {
                        // No field: the form's own button asks the key when it is pressed.
                        StepNote(method: method, draft: step.step.draft, problem: step.step.problem).alpineRow()
                    } else if method == .device {
                        // No field either: the other device is asked on a press, and the form's own button sends the change once it approved.
                        if step.asking.idle && !step.step.deviceApproved {
                            Button(method.other) { step.askDevice() }.foregroundStyle(Alpine.primary).disabled(disabled).alpineRow()
                        } else {
                            DeviceAskView(model: step.asking, inlineAgain: true) { step.askDevice() }.disabled(disabled).alpineRow()
                        }
                    } else {
                        StepField(method: method, draft: Binding(get: { step.step.draft }, set: { step.step.draft = $0; step.step.typed() }))
                            .disabled(disabled).alpineRow()
                    }
                    OtherWays(others: step.step.others) { step.choose($0) }
                        .disabled(disabled).alpineRow()
                } header: {
                    VStack(alignment: .leading, spacing: Alpine.Space.s2) {
                        Text("Two-step sign-in is on, so this needs your second step too.")
                            .font(Theme.Text.footnote).foregroundStyle(Alpine.inkMuted).textCase(nil)
                        // The usual way is not on offer, or a newer HushOS has more: one line, never why.
                        if !step.step.note.isEmpty {
                            Text(step.step.note).font(Theme.Text.footnote).foregroundStyle(Alpine.inkMuted).textCase(nil)
                        }
                        FieldLabel(method.label)
                    }
                    .padding(.top, Alpine.Space.s2)
                } footer: {
                    if method == .device {
                        // Only what the server said of the request, or why it could not be made.
                        if !step.step.problem.isEmpty { Text(step.step.problem).foregroundStyle(Alpine.danger) }
                    } else if method != .webauthn {
                        StepNote(method: method, draft: step.step.draft, problem: step.step.problem)
                    }
                }
            } else {
                Section { Text(step.step.nothingLeft).foregroundStyle(Alpine.danger).alpineRow() }
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
    /* The request to another device, when that is how this step is answered (DeviceApproval.swift). */
    let asking = DeviceAskModel()

    init(_ purpose: StepPurpose) { step = StepUp(purpose: purpose) }

    /* The form opened: an account with the step sees its fields from the start. Quiet when that can't be told; the change's own refusal asks then. */
    func prepare() async {
        guard !step.asked, let status = try? await TwoStep.status(), status.on else { return }
        if let challenge = try? await TwoStep.challenge(step.purpose) { take(challenge) }
    }

    /* A step to answer: a request made for the one before it is let go, and another device is offered only with a key to ask it with. */
    private func take(_ challenge: StepChallenge?, keep: Bool = false) {
        asking.stop()
        step.take(challenge, keep: keep, passkeys: Passkeys.usableNow, device: DeviceApprovals.ownKey != nil)
    }

    /* Use another way. Choosing another device is the press that asks it; choosing anything else lets a request go. */
    func choose(_ method: StepMethod) {
        step.choose(method)
        if method == .device { askDevice() } else { asking.stop() }
    }

    /*
     * Asks another device to approve this step, with this iPhone's own device key. Only from a
     * press: opening a form never sends a prompt. Once it approved, the form's own button sends
     * the change with that request.
     */
    func askDevice() {
        guard let challenge = step.challenge, step.shown == .device, let wire = ApprovalWire.current, let key = DeviceApprovals.ownKey else { return }
        let token = challenge.token
        step.typed()
        asking.begin(
            .init(wire: wire, token: token, purpose: step.purpose.rawValue, key: key),
            approved: { [weak self] answer in
                if case .device(let requestId) = answer.proof { self?.step.approved(ApprovedRequest(token: token, requestId: requestId)) }
            },
            failed: { [weak self] error in
                Task { @MainActor in
                    // Could not be asked: the server's words beside the step, with the other ways still there.
                    guard let self, let words = await self.failed(error) else { return }
                    self.step.say(words)
                }
            }
        )
    }

    /*
     * What the change is about to carry, decided on the press; a passkey or security key is not
     * asked yet. With another device as the way, there is nothing to carry until it approved: the
     * press asks it, if nothing has yet, and the change waits.
     */
    func prove() throws -> StepSending? {
        if step.asked, step.shown == .device, !step.deviceApproved {
            if asking.idle { askDevice() }
            throw StepUp.Unready()
        }
        return try step.prove()
    }

    /*
     * The step's answer, as the change goes out. A passkey or security key is asked here, by the
     * system's sheet, and so only ever on the form's own button. Closed, it throws `KeyUnused`:
     * nothing was sent, and `failed` puts the words beside the step.
     */
    func answer(_ sending: StepSending?) async throws -> StepAnswer? {
        try await sending?.answer(key: PasskeySheet.assert)
    }

    /* After a failed change: nil when the step's own fields say what happened, else the words for the form. */
    func failed(_ error: Error) async -> String? {
        switch step.failed(error) {
        case .notStep:
            return ErrorWords.say(error)
        case .again:
            // The request the change carried is no longer its answer. `step-pending`: the approval had not landed, and
            // the wait goes on. Anything else ended the request: it can be asked again.
            if asking.phase == .approved, !step.deviceApproved {
                if case StepError.refused(.pending, _) = error { asking.resume() } else { asking.stop() }
            }
            return nil
        case .renew:
            do {
                take(try await TwoStep.challenge(step.purpose), keep: true)
                return nil
            } catch {
                return ErrorWords.say(error)
            }
        }
    }
}

/* MARK: Signing in */

/*
 * The second step of a sign-in: the password was right, and the account asks for its passkey or
 * security key, a code, a backup code or the recovery phrase before anything is handed over. It
 * opens on the way the server put first (the account's default); the others are behind Use another
 * way. A wrong answer stays here; a step that is over goes back to the password with why; a reply
 * that never arrived offers the same answer again. Nothing leaves the person on a screen that can
 * no longer be answered. What is offered and what each failure means is HushOSKit's `SignInStep`.
 */
struct SignInStepView: View {
    @Environment(AppModel.self) private var model
    let pending: PendingSignIn
    @State private var step: SignInStep
    @State private var busy = false
    /* The request to another device, while that is the way on screen. */
    @State private var asking = DeviceAskModel()

    init(pending: PendingSignIn) {
        self.pending = pending
        _step = State(initialValue: SignInStep(challenge: pending.challenge, passkeys: Passkeys.usable(for: pending.origin), device: pending.deviceKey != nil))
    }

    var body: some View {
        VStack(spacing: 0) {
            ScrollView {
                VStack(alignment: .leading, spacing: Alpine.Space.s6) {
                    VStack(alignment: .leading, spacing: Alpine.Space.s2) {
                        Text("This account has two-step sign-in on.").font(.body).foregroundStyle(Alpine.inkMuted)
                        // The usual way is not on offer, or a newer HushOS has more: one line, never why.
                        if !step.note.isEmpty {
                            Text(step.note).font(Theme.Text.callout).foregroundStyle(Alpine.inkMuted)
                        }
                    }
                    .padding(.horizontal, Alpine.Space.s1)
                    if !step.notice.isEmpty {
                        HStack(alignment: .firstTextBaseline, spacing: 10) {
                            Image(systemName: "exclamationmark.circle").font(Theme.Text.callout.weight(.semibold))
                            Text(step.notice).font(Theme.Text.callout).frame(maxWidth: .infinity, alignment: .leading)
                        }
                        .foregroundStyle(Alpine.warning)
                        .padding(.horizontal, Alpine.Space.s4).padding(.vertical, Alpine.Space.s3)
                        .background(Alpine.warningSoft, in: RoundedRectangle(cornerRadius: 20, style: .continuous))
                        .highContrastEdge(RoundedRectangle(cornerRadius: 20, style: .continuous))
                        .accessibilityElement(children: .combine)
                    }
                    if let method = step.shown {
                        VStack(alignment: .leading, spacing: Alpine.Space.s2) {
                            FieldLabel(method.label).padding(.horizontal, Alpine.Space.s4)
                            if method == .device {
                                // Nothing is typed here: the other device's QR code, then the code to type there.
                                DeviceAskView(model: asking, inlineAgain: false) { askDevice() }
                                    .padding(.horizontal, Alpine.Space.s4).padding(.vertical, Alpine.Space.s2)
                                if !step.fieldError.isEmpty {
                                    Text(step.fieldError).font(Theme.Text.footnote).foregroundStyle(Alpine.danger).padding(.horizontal, Alpine.Space.s4)
                                }
                            } else {
                                // A passkey or security key has no field: the button below asks it.
                                if method != .webauthn {
                                    StepField(method: method, draft: $step.draft, submit: submit, focus: true)
                                        .disabled(busy)
                                        .padding(.horizontal, Alpine.Space.s4).padding(.vertical, Alpine.Space.s3)
                                        .frame(minHeight: 52)
                                        .background(Alpine.surface, in: RoundedRectangle(cornerRadius: 26, style: .continuous))
                                        .alpineCardEdge(RoundedRectangle(cornerRadius: 26, style: .continuous))
                                }
                                StepNote(method: method, draft: step.draft, problem: step.fieldError).padding(.horizontal, Alpine.Space.s4)
                            }
                        }
                        OtherWays(others: step.others) { choose($0) }
                            .font(Theme.Text.callout.weight(.semibold))
                            .frame(minHeight: Theme.control).disabled(busy)
                            .padding(.horizontal, Alpine.Space.s4)
                    } else {
                        // Nothing this build knows was offered: update. The ways ran out after refusals: updating would not help.
                        Text(step.nothingLeft)
                            .font(Theme.Text.callout).foregroundStyle(Alpine.danger).padding(.horizontal, Alpine.Space.s4)
                    }
                }
                .padding(.horizontal, Alpine.Space.s4).padding(.top, Alpine.Space.s2)
            }
            .scrollDismissesKeyboard(.interactively)

            VStack(spacing: Alpine.Space.s2) {
                if step.shown != nil {
                    Button(action: submit) {
                        Text(action).font(.body.weight(.semibold)).frame(maxWidth: .infinity, minHeight: 52)
                    }
                    .buttonStyle(PrimaryCapsuleStyle())
                    .disabled(busy || (step.shown == .device && step.lost == nil && asking.out))
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
        // Left (answered, started again, timed out): nothing goes on asking behind a screen that is gone.
        .onDisappear { asking.stop() }
    }

    /* The one button: it sends what was typed, or asks the key or the other device. */
    private var action: String {
        if busy { return "Checking" }
        if step.lost != nil { return "Try again" }
        switch step.shown {
        case .webauthn: return "Use your passkey"
        case .device:
            if case .ended = asking.phase { return StepWords.askAgain }
            return asking.idle ? StepMethod.device.other : StepWords.askWaiting
        default: return "Continue"
        }
    }

    /* Use another way. Choosing another device is the press that asks it; choosing anything else lets a request go. */
    private func choose(_ method: StepMethod) {
        step.choose(method)
        if method == .device { askDevice() } else { asking.stop() }
    }

    /*
     * Asks another device, with the key this sign-in holds for it (the phone's own, or the one made
     * for this sign-in). Only from a press. Once approved the step is answered with the request,
     * and the app is signed in; a request that ended stays on screen with Ask again.
     */
    private func askDevice() {
        guard !busy, step.shown == .device, let key = pending.deviceKey else { return }
        step.asking()
        asking.begin(
            .init(wire: .signIn(origin: pending.origin), token: pending.challenge.token, purpose: "login", key: key.publicKey),
            approved: { answer in
                busy = true
                defer { busy = false }
                try await model.answerStep(.ready(answer))
            },
            failed: { error in
                // Could not be asked (the server's words, and the other ways), or the answer's reply was lost (the same one goes again).
                if let over = step.failed(error, tried: .device, answer: asking.answer) {
                    model.cancelStep(over, token: pending.challenge.token)
                }
            }
        )
    }

    private func submit() {
        // Another device is asked, or asked again, from here; a lost reply to its answer goes the usual road below.
        if step.shown == .device, step.lost == nil {
            askDevice()
            return
        }
        // The press decides what goes. For a passkey or security key the system's sheet opens from here, and only from here.
        guard !busy, let sending = step.press() else { return }
        busy = true
        Task {
            var sent: StepAnswer?
            do {
                try await model.answerStep(sending) { sent = $0 }
            } catch {
                // A sheet that was closed sent nothing and keeps the step; a lost reply keeps the answer to send again.
                if let over = step.failed(error, tried: sending.method, answer: sent) {
                    model.cancelStep(over, token: pending.challenge.token)
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
    /* Whether this iPhone can use a passkey or security key for the server it is signed in to: read with the settings. */
    @State private var passkeys = false
    /* The default is being moved: one change at a time. */
    @State private var moving = false
    /* Whether this iPhone holds the account's device key: it asks another device with it. */
    @State private var ownKey = false

    enum Open: Identifiable {
        case app(AuthenticatorSheet.Mode)
        case key(first: Bool)
        case device(first: Bool)
        case rename(TwoStepStatus.Method)
        case remove(TwoStepStatus.Method, last: Bool)
        case codes

        var id: String {
            switch self {
            case .app(let mode): "app-\(mode.rawValue)"
            case .key: "key"
            case .device: "device"
            case .rename(let method): "rename-\(method.id)"
            case .remove(let method, _): "remove-\(method.id)"
            case .codes: "codes"
            }
        }
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
                // The state, once: one row, its value at the trailing edge as the system's settings show theirs.
                Section {
                    LabeledContent("Status") { Text(status.on ? "On" : "Off").foregroundStyle(Alpine.inkMuted) }
                        .foregroundStyle(Alpine.ink).alpineRow()
                }
                keys(status)
                app(status)
                device(status)
                if status.on {
                    Section {
                        Text(status.codesLeft).fontWeight(status.codesLow ? .semibold : .regular)
                            .foregroundStyle(status.codesLow ? Alpine.warning : Alpine.inkMuted).alpineRow()
                        Button("New codes") { open = .codes }.foregroundStyle(Alpine.primary).alpineRow()
                    } header: {
                        SectionTitle("Backup codes")
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
            case .app(let mode):
                AuthenticatorSheet(mode: mode, email: model.user?.email ?? "") { said in finish(said) }
            case .key(let first):
                KeySheet(first: first, email: model.user?.email ?? "") { said in finish(said) }
            case .device(let first):
                DeviceMethodSheet(first: first, email: model.user?.email ?? "") { said in finish(said) }
            case .rename(let method):
                RenameKeySheet(method: method) { said in finish(said) }
            case .remove(let method, let last):
                RemoveMethodSheet(method: method, last: last) { said in finish(said) }
            case .codes:
                NewCodesSheet(email: model.user?.email ?? "") { said in finish(said) }
            }
        }
    }

    /* A kind's name over its rows, with Default beside it while it is the one asked for first. */
    private func kindTitle(_ kind: StepKind, _ status: TwoStepStatus) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: Alpine.Space.s2) {
            SectionTitle(kind.words)
            if status.isDefault(kind) {
                Text("Default").font(Theme.Text.footnote.weight(.semibold)).foregroundStyle(Alpine.onTint).textCase(nil)
                    .padding(.horizontal, 6).padding(.vertical, 2)
                    .background(Alpine.tint, in: RoundedRectangle(cornerRadius: Alpine.Radius.chip, style: .continuous))
            }
        }
        .accessibilityElement(children: .combine)
    }

    /* Offered on the kind that is not asked for first, and only while the account has both. */
    @ViewBuilder private func makeDefault(_ kind: StepKind, _ status: TwoStepStatus) -> some View {
        if status.canMakeDefault(kind) {
            Button("Make default") { move(to: kind) }
                .foregroundStyle(Alpine.primary).disabled(moving).alpineRow()
                .accessibilityLabel("Make \(kind.words.lowercased()) the default")
        }
    }

    @ViewBuilder private func keys(_ status: TwoStepStatus) -> some View {
        Section {
            if status.keys.isEmpty {
                Text("Not added").foregroundStyle(Alpine.inkMuted).alpineRow()
            }
            ForEach(status.keys) { key in
                HStack(spacing: Alpine.Space.s3) {
                    VStack(alignment: .leading, spacing: 2) {
                        Text(key.shownName).foregroundStyle(Alpine.ink)
                        Text(key.line(day: Self.day)).font(Theme.Text.footnote).foregroundStyle(Alpine.inkMuted)
                    }
                    Spacer(minLength: 0)
                    Menu {
                        Button("Rename") { open = .rename(key) }
                        // The last method is not removed: turning it off is turning the step off.
                        Button(status.removeWords, role: .destructive) { open = .remove(key, last: status.removesLast) }
                    } label: {
                        Image(systemName: "ellipsis").foregroundStyle(Alpine.inkMuted).frame(width: 44, height: 44)
                    }
                    .accessibilityLabel("Actions for \(key.shownName)")
                }
                .alpineRow()
            }
            // Only where this iPhone can make a key for this server; on any other, keys are added in a browser.
            if status.canAddKey(passkeys: passkeys) {
                // "Add another" once there is a key: the row adds to the list, and is not an action on the key above it.
                Button(status.addKeyWords) { open = .key(first: !status.on) }
                    .foregroundStyle(Alpine.primary).alpineRow().accessibilityLabel(status.keys.isEmpty ? "Add passkey or security key" : "Add another passkey or security key")
            }
            makeDefault(.webauthn, status)
        } header: {
            kindTitle(.webauthn, status)
        } footer: {
            VStack(alignment: .leading, spacing: Alpine.Space.s2) {
                ForEach(status.keyNotes(passkeys: passkeys), id: \.self) { Text($0) }
            }
        }
    }

    @ViewBuilder private func app(_ status: TwoStepStatus) -> some View {
        Section {
            if let app = status.app {
                VStack(alignment: .leading, spacing: 2) {
                    if status.totpFrozen { Text("Paused").fontWeight(.semibold).foregroundStyle(Alpine.warning) }
                    Text(app.latest(day: Self.day)).font(status.totpFrozen ? Theme.Text.footnote : .body).foregroundStyle(Alpine.inkMuted)
                }
                .alpineRow()
                Button("Replace") { open = .app(.replace) }.foregroundStyle(Alpine.primary).alpineRow()
                Button(status.removeWords, role: .destructive) { open = .remove(app, last: status.removesLast) }
                    .foregroundStyle(Alpine.danger).alpineRow().accessibilityLabel("\(status.removeWords) authenticator app")
            } else {
                Text("Not added").foregroundStyle(Alpine.inkMuted).alpineRow()
                // Beside a key the step is already on: the app is added, and nothing is turned on.
                Button("Add") { open = .app(status.on ? .add : .on) }
                    .foregroundStyle(Alpine.primary).alpineRow().accessibilityLabel("Add authenticator app")
            }
            makeDefault(.totp, status)
        } header: {
            kindTitle(.totp, status)
        } footer: {
            if status.totpFrozen {
                Text("A backup code or your recovery phrase lifts the pause.")
            }
        }
    }

    /*
     * Approve on another device: what it is now (On, Off, or that it needs a device this account
     * has none of signed in), then Turn on or Turn off, and Make default. Only on a server that
     * knows the method. Turning it off is removing it, as for any other method.
     */
    @ViewBuilder private func device(_ status: TwoStepStatus) -> some View {
        if status.showsDevice {
            Section {
                Text(status.deviceValue).foregroundStyle(Alpine.inkMuted).alpineRow()
                if let device = status.device {
                    Button("Turn off", role: .destructive) { open = .remove(device, last: status.removesLast) }
                        .foregroundStyle(Alpine.danger).alpineRow().accessibilityLabel("Turn off \(StepKind.device.words)")
                } else if status.canTurnOnDevice(ownKey: ownKey) {
                    Button("Turn on") { open = .device(first: !status.on) }
                        .foregroundStyle(Alpine.primary).alpineRow().accessibilityLabel("Turn on \(StepKind.device.words)")
                }
                makeDefault(.device, status)
            } header: {
                kindTitle(.device, status)
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

    /* "13 Nov", and the minute as the emails carry it: "13 Nov, 14:08". */
    private static func day(_ date: Date) -> String { date.formatted(Date.FormatStyle().day().month(.abbreviated).locale(.dayMonth)) }
    private static func when(_ date: Date) -> String { "\(day(date)), \(date.formatted(date: .omitted, time: .shortened))" }

    private func finish(_ said: String) {
        if !said.isEmpty { store.notify(said) }
        Task { await load() }
    }

    /* Which kind is asked for first: it changes only an order, so no password and no step. */
    private func move(to kind: StepKind) {
        guard !moving else { return }
        moving = true
        Task {
            do {
                try await TwoStep.makeDefault(kind)
                finish(kind.nowFirst)
            } catch {
                if endsSession(error) { store.report(error) } else if let words = ErrorWords.say(error) { store.notify(words, important: true) }
                // The refusal, or a lost reply, may sit beside a default that moved: the settings are read again.
                await load()
            }
            moving = false
        }
    }

    private func load() async {
        do {
            let next = try await TwoStep.status()
            passkeys = Passkeys.usableNow
            ownKey = DeviceApprovals.ownKey != nil
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
            if tried && password.isEmpty { Text("Enter your password.").foregroundStyle(Alpine.danger) }
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
        // A sheet whose title says it all has no opening words, and no empty section in their place.
        if !text.isEmpty { Section {} header: { Text(text).font(Theme.Text.callout).foregroundStyle(Alpine.ink).textCase(nil) } }
    }
}

private extension View {
    /*
     * A sheet's title in its bar. These are questions and instructions ("Remove this passkey or
     * security key?"), longer than a bar's title usually is: it shrinks to fit before it is cut off.
     */
    func stepSheetTitle(_ title: String) -> some View {
        navigationTitle(title)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .principal) {
                    Text(title).font(.headline).foregroundStyle(Alpine.ink).lineLimit(1).minimumScaleFactor(0.7)
                        .accessibilityAddTraits(.isHeader)
                }
            }
    }
}

/* The offer to remove the other devices when the step is turned on, as the authenticator app's and a key's setup both make it. */
private struct RemoveOthersOffer: View {
    @Binding var ticked: Bool
    /* How many other devices are signed in, for the words only: nil until the list answers, or when it doesn't. */
    let others: Int?
    let disabled: Bool

    var body: some View {
        Section {
            Toggle("Remove my other devices", isOn: $ticked).tint(Alpine.primary).disabled(disabled).alpineRow()
        } footer: {
            Text(TotpEnrolment.othersLine(others))
        }
    }
}

/* The removal of other devices, which runs behind the backup codes and never holds them or their sheet. */
private enum RemovingOthers { case no, running, failed }

/* The backup codes a first method came with: shown once, with how the removal of the other devices behind them is going. */
private struct TurnedOnCodes: View {
    let codes: [String]
    let email: String
    let removing: RemovingOthers
    let done: () -> Void

    var body: some View {
        SheetIntro(text: "Two-step sign-in is on.")
        BackupCodesList(codes: codes, email: email)
        if removing == .running {
            Section {} footer: { Text("Removing your other devices") }
        } else if removing == .failed {
            Section {} footer: { Text(StepWords.othersNotRemoved).foregroundStyle(Alpine.danger) }
        }
        primaryRow("Done", disabled: false, action: done)
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
            Text("Each code works once. They aren’t shown again.")
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
 * Adding an authenticator app: the password (and the step, once it is on), the key to add to the
 * app, a code from the app to confirm, and, when it is the account's first method, the backup codes.
 */
struct AuthenticatorSheet: View {
    /* `on`: the account's first method, which turns the step on. `add`: an app beside its keys. `replace`: a new app for the old. */
    enum Mode: String { case on, add, replace }

    let mode: Mode
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
    @State private var removing = RemovingOthers.no
    @State private var capture = ScreenCapture.shared

    private var replacing: Bool { mode == .replace }

    private var codeReady: Bool {
        let digits = code.filter { !$0.isWhitespace }
        return digits.count == 6 && digits.allSatisfy(StepDraft.digit)
    }

    var body: some View {
        NavigationStack {
            Form {
                if let codes {
                    TurnedOnCodes(codes: codes, email: email, removing: removing) {
                        done("")
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
                    // Offered whenever the step is being turned on, whatever the device list said or didn't; never beside a key or for a new app.
                    if mode == .on { RemoveOthersOffer(ticked: $signOutOthers, others: others, disabled: pending) }
                    FormProblem(text: error)
                    primaryRow(pending ? "Checking" : mode == .replace ? "Replace app" : mode == .on ? "Turn on" : "Add app", disabled: pending) { confirm() }
                } else {
                    SheetIntro(text: intro)
                    ConfirmPassword(password: $password, tried: tried)
                    StepUpSections(step: step, disabled: pending)
                    FormProblem(text: error)
                    primaryRow(pending ? "Checking" : "Continue", disabled: pending) { start() }
                }
            }
            .alpineGrouped()
            .scrollDismissesKeyboard(.interactively)
            .stepSheetTitle(title)
            .toolbar { if codes == nil { ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() }.disabled(pending) } } }
            .interactiveDismissDisabled(codes != nil || pending)
            // Once the step is on (a new app, or an app beside a key) it is needed from the start: its fields are there when the sheet opens.
            .task { if mode != .on { await step.prepare() } }
            .task { if mode == .on { others = (try? await Devices.list())?.filter { !$0.current }.count } }
        }
    }

    private var title: String {
        if codes != nil { return "Save your backup codes" }
        if app != nil { return replacing ? "Add your new authenticator app" : "Add your authenticator app" }
        switch mode {
        case .on: return "Turn on two-step sign-in?"
        case .add: return "Add an authenticator app?"
        case .replace: return "Replace your authenticator app?"
        }
    }

    private var intro: String {
        switch mode {
        case .on: "After your password, HushOS will ask for a code from an authenticator app."
        case .add: ""
        case .replace: "The new app takes over once you confirm it."
        }
    }

    private func start() {
        tried = true
        guard !password.isEmpty else { return }
        let sending: StepSending?
        do { sending = try step.prove() } catch { if !(error is StepUp.Unready) { self.error = ErrorWords.say(error) ?? "" }; return }
        pending = true
        error = ""
        Task {
            do {
                // A passkey or security key is asked here, on this press.
                let twoStep = try await step.answer(sending)
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
                    if mode == .on { throw StepError.lost(StepWords.lostTurnedOn) }
                    // The server answers the same for a new app and for one added beside a key.
                    done(replacing ? "Authenticator app replaced." : "Authenticator app added.")
                    dismiss()
                    return
                }
                // The codes first: they are shown once, and nothing that follows may cost them.
                codes = made
                done("")
                // Then the other devices, which signed in before the step was on: removed whenever the box is ticked,
                // whatever the list said (the server removes none when there are none). It runs behind the codes and
                // never holds them or this sheet: Done closes it meanwhile, and a failure is then a notice.
                // Only when turning the step on: a new app, or one beside a key, never removes a device, whatever the box last said.
                if signOutOthers && mode == .on {
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

/*
 * Removing a method: the password and the step itself. The account's only method is not removed but
 * turned off, with the step; any other leaves the rest as they are.
 */
struct RemoveMethodSheet: View {
    let method: TwoStepStatus.Method
    /* The account's only method: removing it turns the step off. */
    let last: Bool
    let done: (String) -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var step = StepUpModel(.twoStep)
    @State private var password = ""
    @State private var tried = false
    @State private var pending = false
    @State private var error = ""

    private var app: Bool { method.kind == "totp" }
    /* Approve on another device: turned off, never "removed", whether or not it is the last method. */
    private var device: Bool { method.kind == "device" }

    private var title: String {
        if last { return "Turn off two-step sign-in?" }
        if device { return "Turn off \(StepKind.device.words)?" }
        return app ? "Remove your authenticator app?" : "Remove this passkey or security key?"
    }

    private var intro: String {
        if last { return "Your password alone will sign you in, and your backup codes will stop working." }
        // The title says it all.
        if device { return "" }
        if app { return "Its codes will stop working for sign-in." }
        return "\(method.name.flatMap { $0.isEmpty ? nil : $0 } ?? "This key") will stop working for sign-in."
    }

    private var action: String {
        if last || device { return pending ? "Turning off" : "Turn off" }
        return pending ? "Removing" : "Remove"
    }

    var body: some View {
        NavigationStack {
            Form {
                SheetIntro(text: intro)
                ConfirmPassword(password: $password, tried: tried)
                StepUpSections(step: step, disabled: pending)
                FormProblem(text: error)
                Section {
                    Button { submit() } label: {
                        Text(action).font(.body.weight(.semibold))
                            .foregroundStyle(pending ? Alpine.inkMuted : Color.white).frame(maxWidth: .infinity, minHeight: Theme.control)
                            .background(pending ? Alpine.ink.opacity(0.08) : Alpine.danger, in: Capsule())
                    }
                    .buttonStyle(.plain).disabled(pending)
                    .listRowBackground(Color.clear).listRowInsets(EdgeInsets())
                }
            }
            .alpineGrouped()
            .scrollDismissesKeyboard(.interactively)
            .stepSheetTitle(title)
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() }.disabled(pending) } }
            .interactiveDismissDisabled(pending)
            .task { await step.prepare() }
        }
    }

    private func submit() {
        tried = true
        guard !password.isEmpty else { return }
        let sending: StepSending?
        do { sending = try step.prove() } catch { if !(error is StepUp.Unready) { self.error = ErrorWords.say(error) ?? "" }; return }
        pending = true
        error = ""
        Task {
            do {
                // A passkey or security key is asked here, on this press; closed, nothing is sent and nothing was removed.
                let twoStep = try await step.answer(sending)
                let on = try await TwoStep.removeMethod(method.id, password: password, twoStep: twoStep)
                // What is said follows the server's answer: the step is off only when it says so.
                done(TwoStep.removedWords(kind: method.kind, on: on))
                dismiss()
            } catch let unused as KeyUnused {
                // Nothing was sent: there is nothing behind to read again.
                _ = await step.failed(unused)
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

/*
 * Adding a passkey or security key: the password (and the step, once it is on), then the key
 * itself, asked by the system's sheet on the press of Add, with a name for it if the person wants
 * one. The account's first method turns the step on, and its backup codes follow.
 */
struct KeySheet: View {
    /* The account has no method yet: this key turns the step on. */
    let first: Bool
    let email: String
    let done: (String) -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var step = StepUpModel(.twoStep)
    @State private var password = ""
    @State private var tried = false
    @State private var pending = false
    @State private var error = ""
    /* What the key is asked, with the registration token its answer goes back with: good for one answer. */
    @State private var started: KeyCreation?
    @State private var name = ""
    @State private var others: Int?
    @State private var signOutOthers = true
    @State private var codes: [String]?
    @State private var removing = RemovingOthers.no

    private var title: String {
        if codes != nil { return "Save your backup codes" }
        if started != nil { return "Add your passkey or security key" }
        return first ? "Turn on two-step sign-in?" : "Add a passkey or security key?"
    }

    var body: some View {
        NavigationStack {
            Form {
                if let codes {
                    TurnedOnCodes(codes: codes, email: email, removing: removing) {
                        done("")
                        dismiss()
                    }
                } else if started != nil {
                    SheetIntro(text: "Your phone will ask for it.")
                    Section {
                        TextField("Security key", text: Binding(get: { name }, set: { name = Self.fitted($0); error = "" }))
                            .autocorrectionDisabled().disabled(pending).alpineRow()
                    } header: {
                        FieldLabel("Name")
                    } footer: {
                        Text("Optional. Names aren’t encrypted.")
                    }
                    // Offered whenever the step is being turned on, whatever the device list said or didn't.
                    if first { RemoveOthersOffer(ticked: $signOutOthers, others: others, disabled: pending) }
                    FormProblem(text: error)
                    // The system's sheet opens on this press, and only on it.
                    primaryRow(pending ? "Waiting for your key" : first ? "Add and turn on" : "Add", disabled: pending) { add() }
                } else {
                    SheetIntro(text: first ? "After your password, HushOS will ask for your passkey or security key." : "")
                    ConfirmPassword(password: $password, tried: tried)
                    StepUpSections(step: step, disabled: pending)
                    FormProblem(text: error)
                    primaryRow(pending ? "Checking" : "Continue", disabled: pending) { start() }
                }
            }
            .alpineGrouped()
            .scrollDismissesKeyboard(.interactively)
            .stepSheetTitle(title)
            .toolbar { if codes == nil { ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() }.disabled(pending) } } }
            .interactiveDismissDisabled(codes != nil || pending)
            // Once the step is on it is needed from the start: its fields are there when the sheet opens.
            .task { if !first { await step.prepare() } }
            .task { if first { others = (try? await Devices.list())?.filter { !$0.current }.count } }
        }
    }

    /* No more than the 40 characters a name may have, counted as the server counts them. */
    private static func fitted(_ typed: String) -> String {
        var name = typed
        while name.unicodeScalars.count > 40 { name.removeLast() }
        return name
    }

    private func start() {
        tried = true
        guard !password.isEmpty else { return }
        let sending: StepSending?
        do { sending = try step.prove() } catch { if !(error is StepUp.Unready) { self.error = ErrorWords.say(error) ?? "" }; return }
        pending = true
        error = ""
        Task {
            do {
                // With a key already on the account, the step may itself be answered by one: asked here, on this press.
                let twoStep = try await step.answer(sending)
                started = try await TwoStep.startKey(password: password, twoStep: twoStep)
                tried = false
            } catch {
                if let words = await step.failed(error) { self.error = words }
            }
            pending = false
        }
    }

    private func add() {
        guard let started else { return }
        if let problem = TwoStep.nameProblem(name, required: false) { error = problem; return }
        pending = true
        error = ""
        Task {
            do {
                let registration = try await PasskeySheet.make(started)
                let added = try await TwoStep.addKey(started, name: name, registration: registration)
                guard !added.backupCodes.isEmpty else {
                    // Turning the step on always comes back with the codes. An answer without them is not the
                    // server's answer to that: nothing is claimed, and the settings behind are read again.
                    if first { throw StepError.lost(StepWords.lostTurnedOn) }
                    done("Passkey or security key added.")
                    dismiss()
                    return
                }
                // The codes first: they are shown once, and nothing that follows may cost them.
                codes = added.backupCodes
                done("")
                // Then the other devices, which signed in before the step was on, as the authenticator app's setup removes them.
                if signOutOthers && first {
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
            } catch let unused as KeyUnused {
                // The sheet was closed, or no key answered: nothing was sent, and the same setup still stands.
                error = unused.message
            } catch {
                // Anything the server answered ends the setup (a registration is good for one answer), and any failure may
                // hide a key that was added: back to the password with why, and the settings behind are read again.
                self.started = nil
                tried = false
                done("")
                if let words = ErrorWords.say(error) { self.error = words }
            }
            pending = false
        }
    }
}

/*
 * Turning on Approve on another device: the password (and the step, once it is on), then one real
 * approval from another of the account's devices, asked for as at a sign-in. The account's first
 * method turns the step on, and its backup codes follow. The other devices are not offered for
 * removal here: the other device is the method.
 */
struct DeviceMethodSheet: View {
    /* The account has no method yet: this turns the step on. */
    let first: Bool
    let email: String
    let done: (String) -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var step = StepUpModel(.twoStep)
    @State private var password = ""
    @State private var tried = false
    @State private var pending = false
    @State private var error = ""
    /* The pending method, and the step token its one approval runs from: good for ten minutes. */
    @State private var started: DeviceEnrolment?
    @State private var asking = DeviceAskModel()
    @State private var codes: [String]?

    var body: some View {
        NavigationStack {
            Form {
                if let codes {
                    TurnedOnCodes(codes: codes, email: email, removing: .no) {
                        done("")
                        dismiss()
                    }
                } else if started != nil {
                    Section { DeviceAskView(model: asking, inlineAgain: true) { ask() }.alpineRow() }
                    FormProblem(text: error)
                } else {
                    ConfirmPassword(password: $password, tried: tried)
                    StepUpSections(step: step, disabled: pending)
                    FormProblem(text: error)
                    primaryRow(pending ? "Checking" : "Continue", disabled: pending) { start() }
                }
            }
            .alpineGrouped()
            .scrollDismissesKeyboard(.interactively)
            .stepSheetTitle(codes == nil ? "Turn on \(StepKind.device.words)?" : "Save your backup codes")
            .toolbar { if codes == nil { ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() }.disabled(pending) } } }
            .interactiveDismissDisabled(codes != nil || pending)
            // Once the step is on it is needed from the start: its fields are there when the sheet opens.
            .task { if !first { await step.prepare() } }
            .onDisappear { asking.stop() }
        }
    }

    private func start() {
        tried = true
        guard !password.isEmpty else { return }
        let sending: StepSending?
        do { sending = try step.prove() } catch { if !(error is StepUp.Unready) { self.error = ErrorWords.say(error) ?? "" }; return }
        pending = true
        error = ""
        Task {
            do {
                // A passkey or security key is asked here, on this press.
                let twoStep = try await step.answer(sending)
                started = try await TwoStep.startDevice(password: password, twoStep: twoStep)
                tried = false
                // Continue was the press: the other device is asked now.
                ask()
            } catch {
                if let words = await step.failed(error) { self.error = words }
            }
            pending = false
        }
    }

    /* Asks another device to approve the pending method, then confirms it with that approval. */
    private func ask() {
        guard let started else { return }
        guard let wire = ApprovalWire.current, let key = DeviceApprovals.ownKey else {
            self.started = nil
            error = ErrorWords.generic
            return
        }
        error = ""
        asking.begin(
            .init(wire: wire, token: started.token, purpose: DeviceEnrolment.purpose, key: key),
            approved: { answer in
                guard case .device(let requestId) = answer.proof else { return }
                switch try await TwoStep.confirmDevice(started, requestId: requestId) {
                case .turnedOn(let made):
                    // The codes first: they are shown once.
                    codes = made
                    password = ""
                    done("")
                case .added:
                    // Turning the step on always comes back with the codes. An answer without them is not the
                    // server's answer to that: nothing is claimed, and the settings behind are read again.
                    if first { throw StepError.lost(StepWords.lostTurnedOn) }
                    done(StepWords.deviceOn)
                    dismiss()
                }
            },
            failed: { error in
                // The server would not ask another device, or the confirmation failed: back to the password with why. Any
                // failure may hide a method that was turned on, so the settings behind are read again.
                self.started = nil
                tried = false
                done("")
                if let words = ErrorWords.say(error) { self.error = words }
            }
        )
    }
}

/* A key's name: shown in the list only, changed by any session, with no password. */
struct RenameKeySheet: View {
    let method: TwoStepStatus.Method
    let done: (String) -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var name: String
    @State private var pending = false
    @State private var error = ""

    init(method: TwoStepStatus.Method, done: @escaping (String) -> Void) {
        self.method = method
        self.done = done
        _name = State(initialValue: method.name ?? "")
    }

    var body: some View {
        NavigationStack {
            Form {
                SheetIntro(text: "Names aren’t encrypted.")
                Section {
                    TextField("Security key", text: Binding(get: { name }, set: { name = $0; error = "" }))
                        .autocorrectionDisabled().disabled(pending).submitLabel(.done).onSubmit { save() }.alpineRow()
                } header: {
                    FieldLabel("Name")
                } footer: {
                    if !error.isEmpty { Text(error).foregroundStyle(Alpine.danger) }
                }
                primaryRow("Save name", disabled: pending) { save() }
            }
            .alpineGrouped()
            .scrollDismissesKeyboard(.interactively)
            .stepSheetTitle("Rename passkey or security key")
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() }.disabled(pending) } }
            .interactiveDismissDisabled(pending)
        }
    }

    private func save() {
        guard !pending else { return }
        if let problem = TwoStep.nameProblem(name, required: true) { error = problem; return }
        pending = true
        error = ""
        Task {
            do {
                try await TwoStep.renameMethod(method.id, name: name)
                done("")
                dismiss()
            } catch {
                // The server's rules for a name are the server's to say.
                if let words = ErrorWords.say(error) { self.error = words }
                // A lost reply may hide a name that was saved: the list behind is read again.
                if case StepError.lost = error { done("") }
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
                        done("")
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
            .stepSheetTitle(codes == nil ? "Make new backup codes?" : "Save your new backup codes")
            .toolbar { if codes == nil { ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() }.disabled(pending) } } }
            .interactiveDismissDisabled(codes != nil || pending)
            .task { await step.prepare() }
        }
    }

    private func submit() {
        tried = true
        guard !password.isEmpty else { return }
        let sending: StepSending?
        do { sending = try step.prove() } catch { if !(error is StepUp.Unready) { self.error = ErrorWords.say(error) ?? "" }; return }
        pending = true
        error = ""
        Task {
            do {
                // A passkey or security key is asked here, on this press.
                let twoStep = try await step.answer(sending)
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
