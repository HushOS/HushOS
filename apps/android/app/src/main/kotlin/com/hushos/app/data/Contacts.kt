package com.hushos.app.data

import com.hushos.core.HybridPublicKey
import com.hushos.core.IdentityKeys
import com.hushos.core.PinComparison
import com.hushos.core.PinKeys
import com.hushos.core.PinTrust
import com.hushos.core.PinnedKeys
import com.hushos.core.PublicIdentity
import com.hushos.core.ServedContactKeys
import com.hushos.core.ServedKeys
import com.hushos.core.SettingsEnvelope
import com.hushos.core.ShareContext
import com.hushos.core.SuccessionLink
import com.hushos.core.base64urlDecode
import com.hushos.core.identityFingerprintOfKeys
import com.hushos.core.identityVerifyKeys
import com.hushos.core.keyCommitment
import com.hushos.core.keyDigest
import com.hushos.core.pinOfServed
import com.hushos.core.pinTrust
import com.hushos.core.settingsOpen
import com.hushos.core.shareOpen
import com.hushos.core.successionChainVerify
import org.json.JSONArray
import org.json.JSONObject
import java.time.Instant

/*
 * Someone's public identity as the server serves it (contact lookups, a share's granter, shared-by-me grantees,
 * rotation work, report operators; docs/identity-pq-design.md): all four public keys and a version 2 identity's keys
 * statement. A version 1 identity (not upgraded yet) has no ML-DSA key and no statement and is trusted with nothing;
 * only a version 3 pin vouches for any of these.
 */
data class ServedIdentity(
    /* The identity's generation: a succession raises it, and a pin remembers it. Null when the server sent none. */
    val keyVersion: ULong?,
    val encryptionPublicKey: String,
    val signingPublicKey: String,
    val mlDsaPublicKey: String? = null,
    val kemPublicKey: String? = null,
    val identityVersion: Int = 1,
    val keysSignature: String? = null,
) {
    /*
     * Whether this is a version 2 identity whose keys statement holds (both halves of its hybrid signature, over all
     * four keys, the account and the key version): the only kind words can be compared over. Not by itself a reason
     * to trust anyone; a words check over the version 3 fingerprint is.
     */
    fun keysHold(userId: String): Boolean {
        if (identityVersion != 2) return false
        val version = keyVersion ?: return false
        val mlDsa = mlDsaPublicKey ?: return false
        val kem = kemPublicKey ?: return false
        val signature = keysSignature ?: return false
        return runCatching { identityVerifyKeys(userId, PublicIdentity(version, encryptionPublicKey, signingPublicKey, mlDsa, kem, signature)) }.getOrDefault(false)
    }

    /* As the core compares them; no key version reads as 0, which never makes a succession. */
    val core: ServedContactKeys get() = ServedContactKeys(keyVersion ?: 0uL, encryptionPublicKey, signingPublicKey, mlDsaPublicKey, kemPublicKey)

    /* The four keys in full, as a pin is made of them; null for an identity that has not upgraded. */
    val full: ServedKeys? get() {
        val mlDsa = mlDsaPublicKey ?: return null
        val kem = kemPublicKey ?: return null
        return ServedKeys(keyVersion ?: 0uL, encryptionPublicKey, signingPublicKey, mlDsa, kem)
    }

    /* As the API serves it, for code that takes the wire shape (planReseal). */
    fun toJson(): JSONObject = JSONObject().put("keyVersion", keyVersion?.toLong() ?: JSONObject.NULL).put("identityVersion", identityVersion)
        .put("encryptionPublicKey", encryptionPublicKey).put("signingPublicKey", signingPublicKey)
        .put("mlDsaPublicKey", mlDsaPublicKey ?: JSONObject.NULL).put("kemPublicKey", kemPublicKey ?: JSONObject.NULL)
        .put("keysSignature", keysSignature ?: JSONObject.NULL)

    companion object {
        private fun JSONObject.text(key: String): String? = if (!has(key) || isNull(key)) null else optString(key).ifEmpty { null }

        fun from(json: JSONObject) = ServedIdentity(
            if (!json.has("keyVersion") || json.isNull("keyVersion")) null else json.optLong("keyVersion").takeIf { it >= 1 }?.toULong(),
            json.optString("encryptionPublicKey"), json.optString("signingPublicKey"),
            json.text("mlDsaPublicKey"), json.text("kemPublicKey"),
            json.optInt("identityVersion", 1), json.text("keysSignature"),
        )
    }
}

/* A person as `POST /api/auth/contacts/lookup` describes them. */
data class Contact(val userId: String, val name: String, val email: String, val served: ServedIdentity) {
    val encryptionPublicKey: String get() = served.encryptionPublicKey
    val signingPublicKey: String get() = served.signingPublicKey
    val keyVersion: ULong? get() = served.keyVersion

