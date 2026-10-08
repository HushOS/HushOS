import UniformTypeIdentifiers
import HushOSKit
import SwiftUI
import UIKit

/*
 * The item menu, one list in one order on every client (DESIGN.md):
 * get it out, organise it, about it, report, and Move to Trash last and red. What
 * shows depends on whose the item is: someone else's folder hides Share and Tags,
 * adds Save a copy and Report, and a viewer loses Rename, Move and Trash.
 */
enum NodeAction: Identifiable {
    case move([Opened])
    case share(Opened)
    case sendCopy(Opened)
    case versions(Opened)
    case tags(Opened)
    case info(Opened)
    case report(Opened)

    var id: String {
        switch self {
        case .move(let items): return "move-" + items.map(\.id).joined(separator: ",")
        case .share(let item): return "share-\(item.id)"
        case .sendCopy(let item): return "send-\(item.id)"
        case .versions(let item): return "versions-\(item.id)"
        case .tags(let item): return "tags-\(item.id)"
        case .info(let item): return "info-\(item.id)"
        case .report(let item): return "report-\(item.id)"
        }
    }
}

extension View {
    /* Long-press for the menu; swipe for Move, Rename and Move to Trash at the edge (a full swipe trashes). */
    func nodeActions(_ item: Opened, action: Binding<NodeAction?>, store: DriveStore, select: (() -> Void)? = nil) -> some View {
        self
            .contextMenu {
                NodeMenu(item: item, action: action, select: select)
            }
            // From the leading edge, a file goes out as a plain copy through the system share sheet.
            .swipeActions(edge: .leading) {
                if !item.isFolder {
                    Button { action.wrappedValue = .sendCopy(item) } label: { Label("Send a copy", systemImage: "square.and.arrow.up") }.tint(Alpine.primary)
                }
            }
            .swipeActions(edge: .trailing, allowsFullSwipe: store.role(of: item) != .viewer) {
                if store.role(of: item) != .viewer {
                    Button(role: .destructive) { Task { await store.trash(item) } } label: { Label("Move to Trash", systemImage: "trash") }.tint(Alpine.danger)
                    Button { Rename.ask(item, store: store) } label: { Label("Rename", systemImage: "pencil") }.tint(Alpine.primary)
                    Button { action.wrappedValue = .move([item]) } label: { Label("Move", systemImage: "folder") }.tint(Alpine.ink)
                }
            }
    }

    func nodeActionSheets(action: Binding<NodeAction?>, store: DriveStore) -> some View {
        // Sharing may have changed who can open what; the rows and banners ask again.
        self.sheet(item: action, onDismiss: { Task { await store.refreshSharing() } }) { shown in
            switch shown {
            case .move(let items): MovePicker(items: items).environment(store)
            case .share(let item): ShareItemSheet(item: item).environment(store)
            case .sendCopy(let item): SendCopySheet(item: item).environment(store)
            case .versions(let item): VersionsSheet(item: item).environment(store)
            case .tags(let item): ItemTagsSheet(item: item).environment(store)
            case .info(let item): InfoSheet(item: item) { next in action.wrappedValue = next }.environment(store)
            case .report(let item):
                ReportSheet(item: item, from: store.mounts.first { $0.share.workspaceId == item.node.workspaceId }?.share.granter.name) { category, reason, email in
                    try await store.vault.report(item, category: category, reason: reason, email: email)
                }
            }
        }
    }
}

struct NodeMenu: View {
    @Environment(DriveStore.self) private var store
    let item: Opened
    @Binding var action: NodeAction?
    /* In a folder list, Select starts picking with this item. */
    var select: (() -> Void)? = nil

