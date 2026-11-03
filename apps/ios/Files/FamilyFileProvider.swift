import FileProvider
import HushOSKit
import UniformTypeIdentifiers
import os

private let log = Logger(subsystem: "com.hushos.app.files", category: "family")

/*
 * A family's location in Files (docs/groups-mobile-plan.md, iOS 6), read only: the family's
 * folders at the top, then each folder's contents. Every item is named by its workspace and node
 * (FamilyFileIds), never by node alone, and every call goes through `FamilyFilesSource`, which
 * checks the location's record before anything this process holds.
 */
final class FamilyItem: NSObject, NSFileProviderItem {
    let itemIdentifier: NSFileProviderItemIdentifier
    let parentItemIdentifier: NSFileProviderItemIdentifier
    let filename: String
    let contentType: UTType
    let documentSize: NSNumber?
    let contentModificationDate: Date?
    let creationDate: Date?
    let itemVersion: NSFileProviderItemVersion
    private let folder: Bool

    /* A row of one of the family's folders; its folder's top node sits at the location's top level. */
    init(_ opened: Opened) {
        let ref = opened.ref
        itemIdentifier = NSFileProviderItemIdentifier(FamilyFileIds.item(ref))
        parentItemIdentifier = opened.node.parentId.map { NSFileProviderItemIdentifier(FamilyFileIds.item(NodeRef(workspaceId: ref.workspaceId, nodeId: $0))) } ?? .rootContainer
        filename = opened.metadata.name
        folder = opened.node.kind == "folder"
        if folder {
            contentType = .folder
        } else if let mime = opened.metadata.mime, let type = UTType(mimeType: mime) {
            contentType = type
        } else {
            contentType = UTType(filenameExtension: (opened.metadata.name as NSString).pathExtension) ?? .data
        }
        documentSize = opened.size.map { NSNumber(value: $0) }
        contentModificationDate = opened.modified
        creationDate = parseDate(opened.node.createdAt)
        itemVersion = NSFileProviderItemVersion(contentVersion: Data((opened.node.currentVersion?.id ?? "none").utf8),
                                                metadataVersion: Data("\(opened.node.metadataVersion)".utf8))
    }

    /* One of the family's folders before its top node was opened here: its name as the family page shows it. */
    init?(_ area: FamilyArea) {
        guard let root = area.root, let name = area.name else { return nil }
        itemIdentifier = NSFileProviderItemIdentifier(FamilyFileIds.item(root.ref))
        parentItemIdentifier = .rootContainer
        filename = name
        folder = true
        contentType = .folder
        documentSize = nil
        contentModificationDate = parseDate(root.updatedAt)
        creationDate = parseDate(root.createdAt)
        itemVersion = NSFileProviderItemVersion(contentVersion: Data("none".utf8), metadataVersion: Data("\(root.metadataVersion)".utf8))
    }

    /*
     * Read only: nothing is written into a family folder from Files (`createItem` and `modifyItem`
     * refuse, and nothing is sent). The items still declare adding and writing: an item without them
     * is made read only on disk, and Files then fails to put it in place at all ("cannotSetMetadata",
     * EPERM, every item, seen on the simulator), leaving the folders empty.
     */
    var capabilities: NSFileProviderItemCapabilities {
        folder ? [.allowsReading, .allowsContentEnumerating, .allowsAddingSubItems, .allowsEvicting] : [.allowsReading, .allowsWriting, .allowsEvicting]
    }
}

/* The location itself: the family, named as it is. */
final class FamilyContainerItem: NSObject, NSFileProviderItem {
    let filename: String
    init(name: String) { filename = name }
    var itemIdentifier: NSFileProviderItemIdentifier { .rootContainer }
    var parentItemIdentifier: NSFileProviderItemIdentifier { .rootContainer }
    var contentType: UTType { .folder }
    var capabilities: NSFileProviderItemCapabilities { [.allowsReading, .allowsContentEnumerating, .allowsAddingSubItems] }
    var itemVersion: NSFileProviderItemVersion { NSFileProviderItemVersion(contentVersion: Data(), metadataVersion: Data(filename.utf8)) }
}

/* A family location's errors as Files takes them. */
enum FamilyErrors {
    static func translate(_ error: Error, domain: NSFileProviderDomainIdentifier) -> Error {
        log.error("family call refused: \(String(describing: type(of: error)), privacy: .public) \(String(describing: error), privacy: .private)")
        switch error {
        case FamilyFilesError.letGo, FamilyFilesError.notInFamily:
            // Gone from this account's families (or never one of them): Files drops what it holds of it. Nothing here is
            // unsynced, the location being read only.
            return NSFileProviderError(.noSuchItem)
        case FamilyFilesError.otherAccount, FamilyFilesError.signedOut:
            return FileProviderExtension.translate(NSFileProviderError(.notAuthenticated), domain: domain)
        case FamilyFilesError.unavailable, FamilyFilesError.keyChange:
            // Asked again later, with nothing of what Files holds dropped.
            return NSFileProviderError(.serverUnreachable)
        case let failure as GroupsAPIError where failure.status == 0:
            return NSFileProviderError(.serverUnreachable)
        case let failure as LocalizedError where failure.errorDescription == FamilyWords.noAnswer:
            // No answer from the server: Files asks again, and keeps what it holds.
            return NSFileProviderError(.serverUnreachable)
        default:
            return FileProviderExtension.translate(error, domain: domain)
        }
    }
}

