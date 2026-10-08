package com.hushos.app.ui

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import androidx.activity.compose.BackHandler
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.verticalScroll
import androidx.compose.foundation.selection.toggleable
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.KeyboardArrowRight
import androidx.compose.material.icons.automirrored.outlined.Logout
import androidx.compose.material.icons.outlined.ContentCopy
import androidx.compose.material.icons.outlined.Delete
import androidx.compose.material.icons.outlined.DeleteForever
import androidx.compose.material.icons.outlined.FolderOpen
import androidx.compose.material.icons.outlined.Key
import androidx.compose.material.icons.outlined.Password
import androidx.compose.material.icons.outlined.PrivacyTip
import androidx.compose.material.icons.outlined.Gavel
import androidx.compose.material.icons.outlined.Settings
import androidx.compose.material.icons.outlined.Sync
import androidx.compose.material.icons.outlined.Visibility
import androidx.compose.material.icons.outlined.VisibilityOff
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.Checkbox
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.input.nestedscroll.nestedScroll
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.input.VisualTransformation
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.hushos.tokens.AlpineRadius
import com.hushos.tokens.AlpineSpace
import kotlinx.coroutines.launch
import java.io.File
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter

/* "3 Nov": a plan's dates, as the web writes them, never 2026-11-03. */
private fun shortDate(iso: String?): String? = iso?.let {
    runCatching {
        DateTimeFormatter.ofPattern(android.text.format.DateFormat.getBestDateTimePattern(java.util.Locale.getDefault(), "dMMM"))
            .format(Instant.parse(it).atZone(ZoneId.systemDefault()))
    }.getOrNull()
}

private enum class Page { MAIN, PLAN, PASSWORD, PHRASE, ADVANCED, RESET, TRASH }

/*
 * Account, a tab of its own (the user's choice over the board's avatar): who is
 * signed in, Plan and storage, sign-in and recovery, Trash, this phone, Advanced
 * (sharing keys, the account's id and server, delete), and Sign out at the foot.
 */
