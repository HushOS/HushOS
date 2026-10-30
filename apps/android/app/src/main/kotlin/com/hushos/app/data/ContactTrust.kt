package com.hushos.app.data

import com.hushos.core.GuardEntry
import com.hushos.core.GuardState
import com.hushos.core.GuardVerdict
import com.hushos.core.PinComparison
import com.hushos.core.PinTrust
import com.hushos.core.PublicIdentity
import com.hushos.core.base64urlDecode
import com.hushos.core.guardAgrees
import com.hushos.core.guardEntryNext
import com.hushos.core.keyCommitment
import com.hushos.core.pinFirstSeenOfLegacy
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.sync.withPermit
import java.time.Instant
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicLong

/*
 * First use (docs/optional-verification.md 2; the web's lib/contacts.ts, iOS's Vault+Trust.swift): someone added, or
 * met through something they shared, is remembered with the keys the server serves then (a first-seen pin) and shared
 * with at once. Comparing twelve words, any time, makes the pin verified. A later change is followed only along a
 * succession chain signed by keys this phone holds; any other change pauses that one person (new shares, re-sealing,
 * opening what they shared) until the person continues or checks, and nothing is ever sealed to keys nobody pinned,
 * followed or accepted.
 *
 * The settings pin is used only if it agrees with the guard this phone keeps (ContactGuard.kt, 2.8): settings replaced
 * by a newer copy that drops or swaps a pin are met as a change, never as first use. Every rule is the core's
 * (`pin_trust`, `key_commitment`, `compare_pin`, `pin_of_served`, `pin_first_seen_of_legacy`, `guard_agrees`,
 * `guard_entry_next`); this file only orders the reads and writes.
 */

/* What Add someone came to (6.2), and whether the add itself moved whom this phone trusts (so what is drawn is judged again). */
sealed interface Added {
    val trustChanged: Boolean

    data class New(val pin: ContactPin) : Added {
        override val trustChanged get() = true
    }

    /* Already a contact; adding may still have moved trust (a legacy pin made first-seen, a succession followed, a first guard entry). */
    data class Already(val pin: ContactPin, override val trustChanged: Boolean = false) : Added

    data class Changed(val change: AccountChange) : Added {
        override val trustChanged get() = false
    }
}

/* Where each contact stands on this phone, from the settings and the guard alone. */
data class ContactStanding(val verified: Boolean, val changed: Boolean)

/* Where this phone stands with one person, given the keys the server serves for them now. */
internal sealed interface Standing {
    /* The settings pin agrees with the guard (or there is none here yet) and holds the served keys, or followed them. */
    data class Ok(val pin: ContactPin, val entry: GuardEntry?, val followed: Boolean) : Standing
    /* Nobody pinned: first use, or someone removed whose guard entry holds the served keys. */
    data class New(val entry: GuardEntry?, val removed: Boolean) : Standing
    /* A signed succession not looked up (no act of the person's asked for it). */
    data class Succession(val pin: ContactPin) : Standing
    /* Anything else, a pin missing from the settings while the guard holds them included. */
    data class Changed(val pin: ContactPin?, val entry: GuardEntry?, val wasVerified: Boolean) : Standing
    /* A legacy pin whose person has not signed in since post-quantum keys. */
    data class NotUpgraded(val pin: ContactPin) : Standing
}

/*
 * What a Vault keeps of trust between calls: contacts looked up for display, people found changed this session, a
 * generation every guard write and settings save moves (so a caller can tell trust moved), and the tests' hooks.
 */
class TrustMemory {
    val lookedUp = ConcurrentHashMap<String, Pair<Contact, Long>>()
    val changes = ConcurrentHashMap<String, AccountChange>()
    val generation = AtomicLong()
    /* Tests: runs right after each guard commit (a stop there, as a crash would); the clock; a guard of their own. */
    @Volatile var afterGuardCommit: (() -> Unit)? = null
    @Volatile var clock: () -> Long = System::currentTimeMillis
    @Volatile var guard: ContactGuard? = null

    companion object {
        /* A lookup for display is kept this long: the server allows an account sixty lookups a minute. */
        const val LOOKUP_KEPT_MS = 60_000L
    }
}

/*
 * One pass over what was shared with this account (`mountShares`): the settings read once and reused until something
 * this pass did saved them, and one verdict per granter and the full identity their share came with.
 */
