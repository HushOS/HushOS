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
import androidx.compose.material.icons.outlined.Add
import androidx.compose.material.icons.outlined.Block
import androidx.compose.material.icons.outlined.CheckCircle
import androidx.compose.material.icons.outlined.Pin
import androidx.compose.material.icons.outlined.Sync
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
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
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentType
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.hushos.app.data.AppSetup
import com.hushos.app.data.KeyName
import com.hushos.app.data.KeySetup
import com.hushos.app.data.KeySheet
import com.hushos.app.data.Problems
import com.hushos.app.data.SecurityEvent
import com.hushos.app.data.SignInStep
import com.hushos.app.data.StepAnswer
import com.hushos.app.data.StepDraft
import com.hushos.app.data.StepNote
import com.hushos.app.data.StepPurpose
import com.hushos.app.data.StepUp
import com.hushos.app.data.StepWords
import com.hushos.app.data.TotpEnrolment
import com.hushos.app.data.TwoStep
import com.hushos.app.data.TwoStepStatus
import com.hushos.core.StepMethod
import com.hushos.tokens.AlpineSpace
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.launch
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter

/*
 * Two-step sign-in (docs/two-step-design.md 4 to 7), as the web has it: the step a sign-in stops at,
 * the step a security change asks for, and Account › Two-step sign-in, where it is turned on with a
 * passkey or security key or an authenticator app, its backup codes are shown once, methods are
 * added, named, replaced and removed, one kind is made the default, new codes are made, and the
 * account's recent security activity is listed. Codes are checked on the server; the recovery phrase
 * is signed on this phone and never leaves it; a passkey or security key answers through the
 * system's own sheet (`PasskeySheet`), which opens only on a press. The words are the web's and the
 * server's own.
 */

private val StepMethod.label: String get() = when (this) {
    StepMethod.WEBAUTHN -> "Passkey or security key"
    StepMethod.TOTP -> "Code from your authenticator app"
    StepMethod.BACKUP -> "Backup code"
    StepMethod.PHRASE -> "Recovery phrase"
}

private val StepMethod.other: String get() = when (this) {
    StepMethod.WEBAUTHN -> "Use your passkey or security key"
    StepMethod.TOTP -> "Use your authenticator app"
    StepMethod.BACKUP -> "Use a backup code"
    StepMethod.PHRASE -> "Use your recovery phrase"
}

private val StepMethod.hint: String get() = when (this) {
    StepMethod.WEBAUTHN -> "Your phone asks for it when you continue."
    StepMethod.TOTP -> "The 6-digit code. It changes every 30 seconds."
    StepMethod.BACKUP -> "One of the ten codes you saved. Each works once."
    StepMethod.PHRASE -> "All 24 words, in order. They stay on this device."
}

private val mono @Composable get() = MaterialTheme.typography.bodyLarge.copy(fontFamily = FontFamily.Monospace)

/*
 * What a step is answered with, one way at a time: the account's usual way first (the server's
 * order), the field its answer is typed in (a code, filled from a password manager or a message; a
 * backup code; or the phrase) with what is wrong with it or what to type beneath, and the other ways
 * behind one control. A passkey or security key has no field: the form's own button asks for it.
 * `note`: the one line above the fields when the server left something out (StepNote).
 */