@OptIn(ExperimentalMaterial3Api::class, androidx.compose.foundation.layout.ExperimentalLayoutApi::class)
@Composable
fun AccountScreen(model: DriveViewModel, state: DriveState) {
    val alpine = Alpine.colors
    val context = LocalContext.current
    var page by rememberSaveable { mutableStateOf(Page.MAIN) }
    var editingName by rememberSaveable { mutableStateOf(false) }
    var signingOut by rememberSaveable { mutableStateOf(false) }
    // /app/trash: straight to Trash.
    LaunchedEffect(state.request) { if (state.request == "trash") { page = Page.TRASH; model.clearRequest() } }
    LaunchedEffect(Unit) { model.refreshStorage(); model.refreshAccount(); model.refreshUser() }
    BackHandler(enabled = page != Page.MAIN) { page = if (page == Page.RESET) Page.ADVANCED else Page.MAIN }
    when (page) {
        Page.TRASH -> { TrashScreen(model, state) { page = Page.MAIN; model.refreshStorage() }; return }
        Page.PLAN -> { PlanScreen(model, state) { page = Page.MAIN }; return }
        Page.PASSWORD -> { PasswordScreen(model) { page = Page.MAIN }; return }
        Page.PHRASE -> { PhraseScreen(model, fresh = null) { page = Page.MAIN }; return }
        Page.ADVANCED -> { AdvancedScreen(model, state, onReset = { page = Page.RESET }) { page = Page.MAIN }; return }
        Page.RESET -> { ResetKeysScreen(model) { page = Page.ADVANCED }; return }
        Page.MAIN -> {}
    }
    val scroll = androidx.compose.material3.TopAppBarDefaults.enterAlwaysScrollBehavior()
    Scaffold(
        contentWindowInsets = WindowInsets(0), containerColor = alpine.ground,
        modifier = Modifier.nestedScroll(scroll.nestedScrollConnection),
        // A top-level destination: the same header as the other tabs, and no way "back" from a tab.
        topBar = { DestinationBar("Account", scrollBehavior = scroll) },
    ) { padding ->
        Column(Modifier.padding(padding).fillMaxSize().verticalScroll(rememberScrollState()).padding(bottom = AlpineSpace.S8)) {
            if (state.unreachable) OfflineCapsule()
            state.user?.let { user ->
                Row(Modifier.fillMaxWidth().heightIn(min = 72.dp).padding(start = AlpineSpace.S4, end = AlpineSpace.S2), verticalAlignment = Alignment.CenterVertically) {
                    PersonAvatar(user.name.ifEmpty { user.email }, user.id, 48.dp)
                    Column(Modifier.weight(1f).padding(start = AlpineSpace.S4)) {
                        Text(user.name.ifEmpty { "Signed in" }, style = MaterialTheme.typography.titleMedium)
                        if (user.email.isNotEmpty()) Text(user.email, style = MaterialTheme.typography.bodyMedium, color = alpine.inkMuted, maxLines = 1, overflow = TextOverflow.Ellipsis)
                    }
                    TextButton(onClick = { editingName = true }) { Text("Edit") }
                }
            }
            PlanCard(state) { page = Page.PLAN }
            Subheader("Sign-in and recovery")
            AccountRow("Change password", "The password you sign in with", Icons.Outlined.Password) { page = Page.PASSWORD }
            AccountRow("Recovery phrase", "Gets you back in if you forget your password", Icons.Outlined.Key) { page = Page.PHRASE }
            Subheader("Your files")
            // Trash lives here, as it did before the redesign (the user's choice).
            AccountRow("Trash", state.storage?.let { s -> trashSummary(s.trashItems, s.trashBytes) }, Icons.Outlined.Delete) { page = Page.TRASH }
            Subheader("This phone")
            AccountRow("HushOS in Files", "Open and save files from the Files app and other apps", Icons.Outlined.FolderOpen, onClick = null)
            BackgroundStatus()
            AccountRow("Advanced", "Sharing keys, account ID, delete account", Icons.Outlined.Settings) { page = Page.ADVANCED }
            // The signed-in server's own pages (hushos.com's by default), as the stores require.
            Subheader("About")
            AccountRow("Privacy policy", null, Icons.Outlined.PrivacyTip) { openWebPage(context, privacyUrl(state.origin)) }
            AccountRow("Terms", null, Icons.Outlined.Gavel) { openWebPage(context, termsUrl(state.origin)) }
            HorizontalDivider(Modifier.padding(horizontal = AlpineSpace.S4, vertical = AlpineSpace.S2), color = alpine.divider)
            // Sign out sits below everything else, away from Delete.
            AccountRow("Sign out", null, Icons.AutoMirrored.Outlined.Logout) { signingOut = true }
            Text("HushOS ${com.hushos.app.BuildConfig.VERSION_NAME}", style = MaterialTheme.typography.bodySmall, color = alpine.inkMuted,
                modifier = Modifier.fillMaxWidth().padding(vertical = AlpineSpace.S6), textAlign = TextAlign.Center)
        }
    }
    if (editingName) {
        var name by rememberSaveable { mutableStateOf(state.user?.name.orEmpty()) }
        AlertDialog(
            onDismissRequest = { editingName = false },
            title = { Text("Your name") },
            text = {
                Column {
                    Text("Shown to people you share with.", modifier = Modifier.padding(bottom = AlpineSpace.S3))
                    OutlinedTextField(value = name, onValueChange = { name = it }, singleLine = true, label = { Text("Name") })
                }
            },
            confirmButton = { TextButton(enabled = name.isNotBlank(), onClick = {
                editingName = false
                model.updateName(name.trim()) { failure -> model.notify(failure ?: "Name saved") }
            }) { Text("Save") } },
            dismissButton = { TextButton(onClick = { editingName = false }) { Text("Cancel") } },
        )
    }
    // Signing out removes everything of the account from the phone (AccountStore); kept files are the part people would miss.
    val keptHere = signingOut && remember(signingOut) { com.hushos.app.data.Offline.entries(context).isNotEmpty() || com.hushos.app.data.Offline.folders(context).isNotEmpty() }
    if (signingOut) AlertDialog(
        onDismissRequest = { signingOut = false },
        title = { Text("Sign out of HushOS?") },
        text = { Text(if (keptHere) "Files kept on this phone are removed. You’ll need your email and password to sign back in on this phone." else "You’ll need your email and password to sign back in on this phone.") },
        confirmButton = { TextButton(onClick = { signingOut = false; model.signOut() }) { Text("Sign out", color = alpine.danger) } },
        dismissButton = { TextButton(onClick = { signingOut = false }) { Text("Cancel") } },
    )
}

@Composable
private fun AccountRow(title: String, detail: String?, icon: ImageVector, danger: Boolean = false, onClick: (() -> Unit)?) {
    val alpine = Alpine.colors
    Row(
        Modifier.fillMaxWidth().heightIn(min = 56.dp).then(if (onClick != null) Modifier.clickable(onClick = onClick) else Modifier).padding(horizontal = AlpineSpace.S4, vertical = AlpineSpace.S2),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Icon(icon, null, tint = if (danger) alpine.danger else alpine.inkMuted)
        Column(Modifier.weight(1f).padding(start = AlpineSpace.S4)) {
            Text(title, style = MaterialTheme.typography.bodyLarge, color = if (danger) alpine.danger else alpine.ink)
            detail?.let { Text(it, style = MaterialTheme.typography.bodyMedium, color = alpine.inkMuted) }
        }
        if (onClick != null && !danger) Icon(Icons.AutoMirrored.Outlined.KeyboardArrowRight, null, tint = alpine.inkMuted)
    }
}

/*
 * What lets transfers carry on in the background, quietly: one line each, and Open
 * settings beside any that is off. Read again whenever HushOS comes back from Settings.
 */