class MountPass {
    var settings: Settings? = null
    val verdicts = HashMap<String, Result<GranterKey>>()

    companion object {
        fun key(contact: Contact, explicit: Boolean) = contact.trustKey + "|" + if (explicit) "open" else "list"
    }
}

/* A verdict on whether the settings pin agrees with the guard: the core's `guard_agrees`, without a chain. */
private fun agreement(userId: String, entry: GuardEntry?, pin: ContactPin?): GuardVerdict =
    guardAgrees(userId, entry?.let { GuardState.Held(it) } ?: GuardState.Absent, pin?.keys, null, emptyList())

private fun now(): String = Instant.now().toString()

/* The person as a received share's granter names them. */
fun ShareView.granterContact(): Contact = Contact(granterId, granterName, granterEmail, granter)

/*
 * The save of an act that writes `target`, decided again on every attempt of the compare-and-set: a pin of the target's
 * own keys already there is kept as it is (unless `verify` asks for this person's own check over first-seen keys or a
 * family's word); the target is written only over the pin the act was decided from (`ifOver`, null for nobody);
 * anything else stops the act.
 */
internal fun Settings.setPin(target: ContactPin, ifOver: ContactPin?, verify: Boolean = false) {
    val current = pinOf(target.userId)
    // A pin over the same keys that vouches for nothing (a fingerprint over other keys) is never kept: it is what the act
    // replaces, and kept, every later guard write over it would be refused.
    if (current != null && current.held && ContactPin.sameKeys(current, target) && (!verify || (current.verified && current.trustedVia == null))) {
        forgetRemoval(target.userId)
        return
    }
    if (!ContactPin.sameKeys(current, ifOver)) throw ContactMoved()
    setPinOnce(target)
}

/* A legacy (or malformed) pin as a first-seen pin of the served keys (2.5, `pin_first_seen_of_legacy`); null when the rule doesn't apply. */
private fun firstSeenOfLegacy(pin: ContactPin, contact: Contact): ContactPin? {
    val served = contact.served
    val identity = PublicIdentity(served.keyVersion ?: return null, served.encryptionPublicKey, served.signingPublicKey,
        served.mlDsaPublicKey ?: return null, served.kemPublicKey ?: return null, served.keysSignature ?: return null)
    return pinFirstSeenOfLegacy(contact.userId, pin.keys, identity)?.let { pin.replacing(it) }
}

/* The people this phone found changed this session, so every screen that shows them says so until Continue or a check. */
fun Vault.accountChanges(): Map<String, AccountChange> = memory.changes.toMap()

private fun Vault.note(change: AccountChange): AccountChange = change.also { memory.changes[it.id] = it }

private fun Vault.clearChange(contactId: String) { memory.changes.remove(contactId.lowercase()) }

/* This phone's entry and pending act for a person; a read that fails is never first use. */
private fun Vault.readGuard(contactId: String): Pair<GuardEntry?, PendingAct?> = try {
    val record = guard.record()
    record.entries[contactId.lowercase()] to record.pending[contactId.lowercase()]
} catch (_: Exception) {
    throw GuardUnreadable()
}

private fun Vault.commitGuard(contactId: String, entry: GuardEntry, over: ULong, keep: PendingAct? = null): GuardEntry {
    try {
        guard.commit(contactId, entry, over, keep)
    } catch (raced: GuardRaced) {
        throw raced
    } catch (_: Exception) {
        throw GuardUnsaved()
    }
    memory.generation.incrementAndGet()
    memory.afterGuardCommit?.invoke()
    return entry
}

/*
 * The guard entry for a person, with an act left pending settled first (2.8), given the settings pin and the stored
 * sequence (`at`): one whose target the pin reached, over the entry's revision, is finished silently; one whose save
 * could still land (the settings are still at its base) is kept (`second`) and the entry judged as it is; any other is
 * dropped.
 */
