import FileProvider
import HushOSKit
import os

private let log = Logger(subsystem: "com.hushos.app.files", category: "enumerator")

final class FileProviderEnumerator: NSObject, NSFileProviderEnumerator {
    private let container: NSFileProviderItemIdentifier
    private let vault: Vault

    init(container: NSFileProviderItemIdentifier, vault: Vault) {
        self.container = container
        self.vault = vault
        super.init()
    }

    func invalidate() {}

    func enumerateItems(for observer: NSFileProviderEnumerationObserver, startingAt page: NSFileProviderPage) {
        Task {
            do {
                let rootId = try await vault.rootId()
                if container == .workingSet || container == .trashContainer {
                    observer.finishEnumerating(upTo: nil)
                    return
                }
                let folderId = container == .rootContainer ? rootId : container.rawValue
                let listing = try await vault.listChildren(of: folderId)
                var items: [FileProviderItem] = []
                for child in listing.children {
                    if let opened = await vault.item(child.id) { items.append(FileProviderItem(opened, rootId: rootId)) }
                }
                log.notice("container \(self.container.rawValue, privacy: .public): \(listing.children.count) children, \(items.count) items")
                observer.didEnumerate(items)
                observer.finishEnumerating(upTo: nil)
            } catch {
                log.error("container \(self.container.rawValue, privacy: .public) failed: \(String(describing: error), privacy: .public)")
                observer.finishEnumeratingWithError(FileProviderExtension.translate(error))
            }
        }
    }

    /* The Drive's change feed: the anchor is the change sequence Files has seen. */
    func enumerateChanges(for observer: NSFileProviderChangeObserver, from anchor: NSFileProviderSyncAnchor) {
        let since = Int(String(data: anchor.rawValue, encoding: .utf8) ?? "0") ?? 0
        Task {
            do {
                let rootId = try await vault.rootId()
                guard let changes = try await vault.changes(since: since) else {
                    observer.finishEnumeratingWithError(NSFileProviderError(.syncAnchorExpired))
                    return
                }
                if !changes.updated.isEmpty { observer.didUpdate(changes.updated.map { FileProviderItem($0, rootId: rootId) }) }
                if !changes.deleted.isEmpty { observer.didDeleteItems(withIdentifiers: changes.deleted.map { NSFileProviderItemIdentifier($0) }) }
                log.notice("changes since \(since): \(changes.updated.count) updated, \(changes.deleted.count) deleted, next \(changes.nextCursor)")
                observer.finishEnumeratingChanges(upTo: NSFileProviderSyncAnchor(String(changes.nextCursor).data(using: .utf8)!), moreComing: changes.hasMore)
            } catch {
                observer.finishEnumeratingWithError(FileProviderExtension.translate(error))
            }
        }
    }

    func currentSyncAnchor(completionHandler: @escaping (NSFileProviderSyncAnchor?) -> Void) {
        Task {
            let seq = (try? await vault.loadWorkspace().changeSeq) ?? 0
            completionHandler(NSFileProviderSyncAnchor(String(seq ?? 0).data(using: .utf8)!))
        }
    }
}
