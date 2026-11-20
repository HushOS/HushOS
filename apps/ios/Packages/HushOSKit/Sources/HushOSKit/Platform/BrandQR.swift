import CoreGraphics
import CoreImage
import CoreImage.CIFilterBuiltins
import Foundation

/*
 * A QR code with the HushOS mark in the middle, drawn as the web draws it (`QrCode`,
 * apps/web/src/components/marks/qr-code.tsx), so a code from any HushOS app is recognisable as one.
 *
 * Error correction is H, so the modules under the mark (about a quarter of the side, exactly the
 * ones it covers) and round dots cost nothing in reading. The three finder squares and the
 * alignment squares stay square so cameras lock on. Links are drawn in dots; a code another
 * device reads off this screen (approving a sign-in) keeps square modules, as the web's does.
 *
 * Made for what the apps show: links and approval codes, about 90 characters and more. A code for a
 * few characters is so small that the mark takes more than error correction can give back.
 */
public enum BrandQR {
    /* The mark's corner radius on the 539-unit square it is drawn on, and a dot's radius in modules: the web's. */
    static let markRadius: CGFloat = 96
    static let dot: CGFloat = 0.44
    static let markSide: CGFloat = 539
    static let markWidth: CGFloat = 300
    static let markMargin: CGFloat = 60

    /* One dark module to draw, in the code's own squares (the one-module quiet zone included). */
    public struct Module: Equatable, Sendable {
        public let x: Int
        public let y: Int
        /* A finder or alignment square's: always drawn square. */
        public let square: Bool
    }

    public struct Layout: Sendable {
        /* Modules a side, the one-module quiet zone included. */
        public let size: Int
        /* The mark's square: its side and where it starts, in modules. */
        public let box: Int
        public let from: Int
        public let modules: [Module]

        public func under(_ x: Int, _ y: Int) -> Bool {
            x >= from && x < from + box && y >= from && y < from + box
        }
    }

    /* The code's modules and where the mark sits, or nil for text no code holds. */
    public static func layout(_ text: String) -> Layout? {
        guard let grid = matrix(text) else { return nil }
        let inner = grid.count
        let size = inner + 2
        // About a quarter of the side, odd so it sits on whole modules in the middle.
        let box = Int((Double(size) * 0.24).rounded(.toNearestOrAwayFromZero)) | 1
        let from = (size - box) / 2
        let version = (inner - 17) / 4
        let centres = alignmentCentres(version: version, size: inner)
        func fixed(_ x: Int, _ y: Int) -> Bool {
            // The finder squares in three corners.
            if (x < 7 && y < 7) || (x >= inner - 7 && y < 7) || (x < 7 && y >= inner - 7) { return true }
            // The alignment squares, but for the ones the finders take.
            for cy in centres {
                for cx in centres {
                    let corner = (cx == 6 && cy == 6) || (cx == 6 && cy == inner - 7) || (cx == inner - 7 && cy == 6)
                    if !corner && abs(x - cx) <= 2 && abs(y - cy) <= 2 { return true }
                }
            }
            return false
        }
        var modules: [Module] = []
        let layout = Layout(size: size, box: box, from: from, modules: [])
        for y in 0..<inner {
            for x in 0..<inner where grid[y][x] {
                // Exactly the modules under the mark, no more: every one left out costs error correction.
                if layout.under(x + 1, y + 1) { continue }
                modules.append(Module(x: x + 1, y: y + 1, square: fixed(x, y)))
            }
        }
        return Layout(size: size, box: box, from: from, modules: modules)
    }