internal fun Vault.guardFor(contactId: String, pin: ContactPin?, at: ULong): Pair<GuardEntry?, PendingAct?> {
    val (entry, pending) = readGuard(contactId)
    pending ?: return entry to null
    val revision = entry?.revision ?: 0uL
    if (pending.revision == revision) {
        val next = if (pin != null && pin.commitment == pending.target) runCatching { guardEntryNext(entry, pin.keys) }.getOrNull() else null
        if (next != null) {
            // An act whose save landed but whose app stopped before it went on (a Continue, They match over new keys): what
            // was shared with them still holds the old keys. Queued before the commit that drops the pending record, so no
            // stop between the two loses it; queued twice is only a re-seal done again.
            if (pin!!.resealShares) ShareSeals.of(context).queue(contactId)
            val committed = commitGuard(contactId, next, revision)
            // Again once committed, at a fresh generation, for a pass that read the settings before this act (as commitTrust).
            if (pin.resealShares) ShareSeals.of(context).queue(contactId)
            return committed to null
        }
        if (pending.base != null && at <= pending.base) return entry to pending
    }
    try {
        guard.dropPending(contactId)
    } catch (_: Exception) {
        throw GuardUnsaved()
    }
    return entry to null
}

/* A guard entry for keys this phone acts on with nothing in the settings to change: a pin met here first, or now seen verified. */
private fun Vault.rememberKeys(contactId: String, entry: GuardEntry?, pin: ContactPin, keep: PendingAct? = null): GuardEntry =
    commitGuard(contactId, guardEntryNext(entry, pin.keys), entry?.revision ?: 0uL, keep)

/*
 * One act that changes whom this phone trusts (2.8, "Committing an act"): a pending record naming the exact keys it
 * moves to (written again before every attempt, with the sequence that attempt lands over), the settings saved, then the
 * guard entry at the next revision with the pending record deleted. Only then is the act done; a lost answer, a crash or
 * a failed write between leaves the pending record for the next read to settle. `change` must write a pin of `target`'s
 * keys, or the act stops (ContactMoved).
 */
internal fun Vault.commitTrust(contactId: String, entry: GuardEntry?, target: ContactPin, change: (Settings) -> Unit): Pair<ContactPin, GuardEntry> {
    val keys = target.commitment ?: throw ContactProblem("These keys can’t be remembered.")
    val revision = entry?.revision ?: 0uL
    // An act that leaves what was shared with them on older keys (Continue, a check over new keys, a followed succession)
    // queues the re-seal before anything is saved: a stop after the save or the guard's commit never leaves it owed and
    // unqueued. One that never lands only re-seals to the keys the pin still holds.
    if (target.resealShares) ShareSeals.of(context).queue(contactId)
    val saved = updateSettings(beforeSend = { base ->
        try {
            guard.putPending(contactId, PendingAct(keys, revision, now(), base))
        } catch (_: Exception) {
            throw GuardUnsaved()
        }
    }, change = change)
    val pin = saved.pinOf(contactId)?.takeIf { it.commitment == keys } ?: throw ContactMoved()
    val committed = commitGuard(contactId, guardEntryNext(entry, pin.keys), revision)
    // And again once it landed, at a fresh generation: a re-seal pass that read the earlier request with settings from
    // before this save could skip them (no pin there yet) and acknowledge it; this one only a later pass can.
    if (target.resealShares) ShareSeals.of(context).queue(contactId)
    return pin to committed
}

/*
 * Where this phone stands with one person (2.3, 2.4, 2.8). `act` writes what the person's act needs (a first guard
 * entry, a legacy pin made first-seen, a followed succession); `follow` looks a succession up, only on the person's act,
 * so the server cannot learn whom this phone pins by watching it look people up. In the guard's turn.
 */
