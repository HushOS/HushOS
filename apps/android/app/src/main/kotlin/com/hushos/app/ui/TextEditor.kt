package com.hushos.app.ui

import android.content.Context
import android.graphics.Typeface
import android.text.Editable
import android.text.InputFilter
import android.text.InputType
import android.text.SpannableStringBuilder
import android.text.TextWatcher
import android.util.TypedValue
import android.view.Gravity
import android.view.View
import android.view.inputmethod.EditorInfo
import android.widget.EditText
import android.widget.TextView
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.background
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyListState
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.ContentCopy
import androidx.compose.material.icons.outlined.History
import androidx.compose.material.icons.outlined.Save
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SegmentedButton
import androidx.compose.material3.SegmentedButtonDefaults
import androidx.compose.material3.SingleChoiceSegmentedButtonRow
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.snapshotFlow
import androidx.compose.runtime.withFrameNanos
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.toArgb
import androidx.compose.ui.layout.Layout
import androidx.compose.ui.unit.Constraints
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import com.hushos.app.data.Auth
import com.hushos.app.data.DraftRules
import com.hushos.app.data.DraftStore
import com.hushos.app.data.EditSession
import com.hushos.app.data.MarkdownDocument
import com.hushos.app.data.LineMap
import com.hushos.app.data.MdPiece
import com.hushos.app.data.NotAuthenticated
import com.hushos.app.data.Opened
import com.hushos.app.data.SaveRunJournal
import com.hushos.app.data.SaveRunStopped
import com.hushos.app.data.SaveRuns
import com.hushos.app.data.TextEditing
import com.hushos.app.data.TextSave
import com.hushos.app.data.TextLines
import com.hushos.app.data.TextSaved
import com.hushos.app.data.Vault
import com.hushos.app.data.VaultSaveWriter
import com.hushos.app.data.readDraft
import com.hushos.app.data.removeDraft
import com.hushos.app.data.writeDraft
import com.hushos.core.Draft
import com.hushos.core.DraftFrame
import com.hushos.core.DraftOffer
import com.hushos.core.DraftSelection
import com.hushos.core.RunControl
import com.hushos.core.TextFormat
import com.hushos.core.TextReadOnly
import com.hushos.core.toolWatchdogMillis
import com.hushos.tokens.AlpineSpace
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

/* The editor's words, the web's (text-editor.tsx editorWords) and iOS's. */
object EditorWords {
    const val EDIT = "Edit"
    const val SAVE = "Save"
    const val SAVING = "Saving"
    const val SAVED = "Saved"
    fun savedCopy(name: String) = "Saved as “$name”"
    const val SAVE_FAILED = "This couldn’t be saved, so nothing was kept."
    const val FAILED = "This file couldn’t be opened for editing."
    const val TRY_AGAIN = "Try again"
    const val CLOSE = "Close"
    const val STALE_TITLE = "This file changed"
    const val STALE_TEXT = "Someone saved a newer version while you were editing. Your changes aren’t saved yet."
    const val GONE_TITLE = "This file was moved or deleted"
    const val GONE_TEXT = "Your changes aren’t saved yet. Save them as a new file to keep them."
    const val ON_TOP = "Save on top"
    const val COPY = "Save as a copy"
    const val THEIRS = "Open theirs"
    const val CANCEL = "Cancel"
    const val DISCARD_TITLE = "Discard your changes?"
    const val THEIRS_TEXT = "The newer version opens instead, and your changes are lost."
    fun leaveText(name: String) = "Your changes to “$name” aren’t saved."
    const val DISCARD = "Discard changes"
    const val KEEP_EDITING = "Keep editing"
    const val FINISHING = "Finishing your save, then closing"
    const val SOURCE = "Source"
    const val PREVIEW = "Preview"
    const val PREVIEW_TOO_LONG = "This file is too long to preview while you edit."
    const val HALF_CHARACTER = "This text has half of an emoji or symbol in it. Delete it, then save."
    fun restoreOffer(whenSaved: String) = "Restore your unsaved changes from $whenSaved"
    const val RESTORE = "Restore"
    const val DISCARD_DRAFT = "Discard"
    const val DRAFT_NOT_KEPT = "Your unsaved changes couldn’t be kept on this device."
}

/* How many bytes `text` takes in UTF-8, counted without encoding it (a lone surrogate as the three of its replacement). */
internal fun utf8Length(text: CharSequence): Long {
    var bytes = 0L
    var at = 0
    while (at < text.length) {
        val unit = text[at]
        bytes += when {
            unit.code < 0x80 -> 1
            unit.code < 0x800 -> 2
            unit.isHighSurrogate() && at + 1 < text.length && text[at + 1].isLowSurrogate() -> { at++; 4 }
            else -> 3
        }
        at++
    }
    return bytes
}

/*
 * An editing session (Editing 1a and 1b; docs/editing-design.md sections 1 and 3, the web's text-editor.tsx, iOS's
 * TextEditorScreen): the file's current version read again from the server into one buffer the system's EditText edits in
 * place, saved explicitly as a new version through the save path (TextSave over SaveRuns) in the file's own encoding, byte
 * order mark and line breaks (TextEditing.SaveState), with the stale choices when someone else saved first. Markdown offers
 * Source or Preview, the viewer's rendering (MarkdownDocument: images named, never fetched). Held by the view model, so a rotation keeps the text; every path that ends a session ends this
 * one (`end`), its text emptied. What was typed and not saved is kept as a draft (Editing 1c, data/Drafts.kt): sealed on this
 * phone about two seconds after a change and when the app leaves the screen, and offered back at the next open of the file.
 * The decrypted copy it reads goes as soon as it is read.
 */
