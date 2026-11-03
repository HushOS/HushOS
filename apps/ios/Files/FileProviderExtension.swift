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
    /*
     * Every call goes through the gate: the session must belong to the account this location was
     * added for (FilesDomainOwner), or nothing is listed, read or sent, and a location still
     * holding another account's pending folders and files is refused until the app replaces it.
     */
    private let gate = FilesGate<Vault>(
        owner: { FilesDomainOwner.shared.read() },
        session: { SharedKeychain.session },
        changed: { owner in
            TemporaryCopies.claim(owner)
            // Someone is signed in again (from the Files sheet or the app): the next refusal may ask again.
            if owner != nil { SignInPrompt.reset() }
        },
        make: { Vault(api: DriveAPI(session: $0), session: $0) }
    )

    /* The family this location is for (FamilyFileIds); nil for the drive's. */
    let family: String?

    /*
     * A family location's way to its family: the session must be the account its record names
     * (another's, or nobody: `.notAuthenticated`), and the family is that session's vault's own sync
     * in this process (one vault per session, so the ledger and the syncs take turns per family).
     */
    private lazy var familyGate: FilesGate<FamilyFilesSource>? = family.map { groupId in
        FilesGate<FamilyFilesSource>(
            owner: { (try? FamilyDomainRecords.shared.read())?[groupId]?.owner },
            session: { SharedKeychain.session },
            changed: { owner in
                TemporaryCopies.claim(owner)
                if owner != nil { SignInPrompt.reset() }
            },
            make: { session in
                let vault = Vault.shared(for: session)
                guard let sync = FamilySync.shared(for: vault) else { return nil }
                return FamilyFilesSource(groupId: groupId, vault: vault, sync: sync)
            }
        )
    }

    /*
     * Every call of a family location: its record first. A family let go of (no record) is gone
     * from this location whoever is signed in, without asking the server; then the gate.
     */
    func requireFamily() throws -> FamilyFilesSource {
        guard let family, let familyGate else { throw NSFileProviderError(.noSuchItem) }
        switch FamilyDomainRecords.shared.admission(family, owner: SharedKeychain.session.map(AccountOwner.init)) {
        case .letGo: throw FamilyFilesError.letGo
        case .unreadable: throw GuardError.unreadable
        case .admitted, .otherAccount: break
        }
        return try familyGate.open()
    }

    /* The family location's name, as its record keeps it. */
    private var familyName: String {
        family.flatMap { (try? FamilyDomainRecords.shared.read())?[$0]?.name } ?? domain.displayName
    }

    required init(domain: NSFileProviderDomain) {
        self.domain = domain
        family = FamilyFileIds.group(ofDomain: domain.identifier.rawValue)
        Unbacked.apply()
        // Copies of family folders no record names any more (let go of while this process was away) go before anything is answered.
        FamilyFilesDomains.shared.sweepUnrecorded()
        // Decrypted downloads (and partials) Files never took, older than a day.
        TemporaryCopies.sweep()
        super.init()
    }

    /*
     * Called as the system lets this instance go, a sign-out's removal of the location included.
     * Signed out (no session left), this process's temporary folder goes: Files' decrypted
     * downloads not moved into place and the record of whose they are, which nothing else can
     * reach (the app can't open this extension's container).
     */
    func invalidate() {
        if SharedKeychain.session == nil { TemporaryCopies.claim(nil) }
        // A family location removed (or any let go of meanwhile): its copies in this process go with it.
        FamilyFilesDomains.shared.sweepUnrecorded()
    }

    static func translate(_ error: Error, domain: NSFileProviderDomainIdentifier = FilesDomain.identifier) -> Error {
        // An error's text can carry decrypted names and paths: only its type is public.
        log.error("\(String(describing: type(of: error)), privacy: .public) \(String(describing: error), privacy: .private)")
        switch error {
        case let refused as NSFileProviderError:
            // The gate's refusal (signed out, or another account's location) reaches Files as it is.
            if refused.code == .notAuthenticated { SignInPrompt.ask(domain) }
            return refused
        case DriveAPIError.notAuthenticated where !endsSession(error, current: SharedKeychain.session):
            // A late 401 of a session no longer stored (signed in again meanwhile): nothing to sign in to; Files tries again.
            return NSFileProviderError(.cannotSynchronize)
        case DriveAPIError.notAuthenticated:
            SignInPrompt.ask(domain)
            return NSFileProviderError(.notAuthenticated)
        case DriveAPIError.transport:
            return NSFileProviderError(.serverUnreachable)
        case is CancellationError:
            return CocoaError(.userCancelled)
        case let failure as CoreError:
            // Files accepts only Cocoa and FileProvider errors; the core's sentence survives in userInfo, never its type's description.
            return CocoaError(.fileReadCorruptFile, userInfo: [NSLocalizedDescriptionKey: ErrorWords.say(failure) ?? ErrorWords.generic])
        case DriveAPIError.notFound(let message):
            // Only a node the server no longer has is "no such item"; Files removes those locally.
            return message == "This item no longer exists."
                ? NSFileProviderError(.noSuchItem)
                : CocoaError(.fileReadUnknown, userInfo: [NSLocalizedDescriptionKey: message])
        case DriveAPIError.trashed:
            // Files shows no HushOS trash, so an item trashed elsewhere (or under a trashed folder) is gone
            // from this location: saying so lets Files drop it instead of keeping a copy it can't sync.
            return NSFileProviderError(.noSuchItem)
        case DriveAPIError.server(_, let message):
            return CocoaError(.fileReadUnknown, userInfo: [NSLocalizedDescriptionKey: message])
        default:
            // Files shows this text: HushOS's own words, or plain ones, never the error's own description.
            return CocoaError(.fileReadUnknown, userInfo: [NSLocalizedDescriptionKey: ErrorWords.say(error) ?? ErrorWords.generic])
        }
    }

    /*
     * The session in the keychain wins: a sign-in from the Files sheet or the app, or a new
     * session after a password change or key reset, replaces a vault built on the old token.
     * Signed out, or another account in: refused, and the files this extension decrypted for
     * the last one go (TemporaryCopies.claim), so Files never answers from an account that has
     * left the phone and never sends one account's pending changes under another's session.
     */
    private func requireVault() throws -> Vault {
        try gate.open()
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
        if family != nil {
            Task {
                do {
                    completionHandler(try await familyItem(identifier, source: try requireFamily(), name: familyName), nil)
                } catch {
                    completionHandler(nil, FamilyErrors.translate(error, domain: self.domain.identifier))
                }
                progress.completedUnitCount = 1
            }
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
        if family != nil {
            let task = Task {
                do {
                    let (file, item) = try await familyContents(itemIdentifier, source: try requireFamily(), progress: progress)
                    completionHandler(file, item, nil)
                } catch {
                    completionHandler(nil, nil, FamilyErrors.translate(error, domain: self.domain.identifier))
                }
            }
            progress.cancellationHandler = { task.cancel() }
            return progress
        }
        let task = Task {
            do {
                // The vault first (opening may claim this folder for the account), then the copy's gate, kept to that
                // vault's session: an account change after it writes nothing, and the claim itself never refuses this download.
                let vault = try self.gate.open()
                let copyGate = vault.copyGate(familyWorkspace: nil)
                let rootId = try await vault.rootId()
                // Decrypted into the extension's own temporary directory; Files moves it into place. The path is the
                // item's and its version's, so when Files asks again after a failure the partial is continued, not orphaned.
                let item = try await vault.resolve(itemIdentifier.rawValue)
                let directory = FileManager.default.temporaryDirectory
                    .appendingPathComponent("downloads/\(item.id)/\(item.node.currentVersion?.id ?? "none")", isDirectory: true)
                try copyGate.perform { try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true) }
                let file = directory.appendingPathComponent("content")
                try await vault.download(itemIdentifier.rawValue, to: file, gate: copyGate) { fraction in
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
        if family != nil {
            // A family location is read only: nothing is made in it from Files.
            completionHandler(nil, [], false, CocoaError(.fileWriteNoPermission))
            return progress
        }
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
        if family != nil {
            // Read only: contents, a name or a place are refused, and nothing is sent. What Files changes on its own when a
            // file is opened (last used, tags, ranks, attributes) is acknowledged without being stored, as the drive does,
            // or every opened file would wait to sync for ever.
            guard changedFields.isDisjoint(with: [.contents, .filename, .parentItemIdentifier]) else {
                completionHandler(nil, [], false, CocoaError(.fileWriteNoPermission))
                return progress
            }
            Task {
                do {
                    let current = try await familyItem(item.itemIdentifier, source: try requireFamily(), name: familyName)
                    completionHandler(current, [], false, nil)
                } catch {
                    completionHandler(nil, [], false, FamilyErrors.translate(error, domain: self.domain.identifier))
                }
                progress.completedUnitCount = 100
            }
            return progress
        }
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
                    do {
                        current = try await vault.upload(
                            fileURL: newContents, name: current.name, mime: mime, in: current.node.parentId ?? rootId,
                            replacing: current, thumbnail: Thumbnails.make(for: newContents, mime: mime)
                        ) { fraction in progress.completedUnitCount = Int64(fraction * 100) }
                    } catch is UploadLanded {
                        // The new version is on the server; only its row couldn't be looked up here. Answered as done, never an
                        // error, so Files doesn't send the same contents again as another version. The next enumeration shows it.
                    }
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
        if family != nil {
            completionHandler(NSFileProviderError(.deletionRejected))
            progress.completedUnitCount = 1
            return progress
        }
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
        if family != nil {
            Task {
                do {
                    let source = try requireFamily()
                    for identifier in itemIdentifiers {
                        do {
                            guard let ref = FamilyFileIds.ref(identifier.rawValue) else { throw FamilyFilesError.notInFamily }
                            perThumbnailCompletionHandler(identifier, try await source.thumbnail(ref), nil)
                        } catch {
                            perThumbnailCompletionHandler(identifier, nil, FamilyErrors.translate(error, domain: self.domain.identifier))
                        }
                        progress.completedUnitCount += 1
                    }
                    completionHandler(nil)
                } catch {
                    completionHandler(FamilyErrors.translate(error, domain: self.domain.identifier))
                }
            }
            return progress
        }
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
        if family != nil {
            do { _ = try requireFamily() } catch { throw FamilyErrors.translate(error, domain: self.domain.identifier) }
            return FamilyEnumerator(container: containerItemIdentifier, domain: domain.identifier) { [weak self] in
                guard let self else { throw NSFileProviderError(.noSuchItem) }
                return try self.requireFamily()
            }
        }
        _ = try requireVault()
        return FileProviderEnumerator(container: containerItemIdentifier, gate: gate)
    }
}

/*
 * Files offers the Sign in sheet (FileProviderUIController) only when listing a location fails
 * with `.notAuthenticated`. A replicated location lists from what it cached, so a session that
 * ended showed only a dead-end "You need to authenticate" alert when a file was opened. The first
 * refusal asks Files for the working set's changes, which fail the same way and put the location
 * into its signed-out state, where Files offers the sheet; once is enough until someone signs in.
 */
enum SignInPrompt {
    /* The location `domain` (the drive's, or a family's) asks, once until someone signs in. */
    static func ask(_ domain: NSFileProviderDomainIdentifier = FilesDomain.identifier) {
        guard SignInAsks.shared.first(domain.rawValue),
              let manager = NSFileProviderManager(for: NSFileProviderDomain(identifier: domain, displayName: "HushOS")) else { return }
        manager.signalEnumerator(for: .workingSet) { _ in }
    }

    static func reset() { SignInAsks.shared.reset() }
}
