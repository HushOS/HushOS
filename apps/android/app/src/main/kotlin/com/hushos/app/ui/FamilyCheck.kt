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
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.retain.retain
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.unit.dp
import com.hushos.app.data.FamilyCheckCode
import com.hushos.app.data.FamilyMemberRef
import com.hushos.app.data.FamilyRemovedNow
import com.hushos.app.data.FamilyWords
import com.hushos.app.data.FamilySync
import com.hushos.app.data.GroupSummary
import com.hushos.app.data.NotAuthenticated
import com.hushos.app.data.Problems
import com.hushos.app.data.checkCode
import com.hushos.app.data.checkMatch
import com.hushos.app.data.firstNameOf
import com.hushos.app.data.rethrowIfCancelled
import com.hushos.tokens.AlpineSpace
import kotlinx.coroutines.launch

/*
 * Check it's Sam, in a family (docs/optional-verification.md 3.4, 6.10; iOS's FamilyCheck.swift, the web's
 * family-check.tsx, in its words): one comparison between two members. The family is synced first ("Getting the
 * latest"), then both screens show the same twelve words, worked out from the member list that let the later of the two
 * in and both accounts. They match on each side writes that side's records; They don't match writes nothing. A phone
 * whose own entry was wrong at that list shows no words and leads to Sam's own twelve words instead.
 */

/* Whom a member row's check is with, the family it is in, and who to ask for help (the organizer, null when it's this person). */
data class MemberCheck(val summary: GroupSummary, val member: FamilyMemberRef, val me: String, val organizer: String?)

/* A member's check, drawn by Main from FamiliesModel.checking so it outlives the row and the page it started from. */
@Composable
fun MemberCheckSheet(model: DriveViewModel, check: MemberCheck, done: () -> Unit) {
    Sheet(onDismissRequest = done, full = true) {
        Column(
            Modifier.fillMaxWidth().verticalScroll(rememberScrollState()).padding(horizontal = AlpineSpace.S6).padding(bottom = AlpineSpace.S6),
            verticalArrangement = Arrangement.spacedBy(AlpineSpace.S3),
        ) { FamilyCheckContent(model, check, done) }
    }
}

