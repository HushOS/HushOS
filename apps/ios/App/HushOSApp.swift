import UIKit
import HushOSKit
import SwiftUI

@main
struct HushOSApp: App {
    @UIApplicationDelegateAdaptor(AppDelegate.self) private var delegate
    @Environment(\.scenePhase) private var scenePhase
    @State private var model = AppModel()

    init() {
        // Before launch finishes, or iOS will not run it.
        BackgroundTransfers.registerTask()
        // Before launch finishes, so a tap on a transfers notification that launched the app arrives.
        TransferNotices.shared.start()
        Theme.configureAppearance()
    }

    var body: some Scene {
        WindowGroup {
            RootView()
                .environment(model)
                .tint(Alpine.primary)
        }
        .onChange(of: scenePhase) { _, phase in
            // Leaving the screen with something still unsealed: ask iOS for time with a network to start it.
            if phase == .background { BackgroundTransfers.shared.scheduleIfWaiting() }
            if phase == .active { Task { await BackgroundTransfers.shared.pump() } }
        }
    }
}

/* The gate: a session shows the drive, none shows sign-in, a deleted account says so. */
struct RootView: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        Group {
            switch model.state {
            case .checking:
                ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity).background(Alpine.ground)
            case .signedOut:
                SignInView()
            case .signedIn:
                MainView()
            case .deleted:
                AccountDeletedView()
            }
        }
        .task {
            #if DEBUG
            // scripts/site-phone-shots.sh launches with -HushOSOpenLink <url>: a link from simctl openurl
            // makes iOS ask "Open in HushOS?" first, and that alert lands in the picture.
            if let link = UserDefaults.standard.string(forKey: "HushOSOpenLink").flatMap(URL.init(string:)) { model.open(link) }
            #endif
            await model.start()
        }
        .fullScreenCover(isPresented: Binding(get: { model.recovering }, set: { if !$0 { model.recoveryDone() } })) { RecoveryView() }
        // hushos:// links, and https links when the system hands them over as a URL.
        .onOpenURL { url in model.open(url) }
        // Universal links: https://<server>/s/…, /app, /app/drive…, /app/shared…, /app/trash….
        .onContinueUserActivity(NSUserActivityTypeBrowsingWeb) { activity in
            if let url = activity.webpageURL { model.open(url) }
        }
        // Notices go in their own window, above any sheet that is open.
        .onAppear { NoticeWindow.install() }
    }
}

/* What the person sees after deleting their account, in the web's words, instead of dropping silently to sign-in. */
struct AccountDeletedView: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        VStack(alignment: .leading, spacing: Alpine.Space.s3) {
            Spacer()
            Text("Your account is deleted").font(Theme.Text.titleLarge).foregroundStyle(Alpine.ink).accessibilityAddTraits(.isHeader)
            Text("Your files, shares, links and account are gone from HushOS. This can’t be undone.")
                .font(.body).foregroundStyle(Alpine.inkMuted)
            Spacer()
            Button { model.leaveDeleted() } label: { Text("Done").frame(maxWidth: .infinity) }
                .buttonStyle(PrimaryCapsuleStyle())
        }
        .padding(.horizontal, Alpine.Space.s8).padding(.bottom, Alpine.Space.s8)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .leading)
        .background(Alpine.ground)
    }
}

/* What SwiftUI has no hook for: iOS relaunching the app to hand over background transfer events, and quick actions. */
final class AppDelegate: NSObject, UIApplicationDelegate {
    func application(_ application: UIApplication, configurationForConnecting session: UISceneSession, options: UIScene.ConnectionOptions)
        -> UISceneConfiguration {
        let configuration = UISceneConfiguration(name: nil, sessionRole: session.role)
        configuration.delegateClass = SceneDelegate.self
        return configuration
    }

    func application(_ application: UIApplication, handleEventsForBackgroundURLSession identifier: String, completionHandler: @escaping () -> Void) {
        guard identifier == BackgroundTransfers.sessionIdentifier || identifier == ShareHandoff.sessionIdentifier else { return completionHandler() }
        MainActor.assumeIsolated {
            // Touching the shared instance reconnects the app's session (Save to HushOS's on request); the relay then receives the events.
            BackgroundTransfers.shared.eventsHandled[identifier] = completionHandler
            if identifier == ShareHandoff.sessionIdentifier { BackgroundTransfers.shared.connectShare() }
        }
    }
}
