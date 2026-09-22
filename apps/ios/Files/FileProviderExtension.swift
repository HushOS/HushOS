import FileProvider
import HushOSKit
import UniformTypeIdentifiers
import os

private let log = Logger(subsystem: "com.hushos.app.files", category: "extension")

/*
 * HushOS in the Files app. The session and the remembered device come from the
 * shared keychain; every key is opened in the Rust core; content is fetched by
 * chunk and decrypted here, and uploaded the same way. Folders, renames, moves
 * and the trash go through the Drive API with envelopes sealed here.
 */
final class FileProviderExtension: NSObject, NSFileProviderReplicatedExtension, NSFileProviderThumbnailing {
    private let domain: NSFileProviderDomain
    private var vault: Vault?

    required init(domain: NSFileProviderDomain) {
        self.domain = domain
        vault = Vault.fromKeychain()
        super.init()
    }

    func invalidate() {}

    static func translate(_ error: Error) -> Error {
        log.error("\(String(describing: error), privacy: .public)")
        switch error {
        case DriveAPIError.notAuthenticated:
            return NSFileProviderError(.notAuthenticated)
        case DriveAPIError.transport:
            return NSFileProviderError(.serverUnreachable)
        case is CancellationError:
            return CocoaError(.userCancelled)
        case let failure as CoreError:
            // Files accepts only Cocoa and FileProvider errors; the message survives in userInfo.
            return CocoaError(.fileReadCorruptFile, userInfo: [NSLocalizedDescriptionKey: failure.localizedDescription])
        case DriveAPIError.notFound(let message):
            // Only a node the server no longer has is "no such item"; Files removes those locally.
            return message == "This item no longer exists."
                ? NSFileProviderError(.noSuchItem)
                : CocoaError(.fileReadUnknown, userInfo: [NSLocalizedDescriptionKey: message])
        case DriveAPIError.server(_, let message):
            return CocoaError(.fileReadUnknown, userInfo: [NSLocalizedDescriptionKey: message])
        default:
            return CocoaError(.fileReadUnknown, userInfo: [NSLocalizedDescriptionKey: error.localizedDescription])
        }
    }

    /* The session in the keychain wins: a sign-in from the Files sheet or the app replaces a vault built on the old token. */
    private func requireVault() throws -> Vault {
        let session = SharedKeychain.session
        if let vault, let session, vault.api.session == session { return vault }
        guard session != nil, let fresh = Vault.fromKeychain() else {
            vault = nil
            throw NSFileProviderError(.notAuthenticated)
        }
        vault = fresh
        return fresh
    }

    func item(for identifier: NSFileProviderItemIdentifier, request: NSFileProviderRequest,
              completionHandler: @escaping (NSFileProviderItem?, Error?) -> Void) -> Progress {
        let progress = Progress(totalUnitCount: 1)
        if identifier == .trashContainer {
            completionHandler(ContainerItem(.trashContainer, name: "Trash"), nil)
            progress.completedUnitCount = 1
            return progress
        }
        if identifier == .workingSet {
            completionHandler(nil, NSFileProviderError(.noSuchItem))
            progress.completedUnitCount = 1
            return progress
        }
        Task {
            do {
                let vault = try requireVault()
                let rootId = try await vault.rootId()
                let opened: Opened
                if identifier == .rootContainer {
                    _ = try await vault.listChildren(of: rootId)
                    guard let rootItem = await vault.item(rootId) else { throw NSFileProviderError(.noSuchItem) }
                    opened = rootItem
                } else {
                    opened = try await vault.resolve(identifier.rawValue)
                }
                completionHandler(FileProviderItem(opened, rootId: rootId), nil)
            } catch {
                completionHandler(nil, Self.translate(error))
            }
            progress.completedUnitCount = 1
        }
        return progress
    }

    func fetchContents(for itemIdentifier: NSFileProviderItemIdentifier, version requestedVersion: NSFileProviderItemVersion?,
                       request: NSFileProviderRequest,
                       completionHandler: @escaping (URL?, NSFileProviderItem?, Error?) -> Void) -> Progress {
        let progress = Progress(totalUnitCount: 100)
        let task = Task {
            do {
                let vault = try requireVault()
                let rootId = try await vault.rootId()
                // Decrypted into the extension's own temporary directory; Files moves it into place.
                let directory = FileManager.default.temporaryDirectory.appendingPathComponent("downloads", isDirectory: true)
                try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
                let file = directory.appendingPathComponent(UUID().uuidString)
                try await vault.download(itemIdentifier.rawValue, to: file) { fraction in
                    progress.completedUnitCount = Int64(fraction * 100)
                }
                let opened = try await vault.resolve(itemIdentifier.rawValue)
                completionHandler(file, FileProviderItem(opened, rootId: rootId), nil)
            } catch {
                completionHandler(nil, nil, Self.translate(error))
            }
        }
        progress.cancellationHandler = { task.cancel() }
        return progress
    }

    private func parentNodeId(_ identifier: NSFileProviderItemIdentifier, vault: Vault) async throws -> String {
        identifier == .rootContainer ? try await vault.rootId() : identifier.rawValue
    }

