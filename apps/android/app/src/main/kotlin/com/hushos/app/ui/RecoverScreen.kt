package com.hushos.app.ui

import android.Manifest
import android.content.pm.PackageManager
import android.net.Uri
import androidx.activity.compose.BackHandler
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.camera.core.CameraSelector
import androidx.camera.core.ImageAnalysis
import androidx.camera.core.Preview
import androidx.camera.lifecycle.ProcessCameraProvider
import androidx.camera.view.PreviewView
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawingPadding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.CheckCircle
import androidx.compose.material.icons.outlined.Description
import androidx.compose.material.icons.outlined.Edit
import androidx.compose.material.icons.outlined.Mail
import androidx.compose.material.icons.outlined.QrCodeScanner
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.SideEffect
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalLifecycleOwner
import androidx.compose.ui.text.TextRange
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.input.TextFieldValue
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.core.content.ContextCompat
import com.hushos.app.data.KitScan
import com.hushos.app.data.RecoveryKitText
import com.hushos.tokens.AlpineSpace
import java.util.concurrent.Executors

/*
 * Reset your password, in the app: the web's /recover steps and words. The email step,
 * "Check your inbox", the emailed link (which opens the app), then the kit: Scan your kit,
 * Choose the kit file, or Type the 24 words, in that order; then a new password. The new
 * phrase is saved afterwards, signed in, on the recovery phrase page.
 */
@Composable
fun RecoverScreen(model: DriveViewModel, state: DriveState) {
    val flow = model.recovery ?: return
    // Back steps back: out of the scanner or the typed words to the kit choices, from the
    // inbox to the email; only then out of recovery.
    val inner = remember { mutableStateOf<(() -> Unit)?>(null) }
    val back = { inner.value?.invoke() ?: model.recoveryBack() }
    BackHandler(onBack = back)
    Column(Modifier.fillMaxSize().safeDrawingPadding().imePadding()) {
        DestinationBar("", onBack = back)
        Column(Modifier.verticalScroll(rememberScrollState()).padding(horizontal = AlpineSpace.S6).padding(bottom = AlpineSpace.S8),
            verticalArrangement = Arrangement.spacedBy(AlpineSpace.S4)) {
            when (flow.step) {
                DriveViewModel.RecoveryStep.EMAIL -> EmailStep(model, flow)
                DriveViewModel.RecoveryStep.SENT -> SentStep(model, flow)
                DriveViewModel.RecoveryStep.CHECKING -> {
                    Heading("Checking your link…", null)
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        CircularProgressIndicator(Modifier.size(20.dp), strokeWidth = 2.dp)
                        Text("This only takes a moment.", Modifier.padding(start = AlpineSpace.S3), color = Alpine.colors.inkMuted)
                    }
                }
                DriveViewModel.RecoveryStep.LINK_FAILED -> LinkFailed(model, flow)
                DriveViewModel.RecoveryStep.KIT -> KitStep(model, flow, inner)
                DriveViewModel.RecoveryStep.NEW_PHRASE -> {}
            }
        }
    }
}

@Composable
private fun Heading(title: String, description: String?) {
    Column(verticalArrangement = Arrangement.spacedBy(AlpineSpace.S2), modifier = Modifier.padding(top = AlpineSpace.S4)) {
        Text(title, style = MaterialTheme.typography.headlineMedium)
        description?.let { Text(it, style = MaterialTheme.typography.bodyLarge, color = Alpine.colors.inkMuted) }
    }
}

@Composable
private fun Note(text: String, danger: Boolean = true) {
    val alpine = Alpine.colors
    Text(text, color = if (danger) alpine.danger else alpine.success, style = MaterialTheme.typography.bodyMedium,
        modifier = Modifier.fillMaxWidth().background(if (danger) alpine.dangerSoft else alpine.successSoft, RoundedCornerShape(10.dp)).padding(AlpineSpace.S3))
}

@Composable
private fun EmailStep(model: DriveViewModel, flow: DriveViewModel.RecoveryFlow) {
    var email by rememberSaveable { mutableStateOf(flow.email) }
    var tried by remember { mutableStateOf(false) }
    val invalid = !email.contains("@")
    Heading("Reset your password", "You’ll need your recovery kit, or the 24 words on it. We’ll email you a link to start.")
    flow.error?.let { Note(it) }
    OutlinedTextField(email, { email = it }, label = { Text("Email") }, singleLine = true, enabled = !flow.pending,
        isError = tried && invalid, supportingText = if (tried && invalid) ({ Text("Enter your email address.") }) else null,
        keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Email, autoCorrectEnabled = false), modifier = Modifier.fillMaxWidth())
    Button(onClick = { tried = true; if (!invalid) model.sendRecoveryEmail(email) }, enabled = !flow.pending, modifier = Modifier.fillMaxWidth().height(48.dp)) {
        Text(if (flow.pending) "Sending…" else "Send link")
    }
}

