package com.hushos.app.ui

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.KeyboardArrowRight
import androidx.compose.material.icons.outlined.Check
import androidx.compose.material.icons.outlined.MoreVert
import androidx.compose.material.icons.outlined.WarningAmber
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.LoadingIndicator
import androidx.compose.material3.ExperimentalMaterial3ExpressiveApi
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.hushos.app.data.FamilyFork
import com.hushos.app.data.FamilyMemberRef
import com.hushos.app.data.FamilyState
import com.hushos.app.data.FamilySync
import com.hushos.app.data.FamilyView
import com.hushos.app.data.MemberStanding
import com.hushos.app.data.checkedFamilyWith
import com.hushos.app.data.firstNameOf
import com.hushos.app.data.memberStandings
import com.hushos.tokens.AlpineSpace
import kotlinx.coroutines.launch

/*
 * Families on the phone (docs/groups-mobile-plan.md, Android 1, 3 and 5's members; iOS's Families.swift): a row per family
 * in Account, the family's page (the hard warning, Couldn't check, a removal, its folders, its members with Verified or
 * Not verified and Check it's Sam, Technical details), and each family folder as the Files list, read only. Every family
 * is checked on this phone first (FamilySync); the words are the web's.
 */

/* Where Account goes in a family, by value in one place (Account's `familyRoute`): the family's page, or one of its folders. */
sealed interface FamilyRoute {
    data class Page(val groupId: String) : FamilyRoute
    /* A family's top folder, by its workspace too: a personal or shared row with the same id never stands in for it. */
    data class Folder(val groupId: String, val rootId: String, val workspaceId: String? = null) : FamilyRoute

    fun save(): String = when (this) { is Page -> "page:$groupId"; is Folder -> "folder:$groupId:$rootId:${workspaceId.orEmpty()}" }

    companion object {
        fun of(saved: String?): FamilyRoute? = saved?.split(':')?.let { parts ->
            when {
                parts.size == 2 && parts[0] == "page" -> Page(parts[1])
                parts.size == 3 && parts[0] == "folder" -> Folder(parts[1], parts[2])
                parts.size == 4 && parts[0] == "folder" -> Folder(parts[1], parts[2], parts[3].ifEmpty { null })
                else -> null
            }
        }
    }
}

/* Account's Families: one row per family, as the web's list draws it. Absent on a server without families, or with none. */
@Composable
fun FamiliesSection(model: DriveViewModel, open: (String) -> Unit) {
    val list = model.families.list ?: return
    if (list.isEmpty()) return
    val alpine = Alpine.colors
    Subheader("Families")
    for (family in list) {
        Row(Modifier.fillMaxWidth().heightIn(min = 56.dp).clickable { open(family.id) }.padding(horizontal = AlpineSpace.S4, vertical = AlpineSpace.S2),
            verticalAlignment = Alignment.CenterVertically) {
            PersonAvatar(family.name, family.id)
            Column(Modifier.weight(1f).padding(start = AlpineSpace.S4)) {
                Text(family.name, style = MaterialTheme.typography.bodyLarge, maxLines = 1, overflow = TextOverflow.Ellipsis)
                Text(if (family.state == "accepted") "Waiting to join" else FamilySync.rolesLine(family.roles), style = MaterialTheme.typography.bodyMedium, color = alpine.inkMuted, maxLines = 1)
            }
            when (model.families.states[family.id]) {
                is FamilyState.Fork -> StateLabel("Shown differently")
                is FamilyState.Failed -> StateLabel("Couldn’t check")
                else -> {}
            }
            Icon(Icons.AutoMirrored.Outlined.KeyboardArrowRight, null, tint = alpine.inkMuted, modifier = Modifier.padding(start = AlpineSpace.S2))
        }
    }
}

/* A status in words on its soft fill: never colour alone. */
@Composable
private fun StateLabel(text: String) {
    val alpine = Alpine.colors
    Text(text, style = MaterialTheme.typography.labelSmall, color = alpine.warning, maxLines = 1,
        modifier = Modifier.background(alpine.warningSoft, RoundedCornerShape(4.dp)).padding(horizontal = 6.dp, vertical = 1.dp))
}

/*
 * One family: what its check on this phone found, its folders, who is in it with their roles and whether this person
 * checked them, and the member list's technical details. While not let in (or let in with nothing on this phone or
 * account checking the family yet) the join takes the page's place, as the web's page redirects there.
 */
