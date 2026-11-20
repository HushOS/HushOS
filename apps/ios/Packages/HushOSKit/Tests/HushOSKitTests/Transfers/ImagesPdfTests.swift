import CoreGraphics
import CryptoKit
import Foundation
import HushOSCore
import ImageIO
import PDFKit
import Testing
import UIKit
import UniformTypeIdentifiers
@testable import HushOSKit

/*
 * One PDF on the phone: the core's writer over the shared fixtures (e2e/fixtures/images), images
 * the platform decodes (HEIC among them), read back with PDFKit the way a reader shows them.
 * Each page is drawn and looked at where a person looks: red along the top, green down the left.
 */
@Suite struct ImagesPdfTests {
    static let fixtures = Checkout.file("e2e/fixtures/images")

    static func fixture(_ name: String) throws -> Data { try Data(contentsOf: fixtures.appendingPathComponent(name)) }

    static func build(_ images: [(String, Data)], size: PageSize = .fit, margin: Bool = false, maxPixels: UInt64 = 100_000_000) throws -> ImagesPdf.Made {
        try ImagesPdf.build(names: images.map(\.0), size: size, margin: margin, maxPixels: maxPixels,
                            control: RunControl(watchdogMillis: 30_000, clock: nil), read: { images[$0].1 })
    }

    /* A page drawn at a point a pixel, as RGBA with row 0 at the top. */
    struct Drawn {
        let width: Int, height: Int, rgba: [UInt8]
        func at(_ x: Double, _ y: Double) -> (Int, Int, Int) {
            let i = (Int(y) * width + Int(x)) * 4
            return (Int(rgba[i]), Int(rgba[i + 1]), Int(rgba[i + 2]))
        }
        var upright: Bool {
            let red = { (c: (Int, Int, Int)) in c.0 > 150 && c.1 < 90 && c.2 < 90 }
            let green = { (c: (Int, Int, Int)) in c.1 > 110 && c.0 < 90 && c.2 < 110 }
            let w = Double(width), h = Double(height)
            return red(at(w / 2, h * 0.03)) && green(at(w * 0.03, h / 2)) && !red(at(w / 2, h * 0.97))
        }
    }

