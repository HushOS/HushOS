package com.hushos.app.ui

import android.net.Uri
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.PickVisualMediaRequest
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.selection.toggleable
import androidx.compose.foundation.verticalScroll
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Add
import androidx.compose.material.icons.outlined.Close
import androidx.compose.material.icons.outlined.ContentPaste
import androidx.compose.material.icons.outlined.CreateNewFolder
import androidx.compose.material.icons.outlined.DriveFolderUpload
import androidx.compose.material.icons.outlined.PhotoCamera
import androidx.compose.material.icons.outlined.PhotoLibrary
import androidx.compose.material.icons.outlined.UploadFile
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Checkbox
import androidx.compose.material3.ExperimentalMaterial3ExpressiveApi
import androidx.compose.material3.FloatingActionButtonMenu
import androidx.compose.material3.FloatingActionButtonMenuItem
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.RadioButton
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.ToggleFloatingActionButton
import androidx.compose.material3.ToggleFloatingActionButtonDefaults.animateIcon
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import java.io.File

/* What the + menu does in a folder: each starts its picker, the camera or the New folder dialog. */
class Adder(val pickFiles: () -> Unit, val pickFolder: () -> Unit, val pickPhotos: () -> Unit, val takePhoto: () -> Unit, val newFolder: () -> Unit)

/*
 * Adding into a folder, for Files and Home alike: the pickers, the camera, the same-name
 * questions for uploads and the New folder dialog. The dialogs are drawn here, where their
 * state lives; the screen calls this once and wires the + menu (or its own buttons) to it.
 */