@OptIn(ExperimentalMaterial3Api::class, ExperimentalMaterial3ExpressiveApi::class)
@Composable
fun FamilyPage(model: DriveViewModel, groupId: String, openFolder: (com.hushos.app.data.NodeView) -> Unit, onBack: () -> Unit) {
    val alpine = Alpine.colors
    val families = model.families
    val name = families.name(groupId)
    val summary = families.list?.firstOrNull { it.id == groupId }
    val state = families.states[groupId]
    val view: FamilyView? = (state as? FamilyState.Accepted)?.view
        // No answer at all: what was accepted last is still what this phone holds open, read only.
        ?: (state as? FamilyState.Failed)?.takeIf { it.words == com.hushos.app.data.FamilyWords.NO_ANSWER }?.let { families.shown[groupId] }
    val joining = state == FamilyState.Waiting || state == FamilyState.Unchecked || (state == null && summary?.state == "accepted")
    var waitTitle by remember { mutableStateOf<String?>(null) }
    val scope = rememberCoroutineScope()
    BackHandler(onBack = onBack)
    LaunchedEffect(groupId) {
        val session = families.begin() ?: return@LaunchedEffect
        if (families.list == null) families.refreshFamilies(session = session) else summary?.let { families.refreshFamily(it, session = session) }
    }
    val me = model.currentVault?.api?.session?.userId.orEmpty()
    val named = families.details[groupId]?.members.orEmpty().filter { it.state == "active" }
    fun served(id: String) = named.firstOrNull { it.userId.equals(id, ignoreCase = true) }
    val organizer = view?.members?.firstOrNull { "billing" in it.roles && !it.userId.equals(me, ignoreCase = true) }?.let { served(it.userId) }?.let { firstNameOf(it.name) }
    // Who this person checked, on this phone (3.8): read again after every finished check of the family and every trust change.
    var standings by remember { mutableStateOf<Map<String, MemberStanding>?>(null) }
    var checkedWith by remember { mutableStateOf<String?>(null) }
    // Observed, not read once: a trust change must start the read again.
    val trust = model.state.collectAsStateWithLifecycle().value.trust
    LaunchedEffect(view?.rosterDigest, families.refreshed[groupId], trust) {
        // Read for the session the page began in: what lands after a sign-out or a switch is dropped, never drawn.
        val session = families.begin() ?: return@LaunchedEffect
        val read = view?.let { shown -> families.run(session) { it.memberStandings(shown) } ?: return@LaunchedEffect }
        val with = families.run(session) { it.checkedFamilyWith(groupId) } ?: return@LaunchedEffect
        standings = read?.getOrNull()
        checkedWith = with.getOrNull()
    }
    /*
     * Check it's {first}, from a row or from Check it's {first} first: an account that changed, or a family check over
     * keys that changed since, takes their own twelve words (6.10); otherwise the family check.
     */
    fun startCheck(ref: FamilyMemberRef, standing: MemberStanding?) {
        if (personalCheck(ref.userId, standing, checkedWith)) model.contactStep = ContactStep.Check(ref.email, ref.name)
        else if (summary != null) families.checking = MemberCheck(summary, ref, served(me)?.name?.let(::firstNameOf) ?: "you", organizer)
    }
    // A manager's page: what the outbox kept sent again, who waits and the open invitations read, at each open.
    val manages = families.manages(groupId)
    LaunchedEffect(groupId, manages, view?.rosterDigest) {
        if (!manages) return@LaunchedEffect
        val session = families.begin() ?: return@LaunchedEffect
        families.loadManaged(groupId, session)
    }
    families.inviting?.takeIf { it.groupId == groupId }?.let { InviteDialog(model, it) }
    families.turningDown?.takeIf { it.first == groupId }?.let { (_, person) -> TurnDownDialog(model, groupId, person, name) }
    families.cancelling?.takeIf { it.first == groupId }?.let { (_, invitation) -> CancelInvitationDialog(model, groupId, invitation) }
    families.roleAsk?.takeIf { it.groupId == groupId }?.let { RoleConfirmDialog(model, it, name) }
    families.checkFirst?.takeIf { it.groupId == groupId }?.let { ask ->
        CheckFirstDialog(model, ask) { families.dismissCheckFirst(); startCheck(ask.member, standings?.get(ask.member.userId.lowercase())) }
    }
    // Remove from family and Delete family folder live in the model too: a removal runs on whatever the page shows.
    families.removal?.takeIf { it.groupId == groupId }?.let { RemoveDialog(model, it, name) }
    families.deletingFolder?.takeIf { it.groupId == groupId }?.let { DeleteFolderDialog(model, it, name) }
    // The leave dialog lives in the model: redrawn as it was after a rotation or a fold, whatever the page shows below it.
    families.leaving?.takeIf { it.groupId == groupId }?.let { LeaveDialog(model, it, name) }
    // A leave that landed: the page moves on, once, whichever composition is on screen when it lands.
    LaunchedEffect(families.leftFamily) {
        if (families.leftFamily == groupId) {
            families.leftFamily = null
            onBack()
        }
    }
    Scaffold(contentWindowInsets = WindowInsets(0), containerColor = alpine.ground, topBar = { DestinationBar(if (joining) waitTitle ?: "Join $name" else name, onBack = onBack) }) { padding ->
        PullToRefreshBox(isRefreshing = families.syncing[groupId] == true, onRefresh = { scope.launch { families.refreshPage(groupId) } }, modifier = Modifier.padding(padding).fillMaxSize()) {
            Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(bottom = AlpineSpace.S8)) {
                when {
                    joining -> JoinContent(model, groupId, name, title = { waitTitle = it }, onJoined = {})
                    view != null -> {
                        Alerts(model, groupId, name, state, organizer)
                        // Someone left (or their account went) and isn't marked left yet: a manager's phone finishes it.
                        if (manages) families.details[groupId]?.due?.markLeft?.takeIf { it.isNotEmpty() }?.let { gone ->
                            // Named as route 3 names them, whatever their state now (they left): the web's firstNames.
                            val everyone = families.details[groupId]?.members.orEmpty()
                            val who = gone.map { id -> everyone.firstOrNull { it.userId.equals(id, ignoreCase = true) }?.name?.let(::firstNameOf) ?: "Someone" }
                            Notice("${namesInWords(who)} left the family. A manager needs to finish that before anyone can join or roles change.",
                                if (families.dueRunning[groupId] == true) "HushOS is finishing it on this device now."
                                else "HushOS finishes it on this device the next time it checks the family.")
                        }
                        KeyChanges(model, groupId, name, view)
                        Folders(view, openFolder, delete = if (manages) { area -> families.askDeleteFolder(groupId, area.workspaceId, area.name ?: "Family folder") } else null)
                        // A manager's: Invite someone, and who waits to be let in (6.8).
                        if (manages) { InviteRow(model, groupId); ManagedError(model, groupId); Waiting(model, groupId, name) }
                        // A handover left half done (billing given, not yet let go of here): the page offers its last step.
                        if (manages) com.hushos.app.data.handoverToFinish(view, me)?.let { other ->
                            served(other)?.let { who -> FinishHandover(model, groupId, FamilyMemberRef(other, who.email.orEmpty(), who.name)) }
                        }
                        Subheader("Members")
                        val iAmOrganizer = view.members.any { it.userId.equals(me, ignoreCase = true) && "billing" in it.roles }
                        for (member in view.members) {
                            val who = served(member.userId)
                            val you = member.userId.equals(me, ignoreCase = true)
                            val standing = standings?.get(member.userId.lowercase())
                            val ref = FamilyMemberRef(member.userId, who?.email.orEmpty(), who?.name ?: "Someone")
                            // A manager's role changes (the web's MemberList menu): managing the family, and the handover.
                            val roles = if (!manages || you || who == null) emptyList() else buildList {
                                val verified = standing == MemberStanding.VERIFIED
                                if ("members" in member.roles) add("Stop them managing the family" to { families.askRole(RoleAsk(groupId, ref, RoleKind.STOP), verified) })
                                else add("Let them manage the family" to { families.askRole(RoleAsk(groupId, ref, RoleKind.MANAGE), verified) })
                                // Not while a handover is left half done: Finish handing over is the way on from there.
                                if (iAmOrganizer && "billing" !in member.roles && com.hushos.app.data.handoverToFinish(view, me) == null)
                                    add("Make them the organizer" to { families.askRole(RoleAsk(groupId, ref, RoleKind.ORGANIZER), verified) })
                            }
                            // Last on a manager's menu (the web's MemberList): Remove from family, or why it can't be done yet.
                            val remove = if (!manages || you || who == null) null
                                else RemoveItem(removeBlocker(member.userId, firstNameOf(who.name), named)) { families.askRemove(groupId, ref, member) }
                            MemberRow(who?.name ?: "Someone", who?.email, member.userId, FamilySync.rolesLine(member.roles), you, standing, roles,
                                busy = families.roleBusy != null, remove = remove) { _ -> startCheck(ref, standing) }
                        }
                        if (manages) Invitations(model, groupId)
                        FamilyPlanSection(model, groupId)
                        TechnicalDetailsRow(view)
                        Leaving(model, groupId, me)
                    }
                    else -> {
                        Alerts(model, groupId, name, state, organizer)
                        if (state == null || families.syncing[groupId] == true) Box(Modifier.fillMaxWidth().padding(AlpineSpace.S8), contentAlignment = Alignment.Center) { LoadingIndicator() }
                        // A family this phone couldn't check (or found shown differently) can still be left, as on the web.
                        else if (summary?.state == "active" && state != FamilyState.Wiped) Leaving(model, groupId, me)
                    }
                }
            }
        }
    }
}

