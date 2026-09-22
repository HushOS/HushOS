import HushOSKit
import SwiftUI

@main
struct HushOSApp: App {
    @State private var model = AppModel()

    var body: some Scene {
        WindowGroup {
            RootView()
                .environment(model)
                .tint(Color.accentColor)
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
