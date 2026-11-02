package com.hushos.app.data

import com.hushos.core.CoreException
import com.hushos.core.GroupVerdict

/*
 * What the families screens say when something fails, as the web's errorCopy and keyChangeWords word it (iOS's
 * FamilyWords.swift): a coded refusal in the person's words, no answer as no answer, and the core's own sentence with
 * only the family-folder refusals reworded.
 */
object FamilyWords {
    const val NO_ANSWER = GroupsApiError.NO_ANSWER
    /* Something family folders don't offer (sharing, links, reports, keeping, versions, copies): iOS's words. */
    const val UNAVAILABLE = "This isn’t available in family folders."
    const val OPEN_AGAIN = "Open the family again, then try again."
    const val NOT_IN_FAMILY = "You’re not in this family any more."
    private const val KEY_CHANGE_PENDING = "This folder’s keys changed: the key change has not reached it yet."
    private const val NO_CHAIN = "Check the family’s member list first."
    private const val NOT_COMMITTED_ROOT = "This folder’s key is not the one the family’s member list names."
    private const val NOT_CARRIED = "This item was added under a key the key change replaces, so it is not carried over."
    const val COULDNT_CHECK_KEYS = "Couldn’t check this folder’s keys."

    fun keyChangeWords(message: String): String = when (message) {
        KEY_CHANGE_PENDING -> "HushOS is finishing a key change for this folder. Try again in a moment."
        // Nothing of the family opens until it is checked again: said as the web's family folders say it.
        NO_CHAIN -> OPEN_AGAIN
        NOT_COMMITTED_ROOT, NOT_CARRIED -> COULDNT_CHECK_KEYS
        else -> message
    }

    fun error(error: Throwable): String = when (error) {
        is GroupsApiError -> error.words
        is NotAuthenticated -> "You were signed out. Sign in again, then retry."
        is Unreachable, is AuthUnreachable -> NO_ANSWER
        is CoreException -> keyChangeWords(error.message.orEmpty())
        is FamilyFailure, is Refused -> keyChangeWords(error.message.orEmpty())
        else -> "Something went wrong. Try again."
    }
}

/* A refusal in the families' words; `notInFamily` is the server's not-member, said. */
class FamilyFailure(message: String) : Exception(message) {
    companion object {
        val notInFamily get() = FamilyFailure(FamilyWords.NOT_IN_FAMILY)
    }
}

/* What family folders don't offer: refused before anything is sent. */
class FamilyUnavailable : Refused("Nothing was changed", FamilyWords.UNAVAILABLE)

/*
 * A family folder item's mark and Info lines, ported from the web (iOS's FamilyIntegrity.swift): trust.ts `recordIssues`
 * and `sortIssues`, and integrity-lines.ts `issueLines`, `markLabel`, `changedByLabel`/`changedByWords`, `rekeyedLines`
 * and `verifiedByLine`, in the family's case only. Pure, so the words a server could steer are tested on their own.
 */
enum class FamilyRecordKind { METADATA, VERSION }

enum class RekeyCause { MISMATCH, UNCONFIRMED, UNATTESTED }

/* Who wrote a re-keyed record, who locked it again, the re-keyer's verdict and whether the bytes bound (trust.ts RekeyNote). */
data class RekeyNote(val writer: String?, val by: String?, val integrity: GroupVerdict, val bound: Boolean?, val via: String? = null)

data class FamilyIssue(val record: FamilyRecordKind, val integrity: GroupVerdict, val signer: String?, val rekey: Rekey? = null) {
    data class Rekey(val cause: RekeyCause, val rekeyer: GroupVerdict)
}

/* One record as judged: its verdict (a re-keyed record's is its origin's), whose word vouched, its signer and re-key note. */
data class FamilyJudged(val record: FamilyRecordKind, val verdict: GroupVerdict, val via: String?, val signer: String?, val note: RekeyNote?)

/* Who a line can name (integrity-lines.ts SignerNames, the family's case). */
data class FamilyNames(
    val userId: String,
    /* Pins whose words count, by lowercase user id: their names. */
    val checked: Map<String, String>,
    /* Pins taken on a family's word, by lowercase user id. */
    val vouched: Map<String, Vouched>,
    val family: String,
    /* Route 3's members, by lowercase user id: named as the server names them, address beside (D10). */
    val members: Map<String, Member>,
) {
    data class Member(val name: String, val email: String?)
    data class Vouched(val name: String, val email: String, val family: String)
}