@Composable
fun addInto(model: DriveViewModel, state: DriveState, folderId: String?, folderName: String): Adder {
    val alpine = Alpine.colors
    val context = LocalContext.current
    var newFolder by rememberSaveable { mutableStateOf<String?>(null) }
    val taken = (folderId?.let { state.folders[it] } ?: emptyList()).map { it.name.lowercase() }.toSet()
    // Same-name uploads, picked files and picked folders alike: asked one file at a time, each by
    // its own uri (two picks can share a name); Keep both then names them all in one dialog.
    // Cancel adds none of those; the files with free names have gone already.
    var clashes by remember { mutableStateOf<List<DriveViewModel.Clash>>(emptyList()) }
    var answers by remember { mutableStateOf<Map<Uri, Pair<DriveViewModel.Conflict, String>>>(emptyMap()) }
    // Names in each destination before any answer, and the same with the kept-both names suggested so far.
    var namesThere by remember { mutableStateOf<Map<String, Set<String>>>(emptyMap()) }
    var claimed by remember { mutableStateOf<Map<String, Set<String>>>(emptyMap()) }
    var renames by remember { mutableStateOf<Map<Uri, String>>(emptyMap()) }
    fun ask(found: List<DriveViewModel.Clash>, names: Map<String, Set<String>>) {
        if (found.isEmpty()) return
        clashes = found; answers = emptyMap(); namesThere = names; claimed = names; renames = emptyMap()
    }
    fun startUpload(uris: List<Uri>) {
        if (uris.isEmpty() || folderId == null) return
        val children = state.folders[folderId].orEmpty()
        val names = children.map { it.name.lowercase() }.toMutableSet()
        val (free, found) = model.sortPicked(uris.map { it to (model.displayName(it) ?: "file") }, folderId, folderName, children, names)
        if (free.isNotEmpty()) model.upload(free, folderId)
        ask(found, mapOf(folderId to names))
    }
    val picker = rememberLauncherForActivityResult(ActivityResultContracts.OpenMultipleDocuments()) { startUpload(it) }
    // A picked folder comes in whole, as on the web: its folders merge with any of the same name
    // already there, at every depth, and each file whose name is taken in its folder gets the same question.
    val folderPicker = rememberLauncherForActivityResult(ActivityResultContracts.OpenDocumentTree()) { tree ->
        if (tree == null || folderId == null) return@rememberLauncherForActivityResult
        model.uploadFolder(tree, folderId, folderName) { found, names -> ask(found, names) }
    }
    val photos = rememberLauncherForActivityResult(ActivityResultContracts.PickMultipleVisualMedia()) { startUpload(it) }
    var photoFile by rememberSaveable { mutableStateOf<String?>(null) }
    val camera = rememberLauncherForActivityResult(ActivityResultContracts.TakePicture()) { saved ->
        val file = photoFile?.let { File(it) }
        photoFile = null
        if (saved && file != null && file.length() > 0 && folderId != null) model.uploadTaken(file, folderId) else file?.delete()
    }
    // HushOS holds the camera permission (for scanning a recovery kit), and Android refuses the
    // camera app to an app that holds it but hasn't been granted it: so Take photo asks first.
    lateinit var takePhotoAfterAsking: () -> Unit
    val cameraAllowed = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
        if (granted) takePhotoAfterAsking() else model.notify("Allow HushOS to use the camera to take a photo.")
    }
    fun takePhoto() {
        if (androidx.core.content.ContextCompat.checkSelfPermission(context, android.Manifest.permission.CAMERA) != android.content.pm.PackageManager.PERMISSION_GRANTED) {
            cameraAllowed.launch(android.Manifest.permission.CAMERA)
            return
        }
        val stamp = java.time.LocalDateTime.now().format(java.time.format.DateTimeFormatter.ofPattern("yyyy-MM-dd HH.mm.ss"))
        val file = File(context.cacheDir, "camera/Photo $stamp.jpg").also { it.parentFile?.mkdirs() }
        photoFile = file.path
        runCatching { camera.launch(androidx.core.content.FileProvider.getUriForFile(context, "${context.packageName}.shared", file)) }
            .onFailure { photoFile = null; file.delete(); model.notify("No camera app is available on this phone.") }
    }
    takePhotoAfterAsking = ::takePhoto

    clashes.firstOrNull { it.uri !in answers }?.let { asked ->
        val left = clashes.filter { it.uri !in answers && it != asked }
        ClashDialog(asked, left, asked.folderName, model.freeName(asked.name, claimed[asked.folderId].orEmpty()),
            cancel = { clashes = emptyList(); answers = emptyMap() },
        ) { choice, forAll ->
            // Keep both takes the next free name in that folder, so two copies never get the same one.
            var names = claimed
            var given = answers
            for (clash in listOf(asked) + if (forAll) left else emptyList()) {
                var name = clash.name
                if (choice == DriveViewModel.Conflict.KEEP_BOTH) {
                    name = model.freeName(clash.name, names[clash.folderId].orEmpty())
                    names = names + (clash.folderId to names[clash.folderId].orEmpty() + name.lowercase())
                }
                given = given + (clash.uri to (choice to name))
            }
            claimed = names
            answers = given
            if (clashes.all { it.uri in given }) {
                val keep = clashes.filter { given.getValue(it.uri).first == DriveViewModel.Conflict.KEEP_BOTH }
                if (keep.isEmpty()) {
                    model.uploadAnswered(clashes.map { it to given.getValue(it.uri) })
                    clashes = emptyList()
                    answers = emptyMap()
                } else renames = keep.associate { it.uri to given.getValue(it.uri).second }
            }
        }
    }
    if (renames.isNotEmpty()) {
        KeepBothDialog(
            clashes.filter { it.uri in renames }.map { KeepEntry(it.uri, it.name, it.folderId, it.folderName) }, renames, namesThere,
            edit = { uri, name -> renames = renames + (uri to name) },
            upload = {
                model.uploadAnswered(clashes.map { clash ->
                    val answer = answers.getValue(clash.uri)
                    clash to (answer.first to (renames[clash.uri]?.trim() ?: answer.second))
                })
                renames = emptyMap(); clashes = emptyList(); answers = emptyMap()
            },
            // Back returns to the questions, from the first file.
            back = { renames = emptyMap(); answers = emptyMap(); claimed = namesThere },
        )
    }
    newFolder?.let { draft ->
        AlertDialog(
            onDismissRequest = { newFolder = null },
            title = { Text("New folder") },
            text = {
                Column {
                    Text("In “$folderName”", color = alpine.inkMuted, modifier = Modifier.padding(bottom = 12.dp))
                    val clash = draft.trim().lowercase() in taken
                    OutlinedTextField(value = draft, onValueChange = { newFolder = it }, singleLine = true, label = { Text("Name") }, isError = clash,
                        supportingText = if (clash) ({ Text("“${draft.trim()}” is already in this folder. Try another name.") }) else null)
                }
            },
            confirmButton = { TextButton(enabled = draft.isNotBlank() && draft.trim().lowercase() !in taken, onClick = { folderId?.let { model.createFolder(draft.trim(), it) }; newFolder = null }) { Text("Create") } },
            dismissButton = { TextButton(onClick = { newFolder = null }) { Text("Cancel") } },
        )
    }
    return Adder(
        pickFiles = { picker.launch(arrayOf("*/*")) },
        pickFolder = { folderPicker.launch(null) },
        pickPhotos = { photos.launch(PickVisualMediaRequest(ActivityResultContracts.PickVisualMedia.ImageAndVideo)) },
        takePhoto = ::takePhoto,
        newFolder = { newFolder = "" },
    )
}

