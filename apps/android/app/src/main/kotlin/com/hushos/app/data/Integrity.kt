package com.hushos.app.data

import com.hushos.core.Integrity
import com.hushos.core.MetadataStatement
import com.hushos.core.NodeKind
import com.hushos.core.TrustedKeys
import com.hushos.core.VersionStatement
import com.hushos.core.base64urlDecode
import com.hushos.core.metadataCopySign
import com.hushos.core.metadataIntegrity
import com.hushos.core.metadataResealSign
import com.hushos.core.metadataSign
import com.hushos.core.versionCopySign
import com.hushos.core.versionIntegrity
import com.hushos.core.versionResealSign
import com.hushos.core.versionSign

/*
 * The signing keys this person trusts, by account (docs/integrity-design.md, "Reading" and "Retired keys"): their own,
 * the current one proven against its seed when the identity opened and the earlier ones from their own history; and
 * each verified contact's pinned key with the earlier ones a checked succession vouched for. Only a current key can
 * verify; an earlier one can only make a record `RetiredKey`. Anyone else has none, so what they signed reads as an
 * unknown signer, never as verified. Names come from here too: "you", a checked contact's name, or nobody.
 */
class Trust private constructor(
    val userId: String,
    private val own: TrustedKeys,
    private val contacts: Map<String, TrustedKeys>,
    private val names: Map<String, String>,
    /* Addresses of people pinned but not checked over both keys: where "Check their words" can start. */
    private val unchecked: Map<String, String>,
) {
    fun keysFor(signerId: String?): TrustedKeys? = when {
        signerId == null -> null
        signerId.equals(userId, ignoreCase = true) -> own
        else -> contacts[signerId.lowercase()]
    }

    /* Who wrote it, as this person can name them: never from what the server says, which is an account id alone. */
    fun writer(signerId: String?): Writer = when {
        signerId == null -> Writer.Unknown(null)
        signerId.equals(userId, ignoreCase = true) -> Writer.You
        else -> names[signerId.lowercase()]?.let { Writer.Contact(it) } ?: Writer.Unknown(unchecked[signerId.lowercase()])
    }

    companion object {
        /*
         * `ownCurrent` is the signing key of the identity opened now; `ownEarlier` those of the identities it replaced.
         * An unverified pin (no signing key, or a fingerprint that isn't the current one over its keys) vouches for
         * nothing, and a pinned key that does not decode is left out rather than trusted in part.
         */
        fun of(userId: String, ownCurrent: ByteArray, ownEarlier: List<ByteArray>, pins: Map<String, ContactPin>): Trust {
            val contacts = HashMap<String, TrustedKeys>()
            val names = HashMap<String, String>()
            val unchecked = HashMap<String, String>()
            for (pin in pins.values) {
                val id = pin.userId.lowercase()
                val current = if (pin.verified) runCatching { base64urlDecode(pin.signingPublicKey) }.getOrNull() else null
                if (current == null) { if (pin.email.isNotEmpty()) unchecked[id] = pin.email; continue }
                contacts[id] = TrustedKeys(current, pin.previousSigningKeys.mapNotNull { runCatching { base64urlDecode(it) }.getOrNull() })
                names[id] = pin.displayName
            }
            return Trust(userId, TrustedKeys(ownCurrent, ownEarlier.filter { !it.contentEquals(ownCurrent) }), contacts, names, unchecked)
        }
    }
}

/* Who a record's writer is to this person. `Unknown.email` is set when there is someone to check (an unchecked pin, a share's granter). */
sealed interface Writer {
    data object You : Writer
    data class Contact(val name: String) : Writer
    data class Unknown(val email: String?) : Writer
}

/* Why a record is not verified, and who wrote it as this person can name them. Verified records have none. */
data class Unverified(val integrity: Integrity, val signerId: String?, val writer: Writer) {
    companion object {
        /* Nothing could be checked: whom this person trusts did not load. Never shown as clean. */
        fun unchecked(signerId: String? = null) = Unverified(Integrity.UNCHECKED, signerId, Writer.Unknown(null))
    }
}