/* A family mark: its face, its lines, and the way out where there is one. */
data class FamilyMark(val label: String, val lines: List<String>, val danger: Boolean, val retry: Boolean, val check: String?)

/*
 * Who wrote an item whose writer nobody checked (2.6, first use): Info's "Added by <name>" with "Not verified · Check
 * it's <first name>", as the personal Info says it. The account id picks the check: the family's, for a member.
 */
data class FamilySeen(val name: String, val userId: String, val email: String?)

/* A family folder item as the web's mark and Info say it. */
data class FamilyVerdict(
    val mark: FamilyMark?, val changedBy: Pair<String, String>?, val writtenBy: String?, val replacedBy: List<String>, val verifiedBy: String?,
    val seen: FamilySeen? = null,
) {
    companion object {
        /* Everything unchecked: whom to judge by didn't load. */
        val unchecked = FamilyVerdict(FamilyMark("Couldn’t check", listOf(FamilyLines.COULDNT_CHECK), danger = false, retry = true, check = null),
            "Changed by" to "Not checked", null, emptyList(), null)
    }
}

object FamilyLines {
    const val COULDNT_CHECK = "HushOS couldn’t check who wrote this. Try again later."
    private const val CANT_CONFIRM = "HushOS can’t confirm who wrote this."
    private const val CANT_CONFIRM_VERSION = "HushOS can’t confirm who added this version."

    /* The re-keyer verdicts that leave the record unmarked: said in Info, never as a mark (decision D5). */
    private val infoOnly = setOf(GroupVerdict.VERIFIED, GroupVerdict.SAVED_FROM_LINK, GroupVerdict.RETIRED_KEY, GroupVerdict.UNKNOWN_SIGNER, GroupVerdict.SEEN,
        GroupVerdict.UNCHECKED, GroupVerdict.FORMER_MEMBER, GroupVerdict.RESEALED)

    private fun trusted(verdict: GroupVerdict) = verdict == GroupVerdict.VERIFIED || verdict == GroupVerdict.SAVED_FROM_LINK

    /* No issue at all (trust.ts UNMARKED): verified, a first-seen writer's (`seen`), a copy saved from a link. */
    private fun unmarked(verdict: GroupVerdict) = trusted(verdict) || verdict == GroupVerdict.SEEN

    fun recordIssues(record: FamilyRecordKind, integrity: GroupVerdict, signer: String?, note: RekeyNote?): List<FamilyIssue> {
        val issues = ArrayList<FamilyIssue>()
        if (note != null) {
            val rekeyer = note.integrity
            when (note.bound) {
                // A re-key cause names someone only when their own verified signature covers what failed.
                false -> issues.add(FamilyIssue(record, GroupVerdict.BAD_SIGNATURE, if (rekeyer == GroupVerdict.VERIFIED) note.by else null, FamilyIssue.Rekey(RekeyCause.MISMATCH, rekeyer)))
                null -> issues.add(FamilyIssue(record, GroupVerdict.UNCHECKED, null, FamilyIssue.Rekey(RekeyCause.UNCONFIRMED, rekeyer)))
                true -> {
                    if (!unmarked(integrity)) issues.add(FamilyIssue(record, integrity, note.writer))
                    if (rekeyer !in infoOnly) issues.add(FamilyIssue(record, rekeyer, null, FamilyIssue.Rekey(RekeyCause.UNATTESTED, rekeyer)))
                }
            }
            return issues
        }
        if (!unmarked(integrity)) issues.add(FamilyIssue(record, integrity, signer))
        return issues
    }

    private fun rank(verdict: GroupVerdict) = when (verdict) {
        GroupVerdict.KEY_CONFLICT -> 0
        GroupVerdict.BAD_SIGNATURE -> 1
        GroupVerdict.RETIRED_KEY -> 2
        GroupVerdict.FORMER_MEMBER -> 3
        GroupVerdict.UNKNOWN_SIGNER, GroupVerdict.SEEN -> 4
        GroupVerdict.UNSIGNED -> 5
        GroupVerdict.RESEALED -> 6
        GroupVerdict.UNCHECKED -> 7
        GroupVerdict.VERIFIED, GroupVerdict.SAVED_FROM_LINK -> 8
    }