/*
 * Key changes on the family page (the web's KeyChangeNotice): while route 25 says a folder's keys are being replaced (a
 * removal's, a departure's), how far this phone's walk has got; and a walk that stopped, with why and when it is tried
 * again. Everything in the folders stays readable meanwhile, and an upload to a folder waits until its new keys reach it
 * (FamilyUploads.waitingOutKeyChanges), as the web's notice says.
 */
@Composable
private fun KeyChanges(model: DriveViewModel, groupId: String, family: String, view: FamilyView) {
    val running = view.areas.filter { it.rotating }
    val walks = model.families.walks.filterValues { it.groupId == groupId }
    fun nameOf(workspaceId: String) = view.areas.firstOrNull { it.workspaceId.equals(workspaceId, ignoreCase = true) }?.name ?: "A family folder"
    if (running.isNotEmpty()) {
        val done = walks.values.sumOf { it.done }
        val what = if (running.size == 1) "${nameOf(running[0].workspaceId)} is getting new keys." else "${running.size} folders are getting new keys."
        val progress = if (done > 0) " $done ${if (done == 1) "item" else "items"} done so far." else ""
        Info("Replacing keys in the family folders", "$what$progress Everything stays readable meanwhile; an upload to a folder waits until its new keys reach it.")
    }
    for ((workspaceId, walk) in walks) {
        val error = walk.error ?: continue
        Notice("Replacing keys in ${nameOf(workspaceId)} stopped", "$error HushOS tries again the next time it checks $family.")
    }
}

/* A notice in the calm colours, for what is under way rather than wrong (the web's info alert). */
@Composable
private fun Info(title: String, body: String) {
    val alpine = Alpine.colors
    Column(Modifier.fillMaxWidth().padding(horizontal = AlpineSpace.S4, vertical = AlpineSpace.S2).background(alpine.tint, RoundedCornerShape(12.dp)).padding(AlpineSpace.S4),
        verticalArrangement = Arrangement.spacedBy(AlpineSpace.S1)) {
        Text(title, style = MaterialTheme.typography.titleSmall, color = alpine.ink)
        Text(body, style = MaterialTheme.typography.bodyMedium, color = alpine.ink)
    }
}

/*
 * Leaving (route 20, the web's Leaving setting and LeaveDialog): Leave family, disabled with the reason when the member list
 * already shows the server would refuse (the organizer, the last manager), asked once, then this phone forgets the family.
 * The server stays the judge: its refusal shows in the dialog, and lapsed plans it names are said and confirmed by id.
 */
@Composable
private fun Leaving(model: DriveViewModel, groupId: String, me: String) {
    val alpine = Alpine.colors
    val families = model.families
    val members = families.details[groupId]?.members
    LaunchedEffect(groupId, members == null) {
        if (members != null) return@LaunchedEffect
        val session = families.begin() ?: return@LaunchedEffect
        families.loadMembers(groupId, session)
    }
    val blocker = members?.let { FamilySync.leaveBlocker(me, it) }
    Subheader("Leaving")
    Row(Modifier.fillMaxWidth().heightIn(min = 56.dp).padding(start = AlpineSpace.S4, end = AlpineSpace.S2, top = AlpineSpace.S2, bottom = AlpineSpace.S2),
        verticalAlignment = Alignment.CenterVertically) {
        Text(blocker ?: "You’ll lose the family folders. Your own files stay yours.", style = MaterialTheme.typography.bodyMedium, color = alpine.inkMuted,
            modifier = Modifier.weight(1f))
        TextButton(onClick = { families.askLeave(groupId) }, enabled = members != null && blocker == null, modifier = Modifier.heightIn(min = 44.dp)) {
            Text("Leave family", color = if (members != null && blocker == null) alpine.danger else alpine.inkMuted)
        }
    }
}

/*
 * The leave dialog, drawn by the family page from the model's LeaveAsk (so a rotation or a fold redraws it with its
 * request, plans and words), never from the screen's own state.
 */
@Composable
private fun LeaveDialog(model: DriveViewModel, ask: LeaveAsk, family: String) {
    val alpine = Alpine.colors
    val families = model.families
    val alone = families.details[ask.groupId]?.members?.count { it.state == "active" } == 1
    val busy = ask.busy
    val plans = ask.plans
    val error = ask.error
    androidx.compose.material3.AlertDialog(
        onDismissRequest = { families.dismissLeave() },
        title = { Text("Leave $family?") },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(AlpineSpace.S3)) {
                Text(if (alone) "You’re the only one in $family, so leaving ends it. You’ll lose the family folders. Your own files stay yours."
                    else "You’ll lose the family folders. Your own files stay yours.")
                if (plans.isNotEmpty()) Text(com.hushos.app.data.FamilyLapsedPlan.endsWhenYouLeave(family, plans))
                error?.let { Text(it, color = alpine.danger) }
            }
        },
        confirmButton = { TextButton(onClick = { families.confirmLeave(family) }, enabled = !busy) { Text(if (busy) "Leaving" else "Leave family", color = alpine.danger) } },
        dismissButton = { TextButton(onClick = { families.dismissLeave() }, enabled = !busy) { Text("Cancel") } },
    )
}