/*
 * The + button and its menu, Files' and Home's: Paste (when the clipboard can go here), New
 * folder, Take photo, Upload photos, Upload folder, and Upload files nearest the button. `lift` raises it over
 * a paste bar; it also rises over the notice and transfer bars at the foot.
 */
@OptIn(ExperimentalMaterial3ExpressiveApi::class)
@Composable
fun AddButton(open: Boolean, onOpen: (Boolean) -> Unit, add: Adder, paste: Pair<String, () -> Unit>? = null, lift: Dp = 0.dp) {
    val alpine = Alpine.colors
    // Over the paste bar and over the notice and transfer bars at the foot, moving as they come and go.
    val rise by androidx.compose.animation.core.animateDpAsState(lift + LocalFootBars.current, label = "fab lift")
    FloatingActionButtonMenu(
        // The menu pads its button a second time; pull it back to the usual 16dp, and lift it.
        modifier = Modifier.offset(x = 16.dp, y = 16.dp).padding(bottom = rise),
        expanded = open,
        horizontalAlignment = Alignment.End,
        button = {
            // High contrast has no shadows: the button gets a solid edge instead.
            if (alpine.high) HighContrastFab(open, onOpen)
            else ToggleFloatingActionButton(checked = open, onCheckedChange = onOpen) {
                val icon = if (checkedProgress > 0.5f) Icons.Outlined.Close else Icons.Outlined.Add
                Icon(icon, contentDescription = if (open) "Close" else "Add", modifier = Modifier.animateIcon({ checkedProgress }))
            }
        },
    ) {
        paste?.let { (text, onPaste) ->
            FloatingActionButtonMenuItem(containerColor = alpine.primary, contentColor = alpine.onPrimary, onClick = { onOpen(false); onPaste() }, icon = { Icon(Icons.Outlined.ContentPaste, null) }, text = { Text(text) })
        }
        FloatingActionButtonMenuItem(containerColor = alpine.primary, contentColor = alpine.onPrimary, onClick = { onOpen(false); add.newFolder() }, icon = { Icon(Icons.Outlined.CreateNewFolder, null) }, text = { Text("New folder") })
        FloatingActionButtonMenuItem(containerColor = alpine.primary, contentColor = alpine.onPrimary, onClick = { onOpen(false); add.takePhoto() }, icon = { Icon(Icons.Outlined.PhotoCamera, null) }, text = { Text("Take photo") })
        FloatingActionButtonMenuItem(containerColor = alpine.primary, contentColor = alpine.onPrimary, onClick = { onOpen(false); add.pickPhotos() }, icon = { Icon(Icons.Outlined.PhotoLibrary, null) }, text = { Text("Upload photos") })
        FloatingActionButtonMenuItem(containerColor = alpine.primary, contentColor = alpine.onPrimary, onClick = { onOpen(false); add.pickFolder() }, icon = { Icon(Icons.Outlined.DriveFolderUpload, null) }, text = { Text("Upload folder") })
        // The most used, nearest the button.
        FloatingActionButtonMenuItem(containerColor = alpine.primary, contentColor = alpine.onPrimary, onClick = { onOpen(false); add.pickFiles() }, icon = { Icon(Icons.Outlined.UploadFile, null) }, text = { Text("Upload files") })
    }
}

/* One file to keep both of: its name now and the folder it is going to. */
private class KeepEntry(val uri: Uri, val original: String, val folderId: String, val folderName: String)

/*
 * Keep both: each file gets the name it will carry, suggested free and editable. A name can't be
 * empty, already in its folder, or given to another file going to the same folder. Upload is
 * offered once every name is usable; Back returns to the questions.
 */
