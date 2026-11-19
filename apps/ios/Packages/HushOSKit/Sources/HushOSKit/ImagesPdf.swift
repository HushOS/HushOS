import Foundation
import HushOSCore
import ImageIO
import UniformTypeIdentifiers

/*
 * Convert, then One PDF (docs/file-tools-design.md, feature (b)), as the web makes it: the images
 * in the order chosen, a page each, built by the core's writer (`ImagesPdfWriter`), so a JPEG goes
 * in byte for byte with its location and camera details cut and its orientation turned on the
 * page. Anything else is decoded here with ImageIO, which reads HEIC: a PNG, or any image with
 * transparency, goes in as its pixels with a soft mask; the rest as JPEG at quality 92. The PDF
 * is saved as a new file beside the images, under the next free name, through the save path
 * (SaveRuns), signed as the weakest of them. The work is a tool run (ToolRuns): one at a time,
 * the watchdog over it, and a cancel at any point leaves nothing.
 */
public enum ImagesPdf {
    public static let limits = imagesPdfLimits()

    /* The most pixels one image may be decoded to here: a sixty-fourth of the device's memory, 16 to 100 megapixels. */
    public static var maxPixels: UInt64 { imagesPdfMaxPixels(deviceMemoryBytes: ProcessInfo.processInfo.physicalMemory) }

    public enum Stage: Equatable, Sendable { case fine, offer, ceiling }

    /* Fine, worth a word first past 64 MB (the large-file card), or more than one PDF takes. */
    public static func stage(count: Int, bytes: UInt64) -> Stage {
        if count > Int(limits.maxImages) || bytes > limits.maxInputBytes { return .ceiling }
        return bytes > limits.cardBytes ? .offer : .fine
    }

    private static let extensions: Set<String> = ["jpg", "jpeg", "jpe", "jfif", "png", "heic", "heif", "webp", "avif", "gif", "bmp"]
    private static let types: Set<String> = [
        "image/jpeg", "image/pjpeg", "image/png", "image/heic", "image/heif", "image/webp", "image/avif", "image/gif",
        "image/bmp", "image/x-ms-bmp",
    ]

    /* An image a PDF takes, by its recorded type or its name: as the web's `pdfable`. */
    public static func takes(_ item: Opened) -> Bool {
        guard !item.isFolder else { return false }
        if let mime = item.metadata.mime?.lowercased(), types.contains(mime) { return true }
        return extensions.contains((item.name as NSString).pathExtension.lowercased())
    }

    /* Images from more than one folder (search results can hold them): refused, never converted in part. */
    public static let mixedFolders = "These images are in different folders. Make a PDF from one folder at a time."

    /* Whether every image is in one folder of one workspace, where the PDF goes. */
    public static func oneFolder(_ images: [Opened]) -> Bool {
        guard let first = images.first else { return false }
        return images.allSatisfy { $0.node.parentId == first.node.parentId && $0.node.workspaceId == first.node.workspaceId }
    }

    /* The most one read asks of a version reader: the core refuses a read past 64 MiB. */
    public static let readPiece: UInt64 = 8 << 20

    /* A file's `size` bytes, read in pieces of at most `piece`, never in one read the core would refuse. */
    public static func readWhole(size: UInt64, piece: UInt64 = readPiece, read: (UInt64, UInt64) throws -> Data) throws -> Data {
        var out = Data(capacity: Int(size))
        var offset: UInt64 = 0
        while offset < size {
            let part = try read(offset, min(piece, size - offset))
            guard !part.isEmpty else { throw ImagesPdfRefused(toolFailedMessage()) }
            out.append(part)
            offset += UInt64(part.count)
        }
        return out
    }

    /* The first image's name with `.pdf` in place of its extension. */
    public static func pdfName(for first: String) -> String {
        let base = ((first as NSString).deletingPathExtension).trimmingCharacters(in: .whitespaces)
        return "\(base.isEmpty ? "Images" : base).pdf"
    }

    /* Letter in the US and Canada, A4 everywhere else. */
    public static func defaultSize(region: String? = Locale.current.region?.identifier) -> PageSize {
        region == "US" || region == "CA" ? .letter : .a4
    }