/* Invite someone: the page's one blue button for a manager (the web's header button). */
@Composable
private fun InviteRow(model: DriveViewModel, groupId: String) {
    Row(Modifier.fillMaxWidth().padding(horizontal = AlpineSpace.S4, vertical = AlpineSpace.S2)) {
        androidx.compose.material3.Button(onClick = { model.families.askInvite(groupId) }, modifier = Modifier.heightIn(min = 44.dp)) { Text("Invite someone") }
    }
}

/* Who waits or the invitations didn't load: why, with Try again; the rows last read stay below. */
@Composable
private fun ManagedError(model: DriveViewModel, groupId: String) {
    val words = model.families.managedErrors[groupId] ?: return
    val scope = rememberCoroutineScope()
    Row(Modifier.fillMaxWidth().padding(start = AlpineSpace.S4, end = AlpineSpace.S2), verticalAlignment = Alignment.CenterVertically) {
        Text(words, style = MaterialTheme.typography.bodyMedium, color = Alpine.colors.danger, modifier = Modifier.weight(1f))
        TextButton(onClick = { scope.launch { model.families.loadManaged(groupId) } }, modifier = Modifier.heightIn(min = 44.dp)) { Text("Try again") }
    }
}

/*
 * Waiting to join (the web's PendingList): each person who accepted, with Let them in (one press, no words) and Not now;
 * someone already in another family can't be let in. An earlier Let them in kept for their keys before their account
 * changed is said, with Drop it and let them in.
 */
@Composable
private fun Waiting(model: DriveViewModel, groupId: String, family: String) {
    val alpine = Alpine.colors
    val families = model.families
    val people = families.waiting[groupId].orEmpty()
    if (people.isEmpty()) return
    Subheader("Waiting to join")
    for (person in people) {
        val row = families.waitingRow(groupId, person.userId)
        val first = firstNameOf(person.name)
        Column(Modifier.fillMaxWidth().padding(horizontal = AlpineSpace.S4, vertical = AlpineSpace.S2)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                PersonAvatar(person.name, person.userId)
                Column(Modifier.weight(1f).padding(start = AlpineSpace.S4)) {
                    Text(person.name, style = MaterialTheme.typography.bodyLarge, maxLines = 1, overflow = TextOverflow.Ellipsis)
                    Text(person.email, style = MaterialTheme.typography.bodyMedium, color = alpine.inkMuted, maxLines = 1, overflow = TextOverflow.Ellipsis)
                    if (person.inFamily) Text("Already in a family", style = MaterialTheme.typography.bodyMedium, color = alpine.inkMuted)
                }
            }
            if (!person.inFamily) Row(Modifier.fillMaxWidth().padding(start = 56.dp, top = AlpineSpace.S2), horizontalArrangement = Arrangement.spacedBy(AlpineSpace.S2)) {
                androidx.compose.material3.OutlinedButton(onClick = { families.askTurnDown(groupId, person) }, enabled = row.busy == null, modifier = Modifier.heightIn(min = 44.dp)) {
                    Text(if (row.busy == "decline") "Turning down" else "Not now")
                }
                androidx.compose.material3.Button(onClick = { families.letIn(groupId, person) }, enabled = row.busy == null && !row.keptOther, modifier = Modifier.heightIn(min = 44.dp)) {
                    Text(if (row.busy == "send") "Letting them in" else "Let them in")
                }
            }
            if (row.keptOther) Column(Modifier.fillMaxWidth().padding(start = 56.dp, top = AlpineSpace.S2).background(alpine.warningSoft, RoundedCornerShape(12.dp)).padding(AlpineSpace.S3),
                verticalArrangement = Arrangement.spacedBy(AlpineSpace.S2)) {
                Text("An earlier Let them in for $first hasn’t reached the server, and it was made before $first’s account changed. Drop it and let $first in again.",
                    style = MaterialTheme.typography.bodyMedium, color = alpine.ink)
                androidx.compose.material3.OutlinedButton(onClick = { families.letIn(groupId, person, dropKept = true) }, enabled = row.busy == null, modifier = Modifier.heightIn(min = 44.dp)) {
                    Text("Drop it and let them in")
                }
            }
            row.error?.let { Text(it, style = MaterialTheme.typography.bodyMedium, color = alpine.danger, modifier = Modifier.padding(start = 56.dp, top = AlpineSpace.S1)) }
        }
    }
}

/* The invitations still open (the web's InvitationList): who, until when, by whom, and Cancel invitation. */
@Composable
private fun Invitations(model: DriveViewModel, groupId: String) {
    val alpine = Alpine.colors
    val families = model.families
    val open = families.invitations[groupId].orEmpty()
    if (open.isEmpty()) return
    val members = families.details[groupId]?.members.orEmpty()
    fun inviter(id: String?) = members.firstOrNull { it.userId.equals(id, ignoreCase = true) }?.let { m -> m.name + (m.email?.let { " ($it)" } ?: "") } ?: "a manager"
    Subheader("Invitations")
    for (invitation in open) {
        Row(Modifier.fillMaxWidth().heightIn(min = 72.dp).padding(start = AlpineSpace.S4, end = AlpineSpace.S2, top = AlpineSpace.S2, bottom = AlpineSpace.S2),
            verticalAlignment = Alignment.CenterVertically) {
            Column(Modifier.weight(1f)) {
                Text(invitation.email ?: "Someone invited", style = MaterialTheme.typography.bodyLarge, maxLines = 1, overflow = TextOverflow.Ellipsis)
                Text("Open until ${dayOf(invitation.expiresAt)}", style = MaterialTheme.typography.bodyMedium, color = alpine.inkMuted)
                Text("Invited by ${inviter(invitation.invitedBy)}", style = MaterialTheme.typography.bodyMedium, color = alpine.inkMuted)
            }
            TextButton(onClick = { families.askCancel(groupId, invitation) }, modifier = Modifier.heightIn(min = 44.dp)) { Text("Cancel invitation", color = alpine.danger) }
        }
    }
}

/* "4 Nov", or "4 Nov 2027" in another year, as the web's formatDay. */
private fun dayOf(iso: String): String = runCatching {
    val at = java.time.Instant.parse(iso).atZone(java.time.ZoneId.systemDefault())
    val pattern = if (at.year == java.time.LocalDate.now().year) "d MMM" else "d MMM yyyy"
    java.time.format.DateTimeFormatter.ofPattern(pattern).format(at)
}.getOrDefault(iso)

