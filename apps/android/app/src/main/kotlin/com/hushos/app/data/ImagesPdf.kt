package com.hushos.app.data

import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.ImageDecoder
import com.hushos.core.ImagesPdfException
import com.hushos.core.ImagesPdfWriter
import com.hushos.core.PageSize
import com.hushos.core.PlannedResult
import com.hushos.core.RunControl
import com.hushos.core.imagesPdfLimits
import com.hushos.core.imagesPdfMaxPixels
import java.io.ByteArrayOutputStream
import java.nio.ByteBuffer
import java.util.Locale
import java.util.concurrent.atomic.AtomicReference

/*
 * Convert, then One PDF (docs/file-tools-design.md, feature (b)), as the web makes it: the images in
 * the order chosen, a page each, built by the core's writer (ImagesPdfWriter), so a JPEG goes in
 * byte for byte with its location and camera details cut and its orientation turned on the page.
 * Anything else is decoded here with ImageDecoder, which reads HEIC: a PNG, or any image with
 * transparency, goes in as its pixels with a soft mask; the rest as JPEG at quality 92. The PDF is
 * saved as a new file beside the images, under the next free name, through the save path
 * (SaveRuns), signed as the weakest of them. The work is a tool run (ToolRuns): one at a time, the
 * watchdog over it, and a cancel at any point leaves nothing.
 */
object ImagesPdf {
    val limits = imagesPdfLimits()

    enum class Stage { FINE, OFFER, CEILING }

    /* Fine, worth a word first past 64 MB (the large-file card), or more than one PDF takes. */
    fun stage(count: Int, bytes: Long): Stage = when {
        count > limits.maxImages.toInt() || bytes.toULong() > limits.maxInputBytes -> Stage.CEILING
        bytes.toULong() > limits.cardBytes -> Stage.OFFER
        else -> Stage.FINE
    }

    /* The most pixels one image may be decoded to on this device: a sixty-fourth of its memory, 16 to 100 megapixels. */
    fun maxPixels(deviceMemory: Long): Long = imagesPdfMaxPixels(deviceMemory.toULong()).toLong()

    private val EXTENSIONS = setOf("jpg", "jpeg", "jpe", "jfif", "png", "heic", "heif", "webp", "avif", "gif", "bmp")
    private val TYPES = setOf(
        "image/jpeg", "image/pjpeg", "image/png", "image/heic", "image/heif", "image/webp", "image/avif", "image/gif",
        "image/bmp", "image/x-ms-bmp",
    )

    /* An image a PDF takes, by its recorded type or its name: as the web's `pdfable`. */
    fun takes(item: Opened): Boolean {
        if (item.isFolder) return false
        item.metadata.mime?.lowercase()?.let { if (it in TYPES) return true }
        return item.name.substringAfterLast('.', "").lowercase() in EXTENSIONS
    }

    /* The first image's name with `.pdf` in place of its extension. */
    fun pdfName(first: String): String {
        val dot = first.lastIndexOf('.')
        val base = (if (dot > 0) first.substring(0, dot) else first).trim()
        return "${base.ifEmpty { "Images" }}.pdf"
    }

    /* Letter in the US and Canada, A4 everywhere else. */
    fun defaultSize(region: String? = Locale.getDefault().country): PageSize =
        if (region == "US" || region == "CA") PageSize.LETTER else PageSize.A4

    /* The person's words for a refusal, naming the image it met. */
    fun words(code: String, name: String): String = when (code) {
        "unsupported" -> "“$name” is a kind of JPEG HushOS can’t put in a PDF."
        "too-many-pixels" -> "“$name” is too large to put in a PDF on this device."
        "too-large" -> "The PDF would be too large to make on this phone. Choose fewer images."
        else -> "“$name” is damaged, or isn’t an image HushOS can put in a PDF."
    }

    class Made(val pdf: ByteArray, val thumbnail: ByteArray?)

    /*
     * The PDF from the images `read` hands over one at a time (blocking, on the run's thread), in the
     * order of `names`. Every core call is under `control`, which a cancel or the watchdog ends.
     */
    fun build(names: List<String>, size: PageSize, margin: Boolean, maxPixels: Long, control: RunControl,
              read: (Int) -> ByteArray, progress: (Int) -> Unit = {}, maxOutput: Long = Long.MAX_VALUE): Made {
        // Closed however the build ends (a refusal, a Stop): the partial PDF's plaintext goes with it, not when collected.
        ImagesPdfWriter(size, margin).use { writer -> return buildWith(writer, names, maxPixels, control, read, progress, maxOutput) }
    }