internal fun Vault.stand(contact: Contact, act: Boolean, follow: Boolean, pass: MountPass? = null, sealUnsaved: Boolean = false): Standing {
    // A mounting pass reads the settings once for all its shares, and again only after something saved them.
    val settings = pass?.settings ?: loadSettings().also { pass?.settings = it }
    val id = contact.userId
    var pin = settings.pinOf(id)
    var (entry, kept) = guardFor(id, pin, settings.version)
    var trust = pin?.trust
    fun changed() = Standing.Changed(pin, entry,
        entry?.verified == true || (trust == PinTrust.VERIFIED && agreement(id, entry, pin) != GuardVerdict.CHANGED))
    var current = pin ?: run {
        val removed = settings.removed(id)
        val held = entry ?: return Standing.New(null, removed)
        // Removed (here or on an older app) over the keys this phone holds: new again, over others a change.
        val served = contact.commitment
        return if (served != null && served == keyCommitment(held.keys)) Standing.New(held, removed) else changed()
    }
    if (trust == PinTrust.LEGACY || trust == PinTrust.INVALID) {
        // A legacy pin over a guard is settings older than this phone has acted on.
        if (entry != null) return changed()
        val upgraded = firstSeenOfLegacy(current, contact) ?: run {
            val sameClassical = current.encryptionPublicKey == contact.encryptionPublicKey && current.signingPublicKey == contact.signingPublicKey
            return if (sameClassical) Standing.NotUpgraded(current) else changed()
        }
        if (!act) return Standing.Ok(upgraded, entry, false)
        val before = current
        val (saved, held) = try {
            commitTrust(id, entry, upgraded) { it.setPin(upgraded, ifOver = before) }
        } catch (full: ContactProblem) {
            // A rotation (`sealUnsaved`) that can't save the migration for room seals to the keys the legacy pin already
            // holds, as before first-seen pins existed, saving and remembering nothing: no new trust. Left out, the server
            // would revoke them for the owner's full settings; stopped, the rotation would never finish.
            val served = contact.commitment
            if (!sealUnsaved || full.message != Settings.CONTACTS_FULL || served == null || upgraded.commitment != served) throw full
            return Standing.Ok(upgraded, entry, false)
        }
        pass?.settings = null
        current = saved
        entry = held
        pin = current
        trust = PinTrust.SEEN
    }
    if (agreement(id, entry, current) == GuardVerdict.CHANGED) {
        // The settings moved away from what this phone holds: taken only along a chain this phone verifies from the
        // guard's keys to the served ones, which must be the pin's.
        val held = entry
        val served = contact.served.full
        if (!follow || held == null || served == null) return changed()
        val links = runCatching { Auth.succession(context, id, api.session) }.getOrNull() ?: return changed()
        if (guardAgrees(id, GuardState.Held(held), current.keys, served, links) != GuardVerdict.FOLLOWS) return changed()
        if (act) entry = rememberKeys(id, held, current, kept)
    }
    when (current.compare(contact.served)) {
        PinComparison.SAME -> {
            if (act && (entry == null || (trust == PinTrust.VERIFIED && !entry.verified))) entry = rememberKeys(id, entry, current, kept)
            return Standing.Ok(current, entry, false)
        }
        PinComparison.SUCCESSION -> Unit
        PinComparison.RECHECK, PinComparison.CHANGED -> return changed()
    }
    if (!follow) return Standing.Succession(current)
    val links = runCatching { Auth.succession(context, id, api.session) }.getOrNull() ?: return changed()
    val next = followSuccession(current, contact.served, links, now()) ?: return changed()
    if (!act) return Standing.Ok(next, entry, true)
    val from = current
    val (saved, held) = commitTrust(id, entry, next) { stored ->
        val there = stored.pinOf(id)
        // Another device followed it first: its pin is kept as it is, a check included.
        if (ContactPin.sameKeys(there, next)) {
            stored.forgetRemoval(id)
        } else {
            // Only from the keys the chain was checked from, and carrying that pin's standing as it is now.
            if (there == null || !ContactPin.sameKeys(there, from)) throw ContactMoved()
            stored.setPinOnce(followSuccession(there, contact.served, links, now()) ?: throw ContactMoved())
        }
    }
    pass?.settings = null
    return Standing.Ok(saved, held, true)
}

/* An act decided over what the settings held, run again once when another device moved the person's pin before it saved. */
private fun <T> decidedAgain(act: () -> T): T = try {
    act()
} catch (_: ContactMoved) {
    act()
} catch (_: GuardRaced) {
    act()
}

// Acts

/*
 * Add someone (6.2): looked up by email and, when the keys statement holds, remembered at once as a first-seen pin of
 * the keys served now. No words. Someone already added is said so; a change from the keys this phone holds for them (a
 * contact removed and added again over other keys included) is the notice instead. `writer`, from a mark: the account
 * that wrote the item, which the address must be.
 */
fun Vault.addContact(email: String, writer: String? = null, firstSeen: String = "added"): Added {
    // Every guard write and settings save moves the generation: one during the add is a change in trust, even for
    // someone already there (a legacy pin made first-seen, a succession followed, a first guard entry).
    val generation = memory.generation.get()
    val contact = Auth.lookupContact(context, email, api.session)
    if (writer != null && !contact.userId.equals(writer, ignoreCase = true)) {
        throw ContactProblem("This isn’t the account that wrote it. Check the address, then try again.")
    }
    if (!contact.upgraded) throw ContactProblem.notUpgraded(contact.displayName)
    val added = GuardTurn.run { decidedAgain { addDecided(contact, firstSeen) } }
    return if (added is Added.Already) added.copy(trustChanged = memory.generation.get() != generation) else added
}