class TextEdit(val item: Opened, private val context: Context, private val scope: CoroutineScope, opening: Vault,
               current: () -> Vault?, private val saved: (parentId: String?) -> Unit,
               private val refused: (com.hushos.app.data.Shared.Session?) -> Unit = {},
               private val drafts: DraftStore = DraftStore.of(context)) {
    /* The account session this editor opened under: a 401 ends it only while it is still the one in use (refused). */
    private val signedIn = com.hushos.app.data.Shared.session(context)

    /*
     * A 401 under this editor's work (a listing, a read, a run it stopped): the app's session check with the session it ran
     * under, never a line in the editor, and nothing for a session a later sign-in replaced (DriveViewModel.archiveRefused).
     */
    private fun sessionRefused(error: Throwable?): Boolean {
        var cause = error
        while (cause != null) {
            if (cause is NotAuthenticated || (cause is SaveRunStopped && cause.sessionRefused)) {
                refused(signedIn)
                return true
            }
            cause = cause.cause
        }
        return false
    }

    /* This editor's session: the vault it opened under and the opened text; every path checks it (EditSession). */
    private val session = EditSession(opening, current)

    sealed interface Phase {
        data object Loading : Phase
        data object Failed : Phase
        data class ReadOnly(val reason: TextReadOnly, val text: String?) : Phase
        data object Editing : Phase
    }

    /* Someone else's version is current (null: the file is gone from its folder). */
    data class Stale(val currentVersionId: String?)

    var phase by mutableStateOf<Phase>(Phase.Loading); private set
    var target by mutableStateOf(item); private set
    /*
     * The row the header names and marks: the one the text was read from, moved on only by a save or a copy whose row
     * lists the very version it published (its checks are of that version). Another device's newer version, checked or
     * not, says nothing of the text on screen; its name and its mark always come from this one row.
     */
    var marked by mutableStateOf(item); private set

    /* `row` speaks for the text when it lists the version this editor just published, in the editor's folder. */
    private fun markWith(row: Opened, versionId: String?) {
        if (TextEditing.speaksFor(row, versionId, destination)) marked = row
    }
    private var startedFrom: String? = item.node.currentVersion?.id
    /*
     * The row the text's bytes were read from: a copy is signed as it is (an Unverified file's copy stays Unverified). Set only
     * when a version is opened; a save or a copy moves `target` on, and the copy's row (which may already carry someone else's
     * version) never stands in for it.
     */
    private var source: Opened = item
    /* The workspace and folder the file was opened in (TextEditing.Destination): every save and copy lists and writes there. */
    private val destination = TextEditing.Destination.of(item)
    /* The text, edited in place by the EditText: never copied per keystroke, never put in a Bundle. */
    val buffer = SpannableStringBuilder()
    var edited by mutableStateOf(false); private set
    /* The text as last opened or saved: typing then undoing it is no change (Save sends nothing, Close asks nothing). */
    private var savedText: String? = null
    /*
     * The session's saves (TextEditing.SaveState): the format found when the file opened, kept whatever is saved since, and
     * the text and bytes last opened or saved, so a text still as it was writes those bytes again. Null while nothing
     * editable is open.
     */
    @Volatile private var saveState: TextEditing.SaveState? = null
    /* The open file's encoding and line breaks: a mixed file says which a save writes. */
    var format by mutableStateOf<TextFormat?>(null); private set

    /*
     * Markdown shows Source or Preview when the window is narrow (the preview renders the text as it was when Preview was
     * chosen), and both side by side when it is wide, the preview following typing. Decided by the row the text was read
     * from (load, Open theirs included), never the item sheet's, which may be a version or a rename behind.
     */
    var markdown by mutableStateOf(false); private set
    var previewing by mutableStateOf(false); private set
    /* The text was past what the preview renders when Preview was chosen: it stayed on Source and says so. */
    var previewTooLong by mutableStateOf(false); private set
    var preview by mutableStateOf<List<MdPiece>?>(null); private set
    /* The preview's blocks by source line, from its last rendering (TextEditorScreen scrolls the two together). */
    var lineMap: LineMap? = null; private set
    private var parsing: Job? = null
    /* Side by side (the window is wide): every edit renders the preview again. */
    var sideBySide = false; private set
    /* The text changed while a rendering was on its way: one more follows it. */
    private var again = false
    /*
     * Where the person was: the text offset at the top of the view (cheap: the layout's own line start) and the cursor.
     * Kept here, in the view model, so a fold, an unfold or a resize (which recreate the screen and its EditText) finds
     * both as they were.
     */
    var topOffset = 0
    var selection: Pair<Int, Int>? = null
    /*
     * The text's line starts, built in the background with each rendering of the preview (never in a scroll callback,
     * and never for plain text or a text past the preview's limit): what maps the source to the preview's blocks.
     */
    var textLines: TextLines? = null; private set
    /* A narrow switch's line, until the pane switched to can be put there. */
    var keptLine: Double? = null

    /* A draft found at the first open: what it holds, how it is restored, and the file and version it opened at. */
    data class PendingDraft(val draft: Draft, val kind: DraftOffer, val openedVersionId: String?, val file: Opened)

    /* The draft offer, unanswered: the dialog is up, and nothing is written meanwhile. */
    var offer by mutableStateOf<PendingDraft?>(null); private set
    /* The last draft couldn't be kept: one quiet line. */
    var draftNotKept by mutableStateOf(false); private set
    /* A draft was looked for: once, at the first open that reached the text (never after Open theirs). */
    private var draftAsked = false
    /* The write turn waiting to run; draft writes and removals run one at a time, in the order asked. */
    private var draftTurn: Job? = null
    private val draftLane = Dispatchers.IO.limitedParallelism(1)
    /* Draft writes and removals, one after another in the order asked: a removal decides after the writes before it. */
    private var draftWork: Job? = null
    /*
     * Whether this session owns the stored draft (it wrote it, or the person restored it): only then does a close, a save
     * back to the baseline, Open theirs or a copy remove it. An editor that wrote nothing never removes another's draft.
     */
    private var ownsDraft = false
    /*
     * The version the session's text was first read from (what a copy is signed from), and whether it is the version read
     * now: a draft restored from another version can't be checked, and its copy is re-sealed rather than vouched for.
     */
    private var sourceVersionId: String? = null
    private var sourceKnown = true

    /* Runs `work` on the main thread after everything asked before it. */
    private fun inOrder(work: suspend () -> Unit) {
        val previous = draftWork
        draftWork = scope.launch {
            previous?.join()
            work()
        }
    }

    fun showSource() {
        previewing = false
    }

    fun showPreview() {
        if (previewing) return
        val text = (phase as? Phase.ReadOnly)?.text ?: buffer.toString()
        // Past what the viewer renders (MarkdownDocument.LIMIT, in UTF-8 bytes): Source stays, and says why.
        if (utf8Length(text) > MarkdownDocument.LIMIT) {
            previewTooLong = true
            return
        }
        previewTooLong = false
        previewing = true
        preview = null
        render(text)
    }

    /* The window became wide or narrow: wide, the preview renders the text now and follows it from here. */
    fun sideBySide(wide: Boolean) {
        if (sideBySide == wide) return
        sideBySide = wide
        if (wide && markdown) follow()
    }

    /* Side by side, the text changed (or just opened): render it again, at once or right after the one on its way. */
    private fun follow() {
        if (!sideBySide || !markdown) return
        val text = when (val now = phase) {
            Phase.Editing -> buffer
            is Phase.ReadOnly -> now.text ?: return
            else -> return
        }
        // Past what the viewer renders: no preview at all (no spinner, no old blocks, nothing scrolled by it) until it
        // fits again. The length alone settles most texts; only one that could go either way is counted in bytes.
        if (tooLong(text)) {
            previewTooLong = true
            parsing?.cancel()
            again = false
            preview = null
            lineMap = null
            textLines = null
            return
        }
        if (parsing?.isActive == true) {
            again = true
            return
        }
        render(text.toString())
    }

    /* Over MarkdownDocument.LIMIT in UTF-8 bytes: a UTF-16 unit is one to three bytes, so most lengths need no count. */
    private fun tooLong(text: CharSequence): Boolean = when {
        text.length > MarkdownDocument.LIMIT -> true
        text.length * 3L <= MarkdownDocument.LIMIT -> false
        else -> utf8Length(text) > MarkdownDocument.LIMIT
    }

    /*
     * Parsed off the main thread: one rendering at a time, and one more once it lands if the text changed meanwhile, never
     * a wait for typing to stop.
     */
    private fun render(text: String) {
        parsing?.cancel()
        again = false
        parsing = scope.launch {
            // Parsed, and the source's line starts indexed, off the main thread.
            val (pieces, map, lines) = withContext(Dispatchers.Default) {
                val parsed = MarkdownDocument.parseLined(text)
                val starts = TextLines(text)
                Triple(parsed, LineMap(parsed.map { it.start }, starts.count), starts)
            }
            if (!previewing && !sideBySide || previewTooLong) return@launch
            lineMap = map
            textLines = lines
            preview = pieces
            if (again) {
                again = false
                parsing = null
                follow()
            }
        }
    }

    /* A save or a copy of `text` landed as `bytes`: in one line break from here, unless it sent the bytes it had. */
    private fun settle(text: String, bytes: ByteArray) {
        val state = saveState ?: return
        if (!state.bytes.contentEquals(bytes)) format = format?.copy(mixed = false)
        saveState = state.saved(text, bytes)
    }

    /* Changes to lose or save: typed, and not back to what was last opened or saved. */
    fun changed(): Boolean {
        if (!edited) return false
        if (savedText?.let { TextEditing.same(buffer, it) } == true) {
            edited = false
            return false
        }
        return true
    }
    var saving by mutableStateOf(false); private set
    var status by mutableStateOf<String?>(null); private set
    var failure by mutableStateOf<String?>(null); private set
    var stale by mutableStateOf<Stale?>(null)
    /*
     * A close asked for while a save or a copy was on its way: never Discard then (it may still publish). The editor says it
     * is finishing (`closing`); once the save settles, `closeAfter` says whether it landed (the close goes on, asking first if
     * typed meanwhile) or not (the editor stays, saying why).
     */
    var closing by mutableStateOf(false); private set
    var closeAfter by mutableStateOf<Boolean?>(null); private set
    private var work: Job? = null
    private var reading: RunControl? = null
    /* The save on its way: cancelled with the session (its run start and upload also ask the session themselves). */
    private var saveJob: Job? = null

    private fun writer(vault: Vault) = VaultSaveWriter(vault, storage = { Auth.storage(context) })
    private fun start(vault: Vault) = TextSave.runs(writer(vault), SaveRunJournal.of(context))

    /* Close while saving: wait for the save to settle. */
    fun closeWhenSaved() {
        if (saving) closing = true
    }

    fun closeHandled() {
        closeAfter = null
    }

    /* A save or a copy settled (`landed`: it published): a close waiting on it goes on or is let go. */
    private fun settledSave(landed: Boolean) {
        saving = false
        if (closing) {
            closing = false
            closeAfter = landed
        }
    }

    fun markEdited() {
        // A draft about two seconds after the first change, carrying every change until it runs.
        if (draftTurn?.isActive != true) draftTurn = scope.launch {
            delay(DraftRules.WRITE_DELAY_MS)
            writeDraft()
        }
        if (!edited) edited = true
        status = null
        // Said of the text as it was when Preview was chosen; the size is asked again at the next one.
        previewTooLong = false
        follow()
    }

    /* The file as the server lists it now, read afresh: what a save writes is these bytes, edited. */
    fun load(from: Opened = target) {
        work?.cancel()
        phase = Phase.Loading
        reading?.cancel()
        val control = RunControl(toolWatchdogMillis(), null)
        reading = control
        val token = session.take() ?: return
        val vault = token.owner
        work = scope.launch {
            val opened = withContext(Dispatchers.IO) {
                runCatching {
                    // The row in the file's own folder and workspace, and its bytes read for that row's version, in memory:
                    // nothing decrypted is written to disk for a killed process to leave behind.
                    val file = writer(vault).editTarget(from, destination).second ?: return@runCatching null
                    if ((file.size ?: 0L) > TextEditing.LIMIT) return@runCatching Triple(file, TextEditing.Open.ReadOnly(TextReadOnly.TOO_LARGE, null), null)
                    val bytes = TextEditing.bytesOf(vault, file, TextEditing.LIMIT, control)
                    Triple(file, TextEditing.open(bytes), bytes)
                }
            }
            // The first open only: a draft of this file from an earlier session (a closed app, a kill), answered before the
            // text can be changed.
            val opened0 = opened.getOrNull()
            val kept = if (!draftAsked && opened0 != null && opened0.second is TextEditing.Open.Editable) {
                withContext(draftLane) { vault.readDraft(drafts, opened0.first) }
            } else null
            if (sessionRefused(opened.exceptionOrNull())) return@launch
            if (!session.live(token)) return@launch
            val loaded = opened.getOrNull()
            if (loaded == null) {
                phase = Phase.Failed
                return@launch
            }
            val (file, text, bytes) = loaded
            target = file
            marked = file
            startedFrom = file.node.currentVersion?.id
            source = file
            edited = false
            buffer.clear()
            buffer.clearSpans()
            previewing = false
            preview = null
            previewTooLong = false
            markdown = MarkdownDocument.handles(file.name, file.metadata.mime)
            if (text is TextEditing.Open.Editable && !draftAsked) {
                draftAsked = true
                if (kept != null) {
                    val versionId = file.node.currentVersion?.id
                    when (val kind = DraftRules.offer(kept, versionId, text.text)) {
                        DraftOffer.SAME -> removeDraft(file, force = true)
                        else -> offer = PendingDraft(kept, kind, versionId, file)
                    }
                }
            }
            if (text is TextEditing.Open.Editable) {
                sourceVersionId = file.node.currentVersion?.id
                sourceKnown = true
            }
            phase = when (text) {
                is TextEditing.Open.Editable -> Phase.Editing.also {
                    buffer.append(text.text)
                    savedText = text.text
                    // From what was opened off the main thread, never decoded again here.
                    saveState = bytes?.let { TextEditing.SaveState.opening(text, it) }
                    format = text.format
                }
                is TextEditing.Open.ReadOnly -> Phase.ReadOnly(text.reason, text.text).also {
                    saveState = null
                    format = null
                }
            }
            topOffset = 0
            selection = null
            textLines = null
            follow()
        }
    }

    /* Save, and Save on top (`onTopOf`: the version current now). */
    fun save(onTopOf: String? = null) {
        if (phase != Phase.Editing || saving) return
        // Back to the text as opened or saved (typed, then undone): nothing to send, no version that pushes out an older one.
        if (onTopOf == null && !changed()) return
        // The session it starts in: the vault the editor opened with and its journal, never a replacement's.
        val token = session.take() ?: return
        val vault = token.owner
        // The text as it is now, taken here; written out in the file's format off the main thread.
        val text = buffer.toString()
        val state = saveState ?: return
        val file = target
        saving = true
        failure = null
        status = null
        saveJob?.cancel()
        saveJob = scope.launch {
            val result = withContext(Dispatchers.IO) {
                runCatching {
                    // In the file's encoding, byte order mark and line breaks; unchanged, the bytes it had.
                    val bytes = state.bytes(text)
                    val writer = writer(vault)
                    val (folder, listed) = writer.editTarget(file, destination)
                    bytes to (if (listed == null) TextSaved.Stale(null)
                    else TextSave.version(bytes, listed, folder, onTopOf ?: startedFrom, TextSave.runs(writer, SaveRunJournal.of(context)),
                        stillOn = { session.live(token) }))
                }
            }
            if (sessionRefused(result.exceptionOrNull())) {
                settledSave(false)
                return@launch
            }
            if (!session.live(token)) return@launch
            result.onSuccess { (bytes, done) ->
                when (done) {
                    is TextSaved.Stale -> stale = Stale(done.currentVersionId)
                    is TextSaved.Saved -> {
                        // The version this save published, never the reply row's (which may already be someone else's):
                        // unknown, the next save asks the stale question. Only a row still in the editor's folder sets it:
                        // one answered from elsewhere (moved since it landed) leaves the next save to find the file gone.
                        if (destination?.holds(done.item) == true) {
                            target = done.item
                            startedFrom = done.versionId
                        }
                        markWith(done.item, done.versionId)
                        // Typed while it saved: still changed.
                        savedText = text
                        settle(text, bytes)
                        edited = !TextEditing.same(buffer, text)
                        // The text is the file's now: its draft goes (or holds only what was typed meanwhile).
                        flushDraft()
                        status = EditorWords.SAVED
                        saved(done.item.node.parentId)
                    }
                }
            }.onFailure { failure = failureWords(it) }
            settledSave(result.getOrNull()?.second is TextSaved.Saved)
        }
    }

    fun saveCopy() {
        if (saving) return
        val token = session.take() ?: return
        val vault = token.owner
        val text = buffer.toString()
        val state = saveState ?: return
        val file = target
        val from = source
        saving = true
        failure = null
        saveJob?.cancel()
        saveJob = scope.launch {
            val result = withContext(Dispatchers.IO) {
                runCatching {
                    // The copy keeps the file's encoding and line breaks too, written out off the main thread.
                    val bytes = state.bytes(text)
                    val writer = writer(vault)
                    val (folder, _) = writer.editTarget(file, destination)
                    bytes to TextSave.copy(bytes, file, folder, writer.copySources(from, named = file, contentKnown = sourceKnown), TextSave.runs(writer, SaveRunJournal.of(context)),
                        stillOn = { session.live(token) })
                }
            }
            if (sessionRefused(result.exceptionOrNull())) {
                settledSave(false)
                return@launch
            }
            if (!session.live(token)) return@launch
            result.onSuccess { (bytes, made) ->
                // From here on the editor writes the copy, by the run's own row and version; the file someone else saved
                // stays theirs. The copy went into the editor's folder: a row answered from elsewhere sets no version to go
                // on from, and the next save finds it gone from here.
                // The text went into the copy: the file it came from keeps no draft of it, unless typed into since.
                if (TextEditing.same(buffer, text)) removeDraft(file)
                target = made.file
                startedFrom = if (destination?.holds(made.file) == true) made.versionId else null
                markWith(made.file, made.versionId)
                savedText = text
                settle(text, bytes)
                edited = !TextEditing.same(buffer, text)
                flushDraft()
                status = EditorWords.savedCopy(made.file.name)
                saved(made.file.node.parentId)
            }.onFailure { failure = failureWords(it) }
            settledSave(result.isSuccess)
        }
    }

    /* What went wrong with a save or a copy; half a character in the text saved nothing and keeps the text. */
    private fun failureWords(error: Throwable) =
        if (error is TextEditing.HalfCharacter) EditorWords.HALF_CHARACTER else SaveRuns.reason(error) ?: EditorWords.SAVE_FAILED

    /* Their version, read in place of this text (after the person confirmed). */
    fun openTheirs() {
        // This session's changes are discarded (the person confirmed it): so is their draft.
        draftTurn?.cancel()
        removeDraft(target)
        // Another text opens: nothing begun on this one publishes over it.
        session.reopened()
        stale = null
        status = null
        failure = null
        edited = false
        buffer.clear()
        savedText = null
        saveState = null
        previewing = false
        previewTooLong = false
        preview = null
        textLines = null
        load(target)
    }

    /*
     * A write turn (DraftRules.step): the text as it is now sealed and kept for the file being written, or removed once it is
     * back at what was last opened or saved. Never for read-only text, an unanswered offer, or no version to start from.
     */
    private fun writeDraft() {
        draftTurn?.cancel()
        draftTurn = null
        val vault = session.take()?.owner ?: return
        val file = target
        val baseline = savedText
        val step = DraftRules.step(editable = phase == Phase.Editing, offering = offer != null, startedFrom = startedFrom,
            atBaseline = baseline == null || TextEditing.same(buffer, baseline), owns = ownsDraft)
        when (step) {
            DraftRules.Step.NONE -> return
            DraftRules.Step.REMOVE -> removeDraft(file)
            DraftRules.Step.WRITE -> {
                val state = saveState ?: return
                val base = startedFrom ?: return
                val text = buffer.toString()
                val chosen = selection ?: (android.text.Selection.getSelectionStart(buffer) to android.text.Selection.getSelectionEnd(buffer))
                val draft = Draft(DraftFrame(base, state.format, System.currentTimeMillis().toULong()), text,
                    chosen.takeIf { it.first >= 0 && it.second >= 0 }?.let { DraftSelection(it.first.toUInt(), it.second.toUInt()) },
                    sourceVersionId)
                // Asked now: a sign-out's wipe before it lands keeps nothing of it.
                val asked = drafts.generation
                inOrder {
                    val written = withContext(draftLane) { vault.writeDraft(drafts, draft, file, asked) }
                    draftNotKept = !written
                    if (written) ownsDraft = true
                }
            }
        }
    }

    /* Written now: the app left the screen, a save landed, or a copy took the text elsewhere. */
    fun flushDraft() {
        writeDraft()
    }

    /*
     * The file's draft deleted, after any write asked for before: one this session owns, or (`force`) one the person
     * discarded, the file already holds, or whose family is gone.
     */
    private fun removeDraft(file: Opened, force: Boolean = false) {
        val vault = session.take()?.owner ?: return
        inOrder {
            if (!force && !ownsDraft) return@inOrder
            ownsDraft = false
            withContext(draftLane) { vault.removeDraft(drafts, file) }
        }
    }

    /*
     * Restore: the draft's text in place of the opened one as an unsaved edit, in the format it was typed under. Someone saved
     * since: the stale choices at once, and a save still starts from the draft's version, so nothing lands over theirs
     * without asking.
     */
    fun restoreDraft() {
        val pending = offer ?: return
        val state = saveState ?: return
        offer = null
        val draft = pending.draft
        saveState = state.inFormat(draft.frame.format)
        format = draft.frame.format
        if (pending.kind == DraftOffer.STALE) startedFrom = draft.frame.baseVersionId
        // Its text is this session's from here, and the draft too; read from another version than the one just opened, its
        // source can't be checked now.
        ownsDraft = true
        sourceKnown = draft.sourceVersionId != null && draft.sourceVersionId == sourceVersionId
        sourceVersionId = draft.sourceVersionId
        buffer.replace(0, buffer.length, draft.text)
        draft.selection?.let {
            val end = buffer.length
            val from = it.from.toInt().coerceIn(0, end)
            val until = it.to.toInt().coerceIn(0, end)
            android.text.Selection.setSelection(buffer, from, until)
            selection = from to until
        }
        markEdited()
        if (pending.kind == DraftOffer.STALE) stale = Stale(pending.openedVersionId)
    }

    /* Discard: the draft goes, nothing more is asked; the text stays as the file holds it. */
    fun discardDraft() {
        val pending = offer ?: return
        offer = null
        removeDraft(pending.file, force = true)
    }

    /*
     * Closed by the person (Discard, nothing to keep, saved): the draft this session owns goes; an offer still unanswered keeps
     * its draft, and an editor that wrote nothing (closed while loading) removes nothing. `gone` (the file's family cleared
     * out): its draft goes whatever, offer or not.
     */
    fun closed(gone: Boolean = false) {
        draftTurn?.cancel()
        if (gone) removeDraft(target, force = true) else if (offer == null) removeDraft(target)
        end()
    }

    /* Closed, signed out or another session: the text goes with it, and nothing more lands here. */
    fun end() {
        draftTurn?.cancel()
        session.close()
        work?.cancel()
        saveJob?.cancel()
        reading?.cancel()
        parsing?.cancel()
        buffer.clear()
        buffer.clearSpans()
        savedText = null
        saveState = null
        previewTooLong = false
        preview = null
        textLines = null
        previewing = false
        phase = Phase.Loading
    }
}