/*
 * Which verdict a row shows when its name and its content disagree: the clearest warning wins. Saved from a link is
 * no warning, but it says more than verified (Info names it), so it ranks just above.
 */
internal fun severity(integrity: Integrity) = when (integrity) {
    Integrity.VERIFIED -> 0
    Integrity.SAVED_FROM_LINK -> 1
    Integrity.RESEALED -> 2
    Integrity.UNSIGNED -> 3
    Integrity.RETIRED_KEY -> 4
    Integrity.UNKNOWN_SIGNER -> 5
    Integrity.UNCHECKED -> 6
    Integrity.BAD_SIGNATURE -> 7
}

/* What carries no mark: a record that verified, and one this person or a checked contact saved from a link. */
private fun unmarked(integrity: Integrity) = integrity == Integrity.VERIFIED || integrity == Integrity.SAVED_FROM_LINK

/* Malformed base64 is no signature this device can check: verification fails on it as on any wrong one. */
private fun signatureBytes(value: String?): ByteArray? = value?.let { runCatching { base64urlDecode(it) }.getOrDefault(ByteArray(0)) }

/*
 * A node's metadata verdict against the keys trusted for the account the server names as its writer. No trust set
 * (it did not load) or a check that throws is `Unchecked`, never a pass.
 */
fun metadataVerdict(node: NodeView, trust: Trust?): Integrity {
    trust ?: return Integrity.UNCHECKED
    return try {
        metadataIntegrity(
            trust.keysFor(node.metadataSigner?.id),
            MetadataStatement(node.workspaceId, node.id, if (node.isFolder) NodeKind.FOLDER else NodeKind.FILE, node.metadataVersion),
            base64urlDecode(node.metadataEnvelope), signatureBytes(node.metadataSignature),
        )
    } catch (error: Exception) {
        Integrity.UNCHECKED
    }
}

/* A version's verdict, as `metadataVerdict`: the version as served, its signer and signature, under the node it belongs to. */
fun versionVerdict(
    workspaceId: String, nodeId: String, versionId: String, objectId: String, contentSuite: UInt, contentKeyEnvelope: String,
    signerId: String?, signature: String?, trust: Trust?,
): Integrity {
    trust ?: return Integrity.UNCHECKED
    return try {
        versionIntegrity(
            trust.keysFor(signerId), VersionStatement(workspaceId, nodeId, versionId, objectId, contentSuite),
            base64urlDecode(contentKeyEnvelope), signatureBytes(signature),
        )
    } catch (error: Exception) {
        Integrity.UNCHECKED
    }
}

fun versionVerdict(node: NodeView, trust: Trust?): Integrity? = node.currentVersion?.takeIf { !node.isFolder }?.let { version ->
    versionVerdict(node.workspaceId, node.id, version.id, version.objectId, version.contentSuite, version.contentKeyEnvelope, version.signer?.id, version.signature, trust)
}

/*
 * A node's metadata and its current version, each checked against the keys trusted for the account the server names
 * as its writer, the worse of the two first: a forged version under an honest name is as untrustworthy as a forged
 * name.
 */
private fun worstOf(node: NodeView, trust: Trust): Unverified {
    val metadataId = node.metadataSigner?.id
    var worst = Unverified(metadataVerdict(node, trust), metadataId, trust.writer(metadataId))
    versionVerdict(node, trust)?.let { content ->
        val versionId = node.currentVersion?.signer?.id
        if (severity(content) > severity(worst.integrity)) worst = Unverified(content, versionId, trust.writer(versionId))
    }
    return worst
}

/*
 * The mark a row shows: the worse of its two records, or none when both verified or were saved from a link. Without
 * a trust set every record is `Unchecked`: failing to load is never clean.
 */
fun unverifiedOf(node: NodeView, trust: Trust?): Unverified? {
    if (trust == null) return Unverified.unchecked(node.metadataSigner?.id)
    return worstOf(node, trust).takeIf { !unmarked(it.integrity) }
}