    /* The person's words for a refusal the work met, naming the image it met it at. */
    public static func words(code: String, name: String) -> String {
        switch code {
        case "unsupported": "“\(name)” is a kind of JPEG HushOS can’t put in a PDF."
        case "too-many-pixels": "“\(name)” is too large to put in a PDF on this device."
        case "too-large": "The PDF would be larger than 256 MB. Choose fewer images."
        default: "“\(name)” is damaged, or isn’t an image HushOS can put in a PDF."
        }
    }

    // MARK: Building

    /* What the work hands back: the PDF and a thumbnail of the first image. */
    public struct Made: Sendable {
        public let pdf: Data
        public let thumbnail: Data?
    }

    /*
     * A PDF's charge in the process's produced-plaintext budget (ToolRuns.budget): taken on the run's
     * thread, given back exactly once, after the save has the PDF or however the run ended (a Stop
     * that discards the result included), so no charge outlives its bytes.
     */
    final class Lease: @unchecked Sendable {
        private let lock = NSLock()
        private var held: (bytes: UInt64, generation: UInt64)?
        /* Once released it stays released: a charge taken after that is given back at once. */
        private var released = false
        private let giveBack: @Sendable (UInt64, UInt64) -> Void

        init(giveBack: @escaping @Sendable (UInt64, UInt64) -> Void = { ToolRuns.budget.release(bytes: $0, generation: $1) }) {
            self.giveBack = giveBack
        }

        func take(_ bytes: UInt64, _ generation: UInt64) {
            let late = lock.withLock { () -> Bool in
                if !released { held = (bytes, generation) }
                return released
            }
            if late { giveBack(bytes, generation) }
        }

        func release() {
            let charge = lock.withLock { () -> (bytes: UInt64, generation: UInt64)? in
                released = true
                defer { held = nil }
                return held
            }
            if let charge { giveBack(charge.bytes, charge.generation) }
        }
    }

    /* A refusal of one image (by its place in the order) or of the whole PDF, kept apart from ToolRuns, which turns errors into ToolFailed. */
    final class Refusal: @unchecked Sendable {
        private let lock = NSLock()
        private var held: ImagesPdfRefused?
        var value: ImagesPdfRefused? { lock.withLock { held } }
        func set(_ refused: ImagesPdfRefused) { lock.withLock { if held == nil { held = refused } } }
    }

    /*
     * The PDF from `count` images, read one at a time by `read` (blocking, on the run's thread):
     * synchronous, so a tool run's work can be it. Every core call is under `control`, which a
     * cancel or the watchdog ends.
     */
    public static func build(
        names: [String], size: PageSize, margin: Bool, maxPixels: UInt64, control: RunControl,
        read: (Int) throws -> Data, progress: (Int) -> Void = { _ in }
    ) throws -> Made {
        let writer = ImagesPdfWriter(size: size, margin: margin)
        var thumbnail: Data?
        for (index, name) in names.enumerated() {
            var bytes = try read(index)
            if index == 0 { thumbnail = ImagesPdfImages.thumbnail(bytes) }
            do {
                if ImagesPdfImages.isJpeg(bytes) {
                    try writer.addJpeg(bytes: bytes, control: control)
                } else {
                    switch try ImagesPdfImages.decode(bytes, maxPixels: maxPixels) {
                    case let .jpeg(encoded): try writer.addJpeg(bytes: encoded, control: control)
                    case let .pixels(rgba, width, height):
                        try writer.addPixels(rgba: rgba, width: width, height: height, premultiplied: true, control: control)
                    }
                }
            } catch ImagesPdfError.Refused(let code) {
                throw ImagesPdfRefused(words(code: code, name: name))
            } catch let refusal as ImagesPdfImages.Refused {
                throw ImagesPdfRefused(words(code: refusal.code, name: name))
            }
            bytes = Data()
            progress(index + 1)
        }
        do {
            return Made(pdf: try writer.finish(), thumbnail: thumbnail)
        } catch ImagesPdfError.Refused(let code) {
            throw ImagesPdfRefused(words(code: code, name: names.first ?? ""))
        }
    }
}

/* Why One PDF stopped before anything was made, in the person's words. */
public struct ImagesPdfRefused: Error, Equatable, WordedError {
    public let message: String
    public init(_ message: String) { self.message = message }
    public var errorDescription: String? { message }
}

// MARK: Decoding

/* ImageIO for the images a PDF can't take as they are: the step image conversion's module replaces on the web. */
public enum ImagesPdfImages {
    public struct Refused: Error { public let code: String }