    /*
     * Whether their identity is version 2 with a keys statement that holds: false for someone who has not signed in
     * since the post-quantum release, whose words cannot be compared yet.
     */
    val upgraded: Boolean by lazy { served.keysHold(userId) }

    /* The version 3 fingerprint over their four keys, to compare over another channel; null until they upgraded. */
    val fingerprint: String? by lazy {
        if (!upgraded) null else runCatching {
            identityFingerprintOfKeys(base64urlDecode(served.encryptionPublicKey), base64urlDecode(served.signingPublicKey),
                base64urlDecode(served.mlDsaPublicKey!!), base64urlDecode(served.kemPublicKey!!))
        }.getOrNull()
    }

    val displayName: String get() = name.ifEmpty { email }
    val firstName: String get() = firstNameOf(displayName)

    /*
     * Everything a verdict on this person is judged by: a verdict kept for one pass (mounting received shares, a
     * rotation, the re-seal pass) is reused only for exactly these keys, never for other keys served for the same
     * person later in the pass.
     */
    val trustKey: String get() = listOf(userId.lowercase(), served.keyVersion?.toString() ?: "-", served.identityVersion.toString(),
        served.encryptionPublicKey, served.signingPublicKey, served.mlDsaPublicKey ?: "-", served.kemPublicKey ?: "-", served.keysSignature ?: "-").joinToString("|")

    /* The key commitment of the served keys, or null for an identity that can't be pinned. */
    val commitment: String? get() = served.full?.let { runCatching { keyCommitment(pinOfServed(it, false)) }.getOrNull() }

    /* A pin of the served keys (`verified` only after They match): only for an upgraded identity whose keys statement held. */
    fun pin(verified: Boolean, firstSeen: String?, at: String = Instant.now().toString()): ContactPin {
        val full = served.full?.takeIf { upgraded } ?: throw ContactProblem.notUpgraded(displayName)
        return ContactPin.of(userId, email, name, pinOfServed(full, verified), at, firstSeen)
    }
}

/* The first word of a name, as every sentence about someone says it ("Maya’s account changed"). */
fun firstNameOf(name: String): String = name.trim().split(Regex("\\s+")).firstOrNull { it.isNotEmpty() } ?: name

/*
 * What a pin keeps of a contact, as the settings document stores it. A version 3 pin (docs/identity-pq-design.md 2)
 * holds the X25519 and Ed25519 keys, the SHA-256 (hex) of the ML-DSA and ML-KEM keys, and the version 3 fingerprint
 * over all four; it is version 3 exactly when it carries `mlDsaPublicKeyHash`. Pins made before trust nothing.
 */
