import SwiftUI
import UIKit

/*
 * The tab sidebar's own switch, for what SwiftUI's TabView has no modifier for: folding the
 * sidebar away while Info sits beside the list and bringing it back after (SidebarAroundInfo).
 * The sidebar is UIKit's (`UITabBarController.sidebar`); this finds the tab bar controller in
 * the window the view is in, never in another scene.
 */
@MainActor
final class TabSidebar {
    private weak var controller: UITabBarController?

    /* Whether the sidebar is showing; nil when there is no sidebar to show (a tab bar). */
    var shown: Bool? {
        guard let controller, controller.mode == .tabSidebar else { return nil }
        return !controller.sidebar.isHidden
    }

    func show(_ visible: Bool) {
        guard let controller, controller.mode == .tabSidebar else { return }
        controller.sidebar.isHidden = !visible
    }

    fileprivate func find(in window: UIWindow?) {
        func search(_ vc: UIViewController?) -> UITabBarController? {
            guard let vc else { return nil }
            if let tabs = vc as? UITabBarController { return tabs }
            for child in vc.children { if let found = search(child) { return found } }
            return nil
        }
        controller = search(window?.rootViewController)
    }
}

/* Placed behind the tabs: hands TabSidebar the window they are in once it is on screen. */
struct TabSidebarFinder: UIViewRepresentable {
    let sidebar: TabSidebar

    func makeUIView(context: Context) -> FinderView { FinderView(sidebar: sidebar) }
    func updateUIView(_ view: FinderView, context: Context) { sidebar.find(in: view.window) }

    final class FinderView: UIView {
        let sidebar: TabSidebar

        init(sidebar: TabSidebar) {
            self.sidebar = sidebar
            super.init(frame: .zero)
            isUserInteractionEnabled = false
        }

        required init?(coder: NSCoder) { nil }

        override func didMoveToWindow() {
            super.didMoveToWindow()
            sidebar.find(in: window)
        }
    }
}
