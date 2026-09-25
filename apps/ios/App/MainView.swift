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
    // Here rather than in the panel, which goes and comes back as transfers do.
    @State private var transfersCollapsed = false
    @State private var showingTransfers = false

    /* The background queue's records and this session's transfers, as rows. */
    private func allTransfers(_ store: DriveStore) -> [DriveStore.TransferItem] {
        let queued = BackgroundTransfers.shared.records.map { record in
            DriveStore.TransferItem(
                kind: record.kind == .upload ? .upload : .keep, name: record.name,
                fraction: BackgroundTransfers.shared.fraction(of: record),
                done: record.state == .done || record.state == .failed, failed: record.state == .failed,
                waiting: record.state == .waiting, queuedId: record.state == .done ? nil : record.id,
                message: record.state == .failed ? record.message ?? "The transfer failed." : nil,
                canRetry: BackgroundTransfers.shared.canRetry(record)
            )
        }
        return queued + store.transfers
    }

    /* Transfers sit in the tab bar's accessory, like a player's now playing: one line, the list a tap away. From iOS 26.1, which can hide it. */
    @ViewBuilder private func withTransfersAccessory(_ store: DriveStore, _ tabs: some View) -> some View {
        if #available(iOS 26.1, *) {
            let transfers = allTransfers(store)
            tabs.tabViewBottomAccessory(isEnabled: !transfers.isEmpty) {
                Button { showingTransfers = true } label: { TransfersAccessoryBar(transfers: transfers, offline: store.offline) }
                    .buttonStyle(.plain)
            }
        } else {
            tabs
        }
    }

    private func accessoryShown(_ store: DriveStore) -> Bool {
        if #available(iOS 26.1, *) { return !allTransfers(store).isEmpty }
        return false
    }

    private func dismissTransfer(_ store: DriveStore, _ item: DriveStore.TransferItem) {
        if let queuedId = item.queuedId { BackgroundTransfers.shared.dismiss(queuedId) } else { store.dismiss(item.id) }
    }

    private func retryTransfer(_ store: DriveStore, _ item: DriveStore.TransferItem) {
        if let queuedId = item.queuedId { BackgroundTransfers.shared.retry(queuedId) } else { store.retry(item.id) }
    }

    var body: some View {
        Group {
            if let store {
                withTransfersAccessory(store, TabView {
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
                })
                .tabBarMinimizeBehavior(.onScrollDown)
                // The accessory's list, a tap away.
                .sheet(isPresented: $showingTransfers) {
                    TransfersSheet(
                        transfers: allTransfers(store), offline: store.offline,
                        dismiss: { dismissTransfer(store, $0) }, retry: { retryTransfer(store, $0) },
                        close: { store.closeTransfers() }
                    )
                }
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
                        if let notice = store.notice { NoticeBar(notice: notice, dismiss: { store.notice = nil }) }
                        // iOS 26.0 has no way to hide the accessory, so there the panel floats as before.
                        if #unavailable(iOS 26.1), !allTransfers(store).isEmpty {
                            TransferPanel(
                                transfers: allTransfers(store), offline: store.offline,
                                dismiss: { dismissTransfer(store, $0) }, retry: { retryTransfer(store, $0) },
                                close: { store.closeTransfers() },
                                collapsed: $transfersCollapsed
                            )
                        }
                    }
                    // Above the tab bar, and above the transfers accessory while it shows.
                    .padding(.bottom, accessoryShown(store) ? 124 : 76)
                    // A new batch after the panel has closed starts unfolded, as the web's does.
                    .onChange(of: store.transfers.isEmpty && BackgroundTransfers.shared.records.isEmpty) { _, empty in
                        if empty { transfersCollapsed = false }
                    }
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

/*
 * Every transfer with its own bar, the way the web's panel shows them: name, progress, and how it ended.
 * Failures come first, since they are why the panel is still up; past about four rows the list scrolls.
 * Once nothing is running, the header's cross closes it. Folded, it keeps the header and one bar for the lot.
 * A failed upload that kept its file offers a retry, and the header retries them all at once.
 */
struct TransferPanel: View {
    let transfers: [DriveStore.TransferItem]
    var offline = false
    var dismiss: (DriveStore.TransferItem) -> Void = { _ in }
    var retry: (DriveStore.TransferItem) -> Void = { _ in }
    var close: () -> Void = {}
    @Binding var collapsed: Bool
    @State private var rowsHeight: CGFloat = 0

    private var headline: String { TransferSummary.headline(transfers, offline: offline) }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                Text(headline).font(.subheadline.weight(.semibold))
                Spacer()
                let done = transfers.filter(\.done).count
                if transfers.count > 1 { Text("\(done) of \(transfers.count)").font(.footnote).foregroundStyle(.secondary) }
                let retryable = transfers.filter(\.canRetry)
                if transfers.allSatisfy(\.done), retryable.count > 1 {
                    Button { retryable.forEach(retry) } label: { Image(systemName: "arrow.clockwise").font(.caption.weight(.semibold)) }
                        .buttonStyle(.plain).foregroundStyle(.secondary).accessibilityLabel("Retry all failed")
                }
                Button { collapsed.toggle() } label: { Image(systemName: collapsed ? "chevron.up" : "chevron.down").font(.caption.weight(.semibold)) }
                    .buttonStyle(.plain).foregroundStyle(.secondary).accessibilityLabel(collapsed ? "Expand transfers" : "Collapse transfers")
                if transfers.allSatisfy(\.done) {
                    Button(action: close) { Image(systemName: "xmark").font(.caption.weight(.semibold)) }
                        .buttonStyle(.plain).foregroundStyle(.secondary).accessibilityLabel("Close transfers")
                }
            }
            let moving = transfers.filter { !$0.done && !$0.waiting && $0.kind != .rotate }
            if collapsed, !moving.isEmpty { ProgressView(value: moving.map(\.fraction).reduce(0, +) / Double(moving.count)) }
            if !collapsed {
                // As tall as the rows, up to about four of them; past that they scroll.
                ScrollView {
                    TransferRows(transfers: transfers, offline: offline, dismiss: dismiss, retry: retry)
                        .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { rowsHeight = $0 }
                }
                .frame(height: min(rowsHeight, 230))
                .scrollBounceBehavior(.basedOnSize)
            }
        }
        .padding(14)
        .frame(maxWidth: 360)
        .glassEffect(.regular, in: .rect(cornerRadius: 16))
        .padding(.horizontal)
    }
}