private fun Vault.addDecided(contact: Contact, firstSeen: String): Added = when (val standing = stand(contact, act = true, follow = true)) {
    is Standing.Ok -> { clearChange(contact.userId); Added.Already(standing.pin) }
    is Standing.NotUpgraded -> throw ContactProblem.notUpgraded(contact.displayName)
    is Standing.Succession -> Added.Changed(note(AccountChange(contact.userId, standing.pin.name, contact.email)))
    is Standing.Changed -> Added.Changed(note(AccountChange(contact.userId, standing.pin?.name ?: contact.name, contact.email)))
    is Standing.New -> {
        val fresh = contact.pin(verified = false, firstSeen = firstSeen)
        // Over nobody: a pin another device saved meanwhile is kept, or stops the add.
        Added.New(commitTrust(contact.userId, standing.entry, fresh) { it.setPin(fresh, ifOver = null) }.first)
    }
}

/*
 * Looks a person up and says where this phone stands with them: for Check it's Maya and the changed-account notice. A
 * followed succession is saved; nobody is added here.
 */
fun Vault.lookup(email: String): Lookup {
    val contact = Auth.lookupContact(context, email, api.session)
    // Every guard write and settings save moves the generation: one here is a change in trust.
    val generation = memory.generation.get()
    val standing = GuardTurn.run { stand(contact, act = true, follow = true) }
    var lookup = when (standing) {
        is Standing.Ok -> Lookup(contact, standing.pin, changed = false, followed = standing.followed)
        is Standing.New -> Lookup(contact, null, changed = false)
        is Standing.Succession -> Lookup(contact, standing.pin, changed = false)
        is Standing.NotUpgraded -> Lookup(contact, standing.pin, changed = false)
        is Standing.Changed -> Lookup(contact, standing.pin, changed = true, wasVerified = standing.wasVerified,
            heldFingerprint = standing.entry?.let { runCatching { keyCommitment(it.keys) }.getOrNull() } ?: standing.pin?.commitment)
    }
    if (lookup.changed) note(AccountChange(contact.userId, lookup.pinned?.name ?: contact.name, contact.email)) else clearChange(contact.userId)
    lookup = lookup.copy(verified = !lookup.changed && lookup.pinned?.verified == true, trustChanged = memory.generation.get() != generation)
    return lookup
}

/* What this phone trusted for a person: the settings pin where it agrees with the guard, else the guard's keys. */
private fun base(before: ContactPin?, entry: GuardEntry?, id: String): Pair<String, List<String>>? {
    if (before != null && agreement(id, entry, before) != GuardVerdict.CHANGED) return before.signingPublicKey to before.previousSigningKeys
    return entry?.let { it.signingPublicKey to it.previousSigningKeys }
}

/*
 * The pin a person moves to when they accept keys this phone did not follow there (Continue, or They match over new
 * keys): the served keys, the signing keys this phone held kept as earlier ones (what they signed reads as theirs with
 * earlier keys), and what was shared with them waiting to be sealed to the new keys. A family's word goes: the pin is
 * this person's own now.
 */
private fun acceptedPin(before: ContactPin?, base: Pair<String, List<String>>?, contact: Contact, keys: com.hushos.core.PinKeys): ContactPin {
    val previous = ((base?.second ?: emptyList()) + listOfNotNull(base?.first)).distinct().filter { it != keys.signingPublicKey }
    return ContactPin.of(contact.userId, contact.email, contact.name, keys, now(), before?.firstSeen ?: "added")
        .copy(previousSigningKeys = previous, resealShares = true)
}

/*
 * Continue on "Maya's account changed" (6.7): the keys served now, looked up afresh, become a first-seen pin, and what
 * waited runs: what was shared with them is sealed again, to these keys only. A verified pin loses its verified state;
 * Check it's Maya restores it.
 */
