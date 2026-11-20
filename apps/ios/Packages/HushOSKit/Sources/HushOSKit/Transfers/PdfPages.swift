import CoreGraphics
import Foundation
import HushOSCore
import ImageIO
import PDFKit
import UniformTypeIdentifiers

/*
 * Edit pages (docs/file-tools-design.md, feature (c)), as the web does it: every page of the PDFs
 * chosen, turned, put in order, removed and split, then saved as a new version of the one PDF, as
 * new files (one PDF edited, several merged, or one a range when split), or as images in a new
 * folder. The core's `PdfPagesWriter` (lopdf) reads the PDFs, refuses a password, says what saving
 * would lose (a signature, bookmarks and form fields) and writes every PDF; PDFKit only draws (the
 * sheet's thumbnails, Save as images). Reading and writing are tool runs (ToolRuns: one at a time,
 * the watchdog over them, a cancel at any point leaves nothing); results go through the save path
 * (SaveRuns), each signed as the weakest of the PDFs its pages came from.
 */
public enum PdfPages {
    /* This phone's limits: the input held to a sixteenth of its memory, at most the web's 256 MB. */
    public static var limits: PdfToolsLimits { pdfToolsLimits(deviceMemoryBytes: ProcessInfo.processInfo.physicalMemory) }

    public enum Stage: Equatable, Sendable { case fine, offer, ceiling }

    /* Fine, worth a word first (the large-file card), or more than this phone edits. */
    public static func stage(count: Int, bytes: UInt64, limits: PdfToolsLimits = limits) -> Stage {
        if count > Int(limits.maxFiles) || bytes > limits.maxInputBytes { return .ceiling }
        return bytes > limits.cardBytes ? .offer : .fine
    }

    /* Save as images for `pages` pages: fine, worth a word first, or more than one run makes. */
    public static func imagesStage(pages: Int, limits: PdfToolsLimits = limits) -> Stage {
        if pages > Int(limits.imagesMaxPages) { return .ceiling }
        return pages > Int(limits.imagesCardPages) ? .offer : .fine
    }

    /* A PDF, by its recorded type or its name: as the web's `isPdf`. */
    public static func takes(_ item: Opened) -> Bool {
        guard !item.isFolder, item.node.currentVersion != nil else { return false }
        if item.metadata.mime?.lowercased() == "application/pdf" { return true }
        return (item.name as NSString).pathExtension.lowercased() == "pdf"
    }

    public static let mixedFolders = "These PDFs are in different folders. Edit pages from one folder at a time."

    public static func oneFolder(_ files: [Opened]) -> Bool {
        guard let first = files.first else { return false }
        return files.allSatisfy { $0.node.parentId == first.node.parentId && $0.node.workspaceId == first.node.workspaceId }
    }

    // MARK: Names, as the web gives them (lib/pdf-tools/names.ts)

    public static func baseName(_ name: String) -> String {
        let base = ((name as NSString).deletingPathExtension).trimmingCharacters(in: .whitespaces)
        return base.isEmpty ? (name.isEmpty ? "PDF" : name) : base
    }

    /* "Report (pages 1–3).pdf" for a range, "Report (page 4).pdf" for one page; pages counted from 1. */
    public static func splitName(_ source: String, first: Int, last: Int) -> String {
        let pages = first == last ? "page \(first)" : "pages \(first)\u{2013}\(last)"
        return "\(baseName(source)) (\(pages)).pdf"
    }

    public static func mergedName(_ first: String) -> String { "\(baseName(first)) (merged).pdf" }
    public static func imagesFolderName(_ source: String) -> String { "\(baseName(source)) (images)" }

    public static func pageImageName(_ index: Int, png: Bool) -> String {
        let number = String(index + 1)
        return "page \(String(repeating: "0", count: max(0, 3 - number.count)))\(number).\(png ? "png" : "jpg")"
    }

    /* The ranges `count` pages are cut into, after each index in `cuts`: as the web's `rangesOf`. */
    public static func ranges(count: Int, cuts: Set<Int>) -> [ClosedRange<Int>] {
        guard count > 0 else { return [] }
        var out: [ClosedRange<Int>] = []
        var start = 0
        for cut in cuts.filter({ $0 >= 0 && $0 < count - 1 }).sorted() {
            out.append(start ... cut)
            start = cut + 1
        }
        out.append(start ... count - 1)
        return out
    }