    var body: some View {
        let role = store.role(of: item)
        let mine = role == .owner
        let canEdit = role != .viewer
        if let select {
            Section { Button("Select", systemImage: "checkmark.circle", action: select) }
        }
        Section {
            if mine { Button("Share", systemImage: "person.badge.plus") { action = .share(item) } }
            if item.isFolder {
                // A folder keeps every file inside it, and stays kept as they change; a folder shared with
                // you too (its files list through the share, and go if the share stops).
                if true {
                switch store.keptState(item.id) {
                case .none:
                    Button("Keep on this phone", systemImage: "arrow.down.circle") { Task { await store.keepFolder(item) } }
                case .fetching:
                    Button("Keeping on this phone…", systemImage: "arrow.down.circle.dotted") {}.disabled(true)
                case .kept:
                    Button("Remove from this phone", systemImage: "iphone.slash") {
                        store.removeKeptFolder(item.id)
                        store.notify("Removed “\(item.name)” from this phone. It’s still in HushOS.")
                    }
                }
                }
            } else if let folder = store.keptWith(item) {
                Button("Open in…", systemImage: "arrow.up.forward.app") { OpenIn.present(item, store: store) }
                Button("Send a copy", systemImage: "square.and.arrow.up") { action = .sendCopy(item) }
                // Kept with its folder: only the folder can take it off the phone, and the menu says so.
                if let failure = store.keepFailure(item) {
                    // The rest of the folder is kept; this one says why and can go again now.
                    Button("Couldn’t be kept: \(failure.reason)", systemImage: "exclamationmark.circle") {}.disabled(true)
                    Button("Retry", systemImage: "arrow.clockwise") { Task { await store.retryKeep(item) } }
                } else if Offline.isKept(item.id) {
                    Button("Kept with “\(folder.name)”", systemImage: "iphone") {}.disabled(true)
                } else {
                    Button("Keeping with “\(folder.name)”…", systemImage: "arrow.down.circle.dotted") {}.disabled(true)
                }
                Button("Remove “\(folder.name)” from this phone", systemImage: "iphone.slash") {
                    store.removeKeptFolder(folder.id)
                    store.notify("Removed “\(folder.name)” from this phone. It’s still in HushOS.")
                }
            } else {
                Button("Open in…", systemImage: "arrow.up.forward.app") { OpenIn.present(item, store: store) }
                Button("Send a copy", systemImage: "square.and.arrow.up") { action = .sendCopy(item) }
                switch store.keptState(item.id) {
                case .none:
                    Button("Keep on this phone", systemImage: "arrow.down.circle") { Task { await store.setKeptDownloaded(item, true) } }
                case .fetching(let queued):
                    Button(keepingLabel(queued), systemImage: "arrow.down.circle.dotted") {}.disabled(true)
                    if let queued {
                        Button("Stop downloading", systemImage: "xmark.circle") { Task { await BackgroundTransfers.shared.cancel(queued) } }
                    }
                case .kept:
                    Button("Remove from this phone", systemImage: "iphone.slash") {
                        Task {
                            await store.setKeptDownloaded(item, false)
                            store.notify("Removed from this phone. It’s still in HushOS.")
                        }
                    }
                }
            }
            if !mine { Button("Save a copy to my files", systemImage: "plus.square.on.square") { Task { await store.saveCopy(item) } } }
        }
        Section {
            if canEdit {
                Button("Rename", systemImage: "pencil") { Rename.ask(item, store: store) }
                Button("Move", systemImage: "folder") { action = .move([item]) }
            }
            Button("Copy", systemImage: "doc.on.doc") {
                store.copy([item])
                // In a folder the paste bar says it; elsewhere (Home, Search) nothing would.
                if select == nil { store.notify("Copied “\(item.name)”. Open a folder to paste.") }
            }
            if mine { Button("Tags", systemImage: "tag") { action = .tags(item) } }
        }
        Section {
            if !item.isFolder && canEdit { Button("Versions", systemImage: "clock.arrow.circlepath") { action = .versions(item) } }
            Button("Info", systemImage: "info.circle") { action = .info(item) }
        }
        if !mine {
            Section { Button("Report", systemImage: "flag") { action = .report(item) } }
        }
        if canEdit {
            Section {
                Button("Move to Trash", systemImage: "trash", role: .destructive) { Task { await store.trash(item) } }.tint(Alpine.danger)
            }
        }
    }

