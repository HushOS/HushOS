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
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.background
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.ContentCopy
import androidx.compose.material.icons.outlined.History
import androidx.compose.material.icons.outlined.Save
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
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
import com.hushos.app.data.Opened
import com.hushos.app.data.SaveRunJournal
import com.hushos.app.data.SaveRuns
import com.hushos.app.data.TextEditing
import com.hushos.app.data.TextSave
import com.hushos.app.data.TextSaved
import com.hushos.app.data.Vault
import com.hushos.app.data.VaultSaveWriter
import com.hushos.core.RunControl
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
}

/*
 * An editing session (Editing 1a; docs/editing-design.md sections 1 and 3, the web's text-editor.tsx, iOS's
 * TextEditorScreen): the file's current version read again from the server into one buffer the system's EditText edits in
 * place, saved explicitly as a new version through the save path (TextSave over SaveRuns), with the stale choices when
 * someone else saved first. Held by the view model, so a rotation keeps the text; every path that ends a session ends this
 * one (`end`), its text emptied. Nothing is kept on the phone (drafts are Editing 1c), and the decrypted copy it reads goes
 * as soon as it is read.
 */
class TextEdit(val item: Opened, private val context: Context, private val scope: CoroutineScope, private val vault: () -> Vault?,
               private val saved: (parentId: String?) -> Unit) {
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
    private var startedFrom: String? = item.node.currentVersion?.id
    /* The text, edited in place by the EditText: never copied per keystroke, never put in a Bundle. */
    val buffer = SpannableStringBuilder()
    var edited by mutableStateOf(false); private set
    var saving by mutableStateOf(false); private set
    var status by mutableStateOf<String?>(null); private set
    var failure by mutableStateOf<String?>(null); private set
    var stale by mutableStateOf<Stale?>(null)
    private var work: Job? = null
    private var reading: RunControl? = null
    private var ended = false

    private fun writer(vault: Vault) = VaultSaveWriter(vault, storage = { Auth.storage(context) })
    private fun start(vault: Vault) = TextSave.runs(writer(vault), SaveRunJournal.of(context))

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
        work = scope.launch {
            val vault = vault() ?: return@launch
            val opened = withContext(Dispatchers.IO) {
                runCatching {
                    // The row in the file's own folder and workspace, and its bytes read for that row's version, in memory:
                    // nothing decrypted is written to disk for a killed process to leave behind.
                    val file = writer(vault).editTarget(from).second ?: return@runCatching null
                    if ((file.size ?: 0L) > TextEditing.LIMIT) return@runCatching file to TextEditing.Open.ReadOnly(TextReadOnly.TOO_LARGE, null)
                    file to TextEditing.open(TextEditing.bytesOf(vault, file, TextEditing.LIMIT, control))
                }.getOrNull()
            }
            if (ended) return@launch
            if (opened == null) {
                phase = Phase.Failed
                return@launch
            }
            val (file, text) = opened
            target = file
            startedFrom = file.node.currentVersion?.id
            edited = false
            buffer.clear()
            buffer.clearSpans()
            phase = when (text) {
                is TextEditing.Open.Editable -> Phase.Editing.also { buffer.append(text.text) }
                is TextEditing.Open.ReadOnly -> Phase.ReadOnly(text.reason, text.text)
            }
        }
    }

    /* Save, and Save on top (`onTopOf`: the version current now). */
    fun save(onTopOf: String? = null) {
        if (phase != Phase.Editing || saving) return
        val vault = vault() ?: return
        val text = buffer.toString()
        val file = target
        saving = true
        failure = null
        status = null
        scope.launch {
            val result = withContext(Dispatchers.IO) {
                runCatching {
                    val writer = writer(vault)
                    val (folder, listed) = writer.editTarget(file)
                    if (listed == null) TextSaved.Stale(null)
                    else TextSave.version(text, listed, folder, onTopOf ?: startedFrom, TextSave.runs(writer, SaveRunJournal.of(context)))
                }
            }
            saving = false
            if (ended) return@launch
            result.onSuccess { done ->
                when (done) {
                    is TextSaved.Stale -> stale = Stale(done.currentVersionId)
                    is TextSaved.Saved -> {
                        target = done.item
                        // The version this save published, never the reply row's (which may already be someone else's):
                        // unknown, the next save asks the stale question.
                        startedFrom = done.versionId
                        // Typed while it saved: still changed.
                        edited = buffer.toString() != text
                        status = EditorWords.SAVED
                        saved(done.item.node.parentId)
                    }
                }
            }.onFailure { failure = SaveRuns.reason(it) ?: EditorWords.SAVE_FAILED }
        }
    }

    fun saveCopy() {
        val vault = vault() ?: return
        val text = buffer.toString()
        val file = target
        saving = true
        failure = null
        scope.launch {
            val result = withContext(Dispatchers.IO) {
                runCatching {
                    val writer = writer(vault)
                    val (folder, _) = writer.editTarget(file)
                    TextSave.copy(text, file, folder, writer.copySources(file), TextSave.runs(writer, SaveRunJournal.of(context)))
                }
            }
            saving = false
            if (ended) return@launch
            result.onSuccess { made ->
                // From here on the editor writes the copy, by the run's own row and version; the file someone else saved
                // stays theirs.
                target = made.file
                startedFrom = made.versionId
                edited = buffer.toString() != text
                status = EditorWords.savedCopy(made.file.name)
                saved(made.file.node.parentId)
            }.onFailure { failure = SaveRuns.reason(it) ?: EditorWords.SAVE_FAILED }
        }
    }

    /* Their version, read in place of this text (after the person confirmed). */
    fun openTheirs() {
        stale = null
        status = null
        failure = null
        edited = false
        buffer.clear()
        load(target)
    }

    /* Closed, signed out or another session: the text goes with it, and nothing more lands here. */
    fun end() {
        ended = true
        work?.cancel()
        reading?.cancel()
        buffer.clear()
        buffer.clearSpans()
        phase = Phase.Loading
    }
}

