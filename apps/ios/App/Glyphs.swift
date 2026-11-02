import HushOSKit
import SwiftUI

/*
 * The marks and sizes the app and Save to HushOS (the share extension) both draw:
 * a folder of two solid sheets, a page with its type, and byte counts as the web writes them.
 */

/*
 * Two solid sheets, back darker than front (viewBox 56 x 46): Hush blue, or a folder's
 * own colour (FolderGlyph(folder:), in the app).
 */
struct FolderGlyph: View {
    var front: Color = Alpine.folderFront
    var back: Color = Alpine.folderBack

    var body: some View {
        Canvas { context, size in
            let sx = size.width / 56, sy = size.height / 46
            var back = Path()
            back.move(to: CGPoint(x: 0, y: 6 * sy))
            back.addArc(tangent1End: CGPoint(x: 0, y: 0), tangent2End: CGPoint(x: 6 * sx, y: 0), radius: 6 * sx)
            back.addLine(to: CGPoint(x: 20 * sx, y: 0))
            back.addLine(to: CGPoint(x: 26 * sx, y: 6 * sy))
            back.addLine(to: CGPoint(x: 50 * sx, y: 6 * sy))
            back.addArc(tangent1End: CGPoint(x: 56 * sx, y: 6 * sy), tangent2End: CGPoint(x: 56 * sx, y: 12 * sy), radius: 6 * sx)
            back.addLine(to: CGPoint(x: 56 * sx, y: 40 * sy))
            back.addArc(tangent1End: CGPoint(x: 56 * sx, y: 46 * sy), tangent2End: CGPoint(x: 50 * sx, y: 46 * sy), radius: 6 * sx)
            back.addLine(to: CGPoint(x: 6 * sx, y: 46 * sy))
            back.addArc(tangent1End: CGPoint(x: 0, y: 46 * sy), tangent2End: CGPoint(x: 0, y: 40 * sy), radius: 6 * sx)
            back.closeSubpath()
            context.fill(back, with: .color(self.back))
            let front = Path(roundedRect: CGRect(x: 0, y: 8 * sy, width: 56 * sx, height: 38 * sy), cornerRadius: 6 * sx)
            context.fill(front, with: .color(self.front))
        }
    }
}

/* A white page with a turned corner and a type label, or ruled lines when there is no type (viewBox 44 x 54). */
struct PageGlyph: View {
    let label: String?
    /* The label's colour and the sheet's edge and fill: ink and the plain sheet, or a type's own (init(label:name:)). */
    var ink: Color = Alpine.ink
    var edge: Color = Alpine.field
    var fill: Color = Alpine.surface

    var body: some View {
        GeometryReader { geo in
            let sx = geo.size.width / 44, sy = geo.size.height / 54
            ZStack(alignment: .topLeading) {
                Canvas { context, _ in
                    var sheet = Path()
                    sheet.move(to: CGPoint(x: 4 * sx, y: 1 * sy))
                    sheet.addLine(to: CGPoint(x: 29.6 * sx, y: 1 * sy))
                    sheet.addLine(to: CGPoint(x: 43 * sx, y: 14.4 * sy))
                    sheet.addLine(to: CGPoint(x: 43 * sx, y: 50 * sy))
                    sheet.addArc(tangent1End: CGPoint(x: 43 * sx, y: 53 * sy), tangent2End: CGPoint(x: 40 * sx, y: 53 * sy), radius: 3 * sx)
                    sheet.addLine(to: CGPoint(x: 4 * sx, y: 53 * sy))
                    sheet.addArc(tangent1End: CGPoint(x: 1 * sx, y: 53 * sy), tangent2End: CGPoint(x: 1 * sx, y: 50 * sy), radius: 3 * sx)
                    sheet.addLine(to: CGPoint(x: 1 * sx, y: 4 * sy))
                    sheet.addArc(tangent1End: CGPoint(x: 1 * sx, y: 1 * sy), tangent2End: CGPoint(x: 4 * sx, y: 1 * sy), radius: 3 * sx)
                    sheet.closeSubpath()
                    context.fill(sheet, with: .color(fill))
                    context.stroke(sheet, with: .color(edge), lineWidth: 1.5)
                    var fold = Path()
                    fold.move(to: CGPoint(x: 29.5 * sx, y: 1 * sy))
                    fold.addLine(to: CGPoint(x: 29.5 * sx, y: 11 * sy))
                    fold.addQuadCurve(to: CGPoint(x: 33 * sx, y: 14.5 * sy), control: CGPoint(x: 29.5 * sx, y: 14.5 * sy))
                    fold.addLine(to: CGPoint(x: 43 * sx, y: 14.5 * sy))
                    context.stroke(fold, with: .color(edge), lineWidth: 1.5)
                    if label == nil {
                        for (y, w) in [(22.0, 22.0), (29.0, 27.0), (36.0, 18.0)] {
                            context.fill(Path(roundedRect: CGRect(x: 8 * sx, y: y * sy, width: w * sx, height: 3 * sy), cornerRadius: 1.5 * sx), with: .color(Alpine.rule))
                        }
                    }
                }
                if let label {
                    Text(label)
                        .font(.system(size: max(6, 7.5 * sx), weight: .bold))
                        .foregroundStyle(Alpine.surface)
                        .lineLimit(1).minimumScaleFactor(0.6)
                        .frame(width: 30 * sx, height: 13 * sy)
                        .background(ink, in: RoundedRectangle(cornerRadius: 3 * sx))
                        .offset(x: 4.5 * sx, y: 34 * sy)
                }
            }
        }
    }
}

extension PageGlyph {
    /*
     * A page in its type's colour, from the file's name: the shades the Rust core works out
     * (sheet_shades), the label in every scheme and the sheet faintly tinted, which high contrast
     * leaves plain. A type with no colour of its own keeps ink and the plain sheet (the web's SheetMark).
     */
    init(label: String?, name: String) {
        self.init(label: label)
        guard let shades = sheetShades(name: name) else { return }
        ink = Color(alpineLight: shades.lightLabel, dark: shades.darkLabel, lightHigh: shades.lightHighLabel, darkHigh: shades.darkHighLabel)
        edge = Self.tint(light: shades.lightEdge, dark: shades.darkEdge, plain: Alpine.field)
        fill = Self.tint(light: shades.lightFill, dark: shades.darkFill, plain: Alpine.surface)
    }

    private static func tint(light: UInt32, dark: UInt32, plain: Color) -> Color {
        let tinted = UIColor(Color(alpineLight: light, dark: dark, lightHigh: light, darkHigh: dark))
        let untinted = UIColor(plain)
        return Color(uiColor: UIColor { traits in
            (traits.accessibilityContrast == .high ? untinted : tinted).resolvedColor(with: traits)
        })
    }
}

/* The web's rule (apps/web/src/lib/drive.ts formatBytes): counted in 1024s, labelled KB, MB, GB, TB; whole numbers from 100 up. */
func formatBytes(_ value: Int64) -> String {
    let units = ["B", "KB", "MB", "GB", "TB"]
    var n = Double(max(value, 0))
    var unit = 0
    while n >= 1024 && unit < units.count - 1 { n /= 1024; unit += 1 }
    if unit == 0 { return "\(Int(n)) B" }
    return n >= 100 ? "\(Int(n.rounded())) \(units[unit])" : String(format: "%.1f %@", n, units[unit])
}
