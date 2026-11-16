import CoreImage.CIFilterBuiltins
import HushOSKit
import SwiftUI
import UIKit
import VisionKit

/*
 * Approve on another device (docs/two-step-design.md 12), on this iPhone's screens: the panel the
 * asking side shows (a QR code, then the code to type on the other device), and the answering
 * side's list, banner and sheet. The order of every request, and every check, is HushOSKit's
 * (`DeviceAsk`, `ApprovalAnswering`, `ApprovalAnswer`); nothing here decides what is revealed,
 * approved or signed, nor what holds the sheet.
 *
 * Turning the method on is answered the other way round: the asking panel shows no code and no
 * QR code, and the answering sheet shows the code this iPhone drew when Approve was pressed.
 */

/* MARK: Asking */

/*
 * One request to another device, as a screen follows it: made on a press, looked at every two
 * seconds while its screen is up, and answered with once approved. Let go when the screen goes.
 */
@Observable
@MainActor
final class DeviceAskModel {
    enum Phase: Equatable {
        /* Nothing is out: the screen offers to ask. */
        case idle
        case starting
        /* No device has opened the request: the QR code. None for a request that turns the method on, opened or not. */
        case waiting(qr: String?)
        /* A device opened it: the code to type there. Never for a request that turns the method on. */
        case code(String)
        case approved
        /* Over without an approval: why, with Ask again. */
        case ended(String)
    }

    /* What a request is made from; turning the method on, it names the device the person chose (HushOSKit). */
    typealias Request = DeviceAsk.Request

    /* The answer, and the request itself: turning the method on, the approval answers nothing, and the code typed afterwards is sent with the request's id. */
    typealias Approved = @MainActor @Sendable (StepAnswer, DeviceAsk) async throws -> Void
    typealias Failed = @MainActor @Sendable (Error) -> Void

    private(set) var phase = Phase.idle
    /* What the request that is out, or was last out, answers its step with: a lost reply sends the same one again. */
    private(set) var answer: StepAnswer?
    @ObservationIgnored private var task: Task<Void, Never>?
    @ObservationIgnored private var run = 0
    @ObservationIgnored private var current: (ask: DeviceAsk, approved: Approved, failed: Failed)?

    var idle: Bool { phase == .idle }
    /* A request is out and not yet answered either way. */
    var out: Bool {
        switch phase {
        case .starting, .waiting, .code: true
        case .idle, .approved, .ended: false
        }
    }

    isolated deinit { task?.cancel() }

    /*
     * Makes the request and follows it. `approved` hears the answer once another device approved,
     * and never before; `step-pending` thrown from it keeps waiting. `failed` hears why the request
     * could not be made, or what `approved` threw: nothing is out then.
     */
    func begin(_ request: Request, approved: @escaping Approved, failed: @escaping Failed) {
        stop()
        let this = run
        phase = .starting
        task = Task { [weak self] in
            do {
                let ask = try await request.start(name: await Auth.deviceName())
                guard let self, self.run == this, !Task.isCancelled else { return }
                self.answer = ask.answer
                self.current = (ask, approved, failed)
                self.phase = .waiting(qr: ask.qr)
                await self.follow(ask, run: this, approved: approved, failed: failed)
            } catch {
                guard let self, self.run == this, !ErrorWords.isCancellation(error) else { return }
                self.phase = .idle
                failed(error)
            }
        }
    }

    /* The answer went out before the approval had landed (`step-pending`): the same request is waited on again. */
    func resume() {
        guard let current, phase == .approved else { return }
        let this = run
        task?.cancel()
        task = Task { [weak self] in await self?.follow(current.ask, run: this, approved: current.approved, failed: current.failed) }
    }

    private func follow(_ ask: DeviceAsk, run this: Int, approved: @escaping Approved, failed: @escaping Failed) async {
        do {
            _ = try await ask.answered(shown: { [weak self] state in await self?.show(state, qr: ask.qr, run: this) }) { answer in
                try await approved(answer, ask)
                return true
            }
        } catch {
            guard run == this, !ErrorWords.isCancellation(error) else { return }
            phase = .idle
            failed(error)
        }
    }

    private func show(_ state: DeviceAsk.State, qr: String?, run this: Int) {
        guard run == this else { return }
        switch state {
        case .waiting: phase = .waiting(qr: qr)
        // Turning the method on: opened or not, this screen says the same, and shows no code.
        case .opened: phase = .waiting(qr: nil)
        case .code(let code): phase = .code(code)
        case .approved: phase = .approved
        case .ended(let why): phase = .ended(StepWords.ended(why))
        }
    }