/* A family location's listings and its change feed: each pass through the location's gate again. */
final class FamilyEnumerator: NSObject, NSFileProviderEnumerator {
    private let container: NSFileProviderItemIdentifier
    private let domain: NSFileProviderDomainIdentifier
    private let source: () throws -> FamilyFilesSource

    init(container: NSFileProviderItemIdentifier, domain: NSFileProviderDomainIdentifier, source: @escaping () throws -> FamilyFilesSource) {
        self.container = container
        self.domain = domain
        self.source = source
        super.init()
    }

    func invalidate() {}

    func enumerateItems(for observer: NSFileProviderEnumerationObserver, startingAt page: NSFileProviderPage) {
        Task {
            do {
                let source = try self.source()
                if container == .workingSet || container == .trashContainer {
                    _ = try await source.admitted()
                    observer.finishEnumerating(upTo: nil)
                    return
                }
                var items: [NSFileProviderItem] = []
                if container == .rootContainer {
                    items = try await source.folders().compactMap { FamilyItem($0) }
                } else {
                    guard let ref = FamilyFileIds.ref(container.rawValue) else { throw FamilyFilesError.notInFamily }
                    items = try await source.children(of: ref).map { FamilyItem($0) }
                }
                log.notice("family container \(self.container == .rootContainer ? "root" : "folder", privacy: .public): \(items.count) items")
                observer.didEnumerate(items)
                observer.finishEnumerating(upTo: nil)
            } catch {
                log.error("family container failed: \(String(describing: type(of: error)), privacy: .public) \(String(describing: error), privacy: .private)")
                observer.finishEnumeratingWithError(FamilyErrors.translate(error, domain: self.domain))
            }
        }
    }

    func enumerateChanges(for observer: NSFileProviderChangeObserver, from anchor: NSFileProviderSyncAnchor) {
        Task {
            do {
                let source = try self.source()
                guard let held = try? JSONDecoder().decode(FamilyAnchor.self, from: anchor.rawValue),
                      let changes = try await source.changes(since: held) else {
                    observer.finishEnumeratingWithError(NSFileProviderError(.syncAnchorExpired))
                    return
                }
                if !changes.deleted.isEmpty { observer.didDeleteItems(withIdentifiers: changes.deleted.map { NSFileProviderItemIdentifier($0) }) }
                let updated: [NSFileProviderItem] = changes.added.compactMap { FamilyItem($0) } + changes.updated.map { FamilyItem($0) }
                if !updated.isEmpty { observer.didUpdate(updated) }
                observer.finishEnumeratingChanges(upTo: NSFileProviderSyncAnchor(try JSONEncoder().encode(changes.next)), moreComing: changes.hasMore)
            } catch {
                log.error("family changes failed: \(String(describing: type(of: error)), privacy: .public) \(String(describing: error), privacy: .private)")
                observer.finishEnumeratingWithError(FamilyErrors.translate(error, domain: self.domain))
            }
        }
    }

    func currentSyncAnchor(completionHandler: @escaping (NSFileProviderSyncAnchor?) -> Void) {
        Task {
            guard let source = try? self.source(), let anchor = try? await source.anchor(), let data = try? JSONEncoder().encode(anchor) else {
                completionHandler(nil)
                return
            }
            completionHandler(NSFileProviderSyncAnchor(data))
        }
    }
}

extension FileProviderExtension {
    func familyItem(_ identifier: NSFileProviderItemIdentifier, source: FamilyFilesSource, name: String) async throws -> NSFileProviderItem {
        if identifier == .rootContainer {
            _ = try await source.admitted()
            return FamilyContainerItem(name: name)
        }
        guard let ref = FamilyFileIds.ref(identifier.rawValue) else { throw FamilyFilesError.notInFamily }
        return FamilyItem(try await source.item(ref))
    }

    /*
     * A family file's current version, decrypted where a revocation's forget reaches it (the
     * process's `opened/family/<workspace>`), and handed to Files only while the location stands.
     */
    func familyContents(_ identifier: NSFileProviderItemIdentifier, source: FamilyFilesSource, progress: Progress) async throws -> (URL, NSFileProviderItem) {
        guard let ref = FamilyFileIds.ref(identifier.rawValue) else { throw FamilyFilesError.notInFamily }
        let (file, opened) = try await source.download(ref) { fraction in progress.completedUnitCount = Int64(fraction * 100) }
        return (file, FamilyItem(opened))
    }
}