data class ContactPin(
    val userId: String, val email: String, val name: String, val encryptionPublicKey: String, val signingPublicKey: String,
    val fingerprint: String, val pinnedAt: String, val kemPublicKeyHash: String?, val mlDsaPublicKeyHash: String?,
    /* The identity version the pin was made or last followed at; null on pins made before successions. */
    val keyVersion: ULong? = null,
    /* Signing keys this person held before, each vouched for by a checked succession: what they signed then still verifies. */
    val previousSigningKeys: List<String> = emptyList(),
    /* When the pin followed a signed succession to new keys, until the words are compared again: People says so. */
    val keysReplacedAt: String? = null,
    /*
     * Set when the pin followed a succession: what this person shared with them still holds the old keys and waits to be
     * sealed to the new ones (the web clears it once it has). Synced, and written only when set, so a save from here
     * never clears another client's.
     */
    val resealShares: Boolean = false,
    /*
     * The group the pin was trusted through ("Trust as Acme does"), the web's `trustedVia`: the group's word for these
     * keys, not a words check. Kept when the pin follows a succession, cleared when the words are compared again. Group
     * verdicts ask the successor's consent of links from such a pin, and no member is admitted from one.
     */
    val trustedVia: String? = null,
    /* Where this person was first met ("added", "shared-with-me", "family"): informational, read by no rule. */
    val firstSeen: String? = null,
) {
    /* The key fields every pin rule reads (the core's PinKeys). */
    val keys: PinKeys get() = PinKeys(keyVersion, encryptionPublicKey, signingPublicKey, mlDsaPublicKeyHash, kemPublicKeyHash, fingerprint)

    /* Verified (a words check), seen (first-seen: the keys first met, nobody checked), legacy or invalid: the core's one rule. */
    val trust: PinTrust by lazy { pinTrust(keys) }

    /* Whether the words were compared over all four keys (`pin_verified`): first-seen and legacy pins are not. */
    val verified: Boolean get() = trust == PinTrust.VERIFIED

    /* Verified or first-seen: a pin the guard remembers and a share may be sealed to. */
    val held: Boolean get() = trust == PinTrust.VERIFIED || trust == PinTrust.SEEN

    /* The key commitment over its four keys (never `fingerprint`, which every first-seen pin holds as ""); null when malformed. */
    val commitment: String? by lazy { runCatching { keyCommitment(keys) }.getOrNull() }

    /* What this pin says about the keys served now: the core's `compare_pin`. */
    fun compare(served: ServedIdentity): PinComparison = com.hushos.core.comparePin(keys, served.core)

    /* This pin over other keys: every other field kept. */
    fun replacing(keys: PinKeys, pinnedAt: String = this.pinnedAt, name: String = this.name, email: String = this.email): ContactPin =
        copy(email = email, name = name, encryptionPublicKey = keys.encryptionPublicKey, signingPublicKey = keys.signingPublicKey,
            fingerprint = keys.fingerprint, pinnedAt = pinnedAt, kemPublicKeyHash = keys.kemPublicKeyHash, mlDsaPublicKeyHash = keys.mlDsaPublicKeyHash,
            keyVersion = keys.keyVersion)

    val displayName: String get() = name.ifEmpty { email }
    val firstName: String get() = firstNameOf(displayName)

    /* Writes the pin's fields into `json`, leaving any field another client added as it was. */
    fun writeInto(json: JSONObject): JSONObject {
        json.put("userId", userId).put("email", email).put("name", name)
            .put("encryptionPublicKey", encryptionPublicKey).put("signingPublicKey", signingPublicKey).put("fingerprint", fingerprint)
            .put("pinnedAt", pinnedAt).put("kemPublicKeyHash", kemPublicKeyHash ?: JSONObject.NULL)
            .put("keyVersion", keyVersion?.toLong() ?: JSONObject.NULL)
        if (mlDsaPublicKeyHash == null) json.remove("mlDsaPublicKeyHash") else json.put("mlDsaPublicKeyHash", mlDsaPublicKeyHash)
        if (previousSigningKeys.isEmpty()) json.remove("previousSigningKeys") else json.put("previousSigningKeys", JSONArray(previousSigningKeys))
        if (keysReplacedAt == null) json.remove("keysReplacedAt") else json.put("keysReplacedAt", keysReplacedAt)
        if (resealShares) json.put("resealShares", true)
        // Known here: a words check (no origin) clears a group's; a followed pin carries it on.
        if (trustedVia == null) json.remove("trustedVia") else json.put("trustedVia", trustedVia)
        // Informational, and only ever written: another client's stays as it was.
        if (firstSeen != null) json.put("firstSeen", firstSeen)
        return json
    }

    companion object {
        fun from(json: JSONObject) = ContactPin(
            json.getString("userId"), json.optString("email"), json.optString("name"), json.getString("encryptionPublicKey"),
            json.optString("signingPublicKey"), json.optString("fingerprint"), json.optString("pinnedAt"),
            if (json.isNull("kemPublicKeyHash")) null else json.optString("kemPublicKeyHash").ifEmpty { null },
            if (json.isNull("mlDsaPublicKeyHash")) null else json.optString("mlDsaPublicKeyHash").ifEmpty { null },
            if (!json.has("keyVersion") || json.isNull("keyVersion")) null else json.optLong("keyVersion").takeIf { it >= 1 }?.toULong(),
            json.optJSONArray("previousSigningKeys")?.let { a -> (0 until a.length()).mapNotNull { a.optString(it).ifEmpty { null } } }.orEmpty(),
            if (json.isNull("keysReplacedAt")) null else json.optString("keysReplacedAt").ifEmpty { null },
            json.optBoolean("resealShares", false),
            // An empty origin stays empty, for the core to refuse, never read as a words check.
            if (!json.has("trustedVia") || json.isNull("trustedVia")) null else json.optString("trustedVia"),
            if (!json.has("firstSeen") || json.isNull("firstSeen")) null else json.optString("firstSeen"),
        )

        /* A pin of `keys` for a person, with nothing else carried over. */
        fun of(userId: String, email: String, name: String, keys: PinKeys, pinnedAt: String, firstSeen: String?) = ContactPin(
            userId, email, name, keys.encryptionPublicKey, keys.signingPublicKey, keys.fingerprint, pinnedAt, keys.kemPublicKeyHash,
            keys.mlDsaPublicKeyHash, keys.keyVersion, firstSeen = firstSeen,
        )

        /* Whether two pins hold the same keys: by key commitment, or for pins without one, by every key field. */
        fun sameKeys(a: ContactPin?, b: ContactPin?): Boolean {
            if (a == null || b == null) return a == null && b == null
            val (left, right) = a.commitment to b.commitment
            if (left != null || right != null) return left == right
            return a.encryptionPublicKey == b.encryptionPublicKey && a.signingPublicKey == b.signingPublicKey &&
                a.mlDsaPublicKeyHash == b.mlDsaPublicKeyHash && a.kemPublicKeyHash == b.kemPublicKeyHash
        }

        /*
         * The version 3 pin of keys whose words were just compared: their X25519 and Ed25519 keys, the digests of their
         * ML-DSA and ML-KEM keys, and the fingerprint over all four. Null when the served identity has no ML-DSA or
         * ML-KEM key (not upgraded): words are never compared over fewer than four keys.
         */
        fun ofServed(userId: String, email: String, name: String, served: ServedIdentity, pinnedAt: String): ContactPin? {
            val mlDsa = served.mlDsaPublicKey ?: return null
            val kem = served.kemPublicKey ?: return null
            val print = runCatching {
                identityFingerprintOfKeys(base64urlDecode(served.encryptionPublicKey), base64urlDecode(served.signingPublicKey), base64urlDecode(mlDsa), base64urlDecode(kem))
            }.getOrNull() ?: return null
            return ContactPin(userId, email, name, served.encryptionPublicKey, served.signingPublicKey, print, pinnedAt,
                keyDigest(base64urlDecode(kem)), keyDigest(base64urlDecode(mlDsa)), served.keyVersion)
        }
    }
}

