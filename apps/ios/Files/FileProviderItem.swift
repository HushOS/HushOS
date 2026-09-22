import FileProvider
import HushOSKit
import UniformTypeIdentifiers

/* A node as Files sees it: name, type, size and dates from the decrypted metadata. */
final class FileProviderItem: NSObject, NSFileProviderItem {
    private let opened: Opened
    private let rootId: String

    init(_ opened: Opened, rootId: String) {
        self.opened = opened
        self.rootId = rootId
    }

    var itemIdentifier: NSFileProviderItemIdentifier {
        opened.node.id == rootId ? .rootContainer : NSFileProviderItemIdentifier(opened.node.id)
    }

    var parentItemIdentifier: NSFileProviderItemIdentifier {
        guard opened.node.id != rootId, let parentId = opened.node.parentId, parentId != rootId else {
            return .rootContainer
        }
        return NSFileProviderItemIdentifier(parentId)
    }

    var filename: String { opened.node.id == rootId ? "HushOS" : opened.metadata.name }

    var contentType: UTType {
        if opened.node.kind == "folder" { return .folder }
        if let mime = opened.metadata.mime, let type = UTType(mimeType: mime) { return type }
        let ext = (opened.metadata.name as NSString).pathExtension
        return UTType(filenameExtension: ext) ?? .data
    }

    /* Everything Files can do with a node; the extension carries each out against the Drive API. */
    var capabilities: NSFileProviderItemCapabilities {
        // `allowsEvicting` is what lets Files offer "Remove Download" and, with pinning declared, "Keep Downloaded".
        opened.node.kind == "folder"
            ? [.allowsReading, .allowsContentEnumerating, .allowsAddingSubItems, .allowsRenaming, .allowsReparenting, .allowsTrashing, .allowsDeleting, .allowsEvicting]
            : [.allowsReading, .allowsWriting, .allowsRenaming, .allowsReparenting, .allowsTrashing, .allowsDeleting, .allowsEvicting]
    }

    var documentSize: NSNumber? { opened.size.map { NSNumber(value: $0) } }

    var contentModificationDate: Date? { opened.modified }

    var creationDate: Date? { parseDate(opened.node.createdAt) }

    var itemVersion: NSFileProviderItemVersion {
        NSFileProviderItemVersion(
            contentVersion: (opened.node.currentVersion?.id ?? "none").data(using: .utf8)!,
            metadataVersion: "\(opened.node.metadataVersion)".data(using: .utf8)!
        )
    }

}
