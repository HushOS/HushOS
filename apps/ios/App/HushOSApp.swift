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
    }

    var body: some Scene {
        WindowGroup {
            RootView()
                .environment(model)
                .tint(Color.accentColor)
        }
        .onChange(of: scenePhase) { _, phase in
            // Leaving the screen with something still unsealed: ask iOS for time with a network to start it.
            if phase == .background { BackgroundTransfers.shared.scheduleIfWaiting() }
            if phase == .active { Task { await BackgroundTransfers.shared.pump() } }
        }
    }
}

/* The gate: a session shows the drive, none shows the sign-in sheet. */
struct RootView: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        Group {
            switch model.state {
            case .checking:
                ProgressView()
            case .signedOut:
                SignInView()
            case .signedIn:
                MainView()
            }
        }
        .task { await model.start() }
        .onOpenURL { url in model.open(url) }
    }
}

/* The one app-delegate duty SwiftUI has no hook for: iOS relaunching the app to hand over background transfer events. */
final class AppDelegate: NSObject, UIApplicationDelegate {
    func application(_ application: UIApplication, handleEventsForBackgroundURLSession identifier: String, completionHandler: @escaping () -> Void) {
        guard identifier == BackgroundTransfers.sessionIdentifier else { return completionHandler() }
        MainActor.assumeIsolated {
            // Touching the shared instance reconnects the session; its delegate then receives the events.
            BackgroundTransfers.shared.eventsHandled = completionHandler
        }
    }
}
