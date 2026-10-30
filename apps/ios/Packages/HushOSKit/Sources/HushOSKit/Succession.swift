import Foundation
import os
import HushOSCore

private let successionLog = Logger(subsystem: "com.hushos.app", category: "succession")

/*
 * Following a contact's identity succession (docs/integrity-design.md, "What contacts
 * see"). When the keys the server serves for a pinned person differ from the pin, the
 * changed-key warning offers "Check again": only then is the whole chain fetched and
 * checked link by link, by key continuity; a chain that holds moves the pin to the new
 * keys and says so quietly, and anything else stays the changed-key warning.
 */

/* What the server serves for a person now: from a lookup, a share's granter, a rotation's grantee or a share's grantee. */
public struct ServedContactKeys: Sendable, Equatable {
    public let keyVersion: UInt64?
    public let encryptionPublicKey: String
    public let signingPublicKey: String
    /* Absent from a version 1 identity (not upgraded yet). */
    public let mlDsaPublicKey: String?
    public let kemPublicKey: String?

    public init(keyVersion: UInt64?, encryptionPublicKey: String, signingPublicKey: String, mlDsaPublicKey: String?, kemPublicKey: String?) {
        self.keyVersion = keyVersion
        self.encryptionPublicKey = encryptionPublicKey
        self.signingPublicKey = signingPublicKey
        self.mlDsaPublicKey = mlDsaPublicKey
        self.kemPublicKey = kemPublicKey
    }
}

/*
 * What a pin says about the keys the server serves for that person now
 * (docs/identity-pq-design.md 2, `comparePin` in packages/drive/src/trust.ts):
 * - same: a version 3 pin, the served X25519 and Ed25519 keys are the pinned ones, and the
 *   served ML-DSA and ML-KEM keys match its digests;
 * - recheck: a pin that vouches for nothing (from before the release) over the same X25519
 *   and Ed25519 keys: they upgraded, and only comparing words again trusts them;
 * - succession: other keys at a higher key version, from a version 3 pin, so a signed chain may explain it;
 * - changed: anything else, including no ML-DSA key, or an ML-DSA or ML-KEM key that differs
 *   beside the pinned classical keys.
 */
public enum PinComparison: Sendable, Equatable {
    case same, recheck, succession, changed
}

/* The decision for one pin against the served keys. */
public enum PinFollow: Sendable, Equatable {
    /* The served keys are the pinned ones. */
    case same
    /* A chain from the pinned keys to the served ones holds: the pin to keep from now on. */
    case followed(ContactPin)
    /* Changed without a chain that holds (or from a pin that vouches for nothing): the changed-key warning. */
    case changed
}

/* Hex SHA-256 of a base64url public key, nil when it does not decode. */
func digestOf(_ publicKey: String?) -> String? {
    guard let publicKey, let bytes = try? base64urlDecode(value: publicKey) else { return nil }
    return keyDigest(publicKey: bytes)
}

extension ContactPin {
    public func compare(_ served: ServedContactKeys) -> PinComparison {
        let sameKeys = served.encryptionPublicKey == encryptionPublicKey && served.signingPublicKey == signingPublicKey
        if sameKeys {
            guard verified else { return .recheck }
            guard let mlDsa = digestOf(served.mlDsaPublicKey), let kem = digestOf(served.kemPublicKey) else { return .changed }
            return mlDsa == mlDsaPublicKeyHash && kem == kemPublicKeyHash ? .same : .changed
        }
        // A succession is always to a version 2 identity, and only a version 3 pin passes trust on.
        guard served.mlDsaPublicKey != nil, served.kemPublicKey != nil, let version = served.keyVersion else { return .changed }
        // A pin with no version: the chain is then looked for from 1.
        return version > (keyVersion ?? 1) && verified ? .succession : .changed
    }

    /* Whether asking the server for a chain is worth it: a version 3 pin, and a newer identity served. */
    public func mayFollow(_ served: ServedContactKeys) -> Bool { compare(served) == .succession }

