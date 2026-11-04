package com.hushos.app.data

import java.io.File

/*
 * Where Save to HushOS may put what was shared: your own drive, and the folders of each family you are an accepted member
 * of (iOS's SaveTargets). Every family answer comes from this sheet's own sync of the family (a job's, which never sweeps
 * the app's family copies), and only while the session it began in still stands: an account switched or signed out
 * mid-sheet lists, opens and queues nothing. A family is offered only once its sync accepts it, and only its folders this
 * phone may write in (keys checked at their latest version, top folder opened), never the trash. Before anything is
 * queued into a family folder the family is checked again; a removal, a refusal or a folder that no longer opens stops it
 * in the family's own words, nothing queued. The queued upload is the app's family upload (TransferQueue's family, its
 * job opening the family again before it seals).
 */
class SaveTargets(private val vault: Vault, private val families: FamilySync, private val session: () -> Shared.Session?) {
    /* A family as the picker lists it: its name, then its folders by name. */
    data class Family(val groupId: String, val name: String, val folders: List<Places.Folder>)

    /* The sheet's session ended or another account signed in: nothing more is listed, opened or queued. */
    class SessionEnded : Exception("Sign in to HushOS in the app first.")

    /* Whether the session this sheet began in is still the one signed in. */
    fun stands(): Boolean {
        val now = session() ?: return false
        val mine = vault.api.session
        return !vault.closed && now.token == mine.token && now.userId.equals(mine.userId, ignoreCase = true) && now.origin == mine.origin
    }

    private fun requireStands() { if (!stands()) throw SessionEnded() }

    /*
     * Every family this account is an accepted member of, with the folders it may save into; a family that doesn't sync
     * (no answer, a refusal, a fork, not let in yet) or has no such folder isn't offered. The list itself failing throws.
     */
    fun families(): List<Family> {
        requireStands()
        val listed = families.list()
        val found = listed.mapNotNull { summary ->
            val view = (families.sync(summary) as? FamilyState.Accepted)?.view ?: return@mapNotNull null
            val folders = view.areas.mapNotNull { area -> folderOf(summary.id, area) }.sortedBy { it.name.lowercase() }
            if (folders.isEmpty()) null else Family(summary.id, summary.name, folders)
        }
        requireStands()
        return found.sortedBy { it.name.lowercase() }
    }

    private fun folderOf(groupId: String, area: FamilyArea): Places.Folder? {
        val root = area.root?.takeIf { area.openable && area.write == AreaWrite.WRITABLE } ?: return null
        return Places.Folder(root.id, area.name ?: return null, groupId, area.workspaceId.lowercase())
    }

    /*
     * `target`'s folders, for the picker (none in the trash, by name). A family folder's are listed in its family's
     * workspace, through the ledger, once the family is checked again.
     */
    fun folders(target: Places.Folder): List<Opened> = open(target).filter { it.isFolder && it.node.trashedAt == null }.sortedBy { it.name.lowercase() }

    /*
     * `target` opened to save into, and what it holds: your own drive's folder as it is; a family folder only once its
     * family syncs accepted here, the folder is one of that family's that this phone may write in (and its workspace the
     * family's), and the folder is still there out of the trash. Anything else throws, in the family's words.
     */
    fun open(target: Places.Folder): List<Opened> {
        requireStands()
        val family = target.family ?: return vault.listChildren(target.id).also { requireStands() }
        val summary = families.list().firstOrNull { it.id.equals(family.groupId, ignoreCase = true) }
        // Not listed: only the server's not-member is a removal (and wipes it, as every sync's does); anything else can't be checked now.
        if (summary == null) throw if (families.notMember(family.groupId)) FamilyFailure.notInFamily else FamilyFailure(FamilyWords.COULDNT_CHECK_KEYS)
        val view = when (val state = families.sync(summary)) {
            is FamilyState.Accepted -> state.view
            is FamilyState.Failed -> throw if (state.transient) Unreachable() else FamilyFailure(state.words)
            else -> throw FamilyFailure(FamilySync.checkWordsOf(state))
        }
        val area = view.areas.firstOrNull { it.workspaceId.equals(family.workspaceId, ignoreCase = true) }
            ?: throw NotFound("This folder no longer exists.")
        if (!area.openable || area.write != AreaWrite.WRITABLE) throw FamilyFailure(area.line)
        if (!vault.isFamilyWorkspace(family.workspaceId) || vault.familyOf(family.workspaceId)?.equals(family.groupId, ignoreCase = true) != true) {
            throw FamilyFailure(FamilyWords.COULDNT_CHECK_KEYS)
        }
        // The listing opens the folder's own row too (its page's): one that isn't a folder of this workspace, or is in the trash, isn't saved into.
        val children = vault.listChildren(target.id, family.workspaceId)
        val folder = vault.item(family.workspaceId, target.id)
        if (folder == null || !folder.isFolder || folder.node.trashedAt != null) throw NotFound("This folder no longer exists.")
        requireStands()
        return children
    }

    /* One thing to queue: the sheet's copy, the name it goes under (made free in `save`), its type. */
    data class Outgoing(val copy: File, val name: String, val mime: String?)

    /*
     * The shared copies queued into `target`, each under a name the folder doesn't have yet, a family folder's as the
     * family's upload (its group and the folder's own workspace). The folder is opened (and a family checked) first, and
     * the session checked again right before the queue takes them. Returns the names queued.
     */
    fun save(target: Places.Folder, items: List<Outgoing>, queue: (File, String, String?, String, TransferQueue.Family?) -> Unit): List<String> {
        // Your own drive's folder: offline, its names aren't known and the queue waits for a connection, as before. A family
        // folder is never queued unchecked.
        val listed = if (target.family != null) open(target) else runCatching { open(target) }.getOrElse { if (it is SessionEnded) throw it; emptyList() }
        val taken = listed.filter { !it.isFolder }.map { it.name.lowercase() }.toMutableSet()
        requireStands()
        return items.map { item ->
            val name = UploadNames.freeName(item.name, taken).also { taken.add(it.lowercase()) }
            queue(item.copy, name, item.mime, target.id, target.family)
            name
        }
    }
}
