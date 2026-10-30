package com.hushos.app.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Check
import androidx.compose.material.icons.outlined.KeyboardArrowDown
import androidx.compose.material.icons.outlined.KeyboardArrowUp
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.retain.retain
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.hushos.app.data.AccountChange
import com.hushos.app.data.Added
import com.hushos.app.data.ContactMoved
import com.hushos.app.data.ContactPin
import com.hushos.app.data.Fingerprint
import com.hushos.app.data.Lookup
import com.hushos.app.data.Problems
import com.hushos.app.data.firstNameOf
import com.hushos.tokens.AlpineSpace
import kotlinx.coroutines.launch
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter

/*
 * Contacts without comparing words (docs/optional-verification.md 6.2, 6.6, 6.7; the web's add-someone.tsx,
 * check-contact.tsx and account-changed.tsx, in their words): Add someone is an email and Add; Check it's Maya is the
 * optional door to the twelve words; "Maya's account changed" is the one calm notice for keys that changed with no
 * signed chain. Each is a step in one bottom sheet that takes the place of whatever it was met in, never a sheet over a
 * sheet; a step leads to the next in place (Review's Check it's Maya replaces the notice).
 */
sealed interface ContactStep {
    data class Check(val email: String, val name: String) : ContactStep
    data class Changed(val change: AccountChange) : ContactStep
    /* Add someone; from an Unverified mark `writer` is the account that wrote the item, which the address must be. */
    data class Add(val writer: String? = null) : ContactStep
}

/*
 * One contact step and those it leads to, in a bottom sheet sized to what it shows: the twelve words open the sheet at
 * full height, the notice and Add someone are short and sized to their content. `resolved`: Continue or They match went
 * through, so what waited on them may run now.
 */
@Composable
fun ContactStepSheet(model: DriveViewModel, start: ContactStep, resolved: () -> Unit = {}, done: () -> Unit) {
    // Retained, so a fold, a rotation or a theme change keeps the step it reached (Check it's Kim after Check who
    // wrote this added Kim), never the one it started from.
    var step by retain(start) { mutableStateOf(start) }
    val tall = step is ContactStep.Check
    key(tall) {
        Sheet(onDismissRequest = done, full = tall) {
            Column(
                Modifier.fillMaxWidth().verticalScroll(rememberScrollState()).padding(horizontal = AlpineSpace.S6).padding(bottom = AlpineSpace.S6),
                verticalArrangement = Arrangement.spacedBy(AlpineSpace.S3),
            ) {
                when (val shown = step) {
                    is ContactStep.Check -> CheckContact(model, shown.email, shown.name, resolved, done)
                    is ContactStep.Changed -> AccountChangedNotice(model, shown.change, check = { step = ContactStep.Check(shown.change.email, shown.change.name) }, resolved, done)
                    // Added, and done: no words. Only from a mark (Check who wrote this) do the words come next, as on the web.
                    is ContactStep.Add -> AddSomeone(model, shown.writer, added = { pin -> if (shown.writer != null) step = ContactStep.Check(pin.email, pin.name) else done() },
                        changed = { step = ContactStep.Changed(it) }, cancel = done)
                }
            }
        }
    }
}

@Composable
private fun StepTitle(text: String) = Text(text, style = MaterialTheme.typography.titleLarge, modifier = Modifier.semantics { heading() })

@Composable
private fun Muted(text: String) = Text(text, style = MaterialTheme.typography.bodyMedium, color = Alpine.colors.inkMuted)

@Composable
private fun Failure(text: String) = Text(text, style = MaterialTheme.typography.bodyMedium, color = Alpine.colors.danger)

@Composable
private fun Waiting(text: String) = Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(AlpineSpace.S2)) {
    CircularProgressIndicator(Modifier.size(20.dp), strokeWidth = 2.dp)
    Muted(text)
}