    /* The person's words for a refused PDF, one alone or one of several by its name. */
    public static func words(code: String, name: String?) -> String {
        switch code {
        case "encrypted":
            return name.map { "“\($0)” has a password. Remove it in another app, then try again." }
                ?? "This PDF has a password. Remove it in another app, then try again."
        case "too-many-pages":
            return "\(name.map { "“\($0)”" } ?? "This PDF") has more than 2,000 pages, too many to edit here."
        case "too-large":
            return "“\(name ?? "The PDF")” would be too large to make on this phone. Split it into smaller files."
        default:
            return name.map { "“\($0)” is damaged, or isn’t something HushOS can read." }
                ?? "This PDF is damaged, or isn’t something HushOS can read."
        }
    }

    public static let signedWarning = "Its digital signature won’t be valid in the new file."
    public static let formWarning = "Bookmarks and form fields may not carry over."

    // MARK: Reading

    /* What the sheet holds: each PDF's bytes (for drawing and saving) and what the core read of it. */
    public struct Read: Sendable {
        public let data: [Data]
        public let inspections: [PdfInspection]
    }

    /* A refusal kept apart from ToolRuns, which turns errors into ToolFailed. */
    final class Refusal: @unchecked Sendable {
        private let lock = NSLock()
        private var held: ImagesPdfRefused?
        var value: ImagesPdfRefused? { lock.withLock { held } }
        func set(_ refused: ImagesPdfRefused) { lock.withLock { if held == nil { held = refused } } }
    }

    /*
     * Reads `count` PDFs with `read` (blocking, on the run's thread) and has the core check each:
     * synchronous, so a tool run's work can be it. Throws ImagesPdfRefused with the person's words.
     */
    public static func inspect(names: [String], control: RunControl, read: (Int) throws -> Data,
                               progress: (Int) -> Void = { _ in }) throws -> Read {
        let writer = PdfPagesWriter()
        defer { writer.clear() }
        var data: [Data] = []
        var inspections: [PdfInspection] = []
        for (index, name) in names.enumerated() {
            let bytes = try read(index)
            do {
                inspections.append(try writer.add(bytes: bytes, control: control))
            } catch PdfToolsError.Refused(let code) {
                throw ImagesPdfRefused(words(code: code, name: names.count > 1 ? name : nil))
            }
            data.append(bytes)
            progress(index + 1)
        }
        return Read(data: data, inspections: inspections)
    }

    /* Each output's bytes, built from `sources` in order: synchronous, a tool run's work. */
    public static func build(sources: [Data], names: [String], outputs: [[PdfPagePlan]], maxOutput: UInt64? = nil,
                             control: RunControl, made: (Int, Data) throws -> Void) throws {
        let writer = PdfPagesWriter()
        defer { writer.clear() }
        if let maxOutput { writer.limitOutput(bytes: maxOutput) }
        for (index, bytes) in sources.enumerated() {
            do { _ = try writer.add(bytes: bytes, control: control) } catch PdfToolsError.Refused(let code) {
                throw ImagesPdfRefused(words(code: code, name: sources.count > 1 ? names[index] : nil))
            }
        }
        for (index, pages) in outputs.enumerated() {
            do {
                try made(index, try writer.build(pages: pages, control: control))
            } catch PdfToolsError.Refused(let code) {
                throw ImagesPdfRefused(words(code: code, name: nil))
            }
        }
    }

    // MARK: Drawing (PDFKit)

