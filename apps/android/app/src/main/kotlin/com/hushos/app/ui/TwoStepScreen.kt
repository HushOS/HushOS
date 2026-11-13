package com.hushos.app.ui

import android.content.ActivityNotFoundException
import android.content.Intent
import android.net.Uri
import androidx.activity.compose.BackHandler
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawingPadding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.selection.toggleable
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Block
import androidx.compose.material.icons.outlined.Pin
import androidx.compose.material.icons.outlined.Security
import androidx.compose.material.icons.outlined.Sync
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.retain.retain
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.autofill.ContentType
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentType
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.hushos.app.data.Problems
import com.hushos.app.data.SecurityEvent
import com.hushos.app.data.SetupTimedOut
import com.hushos.app.data.StepAnswer
import com.hushos.app.data.StepDraft
import com.hushos.app.data.StepOutcome
import com.hushos.app.data.StepPurpose
import com.hushos.app.data.StepUp
import com.hushos.app.data.StepWords
import com.hushos.app.data.TotpEnrolment
import com.hushos.app.data.TwoStep
import com.hushos.app.data.TwoStepStatus
import com.hushos.core.StepMethod
import com.hushos.tokens.AlpineSpace
import kotlinx.coroutines.launch
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter

/*
 * Two-step sign-in (docs/two-step-design.md 4 to 7), as the web has it: the step a sign-in stops at,
 * the step a security change asks for, and Account › Two-step sign-in, where it is turned on with an
 * authenticator app, its backup codes are shown once, the app is replaced or removed, new codes are
 * made, and the account's recent security activity is listed. Codes are checked on the server; the
 * recovery phrase is signed on this phone and never leaves it. The words are the web's and the
 * server's own.
 */

private val StepMethod.label: String get() = when (this) {
    StepMethod.TOTP -> "Code from your authenticator app"
    StepMethod.BACKUP -> "Backup code"
    StepMethod.PHRASE -> "Recovery phrase"
}

private val StepMethod.other: String get() = when (this) {
    StepMethod.TOTP -> "Use your authenticator app"
    StepMethod.BACKUP -> "Use a backup code"
    StepMethod.PHRASE -> "Use your recovery phrase"
}

private val StepMethod.hint: String get() = when (this) {
    StepMethod.TOTP -> "The 6-digit code. It changes every 30 seconds."
    StepMethod.BACKUP -> "One of the ten codes you saved. Each works once."
    StepMethod.PHRASE -> "All 24 words, in order. They stay on this device."
}

private val mono @Composable get() = MaterialTheme.typography.bodyLarge.copy(fontFamily = FontFamily.Monospace)

/*
 * The one field a step's answer is typed in (a code, filled from a password manager or a message; a
 * backup code; or the phrase), what is wrong with it or what to type under it, and the other ways
 * offered beneath in plain words.
 */