/* A share as the owner sees it. */
data class OwnedShare(val id: String, val role: String, val keyEpoch: ULong, val createdAt: String, val suite: Int, val granteeId: String, val granteeName: String, val granteeEmail: String) {
    companion object {
        fun from(json: JSONObject): OwnedShare {
            val grantee = json.getJSONObject("grantee")
            return OwnedShare(json.getString("id"), json.getString("role"), json.getLong("keyEpoch").toULong(), json.getString("createdAt"),
                json.optInt("suite"), grantee.getString("id"), grantee.optString("name"), grantee.optString("email"))
        }
    }
}


/* Where this phone stands with someone looked up by email: for Check it's Maya and the changed-account notice. */
data class Lookup(
    val contact: Contact,
    /* The pin held for this person, after any succession it followed just now. */
    val pinned: ContactPin?,
    /* The served keys are not the ones this phone holds and no signed chain explains it: the notice, never a silent update. */
    val changed: Boolean,
    /* The pin is verified and agrees with this phone: "Verified", and Check again. */
    val verified: Boolean = false,
    /* For a change: whether this phone had them checked, so the notice leads with a check. */
    val wasVerified: Boolean = false,
    /* For a change: the key commitment of the keys this phone held, for Technical details. */
    val heldFingerprint: String? = null,
    /* The pin followed their signed succession to the keys looked up just now. */
    val followed: Boolean = false,
    /* The lookup itself saved or remembered something: whom signatures count for moved, so what is drawn is judged again. */
    val trustChanged: Boolean = false,
) {
    /* Words can be compared, and a pin made, only over an upgraded identity whose keys statement holds. */
    val upgraded: Boolean get() = contact.upgraded
}

/* SHA-256 (hex) of a base64url public key, or null when it does not decode. */
private fun digestOf(publicKey: String): String? = runCatching { keyDigest(base64urlDecode(publicKey)) }.getOrNull()

/*
 * The key version a chain is asked for from: always the first, so the request says nothing of the version a pin is
 * at (docs/integrity-design.md, "Who sees whom"). The core finds where the pinned keys enter the chain by keys.
 */
const val CHAIN_FROM: ULong = 1uL

/*
 * The pin after a succession, or null when the chain does not carry it from the pinned keys to the served ones (the
 * core checks every link, version 2 only: continuity by keys, ML-DSA included, each signed with both halves by the
 * keys it replaces, versions rising, the served four keys at the end). A pin that follows becomes the version 3 pin of
 * the served keys, keeps every signing key the chain passed through (what they signed before still verifies), and is
 * marked so People can suggest comparing words again: a succession made with stolen keys is still a change the person
 * did not make. It is also marked `resealShares`, as the web's pinAfterSuccession does: shares to them still hold the
 * old keys.
 */