@Composable
private fun KeepBothDialog(entries: List<KeepEntry>, names: Map<Uri, String>, taken: Map<String, Set<String>>, edit: (Uri, String) -> Unit, upload: () -> Unit, back: () -> Unit) {
    fun problem(entry: KeepEntry): String? {
        val name = names[entry.uri].orEmpty().trim()
        if (name.isEmpty()) return "Enter a name."
        if (name.lowercase() in taken[entry.folderId].orEmpty()) return "“$name” is already here too. Try another name."
        val twice = entries.any { it.uri != entry.uri && it.folderId == entry.folderId && names[it.uri].orEmpty().trim().equals(name, ignoreCase = true) }
        return if (twice) "Another file going here has this name." else null
    }
    val folders = entries.map { it.folderId }.distinct().size
    AlertDialog(
        onDismissRequest = back,
        title = { Text("Keep both") },
        text = {
            Column(Modifier.verticalScroll(androidx.compose.foundation.rememberScrollState())) {
                Text("Each file is added under its new name. The ones already here don’t change.")
                for (entry in entries) {
                    val problem = problem(entry)
                    OutlinedTextField(
                        value = names[entry.uri].orEmpty(), onValueChange = { edit(entry.uri, it) }, singleLine = true, isError = problem != null,
                        label = { Text(if (folders > 1) "Was ${entry.original}, in “${entry.folderName}”" else "Was ${entry.original}") },
                        supportingText = problem?.let { { Text(it) } }, modifier = Modifier.padding(top = 12.dp),
                    )
                }
            }
        },
        confirmButton = { TextButton(enabled = entries.none { problem(it) != null }, onClick = upload) { Text("Upload") } },
        dismissButton = { TextButton(onClick = back) { Text("Back") } },
    )
}

/* One name clash: Replace, Keep both or Skip, each saying what it does, and whether to do the same for the rest. */
@Composable
private fun ClashDialog(clash: DriveViewModel.Clash, others: List<DriveViewModel.Clash>, folderName: String, freeName: String, cancel: () -> Unit, decide: (DriveViewModel.Conflict, Boolean) -> Unit) {
    var choice by remember(clash.uri) { mutableStateOf(DriveViewModel.Conflict.REPLACE) }
    var same by remember(clash.uri) { mutableStateOf(true) }
    val options = listOf(
        Triple(DriveViewModel.Conflict.REPLACE, "Replace", "Keeps the old one as an earlier version"),
        Triple(DriveViewModel.Conflict.KEEP_BOTH, "Keep both", "Adds this one as “$freeName”"),
        Triple(DriveViewModel.Conflict.SKIP, "Skip", "Leaves the one here as it is"),
    )
    AlertDialog(
        onDismissRequest = cancel,
        title = { Text("“${clash.name}” is already here") },
        text = {
            Column {
                // Which folder, as the web says it: a folder upload asks about files at every depth.
                Text("“$folderName” already has a file with this name. What should happen to the one you’re adding?", modifier = Modifier.padding(bottom = 8.dp))
                for ((value, label, detail) in options) Row(
                    Modifier.fillMaxWidth().selectable(selected = choice == value, role = Role.RadioButton) { choice = value }.padding(vertical = 4.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    RadioButton(selected = choice == value, onClick = null)
                    Column(Modifier.padding(start = 12.dp)) {
                        Text(label, style = MaterialTheme.typography.bodyLarge, fontWeight = if (choice == value) FontWeight.Medium else null)
                        Text(detail, style = MaterialTheme.typography.bodyMedium, color = Alpine.colors.inkMuted)
                    }
                }
                if (others.isNotEmpty()) {
                    HorizontalDivider(Modifier.padding(vertical = 8.dp), color = Alpine.colors.divider)
                    Row(Modifier.fillMaxWidth().toggleable(value = same, role = Role.Checkbox) { same = it }.padding(vertical = 4.dp), verticalAlignment = Alignment.CenterVertically) {
                        Checkbox(checked = same, onCheckedChange = null)
                        Column(Modifier.padding(start = 12.dp)) {
                            Text(if (others.size == 1) "Do the same for 1 other" else "Do the same for ${others.size} others", style = MaterialTheme.typography.bodyLarge)
                            Text(names(others.map { it.name }), style = MaterialTheme.typography.bodyMedium, color = Alpine.colors.inkMuted, maxLines = 2)
                        }
                    }
                }
            }
        },
        confirmButton = { TextButton(onClick = { decide(choice, others.isNotEmpty() && same) }) { Text("Continue") } },
        dismissButton = { TextButton(onClick = cancel) { Text("Cancel") } },
    )
}

/* The add button for high contrast: the same place and icons, no shadow, a solid edge. */
@Composable
private fun HighContrastFab(open: Boolean, onChange: (Boolean) -> Unit) {
    val alpine = Alpine.colors
    val shape = if (open) CircleShape else RoundedCornerShape(16.dp)
    Box(
        Modifier.size(56.dp).clip(shape).background(if (open) alpine.primary else alpine.tint).border(2.dp, alpine.edge, shape)
            .clickable(role = Role.Button, onClickLabel = if (open) "Close" else "Add") { onChange(!open) },
        contentAlignment = Alignment.Center,
    ) { Icon(if (open) Icons.Outlined.Close else Icons.Outlined.Add, if (open) "Close" else "Add", tint = if (open) alpine.onPrimary else alpine.onTint) }
}