/*
 * Who saved this item from a link, when that is the whole story (docs/integrity-design.md, "Saved copies, by where
 * they came from"): no mark, and Info says so in a neutral line. Null for anything verified outright or unverified.
 */
fun savedFromLinkOf(node: NodeView, trust: Trust?): Writer? {
    trust ?: return null
    val worst = worstOf(node, trust)
    return if (worst.integrity == Integrity.SAVED_FROM_LINK) worst.writer else null
}

/* Info's line for a copy saved from a link: who saved it, as this person can name them, and what that can't say. */
fun savedFromLinkLine(writer: Writer): String = when (writer) {
    Writer.You -> "Saved from a link by you. HushOS can’t confirm who made the original."
    is Writer.Contact -> "Saved from a link by ${writer.name}. HushOS can’t confirm who made the original."
    // A saved signature only checks under keys this person trusts, so the saver is always named; never guessed.
    is Writer.Unknown -> "Saved from a link. HushOS can’t confirm who made the original."
}

private fun possessive(name: String) = if (name.endsWith("s")) "$name’" else "$name’s"

/*
 * What the Unverified mark explains, per case. A stripped signature and an unknown writer read alike ("HushOS can't
 * confirm who wrote this"), so a server cannot pick the milder warning; only a writer this person checked is named.
 */
fun Unverified.explanation(): String = when (integrity) {
    Integrity.UNCHECKED -> "HushOS couldn’t check who wrote this. Try again later."
    Integrity.UNSIGNED -> "HushOS can’t confirm who wrote this."
    Integrity.UNKNOWN_SIGNER -> "HushOS can’t confirm who wrote this. It was added or last changed by someone you haven’t checked."
    Integrity.BAD_SIGNATURE -> when (val who = writer) {
        Writer.You -> "The signature doesn’t match your keys. Don’t trust this item."
        is Writer.Contact -> "The signature doesn’t match ${possessive(who.name)} keys. Don’t trust this item."
        is Writer.Unknown -> "The signature doesn’t match the writer’s keys. Don’t trust this item."
    }
    Integrity.RESEALED -> when (val who = writer) {
        Writer.You -> "Re-locked by you; HushOS couldn’t confirm who wrote it before."
        is Writer.Contact -> "Re-locked by ${who.name}; HushOS couldn’t confirm who wrote it before."
        is Writer.Unknown -> "Re-locked by someone you haven’t checked; HushOS couldn’t confirm who wrote it before."
    }
    Integrity.RETIRED_KEY -> when (val who = writer) {
        Writer.You -> "Signed with keys you have since replaced."
        is Writer.Contact -> "Signed with keys ${who.name} has since replaced."
        is Writer.Unknown -> "Signed with keys its writer has since replaced."
    }
    // Neither carries a mark, so neither is explained as one.
    Integrity.VERIFIED, Integrity.SAVED_FROM_LINK -> ""
}

/* Where "Check their words" makes sense: an unknown writer with an address to look up. */
val Unverified.checkEmail: String? get() = if (integrity == Integrity.UNKNOWN_SIGNER) (writer as? Writer.Unknown)?.email else null

/*
 * Whom this person trusts, as the screens hold it: not asked yet, loaded, or failed to load. Failed is never treated as
 * clean: every record shows the Couldn't check mark until a retry loads it.
 */
sealed interface TrustState {
    data object Loading : TrustState
    data class Ready(val trust: Trust) : TrustState
    data object Failed : TrustState

    /*
     * The state after a load. Without a network the trust set already loaded stays (it is what this person trusted a
     * moment ago, and offline nothing new arrives to check); any other failure (settings refused as rolled back, an
     * identity that won't open, a check that throws) fails closed, whatever was loaded before.
     */
    fun after(result: Result<Trust>): TrustState = result.fold({ Ready(it) }) { error -> if (error is Unreachable && this is Ready) this else Failed }
}

