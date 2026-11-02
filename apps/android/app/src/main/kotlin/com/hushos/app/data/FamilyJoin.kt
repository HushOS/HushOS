package com.hushos.app.data

import com.hushos.core.FirstUseJoin
import com.hushos.core.JoinAcceptance
import com.hushos.core.JoinMatched
import com.hushos.core.ServedChain
import com.hushos.core.servedRaceMessage

/*
 * Joining a family on this phone (docs/optional-verification.md 3.2, 3.3, 6.8; iOS's FamilyJoin.swift as #243 rewrote
 * it, the web's lib/groups/join.ts): the newcomer's side over the core's join calls.
 *
 * 1. Invite, Join (route 15): the newcomer waits until route 2 says they were let in.
 * 2. Then the phone joins on first use (`join_first_use`): the core verifies what route 5 serves from version 1 against
 *    every mark this phone and account hold (a rejoin's settings pin, this phone's family guard); with none at all, over
 *    the served version 1 keys, only while this account's entry is active at the head and only with settings that opened
 *    here. Nothing is committed: the core seals a version 4 joins record of the head's pin, kept here first.
 * 3. `accept_joining` with that record commits, holding its pin as one more mark, so a relaunch in between finishes
 *    against the same history. Then the family guard, the device record, the folders and the settings pin are written,
 *    in that order, and the joins record goes.
 *
 * No words on either side: checking each other is for later, from the members list (FamilyCheck.kt).
 */
sealed interface JoinOutcome {
    /* In: the family as the acceptance after the join left it. */
    data class Joined(val state: FamilyState, val revision: Long? = null) : JoinOutcome
    /* This phone already holds the family: nothing to join. */
    data object Member : JoinOutcome
    /* Not let in yet. */
    data object Waiting : JoinOutcome
    /* This person's own marks disagree with what is served: the hard warning. */
    data class Fork(val fork: FamilyFork) : JoinOutcome
}

/* The join's own words, as the web's copy.ts and the join page say them. */
object JoinWords {
    /* The invitation for someone already in a family (one per account; the web's joinInFamilyCopy). */
    fun inFamily(yours: String, invitedTo: String, expiresAt: String) =
        "You’re in $yours. To join $invitedTo, leave yours first, from its page. This invitation stays open until ${day(expiresAt)}."

    /* "26 October", as the web's en-GB day and month. */
    fun day(iso: String): String = runCatching {
        java.time.format.DateTimeFormatter.ofPattern("d MMMM", java.util.Locale.UK).format(java.time.Instant.parse(iso).atZone(java.time.ZoneId.systemDefault()))
    }.getOrDefault(iso)

    /* A refusal of the invitation routes, as the web's errorCopy words it for the join page; `family` is the family invited to. */
    fun refusal(error: Throwable, family: String? = null): String {
        if (error !is GroupsApiError || error.status == 0 || error.code == null) return FamilyWords.error(error)
        return when (error.code) {
            "gone" -> "This invitation is no longer open. Ask for a new one."
            "email-mismatch" -> "This invitation is for another email address. Sign in with that one."
            "already-member" -> "That person is already in the family."
            "in-family" -> if (error.reason == "newcomer") "They’ve joined another family since they accepted. They can join yours once they leave it."
                else error.family?.let { "You’re in ${it.name}. Leave it before you create another." } ?: "You’re in a family already. Leave it before you create another."
            "no-plan" -> if (error.invitee) "${family ?: "This family"} can’t take anyone new right now. Ask whoever invited you; this invitation works again once the family has a plan."
                else "Choose a plan for ${family ?: "this family"} first. Until it has one, nobody can be invited and no family folders can be made."
            "unsupported" -> "Update HushOS to do this."
            "rate-limited" -> "That’s been tried too often. Wait a little, then try again."
            "not-member" -> FamilyWords.NOT_IN_FAMILY
            "unavailable" -> "HushOS couldn’t save that just now. Try again in a moment."
            else -> FamilyWords.error(error)
        }
    }
}

/*
 * What the invitation sheet says under the invitation and whether Join is offered (route 14's answer and route 15's
 * refusal; the web's routes/join/route.tsx). One family per account: someone in a family is told to leave theirs first,
 * and Join is off; an `in-family` refusal that names no family is said in the web's error words, Join off too.
 */
data class InvitationNotice(val note: Note?, val canAccept: Boolean) {
    sealed interface Note {
        data class InFamily(val words: String, val yours: Invitation.Family) : Note
        data object AlreadyMember : Note
        data class Problem(val words: String) : Note
    }

