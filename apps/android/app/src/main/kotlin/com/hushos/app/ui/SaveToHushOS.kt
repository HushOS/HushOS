package com.hushos.app.ui

import android.app.Application
import android.content.Intent
import android.net.Uri
import android.provider.OpenableColumns
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.ArrowBack
import androidx.compose.material.icons.automirrored.outlined.KeyboardArrowRight
import androidx.compose.material.icons.outlined.Close
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import com.hushos.app.data.Background
import com.hushos.app.data.NotFound
import com.hushos.app.data.Opened
import com.hushos.app.data.Places
import com.hushos.app.data.Problems
import com.hushos.app.data.Shared
import com.hushos.app.data.SharedText
import com.hushos.app.data.TransferQueue
import com.hushos.app.data.Vault
import com.hushos.app.data.buildCatalogue
import com.hushos.tokens.AlpineSpace
import java.io.File
import java.util.UUID
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

/*
 * Save to HushOS: what another app shares (files of any kind, one or many, or a browser's
 * page as a link), saved into a folder of your own drive. The shared files are copied into
 * HushOS's storage as soon as the sheet opens, streamed, since the sending app's permission
 * ends with this sheet; Save hands the copies to the transfer queue, so they upload after
 * the sheet closes and show in transfers and the finished notification.
 */
class SaveViewModel(application: Application) : AndroidViewModel(application) {
    private val context get() = getApplication<Application>()

    enum class Phase { OPENING, SIGNED_OUT, READY, SAVING, ASK, DONE }

    /* One thing to save: its name, type and size, and the copy once it's made. */
    data class Item(val name: String, val mime: String?, val size: Long?, val copy: File? = null, val unreadable: Boolean = false)

    var phase by mutableStateOf(Phase.OPENING)
    val items = mutableStateListOf<Item>()
    /* "Saves the link as a file." for a browser's page; the same for shared text. */
    var note by mutableStateOf<String?>(null)
    var folder by mutableStateOf<Places.Folder?>(null)
    var problem by mutableStateOf<String?>(null)
    /* Files, once the drive answered: the picker starts there. */
    var root by mutableStateOf<Places.Folder?>(null)

    private var vault: Vault? = null
    private val dir = File(context.cacheDir, "share/${UUID.randomUUID()}")
    private var started = false
    private var handed = false
    private var copying: Job? = null

    fun start(intent: Intent) {
        if (started) return
        started = true
        val uris = streams(intent)
        val text = if (uris.isEmpty()) SharedText.of(intent.getCharSequenceExtra(Intent.EXTRA_TEXT)?.toString(), intent.getStringExtra(Intent.EXTRA_SUBJECT)) else null
        viewModelScope.launch {
            // The session store opens with Keystore work: off the main thread.
            val session = withContext(Dispatchers.IO) { runCatching { Shared.session(context) }.getOrNull() }
            if (session == null) { phase = Phase.SIGNED_OUT; return@launch }
            if (text != null) {
                val file = withContext(Dispatchers.IO) { File(dir, "0").also { it.parentFile?.mkdirs(); it.writeText(text.body) } }
                items.add(Item(text.name, "text/plain", file.length(), file))
                note = if (text.link) "Saves the link as a file." else "Saves the text as a file."
            } else {
                items.addAll(withContext(Dispatchers.IO) { uris.map(::describe) })
                copying = viewModelScope.launch(Dispatchers.IO) { copyAll(uris) }
            }
            phase = Phase.READY
            chooseFolder()
        }
    }

    private fun streams(intent: Intent): List<Uri> = when (intent.action) {
        Intent.ACTION_SEND -> listOfNotNull(androidx.core.content.IntentCompat.getParcelableExtra(intent, Intent.EXTRA_STREAM, Uri::class.java))
        Intent.ACTION_SEND_MULTIPLE -> androidx.core.content.IntentCompat.getParcelableArrayListExtra(intent, Intent.EXTRA_STREAM, Uri::class.java).orEmpty()
        else -> emptyList()
    }.ifEmpty {
        // Some apps attach the files only as clip data.
        intent.clipData?.let { clip -> (0 until clip.itemCount).mapNotNull { clip.getItemAt(it).uri } }.orEmpty()
    }

