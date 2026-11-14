import CoreImage.CIFilterBuiltins
import HushOSKit
import SwiftUI
import UIKit
import VisionKit

/*
 * Approve on another device (docs/two-step-design.md 12), on this iPhone's screens: the panel the
 * asking side shows (a QR code, then the code to type on the other device), and the answering
 * side's list, banner and sheet. The order of every request, and every check, is HushOSKit's
 * (`DeviceAsk`, `ApprovalAnswering`); nothing here decides what is revealed, approved or signed.
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
        /* No device has opened the request: the QR code. */
        case waiting(qr: String)
        /* A device opened it: the code to type there. */
        case code(String)
        case approved
        /* Over without an approval: why, with Ask again. */
        case ended(String)
    }

    /* What a request is made from; turning the method on, it names the device the person chose (HushOSKit). */
    typealias Request = DeviceAsk.Request

    typealias Approved = @MainActor @Sendable (StepAnswer) async throws -> Void
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
                try await approved(answer)
                return true
            }
        } catch {
            guard run == this, !ErrorWords.isCancellation(error) else { return }
            phase = .idle
            failed(error)
        }
    }

    private func show(_ state: DeviceAsk.State, qr: String, run this: Int) {
        guard run == this else { return }
        switch state {
        case .waiting: phase = .waiting(qr: qr)
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

/* The asking side's panel: the QR code until a device opens the request, then the code, then how it ended. */
struct DeviceAskView: View {
    let model: DeviceAskModel
    /* A form has no button of its own for it: Ask again sits in the panel. The sign-in screen's own button asks again. */
    let inlineAgain: Bool
    /* Turning the method on: the name of the one device that is asked, so the panel says which to pick up. */
    var approver: String?
    let again: () -> Void

    var body: some View {
        Group {
            switch model.phase {
            case .idle:
                EmptyView()
            case .starting:
                ProgressView().frame(maxWidth: .infinity, minHeight: 44)
            case .waiting(let qr):
                VStack(spacing: Alpine.Space.s4) {
                    QRCode(text: qr).frame(width: 208, height: 208)
                    Text(StepWords.askOpen(on: approver)).font(Theme.Text.callout).foregroundStyle(Alpine.inkMuted).multilineTextAlignment(.center)
                }
                .frame(maxWidth: .infinity)
            case .code(let code):
                VStack(spacing: Alpine.Space.s2) {
                    Text(StepWords.askCode).font(Theme.Text.callout.weight(.semibold)).foregroundStyle(Alpine.ink)
                    Text(code).font(.system(.largeTitle, design: .monospaced).weight(.bold)).foregroundStyle(Alpine.ink)
                        .lineLimit(1).minimumScaleFactor(0.6)
                }
                .frame(maxWidth: .infinity)
                .accessibilityElement(children: .combine)
            case .approved:
                Label(StepWords.approved, systemImage: "checkmark.circle.fill").foregroundStyle(Alpine.success).frame(maxWidth: .infinity, minHeight: 44)
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
 * Answering a request. Scan the other screen's QR code, and this iPhone checks that it is this
 * very request before anything is asked; or type the code that screen shows. Only then Approve.
 * Deny and This wasn’t me end it at any point. Anything that does not match ends it and says so.
 */
struct ApprovalSheet: View {
    let flow: ApprovalAnswering
    @Environment(\.dismiss) private var dismiss

    private enum Phase { case choose, scanning, waiting, typing, confirm }
    @State private var phase = Phase.choose
    @State private var typed = ""
    @State private var busy = false
    @State private var error = ""
    @State private var work: Task<Void, Never>?

    private var canScan: Bool { DataScannerViewController.isSupported && DataScannerViewController.isAvailable }

    /* The digits as typed, and the word begun after them. */
    private var digits: String { String(typed.prefix(while: StepDraft.digit)) }
    private var word: String { String(typed.drop(while: { !$0.isLetter })).lowercased() }
    /* Words the beginning could become; none once it is one of them and nothing longer. */
    private var completions: [String] {
        let found = approvalWords(prefix: word, limit: 6)
        return found == [word] ? [] : found
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
                switch phase {
                case .choose:
                    Section {
                        if canScan {
                            Button("Scan the code") { error = ""; phase = .scanning }.foregroundStyle(Alpine.primary).alpineRow()
                        }
                        Button("Type the code") { type() }.foregroundStyle(Alpine.primary).alpineRow()
                    }
                case .scanning:
                    Section {
                        ApprovalScanner { scanned($0) }
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
                case .typing:
                    Section {
                        TextField("47 river", text: Binding(get: { typed }, set: { typed = String($0.prefix(24)); error = "" }))
                            .font(.title3.monospaced()).foregroundStyle(Alpine.ink).keyboardType(.asciiCapable).textInputAutocapitalization(.never).autocorrectionDisabled()
                            .submitLabel(.done).disabled(busy).accessibilityLabel(StepWords.approvalCodeField).alpineRow()
                        if !completions.isEmpty {
                            ScrollView(.horizontal, showsIndicators: false) {
                                HStack(spacing: Alpine.Space.s2) {
                                    ForEach(completions, id: \.self) { completion in
                                        Button(completion) { typed = "\(digits) \(completion)" }
                                            .buttonStyle(.bordered).buttonBorderShape(.capsule).tint(Alpine.primary)
                                    }
                                }
                            }
                            .alpineRow()
                        }
                    } header: {
                        FieldLabel(StepWords.approvalCodeField)
                    }
                    approveRow { approve(typed) }
                case .confirm:
                    approveRow { approve(nil) }
                }
                if !error.isEmpty { Section { Text(error).foregroundStyle(Alpine.danger).alpineRow() } }
                Section {
                    Button("Deny") { end(.denied) }.foregroundStyle(Alpine.primary).disabled(busy).alpineRow()
                    Button("This wasn’t me", role: .destructive) { end(.notMe) }.foregroundStyle(Alpine.danger).disabled(busy).alpineRow()
                }
            }
            .alpineGrouped()
            .scrollDismissesKeyboard(.interactively)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() }.disabled(busy) } }
            .interactiveDismissDisabled(busy)
            // Closed without an answer: the request stays in the list until it is answered or over.
            .onDisappear { work?.cancel() }
        }
    }

    private func approveRow(_ action: @escaping () -> Void) -> some View {
        Section {
            Button(action: action) { Text("Approve").frame(maxWidth: .infinity) }
                .buttonStyle(PrimaryCapsuleStyle()).disabled(busy)
                .listRowBackground(Color.clear).listRowInsets(EdgeInsets())
        }
    }

    /* Type the code: the request is opened, and the field appears once the other device has revealed what it committed to. */
    private func type() {
        error = ""
        phase = .waiting
        work = Task {
            do {
                try await flow.open()
                try await flow.awaitReveal()
                phase = .typing
            } catch {
                failed(error)
            }
        }
    }

    /* What the camera read. Anything that is not an approval's code is passed over; this request's own opens it. */
    private func scanned(_ text: String) {
        // Another QR code in view is not looked at twice, and holds nothing up.
        guard !busy, phase == .scanning, approvalQrRead(text: text) != nil else { return }
        busy = true
        work = Task {
            defer { busy = false }
            do {
                guard try await flow.open(scanned: text) else { return }
                phase = .waiting
                try await flow.awaitReveal()
                phase = .confirm
            } catch {
                failed(error)
            }
        }
    }

    private func approve(_ typed: String?) {
        guard !busy else { return }
        busy = true
        error = ""
        work = Task {
            defer { busy = false }
            do {
                try await flow.approve(typed: typed)
                close(StepWords.approved)
            } catch {
                failed(error)
            }
        }
    }

    private func end(_ why: ApprovalAnswering.Ending) {
        guard !busy else { return }
        busy = true
        error = ""
        work?.cancel()
        work = Task {
            defer { busy = false }
            do {
                try await flow.end(why)
                close(StepWords.denied)
            } catch {
                failed(error)
            }
        }
    }

    private func close(_ said: String, important: Bool = false) {
        NoticeCenter.shared.show(said, important: important)
        ApprovalInbox.shared.finished(flow.id)
        dismiss()
    }

    /* A request that is over, or that did not match, closes with why. Anything else stays, to be tried again. */
    private func failed(_ error: Error) {
        if ErrorWords.isCancellation(error) { return }
        if let problem = error as? ApprovalProblem {
            close(problem.errorDescription ?? ErrorWords.generic, important: true)
            return
        }
        // An ended session is said by the app as everywhere; nothing of this account's is left to answer.
        if endsSession(error) { dismiss(); return }
        if phase == .waiting || phase == .scanning { phase = .choose }
        self.error = ErrorWords.say(error) ?? ""
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
