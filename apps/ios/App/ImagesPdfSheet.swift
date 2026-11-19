import HushOSCore
import HushOSKit
import SwiftUI

/*
 * Convert, then One PDF (docs/file-tools-design.md, feature (b)): the images in a list to put in
 * order (drag a row's handle, or its Move earlier and Move later actions for VoiceOver and Switch
 * Control), the page size and margins, and the name, the first image's with `.pdf`. Making it
 * keeps the sheet open with its progress and Stop, which asks first; a stop, a refusal or a
 * failure leaves nothing in the folder (ImagesPdf.make cleans up).
 */
struct ImagesPdfSheet: View {
    @Environment(DriveStore.self) private var store
    @Environment(\.dismiss) private var dismiss
    @State private var order: [Opened]
    @State private var size = ImagesPdf.defaultSize()
    @State private var margin = false
    /* What the person typed; until then the name follows the first image. */
    @State private var typed: String?
    @State private var phase = Phase.choosing
    @State private var work: Task<Void, Never>?
    @State private var askingStop = false
    /* Where the PDF goes, worked out once from the selection as it came (never from the order): the images' own folder. */
    @State private var folder: Opened?
    @State private var problem: String?

    enum Phase: Equatable {
        case choosing
        case making(done: Int, total: Int)
        case saving
        case failed(String)
    }

    private let selection: [Opened]

    init(images: [Opened]) {
        selection = images
        _order = State(initialValue: images)
    }

    private var name: String { typed ?? ImagesPdf.pdfName(for: order.first?.name ?? "") }
    private var total: UInt64 { order.reduce(0) { $0 + ($1.size ?? 0) } }
    private var stage: ImagesPdf.Stage { ImagesPdf.stage(count: order.count, bytes: total) }
    private var busy: Bool {
        switch phase {
        case .making, .saving: true
        default: false
        }
    }

    var body: some View {
        NavigationStack {
            Form {
                Section("Order") {
                    ForEach(Array(order.enumerated()), id: \.element.id) { index, item in
                        HStack(spacing: Alpine.Space.s3) {
                            FileMark(item: item, box: 40)
                            Text(item.name).lineLimit(1).truncationMode(.middle)
                        }
                        .task { await store.thumbnail(for: item) }
                        .accessibilityElement(children: .combine)
                        .accessibilityValue("\(index + 1) of \(order.count)")
                        .accessibilityAction(named: "Move earlier") { move(index, to: index - 1) }
                        .accessibilityAction(named: "Move later") { move(index, to: index + 1) }
                    }
                    .onMove { from, to in order.move(fromOffsets: from, toOffset: to) }
                }
                .disabled(busy)
                Section {
                    Picker("Page size", selection: $size) {
                        Text("Fit to each image").tag(PageSize.fit)
                        Text("A4").tag(PageSize.a4)
                        Text("US Letter").tag(PageSize.letter)
                    }
                    Picker("Margins", selection: $margin) {
                        Text("None").tag(false)
                        Text("12 mm").tag(true)
                    }
                    TextField("Name", text: Binding(get: { name }, set: { typed = $0 }))
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                } footer: {
                    Text("Location, camera and other photo details are left out.")
                }
                .disabled(busy)
                switch stage {
                case .offer:
                    Section {
                        Text("These images are \(ByteCountFormatter.string(fromByteCount: Int64(total), countStyle: .file)). Making the PDF uses a lot of memory and may be slow on this phone.")
                    }
                case .ceiling:
                    Section {
                        Text("These images are too many or too large for one PDF here: at most \(ImagesPdf.limits.maxImages) images and 256 MB.")
                            .foregroundStyle(Alpine.danger)
                    }
                case .fine:
                    EmptyView()
                }
                switch phase {
                case let .making(done, total):
                    Section {
                        ProgressView(value: Double(done), total: Double(max(total, 1))) {
                            Text("\(done) of \(total) \(total == 1 ? "image" : "images")")
                        }
                    }
                case .saving:
                    Section { ProgressView { Text("Saving") } }
                case let .failed(message):
                    Section { Text(message).foregroundStyle(Alpine.danger) }
                case .choosing:
                    if let problem { Section { Text(problem).foregroundStyle(Alpine.danger) } }
                }
            }
            // The handles are the drag; the list's order is the PDF's.
            .environment(\.editMode, .constant(busy ? .inactive : .active))
            .navigationTitle("One PDF")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    if busy {
                        Button("Stop") { askingStop = true }
                    } else {
                        Button("Cancel") { dismiss() }
                    }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button(stage == .offer ? "Continue" : "Make PDF") { make() }
                        .disabled(busy || folder == nil || stage == .ceiling || name.trimmingCharacters(in: .whitespaces).isEmpty
                            || name.contains("/"))
                }
            }
            .confirmationDialog("Stop making the PDF?", isPresented: $askingStop, titleVisibility: .visible) {
                Button("Stop", role: .destructive) { work?.cancel() }
                Button("Keep going", role: .cancel) {}
            } message: {
                Text("What was made so far is deleted.")
            }
        }
        .interactiveDismissDisabled(busy)
        .task {
            // One folder for all of them, or nothing is converted (search results can mix folders).
            guard ImagesPdf.oneFolder(selection) else { problem = ImagesPdf.mixedFolders; return }
            do {
                folder = try await store.vault.editTarget(selection[0]).folder
            } catch {
                if sessionRefused(error) { dismiss(); return }
                problem = ErrorWords.say(error) ?? toolFailedMessage()
            }
        }
    }

    /* A 401 under the conversion: the app's session check, never a line in the sheet. */
    private func sessionRefused(_ error: Error) -> Bool {
        let refusal: Error? = endsSession(error) ? error : (error as? SaveRunStopped)?.sessionRefusal
        guard let refusal else { return false }
        store.report(refusal)
        return true
    }

    private func move(_ from: Int, to: Int) {
        guard order.indices.contains(to) else { return }
        order.move(fromOffsets: IndexSet(integer: from), toOffset: to > from ? to + 1 : to)
    }

    private func make() {
        guard let folder else { return }
        let images = order, size = size, margin = margin
        let name = name.trimmingCharacters(in: .whitespaces)
        let vault = store.vault
        phase = .making(done: 0, total: images.count)
        work = Task {
            do {
                let saved = try await ImagesPdf.make(vault: vault, images: images, folder: folder, size: size, margin: margin, name: name) { done, total in
                    Task { @MainActor in phase = done < total ? .making(done: done, total: total) : .saving }
                }
                await store.refresh(folder: folder.id)
                store.notify("Saved “\(saved.name)”.")
                dismiss()
            } catch {
                if sessionRefused(error) { work = nil; dismiss(); return }
                // A tool's own failure (the watchdog, a file it couldn't read) says so in its own words.
                phase = .failed((error as? ToolFailed)?.message ?? ErrorWords.say(error) ?? toolFailedMessage())
            }
            work = nil
        }
    }
}
