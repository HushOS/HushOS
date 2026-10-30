#if DEBUG
import HushOSKit
import SwiftUI
import UIKit

/*
 * Debug builds only (the whole file is compiled out of Release): `-HushOSForceRegular`
 * on the launch line lays the app's window out at iPhone Duo's inner display size,
 * 669 × 951 points (951 × 669 when the screen is on its side), with regular width and
 * height, and scales it down to fit whatever screen it runs on. It exists so the
 * inner display's layout can be captured on a simulator whose fold can only be moved
 * from Device Hub. It is not the inner display: the safe area, the vertical bar strip
 * and the system's own placement of bars come from the real screen, so check those on
 * a real pose. Sheets present inside the same window and see the same traits; the
 * notices and privacy windows are separate and stay at the screen's size.
 */
enum InnerDisplayHarness {
    static var enabled: Bool { ProcessInfo.processInfo.arguments.contains("-HushOSForceRegular") }
    static let portrait = CGSize(width: 669, height: 951)

    /* The screen's safe area, read once while the window still covers the screen untransformed. */
    @MainActor private static var screenSafeArea: UIEdgeInsets?

    @MainActor static func apply(to window: UIWindow) {
        guard enabled, let scene = window.windowScene else { return }
        let screen = scene.effectiveGeometry.coordinateSpace.bounds
        let size = screen.width > screen.height ? CGSize(width: portrait.height, height: portrait.width) : portrait
        // Already laid out this way: setting it again would lay the window out again, forever.
        guard window.bounds.size != size || window.traitOverrides.horizontalSizeClass != .regular else { return }
        if screenSafeArea == nil, window.transform.isIdentity { screenSafeArea = window.safeAreaInsets }
        // Fitted inside the outer display's safe area, so its bar strip and sensor housing stay out of the picture.
        let room = screen.inset(by: screenSafeArea ?? .zero)
        let scale = min(room.width / size.width, room.height / size.height)
        window.traitOverrides.horizontalSizeClass = .regular
        window.traitOverrides.verticalSizeClass = .regular
        window.transform = .identity
        window.bounds = CGRect(origin: .zero, size: size)
        window.transform = CGAffineTransform(scaleX: scale, y: scale)
        window.center = CGPoint(x: room.midX, y: room.midY)
    }
}

/* Finds the window the app is drawn in and hands it to the harness, again if the system resizes it (a turn of the screen). */
struct InnerDisplayHarnessHook: UIViewRepresentable {
    func makeUIView(context: Context) -> HookView { HookView() }
    func updateUIView(_ view: HookView, context: Context) {}

    final class HookView: UIView {
        override func didMoveToWindow() {
            super.didMoveToWindow()
            if let window { InnerDisplayHarness.apply(to: window) }
        }

        override func layoutSubviews() {
            super.layoutSubviews()
            if let window { InnerDisplayHarness.apply(to: window) }
        }
    }
}

/* Evidence runs only: launch arguments that open a screen without taps, the same on main and the branch. */
@MainActor
enum DebugStart {
    static var tab: MainTab? {
        switch UserDefaults.standard.string(forKey: "HushOSTab") {
        case "files": .files
        case "shared": .shared
        case "account": .account
        case "search": .search
        default: nil
        }
    }

    static var people: Bool { UserDefaults.standard.bool(forKey: "HushOSPeople") }

    static func item(in items: [Opened]) -> NodeAction? {
        if let id = UserDefaults.standard.string(forKey: "HushOSInfo"), let item = items.first(where: { $0.id == id }) { return .info(item) }
        if let id = UserDefaults.standard.string(forKey: "HushOSShare"), let item = items.first(where: { $0.id == id }) { return .share(item) }
        return nil
    }
}
#endif