/* The step's two choices, full width and stacked, the primary one on top (6.6, 6.7: a phone's layout). */
@Composable
private fun Choices(primary: String, onPrimary: () -> Unit, secondary: String?, onSecondary: () -> Unit, enabled: Boolean = true, secondaryEnabled: Boolean = enabled) {
    Column(Modifier.fillMaxWidth().padding(top = AlpineSpace.S2), verticalArrangement = Arrangement.spacedBy(AlpineSpace.S2)) {
        Button(onClick = onPrimary, enabled = enabled, modifier = Modifier.fillMaxWidth().height(48.dp)) { Text(primary) }
        if (secondary != null) OutlinedButton(onClick = onSecondary, enabled = secondaryEnabled, modifier = Modifier.fillMaxWidth().height(48.dp)) { Text(secondary) }
    }
}

/* Add someone (6.2): their email, Add, and they are a contact at once. No words, no second step. */
@Composable
private fun AddSomeone(model: DriveViewModel, writer: String?, added: (ContactPin) -> Unit, changed: (AccountChange) -> Unit, cancel: () -> Unit) {
    val scope = rememberCoroutineScope()
    var email by rememberSaveable { mutableStateOf("") }
    var adding by remember { mutableStateOf(false) }
    var hint by remember { mutableStateOf<Pair<String, Boolean>?>(null) }
    val focus = remember { FocusRequester() }
    LaunchedEffect(Unit) { runCatching { focus.requestFocus() } }
    fun add() {
        val address = email.trim()
        if (address.isEmpty() || adding) return
        adding = true
        hint = null
        scope.launch {
            model.addContact(address, writer).onSuccess { result ->
                when (result) {
                    is Added.New -> { model.notify("${result.pin.firstName} added"); added(result.pin) }
                    is Added.Already -> hint = "${result.pin.firstName} is already in your contacts." to false
                    is Added.Changed -> changed(result.change)
                }
            }.onFailure { hint = Problems.say(it, "Check the address and try again.") to true }
            adding = false
        }
    }
    StepTitle(if (writer == null) "Add someone" else "Check who wrote this")
    if (writer != null) Muted("Enter the email they use for HushOS. Once they’re in your contacts, what they add and change shows as theirs.")
    OutlinedTextField(
        value = email, onValueChange = { email = it; hint = null }, singleLine = true, label = { Text("Email") },
        supportingText = { Text(hint?.first ?: "The email they use for HushOS.", color = if (hint?.second == true) Alpine.colors.danger else Alpine.colors.inkMuted) },
        keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Email, imeAction = ImeAction.Done),
        keyboardActions = KeyboardActions(onDone = { add() }),
        modifier = Modifier.fillMaxWidth().focusRequester(focus),
    )
    Choices(if (adding) "Adding…" else "Add", ::add, "Cancel", cancel, enabled = !adding && email.isNotBlank(), secondaryEnabled = !adding)
}

private val DAY_MONTH: DateTimeFormatter = DateTimeFormatter.ofPattern("d MMMM", java.util.Locale.UK)

/*
 * Check it's Maya (6.6), the advanced door: the twelve words over the keys HushOS serves for them now. They match makes
 * the pin verified; They don't match saves nothing and offers Remove Maya from contacts, which asks once in its place.
 */
