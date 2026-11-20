package com.hushos.app.data.transfers

import android.graphics.Bitmap
import android.graphics.Matrix
import android.graphics.pdf.PdfRenderer
import android.os.Build
import android.os.ParcelFileDescriptor
import android.system.Os
import android.system.OsConstants
import com.hushos.app.data.drive.NotAuthenticated
import com.hushos.app.data.editor.TextSave
import com.hushos.app.data.vault.Opened
import com.hushos.app.data.vault.Vault
import com.hushos.core.PdfInspection
import com.hushos.core.PdfPage
import com.hushos.core.PdfPagePlan
import com.hushos.core.PdfPagesWriter
import com.hushos.core.PdfToolsException
import com.hushos.core.PdfToolsLimits
import com.hushos.core.PlannedResult
import com.hushos.core.RunControl
import com.hushos.core.pdfImageSize
import com.hushos.core.pdfToolsLimits
import java.io.ByteArrayOutputStream
import java.io.FileOutputStream
import java.util.concurrent.atomic.AtomicReference

/*
 * Edit pages (docs/file-tools-design.md, feature (c)), as the web does it: every page of the PDFs
 * chosen, turned, put in order, removed and split, then saved as a new version of the one PDF, as
 * new files (one PDF edited, several merged, or one a range when split), or as images in a new
 * folder. The core's PdfPagesWriter (lopdf) reads the PDFs, refuses a password, says what saving
 * would lose (a signature, bookmarks and form fields) and writes every PDF; PdfRenderer only draws
 * (the sheet's thumbnails, Save as images), from an anonymous memory file, never storage. The work
 * is in tool runs (ToolRuns: one at a time, the watchdog over them, a cancel leaves nothing);
 * results go through the save path (SaveRuns), signed as the weakest of the PDFs their pages are from.
 */
object PdfPages {
    /* This phone's limits: the input held to a sixteenth of its memory, and to what one array on the app's heap takes. */
    fun limits(deviceMemory: Long, heapBytes: Long = Long.MAX_VALUE): PdfToolsLimits {
        val core = pdfToolsLimits(deviceMemory.coerceAtLeast(0).toULong())
        val heap = (heapBytes / 3).coerceAtLeast(0).toULong()
        val input = minOf(core.maxInputBytes, heap)
        return core.copy(maxInputBytes = input, cardBytes = minOf(core.cardBytes, input / 2u), maxOutputBytes = minOf(core.maxOutputBytes, heap))
    }

    enum class Stage { FINE, OFFER, CEILING }

    fun stage(count: Int, bytes: Long, limits: PdfToolsLimits): Stage = when {
        count > limits.maxFiles.toInt() || bytes.toULong() > limits.maxInputBytes -> Stage.CEILING
        bytes.toULong() > limits.cardBytes -> Stage.OFFER
        else -> Stage.FINE
    }

    fun imagesStage(pages: Int, limits: PdfToolsLimits): Stage = when {
        pages > limits.imagesMaxPages.toInt() -> Stage.CEILING
        pages > limits.imagesCardPages.toInt() -> Stage.OFFER
        else -> Stage.FINE
    }

    /* A PDF, by its recorded type or its name: as the web's `isPdf`. */
    fun takes(item: Opened): Boolean {
        if (item.isFolder || item.node.currentVersion == null) return false
        if (item.metadata.mime?.lowercase() == "application/pdf") return true
        return item.name.substringAfterLast('.', "").lowercase() == "pdf"
    }

    const val MIXED_FOLDERS = "These PDFs are in different folders. Edit pages from one folder at a time."
    const val SIGNED = "Its digital signature won’t be valid in the new file."
    const val FORMS = "Bookmarks and form fields may not carry over."
    /* Before Android 11 PdfRenderer would need a file, and a PDF is never written to one. */
    const val NO_RENDERER = "Pages can be drawn here from Android 11 on."

    fun oneFolder(files: List<Opened>): Boolean {
        val first = files.firstOrNull() ?: return false
        return files.all { it.node.parentId == first.node.parentId && it.node.workspaceId == first.node.workspaceId }
    }