    /* Lets the request go: nothing is looked at again, and nothing of it is shown. The server ends it with its token. */
    func stop() {
        run += 1
        task?.cancel()
        task = nil
        current = nil
        answer = nil
        phase = .idle
    }
}

/*
 * The asking side's panel: the QR code until a device opens the request, then the code, then how it ended.
 * Turning the method on (`approver`), it shows neither at any point: only which device to pick up.
 */
struct DeviceAskView: View {
    let model: DeviceAskModel
    /* A form has no button of its own for it: Ask again sits in the panel. The sign-in screen's own button asks again. */
    let inlineAgain: Bool
    /* Turning the method on: the name of the one device that is asked, so the panel says which to pick up. The code is that device's to show. */
    var approver: String?
    let again: () -> Void

    private var pickUp: some View {
        Text(StepWords.askOpen(on: approver)).font(Theme.Text.callout).foregroundStyle(Alpine.inkMuted).multilineTextAlignment(.center)
            .frame(maxWidth: .infinity, minHeight: 44)
    }

    var body: some View {
        Group {
            switch model.phase {
            case .idle:
                EmptyView()
            case .starting:
                ProgressView().frame(maxWidth: .infinity, minHeight: 44)
            case .waiting(let qr):
                if let qr, approver == nil {
                    VStack(spacing: Alpine.Space.s4) {
                        QRCode(text: qr).frame(width: 208, height: 208)
                        Text(StepWords.askOpen(on: approver)).font(Theme.Text.callout).foregroundStyle(Alpine.inkMuted).multilineTextAlignment(.center)
                    }
                    .frame(maxWidth: .infinity)
                } else {
                    pickUp
                }
            case .code where approver != nil:
                pickUp
            case .approved where approver != nil:
                // The approval is half of it: the sheet asks for the code that device now shows.
                EmptyView()
            case .code(let code):
                ShownCode(code: code)
            case .approved:
                ApprovedLine()
            case .ended(let line):
                VStack(spacing: Alpine.Space.s2) {
                    Text(line).font(Theme.Text.callout).foregroundStyle(Alpine.ink).multilineTextAlignment(.center)
                    if inlineAgain {
                        Button(StepWords.askAgain, action: again).buttonStyle(.borderless).foregroundStyle(Alpine.primary).frame(minHeight: 44)
                    }
                }
                .frame(maxWidth: .infinity)
            }
        }
        .padding(.vertical, Alpine.Space.s2)
    }
}

/* The other device approved: said in the asking panel, and on the sign-in screen while that approval's answer is still to be sent again. */
struct ApprovedLine: View {
    var body: some View {
        Label(StepWords.approved, systemImage: "checkmark.circle.fill").foregroundStyle(Alpine.success).frame(maxWidth: .infinity, minHeight: 44)
    }
}

/*
 * A code for the other device, as a screen shows it: the one a sign-in or a change shows to be
 * typed there, and the one this iPhone drew when it approved turning the method on. Not drawn
 * while the screen is recorded, mirrored or AirPlayed (`ScreenCapture`), as the authenticator
 * key and the backup codes are not: a recording outlives the moment, and a mirrored screen is
 * someone else's. VoiceOver is not given it then either.
 */
struct ShownCode: View {
    let code: String
    @State private var capture = ScreenCapture.shared

    var body: some View {
        VStack(spacing: Alpine.Space.s2) {
            Text(StepWords.askCode).font(Theme.Text.callout.weight(.semibold)).foregroundStyle(Alpine.ink)
            if capture.active {
                Label("Hidden while your screen is recorded or shared.", systemImage: "eye.slash")
                    .font(Theme.Text.callout).foregroundStyle(Alpine.inkMuted).multilineTextAlignment(.center)
            } else {
                Text(code).font(.system(.largeTitle, design: .monospaced).weight(.bold)).foregroundStyle(Alpine.ink)
                    .lineLimit(1).minimumScaleFactor(0.6)
            }
        }
        .frame(maxWidth: .infinity)
        .accessibilityElement(children: .combine)
    }
}

/* A QR code, dark on white in both appearances with its quiet zone, so any camera reads it. */
struct QRCode: View {
    let text: String

    var body: some View {
        if let image = Self.image(text) {
            Image(uiImage: image).interpolation(.none).resizable().scaledToFit()
                .padding(Alpine.Space.s3)
                .background(Color.white, in: RoundedRectangle(cornerRadius: Alpine.Radius.control, style: .continuous))
                .accessibilityLabel(StepWords.askCode)
        }
    }