@Composable
private fun CheckContact(model: DriveViewModel, email: String, name: String, resolved: () -> Unit, done: () -> Unit) {
    val scope = rememberCoroutineScope()
    val context = LocalContext.current
    var found by remember { mutableStateOf<Lookup?>(null) }
    var failure by remember { mutableStateOf<String?>(null) }
    var mismatch by rememberSaveable { mutableStateOf(false) }
    var removing by remember { mutableStateOf(false) }
    var saving by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    var attempt by remember { mutableStateOf(0) }
    LaunchedEffect(email, attempt) {
        failure = null
        model.lookup(email).onSuccess { found = it }.onFailure { failure = Problems.say(it, "Try again.") }
    }
    val lookup = found
    val first = firstNameOf(lookup?.contact?.displayName ?: name.ifEmpty { email })
    StepTitle("Check it’s $first")
    Text(
        if (mismatch) "These don’t match. Check $first’s email address with them. If it’s right and they still don’t match, remove $first for now and add them again once they do. To stop sharing something with $first, open Share on it."
        else "Ask $first to open Contacts in HushOS and choose Your twelve words. If theirs match these, it’s really them. Do it in person or on a call.",
        style = MaterialTheme.typography.bodyMedium, color = if (mismatch) Alpine.colors.ink else Alpine.colors.inkMuted,
    )
    when {
        failure != null -> { Failure(failure!!); TextButton(onClick = { attempt++ }) { Text("Try again") } }
        lookup == null -> Waiting("Getting their words")
        !lookup.upgraded -> Muted("$first needs to sign in to HushOS once more before you can share with them.")
    }
    val fingerprint = lookup?.contact?.fingerprint
    if (lookup != null && fingerprint != null && !mismatch) {
        lookup.pinned?.keysReplacedAt?.let { at -> runCatching { DAY_MONTH.format(Instant.parse(at).atZone(ZoneId.systemDefault())) }.getOrNull() }?.let {
            Text("$first updated their account on $it.", style = MaterialTheme.typography.bodySmall, color = Alpine.colors.inkMuted)
        }
        WordGrid(remember(fingerprint) { Fingerprint.words(fingerprint, Fingerprint.wordlist(context)) })
        TechnicalDetails {
            Muted("These words are worked out from $first’s four public keys. Comparing them confirms the keys HushOS gave your device are theirs.")
            Mono(fingerprint)
        }
    }
    error?.let { Failure(it) }
    if (lookup != null && fingerprint != null) {
        if (mismatch) {
            Choices("Done", done, if (lookup.pinned != null) "Remove $first from contacts" else null, { removing = true }, enabled = !saving)
        } else {
            Choices(if (saving) "Saving…" else "They match", {
                saving = true
                error = null
                scope.launch {
                    model.theyMatch(lookup).onSuccess {
                        model.notify("$first verified")
                        resolved()
                        done()
                    }.onFailure {
                        error = Problems.say(it, "That wasn’t saved. Try again.")
                        if (it is ContactMoved) attempt++
                    }
                    saving = false
                }
            }, "They don’t match", { mismatch = true }, enabled = !saving)
        }
    }
    // Asked once, as Contacts asks (6.5); Cancel comes back to the check.
    if (removing) AlertDialog(
        onDismissRequest = { removing = false },
        title = { Text("Remove $first?") },
        text = { Text("$first keeps access to anything you’ve already shared.") },
        confirmButton = {
            TextButton(onClick = {
                removing = false
                saving = true
                scope.launch {
                    model.removeContact(lookup!!.contact.userId).onSuccess { model.notify("$first removed"); done() }
                        .onFailure { error = Problems.say(it, "That wasn’t saved. Try again.") }
                    saving = false
                }
            }) { Text("Remove", color = Alpine.colors.danger) }
        },
        dismissButton = { TextButton(onClick = { removing = false }) { Text("Cancel") } },
    )
}

/*
 * "Maya's account changed" (6.7): until Continue or a check, nothing new is shared with them, nothing is sealed to them
 * again and nothing they shared opens. Continue takes the keys HushOS serves now, and what was shared with them is
 * sealed again, to those keys only. For someone this phone had checked, the check leads.
 */