/* Invite someone (the web's InviteDialog), drawn from the model's InviteAsk. */
@Composable
private fun InviteDialog(model: DriveViewModel, ask: InviteAsk) {
    val alpine = Alpine.colors
    val families = model.families
    androidx.compose.material3.AlertDialog(
        onDismissRequest = { families.dismissInvite() },
        title = { Text("Invite someone") },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(AlpineSpace.S3)) {
                Text("We’ll email them a link. Once they accept, you let them in.")
                androidx.compose.material3.OutlinedTextField(value = ask.email, onValueChange = { families.typeInvite(it) }, singleLine = true,
                    label = { Text("Email") }, placeholder = { Text("them@example.com") }, isError = ask.error != null, enabled = !ask.busy,
                    keyboardOptions = androidx.compose.foundation.text.KeyboardOptions(keyboardType = androidx.compose.ui.text.input.KeyboardType.Email),
                    supportingText = { Text(ask.error ?: "The invitation is open for 7 days.", color = if (ask.error != null) alpine.danger else alpine.inkMuted) })
            }
        },
        confirmButton = { TextButton(onClick = { families.sendInvite() }, enabled = !ask.busy && ask.email.isNotBlank()) { Text(if (ask.busy) "Sending" else "Send invitation") } },
        dismissButton = { TextButton(onClick = { families.dismissInvite() }, enabled = !ask.busy) { Text("Cancel") } },
    )
}

/* Both organizers after a handover's last step didn't land: the web's words for that state, and the plan's Finish handing over. */
@Composable
private fun FinishHandover(model: DriveViewModel, groupId: String, member: FamilyMemberRef) {
    val who = firstNameOf(member.name)
    Column(Modifier.fillMaxWidth().padding(horizontal = AlpineSpace.S4, vertical = AlpineSpace.S2), verticalArrangement = Arrangement.spacedBy(AlpineSpace.S2)) {
        Text("$who is an organizer now, and so are you still.", style = MaterialTheme.typography.bodyMedium)
        androidx.compose.material3.Button(onClick = { model.families.finishHandingOver(groupId, member) }, enabled = model.families.roleBusy == null,
            modifier = Modifier.heightIn(min = 44.dp)) { Text("Finish handing over to $who") }
    }
}

/* The web's RoleConfirm: what the change means, and its own action. */
@Composable
private fun RoleConfirmDialog(model: DriveViewModel, ask: RoleAsk, family: String) {
    val who = firstNameOf(ask.member.name)
    val (title, body, action) = when (ask.kind) {
        RoleKind.MANAGE -> Triple("Let $who manage the family?", "$who can invite people, let them in and change who manages $family.", "Let them manage")
        RoleKind.STOP -> Triple("Stop $who managing the family?", "$who stays in $family and keeps the family folders, but can’t change who’s in it any more.", "Stop managing")
        RoleKind.ORGANIZER, RoleKind.FINISH -> Triple("Make $who the organizer?", "$who takes over the family’s billing. You keep managing the family.", "Make organizer")
    }
    androidx.compose.material3.AlertDialog(
        onDismissRequest = { model.families.dismissRole() },
        title = { Text(title) },
        text = { Text(body) },
        confirmButton = { TextButton(onClick = { model.families.confirmRole() }) { Text(action) } },
        dismissButton = { TextButton(onClick = { model.families.dismissRole() }) { Text("Cancel") } },
    )
}

/* The manager rule asks for a check first (the web's checkFirst dialog): the check, then Let them manage again. */
@Composable
private fun CheckFirstDialog(model: DriveViewModel, ask: RoleAsk, check: () -> Unit) {
    val who = firstNameOf(ask.member.name)
    androidx.compose.material3.AlertDialog(
        onDismissRequest = { model.families.dismissCheckFirst() },
        title = { Text("Check it’s $who first") },
        text = { Text("Managers can let people in and change the family, so check it’s $who before they manage it. It takes a minute on a call or in person.") },
        confirmButton = { TextButton(onClick = check) { Text("Check it’s $who") } },
        dismissButton = { TextButton(onClick = { model.families.dismissCheckFirst() }) { Text("Cancel") } },
    )
}

@Composable
private fun TurnDownDialog(model: DriveViewModel, groupId: String, person: com.hushos.app.data.PendingPerson, family: String) {
    val alpine = Alpine.colors
    val first = firstNameOf(person.name)
    androidx.compose.material3.AlertDialog(
        onDismissRequest = { model.families.turningDown = null },
        title = { Text("Turn $first down?") },
        text = { Text("They’ll need a new invitation to join $family. To decide later, close this instead: nothing is lost.") },
        confirmButton = { TextButton(onClick = { model.families.turnDown(groupId, person) }) { Text("Turn down", color = alpine.danger) } },
        dismissButton = { TextButton(onClick = { model.families.turningDown = null }) { Text("Cancel") } },
    )
}

@Composable
private fun CancelInvitationDialog(model: DriveViewModel, groupId: String, invitation: com.hushos.app.data.OpenInvitation) {
    val alpine = Alpine.colors
    androidx.compose.material3.AlertDialog(
        onDismissRequest = { model.families.cancelling = null },
        title = { Text(invitation.email?.let { "Cancel the invitation to $it?" } ?: "Cancel this invitation?") },
        text = { Text("The link in their email stops working. You can invite them again.") },
        confirmButton = { TextButton(onClick = { model.families.cancelInvitation(groupId, invitation) }) { Text("Cancel invitation", color = alpine.danger) } },
        dismissButton = { TextButton(onClick = { model.families.cancelling = null }) { Text("Keep invitation") } },
    )
}

