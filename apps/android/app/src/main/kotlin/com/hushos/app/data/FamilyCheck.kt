package com.hushos.app.data

import com.hushos.core.FamilyCheck
import com.hushos.core.GuardState
import com.hushos.core.PairCode
import com.hushos.core.PinKeys
import com.hushos.core.pairCode
import com.hushos.core.rosterDigest
import java.time.Instant

/*
 * Who in a family this person checked, and Check it's Sam in a family (docs/optional-verification.md 3.4, 3.8, 6.9,
 * 6.10; iOS's FamilyCheck.swift, the web's lib/family-trust.ts and family-check.tsx). Per viewer, never shared:
 * everything reads this account's own settings pins and this phone's contact guard beside the member list this phone
 * accepted. Every rule is the core's (`pair_code`, `pair_match`).
 */

/* How the member list reads a member (3.8). */
enum class MemberStanding { VERIFIED, NOT_VERIFIED, CHANGED }

/* The words of a family check, or why there are none. */
sealed interface FamilyCheckCode {
    /* The twelve words over the roster at `rosterVersion`, with that roster's digest for Technical details. */
    data class Code(val rosterVersion: ULong, val code: List<String>, val rosterDigest: String?) : FamilyCheckCode
    /* This phone's own entry was wrong at that roster: no words; their own twelve words instead. */
    data object OwnEntryWrong : FamilyCheckCode
    /* One of the two isn't in the family on this phone yet. */
    data object NotAdmitted : FamilyCheckCode
}

/* A member as route 3 names them, for the check's words and the pin it may write. */
data class FamilyMemberRef(val userId: String, val email: String, val name: String)

/* What opening Check it's Sam found: the family as its sync left it, and the words, or why there are none. */
data class CheckStart(val state: FamilyState, val code: FamilyCheckCode?, val problem: String?, val revision: Long? = null)

/*
 * Each member's standing on this phone (3.8): VERIFIED only when this account's own verified pin of them (no
 * `trustedVia`) agrees with the guard and its key commitment is their entry's now, which is also the manager rule (3.6);
 * CHANGED when the pin disagrees with the guard; anything else not verified. One guarded read: the verdict and the keys
 * compared with the entry are the same pin's. A guard that can't be read throws: nobody is shown verified.
 */
fun FamilySync.memberStandings(view: FamilyView): Map<String, MemberStanding> {
    val standings = vault.guardedStandings()
    return view.members.filter { !it.userId.equals(userId, ignoreCase = true) }.associate { member ->
        val id = member.userId.lowercase()
        val (pin, standing) = standings[id] ?: return@associate id to MemberStanding.NOT_VERIFIED
        id to when {
            standing.changed -> MemberStanding.CHANGED
            standing.verified && pin.trustedVia == null && pin.verified && pin.commitment != null && pin.commitment == member.commitment -> MemberStanding.VERIFIED
            else -> MemberStanding.NOT_VERIFIED
        }
    }
}

/*
 * The family check's words with `memberId` (6.10, "Getting the latest" first): the family synced to the server's head,
 * then the pair code over the chain this phone committed, with the roster's digest for Technical details. The sync's
 * outcome comes back whatever it was, so the screens adopt it (a fork or a removal it found clears what this phone opened).
 */
fun FamilySync.checkCode(summary: GroupSummary, memberId: String): CheckStart {
    val (state, revision) = syncRevised(summary)
    FamilySync.checkProblem(state)?.let { return CheckStart(state, null, it, revision) }
    val chain = acceptedChain(summary.id) ?: return CheckStart(state, null, GuardWords.UNREADABLE, revision)
    // Its own read of the member list: a not-member here is a removal, let go of and shown as a sync's.
    val served = try {
        fetchServed(summary.id, 0uL)
    } catch (error: GroupsApiError) {
        if (!error.isNotMember) throw error
        val removed = removedNow(summary.id)
        return CheckStart(removed.state, null, FamilySync.checkProblem(removed.state), removed.revision)
    }
    val code = when (val pair = pairCode(chain, vault.ownIdentities(), memberId.lowercase(), served.rosters)) {
        is PairCode.Code -> FamilyCheckCode.Code(pair.rosterVersion, pair.code,
            served.rosters.getOrNull(pair.rosterVersion.toInt() - 1)?.let { rosterDigest(it.statement) })
        is PairCode.OwnEntryWrong -> FamilyCheckCode.OwnEntryWrong
        is PairCode.NotAdmitted -> FamilyCheckCode.NotAdmitted
    }
    return CheckStart(state, code, null, revision)
}