@Composable
private fun SentStep(model: DriveViewModel, flow: DriveViewModel.RecoveryFlow) {
    Icon(Icons.Outlined.Mail, null, tint = Alpine.colors.primary, modifier = Modifier.padding(top = AlpineSpace.S4).size(32.dp))
    Heading("Check your inbox", "We sent a link to ${flow.email}. Open it to reset your password. It works once, for 30 minutes.")
    if (flow.resent) Note("New link sent to ${flow.email}.", danger = false)
    flow.error?.let { Note(it) }
    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween, verticalAlignment = Alignment.CenterVertically) {
        TextButton(onClick = model::recoveryEmailAgain) { Text("Use another email") }
        TextButton(enabled = !flow.pending, onClick = { model.sendRecoveryEmail(flow.email, again = true) }) { Text(if (flow.pending) "Sending…" else "Send a new link") }
    }
    Text("Not there? Check your spam folder. The link opens HushOS on this phone, or the web anywhere else.", style = MaterialTheme.typography.bodySmall, color = Alpine.colors.inkMuted)
}

/* The web's words for a link that can't be used: another flow's, expired or used, or something else. */
@Composable
private fun LinkFailed(model: DriveViewModel, flow: DriveViewModel.RecoveryFlow) {
    val error = flow.error.orEmpty()
    val otherFlow = error.contains("different account flow")
    val expired = Regex("expired|invalid|used|not valid|no longer", RegexOption.IGNORE_CASE).containsMatchIn(error)
    Heading(
        when { otherFlow -> "This link is for something else"; expired -> "This link has expired"; else -> "This link didn’t work" },
        when {
            otherFlow -> "It creates an account rather than resetting a password. Open the newest email, or ask for a new link here."
            expired -> "Links work once, for 30 minutes. Send yourself a new one and open the newest email."
            else -> error
        },
    )
    Button(onClick = model::recoveryEmailAgain, modifier = Modifier.fillMaxWidth().height(48.dp)) { Text("Send a new link") }
}