/* The transfers themselves, failures first, for the floating panel. */
struct TransferRows: View {
    let transfers: [DriveStore.TransferItem]
    var offline = false
    var dismiss: (DriveStore.TransferItem) -> Void = { _ in }
    var retry: (DriveStore.TransferItem) -> Void = { _ in }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            ForEach(TransferSummary.failuresFirst(transfers)) { item in
                TransferRow(item: item, offline: offline, dismiss: dismiss, retry: retry)
            }
        }
    }
}

/* One transfer: what it is, how far, how it ended and why, and what can be done about it. */
struct TransferRow: View {
    let item: DriveStore.TransferItem
    var offline = false
    var dismiss: (DriveStore.TransferItem) -> Void = { _ in }
    var retry: (DriveStore.TransferItem) -> Void = { _ in }
    /* The sheet's rows read at list size; the floating panel's stay small. */
    var prominent = false

    var body: some View {
        HStack(spacing: 10) {
            Image(systemName: item.failed ? "exclamationmark.circle" : item.done ? "checkmark.circle.fill" : icon(item.kind))
                .foregroundStyle(item.failed ? Color.red : item.done ? Color.green : Color.accentColor)
            VStack(alignment: .leading, spacing: 3) {
                Text(item.name).font(prominent ? .body : .footnote).lineLimit(1)
                if !item.done, !item.waiting, item.kind != .rotate { ProgressView(value: item.fraction) }
                // The reason, in the server's words where it refused: what to do next is in it.
                if let message = item.message { Text(message).font(prominent ? .subheadline : .caption).foregroundStyle(.red).lineLimit(3) }
            }
            Spacer(minLength: 0)
            Text(item.failed ? "Failed" : item.done ? "Done" : item.waiting ? (offline ? "Waiting" : "Queued") : item.kind == .rotate ? "" : "\(Int(item.fraction * 100))%")
                .font((prominent ? Font.footnote : Font.caption).monospacedDigit()).foregroundStyle(.secondary).frame(minWidth: 36, alignment: .trailing)
            if item.canRetry {
                Button { retry(item) } label: { Image(systemName: "arrow.clockwise").font(.caption.weight(.semibold)) }
                    .buttonStyle(.borderless).foregroundStyle(.secondary).accessibilityLabel("Retry \(item.name)")
            }
            if item.failed {
                Button { dismiss(item) } label: { Image(systemName: "xmark").font(.caption.weight(.semibold)) }
                    .buttonStyle(.borderless).foregroundStyle(.secondary).accessibilityLabel("Dismiss \(item.name)")
            } else if let queuedId = item.queuedId {
                Button { Task { await BackgroundTransfers.shared.cancel(queuedId) } } label: { Image(systemName: "xmark").font(.caption.weight(.semibold)) }
                    .buttonStyle(.borderless).foregroundStyle(.secondary).accessibilityLabel("Cancel \(item.name)")
            }
        }
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

/* What the transfers amount to, in a few words: the accessory's line, the panel's and the sheet's title. */
enum TransferSummary {
    /* Failures lead: they are why the list is still up. */
    static func failuresFirst(_ transfers: [DriveStore.TransferItem]) -> [DriveStore.TransferItem] {
        transfers.filter(\.failed) + transfers.filter { !$0.failed }
    }

    static func headline(_ transfers: [DriveStore.TransferItem], offline: Bool) -> String {
        let running = transfers.filter { !$0.done }
        if running.isEmpty { return transfers.contains(where: \.failed) ? "Some transfers failed" : "Done" }
        if running.allSatisfy(\.waiting) { return offline ? "Waiting for a network" : "Queued" }
        let uploads = running.filter { $0.kind == .upload }.count
        if uploads == running.count { return uploads == 1 ? "Uploading" : "Uploading \(uploads) files" }
        return running.count == 1 ? verb(running[0].kind) : "\(running.count) transfers"
    }

    private static func verb(_ kind: DriveStore.TransferItem.Kind) -> String {
        switch kind {
        case .upload: return "Uploading"
        case .download: return "Downloading"
        case .copy: return "Copying"
        case .keep: return "Keeping downloaded"
        case .rotate: return "Rotating keys"
        }
    }
}

/* One line: how it is going, and how far. Inline beside the folded tab bar it keeps only the words. */
struct TransfersAccessoryBar: View {
    let transfers: [DriveStore.TransferItem]
    let offline: Bool
    @Environment(\.tabViewBottomAccessoryPlacement) private var placement

    var body: some View {
        let running = transfers.filter { !$0.done }
        let failed = transfers.contains(where: \.failed)
        HStack(spacing: 10) {
            Image(systemName: failed && running.isEmpty ? "exclamationmark.circle.fill" : running.isEmpty ? "checkmark.circle.fill" : "arrow.up.arrow.down.circle")
                .foregroundStyle(failed && running.isEmpty ? Color.red : running.isEmpty ? Color.green : Color.accentColor)
            Text(TransferSummary.headline(transfers, offline: offline)).font(.subheadline.weight(.medium)).lineLimit(1)
            Spacer(minLength: 0)
            if placement != .inline, transfers.count > 1 {
                Text("\(transfers.filter(\.done).count) of \(transfers.count)").font(.footnote.monospacedDigit()).foregroundStyle(.secondary)
            }
        }
        .padding(.horizontal, 16)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .contentShape(.rect)
    }
}

/* Every transfer, a tap away from the accessory: retry, dismiss, or clear what has finished. */
private struct TransfersSheet: View {
    let transfers: [DriveStore.TransferItem]
    let offline: Bool
    let dismiss: (DriveStore.TransferItem) -> Void
    let retry: (DriveStore.TransferItem) -> Void
    let close: () -> Void
    @Environment(\.dismiss) private var dismissSheet

    var body: some View {
        let finished = !transfers.isEmpty && transfers.allSatisfy(\.done)
        let retryable = transfers.filter(\.canRetry)
        NavigationStack {
            List(TransferSummary.failuresFirst(transfers)) { item in
                TransferRow(item: item, offline: offline, dismiss: dismiss, retry: retry, prominent: true)
            }
            .navigationTitle(TransferSummary.headline(transfers, offline: offline))
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                if finished {
                    ToolbarItem(placement: .topBarLeading) {
                        Button("Clear") { close(); dismissSheet() }
                    }
                }
                if finished, retryable.count > 1 {
                    ToolbarItem(placement: .bottomBar) {
                        Button("Retry All") { retryable.forEach(retry) }
                    }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismissSheet() }
                }
            }
        }
        .presentationDetents([.medium, .large])
        .onChange(of: transfers.isEmpty) { _, empty in if empty { dismissSheet() } }
    }
}
