import Foundation
import ImageIO
import UniformTypeIdentifiers

/* A small JPEG for the Files app and the in-app lists, as the web makes one at upload; nil when the file is not an image or it would not fit. */
public enum Thumbnails {
    public static let maxBytes = 65_536
    public static let side = 256

    public static func make(for fileURL: URL, mime: String?) -> Data? {
        let type = mime.flatMap { UTType(mimeType: $0) } ?? UTType(filenameExtension: fileURL.pathExtension)
        guard let type, type.conforms(to: .image), let source = CGImageSourceCreateWithURL(fileURL as CFURL, nil) else { return nil }
        let options: [CFString: Any] = [
            kCGImageSourceCreateThumbnailFromImageAlways: true,
            kCGImageSourceThumbnailMaxPixelSize: side,
            kCGImageSourceCreateThumbnailWithTransform: true,
        ]
        guard let decoded = CGImageSourceCreateThumbnailAtIndex(source, 0, options as CFDictionary) else { return nil }
        // JPEG has no alpha: transparent images sit on the sheet colour, not on black.
        guard let image = flattened(decoded) else { return nil }
        for quality in [0.7, 0.5, 0.3] {
            let out = NSMutableData()
            guard let destination = CGImageDestinationCreateWithData(out, UTType.jpeg.identifier as CFString, 1, nil) else { return nil }
            CGImageDestinationAddImage(destination, image, [kCGImageDestinationLossyCompressionQuality: quality] as CFDictionary)
            guard CGImageDestinationFinalize(destination) else { return nil }
            if out.length <= maxBytes { return out as Data }
        }
        return nil
    }

    private static func flattened(_ image: CGImage) -> CGImage? {
        guard let context = CGContext(
            data: nil, width: image.width, height: image.height, bitsPerComponent: 8, bytesPerRow: 0,
            space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue
        ) else { return nil }
        context.setFillColor(CGColor(red: 0.988, green: 0.984, blue: 0.969, alpha: 1))
        context.fill(CGRect(x: 0, y: 0, width: image.width, height: image.height))
        context.draw(image, in: CGRect(x: 0, y: 0, width: image.width, height: image.height))
        return context.makeImage()
    }
}