    companion object {
        fun of(invitation: Invitation, refusal: GroupsApiError?, email: String?): InvitationNotice {
            val code = refusal?.code
            (invitation.inFamily ?: refusal?.family?.takeIf { code == "in-family" })?.let { yours ->
                return InvitationNotice(Note.InFamily(JoinWords.inFamily(yours.name, invitation.name, invitation.expiresAt), yours), false)
            }
            refusal ?: return InvitationNotice(null, true)
            return when (code) {
                "already-member" -> InvitationNotice(Note.AlreadyMember, true)
                "in-family" -> InvitationNotice(Note.Problem(JoinWords.refusal(refusal, invitation.name)), false)
                "email-mismatch" -> InvitationNotice(Note.Problem("This invitation is for another email address than ${email ?: "this one"}. Sign in with that one."), false)
                else -> InvitationNotice(Note.Problem(JoinWords.refusal(refusal, invitation.name)), true)
            }
        }
    }
}

/*
 * Where this phone's join of `groupId` stands, for the join screen to resume at: waiting to be let in, joined now (on
 * first use, or a join a relaunch cut short, finished here), or Member when this phone already holds the family.
 */
fun FamilySync.joinStatus(groupId: String): JoinOutcome {
    if (!FamilyRecords.valid(groupId)) throw FamilyFailure("Please try again.")
    val summary = list().firstOrNull { it.id == groupId && it.state == "active" } ?: return JoinOutcome.Waiting
    vault.prepareLedger()
    // Kept before acceptance: a relaunch finishes from it.
    records.readJoins(userId, groupId)?.let { joins ->
        vault.familyPin(groupId)
        return exclusive(groupId) { (finishedBefore(summary) ?: resume(groupId, joins)).revised(this) }
    }
    if (records.read(userId, groupId) != null) return JoinOutcome.Member
    // Read first, so the ledger holds the settings' pin of the family (a rejoin's mark).
    vault.familyPin(groupId)
    return exclusive(groupId) { (finishedBefore(summary) ?: firstUse(groupId, fetchServed(groupId, 0uL))).revised(this) }
}

/* `join_first_use` over `served`, then its commit; for a caller already in the family's turn. */
private fun FamilySync.firstUse(groupId: String, served: ServedChain): JoinOutcome {
    val me = vault.ownIdentities()
    while (true) {
        when (val joined = ledger.joinFirstUse(me, groupId, records.read(userId, groupId)?.envelope, served, vault.heldFamilyGuard(groupId), FamilySync.checkTime(now()))) {
            is FirstUseJoin.RecordUnreadable -> { vault.forgetWorkspaces(knownAreas(groupId)); records.delete(userId, groupId); sweepCopies() }
            // Active on route 2 but not on the member list it serves yet: still waiting.
            is FirstUseJoin.NotAdmitted -> return JoinOutcome.Waiting
            is FirstUseJoin.Fork -> return JoinOutcome.Fork(FamilySync.fork(joined.of, joined.version, joined.sides))
            is FirstUseJoin.Ready -> {
                // Kept before acceptance: a relaunch between the two finishes from here, over the same served chain.
                records.putJoins(userId, groupId, joined.matched.record())
                return acceptJoin(groupId, served, joined.matched, orFirstUse = false)
            }
        }
    }
}

/*
 * An earlier finish wrote the device record and stopped before the joins record went: the record is a mark now, so this
 * is a sync, and the joins record goes. With no device record, a join this session committed but couldn't keep (its
 * guard or record not stored) is let go of in the core first, storing the guard it hands back, so the join runs again
 * from a clean session. Null when the join goes on.
 */
private fun FamilySync.finishedBefore(summary: GroupSummary): JoinOutcome? {
    if (records.read(userId, summary.id) == null) {
        if (!forgetInCore(summary.id)) throw FamilyFailure("The family could not be checked. Try again.")
        return null
    }
    return when (val state = run(summary)) {
        is FamilyState.Accepted -> { records.deleteJoins(userId, summary.id); JoinOutcome.Joined(state) }
        is FamilyState.Fork -> JoinOutcome.Fork(state.fork)
        // A record that did not open and no pin: the join goes on.
        FamilyState.Unchecked -> null
        is FamilyState.Failed -> throw FamilyFailure(state.words)
        FamilyState.Waiting, FamilyState.Wiped -> JoinOutcome.Waiting
    }
}

