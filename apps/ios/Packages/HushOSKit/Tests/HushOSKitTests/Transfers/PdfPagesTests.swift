import CoreGraphics
import Foundation
import HushOSCore
import ImageIO
import PDFKit
import Testing
@testable import HushOSKit

/*
 * Edit pages on the phone: the core's writer (lopdf) over the shared fixtures (e2e/fixtures/pdfs),
 * every output read back with PDFKit the way a reader shows it: its page count, each page's size
 * and rotation, and which page it is by the text the fixture drew on it. Save as images is drawn
 * with PDFKit and its size and orientation checked by the colour band each fixture page carries.
 */
@Suite struct PdfPagesTests {
    static let fixtures = Checkout.file("e2e/fixtures/pdfs")

    static func fixture(_ name: String) throws -> Data { try Data(contentsOf: fixtures.appendingPathComponent(name)) }

    static func control() -> RunControl { RunControl(watchdogMillis: 30_000, clock: nil) }

    static func read(_ names: [String]) throws -> PdfPages.Read {
        let data = try names.map(fixture)
        return try PdfPages.inspect(names: names, control: control(), read: { data[$0] })
    }

    static func build(_ names: [String], _ outputs: [[PdfPagePlan]]) throws -> [Data] {
        let read = try read(names)
        var made: [Data] = []
        try PdfPages.build(sources: read.data, names: names, outputs: outputs, control: control()) { _, bytes in made.append(bytes) }
        return made
    }

    /* Each page as PDFKit shows it: its MediaBox size, its rotation, and the "Page n" drawn on it. */
    static func pages(_ pdf: Data) throws -> [(width: Double, height: Double, rotate: Int, label: String?)] {
        let document = try #require(PDFDocument(data: pdf))
        return (0 ..< document.pageCount).map { index in
            let page = document.page(at: index)!
            let box = page.bounds(for: .mediaBox)
            let label = page.string?.components(separatedBy: .newlines).first { $0.hasPrefix("Page ") }
            return (Double(box.width), Double(box.height), page.rotation, label)
        }
    }

    @Test func mergingReordersAndTurnsTheWayThePlanSays() throws {
        // plain's page 3 first, then page 1 turned a quarter, then rotated's two as they are.
        let made = try Self.build(["plain.pdf", "rotated.pdf"], [[
            PdfPagePlan(source: 0, page: 2, rotate: 0),
            PdfPagePlan(source: 0, page: 0, rotate: 90),
            PdfPagePlan(source: 1, page: 0, rotate: 180),
            PdfPagePlan(source: 1, page: 1, rotate: 90),
        ]])
        let pages = try Self.pages(made[0])
        #expect(pages.map(\.width) == [400, 612, 612, 720])
        #expect(pages.map(\.height) == [600, 792, 792, 405])
        #expect(pages.map(\.rotate) == [0, 90, 180, 90])
        #expect(pages.map(\.label) == ["Page 3", "Page 1", "Page 1", "Page 2"])
    }

    @Test func splittingGivesEachRangeItsOwnPdf() throws {
        let plain = PdfPages.ranges(count: 3, cuts: [0])
        #expect(plain == [0 ... 0, 1 ... 2])
        let plans = plain.map { range in range.map { PdfPagePlan(source: 0, page: UInt32($0), rotate: 0) } }
        let made = try Self.build(["plain.pdf"], plans)
        #expect(try Self.pages(made[0]).map(\.label) == ["Page 1"])
        #expect(try Self.pages(made[1]).map(\.label) == ["Page 2", "Page 3"])
        #expect(PdfPages.splitName("plain.pdf", first: 2, last: 3) == "plain (pages 2\u{2013}3).pdf")
        #expect(PdfPages.splitName("plain.pdf", first: 1, last: 1) == "plain (page 1).pdf")
        #expect(PdfPages.mergedName("plain.pdf") == "plain (merged).pdf")
        #expect(PdfPages.pageImageName(0, png: true) == "page 001.png")
    }

    @Test func outputsCarryNoDocumentInformation() throws {
        let made = try Self.build(["plain.pdf"], [[PdfPagePlan(source: 0, page: 0, rotate: 0)]])[0]
        let document = try #require(PDFDocument(data: made))
        // The source's Info held a canary title and a producer: none of it, and no Info of the writer's own.
        #expect(document.documentAttributes?[PDFDocumentAttribute.titleAttribute] == nil)
        #expect(document.documentAttributes?[PDFDocumentAttribute.producerAttribute] == nil)
        #expect(made.range(of: Data("HUSHOS-CANARY-INFO-c37a".utf8)) == nil)
        #expect(made.range(of: Data("/Info".utf8)) == nil)
    }