    /*
     * The code drawn black on white, `unit` pixels a module, its one-module quiet zone included:
     * dots for a link, squares for a code read off this screen.
     */
    public static func image(_ text: String, dots: Bool, unit: Int = 12) -> CGImage? {
        guard let layout = layout(text), unit > 0 else { return nil }
        let side = layout.size * unit
        guard let context = CGContext(
            data: nil, width: side, height: side, bitsPerComponent: 8, bytesPerRow: 0,
            space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue
        ) else { return nil }
        // Top-left origin, as the web's drawing has it.
        context.translateBy(x: 0, y: CGFloat(side))
        context.scaleBy(x: 1, y: -1)
        let u = CGFloat(unit)
        context.setFillColor(CGColor(gray: 1, alpha: 1))
        context.fill(CGRect(x: 0, y: 0, width: side, height: side))
        context.setFillColor(CGColor(gray: 0, alpha: 1))
        for module in layout.modules {
            let rect = CGRect(x: CGFloat(module.x) * u, y: CGFloat(module.y) * u, width: u, height: u)
            if dots && !module.square {
                context.fillEllipse(in: rect.insetBy(dx: u * (0.5 - dot), dy: u * (0.5 - dot)))
            } else {
                context.fill(rect)
            }
        }
        // The mark: a black rounded square, the white mark centred in it.
        let size = CGFloat(layout.box) * u
        let scale = size / markSide
        let origin = CGFloat(layout.from) * u
        context.addPath(CGPath(
            roundedRect: CGRect(x: origin, y: origin, width: size, height: size),
            cornerWidth: markRadius * scale, cornerHeight: markRadius * scale, transform: nil
        ))
        context.fillPath()
        context.translateBy(x: origin + (markSide - markWidth) / 2 * scale, y: origin + markMargin * scale)
        context.scaleBy(x: scale, y: scale)
        context.setFillColor(CGColor(gray: 1, alpha: 1))
        // Each part on its own: the bar crosses the key's arm, and one even-odd path would cut a hole there.
        for part in mark {
            context.addPath(part)
            context.fillPath(using: .evenOdd)
        }
        return context.makeImage()
    }

    /* The mark's parts, brand.ts's LOGO_PATHS and LOGO_BAR, on its own 300 × 419 box. */
    // CGPath is immutable once made, so sharing these across threads is safe; Swift cannot see that.
    nonisolated(unsafe) static let mark: [CGPath] = {
        var parts: [CGPath] = []
        for d in [
            "M66 59C54.9543 59 46 67.9543 46 79V149C46 160.046 54.9543 169 66 169C77.0457 169 86 160.046 86 149V79C86 67.9543 77.0457 59 66 59ZM66 251C54.9543 251 46 259.954 46 271V399C46 410.046 54.9543 419 66 419C77.0457 419 86 410.046 86 399V271C86 259.954 77.0457 251 66 251Z",
            "M140 30C128.954 30 120 38.9543 120 50V135C120 146.046 128.954 155 140 155C151.046 155 160 146.046 160 135V50C160 38.9543 151.046 30 140 30ZM140 265C128.954 265 120 273.954 120 285V370C120 381.046 128.954 390 140 390C151.046 390 160 381.046 160 370V285C160 273.954 151.046 265 140 265Z",
            "M128.915 230C120.444 256.674 95.4788 276 66 276C29.5492 276 0 246.451 0 210C0 173.549 29.5492 144 66 144C95.4788 144 120.444 163.326 128.915 190L280 190C291.046 190 300 198.954 300 210V260C300 271.046 291.046 280 280 280C268.954 280 260 271.046 260 260V230L128.915 230ZM106 210C106 232.091 88.0914 250 66 250C43.9086 250 26 232.091 26 210C26 187.909 43.9086 170 66 170C88.0914 170 106 187.909 106 210Z",
        ] {
            let path = CGMutablePath()
            addSVG(d, to: path)
            parts.append(path)
        }
        parts.append(CGPath(roundedRect: CGRect(x: 194, y: 0, width: 40, height: 360), cornerWidth: 20, cornerHeight: 20, transform: nil))
        return parts
    }()