    /*
     * A version 3 pin of the served keys, as comparing words writes it: the X25519 and Ed25519
     * keys, the digests of the ML-DSA and ML-KEM keys, and the version 3 fingerprint over all four.
     */
    static func of(_ served: ServedContactKeys, userId: String, email: String, name: String, pinnedAt: String) throws -> ContactPin {
        guard let mlDsa = served.mlDsaPublicKey, let kem = served.kemPublicKey else { throw ContactError.notUpgraded(name.isEmpty ? email : name) }
        let mlDsaBytes = try base64urlDecode(value: mlDsa)
        let kemBytes = try base64urlDecode(value: kem)
        let print = try identityFingerprintOfKeys(
            encryptionPublicKey: try base64urlDecode(value: served.encryptionPublicKey),
            signingPublicKey: try base64urlDecode(value: served.signingPublicKey), mlDsaPublicKey: mlDsaBytes, kemPublicKey: kemBytes
        )
        var pin = ContactPin(userId: userId, email: email, name: name, encryptionPublicKey: served.encryptionPublicKey,
                             signingPublicKey: served.signingPublicKey, fingerprint: print, pinnedAt: pinnedAt,
                             kemPublicKeyHash: keyDigest(publicKey: kemBytes))
        pin.mlDsaPublicKeyHash = keyDigest(publicKey: mlDsaBytes)
        pin.keyVersion = served.keyVersion
        return pin
    }

    /*
     * The decision, given the links the server returned. Only version 2 links exist, and the core
     * follows them from the version 3 pin (its ML-DSA key by digest) to exactly the four served
     * keys. A chain that holds gives the pin the new keys as a version 3 pin, and remembers every
     * signing key the chain passed through, since what those keys signed is still this person's.
     */
    public func follow(_ served: ServedContactKeys, links: [SuccessionLink], at now: Date = Date()) -> PinFollow {
        switch compare(served) {
        case .same: return .same
        case .recheck, .changed: return .changed
        case .succession: break
        }
        guard let version = served.keyVersion, let mlDsa = served.mlDsaPublicKey, let kem = served.kemPublicKey, let mlDsaHash = mlDsaPublicKeyHash
        else { return .changed }
        let valid = successionChainVerify(
            userId: userId,
            pinned: PinnedKeys(keyVersion: keyVersion, encryptionPublicKey: encryptionPublicKey, signingPublicKey: signingPublicKey, mlDsaPublicKeyHash: mlDsaHash),
            served: ServedKeys(keyVersion: version, encryptionPublicKey: served.encryptionPublicKey, signingPublicKey: served.signingPublicKey,
                               mlDsaPublicKey: mlDsa, kemPublicKey: kem),
            links: links
        )
        guard valid, var next = try? ContactPin.of(served, userId: userId, email: email, name: name, pinnedAt: pinnedAt) else { return .changed }
        let start = chainStart(links)
        if start == nil {
            // The core verified a chain this client finds no start for: the two start rules disagree. Followed all the same, keeping the pinned key.
            successionLog.fault("a verified succession chain has no start by the client's rule (\(links.count, privacy: .public) links)")
        }
        next.previousSigningKeys = previousKeys(after: links, from: start, served: next.signingPublicKey)
        next.keysReplacedAt = ISO8601DateFormatter().string(from: now)
        // What this person shared with them still holds the old keys: every client re-seals it (synced, as the web's pin has it).
        next.resealShares = true
        // Followed from a pin trusted through a group: still that group's word, as on the web.
        next.trustedVia = trustedVia
        return .followed(next)
    }

    /*
     * The signing keys a followed pin keeps as replaced, oldest first: the ones it kept already,
     * its own signing key (always: what it signed is still this person's, even if `start` were
     * ever not found where the core started), then the old key of every link from `start`, the
     * links the core verified, through the end. The served key is the current one, never a
     * previous one (as the web and Android keep it).
     */
    func previousKeys(after links: [SuccessionLink], from start: Int?, served signingKey: String) -> [String] {
        var earlier = previousSigningKeys ?? []
        var passed = [signingPublicKey]
        if let start { passed += links[start...].map(\.oldSigningPublicKey) }
        for key in passed where !earlier.contains(key) { earlier.append(key) }
        return earlier.filter { $0 != signingKey }
    }

    /*
     * Where the core starts the chain (`succession_chain_verify`): the first link whose old
     * X25519, Ed25519 and ML-DSA keys are this pin's, the ML-DSA key by its digest. A link in
     * front of it is never checked, so nothing it names may be kept: a decoy at the pinned
     * classical keys with another ML-DSA key, followed by a link naming the server's own key as
     * an old one, would otherwise put that key among the previous signing keys.
     */
    func chainStart(_ links: [SuccessionLink]) -> Int? {
        guard let mlDsaPublicKeyHash else { return nil }
        return links.firstIndex {
            $0.oldEncryptionPublicKey == encryptionPublicKey && $0.oldSigningPublicKey == signingPublicKey
                && digestOf($0.oldMlDsaPublicKey) == mlDsaPublicKeyHash
        }
    }
}