    // Names, as the web gives them (lib/pdf-tools/names.ts).

    fun baseName(name: String): String {
        val dot = name.lastIndexOf('.')
        return (if (dot > 0) name.substring(0, dot) else name).trim().ifEmpty { "PDF" }
    }

    fun splitName(source: String, first: Int, last: Int): String =
        "${baseName(source)} (${if (first == last) "page $first" else "pages $first–$last"}).pdf"

    fun mergedName(first: String) = "${baseName(first)} (merged).pdf"
    fun imagesFolderName(source: String) = "${baseName(source)} (images)"
    fun pageImageName(index: Int, png: Boolean) = "page ${(index + 1).toString().padStart(3, '0')}.${if (png) "png" else "jpg"}"

    /* The ranges `count` pages are cut into, after each index in `cuts`: as the web's `rangesOf`. */
    fun ranges(count: Int, cuts: Set<Int>): List<IntRange> {
        if (count <= 0) return emptyList()
        val out = mutableListOf<IntRange>()
        var start = 0
        for (cut in cuts.filter { it in 0 until count - 1 }.sorted()) {
            out += start..cut
            start = cut + 1
        }
        out += start until count
        return out
    }

    /* The person's words for a refused PDF, one alone or one of several by its name. */
    fun words(code: String, name: String?): String = when (code) {
        "encrypted" -> name?.let { "“$it” has a password. Remove it in another app, then try again." }
            ?: "This PDF has a password. Remove it in another app, then try again."
        "too-many-pages" -> "${name?.let { "“$it”" } ?: "This PDF"} has more than 2,000 pages, too many to edit here."
        "too-large" -> "“${name ?: "The PDF"}” would be too large to make on this phone. Split it into smaller files."
        else -> name?.let { "“$it” is damaged, or isn’t something HushOS can read." }
            ?: "This PDF is damaged, or isn’t something HushOS can read."
    }

    fun stale(name: String) = "Someone saved a newer version of “$name” first, so nothing was saved. Edit its pages again."

    class Read(val data: List<ByteArray>, val inspections: List<PdfInspection>)

    /* The PDFs `read` hands over (blocking, on the run's thread), each checked by the core as it comes. */
    fun inspect(names: List<String>, control: RunControl, read: (Int) -> ByteArray, progress: (Int) -> Unit = {}): Read {
        PdfPagesWriter().use { writer ->
            val data = mutableListOf<ByteArray>()
            val inspections = mutableListOf<PdfInspection>()
            names.forEachIndexed { index, name ->
                val bytes = read(index)
                try {
                    inspections += writer.add(bytes, control)
                } catch (refused: PdfToolsException.Refused) {
                    throw ImagesPdfRefused(words(refused.code, if (names.size > 1) name else null))
                }
                data += bytes
                progress(index + 1)
            }
            return Read(data, inspections)
        }
    }

    /* Each output built from `sources` in order, handed to `made` as it is made. */
    fun build(sources: List<ByteArray>, names: List<String>, outputs: List<List<PdfPagePlan>>, control: RunControl,
              maxOutput: Long = Long.MAX_VALUE, made: (Int, ByteArray) -> Unit) {
        PdfPagesWriter().use { writer ->
            writer.limitOutput(maxOutput.coerceAtLeast(0).toULong())
            sources.forEachIndexed { index, bytes ->
                try {
                    writer.add(bytes, control)
                } catch (refused: PdfToolsException.Refused) {
                    throw ImagesPdfRefused(words(refused.code, if (sources.size > 1) names[index] else null))
                }
            }
            outputs.forEachIndexed { index, pages ->
                val bytes = try {
                    writer.build(pages, control)
                } catch (refused: PdfToolsException.Refused) {
                    throw ImagesPdfRefused(words(refused.code, null))
                }
                made(index, bytes)
            }
        }
    }

    /* An image's size for a page as the core sizes it (and the web): points at `dpi`, turned with the page. */
    fun imageSize(page: PdfPage, rotate: UInt, dpi: UInt): Pair<Int, Int> =
        pdfImageSize(page.width, page.height, rotate, dpi).let { it[0].toInt() to it[1].toInt() }

