import CoreGraphics
import CoreImage
import Foundation
import Testing
@testable import HushOSKit

/*
 * The branded QR code (`BrandQR`). What these hold: every code the apps draw (a link, an approval
 * code), in dots or squares, reads back to exactly its text through the system's own
 * barcode reader with the mark in the middle; it is made at error correction H, which is what pays
 * for the mark; nothing is drawn under the mark, while finder and alignment squares stay square;
 * and the pixels show the mark upright, unmirrored and centred, with dots only where asked for.
 */
struct BrandQRTests {
    /* A share link as long as a real one, key in the fragment, and an approval code's payload. */
    static let link = "https://hushos.com/s/5f0c2a9e-4b7d-4c1e-9a3b-2d8e6f1a7c40#k=Qm9vbS1zaGFrYWxha2EtYm9vbS1zaGFrYWxha2EtYm9vbS1zaGFr"
    static let approval = "hushos-approve:7Y2kQ9wPzR4tVb8nLs3aXe6cHd1fGj5mKo0pUq7rSt2uVw9xYz4AbCdEfGhIjKlMnOpQrStUvWxYz0123456789ab"

    /* Core Image's own QR reader: Vision's needs a neural engine the simulator does not have. */
    static func read(_ image: CGImage) throws -> (text: String?, level: CIQRCodeDescriptor.ErrorCorrectionLevel?) {
        let detector = try #require(CIDetector(ofType: CIDetectorTypeQRCode, context: nil, options: [CIDetectorAccuracy: CIDetectorAccuracyHigh]))
        let found = detector.features(in: CIImage(cgImage: image)).first as? CIQRCodeFeature
        return (found?.messageString, found?.symbolDescriptor?.errorCorrectionLevel)
    }

    @Test(arguments: [(BrandQRTests.link, true), (BrandQRTests.link, false), (BrandQRTests.approval, false), (BrandQRTests.approval, true)])
    func readsBackExactly(text: String, dots: Bool) throws {
        let image = try #require(BrandQR.image(text, dots: dots, unit: 6))
        let read = try Self.read(image)
        #expect(read.text == text)
        #expect(read.level == .levelH)
    }

    @Test(arguments: [BrandQRTests.link, BrandQRTests.approval])
    func nothingUnderTheMarkAndFindersStaySquare(text: String) throws {
        let layout = try #require(BrandQR.layout(text))
        // A quarter of the side, odd, centred on whole modules.
        #expect(layout.box % 2 == 1)
        #expect(abs(Double(layout.box) - Double(layout.size) * 0.24) <= 1)
        #expect(layout.from * 2 + layout.box == layout.size)
        #expect(!layout.modules.contains { layout.under($0.x, $0.y) })
        // The modules inside a finder are drawn square; a code this long has alignment squares too.
        let inner = layout.size - 2
        let finder = layout.modules.filter { module in
            let x = module.x - 1, y = module.y - 1
            return (x < 7 && y < 7) || (x >= inner - 7 && y < 7) || (x < 7 && y >= inner - 7)
        }
        #expect(!finder.isEmpty && finder.allSatisfy(\.square))
        // Every alignment square's centre the mark leaves uncovered is drawn, and drawn square.
        let centres = BrandQR.alignmentCentres(version: (inner - 17) / 4, size: inner)
        #expect(!centres.isEmpty)
        for cy in centres {
            for cx in centres where !((cx == 6 && cy == 6) || (cx == 6 && cy == inner - 7) || (cx == inner - 7 && cy == 6) || layout.under(cx + 1, cy + 1)) {
                #expect(layout.modules.first { $0.x == cx + 1 && $0.y == cy + 1 }?.square == true)
            }
        }
    }

    /* A drawn code's pixels, top row first: true where dark. */
    static func dark(_ image: CGImage) throws -> (Int, Int) -> Bool {
        let side = image.width
        let context = try #require(CGContext(data: nil, width: side, height: side, bitsPerComponent: 8, bytesPerRow: side, space: CGColorSpaceCreateDeviceGray(), bitmapInfo: CGImageAlphaInfo.none.rawValue))
        context.draw(image, in: CGRect(x: 0, y: 0, width: side, height: side))
        let data = try #require(context.data)
        let bytes = Array(UnsafeBufferPointer(start: data.bindMemory(to: UInt8.self, capacity: side * side), count: side * side))
        return { x, y in bytes[y * side + x] < 128 }
    }

    /*
     * The mark upright and unmirrored in the middle, as the web places it, and the dots the caller
     * asked for: a scanner reads the code whatever the mark looks like, so only pixels show these.
     */
    @Test(arguments: [true, false])
    func theMarkSitsUprightAndDotsFollowTheChoice(dots: Bool) throws {
        let unit = 12
        let layout = try #require(BrandQR.layout(Self.link))
        let at = try Self.dark(try #require(BrandQR.image(Self.link, dots: dots, unit: unit)))
        // A point on the mark's own 300 × 419 box, through its place on the 539-unit square.
        let scale = Double(layout.box * unit) / 539
        let origin = Double(layout.from * unit)
        func mark(_ x: Double, _ y: Double) -> Bool { at(Int(origin + (119.5 + x) * scale), Int(origin + (60 + y) * scale)) }
        #expect(!mark(214, 20), "the bar's top is white: not upside down")
        #expect(mark(214, 400), "below the bar's foot is the black square")
        #expect(mark(66, 210), "the ring's hole is black")
        #expect(!mark(234, 210), "the arm to the right is white: not mirrored")
        #expect(!at(layout.from * unit + 1, layout.from * unit + 1), "the square's corner is rounded off")
        // A module's corner: inked for a square, left white by a dot.
        let data = try #require(layout.modules.first { !$0.square })
        #expect(at(data.x * unit + 1, data.y * unit + 1) == !dots)
        let fixed = try #require(layout.modules.first { $0.square })
        #expect(at(fixed.x * unit + 1, fixed.y * unit + 1))
    }

    /* The code's rows read back top first: a flipped matrix scans in lenient readers but is a mirror image. */
    @Test func findersSitInTheTopCornersAndBottomLeft() throws {
        let grid = try #require(BrandQR.matrix(Self.link))
        let n = grid.count
        func finder(_ left: Int, _ top: Int) -> Bool {
            (0..<7).allSatisfy { y in (0..<7).allSatisfy { x in grid[top + y][left + x] == (max(abs(x - 3), abs(y - 3)) != 2) } }
        }
        #expect(finder(0, 0) && finder(n - 7, 0) && finder(0, n - 7))
        #expect(!finder(n - 7, n - 7))
    }

    /* The alignment centres ISO/IEC 18004 lists (Annex E), version 32's uneven step among them. */
    @Test(arguments: [
        (1, [Int]()), (2, [6, 18]), (7, [6, 22, 38]), (14, [6, 26, 46, 66]),
        (32, [6, 34, 60, 86, 112, 138]), (40, [6, 30, 58, 86, 114, 142, 170]),
    ])
    func alignmentCentresMatchTheStandard(version: Int, centres: [Int]) {
        #expect(BrandQR.alignmentCentres(version: version, size: 17 + 4 * version) == centres)
    }
}