    /*
     * Page `page` of `document` drawn turned to `rotate` (absolute, as /Rotate is), `scale` pixels a
     * point, on white: the image Save as images saves and the sheet's thumbnail. The page's own
     * /Rotate is replaced, never added to. Nil past `maxPixels` or when the page can't be drawn.
     */
    public static func draw(_ document: PDFDocument, page: Int, rotate: UInt32, width: Int, height: Int, maxPixels: UInt64 = UInt64.max) -> CGImage? {
        guard let pdfPage = document.page(at: page), let cgPage = pdfPage.pageRef,
              width > 0, height > 0, UInt64(width) * UInt64(height) <= maxPixels,
              let context = CGContext(data: nil, width: width, height: height, bitsPerComponent: 8, bytesPerRow: 0,
                                      space: CGColorSpace(name: CGColorSpace.sRGB) ?? CGColorSpaceCreateDeviceRGB(),
                                      bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue)
        else { return nil }
        let box = cgPage.getBoxRect(.mediaBox)
        let (w, h) = (box.width, box.height)
        let turned = rotate == 90 || rotate == 270
        let scale = CGFloat(width) / (turned ? h : w)
        context.setFillColor(CGColor(red: 1, green: 1, blue: 1, alpha: 1))
        context.fill(CGRect(x: 0, y: 0, width: width, height: height))
        context.scaleBy(x: scale, y: scale)
        // Clockwise by `rotate`, in a space whose origin is the bottom left, as the bitmap's is.
        switch rotate {
        case 90: context.concatenate(CGAffineTransform(a: 0, b: -1, c: 1, d: 0, tx: 0, ty: w))
        case 180: context.concatenate(CGAffineTransform(a: -1, b: 0, c: 0, d: -1, tx: w, ty: h))
        case 270: context.concatenate(CGAffineTransform(a: 0, b: 1, c: -1, d: 0, tx: h, ty: 0))
        default: break
        }
        context.translateBy(x: -box.minX, y: -box.minY)
        context.drawPDFPage(cgPage)
        // Then the annotations a viewer shows (ink, highlights, notes), each in its own appearance, in page space.
        for annotation in pdfPage.annotations where annotation.shouldDisplay {
            context.saveGState()
            annotation.draw(with: .mediaBox, in: context)
            context.restoreGState()
        }
        return context.makeImage()
    }

    /* PNG or JPEG at 92, nothing else in the file (no EXIF, no profile but sRGB's). */
    public static func encode(_ image: CGImage, png: Bool) -> Data? {
        let out = NSMutableData()
        guard let destination = CGImageDestinationCreateWithData(out, (png ? UTType.png : UTType.jpeg).identifier as CFString, 1, nil)
        else { return nil }
        let options: [CFString: Any] = png ? [:] : [kCGImageDestinationLossyCompressionQuality: 0.92]
        CGImageDestinationAddImage(destination, image, options as CFDictionary)
        guard CGImageDestinationFinalize(destination) else { return nil }
        return withoutExif(out as Data, png: png)
    }

    /* ImageIO writes an EXIF block (colour space and pixel size) into every PNG and JPEG it makes; the web's
       canvas and Android's Bitmap write none, so it is cut: a PNG's `eXIf` chunks, a JPEG's APP1 segments
       before its first scan. Anything not laid out as ImageIO writes it is refused (nil), never passed on. */
    static func withoutExif(_ data: Data, png: Bool) -> Data? {
        let bytes = [UInt8](data)
        var out = [UInt8]()
        out.reserveCapacity(bytes.count)
        func be(_ at: Int, _ count: Int) -> Int { (at..<at + count).reduce(0) { $0 << 8 | Int(bytes[$1]) } }
        if png {
            guard bytes.count >= 8 else { return nil }
            out += bytes[0..<8]
            var at = 8
            while at < bytes.count {
                guard at + 12 <= bytes.count else { return nil }
                let end = at + 12 + be(at, 4)
                guard end <= bytes.count else { return nil }
                if bytes[(at + 4)..<(at + 8)] != [0x65, 0x58, 0x49, 0x66] { out += bytes[at..<end] }  // "eXIf"
                at = end
            }
            return Data(out)
        }
        guard bytes.count >= 4, bytes[0] == 0xFF, bytes[1] == 0xD8 else { return nil }
        out += bytes[0..<2]
        var at = 2
        while at + 4 <= bytes.count, bytes[at] == 0xFF {
            let marker = bytes[at + 1]
            if marker == 0xDA { break }  // the first scan: the rest is image data
            let end = at + 2 + be(at + 2, 2)
            guard end <= bytes.count else { return nil }
            if marker != 0xE1 { out += bytes[at..<end] }
            at = end
        }
        guard at + 2 <= bytes.count, bytes[at] == 0xFF, bytes[at + 1] == 0xDA else { return nil }
        out += bytes[at...]
        return Data(out)
    }

    /*
     * Each image's size, or the first page past `maxPixels` refused by its number: checked before the room is
     * reserved, in 64-bit arithmetic (a MediaBox can make each side up to 2^32 pixels), never multiplied as Int.
     */
    public static func imagePlan(_ pages: [PdfPagePlan], inspections: [PdfInspection], dpi: UInt32,
                                 maxPixels: UInt64) throws -> [(width: Int, height: Int)] {
        try pages.enumerated().map { index, page in
            let info = inspections[Int(page.source)].pages[Int(page.page)]
            let size = pdfImageSize(width: info.width, height: info.height, rotate: page.rotate, dpi: dpi)
            let (pixels, overflow) = UInt64(size[0]).multipliedReportingOverflow(by: UInt64(size[1]))
            guard !overflow, pixels <= maxPixels else {
                throw ImagesPdfRefused("Page \(index + 1) is too large to save as an image at this resolution. Choose 150 dpi, or fewer pages.")
            }
            return (Int(size[0]), Int(size[1]))
        }
    }