    public enum Decoded {
        case jpeg(Data)
        /* RGBA, premultiplied (what a bitmap context draws), upright. */
        case pixels(Data, width: UInt32, height: UInt32)
    }

    public static func isJpeg(_ bytes: Data) -> Bool { bytes.starts(with: [0xFF, 0xD8, 0xFF]) }
    public static func isPng(_ bytes: Data) -> Bool { bytes.starts(with: [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]) }

    /*
     * Decoded upright (its orientation applied), refused past `maxPixels` before a pixel is made.
     * A PNG, or anything with a transparent pixel, comes back as pixels; the rest as JPEG at 92.
     */
    public static func decode(_ bytes: Data, maxPixels: UInt64) throws -> Decoded {
        guard let source = CGImageSourceCreateWithData(bytes as CFData, [kCGImageSourceShouldCache: false] as CFDictionary),
              CGImageSourceGetCount(source) > 0,
              let properties = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any],
              let width = properties[kCGImagePropertyPixelWidth] as? Int,
              let height = properties[kCGImagePropertyPixelHeight] as? Int, width > 0, height > 0
        else { throw Refused(code: "damaged") }
        if UInt64(width) * UInt64(height) > maxPixels { throw Refused(code: "too-many-pixels") }
        let options: [CFString: Any] = [
            kCGImageSourceCreateThumbnailFromImageAlways: true,
            kCGImageSourceThumbnailMaxPixelSize: max(width, height),
            kCGImageSourceCreateThumbnailWithTransform: true,
            kCGImageSourceShouldCacheImmediately: true,
        ]
        guard let image = CGImageSourceCreateThumbnailAtIndex(source, 0, options as CFDictionary) else {
            throw Refused(code: "damaged")
        }
        let alpha = image.alphaInfo
        let mayBeTransparent = !(alpha == .none || alpha == .noneSkipLast || alpha == .noneSkipFirst)
        if isPng(bytes) || mayBeTransparent {
            let (rgba, transparent) = try pixels(of: image)
            if isPng(bytes) || transparent {
                return .pixels(rgba, width: UInt32(image.width), height: UInt32(image.height))
            }
        }
        let out = NSMutableData()
        guard let destination = CGImageDestinationCreateWithData(out, UTType.jpeg.identifier as CFString, 1, nil) else {
            throw Refused(code: "damaged")
        }
        CGImageDestinationAddImage(destination, image, [kCGImageDestinationLossyCompressionQuality: 0.92] as CFDictionary)
        guard CGImageDestinationFinalize(destination) else { throw Refused(code: "damaged") }
        return .jpeg(out as Data)
    }

    /* The image drawn into RGBA (premultiplied, sRGB), and whether any pixel is not fully opaque. */
    static func pixels(of image: CGImage) throws -> (Data, Bool) {
        let width = image.width, height = image.height
        var rgba = Data(count: width * height * 4)
        let drawn = rgba.withUnsafeMutableBytes { buffer -> Bool in
            guard let context = CGContext(
                data: buffer.baseAddress, width: width, height: height, bitsPerComponent: 8, bytesPerRow: width * 4,
                space: CGColorSpace(name: CGColorSpace.sRGB) ?? CGColorSpaceCreateDeviceRGB(),
                bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
            ) else { return false }
            context.draw(image, in: CGRect(x: 0, y: 0, width: width, height: height))
            return true
        }
        guard drawn else { throw Refused(code: "damaged") }
        let transparent = rgba.withUnsafeBytes { buffer in
            stride(from: 3, to: buffer.count, by: 4).contains { buffer[$0] != 255 }
        }
        return (rgba, transparent)
    }

    /* The PDF's thumbnail: the first image, upright, at most 512 px and 64 KB of JPEG; nil when it can't be made. */
    public static func thumbnail(_ bytes: Data) -> Data? {
        guard let source = CGImageSourceCreateWithData(bytes as CFData, nil) else { return nil }
        for edge in [Thumbnails.side, Thumbnails.side / 2] {
            let options: [CFString: Any] = [
                kCGImageSourceCreateThumbnailFromImageAlways: true,
                kCGImageSourceThumbnailMaxPixelSize: edge,
                kCGImageSourceCreateThumbnailWithTransform: true,
            ]
            guard let image = CGImageSourceCreateThumbnailAtIndex(source, 0, options as CFDictionary) else { return nil }
            for quality in [0.7, 0.5] {
                let out = NSMutableData()
                guard let destination = CGImageDestinationCreateWithData(out, UTType.jpeg.identifier as CFString, 1, nil) else {
                    return nil
                }
                CGImageDestinationAddImage(destination, image, [kCGImageDestinationLossyCompressionQuality: quality] as CFDictionary)
                guard CGImageDestinationFinalize(destination) else { return nil }
                if out.length <= Thumbnails.maxBytes { return out as Data }
            }
        }
        return nil
    }
}