/* A member: avatar, name, address, role, "Account changed"; Verified or Not verified at the right; the row's menu checks them. */
@Composable
private fun MemberRow(name: String, email: String?, userId: String, roles: String, you: Boolean, standing: MemberStanding?,
    roleItems: List<Pair<String, () -> Unit>> = emptyList(), busy: Boolean = false, remove: RemoveItem? = null, check: (personal: Boolean) -> Unit) {
    val alpine = Alpine.colors
    var menu by remember { mutableStateOf(false) }
    val checkable = !you && !email.isNullOrEmpty()
    Box(Modifier.fillMaxWidth()) {
        Row(
            Modifier.fillMaxWidth().heightIn(min = 72.dp).then(if (checkable) Modifier.clickable { menu = true } else Modifier)
                .padding(horizontal = AlpineSpace.S4, vertical = AlpineSpace.S2).semantics(mergeDescendants = true) {},
            verticalAlignment = Alignment.CenterVertically,
        ) {
            PersonAvatar(name, userId)
            Column(Modifier.weight(1f).padding(start = AlpineSpace.S4)) {
                Text(if (you) "$name (you)" else name, style = MaterialTheme.typography.bodyLarge, maxLines = 1, overflow = TextOverflow.Ellipsis)
                if (!email.isNullOrEmpty()) Text(email, style = MaterialTheme.typography.bodyMedium, color = alpine.inkMuted, maxLines = 1, overflow = TextOverflow.Ellipsis)
                Text(roles, style = MaterialTheme.typography.bodyMedium, color = alpine.inkMuted)
                if (standing == MemberStanding.CHANGED) Text("Account changed", style = MaterialTheme.typography.bodyMedium, color = alpine.inkMuted)
            }
            if (!you && standing != null && standing != MemberStanding.CHANGED) VerifiedLabel(standing == MemberStanding.VERIFIED, Modifier.padding(start = AlpineSpace.S2))
        }
        // Anchored at the row's end, under it, as the other menus on a row open, never over the next member.
        Box(Modifier.align(Alignment.BottomEnd)) { DropdownMenu(expanded = menu, onDismissRequest = { menu = false }, shape = RoundedCornerShape(16.dp), containerColor = alpine.menu) {
            val first = firstNameOf(name)
            DropdownMenuItem(text = { Text(if (standing == MemberStanding.VERIFIED) "Check again" else "Check it’s $first") }, onClick = {
                menu = false
                check(standing == MemberStanding.CHANGED)
            })
            for ((label, act) in roleItems) DropdownMenuItem(text = { Text(label) }, enabled = !busy, onClick = { menu = false; act() })
            remove?.let { item ->
                DropdownMenuItem(
                    text = {
                        Column {
                            Text("Remove from family", color = if (item.blocked == null) alpine.danger else alpine.inkMuted)
                            item.blocked?.let { Text(it, style = MaterialTheme.typography.bodySmall, color = alpine.inkMuted) }
                        }
                    },
                    enabled = item.blocked == null && !busy, onClick = { menu = false; item.act() },
                )
            }
        } }
    }
}

/* The family's folders: each opens as the Files list, read only; one that didn't open says why, as the web's row. */
@Composable
private fun Folders(view: FamilyView, open: (com.hushos.app.data.NodeView) -> Unit, delete: ((com.hushos.app.data.FamilyArea) -> Unit)? = null) {
    val alpine = Alpine.colors
    Subheader("Family folders")
    if (view.areas.isEmpty()) Column(Modifier.fillMaxWidth().heightIn(min = 56.dp).padding(horizontal = AlpineSpace.S4, vertical = AlpineSpace.S2)) {
        Text("No family folders yet", style = MaterialTheme.typography.bodyLarge)
        Text("Someone who manages the family can make one.", style = MaterialTheme.typography.bodyMedium, color = alpine.inkMuted)
    }
    for (area in view.areas.sortedWith(compareBy(String.CASE_INSENSITIVE_ORDER) { it.name.orEmpty() })) {
        val root = area.root?.takeIf { area.openable }
        Row(Modifier.fillMaxWidth().heightIn(min = 56.dp).then(if (root != null) Modifier.clickable { open(root) } else Modifier)
            .padding(horizontal = AlpineSpace.S4, vertical = AlpineSpace.S2), verticalAlignment = Alignment.CenterVertically) {
            FolderGlyph()
            Column(Modifier.weight(1f).padding(start = AlpineSpace.S4)) {
                Text(area.name ?: "Family folder", style = MaterialTheme.typography.bodyLarge, maxLines = 1, overflow = TextOverflow.Ellipsis)
                Text(area.line, style = MaterialTheme.typography.bodyMedium, color = alpine.inkMuted, maxLines = 2)
            }
            // A manager's: the folder's menu, with Delete family folder (the web's family space row).
            if (delete != null) Box {
                var menu by remember { mutableStateOf(false) }
                IconButton(onClick = { menu = true }) { Icon(Icons.Outlined.MoreVert, "More for ${area.name ?: "Family folder"}", tint = alpine.inkMuted) }
                DropdownMenu(expanded = menu, onDismissRequest = { menu = false }, shape = RoundedCornerShape(16.dp), containerColor = alpine.menu) {
                    DropdownMenuItem(text = { Text("Delete family folder", color = alpine.danger) }, onClick = { menu = false; delete(area) })
                }
            } else if (root != null) Icon(Icons.AutoMirrored.Outlined.KeyboardArrowRight, null, tint = alpine.inkMuted)
        }
    }
}

/* Remove from family on a member's menu: why it can't be done yet (the web's removeBlocker), or what it does. */
class RemoveItem(val blocked: String?, val act: () -> Unit)

/* The web's removeBlocker: the family's only billing holder stays until someone else is the organizer. */
private fun removeBlocker(targetId: String, who: String, members: List<com.hushos.app.data.GroupDetail.Member>): String? {
    val active = members.filter { it.state == "active" }
    val target = active.firstOrNull { it.userId.equals(targetId, ignoreCase = true) } ?: return null
    if ("billing" !in target.roles) return null
    if (active.any { it !== target && "billing" in it.roles }) return null
    return "$who is the only one who manages the family’s plan. Make someone else the organizer first."
}

/* The web's namesInWords: "Sam", "Sam and Maya", "Sam, Maya and Lea". */
private fun namesInWords(names: List<String>): String =
    if (names.size <= 1) names.firstOrNull().orEmpty() else names.dropLast(1).joinToString(", ") + " and " + names.last()

