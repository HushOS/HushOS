import Foundation
import HushOSCore

/*
 * Following a contact's identity succession (docs/integrity-design.md, "What contacts
 * see"). When the keys the server serves for a pinned person differ from the pin, the
 * chain of successions from the pinned keys is fetched and checked link by link, by key
 * continuity; a chain that holds moves the pin to the new keys and says so quietly, and
 * anything else stays the changed-key warning it always was.
 */

/* What the server serves for a person now: from a lookup, a share's granter or a rotation's grantee. */
public struct ServedContactKeys: Sendable, Equatable {
    /* Absent from an older server. */
    public let keyVersion: UInt64?
    public let encryptionPublicKey: String
    public let signingPublicKey: String
    /* Absent where the route serves no KEM key (a share's granter): the chain's last link names it, signed. */
    public let kemPublicKey: String?

    public init(keyVersion: UInt64?, encryptionPublicKey: String, signingPublicKey: String, kemPublicKey: String?) {
        self.keyVersion = keyVersion
        self.encryptionPublicKey = encryptionPublicKey
        self.signingPublicKey = signingPublicKey
        self.kemPublicKey = kemPublicKey
    }
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

extension ContactPin {
    /* Whether the served X25519 and signing keys are the pinned ones (an absent signing key compares only X25519). */
    public func matches(_ served: ServedContactKeys) -> Bool {
        served.encryptionPublicKey == encryptionPublicKey && (served.signingPublicKey.isEmpty || served.signingPublicKey == signingPublicKey)
    }

    /* Whether asking the server for a chain is worth it: a pin that vouches for something, and a newer identity served. */
    public func mayFollow(_ served: ServedContactKeys) -> Bool {
        guard verified, !matches(served), !served.signingPublicKey.isEmpty, let version = served.keyVersion else { return false }
        return version > (keyVersion ?? 0)
    }

    /*
     * The decision, given the links the server returned. A chain that holds gives the pin the
     * new keys, their fingerprint, version and KEM digest, and remembers every signing key the
     * chain passed through, since what those keys signed is still this person's.
     */
    public func follow(_ served: ServedContactKeys, links: [SuccessionLink], at now: Date = Date()) -> PinFollow {
        if matches(served) { return .same }
        guard mayFollow(served), let version = served.keyVersion,
              let start = links.firstIndex(where: { $0.oldEncryptionPublicKey == encryptionPublicKey && $0.oldSigningPublicKey == signingPublicKey }),
              let kem = served.kemPublicKey ?? links.last?.newKemPublicKey
        else { return .changed }
        let valid = successionChainVerify(
            userId: userId,
            pinned: PinnedKeys(keyVersion: keyVersion, encryptionPublicKey: encryptionPublicKey, signingPublicKey: signingPublicKey),
            served: ServedKeys(keyVersion: version, encryptionPublicKey: served.encryptionPublicKey, signingPublicKey: served.signingPublicKey, kemPublicKey: kem),
            links: links
        )
        guard valid, let encryption = try? base64urlDecode(value: served.encryptionPublicKey),
              let signing = try? base64urlDecode(value: served.signingPublicKey),
              let kemBytes = try? base64urlDecode(value: kem),
              let print = try? identityFingerprint(encryptionPublicKey: encryption, signingPublicKey: signing)
        else { return .changed }
        var earlier = previousSigningKeys ?? []
        for link in links[start...] where !earlier.contains(link.oldSigningPublicKey) { earlier.append(link.oldSigningPublicKey) }
        var next = ContactPin(
            userId: userId, email: email, name: name, encryptionPublicKey: served.encryptionPublicKey, signingPublicKey: served.signingPublicKey,
            fingerprint: print, pinnedAt: pinnedAt, kemPublicKeyHash: keyDigest(publicKey: kemBytes)
        )
        next.keyVersion = version
        next.previousSigningKeys = earlier
        next.keysReplacedAt = ISO8601DateFormatter().string(from: now)
        return .followed(next)
    }
}

extension Contact {
    var served: ServedContactKeys {
        ServedContactKeys(keyVersion: keyVersion, encryptionPublicKey: encryptionPublicKey, signingPublicKey: signingPublicKey, kemPublicKey: kem?.publicKey)
    }
}

extension ServedIdentity {
    var served: ServedContactKeys {
        ServedContactKeys(keyVersion: keyVersion, encryptionPublicKey: encryptionPublicKey, signingPublicKey: signingPublicKey, kemPublicKey: kem?.publicKey)
    }
}

extension SharedWithMeView.Granter {
    var served: ServedContactKeys {
        ServedContactKeys(keyVersion: keyVersion, encryptionPublicKey: encryptionPublicKey, signingPublicKey: signingPublicKey ?? "", kemPublicKey: nil)
    }
}

extension Vault {
    /*
     * The pin to use for a person whose served keys may have moved on: the same pin, or the
     * one their succession chain leads to (saved over the pin it was decided from, unless
     * another device moved that meanwhile). Any failure leaves the pin as it was, and the
     * caller's own check says the key changed.
     */
    func follow(_ pin: ContactPin, served: ServedContactKeys) async -> ContactPin {
        guard pin.mayFollow(served) else { return pin }
        let attempt = "\(pin.userId.lowercased())|\(served.encryptionPublicKey)|\(served.signingPublicKey)"
        if refusedSuccessions.contains(attempt) { return pin }
        guard let links = try? await Auth.succession(of: pin.userId, from: pin.keyVersion ?? 1) else { return pin }
        guard case .followed(let next) = pin.follow(served, links: links) else {
            refusedSuccessions.insert(attempt)
            return pin
        }
        do {
            try await updateSettings { settings in
                guard let stored = settings.contacts[pin.userId], stored.encryptionPublicKey == pin.encryptionPublicKey,
                      stored.signingPublicKey == pin.signingPublicKey else { return }
                settings.setPin(next)
            }
        } catch {
            return pin
        }
        return next
    }

    /* Every pin, each moved along its person's succession chain when the served keys say they replaced them. */
    func followAll(_ pins: [String: ContactPin], served: [String: ServedContactKeys]) async -> [String: ContactPin] {
        var out = pins
        for (id, keys) in served {
            guard let pin = pins[id] else { continue }
            out[id] = await follow(pin, served: keys)
        }
        return out
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
