import HushOSKit
import SwiftUI

/*
 * Home, Files, Shared and Account, as the cloud drives lay themselves out on a
 * phone: what changed, the tree, what others gave you, and you. Search sits on
 * Home and Files; the trash lives under Account.
 */
struct MainView: View {
    @Environment(AppModel.self) private var model
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
                    if !store.transfers.isEmpty {
                        TransferPanel(transfers: store.transfers).padding(.bottom, 64)
                    }
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

    private var headline: String {
        let running = transfers.filter { !$0.done }
        if running.isEmpty { return transfers.contains(where: \.failed) ? "Some transfers failed" : "Done" }
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
                        if !item.done, item.kind != .rotate { ProgressView(value: item.fraction) }
                    }
                    Text(item.failed ? "Failed" : item.done ? "Done" : item.kind == .rotate ? "" : "\(Int(item.fraction * 100))%")
                        .font(.caption.monospacedDigit()).foregroundStyle(.secondary).frame(minWidth: 36, alignment: .trailing)
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