private enum class KitMode { CHOOSE, SCAN, TYPING }

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun KitStep(model: DriveViewModel, flow: DriveViewModel.RecoveryFlow, inner: androidx.compose.runtime.MutableState<(() -> Unit)?>) {
    val alpine = Alpine.colors
    val context = LocalContext.current
    // The words stay in memory, never in saved state: a rotation keeps them, a restart doesn't.
    var mode by remember { mutableStateOf(KitMode.CHOOSE) }
    var kit by remember { mutableStateOf<Pair<String, List<String>>?>(null) }
    var notKit by remember { mutableStateOf(false) }
    var field by remember { mutableStateOf(TextFieldValue("")) }
    val typed = field.text
    var password by remember { mutableStateOf("") }
    var confirm by remember { mutableStateOf("") }
    var tried by remember { mutableStateOf(false) }
    val wordlist = remember { context.resources.openRawResource(com.hushos.app.R.raw.bip39_english).bufferedReader().readLines().filter { it.isNotBlank() } }
    val pick = rememberLauncherForActivityResult(ActivityResultContracts.OpenDocument()) { uri: Uri? ->
        if (uri == null) return@rememberLauncherForActivityResult
        // A kit is a few kilobytes; anything much larger isn't one.
        val text = runCatching {
            context.contentResolver.openInputStream(uri)?.use { input -> java.io.ByteArrayOutputStream().also { out -> input.copyTo(BoundedStream(out, 64 * 1024 + 1)) }.toByteArray() }?.takeIf { it.size <= 64 * 1024 }?.decodeToString()
        }.getOrNull()
        val found = text?.let(RecoveryKitText::phraseFromKit)
        val name = runCatching {
            context.contentResolver.query(uri, arrayOf(android.provider.OpenableColumns.DISPLAY_NAME), null, null, null)?.use { if (it.moveToFirst()) it.getString(0) else null }
        }.getOrNull() ?: "your kit"
        if (found == null) { notKit = true; kit = null } else { notKit = false; kit = name to found; mode = KitMode.CHOOSE }
    }
    val permission = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { granted -> if (granted) mode = KitMode.SCAN }
    SideEffect { inner.value = if (mode != KitMode.CHOOSE || kit != null) ({ mode = KitMode.CHOOSE; kit = null }) else null }
    DisposableEffect(Unit) { onDispose { inner.value = null } }
    // A refusal belongs to the words it was about: another kit or typing clears it.
    LaunchedEffect(mode, kit) { model.clearRecoveryError() }

    val count = RecoveryKitText.wordsOf(typed).size
    val words = if (mode == KitMode.TYPING) RecoveryKitText.wordsOf(typed) else kit?.second
    val choosing = mode != KitMode.TYPING && kit == null
    val typedError = if (mode == KitMode.TYPING && count != RecoveryKitText.WORDS)
        "${if (count < RecoveryKitText.WORDS) "${RecoveryKitText.WORDS - count} ${if (RecoveryKitText.WORDS - count == 1) "word" else "words"} missing." else "Too many words."} Type all ${RecoveryKitText.WORDS}, in order, with spaces between them." else null
    val passwordError = if (password.length < 12) "Use at least 12 characters." else null
    val confirmError = if (confirm != password) "The passwords don’t match." else null

    Heading(
        if (choosing) "Use your recovery kit" else "Choose a new password",
        if (choosing) "Your email is confirmed. Your kit shows the account is yours; then you choose a new password."
        else "Resetting gives you a new recovery phrase; you’ll save it next.",
    )
    flow.error?.let { Note(it) }
    when {
        mode == KitMode.SCAN -> {
            Text("Hold your kit’s code inside the frame.", style = MaterialTheme.typography.bodyMedium, color = alpine.inkMuted)
            KitScanner { found -> kit = "your kit’s code" to found; mode = KitMode.CHOOSE }
            TextButton(onClick = { mode = KitMode.CHOOSE }) { Text("Cancel") }
        }
        choosing -> {
            if (notKit) Note("That isn’t a HushOS recovery kit. Choose hushos-recovery-kit.txt, or type the words.")
            KitChoice(Icons.Outlined.QrCodeScanner, "Scan your kit", "Point the camera at the printed kit.") {
                if (ContextCompat.checkSelfPermission(context, Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED) mode = KitMode.SCAN
                else permission.launch(Manifest.permission.CAMERA)
            }
            KitChoice(Icons.Outlined.Description, "Choose the kit file", "hushos-recovery-kit.txt") {
                pick.launch(arrayOf("text/plain", "*/*"))
            }
            KitChoice(Icons.Outlined.Edit, "Type the 24 words", "For a kit written by hand.") { mode = KitMode.TYPING }
            Text("It’s read on this phone and never uploaded.", style = MaterialTheme.typography.bodySmall, color = alpine.inkMuted)
        }
        mode == KitMode.TYPING -> {
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                Text("Recovery phrase", style = MaterialTheme.typography.labelLarge)
                Text("$count of ${RecoveryKitText.WORDS} words", style = MaterialTheme.typography.labelLarge,
                    color = if (count == RecoveryKitText.WORDS) alpine.success else alpine.inkMuted)
            }
            OutlinedTextField(field, { field = it }, enabled = !flow.pending, minLines = 3, isError = tried && typedError != null,
                textStyle = MaterialTheme.typography.bodyLarge.copy(fontFamily = FontFamily.Monospace),
                supportingText = { Text(if (tried && typedError != null) typedError else "All ${RecoveryKitText.WORDS} words, in order.") },
                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Password, autoCorrectEnabled = false), modifier = Modifier.fillMaxWidth())
            // The word at the cursor, completed from the BIP-39 list; the cursor lands after it.
            val cursor = field.selection.end
            val start = typed.lastIndexOfAny(charArrayOf(' ', '\n', '\t', '\r'), (cursor - 1).coerceAtLeast(0)).let { if (cursor == 0) 0 else it + 1 }
            val end = typed.indexOfAny(charArrayOf(' ', '\n', '\t', '\r'), cursor).let { if (it < 0) typed.length else it }
            val partial = if (field.selection.collapsed) typed.substring(start, cursor) else ""
            val suggestions = RecoveryKitText.complete(partial, wordlist).filter { it != typed.substring(start, end).lowercase() }
            if (suggestions.isNotEmpty()) FlowRow(horizontalArrangement = Arrangement.spacedBy(AlpineSpace.S2)) {
                for (word in suggestions) AlpineChip(word, selected = false, onClick = {
                    val after = typed.substring(end).trimStart(' ')
                    val text = typed.substring(0, start) + word + " " + after
                    field = TextFieldValue(text, TextRange(start + word.length + 1))
                })
            }
            TextButton(onClick = { mode = KitMode.CHOOSE }) { Text("Use your recovery kit instead") }
        }
        else -> kit?.let { (file, found) ->
            Row(Modifier.fillMaxWidth().background(alpine.successSoft, RoundedCornerShape(10.dp)).padding(AlpineSpace.S3), verticalAlignment = Alignment.CenterVertically) {
                Icon(Icons.Outlined.CheckCircle, null, tint = alpine.success, modifier = Modifier.size(18.dp))
                Text("24 of 24 words read from $file", color = alpine.success, fontWeight = FontWeight.SemiBold, style = MaterialTheme.typography.bodyMedium,
                    modifier = Modifier.weight(1f).padding(start = AlpineSpace.S2))
                TextButton(onClick = { kit = null }) { Text("Use a different kit") }
            }
            PhraseWords(found.joinToString(" "))
        }
    }
    if (!choosing && mode != KitMode.SCAN) {
        PasswordField(password, { password = it }, "New password", enabled = !flow.pending,
            error = if (tried) passwordError else null, hint = if (!tried || passwordError == null) "At least 12 characters. A few unrelated words work well." else null)
        PasswordField(confirm, { confirm = it }, "Confirm new password", enabled = !flow.pending,
            error = if ((tried || confirm.length >= password.length) && confirm.isNotEmpty()) confirmError else null)
        Button(enabled = !flow.pending, modifier = Modifier.fillMaxWidth().height(48.dp), onClick = {
            tried = true
            if (words != null && typedError == null && passwordError == null && confirmError == null) model.recover(words, password)
        }) { Text(if (flow.pending) "Resetting…" else "Reset password") }
    }
}