fun followSuccession(pin: ContactPin, served: ServedIdentity, links: List<SuccessionLink>, now: String): ContactPin? {
    if (pin.compare(served) != PinComparison.SUCCESSION) return null
    val mlDsaHash = pin.mlDsaPublicKeyHash ?: return null
    val version = served.keyVersion ?: return null
    val mlDsa = served.mlDsaPublicKey ?: return null
    val kem = served.kemPublicKey ?: return null
    val holds = runCatching {
        successionChainVerify(pin.userId, PinnedKeys(pin.keyVersion, pin.encryptionPublicKey, pin.signingPublicKey, mlDsaHash),
            ServedKeys(version, served.encryptionPublicKey, served.signingPublicKey, mlDsa, kem), links)
    }.getOrDefault(false)
    if (!holds) return null
    // A followed first-seen pin stays first-seen: the chain carries the pin's standing, never a check nobody made.
    val keys = runCatching { pinOfServed(ServedKeys(version, served.encryptionPublicKey, served.signingPublicKey, mlDsa, kem), pin.verified) }.getOrNull() ?: return null
    val next = pin.replacing(keys)
    val start = chainStart(pin, links)
    // The core verified a chain this client finds no start for: the two start rules disagree. Followed all the same,
    // keeping the pinned key. No keys or addresses in the line; JVM tests have no Log, hence runCatching.
    if (start == null) runCatching { android.util.Log.e("HushOSTrust", "a verified succession chain has no start by the client's rule (${links.size} links)") }
    return next.copy(
        previousSigningKeys = previousKeysAfter(pin, links, start, served.signingPublicKey),
        keysReplacedAt = now,
        resealShares = true,
        // Followed from a pin trusted through a group: still that group's word, as on the web.
        trustedVia = pin.trustedVia,
    )
}

/*
 * The signing keys a followed pin keeps as replaced, oldest first: the ones it kept already, its own signing key (always:
 * what it signed is still this person's, even if `start` were ever not found where the core started), then the old key
 * of every link from `start`, the links the core verified, through the end. The served key is the current one, never a
 * previous one.
 */
internal fun previousKeysAfter(pin: ContactPin, links: List<SuccessionLink>, start: Int?, servedSigningKey: String): List<String> {
    val passed = listOf(pin.signingPublicKey) + (start?.let { links.drop(it).map { link -> link.oldSigningPublicKey } } ?: emptyList())
    return (pin.previousSigningKeys + passed).distinct().filter { it != servedSigningKey }
}

/*
 * Where the core starts the chain (succession_chain_verify): the first link whose old X25519, Ed25519 and ML-DSA keys
 * are the pin's, the ML-DSA key by its digest. A link in front of it is never checked, so nothing it names may be kept:
 * a decoy at the pinned classical keys with another ML-DSA key, followed by a link naming the server's own key as an
 * old one, would otherwise put that key among the previous signing keys.
 */
internal fun chainStart(pin: ContactPin, links: List<SuccessionLink>): Int? {
    val mlDsaHash = pin.mlDsaPublicKeyHash ?: return null
    return links.indexOfFirst {
        it.oldEncryptionPublicKey == pin.encryptionPublicKey && it.oldSigningPublicKey == pin.signingPublicKey && digestOf(it.oldMlDsaPublicKey) == mlDsaHash
    }.takeIf { it >= 0 }
}

/*
 * The owner's own record of what they shared: per node, the people it was shared with; per link,
 * its node. The server's lists are only a claim; only what is here is ever sealed again.
 */
data class SharingLedger(val shares: Map<String, Set<String>>, val links: Map<String, String>) {
    fun hasShare(nodeId: String, granteeUserId: String) = shares[nodeId]?.contains(granteeUserId) == true
    fun hasLink(linkId: String, nodeId: String) = links[linkId] == nodeId
}

/*
 * The settings document, opened, as the JSON it is: the pins, the sharing ledger, and whatever
 * another client added, which every edit here keeps as it was. Edits change the JSON in place.
 */
class Settings(val json: JSONObject, val version: ULong) {
    private fun contactsJson(): JSONObject = json.optJSONObject("contacts") ?: JSONObject().also { json.put("contacts", it) }
    private fun sharingJson(): JSONObject = json.optJSONObject("sharing") ?: JSONObject().also { json.put("sharing", it) }
    private fun sharesJson(): JSONObject = sharingJson().let { s -> s.optJSONObject("shares") ?: JSONObject().also { s.put("shares", it) } }
    private fun linksJson(): JSONObject = sharingJson().let { s -> s.optJSONObject("links") ?: JSONObject().also { s.put("links", it) } }

    /* The pins by user id; one that can't be read is left out here and left alone in the document. */
    val contacts: Map<String, ContactPin> get() {
        val entries = json.optJSONObject("contacts") ?: return emptyMap()
        val out = LinkedHashMap<String, ContactPin>()
        for (key in entries.keys()) entries.optJSONObject(key)?.let { runCatching { ContactPin.from(it) }.getOrNull() }?.let { out[key] = it }
        return out
    }

    fun pin(pin: ContactPin) {
        val all = contactsJson()
        all.put(pin.userId, pin.writeInto(all.optJSONObject(pin.userId) ?: JSONObject()))
    }