@Composable
private fun BackgroundStatus() {
    val alpine = Alpine.colors
    val context = LocalContext.current
    val access = rememberBackgroundAccess()
    val open = { intent: Intent -> runCatching { context.startActivity(intent) }; Unit }
    Row(Modifier.fillMaxWidth().padding(horizontal = AlpineSpace.S4, vertical = AlpineSpace.S2)) {
        Icon(Icons.Outlined.Sync, null, tint = alpine.inkMuted, modifier = Modifier.padding(top = 2.dp))
        Column(Modifier.weight(1f).padding(start = AlpineSpace.S4)) {
            Text("Background transfers", style = MaterialTheme.typography.bodyLarge, color = alpine.ink)
            StatusLine(if (access.notifications) "Notifications on" else "Notifications off", ok = access.notifications) {
                open(com.hushos.app.data.Background.notificationSettings(context))
            }
            StatusLine(if (access.battery) "Battery optimisation off for HushOS" else "Battery optimisation can pause transfers", ok = access.battery) {
                open(com.hushos.app.data.Background.batterySettings())
            }
            StatusLine(if (access.data) "Background data allowed" else "Data Saver blocks background data", ok = access.data) {
                open(com.hushos.app.data.Background.dataSettings(context))
            }
        }
    }
}

@Composable
private fun StatusLine(text: String, ok: Boolean, onOpen: () -> Unit) {
    Row(Modifier.fillMaxWidth().heightIn(min = if (ok) 0.dp else 40.dp), verticalAlignment = Alignment.CenterVertically) {
        Text(text, style = MaterialTheme.typography.bodyMedium, color = Alpine.colors.inkMuted, modifier = Modifier.weight(1f))
        if (!ok) TextButton(onClick = onOpen) { Text("Open settings") }
    }
}

/* Trash in one line, worded as on iOS: empty, or how many top-level items and their size. */
private fun trashSummary(items: Int, bytes: Long): String = when {
    items == 0 -> "Empty · items stay 30 days"
    else -> listOfNotNull(if (items == 1) "1 item" else "$items items", bytes.takeIf { it > 0 }?.let(::formatSpace), "removed after 30 days").joinToString(" · ")
}

/* The plan and how full it is, as a card that opens Plan and storage. */
@Composable
private fun PlanCard(state: DriveState, onClick: () -> Unit) {
    val alpine = Alpine.colors
    val shape = RoundedCornerShape(AlpineRadius.Card)
    Column(
        Modifier.padding(horizontal = AlpineSpace.S4, vertical = AlpineSpace.S2).fillMaxWidth().background(alpine.surface, shape)
            .then(if (alpine.high) Modifier.border(1.dp, alpine.edge, shape) else Modifier).clickable(onClick = onClick).padding(AlpineSpace.S4),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Column(Modifier.weight(1f)) {
                Text("Plan and storage", style = MaterialTheme.typography.labelLarge, color = alpine.inkMuted)
                Text(state.billing?.planName?.takeIf { it.isNotEmpty() } ?: "Free", style = MaterialTheme.typography.titleMedium)
            }
            Icon(Icons.AutoMirrored.Outlined.KeyboardArrowRight, null, tint = alpine.inkMuted)
        }
        state.allowance?.let {
            Text("${formatSpace(it.usedBytes)} of ${formatQuota(it.quotaBytes)}", style = MaterialTheme.typography.bodyMedium, modifier = Modifier.padding(top = AlpineSpace.S2))
            Meter(it.usedBytes.toFloat() / maxOf(it.quotaBytes, 1L), Modifier.padding(top = AlpineSpace.S2))
        }
        planLine(state)?.let { Text(it, style = MaterialTheme.typography.bodySmall, color = alpine.inkMuted, modifier = Modifier.padding(top = AlpineSpace.S2)) }
    }
}

private fun planLine(state: DriveState): String? = state.billing?.periodEnd?.let { shortDate(it) }?.let { date ->
    (if (state.billing.cancelAtPeriodEnd) "Ends $date" else "Renews $date")
}

/* A pushed page inside Account: a back arrow, a title, and its own scrolling column. */
@Composable
private fun AccountPage(title: String, onBack: (() -> Unit)?, actions: @Composable androidx.compose.foundation.layout.RowScope.() -> Unit = {}, content: @Composable androidx.compose.foundation.layout.ColumnScope.() -> Unit) {
    val alpine = Alpine.colors
    Scaffold(contentWindowInsets = WindowInsets(0), containerColor = alpine.ground, topBar = { DestinationBar(title, onBack = onBack, actions = actions) }) { padding ->
        Column(Modifier.padding(padding).fillMaxSize().verticalScroll(rememberScrollState()).padding(bottom = AlpineSpace.S8)) {
            content()
        }
    }
}

/*
 * Plan and storage: the plan's name and storage, read-only, and what fills the
 * space: files, earlier versions and the trash, each with its way to clear it.
 */