@Composable
private fun AccountChangedNotice(model: DriveViewModel, change: AccountChange, check: () -> Unit, resolved: () -> Unit, done: () -> Unit) {
    val scope = rememberCoroutineScope()
    var found by remember { mutableStateOf<Lookup?>(null) }
    var failure by remember { mutableStateOf<String?>(null) }
    var busy by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    var attempt by remember { mutableStateOf(0) }
    LaunchedEffect(change, attempt) {
        failure = null
        model.lookup(change.email).onSuccess { found = it }.onFailure { failure = Problems.say(it, "Try again.") }
    }
    val name = change.firstName
    StepTitle("$name’s account changed")
    Muted("This happens when someone starts their HushOS account over, for example after losing their phone.")
    val lookup = found
    when {
        failure != null -> { Failure(failure!!); TextButton(onClick = { attempt++ }) { Text("Try again") } }
        lookup == null -> Waiting("Checking")
        !lookup.changed -> Text("Nothing needs doing: you can share with $name as before.", style = MaterialTheme.typography.bodyMedium)
        else -> {
            Text(if (lookup.wasVerified) "You’d checked it was $name before. You may want to check again." else "You can keep sharing with $name as before.",
                style = MaterialTheme.typography.bodyMedium)
            TechnicalDetails {
                Muted("$name’s keys are different from the ones your device remembered, and their previous keys didn’t sign the change.")
                Muted("Remembered")
                Mono(lookup.heldFingerprint ?: "None")
                Muted("Now")
                Mono(lookup.contact.fingerprint ?: "None")
            }
        }
    }
    error?.let { Failure(it) }
    if (lookup == null) return
    fun proceed() {
        busy = true
        error = null
        scope.launch {
            model.continueWith(change).onSuccess {
                model.notify("You’re sharing with $name again")
                resolved()
                done()
            }.onFailure {
                error = Problems.say(it, "That wasn’t saved. Try again.")
                if (it is ContactMoved) attempt++
            }
            busy = false
        }
    }
    val continuing = if (busy) "Continuing…" else "Continue"
    when {
        // Nothing changed after all (another device followed a signed succession): what waited may run, and whatever
        // showed the change looks again.
        !lookup.changed -> Choices("Done", { resolved(); done() }, null, {})
        lookup.wasVerified -> Choices("Check it’s $name", check, continuing, ::proceed, enabled = !busy && lookup.upgraded, secondaryEnabled = !busy)
        else -> Choices(continuing, ::proceed, "Check it’s $name", check, enabled = !busy, secondaryEnabled = !busy && lookup.upgraded)
    }
}

@Composable
private fun Mono(text: String) = Text(text, style = MaterialTheme.typography.bodySmall, fontFamily = FontFamily.Monospace, color = Alpine.colors.ink)

/* A closed disclosure, "Technical details", for the words a person looks for (6.1). */
@Composable
fun TechnicalDetails(content: @Composable () -> Unit) {
    var open by rememberSaveable { mutableStateOf(false) }
    Column(Modifier.fillMaxWidth()) {
        Row(
            Modifier.fillMaxWidth().heightIn(min = 48.dp).clickable(onClickLabel = if (open) "Hide" else "Show") { open = !open },
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Text("Technical details", style = MaterialTheme.typography.bodyMedium, fontWeight = FontWeight.SemiBold, modifier = Modifier.weight(1f))
            Icon(if (open) Icons.Outlined.KeyboardArrowUp else Icons.Outlined.KeyboardArrowDown, null, tint = Alpine.colors.inkMuted)
        }
        if (open) Column(
            Modifier.fillMaxWidth().background(Alpine.colors.fill, RoundedCornerShape(10.dp)).padding(AlpineSpace.S3),
            verticalArrangement = Arrangement.spacedBy(AlpineSpace.S1),
        ) { content() }
    }
}

/* "Verified" with a small check, or "Not verified": muted 13sp text, never a badge (6.1). */
@Composable
fun VerifiedLabel(verified: Boolean, modifier: Modifier = Modifier) {
    Row(modifier, verticalAlignment = Alignment.CenterVertically) {
        if (verified) {
            Icon(Icons.Outlined.Check, null, tint = Alpine.colors.inkMuted, modifier = Modifier.size(12.dp))
            Spacer(Modifier.size(3.dp))
        }
        Text(if (verified) "Verified" else "Not verified", fontSize = 13.sp, color = Alpine.colors.inkMuted, maxLines = 1)
    }
}

/*
 * A contact step a mark or Info started (Check who wrote this, Check it's Maya), held by the view model rather than by
 * the mark: adding or checking the writer clears the mark, and a sheet the mark owned would close with it mid-flow.
 * `Main` draws it.
 */
@Composable
fun MarkContactStep(model: DriveViewModel) {
    val step = model.contactStep ?: return
    ContactStepSheet(model, step, resolved = { model.retryTrust() }) { model.contactStep = null }
}