/* A relaunch finishing a join: from the joins record, against what route 5 serves now. */
private fun FamilySync.resume(groupId: String, joins: String): JoinOutcome {
    val served = fetchServed(groupId, 0uL)
    // Another account's, an older version's, or sealed under an earlier account root: it goes, and the join is a first use.
    val matched = ledger.joinMatchedOpen(groupId, joins) ?: run {
        records.deleteJoins(userId, groupId)
        return firstUse(groupId, served)
    }
    return acceptJoin(groupId, served, matched, orFirstUse = true)
}

/*
 * The family taken with the joins record's pin as one more mark; then the family guard it hands back (before anything
 * else: a crash between it and the record leaves the guard above the record, never below), the device record, the
 * folders and the settings pin as after any acceptance, and the joins record goes. A guard or record that can't be kept
 * lets the core go of the family too, or its chain would count as a mark this phone can't show.
 */
private fun FamilySync.acceptJoin(groupId: String, first: ServedChain, matched: JoinMatched, orFirstUse: Boolean): JoinOutcome {
    val me = vault.ownIdentities()
    var served = first
    var overtaken = 0
    while (true) {
        // The write barrier, as for a sync's acceptance.
        val owedBefore = vault.oweFamilyGuard(groupId)
        val result = try {
            ledger.acceptJoining(me, groupId, records.read(userId, groupId)?.envelope, served, matched, vault.heldFamilyGuard(groupId))
        } catch (error: Exception) {
            if (!owedBefore) vault.familyGuardKept(groupId)
            throw error
        }
        if (result !is JoinAcceptance.Accepted && !owedBefore) vault.familyGuardKept(groupId)
        when (result) {
            is JoinAcceptance.RecordUnreadable -> { vault.forgetWorkspaces(knownAreas(groupId)); records.delete(userId, groupId); sweepCopies() }
            is JoinAcceptance.Overtaken -> {
                // Another acceptance moved the family on meanwhile: read the member list again, as a sync does.
                if (++overtaken >= 3) throw FamilyFailure(servedRaceMessage(result.split))
                served = fetchServed(groupId, 0uL)
            }
            is JoinAcceptance.Changed -> {
                // An earlier release's join code that no longer holds: it vouches for nothing here, and goes.
                records.deleteJoins(userId, groupId)
                if (orFirstUse) return firstUse(groupId, served)
                throw FamilyFailure("The family could not be checked. Try again.")
            }
            is JoinAcceptance.NotAdmitted -> return JoinOutcome.Waiting
            is JoinAcceptance.Fork -> return JoinOutcome.Fork(FamilySync.fork(result.of, result.version, result.sides))
            is JoinAcceptance.Accepted -> {
                // Its folders held for the barrier before the guard is stored, as a sync's acceptance holds them: a guard
                // that can't be stored keeps writes into them (a share mounted there) refused. Never a family folder by it.
                vault.holdAsFamilyWorkspaces(result.chain.areaKeys().keys, groupId)
                try {
                    result.guard?.let { vault.keepFamilyGuard(groupId, it) }
                    vault.familyGuardKept(groupId)
                    records.put(userId, groupId, FamilyRecords.Row(result.record, result.chain.roster().rosterVersion, keptAreas(groupId, result.chain.areaKeys().keys)))
                } catch (error: Exception) {
                    // A wipe the core refuses keeps its floor; the store's error is the answer.
                    runCatching { forgetInCore(groupId) }
                    throw error
                }
                noteAccepted(groupId, result.chain)
                val state = try {
                    afterAcceptance(groupId, result.chain, result.pin, reset = false)
                } catch (error: GroupsApiError) {
                    // Removed between the acceptance and the member list: let go of as a sync's not-member is, and refused
                    // when the wipe can't finish (its guard not stored), so nothing of it stays open meanwhile.
                    if (error.isNotMember) {
                        val wiped = runCatching { wipe(groupId) }.onFailure { refuse(groupId) }
                        publishRemovals(listOf(FamilySync.Revised(if (wiped.isSuccess) FamilyState.Wiped else FamilyState.Failed(FamilyWords.error(wiped.exceptionOrNull()!!), removal = true), revise(), groupId)))
                    }
                    throw error
                }
                if (state is FamilyState.Fork) return JoinOutcome.Fork(state.fork)
                records.deleteJoins(userId, groupId)
                return JoinOutcome.Joined(state)
            }
        }
    }
}

/* A join's family state with the revision it took inside the family's turn, ordered with every sync's and check's. */
private fun JoinOutcome.revised(sync: FamilySync): JoinOutcome = if (this is JoinOutcome.Joined) copy(revision = sync.revise()) else this