    /* "Downloading… 40%" while a kept copy comes down; the queue knows how far. */
    private func keepingLabel(_ queued: UUID?) -> String {
        guard let queued, let record = BackgroundTransfers.shared.records.first(where: { $0.id == queued }) else { return "Downloading…" }
        return "Downloading… \(Int(BackgroundTransfers.shared.fraction(of: record) * 100))%"
    }
}

/* Rename and New folder: a plain alert with the name selected up to its extension, and the clash said in place. */
@MainActor
enum Rename {
    static func ask(_ item: Opened, store: DriveStore) {
        let siblings = (item.node.parentId.flatMap { store.folders[$0] } ?? []).filter { $0.id != item.id }.map(\.name)
        TextPrompt.present(
            title: "Rename", message: nil, text: item.name, placeholder: "Name", action: "Rename", selectStem: !item.isFolder,
            validate: { name in problem(name, among: siblings) }
        ) { name in
            guard name != item.name else { return }
            Task { await store.rename(item, to: name) }
        }
    }

    static func newFolder(in folderId: String, named folderName: String, store: DriveStore) {
        let taken = (store.folders[folderId] ?? []).map(\.name)
        TextPrompt.present(
            title: "New folder", message: "In “\(folderName)”", text: DriveStore.freeName("Untitled folder", among: taken),
            placeholder: "Name", action: "Create", selectStem: false,
            validate: { name in problem(name, among: taken) }
        ) { name in
            Task { await store.createFolder(named: name, in: folderId) }
        }
    }

    static func problem(_ name: String, among taken: [String]) -> String? {
        let clean = name.trimmingCharacters(in: .whitespaces)
        if clean.isEmpty { return "Enter a name." }
        if clean.contains("/") { return "A name can’t contain “/”." }
        if taken.contains(where: { $0.caseInsensitiveCompare(clean) == .orderedSame }) { return "“\(clean)” is already in this folder. Try another name." }
        return nil
    }
}

/*
 * One name to type, in a short sheet rather than an alert: an alert can't show what
 * is wrong in the danger colour while the person types. The field selects the name
 * up to its extension, so typing replaces the name and keeps ".jpg".
 */
@MainActor
enum TextPrompt {
    static func present(title: String, message: String?, text: String, placeholder: String, action: String, selectStem: Bool,
                        validate: @escaping (String) -> String?, done: @escaping (String) -> Void) {
        let host = UIHostingController(rootView: AnyView(EmptyView()))
        let dismiss: () -> Void = { [weak host] in host?.dismiss(animated: true) }
        host.rootView = AnyView(
            PromptSheet(title: title, message: message, original: text, placeholder: placeholder, action: action, selectStem: selectStem,
                        validate: validate, done: { value in dismiss(); done(value) }, cancel: dismiss)
                .tint(Alpine.primary)
        )
        host.modalPresentationStyle = .pageSheet
        if let sheet = host.sheetPresentationController {
            sheet.detents = [.custom(identifier: .init("prompt")) { _ in message == nil ? 196 : 228 }]
            sheet.prefersGrabberVisible = false
        }
        topController()?.present(host, animated: true)
    }

    static func topController() -> UIViewController? {
        let scenes = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }
        var top = scenes.flatMap(\.windows).first(where: \.isKeyWindow)?.rootViewController
        while let next = top?.presentedViewController, !next.isBeingDismissed { top = next }
        return top
    }
}

private struct PromptSheet: View {
    let title: String
    let message: String?
    let original: String
    let placeholder: String
    let action: String
    let selectStem: Bool
    let validate: (String) -> String?
    let done: (String) -> Void
    let cancel: () -> Void
    @State private var value = ""

    /* Unchanged, a name is fine for Rename; anything typed is checked as it is typed. */
    private var problem: String? {
        let clean = value.trimmingCharacters(in: .whitespaces)
        if action == "Rename" && clean == original { return nil }
        return validate(clean)
    }