@Composable
internal fun StepFields(
    methods: List<StepMethod>, draft: StepDraft, onDraft: (StepDraft) -> Unit, problem: String, enabled: Boolean,
    focus: Boolean = false, offered: Boolean = true, onGo: (() -> Unit)? = null, note: String = "",
) {
    val alpine = Alpine.colors
    val method = draft.shown(methods)
    // Nothing this build knows was offered: update. The ways ran out after refusals: updating would not help.
    if (method == null) { Text(if (offered) StepWords.NO_WAY_LEFT else StepWords.CANNOT_ANSWER, color = alpine.danger, style = MaterialTheme.typography.bodyMedium); return }
    // The phrase on screen opens the account: out of screenshots, recordings and the recents preview, as it is everywhere else it is typed or shown.
    if (method == StepMethod.PHRASE) SecureWindow()
    val focusRequester = remember { FocusRequester() }
    if (focus && method != StepMethod.WEBAUTHN) LaunchedEffect(method) { runCatching { focusRequester.requestFocus() } }
    val go = KeyboardActions(onGo = { onGo?.invoke() })
    val fieldNote: @Composable () -> Unit = {
        Column {
            if (method == StepMethod.PHRASE) StepDraft.words(draft.phrase).size.let { count ->
                Text("$count of 24 words", color = if (count == 24) alpine.success else alpine.inkMuted)
            }
            Text(problem.ifEmpty { method.hint })
        }
    }
    if (note.isNotEmpty()) Text(note, style = MaterialTheme.typography.bodyMedium, color = alpine.inkMuted)
    // What is typed here opens an account: the keyboard is asked not to learn it.
    NoKeyboardLearning {
        when (method) {
            // No field, and nothing asked yet: the phone's sheet opens when the form's button is pressed.
            StepMethod.WEBAUTHN -> Column(verticalArrangement = Arrangement.spacedBy(AlpineSpace.S1)) {
                FieldLabel(method.label)
                Text(
                    problem.ifEmpty { method.hint }, style = MaterialTheme.typography.bodyMedium, color = if (problem.isEmpty()) alpine.inkMuted else alpine.danger,
                    // A key that wasn't used is said aloud: nothing else on the screen changed.
                    modifier = if (problem.isEmpty()) Modifier else Modifier.semantics { liveRegion = LiveRegionMode.Polite },
                )
            }
            StepMethod.TOTP -> OutlinedTextField(
                value = draft.totp, onValueChange = { typed -> onDraft(draft.copy(method = method, totp = typed.filter { it in '0'..'9' || it == ' ' }.take(7))) },
                label = { Text(method.label) }, placeholder = { Text("000000") }, singleLine = true, enabled = enabled, isError = problem.isNotEmpty(), supportingText = fieldNote,
                textStyle = mono.copy(letterSpacing = 3.sp),
                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.NumberPassword, imeAction = ImeAction.Go, autoCorrectEnabled = false), keyboardActions = go,
                modifier = Modifier.fillMaxWidth().focusRequester(focusRequester).semantics { contentType = ContentType.SmsOtpCode },
            )
            StepMethod.BACKUP -> OutlinedTextField(
                value = draft.backup, onValueChange = { typed -> onDraft(draft.copy(method = method, backup = typed.take(16))) },
                label = { Text(method.label) }, placeholder = { Text("XXXXX-XXXXX") }, singleLine = true, enabled = enabled, isError = problem.isNotEmpty(), supportingText = fieldNote,
                textStyle = mono.copy(letterSpacing = 1.sp),
                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Ascii, capitalization = KeyboardCapitalization.Characters, imeAction = ImeAction.Go, autoCorrectEnabled = false),
                keyboardActions = go, modifier = Modifier.fillMaxWidth().focusRequester(focusRequester),
            )
            StepMethod.PHRASE -> OutlinedTextField(
                value = draft.phrase, onValueChange = { typed -> onDraft(draft.copy(method = method, phrase = typed)) },
                label = { Text(method.label) }, minLines = 4, enabled = enabled, isError = problem.isNotEmpty(), supportingText = fieldNote, textStyle = mono,
                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Ascii, capitalization = KeyboardCapitalization.None, autoCorrectEnabled = false),
                modifier = Modifier.fillMaxWidth().focusRequester(focusRequester),
            )
        }
    }
    // The other ways, in the server's order, behind one control: a menu, as the platform offers a choice.
    val others = methods.filter { it != method }
    if (others.isNotEmpty()) Box {
        var choosing by remember { mutableStateOf(false) }
        TextButton(enabled = enabled, onClick = { choosing = true }) { Text("Use another way") }
        DropdownMenu(expanded = choosing, onDismissRequest = { choosing = false }) {
            for (other in others) DropdownMenuItem(text = { Text(other.other) }, onClick = { choosing = false; onDraft(draft.copy(method = other)) })
        }
    }
}

/*
 * A change's step, for the forms: asked for when the form opens if the account has one, proved with
 * the change, and after a refusal either explained beside its field or asked for afresh. In memory
 * only: what is typed for a step never reaches saved state.
 */
internal class StepUpHolder(private val model: DriveViewModel, purpose: StepPurpose) {
    var step by mutableStateOf(StepUp(purpose))

    /* The phone's sheet is up for this step's key: the form waits for it, and sends nothing meanwhile. */
    var asking by mutableStateOf(false)
        private set

    /* The one line above the step's fields, when the server left something out. */
    val note: String get() = step.challenge?.let { StepNote.of(it, model.passkeys, change = true) }.orEmpty()

    /* The form opened: an account with the step sees its fields from the start. Quiet when that can't be told; the change's own refusal asks then. */
    suspend fun prepare() {
        if (step.asked) return
        val status = model.twoStep { TwoStep.status(it) }.getOrNull() ?: return
        if (!status.on) return
        model.stepChallenge(step.purpose).getOrNull()?.let { step = step.take(it) }
    }

    /*
     * What the change carries (null when no step is asked). `ready` is false when it cannot be sent yet: what was typed
     * is not ready, or the key did not answer, and the field says why. A passkey or security key is asked here, by the
     * press that makes the change, through `sheet`.
     */
    suspend fun prove(sheet: KeySheet): Pair<Boolean, StepAnswer?> {
        if (asking) return false to null
        asking = true
        try {
            return when (val proof = step.prove(sheet)) {
                StepUp.Proof.None -> true to null
                is StepUp.Proof.Ready -> true to proof.answer
                is StepUp.Proof.Unready -> { step = proof.step; false to null }
            }
        } finally {
            asking = false
        }
    }

