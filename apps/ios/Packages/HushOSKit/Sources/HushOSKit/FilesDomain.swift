import Foundation
#if canImport(FileProvider)
import FileProvider

/* The HushOS location in the Files app: one replicated domain, added at sign-in and removed at sign-out. */
public enum FilesDomain {
    public static let identifier = NSFileProviderDomainIdentifier("com.hushos.app.drive")

    /*
     * A new domain on iOS starts disabled until the person turns it on in
     * Files (Browse, the ... menu, Edit). Simulator debug builds skip that step
     * through the testing mode, which needs the testing-mode entitlement the
     * app carries. An existing domain is kept; only a stranger's is removed.
     */
    public static func register() async {
        let domain = NSFileProviderDomain(identifier: identifier, displayName: "HushOS")
        #if DEBUG && targetEnvironment(simulator)
        domain.testingModes = .alwaysEnabled
        #endif
        // Keep an existing domain: removing it would drop Files' cache and every "Keep Downloaded" mark.
        let existing = (try? await NSFileProviderManager.domains()) ?? []
        if existing.contains(where: { $0.identifier == identifier }) {
            signal()
            return
        }
        for stale in existing { try? await NSFileProviderManager.remove(stale) }
        try? await NSFileProviderManager.add(domain)
        signal()
    }

    public static func remove() async {
        try? await NSFileProviderManager.remove(NSFileProviderDomain(identifier: identifier, displayName: "HushOS"))
    }

    /* Tells Files something changed; it re-enumerates through the change feed. */
    public static func signal(folderId: String? = nil) {
        let domain = NSFileProviderDomain(identifier: identifier, displayName: "HushOS")
        guard let manager = NSFileProviderManager(for: domain) else { return }
        manager.signalEnumerator(for: .workingSet) { _ in }
        manager.signalEnumerator(for: .rootContainer) { _ in }
        if let folderId { manager.signalEnumerator(for: NSFileProviderItemIdentifier(folderId)) { _ in } }
    }
}
#endif