    static func draw(_ page: PDFPage) -> Drawn {
        let box = page.bounds(for: .mediaBox)
        let width = Int(box.width.rounded()), height = Int(box.height.rounded())
        var rgba = [UInt8](repeating: 0, count: width * height * 4)
        rgba.withUnsafeMutableBytes { buffer in
            let context = CGContext(data: buffer.baseAddress, width: width, height: height, bitsPerComponent: 8, bytesPerRow: width * 4,
                                    space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
            context.setFillColor(UIColor.white.cgColor)
            context.fill(CGRect(x: 0, y: 0, width: width, height: height))
            page.draw(with: .mediaBox, to: context)
        }
        return Drawn(width: width, height: height, rgba: rgba)
    }

    static func leaks(_ pdf: Data) -> [String] {
        let latitude = Data([51, 0, 0, 0, 1, 0, 0, 0, 30, 0, 0, 0, 1, 0, 0, 0, 0x5A, 0x0A, 0, 0, 100, 0, 0, 0])
        let needles: [(String, Data)] = [
            ("Exif", Data("Exif\0\0".utf8)), ("XMP", Data("http://ns.adobe.com/xap/1.0/".utf8)),
            ("canary", Data("HushCanaryCam".utf8)), ("GPS", latitude),
        ]
        return needles.filter { pdf.range(of: $0.1) != nil }.map(\.0)
    }

    @Test func pagesComeInOrderUprightWithNothingOfTheirMetadata() throws {
        let gps = try Self.fixture("gps.jpg")
        #expect(Self.leaks(gps).contains("GPS"), "the fixture carries what must be cut")
        let made = try Self.build([("page-2.jpg", try Self.fixture("page-2.jpg")), ("phone-rotated.jpg", try Self.fixture("phone-rotated.jpg")),
                                   ("gps.jpg", gps)])
        #expect(Self.leaks(made.pdf).isEmpty)
        let document = try #require(PDFDocument(data: made.pdf))
        #expect(document.pageCount == 3)
        let sizes = (0 ..< 3).map { document.page(at: $0)!.bounds(for: .mediaBox).size }
        // Fit: each page its image; the phone photo, stored 300x400, shown 400x300.
        #expect(sizes == [CGSize(width: 200, height: 300), CGSize(width: 400, height: 300), CGSize(width: 240, height: 160)])
        for index in 0 ..< 3 { #expect(Self.draw(document.page(at: index)!).upright, "page \(index + 1)") }
        // The JPEG went in as it was cut, byte for byte (expected.json's digest, worked out apart from either cutter).
        let cut = try Self.onlyStream(of: try Self.build([("gps.jpg", gps)]).pdf)
        #expect(SHA256.hash(data: cut).map { String(format: "%02x", $0) }.joined() == (try Self.expectedDigest("gps.jpg")))
        #expect(made.pdf.range(of: cut) != nil)
        #expect(made.thumbnail != nil)
    }

    @Test func aHeicPhotoTheDeviceDecodesStandsUpright() throws {
        // An upright picture stored a quarter turn anticlockwise, with orientation 6, as a phone keeps it.
        let upright = try Self.picture(width: 400, height: 300)
        let stored = try #require(Self.turned(upright))
        let heic = NSMutableData()
        let destination = try #require(CGImageDestinationCreateWithData(heic, UTType.heic.identifier as CFString, 1, nil))
        CGImageDestinationAddImage(destination, stored, [kCGImagePropertyOrientation: 6, kCGImageDestinationLossyCompressionQuality: 0.9] as CFDictionary)
        #expect(CGImageDestinationFinalize(destination))
        let made = try Self.build([("IMG_0001.HEIC", heic as Data)], size: .a4, margin: true)
        let page = try #require(PDFDocument(data: made.pdf)?.page(at: 0))
        let box = page.bounds(for: .mediaBox)
        #expect(box.width > box.height, "A4 turned to the photo as shown")
        // On the page: the image inside 12 mm, drawn upright.
        let drawn = Self.draw(page)
        let margin = 12 * 72 / 25.4
        let red = { (c: (Int, Int, Int)) in c.0 > 150 && c.1 < 90 && c.2 < 90 }
        let green = { (c: (Int, Int, Int)) in c.1 > 110 && c.0 < 90 }
        #expect(red(drawn.at(Double(drawn.width) / 2, margin + 10)), "red at the top, inside the margin")
        #expect(!red(drawn.at(Double(drawn.width) / 2, Double(drawn.height) - margin - 10)))
        // The 400x300 photo fitted inside the margins, centred: its left edge, and just inside it.
        let w = Double(drawn.width), h = Double(drawn.height)
        let shown = 400 * min((w - 2 * margin) / 400, (h - 2 * margin) / 300)
        #expect(green(drawn.at((w - shown) / 2 + 10, h / 2)), "green down the left")
    }

    @Test func aPngKeepsItsTransparency() throws {
        let made = try Self.build([("alpha.png", try Self.fixture("alpha.png"))])
        #expect(made.pdf.range(of: Data("/SMask".utf8)) != nil)
        let drawn = Self.draw(try #require(PDFDocument(data: made.pdf)?.page(at: 0)))
        #expect(drawn.at(32, 24).0 > 150, "the disc")
        #expect(drawn.at(1, 1) == (255, 255, 255), "the ground shows through")
    }

    @Test func refusalsNameTheImage() throws {
        #expect(throws: ImagesPdfRefused("“b.jpg” is damaged, or isn’t an image HushOS can put in a PDF.")) {
            try Self.build([("a.jpg", try Self.fixture("plain.jpg")), ("b.jpg", try Self.fixture("truncated-segment.jpg"))])
        }
        #expect(throws: ImagesPdfRefused("“c.jpg” is a kind of JPEG HushOS can’t put in a PDF.")) {
            try Self.build([("c.jpg", try Self.fixture("arithmetic.jpg"))])
        }
        // Past the device's pixels: refused from the header, before anything is decoded.
        #expect(throws: ImagesPdfRefused("“d.png” is too large to put in a PDF on this device.")) {
            try Self.build([("d.png", try Self.fixture("alpha.png"))], maxPixels: 64 * 47)
        }
        #expect(throws: ImagesPdfRefused("“e.webp” is damaged, or isn’t an image HushOS can put in a PDF.")) {
            try Self.build([("e.webp", Data("not an image".utf8))])
        }
    }

    @Test func aCancelledRunMakesNothing() throws {
        let control = RunControl(watchdogMillis: 30_000, clock: nil)
        control.cancel()
        #expect(throws: (any Error).self) {
            try ImagesPdf.build(names: ["a.jpg"], size: .fit, margin: false, maxPixels: 100_000_000, control: control,
                                read: { _ in try Self.fixture("plain.jpg") })
        }
    }

    @Test func aLargeImageIsReadInPiecesTheCoreAccepts() throws {
        // The core refuses one read past 64 MiB: a 70 MiB image must arrive in pieces, whole and in order.
        let size: UInt64 = 70 << 20
        var longest: UInt64 = 0
        let data = try ImagesPdf.readWhole(size: size) { offset, length in
            guard length <= 64 << 20 else { throw ImagesPdfRefused("The read was too long.") }
            longest = max(longest, length)
            return Data(repeating: UInt8((offset >> 20) & 0xFF), count: Int(length))
        }
        #expect(data.count == Int(size))
        #expect(longest <= ImagesPdf.readPiece)
        #expect(data[Int(65 << 20)] == 64 && data[Int(size) - 1] == 64, "each piece where it was read from")
    }

    @Test func aChargeTakenAfterTheLeaseWasReleasedIsGivenBackAtOnce() {
        final class Given: @unchecked Sendable {
            let lock = NSLock()
            var list: [UInt64] = []
            func add(_ bytes: UInt64) { lock.withLock { list.append(bytes) } }
        }
        let given = Given()
        // Stop returned to the caller, which released the lease; then the run's thread charged the PDF.
        let late = ImagesPdf.Lease { bytes, _ in given.add(bytes) }
        late.release()
        late.take(5, 1)
        #expect(given.list == [5])
        let lease = ImagesPdf.Lease { bytes, _ in given.add(bytes) }
        lease.take(7, 2)
        lease.release()
        lease.release()
        #expect(given.list == [5, 7], "given back once, when released")
    }

    @Test func limitsNamesAndPaper() {
        #expect(ImagesPdf.stage(count: 3, bytes: 64 << 20) == .fine)
        #expect(ImagesPdf.stage(count: 3, bytes: (64 << 20) + 1) == .offer)
        #expect(ImagesPdf.stage(count: 3, bytes: (256 << 20) + 1) == .ceiling)
        #expect(ImagesPdf.stage(count: 501, bytes: 1) == .ceiling)
        #expect(ImagesPdf.pdfName(for: "IMG_0001.HEIC") == "IMG_0001.pdf")
        #expect(ImagesPdf.pdfName(for: "Scan") == "Scan.pdf")
        #expect(ImagesPdf.defaultSize(region: "US") == .letter)
        #expect(ImagesPdf.defaultSize(region: "CA") == .letter)
        #expect(ImagesPdf.defaultSize(region: "GB") == .a4)
        #expect(ImagesPdf.defaultSize(region: nil) == .a4)
    }

    // MARK: Helpers

    /* A one-image PDF's JPEG stream, from its start of image to its end. */
    static func onlyStream(of pdf: Data) throws -> Data {
        let start = try #require(pdf.range(of: Data([0xFF, 0xD8, 0xFF])))
        let end = try #require(pdf.range(of: Data([0xFF, 0xD9, 0x0A, 0x65, 0x6E, 0x64, 0x73, 0x74, 0x72, 0x65, 0x61, 0x6D])))
        return pdf.subdata(in: start.lowerBound ..< end.lowerBound + 2)
    }

    static func expectedDigest(_ name: String) throws -> String {
        let table = try JSONSerialization.jsonObject(with: try fixture("expected.json")) as? [String: Any]
        let cases = try #require(table?["cut"] as? [[String: Any]])
        return try #require(cases.first { $0["file"] as? String == name }?["sha256"] as? String)
    }

    static func picture(width: Int, height: Int) throws -> CGImage {
        let context = try #require(CGContext(data: nil, width: width, height: height, bitsPerComponent: 8, bytesPerRow: 0,
                                             space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue))
        // CGContext's origin is the bottom left: the top band is at the high y.
        context.setFillColor(CGColor(red: 0.92, green: 0.92, blue: 0.9, alpha: 1))
        context.fill(CGRect(x: 0, y: 0, width: width, height: height))
        context.setFillColor(CGColor(red: 0.86, green: 0.08, blue: 0.08, alpha: 1))
        context.fill(CGRect(x: 0, y: height - height / 6, width: width, height: height / 6))
        context.setFillColor(CGColor(red: 0.08, green: 0.63, blue: 0.16, alpha: 1))
        context.fill(CGRect(x: 0, y: 0, width: width / 8, height: height - height / 6))
        return try #require(context.makeImage())
    }

    /* `image` turned a quarter anticlockwise: what orientation 6 turns back. */
    static func turned(_ image: CGImage) -> CGImage? {
        let context = CGContext(data: nil, width: image.height, height: image.width, bitsPerComponent: 8, bytesPerRow: 0,
                                space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue)
        // A positive angle turns anticlockwise in Core Graphics: the top lands on the left.
        context?.translateBy(x: CGFloat(image.height), y: 0)
        context?.rotate(by: .pi / 2)
        context?.draw(image, in: CGRect(x: 0, y: 0, width: image.width, height: image.height))
        return context?.makeImage()
    }
}