/*
 * The editor's screen: the system's EditText over the session's buffer, monospaced, wrapped, with no suggestions and no
 * learning from what is typed (IME_FLAG_NO_PERSONALIZED_LEARNING); a line break typed or pasted goes in as LF. No colouring
 * on the phone. Save in the bar; Back and Close ask first when there are changes.
 */
@Composable
fun TextEditorScreen(edit: TextEdit, close: () -> Unit, marks: @Composable (Opened) -> Unit = {}) {
    val alpine = Alpine.colors
    // Source and preview side by side when the window is wide (Adaptive.kt editorSideBySide), the switch when narrow.
    val (widthDp, heightDp) = windowDp()
    val side = edit.markdown && editorSideBySide(widthDp, heightDp)
    LaunchedEffect(side) { edit.sideBySide(side) }
    val listState = rememberLazyListState()
    val coroutines = rememberCoroutineScope()
    val scroll = remember(edit) { EditorScroll(edit) }
    scroll.listState = listState
    scroll.scope = coroutines
    scroll.linked = side
    // The preview scrolled: a person's scroll (a drag or its fling) moves the source; the link's own never comes back.
    LaunchedEffect(listState, scroll) {
        snapshotFlow { listState.firstVisibleItemIndex to listState.firstVisibleItemScrollOffset }
            .collect { (index, offset) -> scroll.previewMoved(index, offset, listState.isScrollInProgress) }
    }
    // A new rendering: beside the source it follows the source (typing keeps the cursor in view there); after a narrow
    // switch it opens at the line the source had at its top.
    LaunchedEffect(edit.preview) {
        if (edit.preview == null) return@LaunchedEffect
        val kept = edit.keptLine
        if (!side && kept != null) {
            edit.keptLine = null
            scroll.movePreview(kept)
        } else if (side) {
            scroll.followSource()
        }
    }
    var leaving by remember { mutableStateOf(false) }
    var confirmTheirs by remember { mutableStateOf(false) }
    // Leaving the screen (Home, another app, the screen off): the text as it is now is kept, in case the app is not brought back.
    val lifecycle = androidx.lifecycle.compose.LocalLifecycleOwner.current.lifecycle
    androidx.compose.runtime.DisposableEffect(lifecycle, edit) {
        val observer = androidx.lifecycle.LifecycleEventObserver { _, event ->
            if (event == androidx.lifecycle.Lifecycle.Event.ON_STOP) edit.flushDraft()
        }
        lifecycle.addObserver(observer)
        onDispose { lifecycle.removeObserver(observer) }
    }
    // While a save is on its way it may still publish: Close never offers Discard then, it waits (TextEdit.closing).
    val tryClose = {
        when {
            edit.saving -> edit.closeWhenSaved()
            edit.changed() -> leaving = true
            else -> close()
        }
    }
    LaunchedEffect(edit.closeAfter) {
        val landed = edit.closeAfter ?: return@LaunchedEffect
        edit.closeHandled()
        if (landed) { if (edit.changed()) leaving = true else close() }
    }
    Dialog(onDismissRequest = tryClose, properties = DialogProperties(usePlatformDefaultWidth = false, decorFitsSystemWindows = false)) {
        Scaffold(
            containerColor = alpine.ground,
            topBar = {
                Column {
                    // The name and its marks from one row: the version the text is (TextEdit.marked), as the viewer marks it.
                    DestinationBar(edit.marked.name, onBack = tryClose) {
                        if (edit.phase == TextEdit.Phase.Editing) {
                            if (edit.saving) CircularProgressIndicator(Modifier.padding(horizontal = AlpineSpace.S4).size(22.dp), color = alpine.primary, strokeWidth = 2.5.dp)
                            else TextButton(enabled = edit.edited, onClick = { edit.save() }) { Text(EditorWords.SAVE) }
                        }
                    }
                    marks(edit.marked)
                    val phase = edit.phase
                    if (!side && edit.markdown && (phase == TextEdit.Phase.Editing || (phase is TextEdit.Phase.ReadOnly && phase.text != null))) {
                        SingleChoiceSegmentedButtonRow(Modifier.fillMaxWidth().padding(horizontal = AlpineSpace.S4, vertical = AlpineSpace.S2)) {
                            // Each keeps the line the other had at its top.
                            SegmentedButton(selected = !edit.previewing, onClick = {
                                if (edit.previewing) scroll.previewLine()?.let(scroll::showSource)
                                edit.showSource()
                            }, shape = SegmentedButtonDefaults.itemShape(0, 2)) { Text(EditorWords.SOURCE) }
                            SegmentedButton(selected = edit.previewing, onClick = {
                                if (!edit.previewing) edit.keptLine = scroll.sourceLine()
                                edit.showPreview()
                            }, shape = SegmentedButtonDefaults.itemShape(1, 2)) { Text(EditorWords.PREVIEW) }
                        }
                    }
                }
            },
        ) { padding ->
            Column(Modifier.fillMaxSize().padding(padding)) {
                when (val phase = edit.phase) {
                    TextEdit.Phase.Loading -> Column(Modifier.fillMaxWidth().padding(top = 48.dp), horizontalAlignment = Alignment.CenterHorizontally) {
                        CircularProgressIndicator(color = alpine.primary)
                    }
                    TextEdit.Phase.Failed -> EmptyState(EditorWords.FAILED, modifier = Modifier.padding(top = 96.dp)) {
                        androidx.compose.material3.Button(onClick = { edit.load() }) { Text(EditorWords.TRY_AGAIN) }
                    }
                    is TextEdit.Phase.ReadOnly -> {
                        if (edit.previewTooLong && !side) Note(EditorWords.PREVIEW_TOO_LONG)
                        Note(TextEditing.words(phase.reason))
                        phase.text?.let { text ->
                            SourceAndPreview(side) {
                                PlainText(text = text, buffer = null, onEdit = {}, scroll = scroll, hidden = edit.previewing && !side)
                                if (side || edit.previewing) MarkdownPreview(edit.preview, listState, divided = side, unavailable = edit.previewTooLong)
                            }
                        } ?: Spacer(Modifier.height(0.dp))
                    }
                    TextEdit.Phase.Editing -> {
                        val line = if (edit.closing) EditorWords.FINISHING else edit.failure ?: edit.status.takeIf { !edit.edited }
                        line?.let { Note(it, failed = !edit.closing && edit.failure != null) }
                        if (edit.previewTooLong && !side) Note(EditorWords.PREVIEW_TOO_LONG)
                        edit.format?.let(TextEditing::mixedNote)?.let { Note(it) }
                        if (edit.draftNotKept) Note(EditorWords.DRAFT_NOT_KEPT)
                        // The EditText stays while the preview shows (out of sight, focus and TalkBack): it holds the text.
                        SourceAndPreview(side) {
                            PlainText(text = null, buffer = edit.buffer, onEdit = edit::markEdited, scroll = scroll, hidden = edit.previewing && !side)
                            if (side || edit.previewing) MarkdownPreview(edit.preview, listState, divided = side, unavailable = edit.previewTooLong)
                        }
                    }
                }
            }
        }
        edit.stale?.let { stale ->
            if (!confirmTheirs) Sheet(onDismissRequest = { edit.stale = null }) {
                Column(Modifier.padding(horizontal = AlpineSpace.S6, vertical = AlpineSpace.S2)) {
                    Text(if (stale.currentVersionId == null) EditorWords.GONE_TITLE else EditorWords.STALE_TITLE, style = MaterialTheme.typography.titleLarge, color = alpine.ink)
                    Text(if (stale.currentVersionId == null) EditorWords.GONE_TEXT else EditorWords.STALE_TEXT, style = MaterialTheme.typography.bodyMedium,
                        color = alpine.inkMuted, modifier = Modifier.padding(top = AlpineSpace.S2, bottom = AlpineSpace.S2))
                }
                stale.currentVersionId?.let { current ->
                    SheetRow(EditorWords.ON_TOP, Icons.Outlined.Save, action = true) { edit.stale = null; edit.save(onTopOf = current) }
                }
                SheetRow(EditorWords.COPY, Icons.Outlined.ContentCopy) { edit.stale = null; edit.saveCopy() }
                if (stale.currentVersionId != null) SheetRow(EditorWords.THEIRS, Icons.Outlined.History, danger = true) { confirmTheirs = true }
                Spacer(Modifier.height(AlpineSpace.S4))
            }
        }
        if (confirmTheirs) AlertDialog(
            onDismissRequest = { confirmTheirs = false },
            title = { Text(EditorWords.DISCARD_TITLE) },
            text = { Text(EditorWords.THEIRS_TEXT) },
            confirmButton = { TextButton(onClick = { confirmTheirs = false; edit.openTheirs() }) { Text(EditorWords.DISCARD, color = alpine.danger) } },
            // Back to the three choices: nothing was discarded.
            dismissButton = { TextButton(onClick = { confirmTheirs = false }) { Text(EditorWords.CANCEL) } },
        )
        // A draft from an earlier session: answered before the text can be changed (no way out but the two answers).
        edit.offer?.let { pending ->
            AlertDialog(
                onDismissRequest = {},
                title = { Text(EditorWords.restoreOffer(DraftRules.whenSaved(pending.draft.frame.savedAt.toLong()))) },
                confirmButton = { TextButton(onClick = edit::restoreDraft) { Text(EditorWords.RESTORE) } },
                dismissButton = { TextButton(onClick = edit::discardDraft) { Text(EditorWords.DISCARD_DRAFT) } },
                properties = DialogProperties(dismissOnBackPress = false, dismissOnClickOutside = false),
            )
        }
        if (leaving) AlertDialog(
            onDismissRequest = { leaving = false },
            title = { Text(EditorWords.DISCARD_TITLE) },
            text = { Text(EditorWords.leaveText(edit.target.name)) },
            confirmButton = { TextButton(onClick = { leaving = false; close() }) { Text(EditorWords.DISCARD, color = alpine.danger) } },
            dismissButton = { TextButton(onClick = { leaving = false }) { Text(EditorWords.KEEP_EDITING) } },
        )
    }
}

