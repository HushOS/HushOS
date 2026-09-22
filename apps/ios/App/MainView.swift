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
                    if let transfer = store.transfer {
                        TransferBanner(transfer: transfer).padding(.bottom, 64)
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

struct TransferBanner: View {
    let transfer: DriveStore.Transfer

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(transfer.title).font(.footnote.weight(.medium)).lineLimit(1)
            ProgressView(value: transfer.fraction)
        }
        .padding(12)
        .frame(maxWidth: 360)
        .glassEffect(.regular, in: .rect(cornerRadius: 16))
        .padding(.horizontal)
    }
}
