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
import androidx.compose.foundation.lazy.itemsIndexed
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
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.toArgb
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import com.hushos.app.data.Auth
import com.hushos.app.data.EditSession
import com.hushos.app.data.MarkdownDocument
import com.hushos.app.data.MdBlock
import com.hushos.app.data.NotAuthenticated
import com.hushos.app.data.Opened
import com.hushos.app.data.SaveRunJournal
import com.hushos.app.data.SaveRunStopped
import com.hushos.app.data.SaveRuns
import com.hushos.app.data.TextEditing
import com.hushos.app.data.TextSave
import com.hushos.app.data.TextSaved
import com.hushos.app.data.Vault
import com.hushos.app.data.VaultSaveWriter
import com.hushos.core.RunControl
import com.hushos.core.TextFormat
import com.hushos.core.TextReadOnly
import com.hushos.core.toolWatchdogMillis
import com.hushos.tokens.AlpineSpace
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
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
 * one (`end`), its text emptied. Nothing is kept on the phone (drafts are Editing 1c), and the decrypted copy it reads goes
 * as soon as it is read.
 */
class TextEdit(val item: Opened, private val context: Context, private val scope: CoroutineScope, opening: Vault,
               current: () -> Vault?, private val saved: (parentId: String?) -> Unit,
               private val refused: (com.hushos.app.data.Shared.Session?) -> Unit = {}) {
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
     * Markdown shows Source or Preview; the preview renders the text as it was when Preview was chosen. Decided by the row the
     * text was read from (load, Open theirs included), never the item sheet's, which may be a version or a rename behind.
     */
    var markdown by mutableStateOf(false); private set
    var previewing by mutableStateOf(false); private set
    /* The text was past what the preview renders when Preview was chosen: it stayed on Source and says so. */
    var previewTooLong by mutableStateOf(false); private set
    var preview by mutableStateOf<List<MdBlock>?>(null); private set
    private var parsing: Job? = null

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
        parsing?.cancel()
        // Parsed off the main thread: a long file shouldn't hold up the switch.
        parsing = scope.launch {
            val blocks = withContext(Dispatchers.Default) { MarkdownDocument.parse(text) }
            if (previewing) preview = blocks
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
        if (!edited) edited = true
        status = null
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
                        status = EditorWords.SAVED
                        saved(done.item.node.parentId)
                    }
                }
            }.onFailure { failure = SaveRuns.reason(it) ?: EditorWords.SAVE_FAILED }
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
                    bytes to TextSave.copy(bytes, file, folder, writer.copySources(from, named = file), TextSave.runs(writer, SaveRunJournal.of(context)),
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
                target = made.file
                startedFrom = if (destination?.holds(made.file) == true) made.versionId else null
                markWith(made.file, made.versionId)
                savedText = text
                settle(text, bytes)
                edited = !TextEditing.same(buffer, text)
                status = EditorWords.savedCopy(made.file.name)
                saved(made.file.node.parentId)
            }.onFailure { failure = SaveRuns.reason(it) ?: EditorWords.SAVE_FAILED }
            settledSave(result.isSuccess)
        }
    }

    /* Their version, read in place of this text (after the person confirmed). */
    fun openTheirs() {
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
        load(target)
    }

    /* Closed, signed out or another session: the text goes with it, and nothing more lands here. */
    fun end() {
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
    var leaving by remember { mutableStateOf(false) }
    var confirmTheirs by remember { mutableStateOf(false) }
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
                    if (edit.markdown && (phase == TextEdit.Phase.Editing || (phase is TextEdit.Phase.ReadOnly && phase.text != null))) {
                        SingleChoiceSegmentedButtonRow(Modifier.fillMaxWidth().padding(horizontal = AlpineSpace.S4, vertical = AlpineSpace.S2)) {
                            SegmentedButton(selected = !edit.previewing, onClick = edit::showSource, shape = SegmentedButtonDefaults.itemShape(0, 2)) { Text(EditorWords.SOURCE) }
                            SegmentedButton(selected = edit.previewing, onClick = edit::showPreview, shape = SegmentedButtonDefaults.itemShape(1, 2)) { Text(EditorWords.PREVIEW) }
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
                        if (edit.previewTooLong) Note(EditorWords.PREVIEW_TOO_LONG)
                        Note(TextEditing.words(phase.reason))
                        phase.text?.let { text ->
                            Box(Modifier.fillMaxSize()) {
                                PlainText(text = text, buffer = null, onEdit = {}, hidden = edit.previewing)
                                if (edit.previewing) MarkdownPreview(edit.preview)
                            }
                        } ?: Spacer(Modifier.height(0.dp))
                    }
                    TextEdit.Phase.Editing -> {
                        val line = if (edit.closing) EditorWords.FINISHING else edit.failure ?: edit.status.takeIf { !edit.edited }
                        line?.let { Note(it, failed = !edit.closing && edit.failure != null) }
                        if (edit.previewTooLong) Note(EditorWords.PREVIEW_TOO_LONG)
                        edit.format?.let(TextEditing::mixedNote)?.let { Note(it) }
                        // The EditText stays while the preview shows (out of sight, focus and TalkBack): it holds the text.
                        Box(Modifier.fillMaxSize()) {
                            PlainText(text = null, buffer = edit.buffer, onEdit = edit::markEdited, hidden = edit.previewing)
                            if (edit.previewing) MarkdownPreview(edit.preview)
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

/* The viewer's Markdown blocks (MarkdownViewer.kt): raw HTML dropped, links only on a tap, images named and never fetched. */
@Composable
private fun MarkdownPreview(blocks: List<MdBlock>?) {
    val alpine = Alpine.colors
    Box(Modifier.fillMaxSize().background(alpine.ground)) {
        if (blocks == null) CircularProgressIndicator(color = alpine.primary, modifier = Modifier.align(Alignment.TopCenter).padding(top = 48.dp))
        else LazyColumn(
            modifier = Modifier.fillMaxSize(),
            contentPadding = PaddingValues(horizontal = 16.dp, vertical = 24.dp),
            verticalArrangement = Arrangement.spacedBy(16.dp),
        ) {
            // Not selectable: a copy from here would go to the clipboard without the editor's protections.
            itemsIndexed(blocks) { _, block -> MarkdownBlockView(block) }
        }
    }
}

/* The EditText: over `buffer` in place when editing, or `text` read-only; `hidden` while the preview covers it. */
@Composable
private fun PlainText(text: String?, buffer: SpannableStringBuilder?, onEdit: () -> Unit, hidden: Boolean = false) {
    val alpine = Alpine.colors
    val ink = alpine.ink.toArgb()
    val background = alpine.ground.toArgb()
    AndroidView(
        modifier = Modifier.fillMaxSize(),
        factory = { context ->
            EditText(context).apply {
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
                        override fun afterTextChanged(s: Editable?) = onEdit()
                    })
                } else {
                    contentDescription = "Text, read only"
                    keyListener = null
                    setTextIsSelectable(true)
                    setText(text.orEmpty())
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
