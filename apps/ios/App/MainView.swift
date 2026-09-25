import HushOSKit
import SwiftUI

/*
 * Home, Files, Shared and Account, as the cloud drives lay themselves out on a
 * phone: what changed, the tree, what others gave you, and you. Search sits on
 * Home and Files; the trash lives under Account.
 */
struct MainView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.scenePhase) private var scenePhase
    @State private var store: DriveStore?

    var body: some View {
        Group {
            if let store {
                TabView {
                    Tab("Home", systemImage: "house") {
                        HomeView().environment(store)
                    }
                    Tab("Files", systemImage: "folder") {
                        BrowseView().environment(store)
                    }
                    Tab("Shared", systemImage: "person.2") {
                        SharedView().environment(store)
                    }
                    Tab("Account", systemImage: "person.crop.circle") {
                        AccountView().environment(store)
                    }
                }
                .tabBarMinimizeBehavior(.onScrollDown)
                .safeAreaInset(edge: .top, spacing: 0) {
                    if store.offline {
                        // A quiet line at the top while the server is out of reach; kept files still open.
                        Text("You're offline. Showing what's on this phone.")
                            .font(.footnote).frame(maxWidth: .infinity).padding(.vertical, 6)
                            .background(.regularMaterial)
                    }
                }
                .overlay(alignment: .bottom) {
                    VStack(spacing: 8) {
                        // Above the add button, which sits over this corner on Files and would cover Undo.
                        if let notice = store.notice { NoticeBar(notice: notice, dismiss: { store.notice = nil }) }
                        let queued = BackgroundTransfers.shared.records.map { record in
                            DriveStore.TransferItem(
                                kind: record.kind == .upload ? .upload : .keep, name: record.name,
                                fraction: BackgroundTransfers.shared.fraction(of: record),
                                done: record.state == .done || record.state == .failed, failed: record.state == .failed,
                                waiting: record.state == .waiting, queuedId: record.state == .done ? nil : record.id
                            )
                        }
                        if !(queued + store.transfers).isEmpty { TransferPanel(transfers: queued + store.transfers, offline: store.offline) }
                    }
                    // Above the tab bar and the add button, which sits over this corner on Files.
                    .padding(.bottom, 134)
                    .animation(.snappy, value: store.notice?.id)
                }
                // While the app is on screen the lists follow the server; in the background nothing polls.
                .task(id: scenePhase) {
                    if scenePhase == .active { await store.liveSync() }
                }
                .alert("Something went wrong", isPresented: Binding(get: { store.error != nil }, set: { if !$0 { store.error = nil } })) {
                    Button("OK") {
                        if store.error == "Your session ended. Sign in again." { model.sessionLost() }
                        store.error = nil
                    }
                } message: {
                    Text(store.error ?? "")
                }
            } else {
                ProgressView()
            }
        }
        .task {
            guard store == nil, let vault = model.vault else { return }
            store = DriveStore(vault: vault)
        }
    }
}

/* Every transfer with its own bar, the way the web's panel shows them: name, progress, and how it ended. */
struct TransferPanel: View {
    let transfers: [DriveStore.TransferItem]
    var offline = false

    private var headline: String {
        let running = transfers.filter { !$0.done }
        if running.isEmpty { return transfers.contains(where: \.failed) ? "Some transfers failed" : "Done" }
        if running.allSatisfy(\.waiting) { return offline ? "Waiting for a network" : "Queued" }
        let uploads = running.filter { $0.kind == .upload }.count
        if uploads == running.count { return uploads == 1 ? "Uploading" : "Uploading \(uploads) files" }
        return running.count == 1 ? verb(running[0].kind) : "\(running.count) transfers"
    }

    private func verb(_ kind: DriveStore.TransferItem.Kind) -> String {
        switch kind {
        case .upload: return "Uploading"
        case .download: return "Downloading"
        case .copy: return "Copying"
        case .keep: return "Keeping downloaded"
        case .rotate: return "Rotating keys"
        }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                Text(headline).font(.subheadline.weight(.semibold))
                Spacer()
                let done = transfers.filter(\.done).count
                if transfers.count > 1 { Text("\(done) of \(transfers.count)").font(.footnote).foregroundStyle(.secondary) }
            }
            ForEach(transfers.suffix(4)) { item in
                HStack(spacing: 10) {
                    Image(systemName: item.failed ? "exclamationmark.circle" : item.done ? "checkmark.circle.fill" : icon(item.kind))
                        .foregroundStyle(item.failed ? Color.red : item.done ? Color.green : Color.accentColor)
                    VStack(alignment: .leading, spacing: 3) {
                        Text(item.name).font(.footnote).lineLimit(1)
                        if !item.done, !item.waiting, item.kind != .rotate { ProgressView(value: item.fraction) }
                    }
                    Text(item.failed ? "Failed" : item.done ? "Done" : item.waiting ? (offline ? "Waiting" : "Queued") : item.kind == .rotate ? "" : "\(Int(item.fraction * 100))%")
                        .font(.caption.monospacedDigit()).foregroundStyle(.secondary).frame(minWidth: 36, alignment: .trailing)
                    if let queuedId = item.queuedId {
                        Button { Task { await BackgroundTransfers.shared.cancel(queuedId) } } label: { Image(systemName: "xmark").font(.caption.weight(.semibold)) }
                            .buttonStyle(.plain).foregroundStyle(.secondary).accessibilityLabel("Cancel \(item.name)")
                    }
                }
            }
        }
        .padding(14)
        .frame(maxWidth: 360)
        .glassEffect(.regular, in: .rect(cornerRadius: 16))
        .padding(.horizontal)
    }

    private func icon(_ kind: DriveStore.TransferItem.Kind) -> String {
        switch kind {
        case .upload: return "arrow.up.circle"
        case .download, .keep: return "arrow.down.circle"
        case .copy: return "doc.on.doc"
        case .rotate: return "key"
        }
    }
}

/* "Moved 2 items to trash · Undo", for a few seconds, above the tab bar. */
struct NoticeBar: View {
    let notice: DriveStore.Notice
    let dismiss: () -> Void

    var body: some View {
        HStack(spacing: 12) {
            Text(notice.text).font(.subheadline).lineLimit(2)
            Spacer(minLength: 8)
            if let undo = notice.undo {
                Button("Undo") { dismiss(); undo() }.font(.subheadline.weight(.semibold))
            }
        }
        .padding(.horizontal, 16).padding(.vertical, 12)
        .frame(maxWidth: 360)
        .glassEffect(.regular, in: .capsule)
        .padding(.horizontal)
        .transition(.move(edge: .bottom).combined(with: .opacity))
    }
}
