package com.hushos.app.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.retain.retain
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import com.hushos.app.data.FamilyFork
import com.hushos.app.data.FamilyWords
import com.hushos.app.data.GroupsApiError
import com.hushos.app.data.Invitation
import com.hushos.app.data.InvitationNotice
import com.hushos.app.data.JoinOutcome
import com.hushos.app.data.JoinWords
import com.hushos.app.data.NotAuthenticated
import com.hushos.app.data.firstNameOf
import com.hushos.app.data.joinStatus
import com.hushos.app.data.rethrowIfCancelled
import com.hushos.tokens.AlpineSpace
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

/*
 * Joining a family on the phone (docs/optional-verification.md 6.8; iOS's Join.swift as #243 rewrote it), the web's two
 * pages in their words: the mailed invitation (/join#invite=<token>), Join, then Waiting for Maya until someone who
 * manages the family lets this person in, when the phone joins on first use and the family's page follows. No words on
 * either side. Every rule is FamilySync's join steps; this draws them and keeps the person's place.
 */

private sealed interface InviteStep {
    data object Opening : InviteStep
    /* The link's token was cut off: nothing to open. */
    data object Incomplete : InviteStep
    data class Failed(val gone: Boolean, val words: String) : InviteStep
    data class Shown(val invitation: Invitation) : InviteStep
    data class Joining(val groupId: String, val family: String) : InviteStep
}

/*
 * The invitation, signed in: who invited you to which family, Join and Not now, and after Join the wait in the same
 * sheet, sized to its content; once in, the family's page in Account. Drawn by Main from FamiliesModel.invitation, so it
 * outlives whatever screen the link opened over.
 */