@Composable
internal fun StepFields(methods: List<StepMethod>, draft: StepDraft, onDraft: (StepDraft) -> Unit, problem: String, enabled: Boolean, focus: Boolean = false, offered: Boolean = true, onGo: (() -> Unit)? = null) {
    val alpine = Alpine.colors
    val method = draft.shown(methods)
    // Nothing this build knows was offered: update. The ways ran out after refusals: updating would not help.
    if (method == null) { Text(if (offered) StepWords.NO_WAY_LEFT else StepWords.CANNOT_ANSWER, color = alpine.danger, style = MaterialTheme.typography.bodyMedium); return }
    // The phrase on screen opens the account: out of screenshots, recordings and the recents preview, as it is everywhere else it is typed or shown.
    if (method == StepMethod.PHRASE) SecureWindow()
    val focusRequester = remember { FocusRequester() }
    if (focus) LaunchedEffect(method) { runCatching { focusRequester.requestFocus() } }
    val go = KeyboardActions(onGo = { onGo?.invoke() })
    val note: @Composable () -> Unit = {
        Column {
            if (method == StepMethod.PHRASE) StepDraft.words(draft.phrase).size.let { count ->
                Text("$count of 24 words", color = if (count == 24) alpine.success else alpine.inkMuted)
            }
            Text(problem.ifEmpty { method.hint })
        }
    }
    // What is typed here opens an account: the keyboard is asked not to learn it.
    NoKeyboardLearning {
        when (method) {
            StepMethod.TOTP -> OutlinedTextField(
                value = draft.totp, onValueChange = { typed -> onDraft(draft.copy(method = method, totp = typed.filter { it in '0'..'9' || it == ' ' }.take(7))) },
                label = { Text(method.label) }, placeholder = { Text("000000") }, singleLine = true, enabled = enabled, isError = problem.isNotEmpty(), supportingText = note,
                textStyle = mono.copy(letterSpacing = 3.sp),
                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.NumberPassword, imeAction = ImeAction.Go, autoCorrectEnabled = false), keyboardActions = go,
                modifier = Modifier.fillMaxWidth().focusRequester(focusRequester).semantics { contentType = ContentType.SmsOtpCode },
            )
            StepMethod.BACKUP -> OutlinedTextField(
                value = draft.backup, onValueChange = { typed -> onDraft(draft.copy(method = method, backup = typed.take(16))) },
                label = { Text(method.label) }, placeholder = { Text("XXXXX-XXXXX") }, singleLine = true, enabled = enabled, isError = problem.isNotEmpty(), supportingText = note,
                textStyle = mono.copy(letterSpacing = 1.sp),
                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Ascii, capitalization = KeyboardCapitalization.Characters, imeAction = ImeAction.Go, autoCorrectEnabled = false),
                keyboardActions = go, modifier = Modifier.fillMaxWidth().focusRequester(focusRequester),
            )
            StepMethod.PHRASE -> OutlinedTextField(
                value = draft.phrase, onValueChange = { typed -> onDraft(draft.copy(method = method, phrase = typed)) },
                label = { Text(method.label) }, minLines = 4, enabled = enabled, isError = problem.isNotEmpty(), supportingText = note, textStyle = mono,
                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Ascii, capitalization = KeyboardCapitalization.None, autoCorrectEnabled = false),
                modifier = Modifier.fillMaxWidth().focusRequester(focusRequester),
            )
        }
    }
    Column {
        for (other in methods.filter { it != method }) TextButton(enabled = enabled, onClick = { onDraft(draft.copy(method = other)) }) { Text(other.other) }
    }
}

/*
 * A change's step, for the forms: asked for when the form opens if the account has one, proved with
 * the change, and after a refusal either explained beside its field or asked for afresh. In memory
 * only: what is typed for a step never reaches saved state.
 */
internal class StepUpHolder(private val model: DriveViewModel, purpose: StepPurpose) {
    var step by mutableStateOf(StepUp(purpose))

    /* The form opened: an account with the step sees its fields from the start. Quiet when that can't be told; the change's own refusal asks then. */
    suspend fun prepare() {
        if (step.asked) return
        val status = model.twoStep { TwoStep.status(it) }.getOrNull() ?: return
        if (!status.on) return
        model.twoStep { TwoStep.challenge(it, step.purpose) }.getOrNull()?.let { step = step.take(it) }
    }

    /* What the change carries (null when no step is asked). `ready` is false when what was typed cannot be sent yet: the field says why. */
    fun prove(): Pair<Boolean, StepAnswer?> = when (val proof = step.prove()) {
        StepUp.Proof.None -> true to null
        is StepUp.Proof.Ready -> true to proof.answer
        is StepUp.Proof.Unready -> { step = proof.step; false to null }
    }

    /* After a failed change: null when the step's own fields say what happened, else the words for the form. */
    suspend fun failed(error: Throwable): String? {
        val (next, updated) = step.failed(error)
        step = updated
        return when (next) {
            StepUp.Next.NOT_STEP -> Problems.say(error, Problems.SERVER)
            StepUp.Next.AGAIN -> null
            StepUp.Next.RENEW -> model.twoStep { TwoStep.challenge(it, step.purpose) }.fold(
                { fresh -> step = step.take(fresh, keep = true); null },
                { Problems.say(it, Problems.SERVER) },
            )
        }
    }
}

/* The step's fields inside a form that changes the account: under the form's own fields, answered with the same press. */
@Composable
internal fun StepUpFields(holder: StepUpHolder, enabled: Boolean) {
    val step = holder.step
    if (!step.asked) return
    Text("Two-step sign-in is on, so this needs your second step too.", style = MaterialTheme.typography.bodyMedium, color = Alpine.colors.inkMuted)
    StepFields(step.methods, step.draft, { holder.step = step.typed(it) }, step.problem, enabled, offered = step.challenge?.methods?.isNotEmpty() == true)
}

/* MARK: Signing in */