fun Vault.continueWith(change: AccountChange): ContactPin {
    val contact = Auth.lookupContact(context, change.email, api.session)
    if (!contact.userId.equals(change.contactId, ignoreCase = true)) throw ContactProblem.otherAccount()
    if (!contact.upgraded) throw ContactProblem.notUpgraded(contact.displayName)
    val pin = GuardTurn.run {
        val settings = loadSettings()
        val before = settings.pinOf(contact.userId)
        val (entry, _) = guardFor(contact.userId, before, settings.version)
        val keys = contact.pin(verified = false, firstSeen = null).keys
        val target = acceptedPin(before, base(before, entry, contact.userId), contact, keys)
        commitTrust(contact.userId, entry, target) { it.setPin(target, ifOver = before) }.first
    }
    clearChange(contact.userId)
    forgetLookups(contact.userId)
    return pin
}

/*
 * They match (6.6): a verified pin of the keys whose words were just compared. Over the keys this phone held it stays as
 * it was in every other way; over others it is a Continue that is also a check. Only for an upgraded identity whose keys
 * statement held. What was shared with them in an older suite (or waiting for new keys) is sealed again next.
 */
fun Vault.theyMatch(found: Lookup): ContactPin {
    val contact = found.contact
    val keys = contact.pin(verified = true, firstSeen = null).keys
    val pin = GuardTurn.run {
        val settings = loadSettings()
        val before = settings.pinOf(contact.userId)
        val (entry, _) = guardFor(contact.userId, before, settings.version)
        val held = base(before, entry, contact.userId)
        val moved = (held != null && held.first != contact.signingPublicKey) || (before != null && before.encryptionPublicKey != contact.encryptionPublicKey)
        val target = if (moved) acceptedPin(before, held, contact, keys) else {
            // The pin is the reader's own check now, not a family's word.
            (before ?: ContactPin.of(contact.userId, contact.email, contact.name, keys, "", "added"))
                .replacing(keys, pinnedAt = now(), name = contact.name, email = contact.email).copy(trustedVia = null)
        }
        commitTrust(contact.userId, entry, target) { it.setPin(target, ifOver = before, verify = true) }.first
    }
    clearChange(contact.userId)
    forgetLookups(contact.userId)
    ShareSeals.of(context).lastPass = 0L
    return pin
}

/*
 * Removing forgets the pin and records the removal in the settings (2.8), so no device adds them back on its own when
 * they share something: it waits until the person opens it. This phone's guard keeps what it saw.
 */
fun Vault.remove(contactId: String) {
    updateSettings { it.removeContact(contactId, now()) }
    clearChange(contactId)
    forgetLookups(contactId)
}

// Sharing and opening

/*
 * The keys a share to a contact is sealed to (X25519, ML-KEM): behind the share sheet (`follow`, the person's act), and
 * when the server names the grantee (rotation, the re-seal pass). The served keys must be the pinned ones, the pin must
 * agree with this phone's guard, and a legacy pin becomes first-seen first. Anything else shares nothing; a changed
 * account throws AccountChanged.
 */
fun Vault.trustGrantee(contact: Contact, follow: Boolean, sealUnsaved: Boolean = false): Pair<ByteArray, ByteArray> = GuardTurn.run {
    when (val standing = stand(contact, act = true, follow = follow, sealUnsaved = sealUnsaved)) {
        is Standing.New -> throw ContactProblem.unpinned()
        is Standing.Changed -> {
            val pin = standing.pin ?: throw ContactProblem.unpinned()
            throw AccountChanged(note(AccountChange(pin.userId, pin.name, pin.email)))
        }
        is Standing.NotUpgraded -> throw ContactProblem.notUpgraded(standing.pin.displayName)
        is Standing.Succession -> throw SharingRefused("${standing.pin.firstName} updated their account. Share with them again to follow it.")
        is Standing.Ok -> {
            // Same (or followed to them): the served ML-KEM key is the one the pin's digest names.
            val kem = contact.served.kemPublicKey?.let { runCatching { base64urlDecode(it) }.getOrNull() } ?: throw ContactProblem.notUpgraded(standing.pin.displayName)
            base64urlDecode(standing.pin.encryptionPublicKey) to kem
        }
    }
}

/* The changed-account check behind a share sheet's row: looks them up (kept a minute); nothing is written. */
fun Vault.shareeChanged(pin: ContactPin): Boolean {
    val contact = cachedLookup(pin.email)
    if (!contact.userId.equals(pin.userId, ignoreCase = true)) return true
    val standing = GuardTurn.run { stand(contact, act = false, follow = false) }
    if (standing !is Standing.Changed) return false
    note(AccountChange(pin.userId, pin.name, pin.email))
    return true
}