/*
 * The verdict on the version the editor read (or last published), under its name: Unverified or Couldn't check as the
 * viewer's rows mark it, a family's mark by its member list, and "Saved from a link" in plain words.
 */
@Composable
fun EditorMarks(model: DriveViewModel, state: DriveState, row: Opened) {
    val alpine = Alpine.colors
    val family = model.families.familyOf(row) != null
    // This exact row's verdict, kept apart from the listing's (another device's newer version judged meanwhile never takes
    // it), and judged again whenever its family's trust moved and dropped it.
    androidx.compose.runtime.DisposableEffect(row.id, row.node) {
        if (family) model.families.holdForEditor(row)
        onDispose { model.families.holdForEditor(null) }
    }
    val unjudged = family && model.families.verdict(row) == null
    LaunchedEffect(row.node, unjudged) { if (unjudged) model.families.judge(listOf(row)) }
    val saved = remember(row.node, state.trust) { com.hushos.app.data.savedLineOf(row.node, state.trust) }
    if (!model.marked(row, state) && saved == null) return
    Column(Modifier.fillMaxWidth().padding(horizontal = AlpineSpace.S4).padding(bottom = AlpineSpace.S2)) {
        UnverifiedMark(model, state, row)
        saved?.let { Text(it, style = MaterialTheme.typography.bodySmall, color = alpine.inkMuted) }
    }
}