    /*
     * Each image's size, or the first page past `maxPixels` refused by its number: checked before the room is
     * reserved, as Longs (each side can be up to 2^32 pixels, past an Int), never multiplied as Ints.
     */
    fun imagePlan(pages: List<PdfPagePlan>, inspections: List<PdfInspection>, dpi: UInt, maxPixels: Long): List<Pair<Int, Int>> =
        pages.mapIndexed { index, page ->
            val info = inspections[page.source.toInt()].pages[page.page.toInt()]
            val (w, h) = pdfImageSize(info.width, info.height, page.rotate, dpi).let { it[0].toLong() to it[1].toLong() }
            // Each side alone first: two sides of 2^32 multiply past a Long's range.
            if (w > maxPixels || h > maxPixels || w * h > maxPixels) throw ImagesPdfRefused(
                "Page ${index + 1} is too large to save as an image at this resolution. Choose 150 dpi, or fewer pages.",
            )
            w.toInt() to h.toInt()
        }

    /*
     * What a save that failed after it began says: its own reason when its clean-up removed everything, and
     * what may still be there (or the 401, for the session check) when it didn't.
     */
    fun afterStop(error: Throwable, stopped: SaveRunStopped): Throwable {
        if (error is kotlinx.coroutines.CancellationException || error is ImagesPdf.StoppedWhileSaving) return stopped
        if (stopped.sessionRefused) return stopped
        if (stopped.cleanup != SaveCleanup.LEFT) return error
        val reason = (error as? ImagesPdfRefused)?.message ?: (error as? ToolFailed)?.message ?: com.hushos.core.toolFailedMessage()
        return ImagesPdfRefused("$reason ${stopped.message}")
    }