    private fun describe(uri: Uri): Item {
        var name: String? = null
        var size: Long? = null
        runCatching {
            context.contentResolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE), null, null, null)?.use { cursor ->
                if (cursor.moveToFirst()) {
                    name = cursor.getString(0)
                    if (!cursor.isNull(1)) size = cursor.getLong(1)
                }
            }
        }
        val mime = runCatching { context.contentResolver.getType(uri) }.getOrNull()
        val fallback = uri.lastPathSegment?.substringAfterLast('/')?.takeIf { it.isNotBlank() } ?: "Shared file"
        return Item((name ?: fallback).replace('/', ' ').trim().ifEmpty { "Shared file" }, mime, size)
    }

    /* Streamed copies, one by one, into the app's own storage (AccountStore wipes it with the cache). */
    private suspend fun copyAll(uris: List<Uri>) {
        dir.mkdirs()
        uris.forEachIndexed { index, uri ->
            val target = File(dir, index.toString())
            val ok = runCatching {
                context.contentResolver.openInputStream(uri)?.use { input -> target.outputStream().use { input.copyTo(it, 1 shl 16) } } != null
            }.getOrDefault(false)
            withContext(Dispatchers.Main) {
                items[index] = if (ok) items[index].copy(copy = target, size = target.length()) else items[index].copy(unreadable = true)
            }
            if (!ok) target.delete()
        }
    }

    /* The folder last added to, if it's still there; otherwise Files. */
    private suspend fun chooseFolder() {
        val last = Places.last(context)
        val result = withContext(Dispatchers.IO) {
            runCatching {
                val vault = vault ?: Vault.fromShared(context)?.also { runCatching { it.buildCatalogue() }; vault = it } ?: throw IllegalStateException("Signed out")
                val top = Places.Folder(vault.rootId, "Files")
                withContext(Dispatchers.Main) { root = top }
                if (last != null) {
                    val found = try { vault.resolve(last.id) } catch (gone: NotFound) { null }
                    if (found != null && found.isFolder && found.node.trashedAt == null) return@runCatching Places.Folder(found.id, if (found.node.parentId == null) "Files" else found.name)
                }
                top
            }
        }
        result.onSuccess { folder = it; problem = null }.onFailure { error ->
            // Offline: the last folder is used as it was; the queue waits for a connection.
            if (last != null) folder = last else problem = Problems.of(error).body
        }
    }

    /* The folders in a folder, for the picker: none in the trash, by name. */
    suspend fun folders(id: String): Result<List<Opened>> = withContext(Dispatchers.IO) {
        runCatching { (vault ?: throw IllegalStateException("Signed out")).listChildren(id).filter { it.isFolder && it.node.trashedAt == null }.sortedBy { it.name.lowercase() } }
    }

    fun save() {
        val target = folder ?: return
        phase = Phase.SAVING
        viewModelScope.launch {
            copying?.join()
            withContext(Dispatchers.IO) {
                // A name the folder already has gets " (2)", as an upload in the app does.
                val taken = runCatching { vault?.listChildren(target.id)?.filter { !it.isFolder }?.map { it.name.lowercase() } }.getOrNull().orEmpty().toMutableSet()
                for (item in items) {
                    val copy = item.copy ?: continue
                    val name = freeName(item.name, taken).also { taken.add(it.lowercase()) }
                    TransferQueue.upload(context, copy, name, item.mime, target.id, null)
                }
                Places.used(context, target.id, target.name)
            }
            handed = true
            val notNow = context.getSharedPreferences("asked", android.content.Context.MODE_PRIVATE).getLong("background-not-now", 0L).takeIf { it > 0L }
            phase = if (Background.shouldAsk(Background.read(context), notNow, System.currentTimeMillis())) Phase.ASK else Phase.DONE
        }
    }

    private fun freeName(name: String, taken: Set<String>): String {
        if (name.lowercase() !in taken) return name
        val dot = name.lastIndexOf('.')
        val stem = if (dot > 0) name.substring(0, dot) else name
        val ext = if (dot > 0) name.substring(dot) else ""
        for (n in 2..999) { val candidate = "$stem ($n)$ext"; if (candidate.lowercase() !in taken) return candidate }
        return "$stem ${System.nanoTime() % 100000}$ext"
    }

    /* Closed without saving, or saved (the queue moved the copies out): nothing is left behind. */
    override fun onCleared() {
        copying?.cancel()
        Thread { dir.deleteRecursively() }.start()
    }
}