@Composable
private fun Note(text: String, failed: Boolean = false) {
    val alpine = Alpine.colors
    Text(text, style = MaterialTheme.typography.bodySmall, color = if (failed) alpine.danger else alpine.inkMuted,
        modifier = Modifier.fillMaxWidth().background(alpine.surface).padding(horizontal = AlpineSpace.S4, vertical = AlpineSpace.S2))
}

/*
 * The text and the preview: side by side when wide, else one over the other (the EditText kept underneath). One layout
 * that only changes how it places them, so a change of width within the window keeps the same EditText.
 */
@Composable
private fun SourceAndPreview(side: Boolean, content: @Composable () -> Unit) {
    Layout(content, Modifier.fillMaxSize()) { measurables, constraints ->
        val width = constraints.maxWidth
        val height = constraints.maxHeight
        val half = if (side) width / 2 else width
        val placeables = measurables.mapIndexed { index, measurable ->
            measurable.measure(Constraints.fixed(if (side && index == 1) width - half else half, height))
        }
        layout(width, height) {
            placeables.forEachIndexed { index, placeable -> placeable.place(if (side && index == 1) half else 0, 0) }
        }
    }
}

/* The viewer's Markdown blocks (MarkdownViewer.kt): raw HTML dropped, links only on a tap, images named and never fetched. */
@Composable
private fun MarkdownPreview(pieces: List<MdPiece>?, state: LazyListState, divided: Boolean, unavailable: Boolean = false) {
    val alpine = Alpine.colors
    val rule = alpine.rule
    Box(Modifier.fillMaxSize().background(alpine.ground).drawBehind {
        if (divided) drawLine(rule, Offset(0f, 0f), Offset(0f, size.height), 1.dp.toPx())
    }) {
        // Past the limit: said here, never a spinner for a rendering that won't start.
        if (unavailable) Text(EditorWords.PREVIEW_TOO_LONG, style = MaterialTheme.typography.bodySmall, color = alpine.inkMuted,
            modifier = Modifier.align(Alignment.TopCenter).padding(24.dp))
        else if (pieces == null) CircularProgressIndicator(color = alpine.primary, modifier = Modifier.align(Alignment.TopCenter).padding(top = 48.dp))
        else LazyColumn(
            modifier = Modifier.fillMaxSize(),
            state = state,
            contentPadding = PaddingValues(horizontal = 16.dp, vertical = 24.dp),
            verticalArrangement = Arrangement.spacedBy(16.dp),
        ) {
            // Not selectable: a copy from here would go to the clipboard without the editor's protections.
            itemsIndexed(pieces) { _, piece -> MarkdownBlockView(piece.block) }
        }
    }
}