    private fun buildWith(writer: ImagesPdfWriter, names: List<String>, maxPixels: Long, control: RunControl,
                          read: (Int) -> ByteArray, progress: (Int) -> Unit, maxOutput: Long): Made {
        // The PDF comes back as one array on this app's heap: never larger than it can take.
        writer.limitOutput(maxOutput.coerceAtLeast(0).toULong())
        var thumbnail: ByteArray? = null
        names.forEachIndexed { index, name ->
            val bytes = try {
                read(index)
            } catch (refused: Images.Refused) {
                throw ImagesPdfRefused(words(refused.code, name))
            }
            if (index == 0) thumbnail = Images.thumbnail(bytes)
            try {
                if (Images.isJpeg(bytes)) writer.addJpeg(bytes, control)
                else when (val decoded = Images.decode(bytes, maxPixels)) {
                    is Images.Decoded.Jpeg -> writer.addJpeg(decoded.bytes, control)
                    is Images.Decoded.Pixels -> writer.addPixels(decoded.rgba, decoded.width.toUInt(), decoded.height.toUInt(), false, control)
                }
            } catch (refused: ImagesPdfException.Refused) {
                throw ImagesPdfRefused(words(refused.code, name))
            } catch (refused: Images.Refused) {
                throw ImagesPdfRefused(words(refused.code, name))
            }
            progress(index + 1)
        }
        return try {
            Made(writer.finish(), thumbnail)
        } catch (refused: ImagesPdfException.Refused) {
            throw ImagesPdfRefused(words(refused.code, names.firstOrNull().orEmpty()))
        }
    }

    /* Images from more than one folder (search results can hold them): refused, never converted in part. */
    const val MIXED_FOLDERS = "These images are in different folders. Make a PDF from one folder at a time."

    /* Whether every image is in one folder of one workspace, where the PDF goes. */
    fun oneFolder(images: List<Opened>): Boolean {
        val first = images.firstOrNull() ?: return false
        return images.all { it.node.parentId == first.node.parentId && it.node.workspaceId == first.node.workspaceId }
    }

    /* The most one read asks of a version reader: the core refuses a read past 64 MiB. */
    const val READ_PIECE: Long = 8L shl 20

    /* A file's `size` bytes, read in pieces of at most `piece`, never in one read the core would refuse. */
    fun readWhole(size: Long, piece: Long = READ_PIECE, maxBytes: Long = Long.MAX_VALUE,
                  read: (offset: Long, length: Long) -> ByteArray): ByteArray {
        // One array on the app's heap: refused when it can't take it, before a byte is read.
        if (size > maxBytes) throw Images.Refused("too-many-pixels")
        val out = ByteArray(Math.toIntExact(size))
        var offset = 0L
        while (offset < size) {
            val part = read(offset, minOf(piece, size - offset))
            if (part.isEmpty()) throw ToolFailed()
            part.copyInto(out, offset.toInt())
            offset += part.size
        }
        return out
    }

    /*
     * The most pixels one image may be decoded to here: the core's cap from the device's memory, and
     * what the app's own heap holds, since the decoded RGBA is a Java array beside the image's file and
     * the PDF so far: a third of the heap for it, at four bytes a pixel.
     */
    fun maxPixels(deviceMemory: Long, heapBytes: Long): Long = minOf(maxPixels(deviceMemory), heapBytes / 3 / 4)

    /*
     * A PDF's charge in ToolRuns.budget: taken on the run's thread, given back exactly once, however the run
     * ends. Once released it stays released: a charge taken after that (the run's thread still producing
     * when Stop already returned to the caller) is given back at once, never left for nobody to release.
     */
    class Lease(private val giveBack: (ULong, ULong) -> Unit = { bytes, generation -> ToolRuns.budget.release(bytes, generation) }) {
        private var held: Pair<ULong, ULong>? = null
        private var released = false

        fun take(bytes: ULong, generation: ULong) {
            val late = synchronized(this) {
                if (!released) held = bytes to generation
                released
            }
            if (late) giveBack(bytes, generation)
        }

        fun release() {
            val charge = synchronized(this) {
                released = true
                held.also { held = null }
            }
            charge?.let { (bytes, generation) -> giveBack(bytes, generation) }
        }
    }