/*
 * Trust loads of which only the latest begun may land. Loads overlap (a refresh, then a succession or a pin change and
 * the refresh after it), and the older one can finish last: kept, it would put back the replaced key or the old pins
 * until the next load. `land` checks and applies under one lock, so a load begun meanwhile always lands after it.
 */
class TrustLoads {
    private val begun = java.util.concurrent.atomic.AtomicLong()
    private val lock = Any()

    /* A ticket for a load about to start; any load begun before it no longer lands. */
    fun begin(): Long = begun.incrementAndGet()

    /* No load begun so far lands (the account or the session changed). */
    fun dropAll() { begun.incrementAndGet() }

    /* Runs `apply` (which keeps the load's result) only when no load began after `ticket`; null otherwise. */
    fun <T> land(ticket: Long, apply: () -> T): T? = synchronized(lock) { if (ticket == begun.get()) apply() else null }
}

/*
 * One load at a time, shared by everyone who asks while it runs (the Files app asks from many threads at once): a load
 * per request would multiply the loads, and with only the latest kept, none would land while browsing goes on. Loads
 * are for the current `key` (the vault, set by `reset`): one is joined only for that key and only if nothing
 * invalidated since it began, and only such a load is kept. A request still holding another key (a vault dropped since
 * it took it) loads for itself: never joined, never kept, never in the way of the current key's load.
 */
class SharedLoad<K : Any, T> {
    private class Flight<K, T>(val key: K, val generation: Long) {
        val done = java.util.concurrent.CompletableFuture<T>()
    }

    private val lock = Any()
    private var generation = 0L
    private var current: K? = null
    private var flight: Flight<K, T>? = null

    /* `key` is the one loads are for from now (null: none); nothing begun before is kept or joined. `then` runs under the same lock. */
    fun reset(key: K?, then: () -> Unit = {}) = synchronized(lock) {
        generation++
        current = key
        flight = null
        then()
    }

    /* The identity or the pins changed: the next caller loads afresh, and the load under way keeps nothing. */
    fun invalidate() = synchronized(lock) { reset(current) }

    /*
     * The result of the load for `key` under way, or of one started now with `read`. The one that ran `read` hands the
     * result to `keep` under the lock, only when `key` is still the current one and nothing invalidated since it
     * began. Those who joined get the same result, kept or not (they asked before it changed), and always get it:
     * a `keep` that throws fails only the caller that ran it.
     */
    fun load(key: K, read: () -> T, keep: (T) -> Unit): T {
        val (mine, joined) = synchronized(lock) {
            val running = flight?.takeIf { it.key === key && it.generation == generation }
            when {
                running != null -> running to true
                key !== current -> Flight<K, T>(key, generation) to false
                else -> Flight<K, T>(key, generation).also { flight = it } to false
            }
        }
        if (joined) {
            try {
                return mine.done.get()
            } catch (failure: java.util.concurrent.ExecutionException) {
                throw failure.cause ?: failure
            }
        }
        var outcome: Result<T>? = null
        try {
            val result = read()
            outcome = Result.success(result)
            synchronized(lock) { if (mine.generation == generation && key === current) keep(result) }
            return result
        } catch (failure: Throwable) {
            if (outcome == null) outcome = Result.failure(failure)
            throw failure
        } finally {
            synchronized(lock) { if (flight === mine) flight = null }
            outcome?.fold({ mine.done.complete(it) }, { mine.done.completeExceptionally(it) })
        }
    }
}

/* The mark a row shows under `state`: none while it loads, Couldn't check when it failed, otherwise the verdict. */
fun markOf(node: NodeView, state: TrustState): Unverified? = when (state) {
    TrustState.Loading -> null
    TrustState.Failed -> Unverified.unchecked(node.metadataSigner?.id)
    is TrustState.Ready -> try { unverifiedOf(node, state.trust) } catch (error: Exception) { Unverified.unchecked(node.metadataSigner?.id) }
}

/*
 * What the system Files app shows under a row's name: nothing for a verified record or one saved from a link,
 * otherwise that it is unverified, and when the check couldn't run, that too.
 */
