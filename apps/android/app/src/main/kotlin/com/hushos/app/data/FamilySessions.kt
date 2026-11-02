package com.hushos.app.data

import java.util.concurrent.ConcurrentHashMap

/*
 * What this process knows of a session's families, shared by every Vault of that session: the app's, the Files app's
 * provider's, and each transfer job's (jobVault). A proof, a refusal, a removal or a guard owed that one of them learns
 * is seen by all, so a job's vault never keeps, downloads or writes what the app's vault already let go of. Every
 * change and every check that must agree with it is made under FamilyCopies.LOCK.
 */
class FamilySessionState internal constructor(val userId: String) {
    /* Each family folder route 25 named this session (or a device record kept from an earlier one), lowercase, to its family. */
    val areas = ConcurrentHashMap<String, String>()
    /* The write barrier's hold: each folder an accepted member list named, to every family that named it. */
    val held = ConcurrentHashMap<String, MutableSet<String>>()
    /* Each family folder's invalidation: a count and the family's words, moved by every forget. */
    val epochs = ConcurrentHashMap<String, Pair<Long, String>>()
    /*
     * The guards owed, each acceptance's its own (GuardDebt), by family: the barrier is up over a family while any is
     * owed. An acceptance discharges only its own; one left owed by a failed store goes only once a stored guard covers
     * it, or its own vault's core lets the family go. Shared by every vault of the session, whose acceptances run apart.
     */
    val guardDebts = ConcurrentHashMap<String, MutableSet<GuardDebt>>()
    /* Ids whose copies a family's proof deleted, until the screens drop them. */
    val purged: MutableSet<String> = ConcurrentHashMap.newKeySet()
    /* The session ended (a sign-out, a lost session, another sign-in): nothing of it is written again, by any of its vaults. */
    @Volatile var closed = false
        internal set
    /* Whether the device records' folders were read in (a job's process may start without the app's). */
    @Volatile internal var seeded = false
}

/*
 * One acceptance's guard debt: raised before its core commits, by `owner` (the vault whose core it is). `left` is the pin
 * its core handed back and couldn't be stored: set, the debt outlives the acceptance until a stored guard covers it.
 */
class GuardDebt internal constructor(val groupId: String, val owner: Any) {
    @Volatile var left: com.hushos.core.GroupPin? = null
        internal set
}

object FamilySessions {
    private val current = ConcurrentHashMap<String, FamilySessionState>()

    private fun key(session: Shared.Session) = session.userId.lowercase() + "|" + session.token

    /* The session's state now: the one every live vault of it shares, or a fresh one once the last was closed. */
    fun of(session: Shared.Session): FamilySessionState = synchronized(FamilyCopies.LOCK) {
        val held = current[key(session)]
        if (held != null && !held.closed) return held
        FamilySessionState(session.userId.lowercase()).also { current[key(session)] = it }
    }
}