    /* The pin of `userId`, under its id in any letters (the web's pinOf). */
    fun pinOf(userId: String): ContactPin? {
        val all = contacts
        return all[userId] ?: all.entries.firstOrNull { it.key.equals(userId, ignoreCase = true) }?.value
    }

    /*
     * `pin` written for its person, under the served id, their removal forgotten (they are a contact again), and
     * removals forgotten oldest first for room; refused with CONTACTS_FULL, changing nothing, when the document would not
     * seal even without any. A pin another client stored under the id in other letters moves to the served id first,
     * whole: the fields this version doesn't know (another client's, a later version's) go with it, and only then are
     * the known ones written over.
     */
    fun setPinOnce(pin: ContactPin) {
        val before = json.toString()
        val all = contactsJson()
        val others = all.keys().asSequence().filter { it != pin.userId && it.equals(pin.userId, ignoreCase = true) }.sorted().toList()
        if (!all.has(pin.userId)) others.firstOrNull()?.let { all.put(pin.userId, all.getJSONObject(it)) }
        for (key in others) all.remove(key)
        pin(pin)
        forgetRemoval(pin.userId)
        fit()
        if (bytes() > MAX_BYTES) {
            // Nothing of the attempt stays: the document is as it was read.
            val restored = JSONObject(before)
            for (key in json.keys().asSequence().toList()) json.remove(key)
            for (key in restored.keys()) json.put(key, restored.get(key))
            throw ContactProblem(CONTACTS_FULL)
        }
    }

    /* The pin removed and the removal recorded (docs/optional-verification.md 2.8): nothing adds them back on its own. */
    fun removeContact(userId: String, at: String) {
        val all = contactsJson()
        for (key in all.keys().asSequence().toList()) if (key.equals(userId, ignoreCase = true)) all.remove(key)
        val kept = removals.filter { it.first != userId.lowercase() } + (userId.lowercase() to at)
        json.put("removedContacts", JSONObject().also { r -> kept.forEach { (id, time) -> r.put(id, time) } })
        fit()
    }

    /*
     * The removals the document records (`removedContacts`), oldest first; anything malformed is left out, so an odd
     * value from another client never stops a save.
     */
    val removals: List<Pair<String, String>> get() {
        val removed = json.optJSONObject("removedContacts") ?: return emptyList()
        return removed.keys().asSequence().mapNotNull { key -> (removed.opt(key) as? String)?.let { key.lowercase() to it } }
            .sortedWith(compareBy<Pair<String, String>> { it.second }.thenBy { it.first }).toList()
    }

    /* Whether this account removed `userId` and has not added them back. */
    fun removed(userId: String): Boolean = removals.any { it.first == userId.lowercase() }

    fun forgetRemoval(userId: String) {
        val removed = json.optJSONObject("removedContacts") ?: return
        for (key in removed.keys().asSequence().toList()) if (key.equals(userId, ignoreCase = true)) removed.remove(key)
        if (removed.length() == 0) json.remove("removedContacts")
    }

    /*
     * Removals count against the room a document has (2.7): the oldest are forgotten first, one at a time, until it
     * seals. A document too large without any is left for the caller to refuse.
     */
    fun fit() {
        val removed = json.optJSONObject("removedContacts") ?: return
        val order = removals.map { it.first }.toMutableList()
        while (order.isNotEmpty() && bytes() > MAX_BYTES) {
            val oldest = order.removeAt(0)
            for (key in removed.keys().asSequence().toList()) if (key.lowercase() == oldest) removed.remove(key)
            if (removed.length() == 0) json.remove("removedContacts")
        }
    }

    /* The sealed document's size, as the core measures it. */
    fun bytes(): Int = text().toByteArray(Charsets.UTF_8).size

    fun unpin(userId: String) { contactsJson().remove(userId) }

    val ledger: SharingLedger get() {
        val sharing = json.optJSONObject("sharing") ?: return SharingLedger(emptyMap(), emptyMap())
        val shares = HashMap<String, Set<String>>()
        sharing.optJSONObject("shares")?.let { all ->
            for (node in all.keys()) all.optJSONArray(node)?.let { a -> shares[node] = (0 until a.length()).mapNotNull { a.optString(it).ifEmpty { null } }.toSet() }
        }
        val links = HashMap<String, String>()
        sharing.optJSONObject("links")?.let { all -> for (link in all.keys()) all.optString(link).ifEmpty { null }?.let { links[link] = it } }
        return SharingLedger(shares, links)
    }

    fun addShare(nodeId: String, granteeUserId: String) {
        val shares = sharesJson()
        val people = shares.optJSONArray(nodeId) ?: JSONArray().also { shares.put(nodeId, it) }
        if ((0 until people.length()).none { people.optString(it) == granteeUserId }) people.put(granteeUserId)
    }