// MARK: Making and saving

extension ImagesPdf {
    /*
     * One PDF of `images` into `folder` as `name` (the next free one there): the room checked and
     * the run recorded first, the PDF built in a tool run, then saved. `progress` hears images
     * done of all, then the save. Any failure, a cancel included, cleans up what was made and
     * throws: SaveRefused (nothing was started), ImagesPdfRefused, ToolCancelled, ToolFailed or
     * SaveRunStopped.
     */
    public static func make(
        vault: Vault, images: [Opened], folder: Opened, size: PageSize, margin: Bool, name: String,
        progress: @escaping @Sendable (Int, Int) -> Void = { _, _ in }
    ) async throws -> Opened {
        guard oneFolder(images), images.allSatisfy({ $0.node.parentId == folder.id }) else { throw ImagesPdfRefused(mixedFolders) }
        let total = images.reduce(UInt64(0)) { $0 + ($1.size ?? 0) }
        let run = try await SaveRun.start(writer: vault, targets: [folder], results: [.fromSources(sourcesSize: total, thumbnail: true)])
        do {
            var sources: [SaveSource] = []
            for image in images {
                if case let .from(each) = try await vault.copySources(of: image) { sources.append(contentsOf: each) }
            }
            let refusal = Refusal()
            let names = images.map(\.name)
            let maxPixels = Self.maxPixels
            let lease = Lease()
            defer { lease.release() }
            // A 401 renewing an address mid-read: thrown as itself, for the session check, never as the core's read failure.
            let refusals = SessionRefusals()
            let made: Made
            do {
                made = try await ToolRuns.shared.run("Making \(name)") { control in
                    do {
                        let made = try build(names: names, size: size, margin: margin, maxPixels: maxPixels, control: control, read: { index in
                            let reader = try blocking { try await vault.toolReader(images[index], control: control, refusals: refusals) }
                            return try readWhole(size: reader.size()) { offset, length in try reader.readAt(offset: offset, length: length) }
                        }, progress: { progress($0, images.count) })
                        // Waits while the process holds 512 MB of results not yet uploaded.
                        lease.take(UInt64(made.pdf.count), try ToolRuns.budget.produce(bytes: UInt64(made.pdf.count), control: control))
                        return made
                    } catch let refused as ImagesPdfRefused {
                        refusal.set(refused)
                        throw refused
                    }
                }
            } catch {
                if let refused = refusals.refused { throw refused }
                if let refused = refusal.value { throw refused }
                throw error
            }
            progress(images.count, images.count)
            let saved = try await run.file(made.pdf, name: name, mime: "application/pdf", sources: .from(sources),
                                           thumbnail: made.thumbnail, in: folder)
            // Stopped while it uploaded: what landed goes (the catch below cancels the run), never kept.
            try Task.checkCancellation()
            _ = await TextSave.end(run)
            return saved
        } catch {
            let stopped = await run.cancel()
            if error is ToolCancelled || error is CancellationError { throw stopped }
            throw error
        }
    }

    /* An async step waited for on the run's own thread (never the cooperative pool): the reader's address. */
    static func blocking<T: Sendable>(_ step: @escaping @Sendable () async throws -> T) throws -> T {
        let done = DispatchSemaphore(value: 0)
        let box = Box<Result<T, Error>>()
        Task {
            let result: Result<T, Error>
            do { result = .success(try await step()) } catch { result = .failure(error) }
            box.set(result)
            done.signal()
        }
        done.wait()
        return try box.value!.get()
    }

    final class Box<T>: @unchecked Sendable {
        private let lock = NSLock()
        private var held: T?
        var value: T? { lock.withLock { held } }
        func set(_ value: T) { lock.withLock { held = value } }
    }
}