@Composable
private fun PlanScreen(model: DriveViewModel, state: DriveState, onBack: () -> Unit) {
    val alpine = Alpine.colors
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    var removing by remember { mutableStateOf(false) }
    var busy by remember { mutableStateOf(false) }
    var showingTrash by remember { mutableStateOf(false) }
    LaunchedEffect(Unit) { model.refreshStorage(); model.refreshAccount() }
    if (showingTrash) {
        BackHandler { showingTrash = false }
        TrashScreen(model, state) { showingTrash = false; model.refreshStorage(); model.refreshAccount() }
        return
    }
    AccountPage("Plan and storage", onBack) {
        if (state.unreachable) OfflineCapsule()
        val shape = RoundedCornerShape(AlpineRadius.Card)
        Column(Modifier.padding(AlpineSpace.S4).fillMaxWidth().background(alpine.surface, shape).then(if (alpine.high) Modifier.border(1.dp, alpine.edge, shape) else Modifier).padding(AlpineSpace.S4)) {
            Text("Your plan", style = MaterialTheme.typography.labelLarge, color = alpine.inkMuted)
            Text(state.billing?.planName?.takeIf { it.isNotEmpty() } ?: "Free", style = MaterialTheme.typography.titleLarge)
            // The plan's name and storage only: no way to the web's billing page (Google Play's
            // payments policy; Apple's 3.1.3(f)). The renewal date is account information.
            Text(listOfNotNull(state.allowance?.let { formatQuota(it.quotaBytes) }, planLine(state)?.replaceFirstChar { it.lowercase() }).joinToString(" · "),
                style = MaterialTheme.typography.bodyMedium, color = alpine.inkMuted)
        }
        val allowance = state.allowance
        val storage = state.storage
        if (allowance != null) {
            val trash = storage?.trashBytes ?: 0L
            val versions = storage?.supersededBytes ?: 0L
            val files = (allowance.usedBytes - trash - versions).coerceAtLeast(0L)
            Text("${formatSpace(allowance.usedBytes)} of ${formatQuota(allowance.quotaBytes)}", style = MaterialTheme.typography.titleMedium, modifier = Modifier.padding(horizontal = AlpineSpace.S4))
            SplitMeter(listOf(files to alpine.primary, versions to alpine.folderBack, trash to alpine.inkMuted), allowance.quotaBytes, Modifier.padding(AlpineSpace.S4))
            StorageRow("Files", formatSpace(files), alpine.primary, null)
            StorageRow("Earlier versions", formatSpace(versions), alpine.folderBack, if (versions > 0) "Remove" to { removing = true } else null)
            StorageRow("Trash", "${formatSpace(trash)} · empties itself after 30 days", alpine.inkMuted, "Open trash" to { showingTrash = true })
            if (busy) Row(Modifier.padding(AlpineSpace.S4), verticalAlignment = Alignment.CenterVertically) {
                CircularProgressIndicator(Modifier.size(18.dp), strokeWidth = 2.dp); Text("Removing…", modifier = Modifier.padding(start = AlpineSpace.S2))
            }
        }
    }
    if (removing) AlertDialog(
        onDismissRequest = { removing = false },
        title = { Text("Remove earlier versions?") },
        text = { Text("Every file keeps its current version. The ${formatSpace(state.storage?.supersededBytes ?: 0)} of earlier versions is deleted and can’t be restored.") },
        confirmButton = { TextButton(onClick = {
            removing = false; busy = true
            val freed = state.storage?.supersededBytes ?: 0
            val count = state.storage?.supersededVersions ?: 0
            scope.launch {
                if (model.discardEarlierVersions()) model.notify("Removed ${if (count == 1) "1 earlier version" else "$count earlier versions"} · ${formatSpace(freed)} freed")
                else model.notify("Couldn’t remove the earlier versions. Check your connection and try again.")
                busy = false
            }
        }) { Text("Remove", color = alpine.danger) } },
        dismissButton = { TextButton(onClick = { removing = false }) { Text("Cancel") } },
    )
}

/* The meter split by what fills it, no stop dot and no gaps. */
@Composable
private fun SplitMeter(parts: List<Pair<Long, androidx.compose.ui.graphics.Color>>, total: Long, modifier: Modifier = Modifier) {
    val alpine = Alpine.colors
    Row(modifier.fillMaxWidth().height(10.dp).clip(CircleShape).background(alpine.ink.copy(alpha = if (alpine.high) 0.2f else 0.1f))) {
        for ((bytes, colour) in parts) {
            val share = (bytes.toFloat() / maxOf(total, 1L)).coerceIn(0f, 1f)
            if (share > 0f) Box(Modifier.weight(share).height(10.dp).background(colour))
        }
        val used = parts.sumOf { it.first }.toFloat() / maxOf(total, 1L)
        if (used < 1f) Spacer(Modifier.weight((1f - used).coerceAtLeast(0.0001f)))
    }
}