/*
 * The source (the EditText) and the preview (a LazyColumn) scrolled together, by source line (TextLines, LineMap): the
 * line at the top of the text, and the block at the top of the preview and how far down it. Only a person's scroll
 * leads. The link's own scroll of the text is set and seen in one call (`ours`), and its own move of the preview is
 * recognised when it lands (`expected`), so neither comes back to move the pane that led.
 */
private class EditorScroll(val edit: TextEdit) {
    var editText: EditText? = null
    var listState: LazyListState? = null
    var scope: CoroutineScope? = null
    var linked = false
    private var ours = false
    private var expected: Pair<Int, Int>? = null

    /* The top of a line and of the next, in the text's layout. */
    private fun bounds(view: EditText, layout: android.text.Layout, lines: TextLines, line: Int): Pair<Int, Int> {
        val top = layout.getLineTop(layout.getLineForOffset(lines.startOf(line)))
        val next = if (line < lines.count) layout.getLineTop(layout.getLineForOffset(lines.startOf(line + 1))) else layout.height
        return top to maxOf(next, top)
    }

    /* The fractional source line at the top of the text. */
    fun sourceLine(): Double? {
        val view = editText ?: return null
        val layout = view.layout ?: return null
        if (view.scrollY <= 0) return 1.0
        val y = view.scrollY - view.totalPaddingTop
        // The index the last rendering built; none (plain text, past the limit, not rendered yet): no line to give.
        val lines = edit.textLines ?: return null
        val line = lines.lineAt(layout.getLineStart(layout.getLineForVertical(maxOf(y, 0))))
        val (top, next) = bounds(view, layout, lines, line)
        val fraction = if (next > top) (y - top).toDouble() / (next - top) else 0.0
        return line + fraction.coerceIn(0.0, 0.999)
    }