@Composable
fun InvitationSheet(model: DriveViewModel, state: DriveState, token: String, done: () -> Unit) {
    var step by retain(token) { mutableStateOf<InviteStep>(if (token.isEmpty()) InviteStep.Incomplete else InviteStep.Opening) }
    var refusal by retain(token) { mutableStateOf<GroupsApiError?>(null) }
    var problem by retain(token) { mutableStateOf<String?>(null) }
    var accepting by remember { mutableStateOf(false) }
    var waitTitle by remember { mutableStateOf<String?>(null) }
    var attempt by remember { mutableStateOf(0) }
    val scope = rememberCoroutineScope()
    fun openFamily(groupId: String) { done(); model.openRequest("family:$groupId") }
    LaunchedEffect(token, attempt) {
        if (step != InviteStep.Opening) return@LaunchedEffect
        val session = model.families.begin() ?: return@LaunchedEffect
        val opened = model.families.run(session) { it.openInvitation(token) } ?: return@LaunchedEffect
        step = opened.fold({ InviteStep.Shown(it) }) { error ->
            error.rethrowIfCancelled()
            if (error is NotAuthenticated) { model.lostSession(); done(); return@LaunchedEffect }
            if ((error as? GroupsApiError)?.code == "gone") InviteStep.Failed(true, "") else InviteStep.Failed(false, JoinWords.refusal(error))
        }
    }
    Sheet(onDismissRequest = { if (!accepting) done() }) {
        Column(
            Modifier.fillMaxWidth().verticalScroll(rememberScrollState()).padding(horizontal = AlpineSpace.S6).padding(bottom = AlpineSpace.S6),
            verticalArrangement = Arrangement.spacedBy(AlpineSpace.S3),
        ) {
            val alpine = Alpine.colors
            val buttons = Modifier.fillMaxWidth().height(48.dp)
            @Composable fun title(text: String) = Text(text, style = MaterialTheme.typography.titleLarge, modifier = Modifier.semantics { heading() })
            @Composable fun signedInAs() = Text("Signed in as ${state.user?.email?.ifEmpty { null } ?: "you"}.", style = MaterialTheme.typography.bodySmall, color = alpine.inkMuted)
            when (val shown = step) {
                InviteStep.Opening -> {
                    title("Opening your invitation")
                    Row(verticalAlignment = Alignment.CenterVertically) { CircularProgressIndicator(Modifier.size(20.dp), strokeWidth = 2.dp) }
                }
                InviteStep.Incomplete -> {
                    title("This invitation link is incomplete")
                    Text("Open the link from the invitation email again. If it still doesn’t work, ask for a new invitation.", style = MaterialTheme.typography.bodyMedium)
                    Button(onClick = done, modifier = buttons) { Text("Done") }
                }
                is InviteStep.Failed -> {
                    title(if (shown.gone) "This invitation is no longer open" else "This invitation didn’t open")
                    Text(if (shown.gone) "It was used, cancelled, or it ran out. Ask the person who invited you for a new one." else shown.words, style = MaterialTheme.typography.bodyMedium)
                    signedInAs()
                    if (!shown.gone) Button(onClick = { step = InviteStep.Opening; attempt++ }, modifier = buttons) { Text("Try again") }
                    TextButton(onClick = done) { Text("Done") }
                }
                is InviteStep.Shown -> {
                    val invitation = shown.invitation
                    val notice = InvitationNotice.of(invitation, refusal, state.user?.email)
                    // No answer, or something other than a refusal: said as such, and Join stays to try again.
                    val note = notice.note ?: problem?.let { InvitationNotice.Note.Problem(it) }
                    // Names are the server's word (D10): the address goes beside the inviter's.
                    val invited = invitation.inviter?.let { inviter -> "${inviter.name}${inviter.email?.let { " ($it)" } ?: ""} invited you." } ?: "You’re invited."
                    title("Join ${invitation.name}")
                    Text("$invited Family folders are shared with everyone in the family.", style = MaterialTheme.typography.bodyMedium, color = alpine.inkMuted)
                    when (note) {
                        is InvitationNotice.Note.InFamily -> {
                            Text(note.words, style = MaterialTheme.typography.bodyMedium)
                            TextButton(onClick = { openFamily(note.yours.groupId) }) { Text("Open ${note.yours.name}") }
                        }
                        InvitationNotice.Note.AlreadyMember -> {
                            Text("You’re already in this family", style = MaterialTheme.typography.titleSmall)
                            TextButton(onClick = { openFamily(invitation.groupId) }) { Text("Open ${invitation.name}") }
                        }
                        is InvitationNotice.Note.Problem -> Text(note.words, style = MaterialTheme.typography.bodyMedium, color = alpine.danger)
                        null -> {}
                    }
                    signedInAs()
                    Button(enabled = !accepting && notice.canAccept, modifier = buttons, onClick = {
                        accepting = true
                        refusal = null
                        problem = null
                        scope.launch {
                            // One session from Join to the family's first check: a switch meanwhile drops the rest.
                            val session = model.families.begin()
                            val accepted = session?.let { model.families.run(it) { sync -> sync.acceptInvitation(token) } }
                            if (session == null || accepted == null) { accepting = false; return@launch }
                            accepted.onSuccess { groupId ->
                                model.families.refreshFamilies(force = true, session = session)
                                if (!model.families.current(session)) return@launch
                                step = InviteStep.Joining(groupId, invitation.name)
                            }.onFailure { error ->
                                error.rethrowIfCancelled()
                                when {
                                    error is NotAuthenticated -> { model.lostSession(); done() }
                                    // Said under the invitation in the web's words, Join off where it can't help.
                                    error is GroupsApiError && error.status != 0 -> refusal = error
                                    else -> problem = JoinWords.refusal(error, invitation.name)
                                }
                            }
                            accepting = false
                        }
                    }) { Text(if (accepting) "Joining" else "Join") }
                    OutlinedButton(enabled = !accepting, onClick = done, modifier = buttons) { Text("Not now") }
                }
                is InviteStep.Joining -> {
                    title(waitTitle ?: "Join ${shown.family}")
                    JoinContent(model, shown.groupId, shown.family, title = { waitTitle = it }, onJoined = { openFamily(shown.groupId) })
                }
            }
        }
    }
}

private sealed interface JoinStep {
    data object Loading : JoinStep
    /* `entry` tells one entry into waiting from the next, so polling starts again each time. */
    data class Waiting(val entry: Long) : JoinStep
    data class Fork(val fork: FamilyFork) : JoinStep
}

/*
 * The newcomer's side after Join (6.8): waiting until someone who manages the family lets them in, route 2 polled
 * meanwhile through the join status; then the phone joins on first use and `onJoined` follows. The hard warning when
 * this person's own marks disagree with what is served. It owns the family while open: background checks of it wait.
 */