@Composable
private fun StorageRow(label: String, value: String, colour: androidx.compose.ui.graphics.Color, action: Pair<String, () -> Unit>?) {
    val alpine = Alpine.colors
    Row(Modifier.fillMaxWidth().heightIn(min = 56.dp).padding(start = AlpineSpace.S4, end = AlpineSpace.S2), verticalAlignment = Alignment.CenterVertically) {
        Box(Modifier.size(12.dp).background(colour, CircleShape))
        Column(Modifier.weight(1f).padding(start = AlpineSpace.S3)) {
            Text(label, style = MaterialTheme.typography.bodyLarge)
            Text(value, style = MaterialTheme.typography.bodyMedium, color = alpine.inkMuted)
        }
        action?.let { (text, run) -> TextButton(onClick = run) { Text(text) } }
    }
}

/* A password field with the eye, as on sign-in. */
@Composable
fun PasswordField(value: String, onChange: (String) -> Unit, label: String, modifier: Modifier = Modifier, error: String? = null, hint: String? = null, enabled: Boolean = true, onGo: (() -> Unit)? = null) {
    var shown by remember { mutableStateOf(false) }
    OutlinedTextField(
        value = value, onValueChange = onChange, label = { Text(label) }, singleLine = true, enabled = enabled, isError = error != null,
        supportingText = (error ?: hint)?.let { { Text(it) } },
        visualTransformation = if (shown) VisualTransformation.None else PasswordVisualTransformation(),
        keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Password, autoCorrectEnabled = false, imeAction = if (onGo != null) ImeAction.Go else ImeAction.Default),
        keyboardActions = KeyboardActions(onGo = { onGo?.invoke() }),
        trailingIcon = { IconButton(onClick = { shown = !shown }) { Icon(if (shown) Icons.Outlined.VisibilityOff else Icons.Outlined.Visibility, if (shown) "Hide password" else "Show password") } },
        modifier = modifier.fillMaxWidth(),
    )
}

/* Change password: a page of its own, saying what you'll notice afterwards. */
@Composable
private fun PasswordScreen(model: DriveViewModel, onBack: () -> Unit) {
    val alpine = Alpine.colors
    var current by rememberSaveable { mutableStateOf("") }
    var new by rememberSaveable { mutableStateOf("") }
    var repeat by rememberSaveable { mutableStateOf("") }
    var pending by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    val mismatch = repeat.isNotEmpty() && new != repeat
    AccountPage("Change password", onBack = if (pending) null else onBack) {
        Column(Modifier.padding(horizontal = AlpineSpace.S4), verticalArrangement = Arrangement.spacedBy(AlpineSpace.S3)) {
            PasswordField(current, { current = it; error = null }, "Current password", error = error, enabled = !pending)
            PasswordField(new, { new = it }, "New password", hint = "At least 12 characters. A few unrelated words work well.", enabled = !pending)
            PasswordField(repeat, { repeat = it }, "Repeat new password", error = if (mismatch) "The new passwords don’t match." else null, enabled = !pending)
            Text("Your other devices will be signed out. Your recovery phrase stays the same.", style = MaterialTheme.typography.bodyMedium, color = alpine.inkMuted)
            Button(
                enabled = !pending && current.isNotEmpty() && new.length >= 12 && new == repeat,
                onClick = {
                    pending = true
                    model.changePassword(current, new) { message ->
                        pending = false
                        if (message == "Your password was changed.") { model.notify(message); onBack() } else error = message
                    }
                },
                modifier = Modifier.fillMaxWidth().height(48.dp),
            ) { Text(if (pending) "Changing…" else "Change password") }
        }
    }
}

/*
 * The recovery phrase on a page of its own, so 24 words fit: Save the kit (the
 * web's kit file, through the share sheet), Copy, and, while the phrase isn't
 * confirmed as saved, the web's check: say it's saved, then pick three words back.
 * `fresh` is a phrase just made (after Reset sharing keys): no way out but "I’ve saved it".
 */