/*
 * The second step of a sign-in: the password was right, and the account asks for a code, a backup
 * code or the recovery phrase before anything is handed over. A wrong answer stays here; a step
 * that is over goes back to the password with why (DriveViewModel.answerStep); a reply that never
 * arrived offers the same answer again. Nothing leaves the person on a screen that can no longer
 * be answered.
 */
@Composable
fun SignInStepScreen(model: DriveViewModel, challenge: com.hushos.core.StepChallenge) {
    val alpine = Alpine.colors
    // In memory only, and new for each step: saved state is written to disk when the process is put away.
    var methods by retain(challenge.token) { mutableStateOf(challenge.methods) }
    var draft by retain(challenge.token) { mutableStateOf(StepDraft.of(challenge.methods)) }
    // Held by the view model, with the request: a screen rebuilt while the answer is out still shows it, and sends no second one.
    val busy = model.stepBusy
    /* The field's own complaint. Retained, as what follows is: the answer's callback writes to them, and may come back to a rebuilt screen. */
    var fieldError by retain(challenge.token) { mutableStateOf("") }
    /* What the server, or a lost reply, said: above the field. */
    var notice by retain(challenge.token) { mutableStateOf("") }
    /* The last reply was lost: the same answer goes again. */
    var lost by retain(challenge.token) { mutableStateOf<StepAnswer?>(null) }
    val method = draft.shown(methods)

    fun submit() {
        if (busy || method == null) return
        val answer = lost ?: run {
            draft.problem(method)?.let { fieldError = it; return }
            try {
                draft.answer(challenge, method)
            } catch (error: Exception) {
                // A mistyped phrase, refused here before anything is sent.
                (StepOutcome.after(error, methods) as? StepOutcome.Again)?.let { fieldError = it.message }
                return
            }
        }
        fieldError = ""
        notice = ""
        model.answerStep(answer, methods) { outcome ->
            lost = null
            when (outcome) {
                is StepOutcome.Again -> { methods = outcome.methods; if (outcome.field) fieldError = outcome.message else notice = outcome.message }
                is StepOutcome.Retry -> { notice = outcome.message; lost = answer }
                // Over, or signed in: the view model has already moved on.
                is StepOutcome.Over, null -> {}
            }
        }
    }

    BackHandler(enabled = !busy) { model.cancelStep() }
    Column(
        Modifier.fillMaxSize().safeDrawingPadding().imePadding().verticalScroll(rememberScrollState()).padding(AlpineSpace.S6),
        verticalArrangement = Arrangement.spacedBy(AlpineSpace.S3),
    ) {
        Text("One more step", style = MaterialTheme.typography.headlineLarge)
        Text("This account has two-step sign-in on.", style = MaterialTheme.typography.bodyLarge, color = alpine.inkMuted)
        Spacer(Modifier.height(AlpineSpace.S2))
        if (notice.isNotEmpty()) Text(
            notice, color = alpine.warning, style = MaterialTheme.typography.bodyMedium,
            modifier = Modifier.fillMaxWidth().background(alpine.warningSoft, RoundedCornerShape(16.dp)).padding(horizontal = AlpineSpace.S4, vertical = AlpineSpace.S3),
        )
        StepFields(methods, draft, { draft = it; fieldError = ""; lost = null }, fieldError, enabled = !busy, focus = true, offered = challenge.methods.isNotEmpty(), onGo = ::submit)
        if (method != null) Button(onClick = ::submit, enabled = !busy, modifier = Modifier.fillMaxWidth().padding(top = AlpineSpace.S2).height(48.dp)) {
            Text(if (busy) "Checking" else if (lost == null) "Continue" else "Try again")
        }
        TextButton(onClick = { model.cancelStep() }, enabled = !busy, modifier = Modifier.align(Alignment.CenterHorizontally)) { Text("Start again") }
    }
}

/* MARK: Account › Two-step sign-in */

private enum class TwoStepPage { MAIN, ON, REPLACE, OFF, CODES }

/* "13 Nov", and the minute as the emails carry it: "13 Nov, 14:08". */
private fun day(iso: String?): String? = iso?.let {
    runCatching {
        DateTimeFormatter.ofPattern(android.text.format.DateFormat.getBestDateTimePattern(java.util.Locale.UK, "dMMM"), java.util.Locale.UK)
            .format(Instant.parse(it).atZone(ZoneId.systemDefault()))
    }.getOrNull()
}