    /*
     * What a save that failed after it began says: its own reason when its clean-up removed everything,
     * and what may still be there (or the 401, for the session check) when it didn't.
     */
    static func stopped(_ error: Error, _ stopped: SaveRunStopped) -> Error {
        if error is ToolCancelled || error is CancellationError { return stopped }
        if stopped.refusedSession != nil { return stopped }
        guard stopped.cleanup == .left else { return error }
        let reason = (error as? ImagesPdfRefused)?.message ?? (error as? ToolFailed)?.message ?? ErrorWords.say(error) ?? toolFailedMessage()
        return ImagesPdfRefused("\(reason) \(stopped.message)")
    }

    /* An image's size for a page as the core sizes it (and the web): points at `dpi`, turned with the page. */
    public static func imageSize(_ page: PdfPage, rotate: UInt32, dpi: UInt32) -> (width: Int, height: Int) {
        let size = pdfImageSize(width: page.width, height: page.height, rotate: rotate, dpi: dpi)
        return (Int(size[0]), Int(size[1]))
    }

    /* A saved file's thumbnail: the page drawn small, as a JPEG within the upload's limit. */
    public static func thumbnail(_ document: PDFDocument, page: Int, info: PdfPage, rotate: UInt32) -> Data? {
        let side = Double(Thumbnails.side)
        let turned = rotate == 90 || rotate == 270
        let (w, h) = turned ? (info.height, info.width) : (info.width, info.height)
        let scale = side / max(w, h, 1)
        guard let image = draw(document, page: page, rotate: rotate, width: max(1, Int((w * scale).rounded())),
                               height: max(1, Int((h * scale).rounded())))
        else { return nil }
        for quality in [0.7, 0.5] {
            let out = NSMutableData()
            guard let destination = CGImageDestinationCreateWithData(out, UTType.jpeg.identifier as CFString, 1, nil) else { return nil }
            CGImageDestinationAddImage(destination, image, [kCGImageDestinationLossyCompressionQuality: quality] as CFDictionary)
            guard CGImageDestinationFinalize(destination) else { return nil }
            if out.length <= Thumbnails.maxBytes { return out as Data }
        }
        return nil
    }
}

// MARK: Reading and saving