    /* A folder or a file from Files: a sealed folder node, or an encrypted upload. */
    func createItem(basedOn itemTemplate: NSFileProviderItem, fields: NSFileProviderItemFields, contents url: URL?,
                    options: NSFileProviderCreateItemOptions = [], request: NSFileProviderRequest,
                    completionHandler: @escaping (NSFileProviderItem?, NSFileProviderItemFields, Bool, Error?) -> Void) -> Progress {
        let progress = Progress(totalUnitCount: 100)
        let task = Task {
            do {
                let vault = try requireVault()
                let rootId = try await vault.rootId()
                let parentId = try await parentNodeId(itemTemplate.parentItemIdentifier, vault: vault)
                let created: Opened
                if itemTemplate.contentType == .folder {
                    created = try await vault.createFolder(in: parentId, name: itemTemplate.filename)
                } else {
                    guard let url else { throw CocoaError(.featureUnsupported) }
                    let mime = itemTemplate.contentType?.preferredMIMEType
                    created = try await vault.upload(
                        fileURL: url, name: itemTemplate.filename, mime: mime, in: parentId, replacing: nil,
                        thumbnail: Thumbnails.make(for: url, mime: mime)
                    ) { fraction in progress.completedUnitCount = Int64(fraction * 100) }
                }
                completionHandler(FileProviderItem(created, rootId: rootId), [], false, nil)
            } catch {
                completionHandler(nil, [], false, Self.translate(error))
            }
        }
        progress.cancellationHandler = { task.cancel() }
        return progress
    }

    /* Rename, move, trash (a move into the trash container) or new contents. */
    func modifyItem(_ item: NSFileProviderItem, baseVersion version: NSFileProviderItemVersion,
                    changedFields: NSFileProviderItemFields, contents newContents: URL?,
                    options: NSFileProviderModifyItemOptions = [], request: NSFileProviderRequest,
                    completionHandler: @escaping (NSFileProviderItem?, NSFileProviderItemFields, Bool, Error?) -> Void) -> Progress {
        let progress = Progress(totalUnitCount: 100)
        let task = Task {
            do {
                let vault = try requireVault()
                let rootId = try await vault.rootId()
                let nodeId = item.itemIdentifier.rawValue
                var current = try await vault.resolve(nodeId)
                var remaining = changedFields
                if changedFields.contains(.parentItemIdentifier) {
                    if item.parentItemIdentifier == .trashContainer {
                        try await vault.trash(nodeId)
                        completionHandler(nil, [], false, nil)
                        return
                    }
                    let parentId = try await parentNodeId(item.parentItemIdentifier, vault: vault)
                    current = try await vault.move(nodeId, to: parentId)
                    remaining.remove(.parentItemIdentifier)
                }
                if changedFields.contains(.filename) {
                    current = try await vault.rename(nodeId, to: item.filename)
                    remaining.remove(.filename)
                }
                if changedFields.contains(.contents), let newContents {
                    let mime = current.metadata.mime
                    current = try await vault.upload(
                        fileURL: newContents, name: current.name, mime: mime, in: current.node.parentId ?? rootId,
                        replacing: current, thumbnail: Thumbnails.make(for: newContents, mime: mime)
                    ) { fraction in progress.completedUnitCount = Int64(fraction * 100) }
                    remaining.remove(.contents)
                }
                // Dates and other fields have no home in the sealed metadata yet; they are acknowledged, not stored.
                remaining.remove(.contentModificationDate)
                remaining.remove(.creationDate)
                remaining.remove(.lastUsedDate)
                remaining.remove(.tagData)
                remaining.remove(.favoriteRank)
                remaining.remove(.extendedAttributes)
                completionHandler(FileProviderItem(current, rootId: rootId), remaining, false, nil)
            } catch {
                completionHandler(nil, [], false, Self.translate(error))
            }
        }
        progress.cancellationHandler = { task.cancel() }
        return progress
    }

    /* Deleting from Files puts the item in the HushOS trash; nothing is purged from here. */
    func deleteItem(identifier: NSFileProviderItemIdentifier, baseVersion version: NSFileProviderItemVersion,
                    options: NSFileProviderDeleteItemOptions = [], request: NSFileProviderRequest,
                    completionHandler: @escaping (Error?) -> Void) -> Progress {
        let progress = Progress(totalUnitCount: 1)
        Task {
            do {
                let vault = try requireVault()
                try await vault.trash(identifier.rawValue)
                completionHandler(nil)
            } catch {
                completionHandler(Self.translate(error))
            }
            progress.completedUnitCount = 1
        }
        return progress
    }

    func fetchThumbnails(for itemIdentifiers: [NSFileProviderItemIdentifier], requestedSize size: CGSize,
                         perThumbnailCompletionHandler: @escaping (NSFileProviderItemIdentifier, Data?, Error?) -> Void,
                         completionHandler: @escaping (Error?) -> Void) -> Progress {
        let progress = Progress(totalUnitCount: Int64(itemIdentifiers.count))
        Task {
            do {
                let vault = try requireVault()
                for identifier in itemIdentifiers {
                    do {
                        let data = try await vault.thumbnail(identifier.rawValue)
                        perThumbnailCompletionHandler(identifier, data, nil)
                    } catch {
                        perThumbnailCompletionHandler(identifier, nil, Self.translate(error))
                    }
                    progress.completedUnitCount += 1
                }
                completionHandler(nil)
            } catch {
                completionHandler(Self.translate(error))
            }
        }
        return progress
    }

    func enumerator(for containerItemIdentifier: NSFileProviderItemIdentifier,
                    request: NSFileProviderRequest) throws -> NSFileProviderEnumerator {
        let vault = try requireVault()
        return FileProviderEnumerator(container: containerItemIdentifier, vault: vault)
    }
}
