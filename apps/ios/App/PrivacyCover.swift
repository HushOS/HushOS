import SwiftUI
import UIKit

/*
 * What the app switcher shows: a plain cover over everything, sheets included, from the
 * moment the app stops being active, so its snapshot never holds a file name, a link or
 * the recovery phrase. Its own window above sheets and notices; it also covers the app
 * while Control Center or a system prompt is over it, which is the price of covering in
 * time for the snapshot.
 */
@MainActor
enum PrivacyCover {
    private static var window: UIWindow?

    static func show(in scene: UIWindowScene) {
        if window == nil {
            let window = UIWindow(windowScene: scene)
            window.rootViewController = UIHostingController(rootView: Alpine.ground.ignoresSafeArea())
            // Above the notices window (.alert + 1).
            window.windowLevel = .alert + 2
            window.accessibilityElementsHidden = true
            self.window = window
        }
        window?.isHidden = false
    }

    static func hide() { window?.isHidden = true }
}

/*
 * Whether the screen is being recorded, mirrored or AirPlayed. The recovery phrase is not
 * drawn then: a recording outlives the moment, and a mirrored screen is someone else's.
 */
@MainActor @Observable
final class ScreenCapture {
    static let shared = ScreenCapture()
    private(set) var active = false
    private var observer: NSObjectProtocol?

    private init() {
        refresh()
        observer = NotificationCenter.default.addObserver(forName: UIScreen.capturedDidChangeNotification, object: nil, queue: .main) { _ in
            MainActor.assumeIsolated { ScreenCapture.shared.refresh() }
        }
    }

    func refresh() {
        active = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.contains { $0.screen.isCaptured }
    }
}