    static func image(_ text: String) -> UIImage? {
        let filter = CIFilter.qrCodeGenerator()
        filter.message = Data(text.utf8)
        filter.correctionLevel = "M"
        guard let output = filter.outputImage?.transformed(by: CGAffineTransform(scaleX: 8, y: 8)),
              let rendered = CIContext().createCGImage(output, from: output.extent) else { return nil }
        return UIImage(cgImage: rendered)
    }
}

/* MARK: Answering */

/*
 * The list itself is HushOSKit's `ApprovalInbox`: read when the app comes to the front, every five
 * seconds while Account is on screen, and when a push arrives. Home's banner and Devices' rows show
 * it, on any server: whether two-step sign-in can be turned on there is nothing to it.
 */

/* One waiting request as a row: what is asked and by which device, and Answer. */
struct ApprovalRow: View {
    let text: String
    let answer: () -> Void

    var body: some View {
        HStack(spacing: Alpine.Space.s3) {
            Text(text).foregroundStyle(Alpine.ink).frame(maxWidth: .infinity, alignment: .leading)
            Button(StepWords.approvalAnswer, action: answer)
                .buttonStyle(.borderless).font(.body.weight(.semibold)).foregroundStyle(Alpine.primary).frame(minHeight: 44)
        }
        .frame(minHeight: 44)
        .alpineRow()
    }
}

/*
 * Where a code from another device's screen is typed: two digits and a word, with the words the
 * typed beginning could become offered beneath. The answer sheet's field, and the one the code is
 * typed into where the method is turned on. The field itself is `CodeEntry`, which teaches the
 * keyboard nothing; the words offered beneath are the app's own, from the core's list.
 */
struct ApprovalCodeField: View {
    let label: String
    @Binding var typed: String
    let disabled: Bool
    var edited: () -> Void = {}
    // While the screen is recorded, mirrored or AirPlayed, what is typed and the words offered for it are blurred, as
    // the step's other fields are (`StepField`, `ScreenCapture`). The field and the words still work.
    @State private var capture = ScreenCapture.shared

    /* The digits as typed, and the word begun after them. */
    private var digits: String { String(typed.prefix(while: StepDraft.digit)) }
    private var word: String { String(typed.drop(while: { !$0.isLetter })).lowercased() }
    /* Words the beginning could become; none once it is one of them and nothing longer. */
    private var completions: [String] {
        let found = approvalWords(prefix: word, limit: 6)
        return found == [word] ? [] : found
    }

    var body: some View {
        Section {
            CodeEntry(label: label, typed: $typed, edited: edited).disabled(disabled)
                .blur(radius: capture.active ? 10 : 0)
                .alpineRow()
            if !completions.isEmpty {
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: Alpine.Space.s2) {
                        ForEach(completions, id: \.self) { completion in
                            Button(completion) { typed = "\(digits) \(completion)"; edited() }
                                .buttonStyle(.bordered).buttonBorderShape(.capsule).tint(Alpine.primary).disabled(disabled)
                        }
                    }
                }
                // The words the typed beginning could become give the code's word away as surely as the field does.
                .blur(radius: capture.active ? 10 : 0)
                .alpineRow()
            }
        } header: {
            FieldLabel(label)
        }
    }
}

/*
 * The field a code is typed in. A UIKit field, because SwiftUI's has no way to say all of it: no
 * autocorrection, spell checking, capitals, predictions (the bar or inline), smart punctuation or
 * Writing Tools, as `PhraseEntry` and a shown password. So the keyboard neither learns the code's
 * word nor offers what it learned elsewhere, and nothing typed here goes to a model. The app
 * refuses third-party keyboards (AppDelegate).
 */
private struct CodeEntry: UIViewRepresentable {
    let label: String
    @Binding var typed: String
    let edited: () -> Void

    /* Longer than any code as people type one, spaces and a hyphen included. */
    private static let longest = 24

    func makeCoordinator() -> Coordinator { Coordinator(self) }