    /* Puts `line` at the top of the text. */
    fun showSource(line: Double) {
        val view = editText ?: return
        val layout = view.layout ?: return
        val lines = edit.textLines ?: return
        val whole = line.toInt().coerceIn(1, lines.count)
        val (top, next) = bounds(view, layout, lines, whole)
        val most = maxOf(0, layout.height + view.totalPaddingTop + view.totalPaddingBottom - view.height)
        val y = (top + (line - whole).coerceIn(0.0, 1.0) * (next - top)).toInt() + view.totalPaddingTop
        scrollSource(view, y.coerceIn(0, most))
    }

    /* Puts text offset `offset` at the top of the text: a fold's restore, with no line index needed. */
    fun showOffset(offset: Int) {
        val view = editText ?: return
        val layout = view.layout ?: return
        val most = maxOf(0, layout.height + view.totalPaddingTop + view.totalPaddingBottom - view.height)
        val y = layout.getLineTop(layout.getLineForOffset(offset.coerceIn(0, view.length()))) + view.totalPaddingTop
        scrollSource(view, y.coerceIn(0, most))
    }

    private fun scrollSource(view: EditText, y: Int) {
        ours = true
        try {
            view.scrollTo(0, y)
        } finally {
            ours = false
        }
        recordTop(view)
    }