    var body: some View {
        NavigationStack {
            VStack(alignment: .leading, spacing: Alpine.Space.s2) {
                if let message { Text(message).font(Theme.Text.callout).foregroundStyle(Alpine.inkMuted).padding(.horizontal, Alpine.Space.s1) }
                PromptField(text: $value, original: original, placeholder: placeholder, selectStem: selectStem, invalid: problem != nil) { submit() }
                    .frame(height: Theme.control)
                    .padding(.horizontal, Alpine.Space.s3)
                    .background(Alpine.surface, in: RoundedRectangle(cornerRadius: Alpine.Radius.control, style: .continuous))
                    .overlay(RoundedRectangle(cornerRadius: Alpine.Radius.control, style: .continuous)
                        .strokeBorder(problem != nil ? Alpine.danger : Alpine.field.opacity(0.5), lineWidth: problem != nil ? 2 : 1))
                if let problem {
                    Label(problem, systemImage: "exclamationmark.circle").font(Theme.Text.footnote).foregroundStyle(Alpine.danger)
                        .padding(.horizontal, Alpine.Space.s1)
                        .accessibilityLabel("Error: \(problem)")
                }
                Spacer(minLength: 0)
            }
            .padding(.horizontal, Alpine.Space.s4).padding(.top, Alpine.Space.s1)
            .background(Alpine.ground.ignoresSafeArea())
            .navigationTitle(title)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel", action: cancel) }
                ToolbarItem(placement: .confirmationAction) { Button(action, action: submit).disabled(problem != nil) }
            }
        }
        .onAppear { value = original }
    }

    private func submit() {
        guard problem == nil else { return }
        done(value.trimmingCharacters(in: .whitespaces))
    }
}

/* A UIKit field, for the one thing SwiftUI's can't do: select part of its text when it opens. */
private struct PromptField: UIViewRepresentable {
    @Binding var text: String
    let original: String
    let placeholder: String
    let selectStem: Bool
    let invalid: Bool
    let submit: () -> Void

    func makeUIView(context: Context) -> UITextField {
        let field = UITextField()
        field.text = original
        field.placeholder = placeholder
        field.font = .preferredFont(forTextStyle: .body)
        field.adjustsFontForContentSizeCategory = true
        field.textColor = UIColor(Alpine.ink)
        field.autocapitalizationType = .sentences
        // Names are what the person types: no autocorrect turning "photos alpine" into something else.
        field.autocorrectionType = .no
        field.clearButtonMode = .whileEditing
        field.returnKeyType = .done
        field.delegate = context.coordinator
        field.addTarget(context.coordinator, action: #selector(Coordinator.changed(_:)), for: .editingChanged)
        DispatchQueue.main.async {
            field.becomeFirstResponder()
            let stem = selectStem ? (original as NSString).deletingPathExtension.count : original.count
            if let start = field.position(from: field.beginningOfDocument, offset: 0),
               let end = field.position(from: field.beginningOfDocument, offset: max(0, stem)) {
                field.selectedTextRange = field.textRange(from: start, to: end)
            }
        }
        return field
    }

    func updateUIView(_ field: UITextField, context: Context) {
        context.coordinator.parent = self
        field.accessibilityValue = invalid ? "Not valid" : nil
    }

    func makeCoordinator() -> Coordinator { Coordinator(parent: self) }

    final class Coordinator: NSObject, UITextFieldDelegate {
        var parent: PromptField
        init(parent: PromptField) { self.parent = parent }
        @objc func changed(_ field: UITextField) { parent.text = field.text ?? "" }
        func textFieldShouldReturn(_ textField: UITextField) -> Bool {
            parent.submit()
            return false
        }
    }
}

/* The system share sheet for one file. */
struct ActivityView: UIViewControllerRepresentable {
    let url: URL
    let done: () -> Void