private fun minute(context: android.content.Context, iso: String?): String? = iso?.let {
    runCatching {
        val at = Instant.parse(it).atZone(ZoneId.systemDefault())
        val clock = if (android.text.format.DateFormat.is24HourFormat(context)) "HH:mm" else "h:mm a"
        "${day(iso)}, ${DateTimeFormatter.ofPattern(clock).format(at)}"
    }.getOrNull()
}

@Composable
fun TwoStepScreen(model: DriveViewModel, state: DriveState, onBack: () -> Unit) {
    val alpine = Alpine.colors
    val context = LocalContext.current
    var page by rememberSaveable { mutableStateOf(TwoStepPage.MAIN) }
    var status by remember { mutableStateOf<TwoStepStatus?>(null) }
    var loaded by remember { mutableStateOf(false) }
    var problem by remember { mutableStateOf<String?>(null) }
    var events by remember { mutableStateOf<List<SecurityEvent>>(emptyList()) }
    var allEvents by rememberSaveable { mutableStateOf(false) }
    var attempt by remember { mutableStateOf(0) }
    val email = state.user?.email.orEmpty()

    val flow = model.twoStepFlow
    // Read again after every change, and whenever a reply was lost: nothing else says what the account now is.
    LaunchedEffect(attempt, flow.reread) {
        model.twoStep { TwoStep.status(it) }.fold(
            { next ->
                status = next; problem = null; loaded = true
                // The log is beside the settings, never instead of them: a failure there leaves it out.
                if (next != null) model.twoStep { TwoStep.securityEvents(it) }.getOrNull()?.let { events = it }
            },
            { failure -> if (failure !is com.hushos.app.data.NotAuthenticated) problem = Problems.say(failure, "Two-step sign-in couldn’t be loaded.") },
        )
    }
    fun open(next: TwoStepPage) { model.twoStepReset(); page = next }
    fun leave() { model.twoStepReset(); page = TwoStepPage.MAIN; attempt++ }
    fun finish(said: String) { if (said.isNotEmpty()) model.notify(said); leave() }
    // A change that has nothing more to show (the app replaced, a method removed) closes its page and says so.
    LaunchedEffect(flow.finished) { flow.finished?.let(::finish) }
    // Turning off with the reply lost, and the settings read again say it is off: the page has nothing left to turn off.
    LaunchedEffect(page, status?.on, flow.pending) {
        if (page == TwoStepPage.OFF && loaded && status?.on == false && !flow.pending) finish("Two-step sign-in is off.")
    }

    when (page) {
        TwoStepPage.ON, TwoStepPage.REPLACE -> { AuthenticatorScreen(model, replacing = page == TwoStepPage.REPLACE, email = email, onBack = ::leave, onDone = ::finish); return }
        TwoStepPage.OFF -> { TurnOffScreen(model, status?.app?.id ?: status?.methods?.firstOrNull()?.id, onBack = ::leave); return }
        TwoStepPage.CODES -> { NewCodesScreen(model, email, onBack = ::leave, onDone = ::finish); return }
        TwoStepPage.MAIN -> {}
    }
    AccountPage("Two-step sign-in", onBack) {
        Text("A second step stops someone who has your password from signing in. It doesn’t change how your files are encrypted.", style = MaterialTheme.typography.bodyMedium, color = alpine.inkMuted,
            modifier = Modifier.padding(horizontal = AlpineSpace.S4))
        val current = status
        when {
            problem != null -> Column(Modifier.padding(AlpineSpace.S4), verticalArrangement = Arrangement.spacedBy(AlpineSpace.S2)) {
                Text(problem.orEmpty(), color = alpine.danger)
                OutlinedButton(onClick = { attempt++ }) { Text("Try again") }
            }
            !loaded -> Box(Modifier.fillMaxWidth().padding(AlpineSpace.S8), contentAlignment = Alignment.Center) { CircularProgressIndicator() }
            current == null -> {}
            !current.on -> {
                Text("Off. Your password alone signs you in.", style = MaterialTheme.typography.bodyLarge, color = alpine.inkMuted,
                    modifier = Modifier.padding(horizontal = AlpineSpace.S4, vertical = AlpineSpace.S4))
                AccountRow("Turn on", null, Icons.Outlined.Security) { open(TwoStepPage.ON) }
            }
            else -> {
                Subheader("Authenticator app")
                for (method in current.methods) {
                    // The app is the section's own name; a kind added later (a security key) is listed by its name.
                    val paused = method.kind == "totp" && current.totpFrozen
                    Column(Modifier.fillMaxWidth().heightIn(min = 56.dp).padding(horizontal = AlpineSpace.S4, vertical = AlpineSpace.S2), verticalArrangement = Arrangement.Center) {
                        Row(horizontalArrangement = Arrangement.spacedBy(AlpineSpace.S2)) {
                            if (method.kind != "totp") Text(method.name ?: "Security key", style = MaterialTheme.typography.bodyLarge)
                            Text(if (paused) "Paused" else "On", style = MaterialTheme.typography.bodyLarge, fontWeight = FontWeight.SemiBold, color = if (paused) alpine.warning else alpine.ink)
                        }
                        val used = listOfNotNull(day(method.createdAt)?.let { "Added $it" }, day(method.lastUsedAt)?.let { "Last used $it" }).joinToString(" · ")
                        if (used.isNotEmpty()) Text(used, style = MaterialTheme.typography.bodyMedium, color = alpine.inkMuted)
                    }
                }
                if (current.totpFrozen) Text(
                    "Its codes are refused on devices HushOS doesn’t recognise, after many wrong ones. A backup code or your recovery phrase works there, and lifts the pause.",
                    style = MaterialTheme.typography.bodyMedium, color = alpine.inkMuted, modifier = Modifier.padding(horizontal = AlpineSpace.S4, vertical = AlpineSpace.S2),
                )
                if (current.app != null) AccountRow("Replace", null, Icons.Outlined.Sync) { open(TwoStepPage.REPLACE) }
                AccountRow("Turn off", null, Icons.Outlined.Block, danger = true) { open(TwoStepPage.OFF) }
                Subheader("Backup codes")
                Text(current.codesLeft, style = MaterialTheme.typography.bodyLarge, color = alpine.inkMuted, modifier = Modifier.padding(horizontal = AlpineSpace.S4, vertical = AlpineSpace.S2))
                AccountRow("New codes", null, Icons.Outlined.Pin) { open(TwoStepPage.CODES) }
            }
        }
        if (current != null && problem == null && events.isNotEmpty()) {
            Subheader("Recent security activity")
            for (event in if (allEvents) events else events.take(5)) {
                Column(Modifier.fillMaxWidth().heightIn(min = 56.dp).padding(horizontal = AlpineSpace.S4, vertical = AlpineSpace.S2), verticalArrangement = Arrangement.Center) {
                    Text(event.words, style = MaterialTheme.typography.bodyLarge)
                    val detail = listOfNotNull(event.device, minute(context, event.createdAt)).joinToString(" · ")
                    if (detail.isNotEmpty()) Text(detail, style = MaterialTheme.typography.bodyMedium, color = alpine.inkMuted)
                }
            }
            if (events.size > 5) TextButton(onClick = { allEvents = !allEvents }, modifier = Modifier.padding(horizontal = AlpineSpace.S2)) {
                Text(if (allEvents) "Show fewer" else "Show all ${events.size}")
            }
        }
    }
}