    /* trust.ts sortIssues: worst first, stable; a re-key that is not attested ranks with a re-sealed record. */
    fun sorted(issues: List<FamilyIssue>): List<FamilyIssue> =
        issues.sortedBy { if (it.rekey?.cause == RekeyCause.UNATTESTED) rank(GroupVerdict.RESEALED) else rank(it.integrity) }

    fun issues(records: List<FamilyJudged>) = sorted(records.flatMap { recordIssues(it.record, it.verdict, it.signer, it.note) })

    private sealed interface Named {
        data object You : Named
        data class Contact(val name: String, val vouched: FamilyNames.Vouched?) : Named
        data class Member(val name: String, val email: String?) : Named
        data object Unknown : Named
    }

    private fun name(signer: String?, names: FamilyNames): Named {
        val id = signer?.lowercase() ?: return Named.Unknown
        if (id == names.userId.lowercase()) return Named.You
        names.checked[id]?.let { return Named.Contact(it, names.vouched[id]) }
        names.members[id]?.let { return Named.Member(it.name, it.email) }
        return Named.Unknown
    }

    private fun plainContact(name: String, vouched: FamilyNames.Vouched?) = vouched?.let { "${it.name} (${it.email})" } ?: name

    /* A member as a sentence names them: a checked contact by their pin, anyone else as the server does. */
    private fun memberWords(named: Named, fallback: String) = when (named) {
        is Named.Contact -> firstNameOf(named.name)
        is Named.Member -> named.email?.let { "${named.name} ($it)" } ?: named.name
        else -> fallback
    }

    private fun personWords(named: Named): String? = when (named) {
        Named.You -> "you"
        Named.Unknown -> null
        else -> memberWords(named, "")
    }

    private data class Line(val text: String, val retry: Boolean = false, val check: String? = null)

    private fun rekeyLine(issue: FamilyIssue, named: Named): Line {
        val version = issue.record == FamilyRecordKind.VERSION
        val rekey = issue.rekey!!
        return when (rekey.cause) {
            RekeyCause.MISMATCH -> {
                val who = if (rekey.rekeyer == GroupVerdict.VERIFIED) personWords(named) else null
                Line(if (version) "This version as ${who?.let { "$it locked it" } ?: "it was locked"} again doesn’t match what was added. Don’t trust this item."
                    else "What ${who?.let { "$it locked" } ?: "was locked"} again doesn’t match what was written. Don’t trust this item.")
            }
            RekeyCause.UNCONFIRMED -> Line(if (version) "HushOS couldn’t confirm this version since its keys were replaced." else "HushOS couldn’t confirm this item since its keys were replaced.", retry = true)
            RekeyCause.UNATTESTED -> Line("HushOS can’t confirm who replaced this item’s keys.")
        }
    }

    private fun line(issue: FamilyIssue, names: FamilyNames): Line {
        val version = issue.record == FamilyRecordKind.VERSION
        val named = name(issue.signer, names)
        val plain = if (version) CANT_CONFIRM_VERSION else CANT_CONFIRM
        if (issue.rekey != null) return rekeyLine(issue, named)
        return when (issue.integrity) {
            GroupVerdict.KEY_CONFLICT -> {
                val vouched = (named as? Named.Contact)?.vouched
                if (vouched != null) Line("${vouched.name} (${vouched.email})’s keys don’t match the ones ${vouched.family} vouched for. Check it’s them again.", check = issue.signer)
                else {
                    val who = memberWords(named, "Its writer")
                    Line("${if (who == "Its writer") "Its writer’s" else "$who’s"} keys don’t match the ones you checked. Check it’s them again.", check = issue.signer)
                }
            }
            GroupVerdict.FORMER_MEMBER -> Line("${if (version) "Added" else "Written"} by ${memberWords(named, "someone you haven’t checked")}, who has left ${names.family}.")
            GroupVerdict.UNCHECKED -> Line(COULDNT_CHECK, retry = true)
            GroupVerdict.UNSIGNED -> Line(plain)
            GroupVerdict.UNKNOWN_SIGNER, GroupVerdict.SEEN ->
                Line("$plain It was ${if (version) "added" else "added or last changed"} by someone you haven’t checked.", check = if (issue.signer != null && named == Named.Unknown) issue.signer else null)
            // In a family's folders a server withholding a member's links makes genuine records read this way: said as what it is.
            GroupVerdict.BAD_SIGNATURE -> Line(if (version) "HushOS couldn’t verify this version’s signature." else "HushOS couldn’t verify this signature.")
            GroupVerdict.RETIRED_KEY -> {
                val who = when (named) { Named.You -> "you have"; is Named.Contact -> "${plainContact(named.name, named.vouched)} has"; else -> "its writer has" }
                Line("${if (version) "This version was signed" else "Signed"} with keys $who since replaced.")
            }
            GroupVerdict.RESEALED -> {
                val by = when (named) { Named.You -> "you"; is Named.Contact -> plainContact(named.name, named.vouched); else -> "someone you haven’t checked" }
                Line("${if (version) "This version was re-locked" else "Re-locked"} by $by; HushOS couldn’t confirm who wrote it before.")
            }
            GroupVerdict.VERIFIED, GroupVerdict.SAVED_FROM_LINK -> Line("")
        }
    }

