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
import androidx.compose.material.icons.outlined.WarningAmber
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
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
    LaunchedEffect(view?.rosterDigest, families.refreshed[groupId], model.state.value.trust) {
        // Read for the session the page began in: what lands after a sign-out or a switch is dropped, never drawn.
        val session = families.begin() ?: return@LaunchedEffect
        val read = view?.let { shown -> families.run(session) { it.memberStandings(shown) } ?: return@LaunchedEffect }
        val with = families.run(session) { it.checkedFamilyWith(groupId) } ?: return@LaunchedEffect
        standings = read?.getOrNull()
        checkedWith = with.getOrNull()
    }
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
        PullToRefreshBox(isRefreshing = families.syncing[groupId] == true, onRefresh = { scope.launch { families.refreshFamilies(force = true) } }, modifier = Modifier.padding(padding).fillMaxSize()) {
            Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(bottom = AlpineSpace.S8)) {
                when {
                    joining -> JoinContent(model, groupId, name, title = { waitTitle = it }, onJoined = {})
                    view != null -> {
                        Alerts(model, groupId, name, state, organizer)
                        KeyChanges(model, groupId, name, view)
                        Folders(view, openFolder)
                        Subheader("Members")
                        for (member in view.members) {
                            val who = served(member.userId)
                            val you = member.userId.equals(me, ignoreCase = true)
                            val standing = standings?.get(member.userId.lowercase())
                            MemberRow(who?.name ?: "Someone", who?.email, member.userId, FamilySync.rolesLine(member.roles), you, standing) { mine ->
                                val ref = FamilyMemberRef(member.userId, who?.email.orEmpty(), who?.name ?: "Someone")
                                // An account that changed, or a family check over keys that changed since: their own twelve words (6.10).
                                if (mine || (checkedWith?.equals(member.userId, ignoreCase = true) == true && standing != MemberStanding.VERIFIED)) model.contactStep = ContactStep.Check(ref.email, ref.name)
                                else if (summary != null) families.checking = MemberCheck(summary, ref, served(me)?.name?.let(::firstNameOf) ?: "you", organizer)
                            }
                        }
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

/* A member: avatar, name, address, role, "Account changed"; Verified or Not verified at the right; the row's menu checks them. */
@Composable
private fun MemberRow(name: String, email: String?, userId: String, roles: String, you: Boolean, standing: MemberStanding?, check: (personal: Boolean) -> Unit) {
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
        } }
    }
}

/* The family's folders: each opens as the Files list, read only; one that didn't open says why, as the web's row. */
@Composable
private fun Folders(view: FamilyView, open: (com.hushos.app.data.NodeView) -> Unit) {
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
            if (root != null) Icon(Icons.AutoMirrored.Outlined.KeyboardArrowRight, null, tint = alpine.inkMuted)
        }
    }
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