/* The password, asked again before any change to the step. */
@Composable
private fun ConfirmPassword(password: String, onChange: (String) -> Unit, tried: Boolean, enabled: Boolean) {
    PasswordField(password, onChange, "Password", error = if (tried && password.isEmpty()) "Enter your password." else null, hint = "Enter your password to confirm.", enabled = enabled)
}

@Composable
private fun FormBody(content: @Composable androidx.compose.foundation.layout.ColumnScope.() -> Unit) {
    Column(Modifier.padding(horizontal = AlpineSpace.S4), verticalArrangement = Arrangement.spacedBy(AlpineSpace.S3), content = content)
}

/* The ten codes, shown once: to copy, or to share to wherever the person keeps such things. */
@Composable
private fun BackupCodes(model: DriveViewModel, codes: List<String>, email: String) {
    val alpine = Alpine.colors
    val context = LocalContext.current
    // Out of screenshots, recordings and the recents preview, as the recovery phrase is.
    SecureWindow()
    Column(verticalArrangement = Arrangement.spacedBy(AlpineSpace.S2)) {
        codes.chunked(2).forEach { pair ->
            Row(horizontalArrangement = Arrangement.spacedBy(AlpineSpace.S2)) {
                for (code in pair) Text(
                    code, style = mono, maxLines = 1,
                    modifier = Modifier.weight(1f).background(alpine.surface, RoundedCornerShape(10.dp))
                        .then(if (alpine.high) Modifier.border(1.dp, alpine.edge, RoundedCornerShape(10.dp)) else Modifier)
                        .padding(horizontal = AlpineSpace.S3, vertical = AlpineSpace.S2),
                )
                if (pair.size == 1) Spacer(Modifier.weight(1f))
            }
        }
    }
    Text("Each code works once, when you can’t use your authenticator app. They aren’t shown again, so keep them somewhere apart from your password.",
        style = MaterialTheme.typography.bodySmall, color = alpine.inkMuted)
    Row(horizontalArrangement = Arrangement.spacedBy(AlpineSpace.S2)) {
        OutlinedButton(onClick = {
            // Marked sensitive and cleared two minutes later, as the recovery phrase's copy is (SensitiveClipboard).
            SensitiveClipboard.copy(context, "Backup codes", codes.joinToString("\n"))
            model.notify("Backup codes copied. Cleared from the clipboard in two minutes.")
        }) { Text("Copy") }
        OutlinedButton(onClick = {
            // Best effort, as a link's Send is: the clip marks the note sensitive for a share sheet that copies it, and a
            // copy of it left on the clipboard is cleared like our own. What the receiving app does with it is its own.
            val note = TwoStep.codesNote(codes, email)
            val send = Intent(Intent.ACTION_SEND).setType("text/plain").putExtra(Intent.EXTRA_TEXT, note).putExtra(Intent.EXTRA_SUBJECT, "HushOS backup codes")
                .apply { clipData = sensitiveClip("HushOS backup codes", note) }
            SensitiveClipboard.watch(context, note)
            context.startActivity(shareChooser(context, send, "Save your backup codes"))
        }) { Text("Share") }
    }
}