    /*
     * A PDF for PdfRenderer: the bytes in an anonymous memory file (memfd, Android 11 and later), never a
     * file on storage. Null before Android 11, or when PdfRenderer can't open it. Close it when done.
     */
    fun renderer(bytes: ByteArray): PdfRenderer? {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.R) return null
        val fd = runCatching { Os.memfd_create("pdf-pages", 0) }.getOrNull() ?: return null
        val parcel = try {
            FileOutputStream(fd).let { out -> out.write(bytes); out.flush() }
            Os.lseek(fd, 0, OsConstants.SEEK_SET)
            ParcelFileDescriptor.dup(fd)
        } catch (_: Exception) {
            return null
        } finally {
            runCatching { Os.close(fd) }
        }
        return try {
            PdfRenderer(parcel)
        } catch (_: Exception) {
            runCatching { parcel.close() }
            null
        }
    }

    /*
     * Page `page` drawn `width` by `height` pixels on white, turned to `rotate` (absolute, as /Rotate is:
     * PdfRenderer draws a page turned by its own /Rotate, so only the difference is added).
     */
    fun draw(renderer: PdfRenderer, page: Int, own: UInt, rotate: UInt, width: Int, height: Int): Bitmap? = runCatching {
        renderer.openPage(page).use { open ->
            val extra = ((rotate.toInt() - own.toInt()) % 360 + 360) % 360
            val turned = extra == 90 || extra == 270
            val shownWidth = if (turned) open.height else open.width
            val scale = width.toFloat() / shownWidth.coerceAtLeast(1)
            val (pw, ph) = open.width * scale to open.height * scale
            val matrix = Matrix().apply {
                setScale(scale, scale)
                when (extra) {
                    90 -> { postRotate(90f); postTranslate(ph, 0f) }
                    180 -> { postRotate(180f); postTranslate(pw, ph) }
                    270 -> { postRotate(270f); postTranslate(0f, pw) }
                }
            }
            Bitmap.createBitmap(width, height, Bitmap.Config.ARGB_8888).also { bitmap ->
                bitmap.eraseColor(android.graphics.Color.WHITE)
                open.render(bitmap, null, matrix, PdfRenderer.Page.RENDER_MODE_FOR_DISPLAY)
            }
        }
    }.getOrNull()

    fun encode(bitmap: Bitmap, png: Boolean): ByteArray? {
        val out = ByteArrayOutputStream()
        val ok = bitmap.compress(if (png) Bitmap.CompressFormat.PNG else Bitmap.CompressFormat.JPEG, if (png) 100 else 92, out)
        return if (ok) out.toByteArray() else null
    }

    /* A saved file's thumbnail: the page drawn small, as a JPEG within the upload's limit. */
    fun thumbnail(renderer: PdfRenderer, page: Int, info: PdfPage, rotate: UInt): ByteArray? {
        val turned = rotate == 90u || rotate == 270u
        val (w, h) = if (turned) info.height to info.width else info.width to info.height
        val scale = 512.0 / maxOf(w, h, 1.0)
        val bitmap = draw(renderer, page, info.rotate, rotate, maxOf(1, (w * scale).toInt()), maxOf(1, (h * scale).toInt())) ?: return null
        try {
            for (quality in listOf(70, 50, 30)) {
                val out = ByteArrayOutputStream()
                bitmap.compress(Bitmap.CompressFormat.JPEG, quality, out)
                if (out.size() <= 65_536) return out.toByteArray()
            }
            return null
        } finally {
            bitmap.recycle()
        }
    }

    sealed interface Choice {
        /* A new version of the one PDF, from the version the sheet read. */
        class Version(val pages: List<PdfPagePlan>, val file: Opened, val startedFrom: String?) : Choice
        /* New files, each its pages under its name (the next free one in the folder). */
        class Files(val outputs: List<Pair<String, List<PdfPagePlan>>>) : Choice
        class Images(val pages: List<PdfPagePlan>, val png: Boolean, val dpi: UInt, val folderName: String) : Choice
    }

    /* Reads `files` in a tool run: their bytes, held in memory while the sheet is open, and what each is. */
    suspend fun read(vault: Vault, files: List<Opened>, limits: PdfToolsLimits, progress: (Int, Int) -> Unit = { _, _ -> }): Read {
        val refusal = AtomicReference<ImagesPdfRefused?>(null)
        val session = AtomicReference<NotAuthenticated?>(null)
        return try {
            ToolRuns.shared.run(if (files.size == 1) "Reading ${files[0].name}" else "Reading ${files.size} PDFs") { control ->
                try {
                    inspect(files.map { it.name }, control, read = { index ->
                        vault.toolReader(files[index], control, refused = session).use { reader ->
                            ImagesPdf.readWhole(reader.size().toLong(), maxBytes = limits.maxInputBytes.toLong()) { offset, length ->
                                reader.readAt(offset.toULong(), length.toULong())
                            }
                        }
                    }, progress = { progress(it, files.size) })
                } catch (refused: ImagesPdfRefused) {
                    refusal.set(refused)
                    throw refused
                } catch (_: ImagesPdf.Images.Refused) {
                    throw ImagesPdfRefused(words("too-large", null)).also { refusal.set(it) }
                }
            }
        } catch (error: ToolFailed) {
            throw session.get() ?: refusal.get() ?: error
        }
    }

    /*
     * Saves `choice` into `folder`: the room checked and the run recorded first, the work in tool runs,
     * each result saved as it is made. Blocking but for the runs, which suspend; call it on Dispatchers.IO.
     * Returns what to tell the person. Any failure, a cancel included, cleans up what was made and throws.
     */
    suspend fun save(writer: VaultSaveWriter, journal: SaveRunJournal, files: List<Opened>, read: Read, folder: Opened,
                     choice: Choice, limits: PdfToolsLimits, progress: (Int, Int) -> Unit = { _, _ -> },
                     stopped: (SaveRunStopped) -> Unit = {}): String {
        if (!oneFolder(files) || files.any { it.node.parentId != folder.id }) throw ImagesPdfRefused(MIXED_FOLDERS)
        val job = kotlinx.coroutines.currentCoroutineContext()[kotlinx.coroutines.Job]
        val stillOn = { job?.isActive != false }
        val total = files.sumOf { it.size ?: 0L }
        val sources = files.map { (writer.copySources(it) as SaveSources.From).sources }
        // Every result signed as the weakest of all the PDFs read for it, as the web signs them: never as
        // stronger than the weakest PDF the work held, whichever pages it was asked for.
        val signing = { _: List<PdfPagePlan> -> SaveSources.From(sources.flatten()) }
        val names = files.map { it.name }
        when (choice) {
            is Choice.Images -> {
                // Every page's size first: one too large to draw is refused before anything is reserved or made.
                val sizes = imagePlan(choice.pages, read.inspections, choice.dpi, limits.imagesMaxPixels.toLong())
                // A guess, as conversion's is: a PNG of a page is rarely more than a byte a pixel, a JPEG a third of that.
                val results = sizes.map { (w, h) -> PlannedResult.Known((w.toLong() * h / if (choice.png) 1 else 3).toULong(), true) }
                val run = SaveRun.start(writer, listOf(folder), results, journal)
                try {
                    val into = run.folder(choice.folderName, signing(choice.pages), folder)
                    // The PDFs read once into the core's writer, which makes each page a PDF to draw (its annotations
                    // drawn into its content, as a viewer shows them); PdfRenderer draws that.
                    val pdfWriter = PdfPagesWriter()
                    try {
                        ToolRuns.shared.run("Reading ${names.first()}") { control -> read.data.forEach { pdfWriter.add(it, control) } }
                        choice.pages.forEachIndexed { index, page ->
                            val (w, h) = sizes[index]
                            val lease = ImagesPdf.Lease()
                            try {
                                val refusal = AtomicReference<ImagesPdfRefused?>(null)
                                val made = try {
                                    ToolRuns.shared.run("Saving page ${index + 1} as an image") { control ->
                                        control.progress()
                                        val renderer = renderer(pdfWriter.drawable(page, control))
                                            ?: throw ImagesPdfRefused(NO_RENDERER).also { refusal.set(it) }
                                        // The page to draw carries its own rotation already: nothing is added to it.
                                        val bitmap = try { draw(renderer, 0, page.rotate, page.rotate, w, h) } finally { runCatching { renderer.close() } }
                                            ?: throw ImagesPdfRefused(words("damaged", if (files.size > 1) names[page.source.toInt()] else null))
                                                .also { refusal.set(it) }
                                        val bytes = try { encode(bitmap, choice.png) } finally { bitmap.recycle() }
                                            ?: throw ImagesPdfRefused(words("damaged", null)).also { refusal.set(it) }
                                        control.progress()
                                        lease.take(bytes.size.toULong(), ToolRuns.budget.produce(bytes.size.toULong(), control))
                                        bytes to ImagesPdf.Images.thumbnail(bytes)
                                    }
                                } catch (error: ToolFailed) {
                                    throw refusal.get() ?: error
                                }
                                run.holdTo(stillOn)
                                run.file(made.first, pageImageName(index, choice.png), if (choice.png) "image/png" else "image/jpeg",
                                    signing(listOf(page)), made.second, into)
                                if (!stillOn()) throw ImagesPdf.StoppedWhileSaving()
                            } finally {
                                lease.release()
                            }
                            progress(index + 1, choice.pages.size)
                        }
                    } finally {
                        pdfWriter.close()
                    }
                    TextSave.end(run)
                    return "Saved “${choice.folderName}”."
                } catch (error: Throwable) {
                    val how = run.cancel()
                    stopped(how)
                    throw afterStop(error, how)
                }
            }
            is Choice.Version -> {
                val run = SaveRun.start(writer, listOf(choice.file), listOf(PlannedResult.FromSources(total.toULong(), true)), journal)
                try {
                    run.holdTo(stillOn)
                    var saved: VersionSaved? = null
                    buildEach(read, names, listOf(choice.pages), limits, progress = progress) { _, made ->
                        saved = run.version(made, choice.file, folder, choice.startedFrom, signing(choice.pages), "application/pdf",
                            thumbnailOf(read, choice.pages))
                        if (!stillOn()) throw ImagesPdf.StoppedWhileSaving()
                    }
                    TextSave.end(run)
                    if (saved is VersionSaved.Stale) throw ImagesPdfRefused(stale(choice.file.name))
                    return "Saved a new version of “${choice.file.name}”."
                } catch (error: Throwable) {
                    val how = run.cancel()
                    stopped(how)
                    throw afterStop(error, how)
                }
            }
            is Choice.Files -> {
                val count = choice.outputs.sumOf { it.second.size }.coerceAtLeast(1)
                val results = choice.outputs.map { PlannedResult.FromSources((total * it.second.size / count).coerceAtLeast(1).toULong(), true) }
                val run = SaveRun.start(writer, listOf(folder), results, journal)
                try {
                    run.holdTo(stillOn)
                    // Each output saved as it is made, its bytes counted in the budget until then: never all of them at once.
                    buildEach(read, names, choice.outputs.map { it.second }, limits, progress = progress) { index, made ->
                        val (name, pages) = choice.outputs[index]
                        run.file(made, name, "application/pdf", signing(pages), if (index < 20) thumbnailOf(read, pages) else null, folder)
                        if (!stillOn()) throw ImagesPdf.StoppedWhileSaving()
                    }
                    TextSave.end(run)
                    return if (choice.outputs.size == 1) "Saved “${choice.outputs[0].first}”." else "Saved ${choice.outputs.size} files."
                } catch (error: Throwable) {
                    val how = run.cancel()
                    stopped(how)
                    throw afterStop(error, how)
                }
            }
        }
    }

    /*
     * The outputs, one at a time: the PDFs read once into one writer, then each output built in a tool run of its
     * own, its bytes charged to `budget` (waiting while the process holds 512 MB of results) and handed to `save`,
     * the charge given back once `save` returns or throws, before the next is built. So a split whose ranges each
     * carry a large shared font holds one output at a time, never all of them.
     */
    suspend fun buildEach(read: Read, names: List<String>, outputs: List<List<PdfPagePlan>>, limits: PdfToolsLimits,
                          budget: com.hushos.core.ToolBudget = ToolRuns.budget, progress: (Int, Int) -> Unit = { _, _ -> },
                          save: (Int, ByteArray) -> Unit) {
        val refusal = AtomicReference<ImagesPdfRefused?>(null)
        val label = if (outputs.size == 1) "Making ${names.first()}" else "Splitting ${names.first()}"
        PdfPagesWriter().use { writer ->
            writer.limitOutput(limits.maxOutputBytes)
            try {
                ToolRuns.shared.run(label) { control ->
                    read.data.forEachIndexed { index, bytes ->
                        try {
                            writer.add(bytes, control)
                        } catch (refused: PdfToolsException.Refused) {
                            throw ImagesPdfRefused(words(refused.code, if (read.data.size > 1) names[index] else null)).also { refusal.set(it) }
                        }
                    }
                }
                outputs.forEachIndexed { index, pages ->
                    val lease = ImagesPdf.Lease { bytes, generation -> budget.release(bytes, generation) }
                    try {
                        val made = ToolRuns.shared.run(label) { control ->
                            val bytes = try {
                                writer.build(pages, control)
                            } catch (refused: PdfToolsException.Refused) {
                                throw ImagesPdfRefused(words(refused.code, null)).also { refusal.set(it) }
                            }
                            lease.take(bytes.size.toULong(), budget.produce(bytes.size.toULong(), control))
                            bytes
                        }
                        progress(index + 1, outputs.size)
                        save(index, made)
                    } finally {
                        lease.release()
                    }
                }
            } catch (error: ToolFailed) {
                throw refusal.get() ?: error
            }
        }
    }

    private fun thumbnailOf(read: Read, pages: List<PdfPagePlan>): ByteArray? {
        val first = pages.firstOrNull() ?: return null
        val renderer = renderer(read.data[first.source.toInt()]) ?: return null
        return try {
            thumbnail(renderer, first.page.toInt(), read.inspections[first.source.toInt()].pages[first.page.toInt()], first.rotate)
        } finally {
            runCatching { renderer.close() }
        }
    }
}