@Composable
fun PhraseScreen(model: DriveViewModel, fresh: String?, onDone: () -> Unit) {
    val alpine = Alpine.colors
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    var kit by remember { mutableStateOf<DriveViewModel.RecoveryKit?>(null) }
    var failed by remember { mutableStateOf(false) }
    var saved by rememberSaveable { mutableStateOf(false) }
    var checking by rememberSaveable { mutableStateOf(false) }
    var attempt by remember { mutableStateOf(0) }
    LaunchedEffect(attempt) { failed = false; kit = model.recoveryKit(); if (kit == null) failed = true }
    // The kit file is only on this phone while this page is open.
    androidx.compose.runtime.DisposableEffect(Unit) { onDispose { File(context.cacheDir, "kit").deleteRecursively() } }
    val current = kit
    if (checking && current != null) {
        CheckWordsScreen(current.phrase, onBack = { checking = false }) {
            scope.launch {
                if (model.confirmRecovery(current)) { model.notify("Recovery phrase saved"); onDone() }
                else model.notify("Couldn’t record that. Check your connection and try again.")
            }
        }
        return
    }
    AccountPage(if (fresh != null) "Your new recovery phrase" else "Recovery phrase", onBack = if (fresh != null) null else onDone) {
        Column(Modifier.padding(horizontal = AlpineSpace.S4), verticalArrangement = Arrangement.spacedBy(AlpineSpace.S4)) {
            Text(
                if (fresh != null) "Your old phrase and any printed kit no longer work. Save these 24 words instead."
                else "These 24 words get you back in if you forget your password. Keep them somewhere private and offline.",
                style = MaterialTheme.typography.bodyMedium, color = alpine.inkMuted,
            )
            when {
                failed -> Column(verticalArrangement = Arrangement.spacedBy(AlpineSpace.S2)) {
                    Text("Your recovery phrase didn’t open. Try again.", color = alpine.danger)
                    Button(onClick = { attempt++ }) { Text("Try again") }
                }
                current == null -> Box(Modifier.fillMaxWidth().padding(AlpineSpace.S8), contentAlignment = Alignment.Center) { CircularProgressIndicator() }
                else -> {
                    PhraseWords(current.phrase)
                    Row(horizontalArrangement = Arrangement.spacedBy(AlpineSpace.S2)) {
                        Button(onClick = { shareKit(context, model.state.value.user, current) }) { Text("Save the kit") }
                        OutlinedButton(onClick = {
                            (context.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager).setPrimaryClip(ClipData.newPlainText("Recovery phrase", current.phrase))
                            model.notify("Copied. Paste it somewhere private, then clear your clipboard.")
                        }) { Icon(Icons.Outlined.ContentCopy, null, Modifier.size(18.dp)); Spacer(Modifier.width(AlpineSpace.S2)); Text("Copy") }
                    }
                    Text("Keep it somewhere private and offline. Anyone with these words and your email can get into your account.",
                        style = MaterialTheme.typography.bodySmall, color = alpine.inkMuted)
                    if (fresh != null || !current.confirmed) {
                        Row(Modifier.fillMaxWidth().toggleable(value = saved, role = Role.Checkbox) { saved = it }, verticalAlignment = Alignment.CenterVertically) {
                            Checkbox(checked = saved, onCheckedChange = null)
                            Text("I’ve saved my kit or written the words down, somewhere private.", modifier = Modifier.padding(start = AlpineSpace.S3))
                        }
                        Button(enabled = saved, onClick = { checking = true }, modifier = Modifier.fillMaxWidth().height(48.dp)) { Text(if (fresh != null) "I’ve saved it" else "Check three words") }
                    }
                }
            }
        }
    }
}

/* Twenty-four words, numbered, two to a row. */
@Composable
internal fun PhraseWords(phrase: String) {
    val alpine = Alpine.colors
    val words = phrase.trim().split(Regex("\\s+"))
    Column(verticalArrangement = Arrangement.spacedBy(AlpineSpace.S2)) {
        words.chunked(2).forEachIndexed { row, pair ->
            Row(horizontalArrangement = Arrangement.spacedBy(AlpineSpace.S2)) {
                pair.forEachIndexed { column, word ->
                    Row(Modifier.weight(1f).background(alpine.surface, RoundedCornerShape(10.dp)).then(if (alpine.high) Modifier.border(1.dp, alpine.edge, RoundedCornerShape(10.dp)) else Modifier)
                        .padding(horizontal = AlpineSpace.S3, vertical = AlpineSpace.S2), verticalAlignment = Alignment.CenterVertically) {
                        Text("${row * 2 + column + 1}", style = MaterialTheme.typography.labelSmall, color = alpine.inkMuted, modifier = Modifier.width(22.dp))
                        Text(word, style = MaterialTheme.typography.bodyLarge.copy(fontFamily = FontFamily.Monospace))
                    }
                }
            }
        }
    }
}