    @Test func aPasswordIsRefusedAndASignatureOrFormIsSaid() throws {
        #expect(throws: ImagesPdfRefused("This PDF has a password. Remove it in another app, then try again.")) {
            try Self.read(["encrypted.pdf"])
        }
        #expect(throws: ImagesPdfRefused("“encrypted.pdf” has a password. Remove it in another app, then try again.")) {
            try Self.read(["plain.pdf", "encrypted.pdf"])
        }
        #expect(throws: ImagesPdfRefused("This PDF is damaged, or isn’t something HushOS can read.")) {
            try Self.read(["damaged.pdf"])
        }
        let signed = try Self.read(["signed.pdf"]).inspections[0]
        #expect(signed.signed && signed.form && !signed.outline)
        let form = try Self.read(["outline-form.pdf"]).inspections[0]
        #expect(!form.signed && form.form && form.outline)
        #expect(try !Self.read(["unsigned-field.pdf"]).inspections[0].signed)
    }

    @Test func saveAsImagesDrawsEachPageAtItsResolutionTurnedWithIt() throws {
        let read = try Self.read(["rotated.pdf"])
        let document = try #require(PDFDocument(data: read.data[0]))
        // The wide page (720 by 405) turned a quarter: 844 by 1500 at 150 dpi, as the web makes it.
        let info = read.inspections[0].pages[1]
        let size = PdfPages.imageSize(info, rotate: 90, dpi: 150)
        #expect(size.width == 844 && size.height == 1500)
        let image = try #require(PdfPages.draw(document, page: 1, rotate: 90, width: size.width, height: size.height))
        #expect(image.width == 844 && image.height == 1500)
        // The page's green band runs along its bottom; turned clockwise, it stands along the left.
        let rgba = Self.pixels(image)
        let at = { (x: Int, y: Int) -> (Int, Int, Int) in
            let i = (y * image.width + x) * 4
            return (Int(rgba[i]), Int(rgba[i + 1]), Int(rgba[i + 2]))
        }
        let green = { (c: (Int, Int, Int)) in c.1 > 110 && c.0 < 90 && c.2 < 110 }
        #expect(green(at(image.width / 6, image.height / 2)))
        #expect(!green(at(image.width - 20, image.height / 2)))
        let png = try #require(PdfPages.encode(image, png: true))
        let source = try #require(CGImageSourceCreateWithData(png as CFData, nil))
        let properties = try #require(CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any])
        #expect(properties[kCGImagePropertyPixelWidth] as? Int == 844)
        #expect(properties[kCGImagePropertyPixelHeight] as? Int == 1500)
        #expect(properties[kCGImagePropertyExifDictionary] == nil)
        // A JPEG the same: ImageIO's EXIF block cut, the picture kept.
        let jpeg = try #require(PdfPages.encode(image, png: false))
        let jpegSource = try #require(CGImageSourceCreateWithData(jpeg as CFData, nil))
        let jpegProperties = try #require(CGImageSourceCopyPropertiesAtIndex(jpegSource, 0, nil) as? [CFString: Any])
        #expect(jpegProperties[kCGImagePropertyPixelWidth] as? Int == 844)
        #expect(jpegProperties[kCGImagePropertyExifDictionary] == nil)
        #expect(jpeg.range(of: Data("Exif".utf8)) == nil)
        // Past the pixel cap nothing is drawn.
        #expect(PdfPages.draw(document, page: 0, rotate: 0, width: 8000, height: 8000, maxPixels: 40_000_000) == nil)
    }

    @Test func aCancelledRunStopsTheWriter() throws {
        let read = try Self.read(["plain.pdf"])
        let control = Self.control()
        control.cancel()
        #expect(throws: (any Error).self) {
            try PdfPages.build(sources: read.data, names: ["plain.pdf"], outputs: [[PdfPagePlan(source: 0, page: 0, rotate: 0)]],
                               control: control) { _, _ in Issue.record("built after a cancel") }
        }
    }

    @Test func limitsFollowThePhonesMemory() {
        #expect(pdfToolsLimits(deviceMemoryBytes: 8 << 30).maxInputBytes == 256 << 20)
        #expect(pdfToolsLimits(deviceMemoryBytes: 2 << 30).maxInputBytes == 128 << 20)
        let small = pdfToolsLimits(deviceMemoryBytes: 2 << 30)
        #expect(PdfPages.stage(count: 1, bytes: 32 << 20, limits: small) == .fine)
        #expect(PdfPages.stage(count: 1, bytes: (32 << 20) + 1, limits: small) == .offer)
        #expect(PdfPages.stage(count: 1, bytes: (128 << 20) + 1, limits: small) == .ceiling)
        #expect(PdfPages.stage(count: 101, bytes: 1, limits: small) == .ceiling)
        #expect(PdfPages.imagesStage(pages: 51) == .offer)
        #expect(PdfPages.imagesStage(pages: 501) == .ceiling)
    }

    @Test func imagesShowTheAnnotationsAViewerShows() throws {
        // annotated.pdf: a square annotation filled blue at [100 300 300 500]. Drawn from the page the core
        // flattens for drawing, so its appearance is part of the page whatever PDFKit draws of annotations.
        let read = try Self.read(["annotated.pdf"])
        var drawable = Data()
        try PdfPages.drawable(sources: read.data, page: PdfPagePlan(source: 0, page: 0, rotate: 0), control: Self.control()) { drawable = $0 }
        let document = try #require(PDFDocument(data: drawable))
        let size = PdfPages.imageSize(read.inspections[0].pages[0], rotate: 0, dpi: 72)
        let image = try #require(PdfPages.draw(document, page: 0, rotate: 0, width: size.width, height: size.height))
        let rgba = Self.pixels(image)
        // Row 0 is the top: the square's middle, 400 points up a 792-point page, is row 392.
        let i = (392 * image.width + 200) * 4
        #expect(rgba[i + 2] > 150 && rgba[i] < 90, "the annotation's blue is drawn")
        // And the source as PDFKit draws it alone shows none of it: the flattening is what draws it.
        let source = try #require(PDFDocument(data: read.data[0]))
        let plain = try #require(PdfPages.draw(source, page: 0, rotate: 0, width: size.width, height: size.height))
        let unflattened = Self.pixels(plain)
        #expect(!(unflattened[i + 2] > 150 && unflattened[i] < 90))
    }

    @Test func aPageTooLargeIsRefusedBeforeAnythingIsPlanned() throws {
        let letter = PdfPage(width: 612, height: 792, rotate: 0)
        let huge = PdfPage(width: 1e15, height: 1e15, rotate: 0)
        let inspection = PdfInspection(pages: [letter, huge], signed: false, outline: false, form: false)
        let pages = [PdfPagePlan(source: 0, page: 0, rotate: 0), PdfPagePlan(source: 0, page: 1, rotate: 0)]
        let fine = try PdfPages.imagePlan([pages[0]], inspections: [inspection], dpi: 150, maxPixels: 40_000_000)
        #expect(fine.map(\.width) == [1275] && fine.map(\.height) == [1650])
        // Each side of the huge page is UInt32.max pixels: refused by its number, never multiplied as Int.
        #expect(throws: ImagesPdfRefused("Page 2 is too large to save as an image at this resolution. Choose 150 dpi, or fewer pages.")) {
            try PdfPages.imagePlan(pages, inspections: [inspection], dpi: 150, maxPixels: 40_000_000)
        }
    }

    @Test func aFailedSaveSaysWhatMayStillBeThere() {
        let reason = ImagesPdfRefused("Page 2 is too large.")
        let left = SaveRunStopped(reason: .failed, message: "Some of what was made may still be there.", cleanup: .left)
        #expect((PdfPages.stopped(reason, left) as? ImagesPdfRefused)?.message == "Page 2 is too large. Some of what was made may still be there.")
        // Cleaned up: the reason alone.
        let clean = SaveRunStopped(reason: .failed, message: "Nothing was saved.", cleanup: .deleted)
        #expect(PdfPages.stopped(reason, clean) as? ImagesPdfRefused == reason)
        // A cancel says how the clean-up ended, whatever it was.
        #expect(PdfPages.stopped(ToolCancelled(), clean) as? SaveRunStopped == clean)
    }

    @Test func eachOutputIsSavedBeforeTheNextIsBuiltItsBytesCountedUntilThen() async throws {
        let read = try Self.read(["plain.pdf"])
        let budget = ToolBudget(limitBytes: 512 << 20)
        var seen: [(UInt64, Int)] = []
        let plans = (0 ..< 3).map { [PdfPagePlan(source: 0, page: UInt32($0), rotate: 0)] }
        try await PdfPages.buildEach(read: read, names: ["plain.pdf"], outputs: plans, limits: PdfPages.limits, budget: budget) { _, made in
            // While one is saved, the budget holds it and nothing before it.
            seen.append((budget.waiting(), made.count))
        }
        #expect(seen.count == 3)
        for (waiting, bytes) in seen { #expect(waiting == UInt64(bytes)) }
        #expect(budget.waiting() == 0)
    }

    static func pixels(_ image: CGImage) -> [UInt8] {
        var rgba = [UInt8](repeating: 0, count: image.width * image.height * 4)
        rgba.withUnsafeMutableBytes { buffer in
            let context = CGContext(data: buffer.baseAddress, width: image.width, height: image.height, bitsPerComponent: 8,
                                    bytesPerRow: image.width * 4, space: CGColorSpaceCreateDeviceRGB(),
                                    bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
            // Rows of a bitmap context run from the top, as an image's do.
            context.draw(image, in: CGRect(x: 0, y: 0, width: image.width, height: image.height))
        }
        return rgba
    }
}