extension PdfPages {
    /*
     * Reads `files` in a tool run (the core checks each as it comes): their bytes, held only in memory
     * while the sheet is open, and what each is. Throws ImagesPdfRefused, ToolCancelled or ToolFailed.
     */
    public static func read(vault: Vault, files: [Opened], progress: @escaping @Sendable (Int, Int) -> Void = { _, _ in }) async throws -> Read {
        let refusal = Refusal()
        let refusals = SessionRefusals()
        let names = files.map(\.name)
        do {
            return try await ToolRuns.shared.run(files.count == 1 ? "Reading \(files[0].name)" : "Reading \(files.count) PDFs") { control in
                do {
                    return try inspect(names: names, control: control, read: { index in
                        let reader = try ImagesPdf.blocking {
                            do { return try await vault.toolReader(files[index], control: control, refusals: refusals) } catch {
                                refusals.note(error)
                                throw error
                            }
                        }
                        return try ImagesPdf.readWhole(size: reader.size()) { offset, length in try reader.readAt(offset: offset, length: length) }
                    }, progress: { progress($0, files.count) })
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
    }

    public enum Choice: Sendable {
        /* A new version of the one PDF, from the version the sheet read. */
        case version(pages: [PdfPagePlan], file: Opened, startedFrom: String?)
        /* New files, each its pages under its name (the next free one in the folder). */
        case files([(name: String, pages: [PdfPagePlan])])
        case images(pages: [PdfPagePlan], png: Bool, dpi: UInt32, folderName: String)
    }

    /* What a version that lost a race says: nothing published. */
    public static func stale(_ name: String) -> String {
        "Someone saved a newer version of “\(name)” first, so nothing was saved. Edit its pages again."
    }

    /*
     * Saves `choice` into `folder`: the room checked and the run recorded first, the work in a tool
     * run, each result saved as it is made. Returns what to tell the person. Any failure, a cancel
     * included, cleans up what was made and throws: SaveRefused (nothing was started), ImagesPdfRefused,
     * ToolCancelled, ToolFailed or SaveRunStopped. A version that lost a race throws ImagesPdfRefused(stale).
     */
    public static func save(
        vault: Vault, files: [Opened], read: Read, folder: Opened, choice: Choice,
        progress: @escaping @Sendable (Int, Int) -> Void = { _, _ in }
    ) async throws -> String {
        guard oneFolder(files), files.allSatisfy({ $0.node.parentId == folder.id }) else { throw ImagesPdfRefused(mixedFolders) }
        let total = files.reduce(UInt64(0)) { $0 + ($1.size ?? 0) }
        let limits = limits
        var sources: [[SaveSource]] = []
        for file in files {
            if case let .from(each) = try await vault.copySources(of: file) { sources.append(each) } else { sources.append([]) }
        }
        let signing = { (pages: [PdfPagePlan]) -> SaveSources in
            .from(Set(pages.map { Int($0.source) }).sorted().flatMap { sources[$0] })
        }
        switch choice {
        case let .images(pages, png, dpi, folderName):
            // Every page's size first: one too large to draw is refused before anything is reserved or made.
            let sizes = try imagePlan(pages, inspections: read.inspections, dpi: dpi, maxPixels: limits.imagesMaxPixels)
            // A guess, as conversion's is: a PNG of a page is rarely more than a byte a pixel, a JPEG a third of that.
            let results: [PlannedResult] = sizes.map { .known(size: UInt64($0.width) * UInt64($0.height) / (png ? 1 : 3), thumbnail: true) }
            let run = try await SaveRun.start(writer: vault, targets: [folder], results: results)
            do {
                let into = try await run.folder(folderName, in: folder, sources: signing(pages))
                // The PDFs read once into the core's writer, which makes each page a PDF to draw (its annotations
                // drawn into it, as a viewer shows them): PDFKit draws only page content into a bitmap.
                let writer = PdfPagesWriter()
                defer { writer.clear() }
                let sourceData = read.data
                try await ToolRuns.shared.run("Reading \(files.count == 1 ? files[0].name : "\(files.count) PDFs")") { control in
                    for bytes in sourceData { _ = try writer.add(bytes: bytes, control: control) }
                }
                let names = pages.indices.map { pageImageName($0, png: png) }
                for (index, page) in pages.enumerated() {
                    let size = sizes[index]
                    let refusal = Refusal()
                    let lease = ImagesPdf.Lease()
                    defer { lease.release() }
                    let made: (image: Data, thumbnail: Data?)
                    do {
                        made = try await ToolRuns.shared.run("Saving page \(index + 1) as an image") { control in
                            try control.progress()
                            let drawable = try writer.drawable(page: page, control: control)
                            guard let document = PDFDocument(data: drawable),
                                  let image = draw(document, page: 0, rotate: page.rotate, width: size.width, height: size.height),
                                  let encoded = encode(image, png: png)
                            else {
                                let refused = ImagesPdfRefused(words(code: "damaged", name: files.count > 1 ? files[Int(page.source)].name : nil))
                                refusal.set(refused)
                                throw refused
                            }
                            try control.progress()
                            lease.take(UInt64(encoded.count), try ToolRuns.budget.produce(bytes: UInt64(encoded.count), control: control))
                            return (encoded, ImagesPdfImages.thumbnail(encoded))
                        }
                    } catch {
                        if let refused = refusal.value { throw refused }
                        throw error
                    }
                    _ = try await run.file(made.image, name: names[index], mime: png ? "image/png" : "image/jpeg", sources: signing([page]),
                                           thumbnail: made.thumbnail, in: into)
                    try Task.checkCancellation()
                    progress(index + 1, pages.count)
                }
                _ = await TextSave.end(run)
                return "Saved “\(folderName)”."
            } catch {
                throw stopped(error, await run.cancel())
            }
        case let .version(pages, file, startedFrom):
            let run = try await SaveRun.start(writer: vault, targets: [file], results: [.fromSources(sourcesSize: total, thumbnail: true)])
            do {
                var saved: VersionSaved?
                try await buildEach(read: read, names: files.map(\.name), outputs: [pages], limits: limits, progress: progress) { _, made in
                    saved = try await run.version(made, of: file, in: folder, startedFrom: startedFrom, sources: signing(pages),
                                                  mime: "application/pdf", thumbnail: thumbnailOf(read: read, pages: pages))
                }
                try Task.checkCancellation()
                _ = await TextSave.end(run)
                if case .stale = saved { throw ImagesPdfRefused(stale(file.name)) }
                return "Saved a new version of “\(file.name)”."
            } catch {
                throw stopped(error, await run.cancel())
            }
        case let .files(outputs):
            let count = max(1, outputs.reduce(0) { $0 + $1.pages.count })
            let results: [PlannedResult] = outputs.map {
                .fromSources(sourcesSize: max(1, total * UInt64($0.pages.count) / UInt64(count)), thumbnail: true)
            }
            let run = try await SaveRun.start(writer: vault, targets: [folder], results: results)
            do {
                // Each output saved as it is made, its bytes counted in the budget until then: never all of them at once.
                try await buildEach(read: read, names: files.map(\.name), outputs: outputs.map(\.pages), limits: limits, progress: progress) { index, made in
                    let output = outputs[index]
                    _ = try await run.file(made, name: output.name, mime: "application/pdf", sources: signing(output.pages),
                                           thumbnail: index < 20 ? thumbnailOf(read: read, pages: output.pages) : nil, in: folder)
                    try Task.checkCancellation()
                }
                _ = await TextSave.end(run)
                return outputs.count == 1 ? "Saved “\(outputs[0].name)”." : "Saved \(outputs.count) files."
            } catch {
                throw stopped(error, await run.cancel())
            }
        }
    }

    /*
     * The outputs, one at a time: the PDFs read once into one writer, then each output built in a tool run of
     * its own, its bytes charged to `budget` (waiting while the process holds 512 MB of results) and handed
     * to `save`, the charge given back once `save` returns or throws, before the next is built. So a split
     * whose ranges each carry a large shared font holds one output at a time, never all of them.
     */
    static func buildEach(read: Read, names: [String], outputs: [[PdfPagePlan]], limits: PdfToolsLimits,
                          budget: ToolBudget = ToolRuns.budget,
                          progress: @escaping @Sendable (Int, Int) -> Void = { _, _ in },
                          save: (Int, Data) async throws -> Void) async throws {
        let refusal = Refusal()
        let data = read.data
        let writer = PdfPagesWriter()
        defer { writer.clear() }
        writer.limitOutput(bytes: limits.maxOutputBytes)
        let label = outputs.count == 1 ? "Making \(names.first ?? "a PDF")" : "Splitting \(names.first ?? "a PDF")"
        do {
            try await ToolRuns.shared.run(label) { control in
                for (index, bytes) in data.enumerated() {
                    do { _ = try writer.add(bytes: bytes, control: control) } catch PdfToolsError.Refused(let code) {
                        let refused = ImagesPdfRefused(words(code: code, name: data.count > 1 ? names[index] : nil))
                        refusal.set(refused)
                        throw refused
                    }
                }
            }
            for (index, pages) in outputs.enumerated() {
                let lease = ImagesPdf.Lease(giveBack: { budget.release(bytes: $0, generation: $1) })
                defer { lease.release() }
                let made = try await ToolRuns.shared.run(label) { control in
                    let bytes: Data
                    do { bytes = try writer.build(pages: pages, control: control) } catch PdfToolsError.Refused(let code) {
                        let refused = ImagesPdfRefused(words(code: code, name: nil))
                        refusal.set(refused)
                        throw refused
                    }
                    lease.take(UInt64(bytes.count), try budget.produce(bytes: UInt64(bytes.count), control: control))
                    return bytes
                }
                progress(index + 1, outputs.count)
                try await save(index, made)
            }
        } catch {
            if let refused = refusal.value { throw refused }
            throw error
        }
    }

    /* One page as the core makes it to draw (annotations in its content), handed to `made`: synchronous, a tool run's work. */
    static func drawable(sources: [Data], page: PdfPagePlan, control: RunControl, made: (Data) throws -> Void) throws {
        let writer = PdfPagesWriter()
        defer { writer.clear() }
        for bytes in sources { _ = try writer.add(bytes: bytes, control: control) }
        try made(try writer.drawable(page: page, control: control))
    }

    static func thumbnailOf(read: Read, pages: [PdfPagePlan]) -> Data? {
        guard let first = pages.first, let document = PDFDocument(data: read.data[Int(first.source)]) else { return nil }
        return thumbnail(document, page: Int(first.page), info: read.inspections[Int(first.source)].pages[Int(first.page)], rotate: first.rotate)
    }
}