/* The kit as the web writes it (hushos-recovery-kit.txt), handed to the share sheet: print, save to Files, any app. */
private fun shareKit(context: Context, user: com.hushos.app.data.SessionUser?, kit: DriveViewModel.RecoveryKit) {
    val words = kit.phrase.trim().split(Regex("\\s+"))
    val numbered = words.mapIndexed { i, w -> "${(i + 1).toString().padStart(2, ' ')}. $w".padEnd(16, ' ') }
    val lines = numbered.chunked(4).map { it.joinToString("").trimEnd() }
    val text = listOf(
        "HushOS recovery kit",
        "Saved ${java.time.LocalDate.now()}",
        "",
        "Keep this file private, and keep it somewhere you will find it again.",
        "Anyone who has it can get into your account. If you lose it and forget",
        "your password, nobody can get you back in, including HushOS.",
        "",
        "YOUR ACCOUNT",
        "Email:       ${user?.email.orEmpty()}",
        "Account ID:  ${user?.id.orEmpty()}",
        "",
        "YOUR RECOVERY PHRASE (${words.size} words, in this order)",
        "This is what unlocks your account if you forget your password.",
        "",
    ) + lines + listOf(
        "",
        "The same phrase on one line, for pasting:",
        words.joinToString(" "),
        "",
        "HOW TO USE IT",
        "1. Open HushOS and choose \"Forgot your password?\".",
        "2. Confirm your email with the link we send.",
        "3. Choose this file when asked for your kit, or type the words above in order.",
        "",
        "WHEN THIS KIT STOPS WORKING",
        "Resetting your password with this phrase, making a new recovery phrase,",
        "or resetting sharing keys in Settings makes a new phrase. Save a new kit then.",
        "Changing your password in Settings keeps this phrase as it is.",
        "",
        "FOR RECOVERY TOOLS",
        "The block below is your account key, locked with the phrase above. You do",
        "not need it to reset your password in HushOS. It is here so the phrase can",
        "open your key even without the service.",
        "",
        kit.recovery.toString(4),
    )
    val file = File(context.cacheDir, "kit/hushos-recovery-kit.txt").also { it.parentFile?.mkdirs() }
    file.writeText(text.joinToString("\n"))
    val uri = androidx.core.content.FileProvider.getUriForFile(context, "${context.packageName}.shared", file)
    val send = Intent(Intent.ACTION_SEND).setType("text/plain").putExtra(Intent.EXTRA_STREAM, uri).addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
    context.startActivity(shareChooser(context, send, "Save your recovery kit"))
}

/* Three words picked back out of the kit before the phrase counts as saved, as on the web: each offered with two other words of the same phrase. */
@OptIn(androidx.compose.foundation.layout.ExperimentalLayoutApi::class)
@Composable
private fun CheckWordsScreen(phrase: String, onBack: () -> Unit, onDone: () -> Unit) {
    val alpine = Alpine.colors
    val words = remember(phrase) { phrase.trim().split(Regex("\\s+")) }
    val positions = remember(phrase) { words.indices.shuffled().take(3).sorted() }
    val options = remember(phrase) {
        positions.associateWith { at -> (words.filterIndexed { i, _ -> i != at }.distinct().filter { it != words[at] }.shuffled().take(2) + words[at]).shuffled() }
    }
    var picked by remember { mutableStateOf<Map<Int, String>>(emptyMap()) }
    val right = positions.all { picked[it] == words[it] }
    AccountPage("Check you saved it", onBack) {
        Column(Modifier.padding(horizontal = AlpineSpace.S4), verticalArrangement = Arrangement.spacedBy(AlpineSpace.S4)) {
            Text("Pick the missing words from your kit.", style = MaterialTheme.typography.bodyMedium, color = alpine.inkMuted)
            for (at in positions) Column(verticalArrangement = Arrangement.spacedBy(AlpineSpace.S2)) {
                Text("Word ${at + 1}", style = MaterialTheme.typography.titleSmall)
                FlowRow(horizontalArrangement = Arrangement.spacedBy(AlpineSpace.S2), verticalArrangement = Arrangement.spacedBy(AlpineSpace.S2)) {
                    for (word in options[at].orEmpty()) AlpineChip(word, selected = picked[at] == word, onClick = { picked = picked + (at to word) })
                }
                val choice = picked[at]
                if (choice != null && choice != words[at]) Text("That isn’t word ${at + 1}. Look at your kit again.", style = MaterialTheme.typography.bodySmall, color = alpine.danger)
            }
            Button(enabled = right, onClick = onDone, modifier = Modifier.fillMaxWidth().height(48.dp)) { Text("Finish") }
            TextButton(onClick = onBack) { Text("Show my words again") }
        }
    }
}