@Composable
fun SaveToHushOS(model: SaveViewModel, close: () -> Unit, openApp: () -> Unit) {
    val alpine = Alpine.colors
    var picking by remember { mutableStateOf(false) }
    LaunchedEffect(model.phase) { if (model.phase == SaveViewModel.Phase.DONE) close() }
    if (model.phase == SaveViewModel.Phase.OPENING || model.phase == SaveViewModel.Phase.DONE) return
    Sheet(onDismissRequest = close, full = picking) {
        when {
            model.phase == SaveViewModel.Phase.SIGNED_OUT -> Column(Modifier.padding(horizontal = AlpineSpace.S6).padding(bottom = AlpineSpace.S6), verticalArrangement = Arrangement.spacedBy(AlpineSpace.S4)) {
                Text("Save to HushOS", style = MaterialTheme.typography.titleLarge)
                Text("Sign in to HushOS in the app first.", style = MaterialTheme.typography.bodyLarge, color = alpine.inkMuted)
                Button(onClick = openApp, modifier = Modifier.fillMaxWidth().height(48.dp)) { Text("Open HushOS") }
            }
            model.phase == SaveViewModel.Phase.ASK -> {
                val access = rememberBackgroundAccess()
                val prefs = LocalContext.current.getSharedPreferences("asked", android.content.Context.MODE_PRIVATE)
                LaunchedEffect(access) { if (access.allSet) close() }
                BackgroundAsk(access) { prefs.edit().putLong("background-not-now", System.currentTimeMillis()).apply(); close() }
            }
            picking -> FolderPicker(model, onPick = { model.folder = it; picking = false }, onBack = { picking = false })
            else -> Items(model, change = { picking = true })
        }
    }
}

@Composable
private fun Items(model: SaveViewModel, change: () -> Unit) {
    val alpine = Alpine.colors
    val saving = model.phase == SaveViewModel.Phase.SAVING
    val readable = model.items.filter { !it.unreadable }
    Column(Modifier.padding(bottom = AlpineSpace.S6)) {
        Text("Save to HushOS", style = MaterialTheme.typography.titleLarge, modifier = Modifier.padding(horizontal = AlpineSpace.S6, vertical = AlpineSpace.S2))
        Column(Modifier.heightIn(max = 280.dp).verticalScroll(rememberScrollState())) {
            for (item in model.items.take(6)) Row(Modifier.fillMaxWidth().heightIn(min = 56.dp).padding(horizontal = AlpineSpace.S6), verticalAlignment = Alignment.CenterVertically) {
                PageMark(item.name)
                Column(Modifier.weight(1f).padding(start = AlpineSpace.S4)) {
                    Text(item.name, style = MaterialTheme.typography.bodyLarge, maxLines = 1, overflow = TextOverflow.MiddleEllipsis)
                    val detail = when {
                        item.unreadable -> "Couldn’t be read, so it won’t be saved."
                        model.note != null -> model.note
                        else -> item.size?.let(::formatBytes)
                    }
                    detail?.let { Text(it, style = MaterialTheme.typography.bodyMedium, color = if (item.unreadable) alpine.danger else alpine.inkMuted) }
                }
            }
            if (model.items.size > 6) Text("and ${model.items.size - 6} more", style = MaterialTheme.typography.bodyMedium, color = alpine.inkMuted,
                modifier = Modifier.padding(horizontal = AlpineSpace.S6, vertical = AlpineSpace.S2))
        }
        HorizontalDivider(color = alpine.divider, modifier = Modifier.padding(vertical = AlpineSpace.S2))
        // Where it goes: the folder last added to, or Files; Change opens the picker.
        Row(Modifier.fillMaxWidth().heightIn(min = 56.dp).clickable(enabled = !saving && model.root != null, onClick = change).padding(horizontal = AlpineSpace.S6),
            verticalAlignment = Alignment.CenterVertically) {
            FolderMark()
            Column(Modifier.weight(1f).padding(start = AlpineSpace.S4)) {
                Text("Save in", style = MaterialTheme.typography.bodyMedium, color = alpine.inkMuted)
                Text(model.folder?.name ?: "Finding your files", style = MaterialTheme.typography.bodyLarge, maxLines = 1, overflow = TextOverflow.Ellipsis)
            }
            if (model.root != null) Text("Change", style = MaterialTheme.typography.labelLarge, color = alpine.primary)
        }
        model.problem?.let { Text(it, style = MaterialTheme.typography.bodyMedium, color = alpine.danger, modifier = Modifier.padding(horizontal = AlpineSpace.S6, vertical = AlpineSpace.S2)) }
        Button(
            enabled = !saving && model.folder != null && readable.isNotEmpty(),
            onClick = model::save,
            modifier = Modifier.fillMaxWidth().padding(horizontal = AlpineSpace.S6).padding(top = AlpineSpace.S4).height(48.dp),
        ) { Text(if (saving) "Saving…" else "Save") }
    }
}