    /* integrity-lines.ts issueLines: the same thing said once. */
    private fun lines(issues: List<FamilyIssue>, names: FamilyNames): List<Line> {
        if (issues.size < 2) return issues.map { line(it, names) }
        val (a, b) = issues[0] to issues[1]
        val sameSigner = a.signer?.lowercase() == b.signer?.lowercase()
        if (a.rekey != null && b.rekey != null && a.rekey.cause == b.rekey.cause && sameSigner) return listOf(line(if (a.record == FamilyRecordKind.METADATA) a else b, names))
        if (a.rekey == null && b.rekey == null && a.integrity == b.integrity && a.integrity != GroupVerdict.BAD_SIGNATURE && (a.integrity == GroupVerdict.UNCHECKED || sameSigner)) {
            return listOf(line(if (a.record == FamilyRecordKind.METADATA) a else b, names))
        }
        return issues.map { line(it, names) }
    }

    private fun label(issues: List<FamilyIssue>): String = when {
        issues.isNotEmpty() && issues.all { it.integrity == GroupVerdict.UNCHECKED } -> "Couldn’t check"
        issues.any { it.integrity == GroupVerdict.KEY_CONFLICT && it.rekey == null } -> "Keys don’t match"
        else -> "Unverified"
    }

    fun mark(issues: List<FamilyIssue>, names: FamilyNames): FamilyMark? {
        if (issues.isEmpty()) return null
        val lines = lines(issues, names)
        return FamilyMark(label(issues), lines.map { it.text }, danger = issues.first().let { it.integrity == GroupVerdict.KEY_CONFLICT && it.rekey == null },
            retry = lines.any { it.retry }, check = lines.firstOrNull { it.check != null }?.check)
    }

    fun changedByLabel(issue: FamilyIssue): String = when {
        issue.integrity != GroupVerdict.FORMER_MEMBER || issue.rekey != null -> "Changed by"
        issue.record == FamilyRecordKind.VERSION -> "Added by"
        else -> "Written by"
    }

    fun changedByWords(issue: FamilyIssue, names: FamilyNames): String {
        val rekey = issue.rekey
        if (rekey != null && !(rekey.cause == RekeyCause.MISMATCH && rekey.rekeyer == GroupVerdict.VERIFIED)) return "Not confirmed"
        if (issue.integrity == GroupVerdict.UNCHECKED) return "Not checked"
        val named = name(issue.signer, names)
        if (issue.integrity == GroupVerdict.FORMER_MEMBER) {
            val who = memberWords(named, "someone you haven’t checked")
            return "${who.take(1).uppercase()}${who.drop(1)}, who has left ${names.family}."
        }
        return when (named) {
            Named.You -> "You"
            is Named.Contact -> plainContact(named.name, named.vouched)
            is Named.Member -> named.email?.let { "${named.name} ($it)" } ?: named.name
            Named.Unknown -> if (issue.signer != null) "Someone you haven’t checked" else "Unknown"
        }
    }