@Composable
private fun KitChoice(icon: androidx.compose.ui.graphics.vector.ImageVector, title: String, detail: String, onClick: () -> Unit) {
    val alpine = Alpine.colors
    Row(Modifier.fillMaxWidth().heightIn(min = 64.dp).background(alpine.surface, RoundedCornerShape(16.dp)).clickable(onClick = onClick).padding(AlpineSpace.S4),
        verticalAlignment = Alignment.CenterVertically) {
        Icon(icon, null, tint = alpine.primary)
        Column(Modifier.padding(start = AlpineSpace.S4)) {
            Text(title, style = MaterialTheme.typography.bodyLarge, fontWeight = FontWeight.Medium)
            Text(detail, style = MaterialTheme.typography.bodyMedium, color = alpine.inkMuted)
        }
    }
}

/* The camera, reading frames for a kit's QR code on the phone; the first code that holds a phrase ends it. */
@Composable
private fun KitScanner(onPhrase: (List<String>) -> Unit) {
    val context = LocalContext.current
    val lifecycle = LocalLifecycleOwner.current
    val executor = remember { Executors.newSingleThreadExecutor() }
    var done by remember { mutableStateOf(false) }
    DisposableEffect(Unit) { onDispose { executor.shutdown() } }
    AndroidView(
        factory = { ctx ->
            val view = PreviewView(ctx)
            val future = ProcessCameraProvider.getInstance(ctx)
            future.addListener({
                val provider = future.get()
                val preview = Preview.Builder().build().also { it.surfaceProvider = view.surfaceProvider }
                val analysis = ImageAnalysis.Builder().setBackpressureStrategy(ImageAnalysis.STRATEGY_KEEP_ONLY_LATEST).build()
                analysis.setAnalyzer(executor) { image ->
                    image.use {
                        if (done) return@use
                        val plane = it.planes[0]
                        val buffer = plane.buffer
                        val bytes = ByteArray(buffer.remaining()).also(buffer::get)
                        KitScan.phrase(bytes, it.width, it.height, plane.rowStride)?.let { found ->
                            done = true
                            ContextCompat.getMainExecutor(context).execute { provider.unbindAll(); onPhrase(found) }
                        }
                    }
                }
                runCatching {
                    provider.unbindAll()
                    provider.bindToLifecycle(lifecycle, CameraSelector.DEFAULT_BACK_CAMERA, preview, analysis)
                }.recoverCatching {
                    provider.bindToLifecycle(lifecycle, CameraSelector.DEFAULT_FRONT_CAMERA, preview, analysis)
                }
            }, ContextCompat.getMainExecutor(ctx))
            view
        },
        modifier = Modifier.fillMaxWidth().aspectRatio(1f).background(Alpine.colors.ink, RoundedCornerShape(16.dp)),
    )
}

/* Takes up to `limit` bytes and quietly drops the rest, so an oversized file is read only that far. */
private class BoundedStream(private val out: java.io.OutputStream, private val limit: Int) : java.io.OutputStream() {
    private var written = 0
    override fun write(b: Int) { if (written < limit) { out.write(b); written++ } else throw java.io.IOException("Too large") }
    override fun write(b: ByteArray, off: Int, len: Int) {
        val room = limit - written
        if (room <= 0) throw java.io.IOException("Too large")
        val n = minOf(room, len)
        out.write(b, off, n)
        written += n
        if (n < len) throw java.io.IOException("Too large")
    }
}
