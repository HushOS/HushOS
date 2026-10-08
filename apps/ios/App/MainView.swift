import HushOSKit
import SwiftUI
import UIKit

/*
 * Home, Files, Shared and Account, then search as its own tab (the iOS 26 search
 * role, drawn apart at the end of the bar as the board has it). Account stays a tab
 * (the user's call over the board's avatar) and keeps Trash. Links that open the app
 * land here: the right tab, then the folder, file, share or page they name.
 */
enum MainTab: Hashable { case home, files, shared, account, search }

struct MainView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.scenePhase) private var scenePhase
    @State private var store: DriveStore?
    @State private var tab: MainTab = .home
    @State private var showingTransfers = false
    @State private var makingRoom = false
    @State private var searchQuery = ""
    @State private var webOnly = false

    /* The background queue's records and this session's transfers, as rows. */
    private func rows(_ store: DriveStore) -> [TransferRowModel] {
        TransferRowModel.rows(queued: BackgroundTransfers.shared.records, foreground: store.transfers)
    }

    /* Transfers sit in the tab bar's accessory, like a player's now playing: one line, the list a tap away. */
    @ViewBuilder private func withTransfersAccessory(_ store: DriveStore, _ tabs: some View) -> some View {
        if #available(iOS 26.1, *) {
            let transfers = rows(store)
            tabs.tabViewBottomAccessory(isEnabled: !transfers.isEmpty) {
                Button { showingTransfers = true } label: { TransfersAccessoryBar(rows: transfers, offline: store.offline) }
                    .buttonStyle(.plain)
            }
        } else {
            // iOS 26.0 cannot hide the accessory: the same line floats in the same place.
            tabs.overlay(alignment: .bottom) {
                let transfers = rows(store)
                if !transfers.isEmpty {
                    Button { showingTransfers = true } label: { TransfersAccessoryBar(rows: transfers, offline: store.offline) }
                        .buttonStyle(.plain).frame(height: 48)
                        .glassEffect(.regular.interactive(), in: .capsule)
                        .padding(.horizontal, Alpine.Space.s4).padding(.bottom, 76)
                }
            }
        }
    }

    var body: some View {
        Group {
            if let store {
                withTransfersAccessory(store, TabView(selection: $tab) {
                    Tab("Home", systemImage: "house", value: MainTab.home) {
                        HomeView().environment(store)
                    }
                    Tab("Files", systemImage: "folder", value: MainTab.files) {
                        BrowseView().environment(store)
                    }
                    Tab("Shared", systemImage: "person.2", value: MainTab.shared) {
                        SharedView().environment(store)
                    }
                    Tab("Account", systemImage: "person.crop.circle", value: MainTab.account) {
                        AccountView().environment(store)
                    }
                    Tab(value: MainTab.search, role: .search) {
                        SearchView(query: $searchQuery).environment(store)
                    }
                }
                .tabViewSearchActivation(.searchTabSelection))
                .tabBarMinimizeBehavior(.onScrollDown)
                .sheet(isPresented: $showingTransfers) {
                    TransfersSheet(
                        rows: rows(store), offline: store.offline,
                        retry: { row in
                            if let id = row.queuedId { BackgroundTransfers.shared.retry(id) } else if let id = row.foregroundId { store.retry(id) }
                        },
                        remove: { row in
                            if let id = row.queuedId { BackgroundTransfers.shared.dismiss(id) } else if let id = row.foregroundId { store.dismiss(id) }
                            for id in row.queuedIds { BackgroundTransfers.shared.dismiss(id) }
                        },
                        cancel: { targets in
                            for row in targets {
                                if let id = row.queuedId { await BackgroundTransfers.shared.cancel(id) }
                                for id in row.queuedIds { await BackgroundTransfers.shared.cancel(id) }
                            }
                        },
                        clearFinished: { store.closeTransfers() },
                        makeRoom: { showingTransfers = false; makingRoom = true }
                    )
                }
                // Something that lets transfers finish in the background is off: said once, when a transfer starts.
                .sheet(isPresented: Binding(get: { BackgroundAccess.shared.asking }, set: { if !$0 { BackgroundAccess.shared.asking = false } })) {
                    BackgroundAccessSheet()
                }
                .sheet(isPresented: $makingRoom) { StorageFullSheet(rows: rows(store)).environment(store).environment(model) }
                .fileViewer(Binding(get: { store.deepFile }, set: { store.deepFile = $0 }), among: store.deepSiblings, store: store)
                // Notices sit above the tab bar, and above the transfers bar while it shows.
                .onChange(of: rows(store).isEmpty, initial: true) { _, empty in NoticeCenter.shared.bottom = empty ? 76 : 124 }
                // While the app is on screen the lists follow the server; in the background nothing polls.
                .task(id: scenePhase) {
                    // Back from Settings: the Account lines read the settings again.
                    if scenePhase == .active { BackgroundAccess.shared.version += 1; await BackgroundAccess.shared.readNotifications() }
                    if scenePhase == .active { await store.liveSync() }
                }
                // Anything that routes (a link, Info's Folder row) brings its tab forward.
                .onChange(of: store.route) { _, link in
                    switch link {
                    case .home: tab = .home; store.route = nil
                    case .files, .node: tab = .files
                    case .shared, .share, .incompleteShare: tab = .shared
                    case .trash: tab = .account
                    // The reset link never routes here: AppModel.open sends it to the reset screen.
                    case .recover, nil: break
                    }
                }
                // A tap on a transfers notification: the list for a failure, else where the files are.
                .onChange(of: TransferNotices.shared.opening, initial: true) { _, target in
                    guard let target else { return }
                    switch target {
                    case .transfers: TransferNotices.shared.opening = nil; showingTransfers = true
                    case let .folder(id): TransferNotices.shared.opening = nil; store.route = .files(folder: id, preview: nil)
                    // Home pushes On this phone and clears it.
                    case .phone: tab = .home
                    }
                }
                // A Home Screen quick action (signed out, it waited for sign-in): Search, or the + menu's
                // action in the folder last added to, or Files when that folder is gone.
                .onChange(of: QuickActions.shared.pending, initial: true) { _, action in
                    guard let action else { return }
                    QuickActions.shared.pending = nil
                    if action == .search { tab = .search; return }
                    Task {
                        guard let root = await store.loadRoot() else { return }
                        var folder = Places.last()?.id
                        if let id = folder, id != root, await store.lookUp(id)?.isFolder != true {
                            Places.forget()
                            folder = nil
                        }
                        store.pendingAdd = .init(folder: folder ?? root, action: action)
                        store.route = .files(folder: folder == root ? nil : folder, preview: nil)
                    }
                }
                .onChange(of: model.pendingLink, initial: true) { _, url in
                    guard let url else { return }
                    model.pendingLink = nil
                    Task { await route(url, store: store) }
                }
                .alert("You’ve been signed out", isPresented: Binding(get: { store.error == DriveStore.sessionEnded }, set: { if !$0 { store.error = nil } })) {
                    Button("Sign in") {
                        store.error = nil
                        model.sessionLost()
                    }
                } message: {
                    Text("Your session ended, perhaps because your password was changed on another device. Sign in again to carry on.")
                }
                .alert("That page is only on the web.", isPresented: $webOnly) {
                    Button("OK", role: .cancel) {}
                }
                .alert("That didn’t work", isPresented: Binding(get: { store.error != nil && store.error != DriveStore.sessionEnded }, set: { if !$0 { store.error = nil } })) {
                    Button("OK") { store.error = nil }
                } message: {
                    Text(store.error ?? "")
                }
            } else {
                ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity).background(Alpine.ground)
            }
        }
        // A new vault (a sign-in again after Change password or Reset sharing keys ended the old session)
        // replaces the store's in place: the old one's session is dead and its keys may be too.
        .task(id: model.vault.map(ObjectIdentifier.init)) {
            guard let vault = model.vault else { return }
            if let store { await store.adopt(vault) } else { store = DriveStore(vault: vault) }
        }
    }

    /* A link, once signed in: the tab it belongs to, then the place inside it. */
    private func route(_ url: URL, store: DriveStore) async {
        switch AppLinks.parse(url, server: model.origin) {
        case .success(let link):
            // The tab follows the route (below); the tab's view picks the rest up once it is on screen.
            store.route = link
        case .failure(.otherServer(let host)):
            store.notify("This link is for another HushOS server (\(host)). Sign in to that server to open it.")
        case .failure(.webOnly):
            // Billing, pricing, the operator console, the website: said, never opened from here, so the
            // app holds no way to a page that sells plans (App Review 3.1.3(f)). Android says the same.
            webOnly = true
        case .failure(.malformed):
            store.notify("This link doesn’t look right. Ask for a new one.")
        case .failure(.unsupported):
            break
        }
    }
}