fun providerSummary(node: NodeView, state: TrustState): String? {
    val mark = markOf(node, state) ?: return null
    return if (mark.integrity == Integrity.UNCHECKED) "Unverified: HushOS couldn’t check who wrote this" else "Unverified"
}

/* Info's saved-from-link line under `state`, or null: only once whom this person trusts has loaded. */
fun savedLineOf(node: NodeView, state: TrustState): String? = (state as? TrustState.Ready)?.let { ready ->
    runCatching { savedFromLinkOf(node, ready.trust) }.getOrNull()?.let(::savedFromLinkLine)
}

/*
 * How a copy's records are signed, by where the copy came from (docs/integrity-design.md, "Saved copies, by where they
 * came from"): from a link, the saved statements (a visitor never sees signatures, so there is no verdict to keep);
 * otherwise the source's metadata and version verdicts as they were, checked here at copy time. A verified one is
 * signed with the ordinary statement, one saved from a link stays saved, anything else is re-sealed.
 */
data class Prior(val metadata: Integrity, val version: Integrity, val fromLink: Boolean = false) {
    companion object {
        /* "Save a copy" from a link: the file and every folder the save creates. */
        val FROM_LINK = Prior(Integrity.UNCHECKED, Integrity.UNCHECKED, fromLink = true)

        /* A folder has no version: its slot is never signed, and a file without one is not copied. */
        fun of(node: NodeView, trust: Trust?) = Prior(metadataVerdict(node, trust), versionVerdict(node, trust) ?: Integrity.UNCHECKED)
    }
}

/*
 * The signature a write sends over a metadata envelope. `prior` null: this person wrote it (a new folder, a rename, an
 * upload) and signs the ordinary statement. Otherwise the envelope re-seals a record that existed before (a rotation,
 * a new version keeping a name), and `prior` is its verdict as it was: `Verified` keeps the ordinary statement,
 * `SavedFromLink` the saved one, anything else gets the re-sealed one, and a record whose check did not run
 * (`Unchecked`) is not re-signed at all. A copy signs with copyMetadataSignature.
 */
fun metadataSignature(seed: ByteArray, statement: MetadataStatement, envelope: ByteArray, prior: Integrity?): ByteArray = when (prior) {
    null -> metadataSign(seed, statement, envelope)
    Integrity.UNCHECKED -> throw TrustUnavailable()
    else -> metadataResealSign(seed, prior, statement, envelope)
}

/* The same for a content-key envelope. */
fun versionSignature(seed: ByteArray, statement: VersionStatement, envelope: ByteArray, prior: Integrity?): ByteArray = when (prior) {
    null -> versionSign(seed, statement, envelope)
    Integrity.UNCHECKED -> throw TrustUnavailable()
    else -> versionResealSign(seed, prior, statement, envelope)
}

/*
 * The signature a copy sends over its new metadata envelope, by `prior` (see Prior). A copy that isn't from a link and
 * whose source could not be checked is not signed at all: nothing is copied without knowing whom this person trusts.
 */
fun copyMetadataSignature(seed: ByteArray, statement: MetadataStatement, envelope: ByteArray, prior: Prior): ByteArray {
    if (!prior.fromLink && prior.metadata == Integrity.UNCHECKED) throw TrustUnavailable()
    return metadataCopySign(seed, prior.metadata, prior.fromLink, statement, envelope)
}

/* The same for a copy's content-key envelope. */
fun copyVersionSignature(seed: ByteArray, statement: VersionStatement, envelope: ByteArray, prior: Prior): ByteArray {
    if (!prior.fromLink && prior.version == Integrity.UNCHECKED) throw TrustUnavailable()
    return versionCopySign(seed, prior.version, prior.fromLink, statement, envelope)
}

/* Thrown where a write must not go ahead without knowing whom this person trusts (a rotation, a copy). */
class TrustUnavailable(cause: Throwable? = null) :
    Refused("Nothing was changed", "HushOS couldn’t load the people you trust, so nothing was locked again. It’s tried again later.") {
    init { cause?.let { initCause(it) } }
}