    /* integrity-lines.ts rekeyedLines: who wrote a re-keyed item and who locked it again. */
    fun rekeyed(records: List<FamilyJudged>, names: FamilyNames): Pair<String?, List<String>> {
        if (records.none { it.note != null }) return null to emptyList()
        val bound = records.filter { it.note?.bound == true }
        if (bound.isEmpty()) return null to emptyList()
        fun words(signer: String?, you: String): String? = when (val named = name(signer, names)) {
            Named.You -> you
            Named.Unknown -> null
            else -> memberWords(named, "")
        }
        fun label(record: FamilyRecordKind) = if (record == FamilyRecordKind.METADATA) "name" else "content"
        fun labelled(phrases: List<Pair<String, String?>>): List<String> {
            val present = phrases.mapNotNull { (l, p) -> p?.let { l to it } }
            if (present.map { it.second }.toSet().size <= 1) return present.take(1).map { it.second }
            return present.map { "${it.second} (${it.first})" }
        }
        val writers = if (records.all { trusted(it.verdict) }) labelled(records.map { label(it.record) to words(it.note?.writer ?: it.signer, "You") }) else emptyList()
        val replacedBy = labelled(bound.map { record ->
            val note = record.note!!
            val by = words(note.by, "you")
            label(record.record) to when (note.integrity) {
                GroupVerdict.VERIFIED -> by?.let { "Keys replaced by $it" }
                GroupVerdict.RETIRED_KEY -> "Keys replaced by ${by ?: "someone you haven’t checked"}, with keys since replaced"
                GroupVerdict.FORMER_MEMBER -> "Keys replaced by ${by ?: "someone you haven’t checked"}, who has left ${names.family}"
                GroupVerdict.UNKNOWN_SIGNER, GroupVerdict.SEEN -> "Keys replaced by someone you haven’t checked"
                GroupVerdict.UNCHECKED -> "HushOS couldn’t check who replaced its keys"
                else -> null
            }
        })
        return (if (writers.isEmpty()) null else writers.joinToString(", ")) to replacedBy
    }

    /* verifiedByLine for this folder's family: every record verified, one at least on the family's word, nothing marked. */
    fun vouched(records: List<FamilyJudged>, issues: List<FamilyIssue>, groupId: String): Boolean {
        if (issues.isNotEmpty() || !records.all { it.verdict == GroupVerdict.VERIFIED }) return false
        return records.any { it.via?.lowercase() == groupId.lowercase() }
    }

    /*
     * A record as this person may read it in a family taken on first use (the web's asFirstUse, 2.6): nobody checked the
     * member list, so what it vouches for reads `seen`, never "Verified by" the family. A verdict from this person's own
     * verified pin (no `via`) stays verified.
     */
    fun asFirstUse(record: FamilyJudged, groupId: String): FamilyJudged {
        fun seen(verdict: GroupVerdict, via: String?) = if (verdict == GroupVerdict.VERIFIED && via?.lowercase() == groupId.lowercase()) GroupVerdict.SEEN else verdict
        return record.copy(verdict = seen(record.verdict, record.via), note = record.note?.let { it.copy(integrity = seen(it.integrity, it.via)) })
    }

    fun verdict(judged: List<FamilyJudged>, names: FamilyNames, groupId: String): FamilyVerdict {
        val issues = issues(judged)
        val (writtenBy, replacedBy) = rekeyed(judged, names)
        return FamilyVerdict(
            mark(issues, names),
            issues.firstOrNull()?.let { changedByLabel(it) to changedByWords(it, names) },
            if (issues.isEmpty()) writtenBy else null,
            replacedBy,
            if (vouched(judged, issues, groupId)) "Verified by ${names.family}" else null,
            seenWriter(judged, issues, names),
        )
    }

    /*
     * The first-seen writer Info names, with no mark speaking instead: the content's writer first (who added what is there
     * now), then the name's. Someone nobody can name gets no line; neither does this account.
     */
    private fun seenWriter(judged: List<FamilyJudged>, issues: List<FamilyIssue>, names: FamilyNames): FamilySeen? {
        if (issues.isNotEmpty()) return null
        for (record in judged.sortedBy { if (it.record == FamilyRecordKind.VERSION) 0 else 1 }) {
            if (record.verdict != GroupVerdict.SEEN || record.note != null) continue
            val id = record.signer?.lowercase() ?: continue
            when (val named = name(id, names)) {
                is Named.Member -> return FamilySeen(named.name, id, named.email)
                is Named.Contact -> return FamilySeen(named.vouched?.name ?: named.name, id, named.vouched?.email)
                else -> continue
            }
        }
        return null
    }
}
