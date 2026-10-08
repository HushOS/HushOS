import HushOSKit
import Observation
import UIKit

/*
 * Home Screen quick actions, as Android's launcher shortcuts: Upload files, Upload photos,
 * New folder and Search, in that order (declared in project.yml, so they show before the
 * first launch). Each opens the folder last added to (or Files) and runs the + menu's own
 * action there; Search opens the Search tab. Signed out, the action waits here and runs
 * once signed in. Cold launches hand it over in the scene's connection options, warm ones
 * through the scene delegate.
 */
enum QuickAction: String {
    case uploadFiles = "com.hushos.app.upload-files"
    case uploadPhotos = "com.hushos.app.upload-photos"
    case newFolder = "com.hushos.app.new-folder"
    case search = "com.hushos.app.search"
}

@MainActor
@Observable
final class QuickActions {
    static let shared = QuickActions()
    /* Waiting for the drive (a cold launch, or sign-in) to act on. */
    var pending: QuickAction?
}

/* Only so a quick action reaches the app: SwiftUI has no hook for it. */
final class SceneDelegate: NSObject, UIWindowSceneDelegate {
    func scene(_ scene: UIScene, willConnectTo session: UISceneSession, options connectionOptions: UIScene.ConnectionOptions) {
        guard let item = connectionOptions.shortcutItem else { return }
        MainActor.assumeIsolated { QuickActions.shared.pending = QuickAction(rawValue: item.type) }
    }

    func windowScene(_ windowScene: UIWindowScene, performActionFor shortcutItem: UIApplicationShortcutItem) async -> Bool {
        guard let action = QuickAction(rawValue: shortcutItem.type) else { return false }
        await MainActor.run { QuickActions.shared.pending = action }
        return true
    }
}