    fun removeShare(nodeId: String, granteeUserId: String) {
        val shares = json.optJSONObject("sharing")?.optJSONObject("shares") ?: return
        val people = shares.optJSONArray(nodeId) ?: return
        for (index in people.length() - 1 downTo 0) if (people.optString(index) == granteeUserId) people.remove(index)
        if (people.length() == 0) shares.remove(nodeId)
    }

    fun addLink(linkId: String, nodeId: String) { linksJson().put(linkId, nodeId) }

    fun removeLink(linkId: String) { json.optJSONObject("sharing")?.optJSONObject("links")?.remove(linkId) }

    /* The document to seal: always version 2, whatever was read (the core raises it too). */
    fun text(): String = json.put("version", 2).toString()

    companion object {
        /* What a sealed document may hold (the core refuses more), and what adding someone says past it (2.7). */
        const val MAX_BYTES = 64 * 1024
        const val CONTACTS_FULL = "Your contacts are full. Remove someone you no longer share with."

        fun parse(text: String, version: ULong) = Settings(JSONObject(text), version)
        /* Version 2, the only document version written (docs/identity-pq-design.md 2): it may hold version 3 pins. */
        fun empty(version: ULong = 0uL) = Settings(JSONObject().put("version", 2).put("contacts", JSONObject()), version)
    }
}

/*
 * The settings out of a served envelope: version 2 under the settings key. Version 1 (sealed under a key off the
 * identity, which a stolen identity key opened) no longer opens: it is no settings at all, at the envelope's version,
 * so the next save (always version 2) goes over it and starts afresh.
 */
/*
 * The settings as served, held to this device's marks (SettingsMark.checkSettings) and opened. No document is empty
 * settings at the stored sequence (0 for no row, above 0 for a version 1 row served as none), so the next save names
 * that sequence as expectedVersion and seals at one above it, the version the server stores it at. A document's own
 * sequence (bound into its seal) is what counts when there is one.
 */
fun readServedSettings(userId: String, envelope: SettingsEnvelope?, sequence: ULong, mark: SettingsMark, settingsKey: () -> ByteArray): Settings {
    if (envelope == null) {
        mark.checkSettings(userId, sequence, present = false)
        // Checked again against what the write found: a newer mark kept meanwhile counts.
        if (sequence > 0uL) mark.checkSettings(mark.recordSettings(userId, sequence, sealedV2 = false), sequence, present = false)
        return Settings.empty(sequence)
    }
    mark.checkSettings(userId, envelope.settingsVersion, present = true)
    val settings = openSettingsText(userId, if (envelope.version == 2u) settingsKey() else null, envelope)
    mark.checkSettings(mark.recordSettings(userId, envelope.settingsVersion, sealedV2 = envelope.version == 2u), envelope.settingsVersion, present = true)
    return settings
}

fun openSettingsText(userId: String, settingsKey: ByteArray?, envelope: SettingsEnvelope): Settings =
    settingsOpen(userId, settingsKey, envelope)?.let { Settings.parse(it, envelope.settingsVersion) } ?: Settings.empty(envelope.settingsVersion)

/* Why a contact act stopped, in a sentence that says what to do. */
class ContactProblem(message: String) : Refused("Nothing was shared", message) {
    companion object {
        fun notUpgraded(name: String) = ContactProblem("${firstNameOf(name)} needs to sign in to HushOS once more before you can share with them.")
        fun unpinned() = ContactProblem("This person is not in your contacts. Add them before sharing.")
        fun otherAccount() = ContactProblem("That address now belongs to a different account.")
    }
}

/* Another device (or Vault) moved this person's pin between the read an act was decided over and its save. */
class ContactMoved : Refused("Nothing was changed", GuardWords.MOVED)

/* Someone whose keys changed with no chain from the keys this phone holds: paused until Continue or a check (2.4). */
data class AccountChange(val contactId: String, val name: String, val email: String) {
    val id: String get() = contactId.lowercase()
    val firstName: String get() = firstNameOf(name.ifEmpty { email })
}

/* What a share, a re-seal or an open met: said as the one calm notice, "Maya’s account changed". */
class AccountChanged(val change: AccountChange) : Refused("Nothing was shared", "${change.firstName}’s account changed.")

/* Why sharing to a pinned person is refused: the sentence says what to do. */
class SharingRefused(message: String) : Refused("Nothing was shared", message)

/*
 * Why a received share waits (docs/optional-verification.md 6.4), said calmly on its row: for the person's Open
 * (someone they removed, or whose signed succession this phone hasn't followed), for Review (an account that changed),
 * for Try again (the guard couldn't be read), for the granter (someone who can't be added yet, or a share sealed with
 * keys they since replaced).
 */