    /* The absolute commands the mark's paths use: M, L, H, V, C and Z. */
    static func addSVG(_ d: String, to path: CGMutablePath) {
        var tokens: [String] = []
        var number = ""
        for character in d {
            if character.isLetter {
                if !number.isEmpty { tokens.append(number); number = "" }
                tokens.append(String(character))
            } else if character == " " || character == "," {
                if !number.isEmpty { tokens.append(number); number = "" }
            } else {
                number.append(character)
            }
        }
        if !number.isEmpty { tokens.append(number) }
        var index = 0
        var command = ""
        var current = CGPoint.zero
        func next() -> CGFloat { defer { index += 1 }; return CGFloat(Double(tokens[index]) ?? 0) }
        while index < tokens.count {
            if tokens[index].first?.isLetter == true { command = tokens[index]; index += 1 }
            switch command {
            case "M": current = CGPoint(x: next(), y: next()); path.move(to: current); command = "L"
            case "L": current = CGPoint(x: next(), y: next()); path.addLine(to: current)
            case "H": current.x = next(); path.addLine(to: current)
            case "V": current.y = next(); path.addLine(to: current)
            case "C":
                let one = CGPoint(x: next(), y: next())
                let two = CGPoint(x: next(), y: next())
                current = CGPoint(x: next(), y: next())
                path.addCurve(to: current, control1: one, control2: two)
            // A number straight after Z belongs to no command: skipped, never read again.
            case "Z": path.closeSubpath(); command = ""
            default: index += 1
            }
        }
    }

    /* One Core Image context for every code: making one costs about as much as drawing the code. */
    static let renderer = CIContext(options: [.workingColorSpace: NSNull()])

    /* The code's modules at error correction H, without a quiet zone: CoreImage's encoder, read back module by module. */
    static func matrix(_ text: String) -> [[Bool]]? {
        let filter = CIFilter.qrCodeGenerator()
        filter.message = Data(text.utf8)
        filter.correctionLevel = "H"
        guard let output = filter.outputImage else { return nil }
        let width = Int(output.extent.width)
        let height = Int(output.extent.height)
        guard width == height, width > 0 else { return nil }
        // The context owns its buffer: one handed in from Swift is only valid during the call that takes it.
        guard let space = CGColorSpace(name: CGColorSpace.linearGray),
              let rendered = renderer.createCGImage(output, from: output.extent),
              let context = CGContext(data: nil, width: width, height: height, bitsPerComponent: 8, bytesPerRow: width, space: space, bitmapInfo: CGImageAlphaInfo.none.rawValue)
        else { return nil }
        context.setFillColor(CGColor(gray: 1, alpha: 1))
        context.fill(CGRect(x: 0, y: 0, width: width, height: height))
        context.draw(rendered, in: CGRect(x: 0, y: 0, width: width, height: height))
        // The buffer is the context's: it stays alive until every read of it is done.
        return withExtendedLifetime(context) { () -> [[Bool]]? in
            guard let data = context.data else { return nil }
            let stride = context.bytesPerRow
            let pixels = data.bindMemory(to: UInt8.self, capacity: stride * height)
            // CoreImage leaves a quiet zone of its own: find the first dark module, the finder's corner.
            var border = -1
            for i in 0..<width where pixels[i * stride + i] < 128 { border = i; break }
            guard border >= 0 else { return nil }
            let inner = width - 2 * border
            guard inner >= 21, (inner - 17) % 4 == 0 else { return nil }
            // CGContext rows run top to bottom in memory here, as the code's do.
            return (0..<inner).map { y in (0..<inner).map { x in pixels[(y + border) * stride + x + border] < 128 } }
        }
    }

    /* Where a version's alignment squares are centred, on each axis (ISO/IEC 18004, as qrcodegen works it out). */
    static func alignmentCentres(version: Int, size: Int) -> [Int] {
        guard version >= 2 else { return [] }
        let count = version / 7 + 2
        let step = version == 32 ? 26 : (version * 4 + count * 2 + 1) / (count * 2 - 2) * 2
        var centres = [Int](repeating: 6, count: count)
        var position = size - 7
        for index in stride(from: count - 1, through: 1, by: -1) {
            centres[index] = position
            position -= step
        }
        return centres
    }
}
