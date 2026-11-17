package com.hushos.app.ui

import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Paint
import android.graphics.Path
import android.graphics.RectF
import androidx.core.graphics.PathParser
import com.google.zxing.qrcode.decoder.ErrorCorrectionLevel
import com.google.zxing.qrcode.encoder.Encoder
import kotlin.math.abs
import kotlin.math.ceil
import kotlin.math.roundToInt

/*
 * A QR code with the HushOS mark in the middle, drawn as the web draws it (`QrCode`,
 * apps/web/src/components/qr-code.tsx), so a code from any HushOS app is recognisable as one.
 *
 * Error correction is H, so the modules under the mark (about a quarter of the side, exactly the
 * ones it covers) and round dots cost nothing in reading. The three finder squares and the
 * alignment squares stay square so cameras lock on. Links are drawn in dots; a code another
 * device reads off this screen (approving a sign-in) keeps square modules, as the web's does.
 *
 * Made for what the apps show: links and approval codes, about 90 characters and more. A code for a
 * few characters is so small that the mark takes more than error correction can give back.
 */
internal object BrandQr {
    /* The mark's corner radius on the 539-unit square it is drawn on, and a dot's radius in modules: the web's. */
    private const val MARK_RADIUS = 96f
    private const val DOT = 0.44f
    private const val MARK_SIDE = 539f
    private const val MARK_WIDTH = 300f
    private const val MARK_MARGIN = 60f

    /* One dark module to draw, in the code's own squares (the one-module quiet zone included); `square` for a finder's or alignment square's. */
    data class Module(val x: Int, val y: Int, val square: Boolean)

    /* `size` modules a side with the quiet zone; the mark's square is `box` modules from `from`. */
    class Layout(val size: Int, val box: Int, val from: Int, val modules: List<Module>) {
        fun under(x: Int, y: Int) = x >= from && x < from + box && y >= from && y < from + box
    }

    fun layout(text: String): Layout {
        val code = Encoder.encode(text, ErrorCorrectionLevel.H)
        val matrix = code.matrix
        val inner = matrix.width
        val size = inner + 2
        // About a quarter of the side, odd so it sits on whole modules in the middle.
        val box = (size * 0.24).roundToInt() or 1
        val from = (size - box) / 2
        val centres = code.version.alignmentPatternCenters
        fun fixed(x: Int, y: Int): Boolean {
            // The finder squares in three corners.
            if ((x < 7 && y < 7) || (x >= inner - 7 && y < 7) || (x < 7 && y >= inner - 7)) return true
            // The alignment squares, but for the ones the finders take.
            for (cy in centres) for (cx in centres) {
                val corner = (cx == 6 && cy == 6) || (cx == 6 && cy == inner - 7) || (cx == inner - 7 && cy == 6)
                if (!corner && abs(x - cx) <= 2 && abs(y - cy) <= 2) return true
            }
            return false
        }
        val shape = Layout(size, box, from, emptyList())
        val modules = buildList {
            for (y in 0 until inner) for (x in 0 until inner) {
                // Exactly the modules under the mark, no more: every one left out costs error correction.
                if (matrix.get(x, y).toInt() != 1 || shape.under(x + 1, y + 1)) continue
                add(Module(x + 1, y + 1, fixed(x, y)))
            }
        }
        return Layout(size, box, from, modules)
    }

    /* The code drawn black on white, at least `side` pixels across in whole pixels a module: dots for a link, squares for a code read off this screen. */
    fun bitmap(text: String, dots: Boolean, side: Int): Bitmap {
        val layout = layout(text)
        val unit = ceil(side.toFloat() / layout.size).toInt().coerceAtLeast(1)
        val pixels = layout.size * unit
        val bitmap = Bitmap.createBitmap(pixels, pixels, Bitmap.Config.ARGB_8888)
        val canvas = Canvas(bitmap)
        canvas.drawColor(android.graphics.Color.WHITE)
        val ink = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = android.graphics.Color.BLACK }
        val u = unit.toFloat()
        for (module in layout.modules) {
            val left = module.x * u
            val top = module.y * u
            if (dots && !module.square) canvas.drawCircle(left + u / 2, top + u / 2, u * DOT, ink)
            else canvas.drawRect(left, top, left + u, top + u, ink)
        }
        // The mark: a black rounded square, the white mark centred in it.
        val size = layout.box * u
        val scale = size / MARK_SIDE
        val origin = layout.from * u
        canvas.drawRoundRect(RectF(origin, origin, origin + size, origin + size), MARK_RADIUS * scale, MARK_RADIUS * scale, ink)
        canvas.save()
        canvas.translate(origin + (MARK_SIDE - MARK_WIDTH) / 2 * scale, origin + MARK_MARGIN * scale)
        canvas.scale(scale, scale)
        val paper = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = android.graphics.Color.WHITE }
        // Each part on its own: the bar crosses the key's arm, and one even-odd path would cut a hole there.
        for (part in mark) canvas.drawPath(part, paper)
        canvas.restore()
        return bitmap
    }

    /* The mark's parts, brand.ts's LOGO_PATHS and LOGO_BAR, on its own 300 × 419 box. */
    private val mark: List<Path> by lazy {
        listOf(
                "M66 59C54.9543 59 46 67.9543 46 79V149C46 160.046 54.9543 169 66 169C77.0457 169 86 160.046 86 149V79C86 67.9543 77.0457 59 66 59ZM66 251C54.9543 251 46 259.954 46 271V399C46 410.046 54.9543 419 66 419C77.0457 419 86 410.046 86 399V271C86 259.954 77.0457 251 66 251Z",
                "M140 30C128.954 30 120 38.9543 120 50V135C120 146.046 128.954 155 140 155C151.046 155 160 146.046 160 135V50C160 38.9543 151.046 30 140 30ZM140 265C128.954 265 120 273.954 120 285V370C120 381.046 128.954 390 140 390C151.046 390 160 381.046 160 370V285C160 273.954 151.046 265 140 265Z",
                "M128.915 230C120.444 256.674 95.4788 276 66 276C29.5492 276 0 246.451 0 210C0 173.549 29.5492 144 66 144C95.4788 144 120.444 163.326 128.915 190L280 190C291.046 190 300 198.954 300 210V260C300 271.046 291.046 280 280 280C268.954 280 260 271.046 260 260V230L128.915 230ZM106 210C106 232.091 88.0914 250 66 250C43.9086 250 26 232.091 26 210C26 187.909 43.9086 170 66 170C88.0914 170 106 187.909 106 210Z",
        ).map { d -> PathParser.createPathFromPathData(d).apply { fillType = Path.FillType.EVEN_ODD } } +
            Path().apply { addRoundRect(RectF(194f, 0f, 234f, 360f), 20f, 20f, Path.Direction.CW) }
    }
}