@Composable
fun JoinContent(model: DriveViewModel, groupId: String, family: String, title: (String?) -> Unit, onJoined: () -> Unit) {
    val alpine = Alpine.colors
    var step by remember(groupId) { mutableStateOf<JoinStep>(JoinStep.Loading) }
    var error by remember(groupId) { mutableStateOf<String?>(null) }
    var managers by remember(groupId) { mutableStateOf<List<String>>(emptyList()) }
    var attempt by remember { mutableStateOf(0) }
    // The session this join screen began in: every request below is that session's, and what lands after it ended is dropped.
    val session = remember(groupId) { model.families.begin() }
    DisposableEffect(groupId) {
        model.families.openJoin(groupId)
        onDispose { model.families.closeJoin(groupId) }
    }
    // One manager is named; with more, whoever manages the family lets them in.
    val only = managers.singleOrNull()?.let(::firstNameOf)
    val waitingTitle = only?.let { "Waiting for $it" } ?: "Waiting to be let in"
    LaunchedEffect(step is JoinStep.Waiting, waitingTitle) { title(if (step is JoinStep.Waiting) waitingTitle else null) }
    suspend fun show(outcome: JoinOutcome) {
        error = null
        when (outcome) {
            is JoinOutcome.Joined -> {
                model.notify("You’re in $family")
                session?.let { model.families.joined(groupId, outcome.state, it, outcome.revision) }
                onJoined()
            }
            // This phone already holds the family: nothing to join. Checked as a member, from this screen.
            JoinOutcome.Member -> {
                model.families.list?.firstOrNull { it.id == groupId }?.let { model.families.refreshFamily(it, fromJoin = true, session = session) } ?: model.families.refreshFamilies(force = true, session = session)
                onJoined()
            }
            JoinOutcome.Waiting -> if (step !is JoinStep.Waiting) step = JoinStep.Waiting(System.nanoTime())
            is JoinOutcome.Fork -> step = JoinStep.Fork(outcome.fork)
        }
    }
    /* Null once the session this screen began in ended: the screen stops asking. */
    suspend fun status(): Result<JoinOutcome>? = session?.let { model.families.run(it) { sync -> sync.joinStatus(groupId) } }
    LaunchedEffect(groupId, attempt) {
        (status() ?: return@LaunchedEffect).onSuccess { show(it) }.onFailure {
            it.rethrowIfCancelled()
            if (it is NotAuthenticated) { model.lostSession(); return@LaunchedEffect }
            // The retry belongs to the loading step, whatever step this came from.
            step = JoinStep.Loading
            error = FamilyWords.error(it)
        }
    }
    // Route 3 answers someone who accepted: who manages the family, read again every few seconds.
    LaunchedEffect(groupId) {
        val s = session ?: return@LaunchedEffect
        while (model.families.current(s)) {
            model.families.run(s) { it.members(groupId) }?.getOrNull()?.let { detail ->
                managers = detail.members.filter { it.state == "active" && "members" in it.roles }.map { it.name }
            }
            delay(5_000)
        }
    }
    // Waiting: route 2 polled through the join status until the person is let in.
    val waiting = step as? JoinStep.Waiting
    LaunchedEffect(waiting?.entry) {
        waiting ?: return@LaunchedEffect
        while (true) {
            delay(3_000)
            (status() ?: return@LaunchedEffect).onSuccess { outcome -> if (outcome != JoinOutcome.Waiting) { show(outcome); return@LaunchedEffect }; error = null }
                .onFailure {
                    it.rethrowIfCancelled()
                    if (it is NotAuthenticated) { model.lostSession(); return@LaunchedEffect }
                    error = FamilyWords.error(it)
                }
        }
    }
    Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(AlpineSpace.S3)) {
        error?.let { words ->
            Text(words, style = MaterialTheme.typography.bodyMedium, color = alpine.ink)
            if (step == JoinStep.Loading) TextButton(onClick = { error = null; attempt++ }) { Text("Try again") }
        }
        when (val shown = step) {
            JoinStep.Loading -> if (error == null) Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(AlpineSpace.S2)) {
                CircularProgressIndicator(Modifier.size(20.dp), strokeWidth = 2.dp)
                Text("Opening", style = MaterialTheme.typography.bodyMedium, color = alpine.inkMuted)
            }
            is JoinStep.Waiting -> Row(verticalAlignment = Alignment.Top, horizontalArrangement = Arrangement.spacedBy(AlpineSpace.S3)) {
                CircularProgressIndicator(Modifier.padding(top = 2.dp).size(18.dp), strokeWidth = 2.dp)
                Text(only?.let { "$it lets you in from the family’s page. This page updates when you’re in." }
                    ?: "Someone who manages $family lets you in from the family’s page. This page updates when you’re in.", style = MaterialTheme.typography.bodyMedium)
            }
            is JoinStep.Fork -> ForkAlert(family, shown.fork, null)
        }
    }
}