/*
 * A contact looked up for display (the share sheet's rows), kept for a minute: the server allows an account sixty
 * lookups a minute, and Add and Share need theirs. Never what anything is sealed to or opened with (those look up
 * afresh); forgotten for a person on Continue, They match and removal, and with the vault at sign-out.
 */
fun Vault.cachedLookup(email: String): Contact {
    val key = email.lowercase()
    val now = memory.clock()
    memory.lookedUp[key]?.let { (contact, at) -> if (now - at < TrustMemory.LOOKUP_KEPT_MS) return contact }
    val contact = Auth.lookupContact(context, email, api.session)
    memory.lookedUp[key] = contact to now
    return contact
}

fun Vault.forgetLookups(contactId: String) {
    memory.lookedUp.entries.removeIf { it.value.first.userId.equals(contactId, ignoreCase = true) }
}

/*
 * Which keys to open a share with (6.4). From someone pinned, the pinned keys, only when the served keys are those or a
 * signed succession leads to them, and the pin agrees with this phone's guard. From someone this account never had as a
 * contact, the keys the share came with are pinned first-seen and it opens. Two things wait for the person's own Open
 * (`explicit`): following a signed succession, and adding back someone this account removed or this phone acted on
 * before (its guard holds them, their pin gone), so a removal sticks. One verdict per granter and full identity within
 * a pass: the same person's other shares under the same keys are judged alike, and other keys (a change mid-list) never
 * take a verdict made over these.
 */
internal fun Vault.trustGranter(share: ShareView, explicit: Boolean, pass: MountPass? = null): GranterKey {
    val contact = share.granterContact()
    val key = MountPass.key(contact, explicit)
    pass?.verdicts?.get(key)?.let { return it.getOrThrow() }
    val verdict = runCatching { judgeGranter(contact, explicit, pass) }
    pass?.verdicts?.put(key, verdict)
    return verdict.getOrThrow()
}

private fun Vault.judgeGranter(contact: Contact, explicit: Boolean, pass: MountPass?): GranterKey {
    val first = contact.firstName
    val removedWords = "You removed $first from your contacts. Open this to add them again."
    return GuardTurn.run {
        decidedAgain {
            var standing = try {
                stand(contact, act = true, follow = explicit, pass = pass)
            } catch (error: Exception) {
                pass?.settings = null
                throw error
            }
            if (standing is Standing.New && !explicit && (standing.removed || standing.entry != null)) {
                throw GranterTrust.Waiting(if (standing.removed) removedWords else "Open this to add $first to your contacts.")
            }
            if (standing is Standing.Succession) throw GranterTrust.Waiting("$first updated their account. Open this to carry on.")
            if (standing is Standing.New) {
                if (!contact.upgraded) throw GranterTrust.Unverified("$first needs to sign in to HushOS once more before this opens.")
                val fresh = contact.pin(verified = false, firstSeen = "shared-with-me")
                try {
                    // Listing never undoes a removal: one recorded on any attempt of this save stops the add.
                    val (pin, entry) = commitTrust(contact.userId, standing.entry, fresh) { settings ->
                        if (!explicit && settings.removed(contact.userId)) throw GranterTrust.Waiting(removedWords)
                        settings.setPin(fresh, ifOver = null)
                    }
                    standing = Standing.Ok(pin, entry, false)
                } catch (full: ContactProblem) {
                    if (full.message == Settings.CONTACTS_FULL) throw GranterTrust.Unverified(Settings.CONTACTS_FULL)
                    throw full
                } finally {
                    // Saved (or refused against settings newer than the pass read): the next share reads them again.
                    pass?.settings = null
                }
            }
            when (val settled = standing) {
                is Standing.NotUpgraded -> throw GranterTrust.Unverified("${settled.pin.firstName} needs to sign in to HushOS once more before this opens.")
                is Standing.Ok -> {
                    val keys = granterKeysOf(settled.pin, contact.served)
                        ?: throw GranterTrust.Changed(note(AccountChange(contact.userId, settled.pin.name, settled.pin.email)))
                    GranterKey(keys, settled.pin.previousSigningKeys.isNotEmpty())
                }
                is Standing.Changed -> throw GranterTrust.Changed(note(AccountChange(contact.userId, settled.pin?.name ?: contact.name, settled.pin?.email ?: contact.email)))
                is Standing.New, is Standing.Succession -> throw GranterTrust.Changed(note(AccountChange(contact.userId, contact.name, contact.email)))
            }
        }
    }
}

