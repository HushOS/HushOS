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