    func makeUIView(context: Context) -> UITextField {
        let field = UITextField()
        field.delegate = context.coordinator
        field.font = UIFontMetrics(forTextStyle: .title3).scaledFont(for: .monospacedSystemFont(ofSize: 20, weight: .regular))
        field.adjustsFontForContentSizeCategory = true
        field.textColor = UIColor(Alpine.ink)
        field.placeholder = "47 river"
        field.keyboardType = .asciiCapable
        field.returnKeyType = .done
        field.textContentType = nil
        field.autocorrectionType = .no
        field.spellCheckingType = .no
        field.autocapitalizationType = .none
        field.inlinePredictionType = .no
        field.smartQuotesType = .no
        field.smartDashesType = .no
        field.smartInsertDeleteType = .no
        field.writingToolsBehavior = .none
        field.allowedWritingToolsResultOptions = []
        field.setContentHuggingPriority(.defaultLow, for: .horizontal)
        field.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        field.addTarget(context.coordinator, action: #selector(Coordinator.changed(_:)), for: .editingChanged)
        return field
    }

    func updateUIView(_ field: UITextField, context: Context) {
        context.coordinator.parent = self
        // A word chosen beneath, or the field cleared for another try.
        if field.text != typed { field.text = typed }
        field.accessibilityLabel = label
        field.isEnabled = context.environment.isEnabled
    }

    func sizeThatFits(_ proposal: ProposedViewSize, uiView field: UITextField, context: Context) -> CGSize? {
        CGSize(width: proposal.width ?? field.intrinsicContentSize.width, height: field.intrinsicContentSize.height)
    }

    final class Coordinator: NSObject, UITextFieldDelegate {
        var parent: CodeEntry
        init(_ parent: CodeEntry) { self.parent = parent }

        @objc func changed(_ field: UITextField) {
            let kept = String((field.text ?? "").prefix(CodeEntry.longest))
            if field.text != kept { field.text = kept }
            guard parent.typed != kept else { return }
            parent.typed = kept
            parent.edited()
        }

        func textFieldShouldReturn(_ field: UITextField) -> Bool {
            field.resignFirstResponder()
            return true
        }
    }
}

/*
 * Answering a request. Scan the other screen's QR code, and this iPhone checks that it is this
 * very request before anything is asked; or type the code that screen shows. Only then Approve.
 * Deny and This wasn’t me end it at any point. Anything that does not match ends it and says so.
 *
 * A request that turns the method on is the other way round: nothing is scanned or typed, this
 * iPhone approves on a press once the other device revealed, drawing a code of its own as it
 * does, and then shows that code for the person to type there, until Done. Nothing the other
 * device holds gives the code, so whoever turns the method on has read this screen. The title
 * says the asking device's name is its own word, and the day it was added.
 *
 * What is on screen, and what holds the sheet, is HushOSKit's `ApprovalAnswer`: waiting for the
 * other device never does, only an approval or an ending that is out. An approval of such a
 * request that was not answered keeps the sheet on it (`unsure`): the reply is said to be lost,
 * Approve reads Try again, and nothing here says the request is over until the server does.
 */
struct ApprovalSheet: View {
    @Environment(\.dismiss) private var dismiss
    @State private var answer: ApprovalAnswer
    @State private var typed = ""

    init(flow: ApprovalAnswering) {
        _answer = State(initialValue: ApprovalAnswer(flow: flow, around: .init(say: { NoticeCenter.shared.show($0, important: $1) })))
    }

    private var flow: ApprovalAnswering { answer.flow }
    private var canScan: Bool { DataScannerViewController.isSupported && DataScannerViewController.isAvailable }
    private var shown: String? {
        if case .shown(let code) = answer.phase { return code }
        return nil
    }