extension Contact {
    var served: ServedContactKeys {
        ServedContactKeys(keyVersion: keyVersion, encryptionPublicKey: encryptionPublicKey, signingPublicKey: signingPublicKey,
                          mlDsaPublicKey: mlDsaPublicKey, kemPublicKey: kemPublicKey)
    }
}

extension ServedIdentity {
    var served: ServedContactKeys {
        ServedContactKeys(keyVersion: keyVersion, encryptionPublicKey: encryptionPublicKey, signingPublicKey: signingPublicKey,
                          mlDsaPublicKey: mlDsaPublicKey, kemPublicKey: kemPublicKey)
    }
}

extension SharedWithMeView.Granter {
    var served: ServedContactKeys {
        ServedContactKeys(keyVersion: keyVersion, encryptionPublicKey: encryptionPublicKey, signingPublicKey: signingPublicKey ?? "",
                          mlDsaPublicKey: mlDsaPublicKey, kemPublicKey: kemPublicKey)
    }
}

extension Vault {
    /*
     * "Check again": the person asked to follow a pinned contact to the keys served now. Only
     * then is the server asked for the chain, and always for the whole of it, so lookups never
     * say which contacts are pinned or at which version. A chain that holds moves the pin
     * (saved over the pin it was decided from, unless another device moved that meanwhile) and
     * queues what was shared with them to be sealed again to the new keys; anything else
     * leaves the pin as it was and the changed-key warning stands.
     */
    public func checkAgain(_ pin: ContactPin, served: ServedContactKeys) async throws -> PinFollow {
        switch pin.compare(served) {
        case .same: return .same
        case .recheck, .changed: return .changed
        case .succession: break
        }
        let links = try await Auth.succession(of: pin.userId, as: session)
        let decision = pin.follow(served, links: links)
        guard case .followed(let next) = decision else { return decision }
        try await updateSettings { settings in
            guard let stored = settings.contacts[pin.userId], stored.encryptionPublicKey == pin.encryptionPublicKey,
                  stored.signingPublicKey == pin.signingPublicKey else { return }
            settings.setPin(next)
        }
        ResealTo.add(next.userId)
        return decision
    }
}

/*
 * People whose keys this person followed along a succession, whose shares still hold the old
 * keys: the next upgrade pass seals them again to the pin's keys, then lets them go. Kept on
 * this phone, in `state/` (out of backups, wiped on sign-out).
 */
enum ResealTo {
    static let file = "reseal-to.json"

    static func add(_ userId: String) {
        var all = Set(Unbacked.read([String].self, file) ?? [])
        all.insert(userId.lowercased())
        Unbacked.write(all.sorted(), file)
    }

    static var all: Set<String> { Set(Unbacked.read([String].self, file) ?? []) }

    static func contains(_ userId: String) -> Bool { all.contains(userId.lowercased()) }

    static func remove(_ userIds: Set<String>) {
        guard !userIds.isEmpty else { return }
        let left = (Unbacked.read([String].self, file) ?? []).filter { !userIds.contains($0) }
        Unbacked.write(left, file)
    }
}

/*
 * Which followed successions this person has since compared words for, on this phone: the pin
 * keeps `keysReplacedAt` (every client agrees on it), and the quiet notice in People goes once
 * the new words were checked here.
 */
public enum ReplacedKeysSeen {
    static let file = "replaced-keys-seen.json"

    static func key(_ pin: ContactPin) -> String { "\(pin.userId.lowercased())|\(pin.signingPublicKey)" }

    public static func acknowledge(_ pin: ContactPin) {
        var seen = Set(Unbacked.read([String].self, file) ?? [])
        seen.insert(key(pin))
        Unbacked.write(Array(seen).sorted(), file)
    }

    /* A pin that followed a succession whose new words haven't been compared on this phone. */
    public static func notice(_ pin: ContactPin) -> Bool {
        guard pin.keysReplacedAt != nil, pin.verified else { return false }
        return !(Unbacked.read([String].self, file) ?? []).contains(key(pin))
    }
}