/*
 * They match (3.4): what the core allows (`pair_match`, over the chain the ledger committed and this phone's guard entry
 * for them), saved in one settings write. `checked` false when the codes no longer match here: nothing saved. The check
 * record and the first-use marker go in that same save (7.2); a verified pin of them only when the core found their
 * entry's keys the very ones compared and the ones this phone holds for them, committed as every trust-changing act is.
 * Returns (checked, verified).
 */
fun FamilySync.checkMatch(groupId: String, member: FamilyMemberRef, rosterVersion: ULong, code: List<String>): Pair<Boolean, Boolean> {
    // Read first, so the ledger holds the settings pin of them it compares with.
    vault.familyPin(groupId)
    val (held, revision) = vault.contactGuardState(member.userId)
    // A not-member here is a removal: let go of as a sync's, and passed on so the sheet shows the family wiped.
    val served = try {
        fetchServed(groupId, 0uL)
    } catch (error: GroupsApiError) {
        if (error.isNotMember) removedNow(groupId)
        throw error
    }
    val match = ledger.pairMatch(vault.ownIdentities(), groupId, member.userId.lowercase(), served.rosters, rosterVersion, code, held, FamilySync.checkTime(now()))
    val check = match.check ?: return false to false
    val verified = vault.saveFamilyCheck(groupId, member, check, match.pin, revision)
    vouched[groupId] = true
    return true to verified
}

/* Whom this person's family check of `groupId` was with, if it was one (their own words check them then, 6.10). */
fun FamilySync.checkedFamilyWith(groupId: String): String? = runCatching { vault.loadSettings().familyCheckWith(groupId) }.getOrNull()

/*
 * This phone's guard entry for a person, with an act left pending settled first, for a family check, and the revision it
 * is at. A guard that can't be read is Unreadable (the core then writes no pin), never none.
 */
internal fun Vault.contactGuardState(contactId: String): Pair<GuardState, ULong> = GuardTurn.run {
    val settings = loadSettings()
    val entry = try {
        guardFor(contactId, settings.pinOf(contactId), settings.version).first
    } catch (_: GuardUnreadable) {
        return@run GuardState.Unreadable to 0uL
    }
    (entry?.let { GuardState.Held(it) } ?: GuardState.Absent) to (entry?.revision ?: 0uL)
}

/*
 * They match in a family check, saved (the web's saveFamilyCheck): with no keys, only the check record (and the marker);
 * with keys, a verified pin of them committed from the guard entry the match was decided over, the check record in the
 * same save. A guard that moved meanwhile (a Continue or a check since) stops it before anything is saved. True when the
 * pin was written.
 */
internal fun Vault.saveFamilyCheck(groupId: String, member: FamilyMemberRef, check: FamilyCheck, keys: PinKeys?, decidedOver: ULong): Boolean {
    if (keys == null) {
        updateSettings { it.setFamilyCheck(groupId, check) }
        return false
    }
    val contactId = member.userId
    GuardTurn.run {
        val settings = loadSettings()
        val before = settings.pinOf(contactId)
        val (entry, _) = guardFor(contactId, before, settings.version)
        // Decided over this very entry, or not at all: a Continue or a check since is its own act.
        if ((entry?.revision ?: 0uL) != decidedOver) throw ContactMoved()
        // This person's own check now, never a family's word.
        val target = (before ?: ContactPin.of(contactId, member.email, member.name, keys, "", "family"))
            .replacing(keys, pinnedAt = Instant.now().toString()).let { it.copy(trustedVia = null, firstSeen = it.firstSeen ?: "family") }
        commitTrust(contactId, entry, target) { settings ->
            settings.setPin(target, ifOver = before, verify = true)
            settings.setFamilyCheck(groupId, check)
        }
    }
    clearChange(contactId)
    forgetLookups(contactId)
    return true
}