/*
 * Open on a row that waits (6.4): the person's own act, so someone removed is added back (the removal forgotten) and a
 * signed succession is followed; then everything they shared opens on the next listing. A change met on the way throws
 * GranterTrust.Changed.
 */
fun Vault.openWaiting(share: ShareView) {
    try {
        trustGranter(share, explicit = true)
    } catch (_: GuardUnreadable) {
        throw GranterTrust.Unchecked()
    }
}

/*
 * The settings pins and this phone's guard entries as one view, read in the guard's turn, for the readers that judge
 * from them (who wrote what, and Verified on Contacts). Every act left pending is settled first, and a pin that came
 * with the settings with nothing for it in the guard yet (a new phone, one signed back into) is written to the guard
 * before it is used, so a later change made on another device is met here as a change, never as first use.
 */
internal fun Vault.guardedView(): Pair<Map<String, ContactPin>, Map<String, GuardEntry>> = GuardTurn.run {
    val settings = loadSettings()
    fun read() = try { guard.record() } catch (_: Exception) { throw GuardUnreadable() }
    var record = read()
    val due = record.pending.keys.toMutableSet()
    for (pin in settings.contacts.values) if (record.entries[pin.userId.lowercase()] == null && pin.held) due.add(pin.userId.lowercase())
    if (due.isNotEmpty()) {
        for (id in due) {
            val pin = settings.pinOf(id)
            val (entry, kept) = guardFor(id, pin, settings.version)
            if (entry != null || pin == null || !pin.held) continue
            rememberKeys(id, null, pin, kept)
        }
        record = read()
    }
    settings.contacts to record.entries.toMap()
}

/*
 * Where each contact stands on this phone, from the settings and the guard alone (no lookup): Verified only for a
 * verified pin that agrees with the guard; a pin that disagrees with it is an account changed. A guard that can't be
 * read fails the whole list: nobody is shown verified.
 */
fun Vault.contactStandings(): Map<String, ContactStanding> {
    val (pins, entries) = guardedView()
    return pins.values.associate { pin ->
        val held = agreement(pin.userId, entries[pin.userId.lowercase()], pin)
        pin.userId.lowercase() to ContactStanding(held != GuardVerdict.CHANGED && pin.verified, held == GuardVerdict.CHANGED)
    }
}

/*
 * Who may have written what Drive lists, beside this account: every pin, verified or first-seen, as the guard allows (one
 * that vouches for nothing for its name and address only, never its keys). A
 * pin that disagrees with the guard vouches for nothing, and the guard's keys stand in for it, never verified.
 */
internal fun Vault.effectivePins(): List<ContactPin> {
    val (pins, entries) = guardedView()
    return pins.values.mapNotNull { pin ->
        val entry = entries[pin.userId.lowercase()]
        when {
            // A pin that vouches for nothing (legacy, invalid) is kept for its name and address, so its writer's mark offers
            // Check it's Maya; Trust.of never trusts its keys.
            agreement(pin.userId, entry, pin) != GuardVerdict.CHANGED -> pin
            entry != null -> ContactPin.of(pin.userId, pin.email, pin.name, entry.keys, pin.pinnedAt, null).copy(previousSigningKeys = entry.previousSigningKeys)
            else -> null
        }
    }
}

/*
 * The share sheet's check of who on an item has an account that changed: at most `parallel` lookups at once (the
 * server allows an account sixty a minute, and each is kept a minute by the vault), by lowercased id. A lookup that
 * fails is never read as "nothing changed": the first failure comes back for the sheet to say.
 */
object ShareeChecks {
    suspend fun changed(pins: List<ContactPin>, parallel: Int = 3, check: (ContactPin) -> Boolean): Pair<Set<String>, Throwable?> =
        kotlinx.coroutines.coroutineScope {
            val gate = kotlinx.coroutines.sync.Semaphore(parallel)
            val results = pins.distinctBy { it.userId.lowercase() }.map { pin ->
                async { gate.withPermit { pin.userId.lowercase() to runCatching { check(pin) } } }
            }.awaitAll()
            results.filter { it.second.getOrNull() == true }.map { it.first }.toSet() to results.firstNotNullOfOrNull { it.second.exceptionOrNull() }
        }
}
