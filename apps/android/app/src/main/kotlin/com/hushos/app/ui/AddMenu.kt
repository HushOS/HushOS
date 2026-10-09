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
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Add
import androidx.compose.material.icons.outlined.Close
import androidx.compose.material.icons.outlined.ContentPaste
import androidx.compose.material.icons.outlined.CreateNewFolder
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

/* One file of a batch that has the same name as something in the folder, and what to do with it. */
private data class Clash(val uri: Uri, val name: String)

/* What the + menu does in a folder: each starts its picker, the camera or the New folder dialog. */
class Adder(val pickFiles: () -> Unit, val pickPhotos: () -> Unit, val takePhoto: () -> Unit, val newFolder: () -> Unit)

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
    // Same-name uploads: asked one file at a time; Keep both then names them all in one dialog.
    var batch by remember { mutableStateOf<List<Uri>>(emptyList()) }
    var clashes by remember { mutableStateOf<List<Clash>>(emptyList()) }
    var decided by remember { mutableStateOf<Map<Uri, DriveViewModel.Conflict>>(emptyMap()) }
    var renames by remember { mutableStateOf<Map<String, String>>(emptyMap()) }
    val taken = (folderId?.let { state.folders[it] } ?: emptyList()).map { it.name.lowercase() }.toSet()
    fun send(uris: List<Uri>, choices: Map<Uri, DriveViewModel.Conflict>, names: Map<String, String>) {
        val folder = folderId ?: return
        val replace = uris.filter { choices[it] == DriveViewModel.Conflict.REPLACE }
        val rest = uris.filter { choices[it] != DriveViewModel.Conflict.REPLACE && choices[it] != DriveViewModel.Conflict.SKIP }
        if (rest.isNotEmpty()) model.upload(rest, folder, DriveViewModel.Conflict.KEEP_BOTH, names)
        if (replace.isNotEmpty()) model.upload(replace, folder, DriveViewModel.Conflict.REPLACE)
    }
    fun startUpload(uris: List<Uri>) {
        if (uris.isEmpty() || folderId == null) return
        val files = (state.folders[folderId] ?: emptyList()).filter { !it.isFolder }.map { it.name.lowercase() }.toSet()
        val found = uris.mapNotNull { uri -> model.displayName(uri)?.takeIf { it.lowercase() in files }?.let { Clash(uri, it) } }
        if (found.isEmpty()) model.upload(uris, folderId) else { batch = uris; clashes = found; decided = emptyMap() }
    }
    val picker = rememberLauncherForActivityResult(ActivityResultContracts.OpenMultipleDocuments()) { startUpload(it) }
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

    clashes.firstOrNull { it.uri !in decided }?.let { clash ->
        val left = clashes.filter { it.uri !in decided && it != clash }
        ClashDialog(clash, left, model.freeName(clash.name, taken),
            cancel = { clashes = emptyList(); batch = emptyList(); decided = emptyMap() },
        ) { choice, forAll ->
            val next = decided + (clash.uri to choice) + if (forAll) left.associate { it.uri to choice } else emptyMap()
            decided = next
            if (clashes.all { it.uri in next }) {
                val keep = clashes.filter { next[it.uri] == DriveViewModel.Conflict.KEEP_BOTH }
                if (keep.isEmpty()) { send(batch, next, emptyMap()); clashes = emptyList(); batch = emptyList() }
                else renames = keep.associate { it.name to model.freeName(it.name, taken) }
            }
        }
    }
    if (renames.isNotEmpty() && folderId != null) {
        val valid = renames.values.all { it.isNotBlank() && it.trim().lowercase() !in taken } && renames.values.map { it.trim().lowercase() }.toSet().size == renames.size
        AlertDialog(
            onDismissRequest = { renames = emptyMap(); decided = emptyMap() },
            title = { Text("Keep both") },
            text = {
                Column {
                    Text("Each file is added under its new name. The ones already here don’t change.")
                    for ((original, name) in renames) OutlinedTextField(value = name, onValueChange = { renames = renames + (original to it) }, singleLine = true, label = { Text("Was $original") }, modifier = Modifier.padding(top = 12.dp))
                }
            },
            confirmButton = { TextButton(enabled = valid, onClick = { send(batch, decided, renames.mapValues { it.value.trim() }); renames = emptyMap(); clashes = emptyList(); batch = emptyList() }) { Text("Upload") } },
            // Back returns to the questions, from the first file.
            dismissButton = { TextButton(onClick = { renames = emptyMap(); decided = emptyMap() }) { Text("Back") } },
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
        pickPhotos = { photos.launch(PickVisualMediaRequest(ActivityResultContracts.PickVisualMedia.ImageAndVideo)) },
        takePhoto = ::takePhoto,
        newFolder = { newFolder = "" },
    )
}

/*
 * The + button and its menu, Files' and Home's: Paste (when the clipboard can go here), New
 * folder, Take photo, Upload photos, and Upload files nearest the button. `lift` raises it over
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
        // The most used, nearest the button.
        FloatingActionButtonMenuItem(containerColor = alpine.primary, contentColor = alpine.onPrimary, onClick = { onOpen(false); add.pickFiles() }, icon = { Icon(Icons.Outlined.UploadFile, null) }, text = { Text("Upload files") })
    }
}

/* One name clash: Replace, Keep both or Skip, each saying what it does, and whether to do the same for the rest. */
@Composable
private fun ClashDialog(clash: Clash, others: List<Clash>, freeName: String, cancel: () -> Unit, decide: (DriveViewModel.Conflict, Boolean) -> Unit) {
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
                Text("What should happen to the one you’re adding?", modifier = Modifier.padding(bottom = 8.dp))
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
