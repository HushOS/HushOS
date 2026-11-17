import CoreGraphics
import CoreImage
import Foundation
import Testing
@testable import HushOSKit

/*
 * The branded QR code (`BrandQR`). What these hold: every code the apps draw (a link, an approval
 * code), in dots or squares, reads back to exactly its text through the system's own
 * barcode reader with the mark in the middle; it is made at error correction H, which is what pays
 * for the mark; and nothing is drawn under the mark, while the finder squares stay square.
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
        #expect(layout.modules.filter(\.square).count > finder.count)
    }
}