/* The web's RemoveDialog: asked once (and again for a plan it ends), then the removal's steps and what it came to. */
@Composable
private fun RemoveDialog(model: DriveViewModel, sheet: RemovalSheet, family: String) {
    val alpine = Alpine.colors
    val families = model.families
    val who = firstNameOf(sheet.member.name)
    val about = "$who loses the family folders straight away. HushOS replaces their keys, which can take a few minutes."
    val phase = sheet.phase
    val plan = phase as? RemovalPhase.ConfirmPlan
    val asking = phase == RemovalPhase.Confirm || plan != null
    val running = phase is RemovalPhase.Running
    val removed = phase is RemovalPhase.Done && phase.end is com.hushos.app.data.RemovalEnd.Removed
    val demoted = when (phase) { is RemovalPhase.Running -> phase.demote; is RemovalPhase.Done -> phase.demoted; else -> false }
    val finished = when (phase) { is RemovalPhase.Running -> phase.finished; is RemovalPhase.Done -> phase.finished; else -> false }
    val steps = buildList {
        if (demoted) add(com.hushos.app.data.RemovalStep.DEMOTE to "Stopping $who managing the family")
        add(com.hushos.app.data.RemovalStep.HOLD to "Pausing $who’s changes")
        if (finished) add(com.hushos.app.data.RemovalStep.FINISH to "Finishing an earlier key change")
        add(com.hushos.app.data.RemovalStep.REMOVE to "Removing $who")
    }
    val at = (phase as? RemovalPhase.Running)?.let { r -> steps.indexOfFirst { it.first == r.step } } ?: -1
    // One dialog throughout, its contents changing with the phase: never closed and opened again between them (a flicker).
    androidx.compose.material3.AlertDialog(
        onDismissRequest = { families.dismissRemove() },
        title = { Text(when { plan != null -> "Remove $who and end the plan?"; asking -> "Remove $who from $family?"; else -> "Remove $who" }) },
        text = {
            if (asking) Text(plan?.line ?: about)
            else Column(verticalArrangement = Arrangement.spacedBy(AlpineSpace.S3)) {
                Text(about)
                Column(verticalArrangement = Arrangement.spacedBy(AlpineSpace.S2)) {
                    steps.forEachIndexed { index, (_, label) ->
                        val done = removed || (at >= 0 && index < at)
                        val current = index == at
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            Box(Modifier.size(20.dp), contentAlignment = Alignment.Center) {
                                when {
                                    done -> Icon(Icons.Outlined.Check, null, tint = alpine.primary, modifier = Modifier.size(16.dp))
                                    current -> androidx.compose.material3.CircularProgressIndicator(Modifier.size(14.dp), strokeWidth = 2.dp, color = alpine.inkMuted)
                                    else -> Box(Modifier.size(6.dp).background(alpine.inkMuted.copy(alpha = 0.4f), RoundedCornerShape(3.dp)))
                                }
                            }
                            Spacer(Modifier.width(AlpineSpace.S2))
                            Text(label, color = if (current || done) alpine.ink else alpine.inkMuted)
                        }
                    }
                }
                if (phase is RemovalPhase.Done) RemovalOutcome(phase.end, who, family, sheet.member.userId, { id ->
                    families.details[sheet.groupId]?.members?.firstOrNull { it.userId.equals(id, ignoreCase = true) }?.name?.let(::firstNameOf)
                }) { families.runRemove(demote = true) }
                if (phase is RemovalPhase.Error) Text(phase.words, color = alpine.danger)
            }
        },
        confirmButton = {
            when {
                plan != null -> TextButton(onClick = { families.runRemove(plan.demote, plan.ids, plan.carried) }) { Text("Remove and end the plan", color = alpine.danger) }
                asking -> TextButton(onClick = { families.runRemove(demote = false) }) { Text("Remove from family", color = alpine.danger) }
                else -> TextButton(onClick = { families.dismissRemove() }, enabled = !running) { Text(if (removed) "Done" else "Close") }
            }
        },
        dismissButton = when {
            asking -> ({ TextButton(onClick = { families.dismissRemove() }) { Text("Cancel") } })
            phase is RemovalPhase.Error -> ({ TextButton(onClick = { families.runRemove(demote = false) }) { Text("Try again") } })
            else -> null
        },
    )
}

/* What a removal came to, in the web's words (its RemoveDialog's Outcome). */
@Composable
private fun RemovalOutcome(end: com.hushos.app.data.RemovalEnd, who: String, family: String, targetId: String, nameOf: (String) -> String?, demoteThenRemove: () -> Unit) {
    val alpine = Alpine.colors
    when (end) {
        is com.hushos.app.data.RemovalEnd.Removed ->
            Text("$who is no longer in $family. HushOS is replacing the family folders’ keys in the background; you can close this.")
        is com.hushos.app.data.RemovalEnd.Held -> {
            val by = end.heldBy
            // Named only as route 3 names them; nobody is blamed on a guess.
            val holder = by?.takeIf { !it.equals(targetId, ignoreCase = true) }?.let(nameOf)
            if (by == null || !by.equals(targetId, ignoreCase = true) || !end.targetManages)
                Text(holder?.let { "$it paused your changes in $family for now, so $who wasn’t removed. Try again later, or ask $it." }
                    ?: "Your changes in $family are paused for now, so $who wasn’t removed. Try again later, or ask the family’s other managers.")
            else Column(verticalArrangement = Arrangement.spacedBy(AlpineSpace.S2)) {
                Text("$who manages $family too and paused your changes, so you can’t remove them yet. Stop them managing the family first: that ends their pause, then HushOS removes them.")
                TextButton(onClick = demoteThenRemove) { Text("Stop managing, then remove", color = alpine.danger) }
            }
        }
        com.hushos.app.data.RemovalEnd.Changed -> Text("$who isn’t in $family any more, so there was nothing to remove.")
        // Still in the family, not as confirmed: the web's members-changed words, nothing changed.
        com.hushos.app.data.RemovalEnd.Moved -> Text("$family changed while you were working on it. Try again.")
        is com.hushos.app.data.RemovalEnd.Pending -> Text(end.words)
        com.hushos.app.data.RemovalEnd.Wiped -> Text("You’re not in $family any more.")
        is com.hushos.app.data.RemovalEnd.Failed -> Text(end.words, color = alpine.danger)
        // Asked in its own step (ConfirmPlan), never shown as an outcome.
        is com.hushos.app.data.RemovalEnd.EndsLapsed -> {}
    }
}

/* The web's DeleteFamilyFolderDialog: what deleting means for everyone, asked once; its refusal stays on it. */
@Composable
private fun DeleteFolderDialog(model: DriveViewModel, ask: FolderAsk, family: String) {
    val alpine = Alpine.colors
    val families = model.families
    androidx.compose.material3.AlertDialog(
        onDismissRequest = { families.dismissDeleteFolder() },
        title = { Text("Delete “${ask.name}”?") },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(AlpineSpace.S2)) {
                Text("It disappears for everyone in $family now. Its files are deleted from the server, normally after 30 days, and their space is freed when they are. Anyone who kept copies or keys keeps them, as after someone is removed. The folder can’t be restored.")
                ask.error?.let { Text(it, color = alpine.danger) }
            }
        },
        confirmButton = { TextButton(onClick = { families.confirmDeleteFolder() }, enabled = !ask.busy) { Text("Delete", color = if (ask.busy) alpine.inkMuted else alpine.danger) } },
        dismissButton = { TextButton(onClick = { families.dismissDeleteFolder() }, enabled = !ask.busy) { Text("Cancel") } },
    )
}