/*
 * Turning the step on, or replacing the app: the password (and the step, once it is on), the key to
 * add to an authenticator app, a code from the app to confirm, and, the first time, the backup codes.
 * The requests run in the view model, which keeps what they made (DriveViewModel.twoStepFlow): this
 * page only shows it, so it can be rebuilt at any moment without losing the key or the codes.
 */
@Composable
private fun AuthenticatorScreen(model: DriveViewModel, replacing: Boolean, email: String, onBack: () -> Unit, onDone: (String) -> Unit) {
    val alpine = Alpine.colors
    val context = LocalContext.current
    val holder = retain { StepUpHolder(model, StepPurpose.TWO_STEP) }
    val flow = model.twoStepFlow
    val pending = flow.pending
    // Passwords and the code stay in memory, never in saved state (which outlives the process on disk).
    var password by retain { mutableStateOf("") }
    var tried by remember { mutableStateOf(false) }
    /* This page's own complaint (no app opened the address); the view model's is the request's. */
    var local by remember { mutableStateOf<String?>(null) }
    val error = local ?: flow.error
    var code by retain { mutableStateOf("") }
    // How many other devices are signed in, for the words only: null until the list answers, or when it doesn't.
    var others by remember { mutableStateOf<Int?>(null) }
    var signOutOthers by rememberSaveable { mutableStateOf(true) }
    val codeReady = code.filterNot { it.isWhitespace() }.let { it.length == 6 && it.all { digit -> digit in '0'..'9' } }

    // Replacing needs the step from the start: its fields are there when the page opens.
    LaunchedEffect(Unit) { if (replacing) holder.prepare() else others = model.otherDevices() }
    // The setup ran out and went back to the start: the code typed for the old key goes with it.
    LaunchedEffect(flow.enrolment == null) { if (flow.enrolment == null) { code = ""; tried = false } }

    val made = flow.codes
    val enrolment = flow.enrolment
    when {
        made != null -> {
            // Shown once: no way out but Done.
            BackHandler {}
            AccountPage("Save your backup codes", onBack = null) {
                FormBody {
                    Text("Two-step sign-in is on.", style = MaterialTheme.typography.bodyLarge)
                    BackupCodes(model, made, email)
                    if (flow.removing) Text("Removing your other devices", style = MaterialTheme.typography.bodyMedium, color = alpine.inkMuted)
                    if (flow.notRemoved) Text(StepWords.OTHERS_NOT_REMOVED, style = MaterialTheme.typography.bodyMedium, color = alpine.danger)
                    Button(onClick = { onDone("Two-step sign-in is on.") }, modifier = Modifier.fillMaxWidth().height(48.dp)) { Text("Done") }
                }
            }
        }
        enrolment != null -> {
            // The key is a secret until the app is confirmed: out of screenshots and the recents preview.
            SecureWindow()
            BackHandler(enabled = !pending, onBack = onBack)
            AccountPage(if (replacing) "Add your new authenticator app" else "Add your authenticator app", onBack = if (pending) null else onBack) {
                FormBody {
                    Text("Add HushOS to your authenticator app, then enter the code it shows.", style = MaterialTheme.typography.bodyLarge)
                    enrolment.link?.let { link ->
                        OutlinedButton(onClick = {
                            try {
                                context.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(link)).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
                            } catch (missing: ActivityNotFoundException) {
                                local = "No authenticator app on this phone opened it. Type the key into your app instead."
                            }
                        }, modifier = Modifier.fillMaxWidth()) { Text("Open in authenticator app") }
                    }
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Column(Modifier.weight(1f)) {
                            Text("Or type this key into the app", style = MaterialTheme.typography.bodyMedium, color = alpine.inkMuted)
                            Text(enrolment.grouped, style = mono)
                        }
                        TextButton(onClick = {
                            SensitiveClipboard.copy(context, "Authenticator key", enrolment.secret)
                            model.notify("Key copied. Cleared from the clipboard in two minutes.")
                        }) { Text("Copy key") }
                    }
                    NoKeyboardLearning {
                        OutlinedTextField(
                            value = code, onValueChange = { typed -> code = typed.filter { it in '0'..'9' || it == ' ' }.take(7); local = null },
                            label = { Text("Code from your authenticator app") }, placeholder = { Text("000000") }, singleLine = true, enabled = !pending,
                            isError = tried && !codeReady, supportingText = if (tried && !codeReady) { { Text("Enter the 6-digit code the app shows.") } } else null,
                            textStyle = mono.copy(letterSpacing = 3.sp),
                            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.NumberPassword, autoCorrectEnabled = false),
                            modifier = Modifier.fillMaxWidth().semantics { contentType = ContentType.SmsOtpCode },
                        )
                    }
                    // Offered whenever the step is being turned on, whatever the device list said or didn't. Never when
                    // replacing the app: those devices have passed the step already.
                    if (!replacing) {
                        Row(Modifier.fillMaxWidth().toggleable(value = signOutOthers, enabled = !pending, role = Role.Switch) { signOutOthers = it }, verticalAlignment = Alignment.CenterVertically) {
                            Column(Modifier.weight(1f)) {
                                Text("Remove my other devices", style = MaterialTheme.typography.bodyLarge)
                                Text(TotpEnrolment.othersLine(others), style = MaterialTheme.typography.bodyMedium, color = alpine.inkMuted)
                            }
                            Switch(checked = signOutOthers, onCheckedChange = null, modifier = Modifier.padding(start = AlpineSpace.S3))
                        }
                    }
                    error?.let { Text(it, color = alpine.danger, style = MaterialTheme.typography.bodyMedium) }
                    Button(enabled = !pending, onClick = {
                        tried = true
                        if (!codeReady) return@Button
                        local = null
                        // The codes come first and are kept by the view model; the other devices are removed behind them, only
                        // when the step is being turned on with the box ticked (TwoStepFlow.removesOthers).
                        model.confirmAuthenticator(code, replacing, signOutOthers, password)
                    }, modifier = Modifier.fillMaxWidth().height(48.dp)) { Text(if (pending) "Checking" else if (replacing) "Replace app" else "Turn on") }
                }
            }
        }
        else -> {
            BackHandler(enabled = !pending, onBack = onBack)
            AccountPage(if (replacing) "Replace your authenticator app?" else "Turn on two-step sign-in?", onBack = if (pending) null else onBack) {
                FormBody {
                    Text(
                        if (replacing) "The new app takes over once you confirm it. Your backup codes stay as they are."
                        else "After your password, HushOS will ask for a code from an authenticator app on your phone. Your recovery phrase works as the second step too, so keep it apart from your password.",
                        style = MaterialTheme.typography.bodyLarge,
                    )
                    ConfirmPassword(password, { password = it; local = null }, tried, enabled = !pending)
                    StepUpFields(holder, enabled = !pending)
                    error?.let { Text(it, color = alpine.danger, style = MaterialTheme.typography.bodyMedium) }
                    Button(enabled = !pending, onClick = {
                        tried = true
                        if (password.isEmpty()) return@Button
                        val (ready, twoStep) = holder.prove()
                        if (!ready) return@Button
                        local = null
                        tried = false
                        model.startAuthenticator(password, twoStep, holder::failed)
                    }, modifier = Modifier.fillMaxWidth().height(48.dp)) { Text(if (pending) "Checking" else "Continue") }
                }
            }
        }
    }
}