/* Advanced: sharing keys, what identifies this account, and deleting it. */
@Composable
private fun AdvancedScreen(model: DriveViewModel, state: DriveState, onReset: () -> Unit, onBack: () -> Unit) {
    val alpine = Alpine.colors
    val context = LocalContext.current
    var deleting by rememberSaveable { mutableStateOf(false) }
    var selfHosting by rememberSaveable { mutableStateOf(false) }
    if (selfHosting) { SelfHostingScreen(model, state, signedIn = true) { selfHosting = false }; return }
    AccountPage("Advanced", onBack) {
        AccountRow("Reset sharing keys", "If you think someone saw your password or phrase", Icons.Outlined.Sync, onClick = onReset)
        Subheader("About this account")
        state.user?.id?.let { id ->
            Row(Modifier.fillMaxWidth().heightIn(min = 56.dp).clickable {
                (context.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager).setPrimaryClip(ClipData.newPlainText("Account ID", id))
                model.notify("Account ID copied")
            }.padding(horizontal = AlpineSpace.S4), verticalAlignment = Alignment.CenterVertically) {
                Column(Modifier.weight(1f)) {
                    Text("Account ID", style = MaterialTheme.typography.bodyLarge)
                    Text(id, style = MaterialTheme.typography.bodyMedium.copy(fontFamily = FontFamily.Monospace), color = alpine.inkMuted)
                }
                Icon(Icons.Outlined.ContentCopy, "Copy account ID", tint = alpine.inkMuted)
            }
        }
        // The server this phone signs in to; it opens Self-hosting, read-only while signed in.
        Column(Modifier.fillMaxWidth().heightIn(min = 56.dp).clickable { selfHosting = true }.padding(horizontal = AlpineSpace.S4, vertical = AlpineSpace.S2)) {
            Text("Server address", style = MaterialTheme.typography.bodyLarge)
            Text(state.origin.substringAfter("://").trimEnd('/') + if (state.origin.contains("hushos.com")) "" else " · self-hosted", style = MaterialTheme.typography.bodyMedium, color = alpine.inkMuted)
        }
        HorizontalDivider(Modifier.padding(horizontal = AlpineSpace.S4, vertical = AlpineSpace.S2), color = alpine.divider)
        AccountRow("Delete account", "Every file, every earlier version and the account. It can’t be undone.", Icons.Outlined.DeleteForever, danger = true) { deleting = true }
    }
    if (deleting) {
        var password by rememberSaveable { mutableStateOf("") }
        var typed by rememberSaveable { mutableStateOf("") }
        var pending by remember { mutableStateOf(false) }
        var error by remember { mutableStateOf<String?>(null) }
        AlertDialog(
            onDismissRequest = { if (!pending) deleting = false },
            title = { Text("Delete account") },
            text = {
                Column(verticalArrangement = Arrangement.spacedBy(AlpineSpace.S3)) {
                    Text("Every file, every earlier version and the account. It can’t be undone.")
                    PasswordField(password, { password = it; error = null }, "Password", error = error, enabled = !pending)
                    OutlinedTextField(value = typed, onValueChange = { typed = it }, singleLine = true, label = { Text("Type DELETE to confirm") }, enabled = !pending, modifier = Modifier.fillMaxWidth())
                }
            },
            confirmButton = {
                TextButton(enabled = !pending && password.isNotEmpty() && typed == "DELETE", onClick = {
                    pending = true
                    model.deleteAccount(password) { failure -> pending = false; if (failure != null) error = failure }
                }) { Text(if (pending) "Deleting…" else "Delete forever", color = alpine.danger) }
            },
            dismissButton = { TextButton(enabled = !pending, onClick = { deleting = false }) { Text("Cancel") } },
        )
    }
}

/*
 * Reset sharing keys (was "Rotate keys"): when you'd use it and what changes, the
 * password, then the new phrase, which has no way out but saving it.
 */
@Composable
private fun ResetKeysScreen(model: DriveViewModel, onBack: () -> Unit) {
    val alpine = Alpine.colors
    var password by rememberSaveable { mutableStateOf("") }
    var pending by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    var phrase by rememberSaveable { mutableStateOf<String?>(null) }
    phrase?.let { made ->
        BackHandler {}
        PhraseScreen(model, fresh = made) { phrase = null; onBack() }
        return
    }
    AccountPage("Reset sharing keys", onBack = if (pending) null else onBack) {
        Column(Modifier.padding(horizontal = AlpineSpace.S4), verticalArrangement = Arrangement.spacedBy(AlpineSpace.S3)) {
            Text("Use this if you think someone saw your password or recovery phrase.", style = MaterialTheme.typography.bodyLarge)
            for (line in listOf("You get a new recovery phrase. The old one stops working.", "Your other devices are signed out.", "Your files, shares and links stay as they are."))
                Row { Text("•", modifier = Modifier.padding(end = AlpineSpace.S2)); Text(line, style = MaterialTheme.typography.bodyMedium, color = alpine.inkMuted) }
            PasswordField(password, { password = it; error = null }, "Password", error = error, enabled = !pending)
            Text("Enter your password to confirm.", style = MaterialTheme.typography.bodySmall, color = alpine.inkMuted)
            Button(enabled = !pending && password.isNotEmpty(), onClick = {
                pending = true
                model.rotateKeys(password) { made, failure -> pending = false; if (made != null) phrase = made else error = failure }
            }, modifier = Modifier.fillMaxWidth().height(48.dp)) { Text(if (pending) "Resetting…" else "Reset") }
        }
    }
}

/* After Delete account: a page that says so, instead of dropping silently to sign in. */
@Composable
fun AccountDeletedScreen(onDone: () -> Unit) {
    val alpine = Alpine.colors
    Column(Modifier.fillMaxSize().background(alpine.ground).padding(AlpineSpace.S6), verticalArrangement = Arrangement.Center) {
        Text("Your account is deleted", style = MaterialTheme.typography.headlineLarge)
        Text("Your files, shares, links and account are gone from HushOS. This can’t be undone.", style = MaterialTheme.typography.bodyLarge, color = alpine.inkMuted,
            modifier = Modifier.padding(top = AlpineSpace.S3, bottom = AlpineSpace.S6))
        Button(onClick = onDone, modifier = Modifier.fillMaxWidth().height(48.dp)) { Text("Done") }
    }
}