sealed class GranterTrust(message: String) : Exception(message) {
    /* Open adds them back, or follows them: the words say which. */
    class Waiting(words: String) : GranterTrust(words)
    /* "Maya’s account changed": Review. */
    class Changed(val change: AccountChange) : GranterTrust("${change.firstName}’s account changed. Review to open this.")
    /* Nothing the person can do here yet (they need to sign in once more, contacts are full). */
    class Unverified(words: String) : GranterTrust(words)
    /* This phone's guard couldn't be read: never first use. */
    class Unchecked : GranterTrust(GuardWords.UNREADABLE)
    /* Sealed under keys the granter has since replaced, which vouch for nothing now: it waits for their re-seal. */
    class Reshare(name: String) : GranterTrust("$name replaced their sharing keys since sharing this. Ask $name to share it again.")
}

/*
 * The keys a granter's share must be signed with: the pin's current Ed25519 key, and the served ML-DSA key only if its
 * digest is the pin's (packages/drive's granterKeysOf). Null when the pin has no ML-DSA digest or the served key is not
 * the pinned one.
 */
fun granterKeysOf(pin: ContactPin, served: ServedIdentity): HybridPublicKey? {
    val pinned = pin.mlDsaPublicKeyHash ?: return null
    val mlDsa = served.mlDsaPublicKey ?: return null
    if (digestOf(mlDsa) != pinned) return null
    return runCatching { HybridPublicKey(base64urlDecode(pin.signingPublicKey), base64urlDecode(mlDsa)) }.getOrNull()
}

/* The keys a share from this granter opens under, and whether the pin followed keys they replaced (so an older share may wait for a re-seal). */
class GranterKey(val keys: HybridPublicKey, val replacedKeys: Boolean) {
    val signingPublicKey: ByteArray get() = keys.signingPublicKey
}

/*
 * A received share's node key: the granter's keys against each of this account's identities, the current one first.
 * A share row does not say which identity it was sealed to, and after a succession shares sealed to earlier keys open
 * only with them. Suite 4 checks both halves of the granter's signature before anything is decapsulated, so a share
 * signed by anyone else, under a key the granter replaced, or in an older suite never opens; the first refusal is what
 * is said, unless the granter replaced keys, when the share is waiting for their re-seal.
 */
fun openShare(envelope: ByteArray, granter: GranterKey, granterName: String, identities: List<IdentityKeys>, ctx: ShareContext): ByteArray {
    var refusal: Exception? = null
    for (identity in identities) {
        try {
            return shareOpen(envelope, granter.keys, identity, ctx)
        } catch (error: Exception) {
            if (refusal == null) refusal = error
        }
    }
    if (granter.replacedKeys) throw GranterTrust.Reshare(granterName)
    throw refusal ?: ShareRefused("This share could not be opened.")
}

fun settingsEnvelope(json: JSONObject) = SettingsEnvelope(
    json.getInt("version").toUInt(), json.getLong("settingsVersion").toULong(), json.getString("nonce"), json.getString("ciphertext"),
)

/* One row of "shared by me": a share or a link, and the item it points at once its name is opened. */
data class SharedByMe(val id: String, val item: Opened?, val node: NodeView, val share: OwnedShare?, val link: LinkView?)

/*
 * "Find someone" on People, by the web's rule: offered from eight people (a shorter list
 * fits on a screen and is found by eye), kept while anything is typed so a list that shrank
 * below eight never hides the field holding the text, and matching a name or an email,
 * trimmed and case-insensitive. Both sides are NFC first, so a name stored decomposed matches
 * what a keyboard types; accents still count ("e" doesn't find "é"), as on the web.
 */
object PeopleFilter {
    const val FROM = 8

    fun offered(count: Int, query: String): Boolean = count >= FROM || query.isNotEmpty()

    /* The query as typed, trimmed: what People quotes back. */
    fun typed(query: String): String = query.trim { it.isWhitespace() }

    /* The query as matched: blank means everyone. */
    fun needle(query: String): String = folded(typed(query))

    fun matches(name: String, email: String, query: String): Boolean {
        val needle = needle(query)
        return needle.isEmpty() || folded(name).contains(needle) || folded(email).contains(needle)
    }

    fun shown(pins: List<ContactPin>, query: String): List<ContactPin> = pins.filter { matches(it.name, it.email, query) }

    /*
     * What the filter found, in the web's words: shown under the field and said by TalkBack. Null while nothing (or
     * only spaces) is typed.
     */
    fun result(shown: Int, total: Int, query: String): String? {
        val typed = typed(query)
        if (typed.isEmpty()) return null
        return if (shown == 0) "Nobody here matches “$typed”." else "$shown of $total shown"
    }

    private fun folded(text: String): String = java.text.Normalizer.normalize(text, java.text.Normalizer.Form.NFC).lowercase()
}