    func makeUIViewController(context: Context) -> UIActivityViewController {
        let controller = UIActivityViewController(activityItems: [url], applicationActivities: nil)
        controller.completionWithItemsHandler = { _, _, _, _ in done() }
        return controller
    }

    func updateUIViewController(_ uiViewController: UIActivityViewController, context: Context) {}
}

/* Tag colours: the presets, or the hex a person picked here or on the web. */
enum TagColour {
    static func hex(_ color: Color) -> String {
        let components = UIColor(color).cgColor.components ?? [0, 0, 0]
        let r = components.count > 0 ? components[0] : 0
        let g = components.count > 1 ? components[1] : r
        let b = components.count > 2 ? components[2] : r
        return String(format: "#%02x%02x%02x", Int(round(r * 255)), Int(round(g * 255)), Int(round(b * 255)))
    }

    /*
     * The tag yellow, the same on every client: apps/web/src/styles.css `--tag-yellow` is the
     * source (light, dark, high contrast light, high contrast dark). Its own dark value, so it
     * is not lightened again like the other presets.
     */
    static let yellow = Color(alpineLight: 0xFFB8860B, dark: 0xFFE3B341, lightHigh: 0xFF6B4D00, darkHigh: 0xFFFFD966)

    /* Presets with their own dark value (yellow) are not lightened again in the dark. */
    static func hasDarkValue(_ value: String) -> Bool { value == "yellow" }

    static func swiftUI(_ value: String) -> Color {
        switch value {
        case "blue": return Color(red: 0.173, green: 0.259, blue: 0.557)
        case "ink": return Color(red: 0.110, green: 0.157, blue: 0.282)
        case "yellow": return yellow
        case "teal": return Color(red: 0.165, green: 0.498, blue: 0.498)
        case "coral": return Color(red: 0.851, green: 0.388, blue: 0.290)
        default:
            let hex = value.dropFirst()
            guard hex.count == 6, let number = UInt32(hex, radix: 16) else { return Alpine.inkMuted }
            return Color(red: Double((number >> 16) & 0xff) / 255, green: Double((number >> 8) & 0xff) / 255, blue: Double(number & 0xff) / 255)
        }
    }

    static func label(_ value: String) -> String {
        TagRegistry.presets.contains(value) ? value.prefix(1).uppercased() + value.dropFirst() : "Custom"
    }
}

/*
 * Open in…: the decrypted copy handed to an app that opens its type (Excel, Numbers, Pages,
 * a PDF reader), from the system's own list, so a file can be edited where it belongs.
 * QuickLook stays the tap; this is the way out when previewing isn't enough.
 */
@MainActor
enum OpenIn {
    /* Held while the system's list is up: it goes away when the controller does. */
    private static var controller: UIDocumentInteractionController?

    static func present(_ item: Opened, store: DriveStore) {
        Task {
            let file: URL
            do { file = try await store.fetch(item) } catch {
                store.notify("Couldn’t open “\(item.name)”. Check your connection and try again.")
                return
            }
            let interaction = UIDocumentInteractionController(url: file)
            let ext = (item.name as NSString).pathExtension
            interaction.uti = (UTType(filenameExtension: ext) ?? UTType(mimeType: item.metadata.mime ?? "") ?? .data).identifier
            interaction.name = item.name
            controller = interaction
            guard let top = TextPrompt.topController() else { return }
            let anchor = CGRect(x: top.view.bounds.midX, y: top.view.bounds.maxY - 80, width: 1, height: 1)
            if !interaction.presentOpenInMenu(from: anchor, in: top.view, animated: true) {
                controller = nil
                // Android's words: no app here takes this type, so the copy goes somewhere else.
                store.notify("No app on this iPhone opens “\(item.name)”. Send a copy to open it somewhere else.", undo: {
                    TextPrompt.topController()?.present(UIActivityViewController(activityItems: [file], applicationActivities: nil), animated: true)
                }, actionLabel: "Send a copy")
            }
        }
    }
}
