import FileProvider
import HushOSKit
import UniformTypeIdentifiers

/* The system containers Files asks about by name: the trash, empty until trash syncing exists. */
final class ContainerItem: NSObject, NSFileProviderItem {
    let itemIdentifier: NSFileProviderItemIdentifier
    let filename: String

    init(_ identifier: NSFileProviderItemIdentifier, name: String) {
        itemIdentifier = identifier
        filename = name
    }

    var parentItemIdentifier: NSFileProviderItemIdentifier { .rootContainer }
    var contentType: UTType { .folder }
    var capabilities: NSFileProviderItemCapabilities { [.allowsReading, .allowsContentEnumerating] }
    var itemVersion: NSFileProviderItemVersion {
        NSFileProviderItemVersion(contentVersion: Data(), metadataVersion: Data())
    }
}