/* The folder mark the lists draw, without an item. */
@Composable
private fun FolderGlyph() {
    Mark(com.hushos.app.data.Opened(FOLDER_NODE, com.hushos.core.NodeMetadata("", null, null, null, emptyMap())), null, box = 36.dp)
}

private val FOLDER_NODE = com.hushos.app.data.NodeView("", "", null, "folder", 0uL, 0uL, "", 0uL, "", null, null, null, null)

/* Try again on a family that couldn't be checked: the family itself when listed, else the list, in one session. */
private suspend fun tryAgain(families: FamiliesModel, groupId: String) {
    val session = families.begin() ?: return
    families.list?.firstOrNull { it.id == groupId }?.let { families.refreshFamily(it, session = session) } ?: families.refreshFamilies(force = true, session = session)
}

/* What the family's check on this phone found, above everything else on its page. */
@Composable
private fun Alerts(model: DriveViewModel, groupId: String, name: String, state: FamilyState?, organizer: String?) {
    val scope = rememberCoroutineScope()
    when (state) {
        is FamilyState.Fork -> ForkAlert(name, state.fork, organizer)
        is FamilyState.Failed -> Notice("Couldn’t check $name", state.words) {
            TextButton(onClick = { scope.launch { tryAgain(model.families, groupId) } }) { Text("Try again") }
        }
        // The page's words for a removal, as iOS and the web's family page say them; a folder of it says the folder's (FilesScreen).
        FamilyState.Wiped -> Notice("You’re not in $name any more", "What this device kept of the family has been cleared.")
        is FamilyState.Accepted -> {
            val view = state.view
            if (view.ownEntryWrong) Notice("$name has your account wrong on this device", "Ask someone who manages the family to check it’s you, from the family’s page.")
            else if (view.ownEntryBehind) Note("$name still has your account as it was before you updated it. A manager’s device catches up the next time they open the family.")
            for (foreign in view.foreign) Notice(foreign.title(name), foreign.body(name) { owner -> model.families.list?.firstOrNull { it.id == owner }?.name })
            if (view.recordReset) Note("This device’s saved check of $name couldn’t be opened, so HushOS checked the family again from the start.")
        }
        else -> {}
    }
}

/* A notice in the warning colours, never the danger ones (6.11's rule for the hard warning, kept for every family notice). */
@Composable
private fun Notice(title: String, body: String?, action: (@Composable () -> Unit)? = null) {
    val alpine = Alpine.colors
    Column(Modifier.fillMaxWidth().padding(horizontal = AlpineSpace.S4, vertical = AlpineSpace.S2).background(alpine.warningSoft, RoundedCornerShape(12.dp)).padding(AlpineSpace.S4),
        verticalArrangement = Arrangement.spacedBy(AlpineSpace.S1)) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Icon(Icons.Outlined.WarningAmber, null, tint = alpine.warning, modifier = Modifier.size(20.dp))
            Spacer(Modifier.width(AlpineSpace.S2))
            Text(title, style = MaterialTheme.typography.titleSmall, color = alpine.ink)
        }
        body?.let { Text(it, style = MaterialTheme.typography.bodyMedium, color = alpine.ink) }
        action?.invoke()
    }
}

@Composable
private fun Note(text: String) {
    val alpine = Alpine.colors
    Text(text, style = MaterialTheme.typography.bodyMedium, color = alpine.ink,
        modifier = Modifier.fillMaxWidth().padding(horizontal = AlpineSpace.S4, vertical = AlpineSpace.S2).background(alpine.tint, RoundedCornerShape(12.dp)).padding(AlpineSpace.S4))
}

/* The hard warning (6.11, the web's ForkAlert): calm words in the warning colours, with both sides under Technical details. */
@Composable
fun ForkAlert(name: String, fork: FamilyFork, organizer: String?) {
    Notice("$name looks different on this device", "HushOS has paused changes to the family here. Let ${organizer ?: "the others"} know, and check each other from the family page.") {
        TechnicalDetails {
            Text("${if (fork.memberList) "Member list version" else "Family key version"} ${fork.version}", style = MaterialTheme.typography.bodySmall)
            for (side in fork.sides) {
                Text("From ${side.from.joinToString(", ")}", style = MaterialTheme.typography.bodySmall, color = Alpine.colors.inkMuted)
                Text(side.digest, style = MaterialTheme.typography.bodySmall, fontFamily = FontFamily.Monospace)
            }
        }
    }
}

@Composable
private fun TechnicalDetailsRow(view: FamilyView) {
    Column(Modifier.fillMaxWidth().padding(horizontal = AlpineSpace.S4, vertical = AlpineSpace.S2)) {
        TechnicalDetails {
            Text("Member list version ${view.rosterVersion}", style = MaterialTheme.typography.bodySmall)
            Text("Member list digest", style = MaterialTheme.typography.bodySmall, color = Alpine.colors.inkMuted)
            Text(view.rosterDigest, style = MaterialTheme.typography.bodySmall, fontFamily = FontFamily.Monospace)
            Text("Family key version ${view.groupKeyVersion}", style = MaterialTheme.typography.bodySmall)
            Text("Family folders ${view.areas.size}", style = MaterialTheme.typography.bodySmall)
        }
    }
}

/*
 * A family folder, as the Files list (BrowseScreen), opened from the family's page: found through its family's last
 * accepted view, which listed it through the ledger. Read only (BrowseScreen's family gates).
 */
@Composable
fun FamilyFolderScreen(model: DriveViewModel, state: DriveState, groupId: String, rootId: String, workspaceId: String?, onBack: () -> Unit) {
    // The top folder as last opened here, held by the families beside the drive so a rotation or a fold keeps it: a
    // removal or a refusal forgets its row, and the folder stays on screen saying so (BrowseScreen's family problem).
    // This family's own top folder: its workspace's row of the id, never another's (an older route without one checks again).
    val live = workspaceId?.let { model.currentVault?.item(it, rootId) }
    if (live != null) androidx.compose.runtime.SideEffect { model.families.hold(live) }
    val root = live ?: workspaceId?.let { model.families.held(it, rootId) }
    if (root == null) {
        // Not open in this process (a restart, or the family cleared it): the page checks the family again.
        LaunchedEffect(rootId) { onBack() }
        return
    }
    BrowseScreen(model, state, start = root, onLeave = { model.families.release(root.node.workspaceId, rootId); onBack() })
}