/* The folders of your drive, walked from Files with a way back up; Save here picks the one you're in. */
@Composable
private fun FolderPicker(model: SaveViewModel, onPick: (Places.Folder) -> Unit, onBack: () -> Unit) {
    val alpine = Alpine.colors
    val root = model.root
    var trail by remember { mutableStateOf(listOfNotNull(root)) }
    val here = trail.lastOrNull() ?: return
    var folders by remember { mutableStateOf<Result<List<Opened>>?>(null) }
    LaunchedEffect(here.id) { folders = null; folders = model.folders(here.id) }
    Column(Modifier.fillMaxWidth().heightIn(min = 480.dp)) {
        Row(Modifier.fillMaxWidth().padding(start = AlpineSpace.S2, end = AlpineSpace.S4, bottom = AlpineSpace.S1), verticalAlignment = Alignment.CenterVertically) {
            if (trail.size > 1) IconButton(onClick = { trail = trail.dropLast(1) }) { Icon(Icons.AutoMirrored.Outlined.ArrowBack, "Up one folder") }
            else IconButton(onClick = onBack) { Icon(Icons.Outlined.Close, "Close") }
            Column {
                Text("Save in", style = MaterialTheme.typography.titleLarge)
                Text(here.name, style = MaterialTheme.typography.bodyMedium, color = alpine.inkMuted, maxLines = 1, overflow = TextOverflow.Ellipsis)
            }
        }
        Column(Modifier.weight(1f, fill = false).heightIn(max = 520.dp).verticalScroll(rememberScrollState())) {
            val list = folders
            when {
                list == null -> Box(Modifier.fillMaxWidth().padding(AlpineSpace.S8), contentAlignment = Alignment.Center) { CircularProgressIndicator() }
                list.isFailure -> Text(Problems.of(list.exceptionOrNull()!!).body, style = MaterialTheme.typography.bodyMedium, color = alpine.inkMuted, textAlign = TextAlign.Center,
                    modifier = Modifier.fillMaxWidth().padding(vertical = 40.dp, horizontal = AlpineSpace.S6))
                list.getOrThrow().isEmpty() -> Text("No folders in here.", style = MaterialTheme.typography.bodyMedium, color = alpine.inkMuted, textAlign = TextAlign.Center,
                    modifier = Modifier.fillMaxWidth().padding(vertical = 40.dp))
                else -> for (folder in list.getOrThrow()) Row(
                    Modifier.fillMaxWidth().heightIn(min = 56.dp).clickable { trail = trail + Places.Folder(folder.id, folder.name) }.padding(horizontal = AlpineSpace.S4),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Box(Modifier.size(36.dp), contentAlignment = Alignment.Center) { FolderMark() }
                    Text(folder.name, style = MaterialTheme.typography.bodyLarge, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f).padding(start = AlpineSpace.S4))
                    Icon(Icons.AutoMirrored.Outlined.KeyboardArrowRight, null, tint = alpine.inkMuted)
                }
            }
        }
        HorizontalDivider(color = alpine.divider)
        Button(onClick = { onPick(here) }, modifier = Modifier.fillMaxWidth().padding(AlpineSpace.S6).height(56.dp)) { Text("Save here") }
    }
}
