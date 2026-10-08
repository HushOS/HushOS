package com.hushos.app.ui

import com.hushos.app.data.Opened

/*
 * Who this account has given an item to: people by first name with whether they can edit, and
 * live links. `ids` holds each first name's account id, so their avatar keeps its colour.
 */
data class Access(val people: List<Pair<String, Boolean>>, val links: Int, val ids: Map<String, String> = emptyMap()) {
    val shared get() = people.isNotEmpty() || links > 0
}

/* What a row says about who can open it. */
sealed interface WhoCanOpen {
    data object OnlyYou : WhoCanOpen
    data object SameAsFolder : WhoCanOpen
    data object AnyoneWithLink : WhoCanOpen
    data class People(val people: List<Pair<String, Boolean>>) : WhoCanOpen
}

/*
 * Rows say who can open them only when it is known: once this session has the
 * account's shares and links, and only for items in the account's own drive
 * (a folder someone shared with you is theirs to describe). Otherwise the row
 * says nothing about it rather than guess "Only you".
 */
fun whoCanOpen(model: DriveViewModel, state: DriveState, item: Opened): WhoCanOpen? {
    val access = state.access ?: return null
    val own = state.rootId?.let { model.item(it) }?.node?.workspaceId ?: return null
    if (item.node.workspaceId != own) return null
    access[item.id]?.takeIf { it.shared }?.let { mine ->
        return if (mine.links > 0) WhoCanOpen.AnyoneWithLink else WhoCanOpen.People(mine.people)
    }
    return if (sharedAbove(model, access, item) != null) WhoCanOpen.SameAsFolder else WhoCanOpen.OnlyYou
}

/* The nearest folder above `item` (or `item` itself, when `self`) that this account shared, with its access. */
fun sharedAbove(model: DriveViewModel, access: Map<String, Access>, item: Opened, self: Boolean = false): Pair<Opened, Access>? {
    if (self) access[item.id]?.takeIf { it.shared }?.let { return item to it }
    var cursor = item.node.parentId
    var steps = 0
    while (cursor != null && steps++ < 256) {
        val folder = model.item(cursor) ?: return null
        access[folder.id]?.takeIf { it.shared }?.let { return folder to it }
        cursor = folder.node.parentId
    }
    return null
}

/* "Only you", "Sam can edit", "Sam, Priya and Erik", "Anyone with the link", "Same as folder". */
fun WhoCanOpen.label(): String = when (this) {
    WhoCanOpen.OnlyYou -> "Only you"
    WhoCanOpen.SameAsFolder -> "Same as folder"
    WhoCanOpen.AnyoneWithLink -> "Anyone with the link"
    is WhoCanOpen.People -> if (people.size == 1) "${people[0].first} can ${if (people[0].second) "edit" else "view"}" else names(people.map { it.first })
}

/* "Sam", "Sam and Priya", "Sam, Priya and Erik". */
fun names(list: List<String>): String = when (list.size) {
    0 -> ""
    1 -> list[0]
    else -> list.dropLast(1).joinToString(", ") + " and " + list.last()
}

/* The banner over a folder this account shared: "You, Sam and Priya can open everything in this folder." */
fun bannerText(access: Access): String {
    val who = listOf("You") + access.people.map { it.first } + if (access.links > 0) listOf("anyone with the link") else emptyList()
    return "${names(who)} can open everything in this folder."
}

/*
 * Who can open an item, as a whole sentence with you first, for Info and other detail lists:
 * "Only you", "You and Sam", "You, Sam and anyone with the link". Its own sharing, or the folder's
 * it sits in; someone else's item says whose it is.
 */
fun whoCanOpenSentence(model: DriveViewModel, state: DriveState, item: Opened): String? {
    receivedVia(model, state, item)?.let { mount -> return "Shared by " + mount.share.granterName.ifEmpty { mount.share.granterEmail } }
    val access = state.access ?: return null
    val own = state.rootId?.let { model.item(it) }?.node?.workspaceId ?: return null
    if (item.node.workspaceId != own) return "Shared with you"
    val who = access[item.id]?.takeIf { it.shared } ?: sharedAbove(model, access, item)?.second ?: return "Only you"
    return names(listOf("You") + who.people.map { it.first } + if (who.links > 0) listOf("anyone with the link") else emptyList())
}