    var body: some View {
        NavigationStack {
            Form {
                // What is asked, and by which device, whole: a bar's title would cut a long device name short.
                Section {} header: {
                    VStack(alignment: .leading, spacing: Alpine.Space.s2) {
                        Text(flow.asks).font(Theme.Text.title).foregroundStyle(Alpine.ink)
                            .fixedSize(horizontal: false, vertical: true).accessibilityAddTraits(.isHeader)
                        // The asking device named this one: no other device was shown the request.
                        if let chosen = flow.chosenLine {
                            Text(chosen).font(Theme.Text.callout).foregroundStyle(Alpine.ink).fixedSize(horizontal: false, vertical: true)
                        }
                    }
                    .textCase(nil)
                }
                switch answer.phase {
                case .choose:
                    Section {
                        if canScan {
                            Button("Scan the code") { answer.scan() }.foregroundStyle(Alpine.primary).alpineRow()
                        }
                        Button("Type the code") { answer.type() }.foregroundStyle(Alpine.primary).alpineRow()
                    }
                case .scanning:
                    Section {
                        ApprovalScanner { answer.scanned($0) }
                            .frame(height: 320).listRowInsets(EdgeInsets()).listRowBackground(Color.black)
                    }
                case .waiting:
                    Section {
                        HStack(spacing: Alpine.Space.s3) {
                            ProgressView()
                            Text(StepWords.askWaiting).foregroundStyle(Alpine.inkMuted)
                        }
                        .alpineRow()
                    }
                    // Turning the method on: Approve is there from the start, and can be pressed once the other device revealed.
                    if answer.turnsOn { approveRow(disabled: true) {} }
                case .typing:
                    ApprovalCodeField(label: StepWords.approvalCodeField, typed: $typed, disabled: answer.sending) { answer.edited() }
                    approveRow(disabled: answer.sending) { answer.approve(typed: typed) }
                case .confirm:
                    approveRow(disabled: answer.sending) { answer.approve() }
                case .shown(let code):
                    // Approved: the code this iPhone drew is its to show, and stays until Done.
                    Section {
                        ShownCode(code: code).padding(.vertical, Alpine.Space.s2).alpineRow()
                    }
                    Section {
                        Button { answer.done() } label: { Text(StepWords.done).frame(maxWidth: .infinity) }
                            .buttonStyle(PrimaryCapsuleStyle())
                            .listRowBackground(Color.clear).listRowInsets(EdgeInsets())
                    }
                }
                if !answer.error.isEmpty { Section { Text(answer.error).foregroundStyle(Alpine.danger).alpineRow() } }
                if shown == nil {
                    Section {
                        Button("Deny") { answer.end(.denied) }.foregroundStyle(Alpine.primary).disabled(answer.held).alpineRow()
                        Button("This wasn’t me", role: .destructive) { answer.end(.notMe) }.foregroundStyle(Alpine.danger).disabled(answer.held).alpineRow()
                    }
                }
            }
            .alpineGrouped()
            .scrollDismissesKeyboard(.interactively)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                // Under the code there is one button, Done.
                if shown == nil {
                    ToolbarItem(placement: .cancellationAction) { Button("Cancel") { answer.cancel() }.disabled(answer.held) }
                }
            }
            // Only over an approval or an ending that is out: the wait for the other device holds nothing.
            .interactiveDismissDisabled(answer.held)
            .task { answer.appeared() }
            .onChange(of: answer.closed) { _, closed in if closed { dismiss() } }
            // Swiped away, or its session ended. While it waited the request is ended; anywhere else it stays in the list.
            .onDisappear { answer.gone() }
        }
    }

    private func approveRow(disabled: Bool, _ action: @escaping () -> Void) -> some View {
        Section {
            // Try again while an approval that went out has not been answered: the same one is sent.
            Button(action: action) { Text(answer.unsure ? StepWords.tryAgain : "Approve").frame(maxWidth: .infinity) }
                .buttonStyle(PrimaryCapsuleStyle()).disabled(disabled)
                .listRowBackground(Color.clear).listRowInsets(EdgeInsets())
        }
    }
}

/* The camera on the other screen's QR code. */
private struct ApprovalScanner: UIViewControllerRepresentable {
    let found: (String) -> Void

    func makeCoordinator() -> Coordinator { Coordinator(found: found) }

    func makeUIViewController(context: Context) -> DataScannerViewController {
        let scanner = DataScannerViewController(recognizedDataTypes: [.barcode(symbologies: [.qr])], qualityLevel: .balanced,
                                                recognizesMultipleItems: false, isHighFrameRateTrackingEnabled: false, isHighlightingEnabled: true)
        scanner.delegate = context.coordinator
        try? scanner.startScanning()
        return scanner
    }

    func updateUIViewController(_ controller: DataScannerViewController, context: Context) {}

    static func dismantleUIViewController(_ controller: DataScannerViewController, coordinator: Coordinator) { controller.stopScanning() }

    final class Coordinator: NSObject, DataScannerViewControllerDelegate {
        let found: (String) -> Void
        init(found: @escaping (String) -> Void) { self.found = found }

        func dataScanner(_ scanner: DataScannerViewController, didUpdate _: [RecognizedItem], allItems: [RecognizedItem]) { look(allItems) }
        func dataScanner(_ scanner: DataScannerViewController, didAdd _: [RecognizedItem], allItems: [RecognizedItem]) { look(allItems) }

        private func look(_ items: [RecognizedItem]) {
            for item in items {
                guard case let .barcode(code) = item, let text = code.payloadStringValue else { continue }
                Task { @MainActor in found(text) }
            }
        }
    }
}