    /* After a failed change: null when the step's own fields say what happened, else the words for the form. */
    suspend fun failed(error: Throwable): String? {
        val (next, updated) = step.failed(error)
        step = updated
        return when (next) {
            StepUp.Next.NOT_STEP -> Problems.say(error, Problems.SERVER)
            StepUp.Next.AGAIN -> null
            StepUp.Next.RENEW -> model.stepChallenge(step.purpose).fold(
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
    StepFields(step.methods, step.draft, { holder.step = step.typed(it) }, step.problem, enabled && !holder.asking, offered = step.challenge?.methods?.isNotEmpty() == true, note = holder.note)
}

/*
 * A form's press that may carry the step: started at once (a second press finds the first under way), and suspended
 * only while the phone's sheet is up for a key. `send` runs with the step's answer once there is one to send.
 */
internal fun kotlinx.coroutines.CoroutineScope.withStep(holder: StepUpHolder, sheet: KeySheet, send: (StepAnswer?) -> Unit) {
    launch(start = CoroutineStart.UNDISPATCHED) {
        val (ready, twoStep) = holder.prove(sheet)
        if (ready) send(twoStep)
    }
}

/* MARK: Signing in */

/*
 * The second step of a sign-in: the password was right, and the account asks for its passkey or
 * security key, a code, a backup code or the recovery phrase before anything is handed over. It opens
 * on the account's usual way, with the rest behind Use another way. A wrong answer stays here; a step
 * that is over goes back to the password with why (DriveViewModel.answerStep); a reply that never
 * arrived offers the same answer again. Nothing leaves the person on a screen that can no longer be
 * answered. What the screen holds and does with a press is `SignInStep`, tested away from it.
 */
@Composable
fun SignInStepScreen(model: DriveViewModel, challenge: com.hushos.core.StepChallenge) {
    val alpine = Alpine.colors
    // In memory only, and new for each step: saved state is written to disk when the process is put away. Retained:
    // the answer's callback writes to it, and may come back to a rebuilt screen.
    var step by retain(challenge.token) { mutableStateOf(SignInStep(challenge)) }
    // Held by the view model, with the request: a screen rebuilt while the answer is out still shows it, and sends no second one.
    val busy = model.stepBusy
    // The system's sheet for a key. Having it asks nothing: only the press below does.
    val sheet = rememberKeySheet()
    val scope = rememberCoroutineScope()
    /* The phone's sheet is up. This screen's own: one rebuilt meanwhile has left the sheet, and nothing was sent. */
    var asking by remember(challenge.token) { mutableStateOf(false) }
    val method = step.shown

    fun submit() {
        if (busy || asking || method == null) return
        asking = true
        scope.launch(start = CoroutineStart.UNDISPATCHED) {
            try {
                when (val pressed = step.pressed(sheet)) {
                    is SignInStep.Pressed.Stay -> step = pressed.step
                    is SignInStep.Pressed.Send -> {
                        step = pressed.step
                        model.answerStep(pressed.answer, pressed.step.methods) { outcome -> step = step.after(outcome, pressed.answer) }
                    }
                }
            } finally {
                asking = false
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
        if (step.notice.isNotEmpty()) Text(
            step.notice, color = alpine.warning, style = MaterialTheme.typography.bodyMedium,
            modifier = Modifier.fillMaxWidth().background(alpine.warningSoft, RoundedCornerShape(16.dp)).padding(horizontal = AlpineSpace.S4, vertical = AlpineSpace.S3),
        )
        StepFields(
            step.methods, step.draft, { step = step.typed(it) }, step.fieldError, enabled = !busy && !asking, focus = true, offered = challenge.methods.isNotEmpty(), onGo = ::submit,
            note = StepNote.of(challenge, model.passkeys, change = false),
        )
        if (method != null) Button(onClick = ::submit, enabled = !busy && !asking, modifier = Modifier.fillMaxWidth().padding(top = AlpineSpace.S2).height(48.dp)) {
            Text(step.button(busy))
        }
        TextButton(onClick = { model.cancelStep() }, enabled = !busy, modifier = Modifier.align(Alignment.CenterHorizontally)) { Text("Start again") }
    }
}

/* MARK: Account › Two-step sign-in */

private enum class TwoStepPage { MAIN, ON, REPLACE, ADD_APP, KEY, REMOVE, CODES }

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

/* The kind asked for first, in a word on a quiet fill beside its heading. */
@Composable
private fun DefaultBadge() {
    val alpine = Alpine.colors
    Text("Default", style = MaterialTheme.typography.labelSmall, color = alpine.ink, maxLines = 1,
        modifier = Modifier.padding(end = AlpineSpace.S3).background(alpine.fill, RoundedCornerShape(4.dp)).padding(horizontal = 6.dp, vertical = 1.dp))
}

/* A label and what it is now, on one row: the label at the start, the value at the end. */
@Composable
private fun SettingValue(label: String, value: String) {
    val alpine = Alpine.colors
    Row(Modifier.fillMaxWidth().heightIn(min = 56.dp).padding(horizontal = AlpineSpace.S4, vertical = AlpineSpace.S2).semantics(mergeDescendants = true) {},
        verticalAlignment = Alignment.CenterVertically) {
        Text(label, style = MaterialTheme.typography.bodyLarge, color = alpine.ink, modifier = Modifier.weight(1f))
        Text(value, style = MaterialTheme.typography.bodyLarge, color = alpine.inkMuted)
    }
}

/* A line of the settings: what is so, said plainly under its heading. */
@Composable
private fun SettingLine(text: String, danger: Boolean = false, strong: Boolean = false, warning: Boolean = false) {
    val alpine = Alpine.colors
    Text(text, style = MaterialTheme.typography.bodyLarge, fontWeight = if (strong || warning) FontWeight.SemiBold else null,
        color = if (danger) alpine.danger else if (warning) alpine.warning else if (strong) alpine.ink else alpine.inkMuted,
        modifier = Modifier.padding(horizontal = AlpineSpace.S4, vertical = AlpineSpace.S2))
}

/* One key: its name, where it lives and when it was added and last used, and its two actions, as a device's row has them. */
@Composable
private fun KeyRow(method: TwoStepStatus.Method, removeWords: String, onRename: () -> Unit, onRemove: () -> Unit) {
    val alpine = Alpine.colors
    Row(Modifier.fillMaxWidth().heightIn(min = 56.dp).padding(start = AlpineSpace.S4, end = AlpineSpace.S2, top = AlpineSpace.S2, bottom = AlpineSpace.S2),
        verticalAlignment = Alignment.CenterVertically) {
        Column(Modifier.weight(1f)) {
            Text(method.shownName, style = MaterialTheme.typography.bodyLarge, color = alpine.ink)
            val detail = method.detail(::day)
            if (detail.isNotEmpty()) Text(detail, style = MaterialTheme.typography.bodyMedium, color = alpine.inkMuted)
        }
        TextButton(onClick = onRename) { Text("Rename") }
        TextButton(onClick = onRemove) { Text(removeWords, color = alpine.danger) }
    }
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
    /*
     * The method a removal page was opened for, and whether it was the account's only one (then it is Turn off).
     * Retained, as the page's password is: a rotation or a fold keeps the page; a process put away does not.
     */
    var removing by retain { mutableStateOf<Pair<TwoStepStatus.Method, Boolean>?>(null) }
    /* Whether the key being added is the account's first method: it turns the step on. Decided when its page opens. */
    var keyFirst by rememberSaveable { mutableStateOf(false) }
    var renaming by retain { mutableStateOf<TwoStepStatus.Method?>(null) }
    /* Changing which kind is asked first: under way, and what the server said if it refused. */
    var moving by remember { mutableStateOf(false) }
    var moveProblem by remember { mutableStateOf<String?>(null) }
    val email = state.user?.email.orEmpty()
    // Whether this phone can use a passkey or security key for this server: only then is there an Add.
    val passkeys = model.passkeys

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
    fun open(next: TwoStepPage) { model.twoStepReset(); moveProblem = null; page = next }
    fun leave() { model.twoStepReset(); page = TwoStepPage.MAIN; removing = null; attempt++ }
    fun finish(said: String) { if (said.isNotEmpty()) model.notify(said); leave() }
    // A change that has nothing more to show (the app replaced, a method added or removed) closes its page and says so.
    LaunchedEffect(flow.finished) { flow.finished?.let(::finish) }
    // A removal page with nothing left to remove. Its reply was lost and the settings, read again, say the step is off
    // or the method is gone; or the page came back from saved state without the method it was opened for.
    LaunchedEffect(page, status, flow.pending, removing) {
        if (page != TwoStepPage.REMOVE || flow.pending) return@LaunchedEffect
        val target = removing?.first
        when {
            target == null -> leave()
            !loaded -> {}
            status?.on == false -> finish("Two-step sign-in is off.")
            status?.methods?.none { it.id == target.id } == true -> finish(if (target.isApp) "Authenticator app removed." else "Passkey or security key removed.")
        }
    }

    // Backup codes nobody has seen yet come before everything else here, whichever page asked for them and wherever
    // the person went while the request was out: the server has made them, and they are shown nowhere else.
    flow.codes?.let { made ->
        // The codes' screen has said it (the step is on; the earlier codes no longer work): closing it says nothing more.
        CodesScreen(model, flow, made, email) {
            model.twoStepCodesSeen()
            page = TwoStepPage.MAIN
        }
        return
    }
    when (page) {
        TwoStepPage.ON -> { AuthenticatorScreen(model, AppSetup.ON, onBack = ::leave); return }
        TwoStepPage.REPLACE -> { AuthenticatorScreen(model, AppSetup.REPLACE, onBack = ::leave); return }
        TwoStepPage.ADD_APP -> { AuthenticatorScreen(model, AppSetup.ADD, onBack = ::leave); return }
        TwoStepPage.KEY -> { KeyScreen(model, first = keyFirst, onBack = ::leave); return }
        TwoStepPage.REMOVE -> removing?.let { (method, last) -> RemoveScreen(model, method, last, onBack = ::leave); return }
        TwoStepPage.CODES -> { NewCodesScreen(model, onBack = ::leave); return }
        TwoStepPage.MAIN -> {}
    }
    AccountPage("Two-step sign-in", onBack) {
        val current = status
        when {
            problem != null -> Column(Modifier.padding(AlpineSpace.S4), verticalArrangement = Arrangement.spacedBy(AlpineSpace.S2)) {
                Text(problem.orEmpty(), color = alpine.danger)
                OutlinedButton(onClick = { attempt++ }) { Text("Try again") }
            }
            !loaded -> Box(Modifier.fillMaxWidth().padding(AlpineSpace.S8), contentAlignment = Alignment.Center) { CircularProgressIndicator() }
            current == null -> {}
            else -> {
                fun remove(method: TwoStepStatus.Method) { removing = method to current.last(method); open(TwoStepPage.REMOVE) }
                fun makeDefault(kind: String) {
                    if (moving) return
                    moving = true
                    moveProblem = null
                    model.makeTwoStepDefault(kind) { failure ->
                        moving = false
                        moveProblem = failure
                        if (failure == null) model.notify(TwoStepStatus.defaultSaid(kind))
                    }
                }
                // The state, once: one row, its value at the end.
                SettingValue("Status", if (current.on) "On" else "Off")
                moveProblem?.let { SettingLine(it, danger = true) }

                Subheader(TwoStepStatus.kindWords(TwoStepStatus.WEBAUTHN)) { if (current.isDefault(TwoStepStatus.WEBAUTHN)) DefaultBadge() }
                val keys = current.keys
                if (keys.isEmpty()) SettingLine("Not added")
                for (key in keys) KeyRow(key, current.removeWords(key), onRename = { renaming = key }, onRemove = { remove(key) })
                // Only where this phone can use one for this server; elsewhere the note below says where they are added.
                // "Add another" once there is a key: the row adds to the list, and is not an action on the key above it.
                if (current.canAddKey(passkeys))
                    AccountRow(current.addKeyWords, null, Icons.Outlined.Add, label = if (keys.isEmpty()) "Add passkey or security key" else "Add another passkey or security key") {
                        keyFirst = !current.on; open(TwoStepPage.KEY)
                    }
                if (current.canMakeDefault(TwoStepStatus.WEBAUTHN))
                    AccountRow("Make default", null, Icons.Outlined.CheckCircle, label = "Make passkey or security key the default") { makeDefault(TwoStepStatus.WEBAUTHN) }
                for (line in current.keyNotes(passkeys))
                    Text(line, style = MaterialTheme.typography.bodyMedium, color = alpine.inkMuted, modifier = Modifier.padding(horizontal = AlpineSpace.S4, vertical = AlpineSpace.S1))

                Subheader(TwoStepStatus.kindWords(TwoStepStatus.TOTP)) { if (current.isDefault(TwoStepStatus.TOTP)) DefaultBadge() }
                val app = current.app
                if (app == null) {
                    SettingLine("Not added")
                    // The account's first method turns the step on; beside keys it is one more way to pass it.
                    AccountRow("Add", null, Icons.Outlined.Add, label = "Add authenticator app") { open(if (current.on) TwoStepPage.ADD_APP else TwoStepPage.ON) }
                } else {
                    Column(Modifier.fillMaxWidth().heightIn(min = 56.dp).padding(horizontal = AlpineSpace.S4, vertical = AlpineSpace.S2), verticalArrangement = Arrangement.Center) {
                        if (current.totpFrozen) Text("Paused", style = MaterialTheme.typography.bodyLarge, fontWeight = FontWeight.SemiBold, color = alpine.warning)
                        val used = app.latest(::day)
                        if (used.isNotEmpty()) Text(used, style = if (current.totpFrozen) MaterialTheme.typography.bodyMedium else MaterialTheme.typography.bodyLarge, color = alpine.inkMuted)
                    }
                    if (current.totpFrozen) Text(
                        "A backup code or your recovery phrase lifts the pause.",
                        style = MaterialTheme.typography.bodyMedium, color = alpine.inkMuted, modifier = Modifier.padding(horizontal = AlpineSpace.S4, vertical = AlpineSpace.S2),
                    )
                    AccountRow("Replace", null, Icons.Outlined.Sync, label = "Replace authenticator app") { open(TwoStepPage.REPLACE) }
                    if (current.canMakeDefault(TwoStepStatus.TOTP))
                        AccountRow("Make default", null, Icons.Outlined.CheckCircle, label = "Make authenticator app the default") { makeDefault(TwoStepStatus.TOTP) }
                    AccountRow(current.removeWords(app), null, Icons.Outlined.Block, danger = true, label = "${current.removeWords(app)} authenticator app") { remove(app) }
                }
                if (current.on) {
                    Subheader("Backup codes")
                    SettingLine(current.codesLeft, warning = current.codesLow)
                    AccountRow("New codes", null, Icons.Outlined.Pin) { open(TwoStepPage.CODES) }
                }
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

    renaming?.let { key -> RenameKeyDialog(model, key) { renaming = null } }
}

/*
 * A key's name: shown in this list only. No password: any session of the account may change it, and the server
 * checks the name again, in its own words.
 */
@Composable
private fun RenameKeyDialog(model: DriveViewModel, key: TwoStepStatus.Method, onClose: () -> Unit) {
    var name by remember(key.id) { mutableStateOf(key.name.orEmpty()) }
    var error by remember(key.id) { mutableStateOf<String?>(null) }
    var saving by remember(key.id) { mutableStateOf(false) }
    AlertDialog(
        onDismissRequest = { if (!saving) onClose() },
        title = { Text("Rename passkey or security key") },
        text = {
            Column {
                Text("Names aren’t encrypted.", modifier = Modifier.padding(bottom = AlpineSpace.S3))
                OutlinedTextField(value = name, onValueChange = { name = it; error = null }, singleLine = true, label = { Text("Name") }, enabled = !saving,
                    isError = error != null, supportingText = error?.let { { Text(it) } })
            }
        },
        confirmButton = {
            TextButton(enabled = !saving, onClick = {
                KeyName.problem(name)?.let { error = it; return@TextButton }
                saving = true
                model.renameTwoStepMethod(key.id, name.trim()) { failure ->
                    saving = false
                    if (failure == null) onClose() else error = failure
                }
            }) { Text(if (saving) "Saving" else "Save name") }
        },
        dismissButton = { TextButton(enabled = !saving, onClick = onClose) { Text("Cancel") } },
    )
}

/* The password, asked again before any change to the step. */
@Composable
private fun ConfirmPassword(password: String, onChange: (String) -> Unit, tried: Boolean, enabled: Boolean) {
    PasswordField(password, onChange, "Password", error = if (tried && password.isEmpty()) "Enter your password." else null, enabled = enabled)
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
    Text("Each code works once. They aren’t shown again.",
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

/* "Remove my other devices", offered (ticked) whenever a method turns the step on: those devices signed in without it. */
@Composable
private fun OthersOffer(checked: Boolean, onChange: (Boolean) -> Unit, others: Int?, enabled: Boolean) {
    Row(Modifier.fillMaxWidth().toggleable(value = checked, enabled = enabled, role = Role.Switch, onValueChange = onChange), verticalAlignment = Alignment.CenterVertically) {
        Column(Modifier.weight(1f)) {
            Text("Remove my other devices", style = MaterialTheme.typography.bodyLarge)
            Text(TotpEnrolment.othersLine(others), style = MaterialTheme.typography.bodyMedium, color = Alpine.colors.inkMuted)
        }
        Switch(checked = checked, onCheckedChange = null, modifier = Modifier.padding(start = AlpineSpace.S3))
    }
}

/*
 * An authenticator app: turning the step on with one, replacing the one the account has, or adding
 * one beside its passkeys and security keys (`setup`). The password (and the step, once it is on),
 * the key to add to the app, a code from the app to confirm, and, when it turned the step on, the
 * backup codes. The requests run in the view model, which keeps what they made
 * (DriveViewModel.twoStepFlow): this page only shows it, so it can be rebuilt at any moment without
 * losing the key or the codes.
 */
@Composable
private fun AuthenticatorScreen(model: DriveViewModel, setup: AppSetup, onBack: () -> Unit) {
    val alpine = Alpine.colors
    val context = LocalContext.current
    val holder = retain { StepUpHolder(model, StepPurpose.TWO_STEP) }
    val sheet = rememberKeySheet()
    val scope = rememberCoroutineScope()
    val replacing = setup == AppSetup.REPLACE
    val first = setup == AppSetup.ON
    val flow = model.twoStepFlow
    val pending = flow.pending || holder.asking
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

    // Once the step is on, a change to it needs the step from the start: its fields are there when the page opens.
    LaunchedEffect(Unit) { if (first) others = model.otherDevices() else holder.prepare() }
    // The setup ran out and went back to the start: the code typed for the old key goes with it.
    LaunchedEffect(flow.enrolment == null) { if (flow.enrolment == null) { code = ""; tried = false } }

    val enrolment = flow.enrolment
    // Back is held while a request is out, not let through to the page behind: its answer (the key, the codes) is shown once.
    BackHandler { if (!pending) onBack() }
    when {
        enrolment != null -> {
            // The key is a secret until the app is confirmed: out of screenshots and the recents preview.
            SecureWindow()
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
                    // replacing the app or adding one beside a key: those devices have passed the step already.
                    if (first) OthersOffer(signOutOthers, { signOutOthers = it }, others, enabled = !pending)
                    error?.let { Text(it, color = alpine.danger, style = MaterialTheme.typography.bodyMedium) }
                    Button(enabled = !pending, onClick = {
                        tried = true
                        if (!codeReady) return@Button
                        local = null
                        // The codes come first and are kept by the view model; the other devices are removed behind them, only
                        // when the step is being turned on with the box ticked (TwoStepFlow.removesOthers).
                        model.confirmAuthenticator(code, setup, signOutOthers, password)
                    }, modifier = Modifier.fillMaxWidth().height(48.dp)) {
                        Text(if (pending) "Checking" else when (setup) { AppSetup.ON -> "Turn on"; AppSetup.REPLACE -> "Replace app"; AppSetup.ADD -> "Add app" })
                    }
                }
            }
        }
        else -> {
            val title = when (setup) { AppSetup.ON -> "Turn on two-step sign-in?"; AppSetup.REPLACE -> "Replace your authenticator app?"; AppSetup.ADD -> "Add an authenticator app?" }
            AccountPage(title, onBack = if (pending) null else onBack) {
                FormBody {
                    // Adding an app beside a key has no opening words: its title says it.
                    when (setup) {
                        AppSetup.ON -> "After your password, HushOS will ask for a code from an authenticator app."
                        AppSetup.REPLACE -> "The new app takes over once you confirm it."
                        AppSetup.ADD -> null
                    }?.let { Text(it, style = MaterialTheme.typography.bodyLarge) }
                    ConfirmPassword(password, { password = it; local = null }, tried, enabled = !pending)
                    StepUpFields(holder, enabled = !pending)
                    error?.let { Text(it, color = alpine.danger, style = MaterialTheme.typography.bodyMedium) }
                    Button(enabled = !pending, onClick = {
                        tried = true
                        if (password.isEmpty()) return@Button
                        // A passkey or security key, when it is the step's way, is asked by this press.
                        scope.withStep(holder, sheet) { twoStep ->
                            local = null
                            tried = false
                            model.startAuthenticator(password, twoStep, holder::failed)
                        }
                    }, modifier = Modifier.fillMaxWidth().height(48.dp)) { Text(if (flow.pending) "Checking" else "Continue") }
                }
            }
        }
    }
}

/*
 * A passkey or security key (docs/two-step-design.md 3, 12). First the password (and the step, once it
 * is on); then the key itself, with a name for it if the person wants one. The phone's sheet opens on
 * the press that adds it, never before. A closed sheet sends nothing and the same setup stands; anything
 * the server answers ends the setup (a registration is good for one answer) and goes back to the
 * password with its words. `first`: the account has no method yet, so this key turns the step on, with
 * the backup codes and the offer to remove the other devices, exactly as the authenticator app does.
 */
@Composable
private fun KeyScreen(model: DriveViewModel, first: Boolean, onBack: () -> Unit) {
    val alpine = Alpine.colors
    val holder = retain { StepUpHolder(model, StepPurpose.TWO_STEP) }
    val sheet = rememberKeySheet()
    val scope = rememberCoroutineScope()
    val flow = model.twoStepFlow
    // Passwords stay in memory, never in saved state (which outlives the process on disk).
    var password by retain { mutableStateOf("") }
    var tried by remember { mutableStateOf(false) }
    /* This page's own complaint (the sheet was closed, a name too long); the view model's is the request's. */
    var local by remember { mutableStateOf<String?>(null) }
    val error = local ?: flow.error
    var name by rememberSaveable { mutableStateOf("") }
    var others by remember { mutableStateOf<Int?>(null) }
    var signOutOthers by rememberSaveable { mutableStateOf(true) }
    /* The phone's sheet is up for the new key. */
    var waiting by remember { mutableStateOf(false) }
    val pending = flow.pending || waiting || holder.asking

    LaunchedEffect(Unit) { if (first) others = model.otherDevices() else holder.prepare() }

    val creation = flow.creation
    // Back is held while a request is out or the sheet is up, not let through to the page behind.
    BackHandler { if (!pending) onBack() }
    if (creation != null) {
        AccountPage("Add your passkey or security key", onBack = if (pending) null else onBack) {
            FormBody {
                Text("Your phone will ask for it.", style = MaterialTheme.typography.bodyLarge)
                OutlinedTextField(
                    value = name, onValueChange = { name = it; local = null }, label = { Text("Name") }, placeholder = { Text("Security key") }, singleLine = true, enabled = !pending,
                    supportingText = { Text("Optional. Names aren’t encrypted.") },
                    keyboardOptions = KeyboardOptions(capitalization = KeyboardCapitalization.Sentences), modifier = Modifier.fillMaxWidth(),
                )
                if (first) OthersOffer(signOutOthers, { signOutOthers = it }, others, enabled = !pending)
                error?.let { Text(it, color = alpine.danger, style = MaterialTheme.typography.bodyMedium, modifier = Modifier.semantics { liveRegion = LiveRegionMode.Polite }) }
                Button(enabled = !pending, onClick = {
                    local = null
                    waiting = true
                    // The system's sheet opens here, on this press. Only a key that answered is sent.
                    scope.launch(start = CoroutineStart.UNDISPATCHED) {
                        try {
                            when (val pressed = KeySetup.pressed(creation, name, sheet)) {
                                is KeySetup.Pressed.Stay -> local = pressed.error
                                is KeySetup.Pressed.Send -> model.addKey(pressed.registration, pressed.name, first, signOutOthers, password)
                            }
                        } finally {
                            waiting = false
                        }
                    }
                }, modifier = Modifier.fillMaxWidth().height(48.dp)) { Text(if (pending) "Waiting for your key" else if (first) "Add and turn on" else "Add") }
            }
        }
        return
    }
    AccountPage(if (first) "Turn on two-step sign-in?" else "Add a passkey or security key?", onBack = if (pending) null else onBack) {
        FormBody {
            if (first) Text("After your password, HushOS will ask for your passkey or security key.", style = MaterialTheme.typography.bodyLarge)
            ConfirmPassword(password, { password = it; local = null }, tried, enabled = !pending)
            StepUpFields(holder, enabled = !pending)
            error?.let { Text(it, color = alpine.danger, style = MaterialTheme.typography.bodyMedium) }
            Button(enabled = !pending, onClick = {
                tried = true
                if (password.isEmpty()) return@Button
                scope.withStep(holder, sheet) { twoStep ->
                    local = null
                    tried = false
                    model.startKey(password, twoStep, holder::failed)
                }
            }, modifier = Modifier.fillMaxWidth().height(48.dp)) { Text(if (flow.pending) "Checking" else "Continue") }
        }
    }
}

/*
 * Removing a method: the password and the step, by any way, the one being removed included. Removing the
 * account's only method (`last`) is turning the step off, and is said so. The page closes from the view
 * model's answer (TwoStepFlow.finished).
 */
@Composable
private fun RemoveScreen(model: DriveViewModel, method: TwoStepStatus.Method, last: Boolean, onBack: () -> Unit) {
    val alpine = Alpine.colors
    val holder = retain { StepUpHolder(model, StepPurpose.TWO_STEP) }
    val sheet = rememberKeySheet()
    val scope = rememberCoroutineScope()
    val flow = model.twoStepFlow
    val pending = flow.pending || holder.asking
    var password by retain { mutableStateOf("") }
    var tried by remember { mutableStateOf(false) }
    LaunchedEffect(Unit) { holder.prepare() }
    // Held while the request is out, not let through to the page behind.
    BackHandler { if (!pending) onBack() }
    val title = if (last) "Turn off two-step sign-in?" else if (method.isApp) "Remove your authenticator app?" else "Remove this passkey or security key?"
    AccountPage(title, onBack = if (pending) null else onBack) {
        FormBody {
            Text(
                when {
                    last -> "Your password alone will sign you in, and your backup codes will stop working."
                    method.isApp -> "Its codes will stop working for sign-in."
                    else -> "${method.name ?: "This key"} will stop working for sign-in."
                },
                style = MaterialTheme.typography.bodyLarge,
            )
            ConfirmPassword(password, { password = it }, tried, enabled = !pending)
            StepUpFields(holder, enabled = !pending)
            flow.error?.let { Text(it, color = alpine.danger, style = MaterialTheme.typography.bodyMedium) }
            Button(
                enabled = !pending, colors = ButtonDefaults.buttonColors(containerColor = alpine.danger, contentColor = androidx.compose.ui.graphics.Color.White),
                onClick = {
                    tried = true
                    if (password.isEmpty()) return@Button
                    // A reply that is lost says so here, and the settings behind this page are read again: they show what is left.
                    scope.withStep(holder, sheet) { twoStep -> model.removeTwoStepMethod(method.id, method.isApp, password, twoStep, holder::failed) }
                }, modifier = Modifier.fillMaxWidth().height(48.dp),
            ) { Text(if (last) { if (flow.pending) "Turning off" else "Turn off" } else if (flow.pending) "Removing" else "Remove") }
        }
    }
}

/* A new set of ten, which replaces the old one: the password and the step. The codes themselves are shown by `CodesScreen`, from the view model. */
@Composable
private fun NewCodesScreen(model: DriveViewModel, onBack: () -> Unit) {
    val alpine = Alpine.colors
    val holder = retain { StepUpHolder(model, StepPurpose.TWO_STEP) }
    val sheet = rememberKeySheet()
    val scope = rememberCoroutineScope()
    val flow = model.twoStepFlow
    val pending = flow.pending || holder.asking
    var password by retain { mutableStateOf("") }
    var tried by remember { mutableStateOf(false) }
    LaunchedEffect(Unit) { holder.prepare() }
    // Held while "Making" is out, not let through to the page behind: the codes it makes are shown once.
    BackHandler { if (!pending) onBack() }
    AccountPage("Make new backup codes?", onBack = if (pending) null else onBack) {
        FormBody {
            Text("You get ten new codes, and the ones you have now stop working.", style = MaterialTheme.typography.bodyLarge)
            ConfirmPassword(password, { password = it }, tried, enabled = !pending)
            StepUpFields(holder, enabled = !pending)
            flow.error?.let { Text(it, color = alpine.danger, style = MaterialTheme.typography.bodyMedium) }
            Button(enabled = !pending, onClick = {
                tried = true
                if (password.isEmpty()) return@Button
                scope.withStep(holder, sheet) { twoStep -> model.newBackupCodes(password, twoStep, holder::failed) }
            }, modifier = Modifier.fillMaxWidth().height(48.dp)) { Text(if (flow.pending) "Making" else "Make new codes") }
        }
    }
}

/*
 * The backup codes, once: after turning the step on, or a new set. Drawn from the view model's flow by
 * `TwoStepScreen` itself, so they are found by whoever opens Two-step sign-in next if the page that
 * asked for them was left while the request was out. No way out but Done.
 */
@Composable
private fun CodesScreen(model: DriveViewModel, flow: com.hushos.app.data.TwoStepFlow, codes: List<String>, email: String, onDone: () -> Unit) {
    val alpine = Alpine.colors
    BackHandler {}
    AccountPage(if (flow.codesReplace) "Save your new backup codes" else "Save your backup codes", onBack = null) {
        FormBody {
            Text(if (flow.codesReplace) "Your earlier codes no longer work." else "Two-step sign-in is on.", style = MaterialTheme.typography.bodyLarge)
            BackupCodes(model, codes, email)
            if (flow.removing) Text("Removing your other devices", style = MaterialTheme.typography.bodyMedium, color = alpine.inkMuted)
            if (flow.notRemoved) Text(StepWords.OTHERS_NOT_REMOVED, style = MaterialTheme.typography.bodyMedium, color = alpine.danger)
            Button(onClick = onDone, modifier = Modifier.fillMaxWidth().height(48.dp)) { Text("Done") }
        }
    }
}