    /* Stopped (Stop, or the sheet's work cancelled) after the PDF landed: the run's clean-up removes it. */
    class StoppedWhileSaving : Exception("Stopped.")

    /*
     * The made PDF saved in `run` as a new file, unless `stillOn` turns false first (Stop): then its
     * upload is never completed (holdTo), and one that landed just before is refused here, so the
     * caller's cancel of the run removes it. Nothing stays that the person stopped.
     */
    fun saveMade(run: SaveRun, made: Made, name: String, sources: SaveSources, folder: Opened, stillOn: () -> Boolean): Opened {
        run.holdTo(stillOn)
        val saved = run.file(made.pdf, name, "application/pdf", sources, made.thumbnail, folder)
        if (!stillOn()) throw StoppedWhileSaving()
        TextSave.end(run)
        return saved
    }

    /*
     * One PDF of `images` into `folder` as `name` (the next free one there): the room checked and the
     * run recorded first, the PDF built in a tool run, then saved. Blocking but for the run, which
     * suspends; call it from a coroutine on Dispatchers.IO. Any failure, a cancel included (through the
     * upload: `stillOn` is the calling job), cleans up what was made and throws: SaveRefused (nothing was
     * started), ImagesPdfRefused, NotAuthenticated (a 401 under a read), CancellationException (after the
     * clean-up), ToolFailed or SaveRunStopped.
     */
    suspend fun make(writer: VaultSaveWriter, vault: Vault, journal: SaveRunJournal, images: List<Opened>, folder: Opened,
                     size: PageSize, margin: Boolean, name: String, deviceMemory: Long, heapBytes: Long,
                     progress: (Int, Int) -> Unit = { _, _ -> }, stopped: (SaveRunStopped) -> Unit = {}): Opened {
        if (!oneFolder(images) || images.any { it.node.parentId != folder.id }) throw ImagesPdfRefused(MIXED_FOLDERS)
        val job = kotlinx.coroutines.currentCoroutineContext()[kotlinx.coroutines.Job]
        val stillOn = { job?.isActive != false }
        val total = images.sumOf { it.size ?: 0L }
        val run = SaveRun.start(writer, listOf(folder), listOf(PlannedResult.FromSources(total.toULong(), true)), journal)
        val lease = Lease()
        try {
            val sources = SaveSources.From(images.flatMap { (writer.copySources(it) as SaveSources.From).sources })
            val refusal = AtomicReference<ImagesPdfRefused?>(null)
            // A 401 renewing an address mid-read: thrown as itself, for the session check, not as the core's read failure.
            val session = AtomicReference<NotAuthenticated?>(null)
            val maxPixels = maxPixels(deviceMemory, heapBytes)
            val made = try {
                ToolRuns.shared.run("Making $name") { control ->
                    try {
                        val made = build(images.map { it.name }, size, margin, maxPixels, control, read = { index ->
                            // Each reader let go of (its chunks and key) as soon as its image is read.
                            vault.toolReader(images[index], control, refused = session).use { reader ->
                                readWhole(reader.size().toLong(), maxBytes = heapBytes / 3) { offset, length ->
                                    reader.readAt(offset.toULong(), length.toULong())
                                }
                            }
                        }, progress = { progress(it, images.size) }, maxOutput = heapBytes / 3)
                        // Waits while the process holds 512 MB of results not yet uploaded.
                        lease.take(made.pdf.size.toULong(), ToolRuns.budget.produce(made.pdf.size.toULong(), control))
                        made
                    } catch (refused: ImagesPdfRefused) {
                        refusal.set(refused)
                        throw refused
                    }
                }
            } catch (error: ToolFailed) {
                throw session.get() ?: refusal.get() ?: error
            }
            progress(images.size, images.size)
            return saveMade(run, made, name, sources, folder, stillOn)
        } catch (error: Throwable) {
            // How it stopped is said even when the caller was cancelled, which rethrows the cancel itself.
            val how = run.cancel()
            stopped(how)
            if (error is kotlinx.coroutines.CancellationException || error is StoppedWhileSaving) throw how
            throw error
        } finally {
            // Its room in the budget goes back once the save has it, or the run ended without it.
            lease.release()
        }
    }

    /* ImageDecoder for what a PDF can't take as it is: the step image conversion's module replaces on the web. */
    object Images {
        class Refused(val code: String) : Exception(code)

        sealed interface Decoded {
            class Jpeg(val bytes: ByteArray) : Decoded
            /* RGBA, not premultiplied, upright. */
            class Pixels(val rgba: ByteArray, val width: Int, val height: Int) : Decoded
        }