/* Turning the step off is removing its last method: the password and the step itself. The page closes from the view model's answer (TwoStepFlow.finished). */
@Composable
private fun TurnOffScreen(model: DriveViewModel, methodId: String?, onBack: () -> Unit) {
    val alpine = Alpine.colors
    val holder = retain { StepUpHolder(model, StepPurpose.TWO_STEP) }
    val flow = model.twoStepFlow
    val pending = flow.pending
    var password by retain { mutableStateOf("") }
    var tried by remember { mutableStateOf(false) }
    LaunchedEffect(Unit) { holder.prepare() }
    BackHandler(enabled = !pending, onBack = onBack)
    AccountPage("Turn off two-step sign-in?", onBack = if (pending) null else onBack) {
        FormBody {
            Text("Your password alone will sign you in, and your backup codes will stop working.", style = MaterialTheme.typography.bodyLarge)
            ConfirmPassword(password, { password = it }, tried, enabled = !pending)
            StepUpFields(holder, enabled = !pending)
            flow.error?.let { Text(it, color = alpine.danger, style = MaterialTheme.typography.bodyMedium) }
            Button(
                enabled = !pending, colors = ButtonDefaults.buttonColors(containerColor = alpine.danger, contentColor = androidx.compose.ui.graphics.Color.White),
                onClick = {
                    tried = true
                    if (password.isEmpty() || methodId == null) return@Button
                    val (ready, twoStep) = holder.prove()
                    if (!ready) return@Button
                    // A reply that is lost says so here, and the settings behind this page are read again: they show whether the step is still on.
                    model.removeTwoStepMethod(methodId, password, twoStep, holder::failed)
                }, modifier = Modifier.fillMaxWidth().height(48.dp),
            ) { Text(if (pending) "Turning off" else "Turn off") }
        }
    }
}