    /* The offset at the top of the text, for a fold: the layout's own line start, no scan. */
    private fun recordTop(view: EditText) {
        val layout = view.layout ?: return
        edit.topOffset = layout.getLineStart(layout.getLineForVertical(maxOf(view.scrollY - view.totalPaddingTop, 0)))
    }

    /* The text scrolled: kept for a fold, and side by side the preview follows, unless the link scrolled it. */
    fun sourceScrolled() {
        if (ours) return
        editText?.let(::recordTop)
        if (!linked) return
        movePreview(sourceLine() ?: return)
    }

    /* Side by side, after a rendering: the preview goes where the source is. */
    fun followSource() {
        movePreview(sourceLine() ?: return)
    }

    /* The fractional source line at the top of the preview. */
    fun previewLine(): Double? {
        val state = listState ?: return null
        val map = edit.lineMap ?: return null
        // The item firstVisibleItemScrollOffset belongs to: one still showing in the content padding above is not it.
        val index = state.firstVisibleItemIndex
        val first = state.layoutInfo.visibleItemsInfo.firstOrNull { it.index == index } ?: return null
        val fraction = if (first.size > 0) state.firstVisibleItemScrollOffset.toDouble() / first.size else 0.0
        return map.line(first.index, fraction)
    }

    /*
     * Puts `line` at the top of the preview: its block, then as far down it as the line is. A block not laid out yet has
     * no height to take a fraction of: it is scrolled to first, measured, and then put at the fraction (a narrow switch
     * in the middle of a tall code block keeps its line).
     */
    fun movePreview(line: Double) {
        val state = listState ?: return
        val (index, fraction) = edit.lineMap?.place(line) ?: return
        scope?.launch {
            var size = state.layoutInfo.visibleItemsInfo.firstOrNull { it.index == index }?.size
            if (size == null) {
                expected = index to 0
                state.scrollToItem(index, 0)
                withFrameNanos { }
                size = state.layoutInfo.visibleItemsInfo.firstOrNull { it.index == index }?.size ?: return@launch
            }
            val offset = (fraction * size).toInt()
            if (state.firstVisibleItemIndex == index && state.firstVisibleItemScrollOffset == offset) return@launch
            expected = index to offset
            state.scrollToItem(index, offset)
        }
    }

    /* The preview's first block or offset changed: its own move lands here once and is let go; a person's moves the text. */
    fun previewMoved(index: Int, offset: Int, byPerson: Boolean) {
        if (expected == index to offset) {
            expected = null
            return
        }
        if (!byPerson || !linked) return
        previewLine()?.let(::showSource)
    }
}

/* The EditText: over `buffer` in place when editing, or `text` read-only; `hidden` while the preview covers it. */
@Composable
private fun PlainText(text: String?, buffer: SpannableStringBuilder?, onEdit: () -> Unit, scroll: EditorScroll, hidden: Boolean = false) {
    val alpine = Alpine.colors
    val ink = alpine.ink.toArgb()
    val background = alpine.ground.toArgb()
    AndroidView(
        modifier = Modifier.fillMaxSize(),
        factory = { context ->
            // Where the person was before a fold, an unfold or a resize made this view again: read before the new view's
            // own first selection and scroll replace them.
            val edit = scroll.edit
            val keptSelection = edit.selection
            val keptOffset = edit.topOffset
            var ready = false
            object : EditText(context) {
                override fun onSelectionChanged(selStart: Int, selEnd: Int) {
                    super.onSelectionChanged(selStart, selEnd)
                    if (ready) edit.selection = selStart to selEnd
                }
            }.apply {
                // The text is never written into the saved instance state (a Bundle the system may keep on disk).
                isSaveEnabled = false
                freezesText = false
                importantForAutofill = View.IMPORTANT_FOR_AUTOFILL_NO_EXCLUDE_DESCENDANTS
                typeface = Typeface.MONOSPACE
                setTextSize(TypedValue.COMPLEX_UNIT_SP, 15f)
                setTextColor(ink)
                setBackgroundColor(background)
                gravity = Gravity.TOP or Gravity.START
                val pad = (12 * resources.displayMetrics.density).toInt()
                setPadding(pad, pad, pad, pad * 2)
                inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_FLAG_MULTI_LINE or InputType.TYPE_TEXT_FLAG_NO_SUGGESTIONS
                imeOptions = EditorInfo.IME_FLAG_NO_PERSONALIZED_LEARNING or EditorInfo.IME_FLAG_NO_EXTRACT_UI
                isVerticalScrollBarEnabled = true
                if (buffer != null) {
                    contentDescription = "Text"
                    // Edits go into the session's buffer itself, never a copy of it.
                    setEditableFactory(object : Editable.Factory() {
                        override fun newEditable(source: CharSequence): Editable = if (source === buffer) buffer else super.newEditable(source)
                    })
                    setText(buffer, TextView.BufferType.EDITABLE)
                    filters = arrayOf(InputFilter { source, start, end, _, _, _ ->
                        val part = source.subSequence(start, end)
                        if ('\r' in part) TextEditing.lineFeeds(part) else null
                    })
                    addTextChangedListener(object : TextWatcher {
                        override fun beforeTextChanged(s: CharSequence?, start: Int, count: Int, after: Int) {}
                        override fun onTextChanged(s: CharSequence?, start: Int, before: Int, count: Int) {}
                        override fun afterTextChanged(s: Editable?) {
                            onEdit()
                        }
                    })
                } else {
                    contentDescription = "Text, read only"
                    keyListener = null
                    setTextIsSelectable(true)
                    setText(text.orEmpty())
                }
                scroll.editText = this
                setOnScrollChangeListener { _, _, _, _, _ -> if (ready) scroll.sourceScrolled() }
                keptSelection?.let { (start, end) -> setSelection(start.coerceIn(0, length()), end.coerceIn(0, length())) }
                // Laid out first, then put back where it was.
                post {
                    scroll.showOffset(keptOffset)
                    ready = true
                }
            }
        },
        update = { view ->
            // Out of sight, focus and TalkBack under the preview, its keyboard gone; back as it was after.
            val shown = if (hidden) View.INVISIBLE else View.VISIBLE
            if (view.visibility != shown) {
                view.visibility = shown
                if (hidden) {
                    view.clearFocus()
                    view.context.getSystemService(android.view.inputmethod.InputMethodManager::class.java)?.hideSoftInputFromWindow(view.windowToken, 0)
                }
            }
        },
    )
}