        fun isJpeg(bytes: ByteArray) = bytes.size > 2 && bytes[0] == 0xFF.toByte() && bytes[1] == 0xD8.toByte() && bytes[2] == 0xFF.toByte()
        fun isPng(bytes: ByteArray) = bytes.size > 7 &&
            byteArrayOf(0x89.toByte(), 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A).withIndex().all { (i, b) -> bytes[i] == b }

        /*
         * Decoded upright (ImageDecoder applies the orientation), refused past `maxPixels` from the
         * header, before a pixel is made. A PNG, or anything with a transparent pixel, comes back as
         * pixels; the rest as JPEG at 92.
         */
        fun decode(bytes: ByteArray, maxPixels: Long): Decoded {
            val bitmap = try {
                ImageDecoder.decodeBitmap(ImageDecoder.createSource(ByteBuffer.wrap(bytes))) { decoder, info, _ ->
                    if (info.size.width.toLong() * info.size.height.toLong() > maxPixels) throw Refused("too-many-pixels")
                    decoder.allocator = ImageDecoder.ALLOCATOR_SOFTWARE
                    decoder.isUnpremultipliedRequired = true
                }
            } catch (refused: Refused) {
                throw refused
            } catch (_: Exception) {
                throw Refused("damaged")
            }
            try {
                // Opaque and not a PNG: compressed straight from the bitmap, no copy of its pixels on the heap.
                if (!isPng(bytes) && !transparent(bitmap)) return Decoded.Jpeg(jpeg(bitmap))
                val argb = if (bitmap.config == Bitmap.Config.ARGB_8888) bitmap else bitmap.copy(Bitmap.Config.ARGB_8888, false)
                    ?: throw Refused("damaged")
                val rgba = ByteArray(argb.width * argb.height * 4)
                // ARGB_8888 is R, G, B, A in memory.
                argb.copyPixelsToBuffer(ByteBuffer.wrap(rgba))
                if (argb !== bitmap) argb.recycle()
                return Decoded.Pixels(rgba, bitmap.width, bitmap.height)
            } finally {
                bitmap.recycle()
            }
        }

        /* Whether any pixel is less than opaque, read a row at a time (never the whole bitmap at once). */
        private fun transparent(bitmap: Bitmap): Boolean {
            if (!bitmap.hasAlpha()) return false
            val row = IntArray(bitmap.width)
            for (y in 0 until bitmap.height) {
                bitmap.getPixels(row, 0, bitmap.width, 0, y, bitmap.width, 1)
                if (row.any { (it ushr 24) != 0xFF }) return true
            }
            return false
        }

        private fun jpeg(bitmap: Bitmap): ByteArray {
            val out = ByteArrayOutputStream()
            if (!bitmap.compress(Bitmap.CompressFormat.JPEG, 92, out)) throw Refused("damaged")
            return out.toByteArray()
        }

        /* The PDF's thumbnail: the first image, upright, at most 512 px and 64 KB of JPEG; null when it can't be made. */
        fun thumbnail(bytes: ByteArray): ByteArray? = try {
            val bitmap = ImageDecoder.decodeBitmap(ImageDecoder.createSource(ByteBuffer.wrap(bytes))) { decoder, info, _ ->
                val scale = minOf(1f, 512f / maxOf(info.size.width, info.size.height))
                decoder.setTargetSize(maxOf(1, (info.size.width * scale).toInt()), maxOf(1, (info.size.height * scale).toInt()))
                decoder.allocator = ImageDecoder.ALLOCATOR_SOFTWARE
            }
            // On white, as a PDF reader shows a transparent image on its page.
            val flat = Bitmap.createBitmap(bitmap.width, bitmap.height, Bitmap.Config.ARGB_8888)
            Canvas(flat).apply { drawColor(Color.WHITE); drawBitmap(bitmap, 0f, 0f, null) }
            bitmap.recycle()
            var found: ByteArray? = null
            for (quality in listOf(70, 50, 30)) {
                val out = ByteArrayOutputStream()
                flat.compress(Bitmap.CompressFormat.JPEG, quality, out)
                if (out.size() <= 65_536) { found = out.toByteArray(); break }
            }
            flat.recycle()
            found
        } catch (_: Exception) {
            null
        }
    }
}

/* Why One PDF stopped before anything was made, in the person's words. */
class ImagesPdfRefused(message: String) : Exception(message)