/* A new set of ten, which replaces the old one: the password and the step, then the codes once. */
@Composable
private fun NewCodesScreen(model: DriveViewModel, email: String, onBack: () -> Unit, onDone: (String) -> Unit) {
    val alpine = Alpine.colors
    val holder = retain { StepUpHolder(model, StepPurpose.TWO_STEP) }
    val flow = model.twoStepFlow
    val pending = flow.pending
    var password by retain { mutableStateOf("") }
    var tried by remember { mutableStateOf(false) }
    LaunchedEffect(Unit) { holder.prepare() }
    val made = flow.codes
    // The password has done its work once the codes are here.
    LaunchedEffect(made != null) { if (made != null) password = "" }
    if (made != null) {
        BackHandler {}
        AccountPage("Save your new backup codes", onBack = null) {
            FormBody {
                Text("Your earlier codes no longer work.", style = MaterialTheme.typography.bodyLarge)
                BackupCodes(model, made, email)
                Button(onClick = { onDone("New backup codes made.") }, modifier = Modifier.fillMaxWidth().height(48.dp)) { Text("Done") }
            }
        }
        return
    }
    BackHandler(enabled = !pending, onBack = onBack)
    AccountPage("Make new backup codes?", onBack = if (pending) null else onBack) {
        FormBody {
            Text("You get ten new codes, and the ones you have now stop working.", style = MaterialTheme.typography.bodyLarge)
            ConfirmPassword(password, { password = it }, tried, enabled = !pending)
            StepUpFields(holder, enabled = !pending)
            flow.error?.let { Text(it, color = alpine.danger, style = MaterialTheme.typography.bodyMedium) }
            Button(enabled = !pending, onClick = {
                tried = true
                if (password.isEmpty()) return@Button
                val (ready, twoStep) = holder.prove()
                if (!ready) return@Button
                model.newBackupCodes(password, twoStep, holder::failed)
            }, modifier = Modifier.fillMaxWidth().height(48.dp)) { Text(if (pending) "Making" else "Make new codes") }
        }
    }
}