@Composable
private fun FamilyCheckContent(model: DriveViewModel, check: MemberCheck, done: () -> Unit) {
    val alpine = Alpine.colors
    val scope = rememberCoroutineScope()
    val member = check.member
    val who = firstNameOf(member.name.ifEmpty { member.email })
    val family = check.summary.name
    var code by retain(member.userId) { mutableStateOf<FamilyCheckCode?>(null) }
    var failure by retain(member.userId) { mutableStateOf<String?>(null) }
    var mismatch by retain(member.userId) { mutableStateOf(false) }
    var saving by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    var attempt by remember { mutableIntStateOf(0) }
    LaunchedEffect(member.userId, attempt) {
        if (code != null && attempt == 0) return@LaunchedEffect
        failure = null
        code = null
        // One session for the check: what lands after a sign-out or a switch is dropped (the sheet closed with it).
        val session = model.families.begin() ?: return@LaunchedEffect
        val start = model.families.run(session) { it.checkCode(check.summary, member.userId) } ?: return@LaunchedEffect
        start.onSuccess {
            // The sync it ran is shown as after any sync (a warning, a removal) when it is a later look than what is shown.
            model.families.adopt(it.state, check.summary, session, it.revision)
            if (!model.families.current(session)) return@LaunchedEffect
            // The family as it is shown now decides: words worked out over a chain it has since left don't show.
            val problem = it.problem ?: FamilySync.checkProblem(model.families.states[check.summary.id] ?: it.state)
            if (problem != null) failure = problem else code = it.code
        }.onFailure {
            it.rethrowIfCancelled()
            if (it is NotAuthenticated) { model.lostSession(); done(); return@LaunchedEffect }
            failure = FamilyWords.error(it)
        }
    }
    Text("Check it’s $who", style = MaterialTheme.typography.titleLarge, modifier = Modifier.semantics { heading() })
    val shown = code as? FamilyCheckCode.Code
    when {
        mismatch -> Text("These don’t match. Make sure you’re both in $family, reload, and compare again. If they still don’t match, ${check.organizer?.let { "ask $it to help" } ?: "contact support"}.",
            style = MaterialTheme.typography.bodyMedium)
        shown != null -> Text("Ask $who to open $family and choose Check it’s ${check.me} beside your name. If the twelve words on both screens match, you’ve checked each other.",
            style = MaterialTheme.typography.bodyMedium, color = alpine.inkMuted)
    }
    when {
        failure != null -> {
            Text(failure!!, style = MaterialTheme.typography.bodyMedium, color = alpine.danger)
            TextButton(onClick = { attempt++ }) { Text("Try again") }
        }
        code == null -> Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(AlpineSpace.S2)) {
            CircularProgressIndicator(Modifier.size(20.dp), strokeWidth = 2.dp)
            Text("Getting the latest", style = MaterialTheme.typography.bodyMedium, color = alpine.inkMuted)
        }
        code == FamilyCheckCode.OwnEntryWrong -> Text("This device can’t check the family with $who. You can check $who’s own twelve words instead.", style = MaterialTheme.typography.bodyMedium)
        code == FamilyCheckCode.NotAdmitted -> Text("$who isn’t in $family on this device yet. Try again in a moment.", style = MaterialTheme.typography.bodyMedium, color = alpine.inkMuted)
        shown != null && !mismatch -> {
            WordGrid(shown.code)
            TechnicalDetails {
                Text("These words are worked out from the family’s member list as it was when $who joined, and from your two accounts. When they match, your devices see the same family, and each confirms the other’s keys.",
                    style = MaterialTheme.typography.bodySmall, color = alpine.inkMuted)
                Text("Member list version ${shown.rosterVersion}", style = MaterialTheme.typography.bodySmall)
                shown.rosterDigest?.let { Text(it, style = MaterialTheme.typography.bodySmall, fontFamily = FontFamily.Monospace) }
            }
        }
    }
    error?.let { Text(it, style = MaterialTheme.typography.bodyMedium, color = alpine.danger) }
    val buttons = Modifier.fillMaxWidth().height(48.dp)
    Column(Modifier.fillMaxWidth().padding(top = AlpineSpace.S2), verticalArrangement = Arrangement.spacedBy(AlpineSpace.S2)) {
        when {
            // Their own twelve words, in this sheet's place (6.6).
            code == FamilyCheckCode.OwnEntryWrong -> Button(onClick = { done(); model.contactStep = ContactStep.Check(member.email, member.name) }, modifier = buttons) { Text("Check $who’s words") }
            mismatch -> Button(onClick = done, modifier = buttons) { Text("Done") }
            shown != null -> {
                Button(enabled = !saving, modifier = buttons, onClick = {
                    saving = true
                    error = null
                    scope.launch {
                        val session = model.families.begin()
                        val saved = session?.let { model.families.run(it) { sync -> sync.checkMatch(check.summary.id, member, shown.rosterVersion, shown.code) } }
                        if (saved == null) { saving = false; return@launch }
                        // Removed meanwhile: the family shows what checkMatch's removal left (wiped, or refused with the
                        // storage words when its guard couldn't be stored), and a failure here keeps Try again.
                        val removed = saved.exceptionOrNull() as? FamilyRemovedNow
                        if (removed != null && session != null) {
                            model.families.removedDuringCheck(removed, check.summary, session)?.let { words ->
                                failure = words
                                saving = false
                                return@launch
                            }
                        }
                        saved.onSuccess { (checked, verified) ->
                            if (!checked) {
                                // The family moved on here since the words were shown: worked out again.
                                error = "The family changed meanwhile. Compare these words again."
                                attempt++
                            } else {
                                model.notify(if (verified) "You and $who checked each other" else "You and $who see the same family")
                                // What this phone trusts moved: what is on screen is judged again now.
                                model.trustMoved()
                                model.families.refreshed[check.summary.id] = (model.families.refreshed[check.summary.id] ?: 0) + 1
                                done()
                            }
                        }.onFailure {
                            it.rethrowIfCancelled()
                            if (it is NotAuthenticated) { model.lostSession(); done() } else error = Problems.say(it, "That wasn’t saved. Try again.")
                        }
                        saving = false
                    }
                }) { Text(if (saving) "Saving…" else "They match") }
                OutlinedButton(enabled = !saving, onClick = { mismatch = true }, modifier = buttons) { Text("They don’t match") }
            }
        }
    }
}