/*
 * The editor's screen: the system's EditText over the session's buffer, monospaced, wrapped, with no suggestions and no
 * learning from what is typed (IME_FLAG_NO_PERSONALIZED_LEARNING); a line break typed or pasted goes in as LF. No colouring
 * on the phone. Save in the bar; Back and Close ask first when there are changes.
 */
@Composable
fun TextEditorScreen(edit: TextEdit, close: () -> Unit) {
    val alpine = Alpine.colors
    var leaving by remember { mutableStateOf(false) }
    var confirmTheirs by remember { mutableStateOf(false) }
    val tryClose = { if (edit.edited) leaving = true else close() }
    Dialog(onDismissRequest = tryClose, properties = DialogProperties(usePlatformDefaultWidth = false, decorFitsSystemWindows = false)) {
        Scaffold(
            containerColor = alpine.ground,
            topBar = {
                DestinationBar(edit.target.name, onBack = tryClose) {
                    if (edit.phase == TextEdit.Phase.Editing) {
                        if (edit.saving) CircularProgressIndicator(Modifier.padding(horizontal = AlpineSpace.S4).size(22.dp), color = alpine.primary, strokeWidth = 2.5.dp)
                        else TextButton(enabled = edit.edited, onClick = { edit.save() }) { Text(EditorWords.SAVE) }
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
                        Note(TextEditing.words(phase.reason))
                        phase.text?.let { text -> PlainText(text = text, buffer = null, onEdit = {}) } ?: Spacer(Modifier.height(0.dp))
                    }
                    TextEdit.Phase.Editing -> {
                        val line = edit.failure ?: edit.status.takeIf { !edit.edited }
                        line?.let { Note(it, failed = edit.failure != null) }
                        PlainText(text = null, buffer = edit.buffer, onEdit = edit::markEdited)
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

@Composable
private fun Note(text: String, failed: Boolean = false) {
    val alpine = Alpine.colors
    Text(text, style = MaterialTheme.typography.bodySmall, color = if (failed) alpine.danger else alpine.inkMuted,
        modifier = Modifier.fillMaxWidth().background(alpine.surface).padding(horizontal = AlpineSpace.S4, vertical = AlpineSpace.S2))
}

/* The EditText: over `buffer` in place when editing, or `text` read-only. */
@Composable
private fun PlainText(text: String?, buffer: SpannableStringBuilder?, onEdit: () -> Unit) {
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
    )
}
