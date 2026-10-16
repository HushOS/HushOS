import { areaKeyCommitment } from './area-keys';
import sodium from 'libsodium-wrappers';
import { parseStatement } from './canonical';
import { fingerprint } from './fingerprint';
import {
    groupKeyDigest,
    groupKeyPair,
    groupSuccessionStatement,
    openAreaGrant,
    openGroupKey,
    parseGroupSuccession,
    sealAreaGrant,
    sealGroupKey,
    signGroup,
    rosterDigest,
    rosterStatement,
    signGroupSuccession,
    signRoster,
    type AreaGrantContext,
    type GroupKeyPair,
    type GroupKeySealContext,
    type GroupKind,
    type GroupRole,
    type Roster,
    type RosterArea,
    type RosterMember,
    type SignedGroupStatement,
} from './groups';
import {
    acceptRosters,
    firstRoster,
    ownRosterEntry,
    joinCode,
    checkNextRoster,
    checkNextSuccession,
    foldInEntry,
    groupIntegrityOf,
    groupWriterTrust,
    pinAfter,
    type AcceptInput,
    type AcceptedRosters,
    type GroupChainCache,
    type ServedIdentity,
} from './group-trust';
import {
    SUCCESSION_CONSENT_BYTES,
    type PinnedKeys,
    type ServedKeys,
    type SuccessionLink,
} from './identity';
import { deriveId } from './ids';
import { decode, encode } from './keys';
import type { GroupPin } from './pins';
import { kemKeypair, mlDsaKeypair } from './pq';
import {
    digest,
    keysStatement,
    metadataStatement,
    metadataStatements,
    signHybrid,
    signStatement,
    successionConsentStatement,
    successionStatement,
} from './signatures';

/*
 * People and groups for the group tests, from fixed seeds: deterministic keys
 * (signatures are hedged and differ each run, which no test relies on).
 * Shared by groups.test.ts and group-trust.test.ts; not part of the package's
 * exports.
 */

export const GROUP = '0a0a0a0a-0a0a-4a0a-8a0a-0a0a0a0a0a0a';
export const OTHER_GROUP = '0b0b0b0b-0b0b-4b0b-8b0b-0b0b0b0b0b0b';
/* The family's area: a workspace id derived under GROUP from AREA_SEED (pattern(16, 60)). */
export const AREA = '80558a81-8dfc-8914-8447-0417b55e2ec5';
export const AREA_SEED = 'pMrxFz5ki7HY_iVLcpi_5Q';
/* Another workspace id, sorting after AREA: a roster's second area (not derived under the group). */
export const SECOND_AREA = 'a0558a81-8dfc-4914-8447-0417b55e2ec5';
export const THIRD_AREA = 'b0558a81-8dfc-4914-8447-0417b55e2ec5';
/* Another group's area: derived under OTHER_GROUP from OTHER_AREA_SEED (pattern(16, 61)). */
export const OTHER_AREA = '8479e412-cae8-8d7c-8357-63caa0c518a9';
export const OTHER_AREA_SEED = 'q9H4HkVskrngBi1TeqHH7g';

/* The bytes the cross-implementation fixtures use for a seed: the same formula in both twins. */
/*
 * The area key every history's rosters list unless told otherwise: AREA at
 * version 1, the key the seal cases grant (pattern(32, 77)).
 */
export const AREA_KEY_SEED = 77;
/* The key the testkit's rotations give an area at a version: AREA's are pattern(32, 77 + v - 1). */
export function areaKeyAt(workspaceId: string, version: number) {
    return pattern(32, workspaceId === AREA ? AREA_KEY_SEED + version - 1 : 100 + version);
}

export async function standardAreas(): Promise<RosterArea[]> {
    return [
        {
            workspaceId: AREA,
            workspaceKeyVersion: 1,
            commitment: await areaKeyCommitment(pattern(32, AREA_KEY_SEED)),
        },
    ];
}

export function pattern(length: number, seed: number) {
    return Uint8Array.from({ length }, (_, i) => (i * 31 + seed * 7 + ((i * seed) >> 3)) & 0xff);
}

/* A lowercase UUID that sorts by `n`. */
export function userIdOf(n: number) {
    const hex = n.toString(16).padStart(8, '0');
    return `${hex}-abcd-4abc-8abc-abcdefabcdef`;
}

/*
 * A person with every key from seeds derived from `n`, at `keyVersion`. The
 * account id is userIdOf(n) unless `userId` names one (an account a test has
 * stored, as the server's tests do); the keys and their statement bind it.
 */
export async function person(n: number, keyVersion = 1, options: { userId?: string } = {}) {
    await sodium.ready;
    const userId = options.userId ?? userIdOf(n);
    // The X25519 private key is the seed itself, as the Rust core's fixtures take it.
    const exchangePrivate = pattern(32, n * 4 + keyVersion * 50);
    const exchange = {
        privateKey: exchangePrivate,
        publicKey: sodium.crypto_scalarmult_base(exchangePrivate),
    };
    const signing = sodium.crypto_sign_seed_keypair(pattern(32, n * 4 + 1 + keyVersion * 50));
    const mlDsa = mlDsaKeypair(pattern(32, n * 4 + 2 + keyVersion * 50));
    const kem = kemKeypair(pattern(64, n * 4 + 3 + keyVersion * 50));
    const signer = { signingKey: signing.privateKey, mlDsaSecretKey: mlDsa.secretKey };
    const keys = {
        keyVersion,
        encryptionPublicKey: encode(exchange.publicKey),
        signingPublicKey: encode(signing.publicKey),
        mlDsaPublicKey: encode(mlDsa.publicKey),
        kemPublicKey: encode(kem.publicKey),
    };
    const served: ServedIdentity = {
        ...keys,
        keysSignature: encode(await signHybrid(await keysStatement({ ...keys, userId }), signer)),
    };
    const mlDsaDigest = await digest(mlDsa.publicKey);
    const kemDigest = await digest(kem.publicKey);
    const hex = (bytes: Uint8Array) =>
        Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
    const sha = async (bytes: Uint8Array) =>
        new Uint8Array(await crypto.subtle.digest('SHA-256', bytes.slice()));
    return {
        n,
        userId,
        keyVersion,
        mlDsaDigest,
        /* The seeds every key came from, as the shared fixtures carry them. */
        seeds: {
            x25519: encode(exchangePrivate),
            ed25519: encode(pattern(32, n * 4 + 1 + keyVersion * 50)),
            mlDsa: encode(pattern(32, n * 4 + 2 + keyVersion * 50)),
            kem: encode(pattern(64, n * 4 + 3 + keyVersion * 50)),
        },
        signer,
        served,
        mlDsaPublicKey: mlDsa.publicKey,
        kemPublicKey: kem.publicKey,
        secrets: { privateKey: exchange.privateKey, kemSecretKey: kem.secretKey },
        entry(
            roles: GroupRole[],
            sinceVersion = 1,
            status: 'active' | 'left' = 'active',
        ): RosterMember {
            return {
                userId,
                keyVersion,
                encryptionPublicKey: keys.encryptionPublicKey,
                signingPublicKey: keys.signingPublicKey,
                mlDsaPublicKeyDigest: mlDsaDigest,
                kemPublicKeyDigest: kemDigest,
                status,
                roles: [...roles].sort(),
                sinceVersion,
            };
        },
        /* A version 3 pin, as comparing words with them writes it. */
        async pin() {
            const mlDsaHash = await sha(mlDsa.publicKey);
            const kemHash = await sha(kem.publicKey);
            return {
                userId,
                email: `${n}@example.com`,
                name: `Person ${n}`,
                keyVersion,
                pinnedAt: '2026-10-15T00:00:00.000Z',
                encryptionPublicKey: keys.encryptionPublicKey,
                signingPublicKey: keys.signingPublicKey,
                mlDsaPublicKeyHash: hex(mlDsaHash),
                kemPublicKeyHash: hex(kemHash),
                fingerprint: await fingerprint(
                    exchange.publicKey,
                    signing.publicKey,
                    mlDsaHash,
                    kemHash,
                ),
            };
        },
        /* What verifySuccessionChain starts from: the pin's keys. */
        /* A pin of these keys from the reader's own words check (trustedVia null). */
        async pinned() {
            return {
                keyVersion,
                encryptionPublicKey: keys.encryptionPublicKey,
                signingPublicKey: keys.signingPublicKey,
                mlDsaPublicKeyHash: hex(await sha(mlDsa.publicKey)),
                trustedVia: null as string | null,
            };
        },
    };
}
export type Person = Awaited<ReturnType<typeof person>>;

/* The roster position a seal names: the sealer's latest accepted roster. */
export function atRoster(chain: AcceptedRosters) {
    return { rosterVersion: chain.roster.rosterVersion, rosterDigest: chain.rosterDigest };
}

/* The person's next identity and the version 2 succession link their current one signs. */
export async function succeed(who: Person): Promise<{ next: Person; link: SuccessionLink }> {
    const next = await person(who.n, who.keyVersion + 1);
    return { next, link: await linkBetween(who, next) };
}

/*
 * A link's consent: the consent statement signed by `old`'s keys as "old"
 * then by `fresh`'s as "new", as a member's own client makes it. A test may sign either half
 * with keys the member never held, or leave it zeros (null), to model a forgery.
 */
export async function consentOf(
    fields: Omit<SuccessionLink, 'signature' | 'consent'>,
    userId: string,
    old: Person['signer'] | null,
    fresh: Person['signer'] | null,
) {
    const consent = new Uint8Array(2 * 3373);
    if (old)
        consent.set(
            await signHybrid(await successionConsentStatement({ ...fields, userId }, 'old'), old),
        );
    if (fresh)
        consent.set(
            await signHybrid(await successionConsentStatement({ ...fields, userId }, 'new'), fresh),
            3373,
        );
    return encode(consent);
}

/*
 * A link from `who`'s keys to `next`'s, with `change` applied before it is
 * signed: the version 2 signature by `who` and, unless `oneSided`, the
 * version 3 consent by both, as clients make links from round 8 on.
 */
export async function linkBetween(
    who: Person,
    next: Person,
    change: (
        fields: Omit<SuccessionLink, 'signature' | 'consent'>,
    ) => Omit<SuccessionLink, 'signature' | 'consent'> = (f) => f,
    { oneSided = false }: { oneSided?: boolean } = {},
): Promise<SuccessionLink> {
    const fields = change({
        oldKeyVersion: who.keyVersion,
        newKeyVersion: next.keyVersion,
        oldEncryptionPublicKey: who.served.encryptionPublicKey,
        oldSigningPublicKey: who.served.signingPublicKey,
        oldMlDsaPublicKey: who.served.mlDsaPublicKey,
        newEncryptionPublicKey: next.served.encryptionPublicKey,
        newSigningPublicKey: next.served.signingPublicKey,
        newMlDsaPublicKey: next.served.mlDsaPublicKey,
        newKemPublicKey: next.served.kemPublicKey,
    });
    const signature = await signHybrid(
        await successionStatement({ ...fields, userId: who.userId }),
        who.signer,
    );
    if (oneSided) return { ...fields, signature: encode(signature) };
    return {
        ...fields,
        signature: encode(signature),
        consent: await consentOf(fields, who.userId, who.signer, next.signer),
    };
}

/* The group key at `version`, from a fixed seed. */
export async function groupKeyAt(version: number) {
    return groupKeyPair(pattern(64, 90 + version));
}

export function sortedMembers(members: RosterMember[]) {
    return [...members].sort((a, b) => (a.userId < b.userId ? -1 : 1));
}

function sameEntry(a: RosterMember, b: RosterMember) {
    return (
        a.keyVersion === b.keyVersion &&
        a.encryptionPublicKey === b.encryptionPublicKey &&
        a.signingPublicKey === b.signingPublicKey &&
        a.mlDsaPublicKeyDigest === b.mlDsaPublicKeyDigest &&
        a.kemPublicKeyDigest === b.kemPublicKeyDigest &&
        a.status === b.status &&
        a.roles.join() === b.roles.join()
    );
}

/*
 * A group's history being written: rosters and successions signed as a
 * holder's client signs them, each roster chained to the one before. Built
 * without nextRoster's checks, so a test can write the histories a server, a
 * removed holder or a broken client might serve.
 */
/* A link of short junk: cheap to serve in bulk, and verifies under nothing. */
export const junkLink: SuccessionLink = {
    oldKeyVersion: 1,
    newKeyVersion: 2,
    oldEncryptionPublicKey: 'AA',
    oldSigningPublicKey: 'AA',
    oldMlDsaPublicKey: 'AA',
    newEncryptionPublicKey: 'AA',
    newSigningPublicKey: 'AA',
    newMlDsaPublicKey: 'AA',
    newKemPublicKey: 'AA',
    signature: 'AA',
};

/*
 * A group id as the server checks it: derived under the creator's account
 * from an id seed (the `group` id kind), for tests that store real groups.
 */
export async function groupIdFor(creatorUserId: string, idSeed: string) {
    return deriveId('group', creatorUserId, idSeed);
}

/*
 * A group's history being written: GROUP's by default, or `groupId`'s, with
 * every roster listing `areas` unless told otherwise (standardAreas() by
 * default: AREA, derived under GROUP).
 */
export async function history(
    kind: 'family' | 'org' = 'family',
    options: { groupId?: string; areas?: RosterArea[] } = {},
) {
    const groupId = options.groupId ?? GROUP;
    const rosters: SignedGroupStatement[] = [];
    const successions: SignedGroupStatement[] = [];
    const statements: Roster[] = [];
    const keys: GroupKeyPair[] = [await groupKeyAt(1)];
    /* Each area's latest key version on the history so far. */
    const areaVersions = new Map<string, number>();
    return {
        groupId,
        rosters,
        successions,
        statements,
        keys,
        kind,
        /*
         * Signs the next roster with `members`, under key `keyVersion` (the latest by default),
         * carrying the area rows `areas`. By default the first roster creates options.areas (or
         * standardAreas()), and in a family a roster that marks anyone left rotates every area to
         * its next key (areaKeyAt), as the rules ask; any other roster carries none.
         */
        async roster(
            signer: Person,
            members: RosterMember[],
            keyVersion = keys.length,
            areas?: RosterArea[],
        ) {
            const previous = statements.at(-1);
            const version = statements.length + 1;
            const leaving =
                previous !== undefined &&
                members.some(
                    (member) =>
                        member.status === 'left' &&
                        previous.members.find((m) => m.userId === member.userId)?.status ===
                            'active',
                );
            const rows =
                areas ??
                (!previous
                    ? (options.areas ?? (await standardAreas()))
                    : kind === 'family' && leaving
                      ? await Promise.all(
                            [...areaVersions.keys()].sort().map(async (workspaceId) => {
                                const next = areaVersions.get(workspaceId)! + 1;
                                return {
                                    workspaceId,
                                    workspaceKeyVersion: next,
                                    commitment: await areaKeyCommitment(
                                        areaKeyAt(workspaceId, next),
                                    ),
                                };
                            }),
                        )
                      : []);
            for (const row of rows) areaVersions.set(row.workspaceId, row.workspaceKeyVersion);
            const roster: Roster = {
                groupId,
                kind,
                rosterVersion: version,
                previousRosterDigest: previous ? await rosterDigest(rosters.at(-1)!.statement) : '',
                groupKeyVersion: keyVersion,
                signerUserId: signer.userId,
                // Each entry's sinceVersion as nextRoster sets it, whatever the caller passed.
                members: sortedMembers(
                    members.map((member) => {
                        const entry = { ...member, roles: [...member.roles].sort() };
                        const before = previous?.members.find((m) => m.userId === member.userId);
                        return {
                            ...entry,
                            sinceVersion: !previous
                                ? 1
                                : before && sameEntry(before, entry)
                                  ? before.sinceVersion
                                  : version,
                        };
                    }),
                ),
                areas: rows,
            };
            const signed = await signRoster(roster, keys[keyVersion - 1]!, signer.signer);
            rosters.push(signed);
            statements.push(roster);
            return signed;
        },
        /* Replaces the latest group key, tied to the latest roster. */
        async succession(signer: Person, from = keys.length) {
            const old = keys[from - 1]!;
            const next = await groupKeyAt(from + 1);
            const last = rosters.at(-1)!;
            const signed = await signGroupSuccession(
                {
                    groupId,
                    oldVersion: from,
                    newVersion: from + 1,
                    oldEd25519PublicKey: old.publicKey.ed25519PublicKey,
                    oldMlDsaPublicKey: old.publicKey.mlDsaPublicKey,
                    newEd25519PublicKey: next.publicKey.ed25519PublicKey,
                    newMlDsaPublicKey: next.publicKey.mlDsaPublicKey,
                    lastRosterVersion: rosters.length,
                    lastRosterDigest: await rosterDigest(last.statement),
                    signerUserId: signer.userId,
                },
                old,
                signer.signer,
            );
            successions.push(signed);
            if (keys.length === from) keys.push(next);
            return signed;
        },
    };
}
export type History = Awaited<ReturnType<typeof history>>;

/*
 * A newcomer outside the group (no entry of its own to check) who has just
 * compared the group's words, with no pins and no cache: what most tests
 * accept rosters as.
 */
export const READER = {
    me: { userId: 'ffffffff-ffff-4fff-8fff-ffffffffffff', identities: [] as ServedKeys[] },
    firstKeysChecked: true,
    pins: [] as GroupPin[],
    cache: null as GroupChainCache | null,
};

/* The served ML-DSA keys of everyone named, by their SHA-256, as acceptRosters takes them. */
export function mlDsaKeysOf(...people: Person[]) {
    return Object.fromEntries(people.map((who) => [who.mlDsaDigest, who.served.mlDsaPublicKey]));
}

/* What acceptRosters takes for `h`, verified from version 1 by a newcomer outside the group. */
export function inputOf(
    h: History,
    people: Person[],
    over: Partial<AcceptInput> = {},
): AcceptInput {
    return {
        groupId: h.groupId,
        firstKeys: h.keys[0]!.publicKey,
        rosters: [...h.rosters],
        successions: [...h.successions],
        mlDsaKeys: mlDsaKeysOf(...people),
        ...READER,
        ...over,
    };
}

/* The accepted chain of `h`'s rosters and successions. */
export async function acceptedOf(
    h: History,
    people: Person[],
    over: Partial<AcceptInput> = {},
): Promise<AcceptedRosters> {
    const chain = await acceptRosters(inputOf(h, people, over));
    if (chain.status !== 'accepted')
        throw new Error(`expected an accepted chain, got a fork at ${chain.version}`);
    return chain;
}

export const CHECKED = '2026-10-15T00:00:00.000Z';

/* The chain of `h` up to roster `version`, with the successions tied before it. */
export async function acceptedTo(h: History, version: number, people: Person[]) {
    return acceptedOf(h, people, {
        rosters: h.rosters.slice(0, version),
        successions: h.successions.filter(
            (s) => parseGroupSuccession(s.statement).lastRosterVersion < version,
        ),
    });
}

/* A pin at roster `version` of `h`, as a device that accepted the chain up to there writes it. */
export async function pinOf(h: History, version: number, people: Person[]) {
    return pinAfter([], await acceptedTo(h, version, people), CHECKED);
}

/* A statement signed by group key `key` and by `by`, whatever its signer field names. */
export async function signedBy(statement: Uint8Array, key: GroupKeyPair, by: Person | null) {
    return {
        statement,
        signature: await signGroup(statement, key),
        signerSignature: by ? await signHybrid(statement, by.signer) : new Uint8Array(3373),
    };
}

/* The record every record probe reads: a file's metadata in the family's area. */
export const NODE = '0e0e0e0e-0e0e-4e0e-8e0e-0e0e0e0e0e0e';
export const RECORD = {
    workspaceId: AREA,
    nodeId: NODE,
    kind: 'file' as const,
    metadataVersion: 1,
};
export const ENVELOPE = new Uint8Array(96).fill(5);

/* The writer's Ed25519 signature over RECORD with `signingKey`. */
export async function recordSignature(signingKey: Uint8Array) {
    return signStatement(await metadataStatement(RECORD, ENVELOPE), signingKey);
}

/* How a reader of the accepted chain is asked about one record in the area. */
export type RecordProbe = {
    writerUserId: string;
    signature: string;
    pinned: PinnedKeys | null;
    /* The pin's trustedVia: the group it was trusted through, when not a words check (r11). */
    pinnedVia?: string | null;
    served: ServedKeys | null;
    links: SuccessionLink[] | null;
    /* The workspace the record is in, when not the family's area (which alone is in the areas). */
    workspaceId?: string;
};

export async function recordVerdict(chain: AcceptedRosters, probe: RecordProbe) {
    const record = { ...RECORD, workspaceId: probe.workspaceId ?? AREA };
    const trust = await groupWriterTrust({
        groupId: GROUP,
        areas: { [AREA]: 1 },
        reading: { status: 'accepted', chain },
        workspaceId: record.workspaceId,
        writerUserId: probe.writerUserId,
        pinned: probe.pinned ? { ...probe.pinned, trustedVia: probe.pinnedVia ?? null } : null,
        served: probe.served,
        links: probe.links,
    });
    return groupIntegrityOf(
        () => metadataStatements(record, ENVELOPE),
        decode(probe.signature),
        trust,
        null,
    );
}

/* What a holder or the server checks next on the accepted chain: one roster or one succession. */
export type NextProbe = {
    roster: SignedGroupStatement | null;
    succession: SignedGroupStatement | null;
    identities: Record<string, ServedIdentity[]> | null;
};

export async function nextVerdict(
    chain: AcceptedRosters,
    probe: NextProbe,
    mlDsaKeys: Record<string, string>,
) {
    try {
        if (probe.roster) await checkNextRoster(chain, probe.roster, mlDsaKeys, probe.identities);
        if (probe.succession) await checkNextSuccession(chain, probe.succession, mlDsaKeys);
        return 'accepted';
    } catch (error) {
        if (error instanceof Error && error.name === 'CryptoError') return 'refused';
        throw error;
    }
}

export function servedKeysOf(who: Person): ServedKeys {
    const { keysSignature: _, ...keys } = who.served;
    return keys;
}

export type CaseVerdict =
    | {
          status: 'accepted';
          rosterVersion: number;
          record?: { integrity: string; via: string | null };
          next?: 'accepted' | 'refused';
          deadBranches?: { version: number; signerUserId: string }[];
          ownEntryBehindAt?: number[];
      }
    | { status: 'fork'; of: 'roster' | 'group-key'; version: number; sides: number }
    | { status: 'refused' };
export type GroupCase = {
    name: string;
    input: AcceptInput;
    /* When given, the record the accepted chain is asked about. */
    record?: RecordProbe;
    /* When given, the next roster or succession checked on the accepted chain. */
    next?: NextProbe;
    expected: CaseVerdict;
};

/*
 * The histories both twins build from the same seeds and must judge alike
 * (crates/hushos-core/tests/common/groups.rs builds the same ones, in this
 * order): the chain the server serves, dead branches beside it, the
 * person's marks agreeing or not, rollbacks, key windows and successions,
 * the entry rules, the cache, the next statement checks, the reviews'
 * probes, and records read through the accepted chain.
 */
export async function groupCases(): Promise<GroupCase[]> {
    const [organizer, adult, holder, child, outsider] = (await Promise.all(
        [1, 2, 3, 4, 5].map((n) => person(n)),
    )) as [Person, Person, Person, Person, Person];
    const owner = organizer.entry(['billing', 'guardian', 'members']);
    const everyone = [organizer, adult, holder, child, outsider];
    const fromOne = (h: History, people = everyone) => inputOf(h, people);
    const junk = encode(new Uint8Array(32).fill(7));
    const cases: GroupCase[] = [];
    const refused = { status: 'refused' as const };
    const fork = (of: 'roster' | 'group-key', version: number, sides = 2) => ({
        status: 'fork' as const,
        of,
        version,
        sides,
    });
    const accepted = (rosterVersion: number) => ({ status: 'accepted' as const, rosterVersion });
    const reads = (integrity: string, via: string | null, rosterVersion: number) => ({
        ...accepted(rosterVersion),
        record: { integrity, via },
    });

    // Rosters 1-3, then: another 2 beside them (dead), two 3s (ambiguous), a broken link.
    {
        const h = await history();
        await h.roster(organizer, [owner, adult.entry([])]);
        await h.roster(organizer, [owner, adult.entry(['billing'])]);
        await h.roster(organizer, [owner, adult.entry(['billing']), outsider.entry([])]);
        const other2 = await signRoster(
            {
                ...h.statements[1]!,
                members: sortedMembers([owner, adult.entry([]), outsider.entry([], 2)]),
            },
            h.keys[0]!,
            organizer.signer,
        );
        cases.push({
            name: 'dead-branch',
            input: { ...fromOne(h), rosters: [...h.rosters, other2] },
            expected: {
                ...accepted(3),
                deadBranches: [{ version: 2, signerUserId: organizer.userId }],
            },
        });
        const other3 = await signRoster(
            {
                ...h.statements[2]!,
                members: sortedMembers([owner, adult.entry(['billing']), child.entry([], 3)]),
            },
            h.keys[0]!,
            organizer.signer,
        );
        cases.push({
            name: 'two-latest',
            input: { ...fromOne(h), rosters: [...h.rosters, other3] },
            expected: refused,
        });
        const branch = await signRoster(
            { ...h.statements[2]!, previousRosterDigest: junk },
            h.keys[0]!,
            organizer.signer,
        );
        cases.push({
            name: 'broken-link',
            input: { ...fromOne(h), rosters: [...h.rosters.slice(0, 2), branch] },
            expected: refused,
        });
        cases.push({
            name: 'unchecked-first-keys',
            input: { ...fromOne(h), firstKeysChecked: false },
            expected: refused,
        });
        // The person's marks: a pin naming another roster 2; two pins at 2 that disagree; a group
        // key mark that is not the chain's; a pin the chain does not reach; first keys not the pin's.
        const pin2 = await pinOf(h, 2, everyone);
        const pin3 = await pinOf(h, 3, everyone);
        const marked = { ...pin2, rosterDigest: await rosterDigest(other2.statement) };
        cases.push({
            name: 'mark-mismatch',
            input: { ...fromOne(h), pins: [marked] },
            expected: fork('roster', 2),
        });
        cases.push({
            name: 'pins-disagree',
            input: { ...fromOne(h), pins: [pin3, pin2, marked] },
            expected: fork('roster', 2),
        });
        cases.push({
            name: 'pin-key-digest',
            input: {
                ...fromOne(h),
                pins: [
                    {
                        ...pin3,
                        groupKeyDigest: await groupKeyDigest((await groupKeyAt(8)).publicKey),
                    },
                ],
            },
            expected: fork('group-key', 1),
        });
        cases.push({
            name: 'rollback',
            input: { ...fromOne(h), pins: [pin3], rosters: h.rosters.slice(0, 2) },
            expected: refused,
        });
        const otherKey = (await groupKeyAt(8)).publicKey;
        cases.push({
            name: 'first-keys-half',
            input: {
                ...fromOne(h),
                pins: [pin2],
                firstKeys: { ...h.keys[0]!.publicKey, mlDsaPublicKey: otherKey.mlDsaPublicKey },
            },
            expected: refused,
        });
        // The cache: extended, extended by another branch, a pin it disagrees with, out of form,
        // bound to another roster, and a cache of another roster 2 with the chain served from 1.
        const two = await acceptedTo(h, 2, everyone);
        cases.push({
            name: 'cache-extends',
            input: { ...fromOne(h), cache: two.cache, rosters: [h.rosters[2]!], pins: [pin2] },
            expected: accepted(3),
        });
        cases.push({
            name: 'cache-branch',
            input: { ...fromOne(h), cache: two.cache, rosters: [branch] },
            expected: refused,
        });
        cases.push({
            name: 'cache-pin-disagrees',
            input: { ...fromOne(h), cache: two.cache, rosters: [h.rosters[2]!], pins: [marked] },
            expected: fork('roster', 2),
        });
        cases.push({
            name: 'cache-garbage',
            input: {
                ...fromOne(h),
                cache: {
                    ...two.cache,
                    keyHistory: {
                        [adult.userId]: [{ ...adult.entry([]), signingPublicKey: 'nope' }],
                    },
                },
                rosters: [h.rosters[2]!],
            },
            expected: refused,
        });
        cases.push({
            name: 'cache-bound',
            input: {
                ...fromOne(h),
                cache: { ...two.cache, statement: encode(h.rosters[0]!.statement) },
                rosters: [h.rosters[2]!],
            },
            expected: refused,
        });
        // r9, r10: the cache's last roster's rows must be its areas' latest commitments, and at
        // roster 1 they are every area there is: a cache carrying another key for an area, or
        // an area the first roster never created, is refused. (Earlier commitments are the
        // device's own record, trusted as stored.)
        const one = await acceptedTo(h, 1, everyone);
        cases.push({
            name: 'cache-area-keys-tampered',
            input: {
                ...fromOne(h),
                cache: { ...one.cache, areaKeys: { [AREA]: [encode(new Uint8Array(32).fill(3))] } },
                rosters: h.rosters.slice(1),
            },
            expected: refused,
        });
        cases.push({
            name: 'cache-area-keys-extra',
            input: {
                ...fromOne(h),
                cache: {
                    ...one.cache,
                    areaKeys: {
                        ...one.cache.areaKeys,
                        [SECOND_AREA]: [encode(new Uint8Array(32).fill(3))],
                    },
                },
                rosters: h.rosters.slice(1),
            },
            expected: refused,
        });
        // r11 (Opus 8), r12: a cache whose area key commitment is not a digest is no cache, in
        // either core (a value both twins can hold, so the refusal is each core's own).
        cases.push({
            name: 'cache-area-keys-malformed',
            input: {
                ...fromOne(h),
                cache: { ...one.cache, areaKeys: { [AREA]: ['nope'] } },
                rosters: h.rosters.slice(1),
            },
            expected: refused,
        });
        const sibling = await history();
        await sibling.roster(organizer, [owner, adult.entry([])]);
        await sibling.roster(organizer, [owner, adult.entry([]), outsider.entry([], 2)]);
        cases.push({
            name: 'cache-as-marks',
            input: { ...fromOne(h), cache: (await acceptedTo(sibling, 2, everyone)).cache },
            expected: fork('roster', 2),
        });
        // The next roster and the next succession, as a holder and the server check them.
        const chain = await acceptedOf(h, everyone);
        const nextOf = async (members: RosterMember[], signer: Person) =>
            signRoster(
                {
                    ...h.statements[2]!,
                    rosterVersion: 4,
                    previousRosterDigest: chain.rosterDigest,
                    signerUserId: signer.userId,
                    members: sortedMembers(
                        members.map((m) => {
                            const before = h.statements[2]!.members.find(
                                (b) => b.userId === m.userId,
                            );
                            const same =
                                before &&
                                JSON.stringify(before) ===
                                    JSON.stringify({ ...m, sinceVersion: before.sinceVersion });
                            return { ...m, sinceVersion: same ? before!.sinceVersion : 4 };
                        }),
                    ),
                },
                h.keys[0]!,
                signer.signer,
            );
        const next = (
            roster: SignedGroupStatement | null,
            succession: SignedGroupStatement | null,
            identities: Record<string, ServedIdentity[]> | null = null,
        ) => ({
            roster,
            succession,
            identities,
        });
        const adding = await nextOf(
            [owner, adult.entry(['billing']), outsider.entry([]), child.entry([])],
            organizer,
        );
        const identities = {
            [organizer.userId]: [organizer.served],
            [adult.userId]: [adult.served],
            [outsider.userId]: [outsider.served],
            [child.userId]: [child.served],
        };
        cases.push({
            name: 'next-roster',
            input: fromOne(h),
            next: next(adding, null, identities),
            expected: { ...accepted(3), next: 'accepted' },
        });
        cases.push({
            name: 'next-roster-not-holder',
            input: fromOne(h),
            next: next(
                await nextOf(
                    [owner, adult.entry(['billing']), outsider.entry([]), child.entry([])],
                    adult,
                ),
                null,
            ),
            expected: { ...accepted(3), next: 'refused' },
        });
        cases.push({
            name: 'next-roster-drops-entry',
            input: fromOne(h),
            next: next(await nextOf([owner, adult.entry(['billing'])], organizer), null),
            expected: { ...accepted(3), next: 'refused' },
        });
        const planted = await nextOf(
            [
                owner,
                { ...outsider.entry([]), userId: adult.userId, keyVersion: 1000 },
                outsider.entry([]),
            ],
            organizer,
        );
        cases.push({
            name: 'next-roster-planted',
            input: fromOne(h),
            next: next(planted, null, identities),
            expected: { ...accepted(3), next: 'refused' },
        });
        cases.push({
            name: 'next-roster-planted-unchecked',
            input: fromOne(h),
            next: next(planted, null),
            expected: { ...accepted(3), next: 'accepted' },
        });
        const succeedFrom = async (tie: number) => {
            const old = h.keys[0]!;
            const nextKey = await groupKeyAt(2);
            return signGroupSuccession(
                {
                    groupId: GROUP,
                    oldVersion: 1,
                    newVersion: 2,
                    oldEd25519PublicKey: old.publicKey.ed25519PublicKey,
                    oldMlDsaPublicKey: old.publicKey.mlDsaPublicKey,
                    newEd25519PublicKey: nextKey.publicKey.ed25519PublicKey,
                    newMlDsaPublicKey: nextKey.publicKey.mlDsaPublicKey,
                    lastRosterVersion: tie,
                    lastRosterDigest: await rosterDigest(h.rosters[tie - 1]!.statement),
                    signerUserId: organizer.userId,
                },
                old,
                organizer.signer,
            );
        };
        cases.push({
            name: 'next-succession',
            input: fromOne(h),
            next: next(null, await succeedFrom(3)),
            expected: { ...accepted(3), next: 'accepted' },
        });
        cases.push({
            name: 'next-succession-tied-early',
            input: fromOne(h),
            next: next(null, await succeedFrom(2)),
            expected: { ...accepted(3), next: 'refused' },
        });
    }
    // A holder removed at 2 (key replaced, tied to 2), then 3 under key 2; the removed holder
    // forges another 3 under key 1: two latest rosters, refused.
    {
        const h = await history();
        await h.roster(organizer, [owner, holder.entry(['members'])]);
        await h.roster(organizer, [owner, holder.entry(['members'], 2, 'left')]);
        await h.succession(organizer);
        await h.roster(
            organizer,
            [owner, holder.entry(['members'], 2, 'left'), adult.entry([])],
            2,
        );
        const forged = await signedBy(
            rosterStatement({
                ...h.statements[2]!,
                groupKeyVersion: 1,
                signerUserId: holder.userId,
                members: sortedMembers([owner, holder.entry(['members'])]),
            }),
            h.keys[0]!,
            holder,
        );
        cases.push({
            name: 'forged-latest',
            input: { ...fromOne(h), rosters: [...h.rosters, forged] },
            expected: refused,
        });
    }
    // A succession tied to 2, then 3 still under key 1; a removal at 2 with no succession.
    {
        const h = await history();
        await h.roster(organizer, [owner]);
        await h.roster(organizer, [owner, adult.entry([])]);
        await h.succession(organizer);
        await h.roster(organizer, [owner, adult.entry([]), outsider.entry([])], 1);
        cases.push({ name: 'key-window', input: fromOne(h), expected: refused });
        const g = await history();
        await g.roster(organizer, [owner, holder.entry(['members'])]);
        await g.roster(organizer, [owner, holder.entry(['members'], 2, 'left')]);
        await g.roster(organizer, [owner, holder.entry(['members'], 2, 'left'), adult.entry([])]);
        cases.push({ name: 'succession-due', input: fromOne(g), expected: refused });
    }
    // Two successions from key 1 that both hold: refused, unless a group key mark chooses.
    {
        const h = await history();
        await h.roster(organizer, [owner, adult.entry([])]);
        await h.succession(organizer);
        const genuine = parseGroupSuccession(h.successions[0]!.statement);
        const rivalKey = (await groupKeyAt(8)).publicKey;
        const rival = await signedBy(
            groupSuccessionStatement({
                ...genuine,
                newEd25519PublicKey: rivalKey.ed25519PublicKey,
                newMlDsaPublicKey: rivalKey.mlDsaPublicKey,
            }),
            h.keys[0]!,
            organizer,
        );
        const both = { ...fromOne(h), successions: [...h.successions, rival] };
        cases.push({ name: 'two-successions', input: both, expected: refused });
        const pin = await pinAfter([], await acceptedOf(h, everyone), CHECKED);
        cases.push({
            name: 'two-successions-marked',
            input: { ...both, pins: [pin] },
            expected: accepted(1),
        });
        // F6: two pins naming different group keys at one key version.
        cases.push({
            name: 'pins-other-group-key',
            input: {
                ...fromOne(h),
                pins: [pin, { ...pin, groupKeyDigest: await groupKeyDigest(rivalKey) }],
            },
            expected: fork('group-key', 2),
        });
    }
    // The organizer replaces their identity; the holder folds it in at 3; the organizer signs 4 with it.
    {
        const { next: organizer2 } = await succeed(organizer);
        const h = await history();
        await h.roster(organizer, [owner, holder.entry(['members'])]);
        await h.roster(organizer, [owner, holder.entry(['members']), adult.entry([])]);
        await h.roster(holder, [
            organizer2.entry(['billing', 'guardian', 'members']),
            holder.entry(['members']),
            adult.entry([]),
        ]);
        await h.roster(organizer2, [
            organizer2.entry(['billing', 'guardian', 'members']),
            holder.entry(['members']),
            adult.entry(['billing']),
        ]);
        cases.push({
            name: 'identity-change',
            input: fromOne(h, [organizer, organizer2, holder]),
            expected: accepted(4),
        });
        // An Ed25519 forger signing as the organizer with their own ML-DSA key, served under the organizer's digest.
        const forger = {
            signingKey: organizer.signer.signingKey,
            mlDsaSecretKey: outsider.signer.mlDsaSecretKey,
        };
        const forge = async (signed: SignedGroupStatement) => ({
            ...signed,
            signerSignature: await signHybrid(signed.statement, forger),
        });
        cases.push({
            name: 'signer-ml-dsa-substituted',
            input: {
                ...fromOne(h, [organizer, organizer2, holder]),
                rosters: await Promise.all(h.rosters.map(forge)),
                mlDsaKeys: {
                    ...mlDsaKeysOf(organizer2, holder),
                    [organizer.mlDsaDigest]: outsider.served.mlDsaPublicKey,
                },
            },
            expected: refused,
        });
    }
    // The entry rules: an entry dropped, a sinceVersion not the version it changed at.
    {
        const h = await history();
        await h.roster(organizer, [owner, adult.entry([])]);
        const dropped = await signRoster(
            {
                ...h.statements[0]!,
                rosterVersion: 2,
                previousRosterDigest: await rosterDigest(h.rosters[0]!.statement),
                members: [owner],
            },
            h.keys[0]!,
            organizer.signer,
        );
        cases.push({
            name: 'entry-dropped',
            input: { ...fromOne(h), rosters: [h.rosters[0]!, dropped] },
            expected: refused,
        });
        const stale = await signRoster(
            {
                ...h.statements[0]!,
                rosterVersion: 2,
                previousRosterDigest: await rosterDigest(h.rosters[0]!.statement),
                members: sortedMembers([owner, adult.entry(['billing'], 1)]),
            },
            h.keys[0]!,
            organizer.signer,
        );
        cases.push({
            name: 'since-version-wrong',
            input: { ...fromOne(h), rosters: [h.rosters[0]!, stale] },
            expected: refused,
        });
    }
    // The adult's entry swapped for the outsider's keys at 2, then their own third identity at 3.
    {
        const { next: adult2 } = await succeed(adult);
        const { next: adult3 } = await succeed(adult2);
        const h = await history();
        await h.roster(organizer, [owner, adult.entry([])]);
        await h.roster(organizer, [
            owner,
            { ...outsider.entry([]), userId: adult.userId, keyVersion: 2 },
        ]);
        await h.roster(organizer, [owner, adult3.entry([])]);
        cases.push({
            name: 'wrong-own-entry',
            input: {
                ...fromOne(h),
                me: { userId: adult.userId, identities: [adult, adult2, adult3].map(servedKeysOf) },
            },
            expected: accepted(3),
        });
        // r8: the adult's entry moved to their own second identity while they hold a third: a
        // replaced identity of theirs, a soft note at each roster it changed to one (1 and 2).
        const behind = await history();
        await behind.roster(organizer, [owner, adult.entry([])]);
        await behind.roster(organizer, [owner, adult2.entry([])]);
        cases.push({
            name: 'own-entry-behind',
            input: {
                ...fromOne(behind),
                me: { userId: adult.userId, identities: [adult, adult2, adult3].map(servedKeysOf) },
            },
            expected: { ...accepted(2), ownEntryBehindAt: [1, 2] },
        });
    }
    // Probes 1, 1b, 1c, F2, F3: a roster's keys are a holder's claim; versions are free.
    {
        const restarted = await person(2, 2);
        const { next: adult3 } = await succeed(restarted);
        const h = await history();
        await h.roster(organizer, [owner, adult.entry([])]);
        await h.roster(organizer, [owner, adult3.entry([])]);
        cases.push({
            name: 'entry-several-versions-ahead',
            input: fromOne(h),
            expected: accepted(2),
        });
        const { next: adult2, link } = await succeed(adult);
        const base = await history();
        await base.roster(organizer, [owner, adult.entry([]), holder.entry(['members'])]);
        await base.roster(holder, [
            owner,
            { ...outsider.entry([]), userId: adult.userId, keyVersion: 2 },
            holder.entry(['members']),
        ]);
        await base.roster(organizer, [owner, adult.entry([]), holder.entry(['members'])]);
        cases.push({
            name: 'wrong-entry-restored-back',
            input: fromOne(base),
            expected: accepted(3),
        });
        // F3: the outsider's key planted at 2 and taken out at 3, with no link from it, vouches for nothing.
        cases.push({
            name: 'f3-planted-key',
            input: fromOne(base),
            record: {
                writerUserId: adult.userId,
                signature: encode(await recordSignature(outsider.signer.signingKey)),
                pinned: null,
                served: servedKeysOf(adult),
                links: [],
            },
            expected: reads('bad-signature', null, 3),
        });
        // F2: the adult's own keys written at key version 1000 (and another KEM key); their real
        // succession is still followed from the entry's keys.
        const f2 = await history();
        await f2.roster(organizer, [owner, adult.entry([])]);
        await f2.roster(organizer, [
            owner,
            {
                ...adult.entry([]),
                kemPublicKeyDigest: outsider.entry([]).kemPublicKeyDigest,
                keyVersion: 1000,
            },
        ]);
        cases.push({
            name: 'f2-inflated-version',
            input: fromOne(f2),
            record: {
                writerUserId: adult.userId,
                signature: encode(await recordSignature(adult2.signer.signingKey)),
                pinned: null,
                served: servedKeysOf(adult2),
                links: [link],
            },
            expected: reads('verified', GROUP, 2),
        });
    }
    // P2, P3: the holder is removed at 3 and the key replaced; the outsider poses as the holder.
    {
        const h = await history();
        await h.roster(organizer, [owner, holder.entry(['members'])]);
        await h.roster(organizer, [owner, holder.entry(['members']), outsider.entry([])]);
        await h.roster(organizer, [
            owner,
            holder.entry(['members'], 3, 'left'),
            outsider.entry([]),
        ]);
        await h.succession(organizer);
        const posing = { ...outsider.entry(['members'], 2), userId: holder.userId };
        const rival2 = await signedBy(
            rosterStatement({
                ...h.statements[1]!,
                signerUserId: holder.userId,
                members: sortedMembers([owner, posing]),
            }),
            h.keys[0]!,
            outsider,
        );
        cases.push({
            name: 'p3-self-listed-rival',
            input: { ...fromOne(h), rosters: [...h.rosters, rival2] },
            expected: {
                ...accepted(3),
                deadBranches: [{ version: 2, signerUserId: holder.userId }],
            },
        });
        const alt = await signRoster(
            {
                ...h.statements[2]!,
                signerUserId: holder.userId,
                members: h.statements[1]!.members.map((m) =>
                    m.userId === outsider.userId
                        ? { ...m, roles: ['members' as const], sinceVersion: 3 }
                        : m,
                ),
            },
            h.keys[0]!,
            holder.signer,
        );
        const withheld = {
            ...fromOne(h),
            rosters: [...h.rosters.slice(0, 2), alt],
            successions: [],
        };
        cases.push({ name: 'p2b-missed-removal', input: withheld, expected: accepted(3) });
        cases.push({
            name: 'p2b-caught-by-pin',
            input: { ...withheld, pins: [await pinOf(h, 3, everyone)] },
            expected: fork('roster', 3),
        });
    }
    // F1, P4, p4b: a former holder of key 1 at a chain of nine rosters, six under key 2.
    {
        const h = await history();
        await h.roster(organizer, [owner, holder.entry(['members'])]);
        await h.roster(organizer, [owner, holder.entry(['members']), adult.entry([], 2)]);
        await h.roster(organizer, [
            owner,
            holder.entry(['members'], 3, 'left'),
            adult.entry([], 2),
        ]);
        await h.succession(organizer);
        for (let i = 0; i < 6; i++)
            await h.roster(
                organizer,
                [
                    owner,
                    holder.entry(['members'], 3, 'left'),
                    adult.entry(i % 2 ? ['billing'] : []),
                ],
                2,
            );
        const pin9 = await pinOf(h, 9, everyone);
        // F1: long after their removal, the holder signs another roster 2 under key 1.
        const back = await signRoster(
            {
                ...h.statements[1]!,
                signerUserId: holder.userId,
                members: sortedMembers([owner, holder.entry(['members']), outsider.entry([], 2)]),
            },
            h.keys[0]!,
            holder.signer,
        );
        const dead = [{ version: 2, signerUserId: holder.userId }];
        cases.push({
            name: 'f1-former-holder-rival',
            input: { ...fromOne(h), pins: [pin9], rosters: [...h.rosters, back] },
            expected: { ...accepted(9), deadBranches: dead },
        });
        cases.push({
            name: 'f1-with-cache',
            input: {
                ...fromOne(h),
                pins: [pin9],
                rosters: [...h.rosters, back],
                cache: (await acceptedOf(h, everyone)).cache,
            },
            expected: { ...accepted(9), deadBranches: dead },
        });
        // F1: an orphaned roster 5 of the organizer's (one the server never stored).
        const orphan = await signRoster(
            {
                ...h.statements[4]!,
                members: sortedMembers([...h.statements[4]!.members, child.entry([], 5)]),
            },
            h.keys[1]!,
            organizer.signer,
        );
        cases.push({
            name: 'f1-orphan',
            input: { ...fromOne(h), pins: [pin9], rosters: [...h.rosters, orphan] },
            expected: {
                ...accepted(9),
                deadBranches: [{ version: 5, signerUserId: organizer.userId }],
            },
        });
        const real = parseGroupSuccession(h.successions[0]!.statement);
        const far = await signedBy(
            groupSuccessionStatement({
                ...real,
                lastRosterVersion: 100,
                signerUserId: holder.userId,
            }),
            h.keys[0]!,
            null,
        );
        cases.push({
            name: 'p4-far-succession',
            input: { ...fromOne(h), successions: [...h.successions, far] },
            expected: accepted(9),
        });
        const own = (await groupKeyPair(pattern(64, 200))).publicKey;
        const inOrder = await signedBy(
            groupSuccessionStatement({
                ...real,
                newEd25519PublicKey: own.ed25519PublicKey,
                newMlDsaPublicKey: own.mlDsaPublicKey,
                signerUserId: holder.userId,
            }),
            h.keys[0]!,
            holder,
        );
        cases.push({
            name: 'p4b-in-order-rival',
            input: { ...fromOne(h), successions: [...h.successions, inOrder] },
            expected: accepted(9),
        });
        // A cache through 9, then the rival succession served alone: it is off the cache's chain.
        const full = await acceptedOf(h, everyone);
        cases.push({
            name: 'cache-ignores-other-succession',
            input: { ...fromOne(h), cache: full.cache, rosters: [], successions: [inOrder] },
            expected: accepted(9),
        });
    }
    // A succession tied before the one into its key; a roster served twice; a copy with a bad signature.
    {
        const h = await history();
        await h.roster(organizer, [owner, adult.entry([])]);
        await h.roster(organizer, [owner, adult.entry(['billing'])]);
        await h.succession(organizer);
        await h.roster(organizer, [owner, adult.entry([])], 2);
        await h.succession(organizer);
        await h.roster(organizer, [owner, adult.entry(['billing'])], 3);
        const early = await signedBy(
            groupSuccessionStatement({
                ...parseGroupSuccession(h.successions[1]!.statement),
                lastRosterVersion: 1,
                lastRosterDigest: await rosterDigest(h.rosters[0]!.statement),
            }),
            h.keys[1]!,
            organizer,
        );
        cases.push({
            name: 'succession-out-of-order',
            input: { ...fromOne(h), successions: [h.successions[0]!, early] },
            expected: refused,
        });
        const again = await signRoster(h.statements[1]!, h.keys[0]!, organizer.signer);
        cases.push({
            name: 'same-statement-twice',
            input: { ...fromOne(h), rosters: [...h.rosters, again] },
            expected: accepted(4),
        });
        const flipped = {
            ...again,
            signature: {
                ...again.signature,
                mlDsa: again.signature.mlDsa.map((b, i) => (i === 9 ? b ^ 1 : b)),
            },
        };
        cases.push({
            name: 'bad-copy-beside-good',
            input: { ...fromOne(h), rosters: [...h.rosters, flipped] },
            expected: accepted(4),
        });
        cases.push({
            name: 'only-bad-copy',
            input: { ...fromOne(h), rosters: [h.rosters[0]!, flipped, ...h.rosters.slice(2)] },
            expected: refused,
        });
    }
    // Records read through the chain: the adult replaced their identity (folded in at 3 in the
    // second history), and writes before and after.
    {
        const { next: adult2, link } = await succeed(adult);
        const { next: adult3, link: second } = await succeed(adult2);
        const h = await history();
        await h.roster(organizer, [owner, adult.entry([])]);
        await h.roster(organizer, [owner, adult.entry(['billing'])]);
        const lagging = fromOne(h);
        const byNew = encode(await recordSignature(adult2.signer.signingKey));
        const byOld = encode(await recordSignature(adult.signer.signingKey));
        const lag = {
            writerUserId: adult.userId,
            signature: byNew,
            pinned: null,
            served: servedKeysOf(adult2),
            links: [link],
        };
        cases.push({
            name: 'record-roster-lag',
            input: lagging,
            record: lag,
            expected: reads('verified', GROUP, 2),
        });
        cases.push({
            name: 'record-roster-lag-pinned',
            input: lagging,
            record: { ...lag, pinned: await adult2.pinned() },
            expected: reads('verified', null, 2),
        });
        cases.push({
            name: 'record-two-link-lag',
            input: lagging,
            record: { ...lag, served: servedKeysOf(adult3), links: [link, second] },
            expected: reads('retired-key', null, 2),
        });
        const unloaded = { ...lag, served: null, links: null };
        cases.push({
            name: 'record-lag-unloaded',
            input: lagging,
            record: unloaded,
            expected: reads('unchecked', null, 2),
        });
        const flipped = decode(byOld);
        flipped[0]! ^= 1;
        const loadedOld = { ...lag, served: servedKeysOf(adult), links: [] };
        cases.push({
            name: 'record-tampered',
            input: lagging,
            record: { ...loadedOld, signature: encode(flipped) },
            expected: reads('bad-signature', null, 2),
        });
        cases.push({
            name: 'record-tampered-unloaded',
            input: lagging,
            record: { ...unloaded, signature: encode(flipped) },
            expected: reads('unchecked', null, 2),
        });
        cases.push({
            name: 'record-forged',
            input: lagging,
            record: {
                ...loadedOld,
                signature: encode(await recordSignature(outsider.signer.signingKey)),
            },
            expected: reads('bad-signature', null, 2),
        });
        await h.roster(organizer, [owner, adult2.entry(['billing'])]);
        cases.push({
            name: 'record-retired-key',
            input: fromOne(h),
            record: { ...lag, signature: byOld },
            expected: reads('retired-key', null, 3),
        });
    }
    // The fifth review's probes. p4: an unsigned chain naming the child as signer, against a pin;
    // p7: an unsigned roster after the cache that does not continue it. Neither is a warning.
    {
        const h = await history();
        await h.roster(organizer, [owner, adult.entry([])]);
        await h.roster(organizer, [owner, adult.entry(['members'])]);
        await h.roster(organizer, [owner, adult.entry(['members'])]);
        const unsigned = (statement: Uint8Array) => ({
            statement,
            signature: { ed25519: new Uint8Array(64), mlDsa: new Uint8Array(3309) },
            signerSignature: new Uint8Array(3373),
        });
        const fabricated: SignedGroupStatement[] = [];
        let previous = '';
        for (let version = 1; version <= 3; version++) {
            const statement = rosterStatement({
                ...h.statements[0]!,
                rosterVersion: version,
                previousRosterDigest: previous,
                signerUserId: child.userId,
                members: [child.entry(['members'])],
            });
            fabricated.push(unsigned(statement));
            previous = await rosterDigest(statement);
        }
        const pin2 = await pinOf(h, 2, everyone);
        cases.push({
            name: 'unsigned-chain-vs-pin',
            input: { ...fromOne(h), pins: [pin2], firstKeysChecked: false, rosters: fabricated },
            expected: refused,
        });
        const two = await acceptedTo(h, 2, everyone);
        cases.push({
            name: 'cache-junk-extension',
            input: {
                ...fromOne(h),
                cache: two.cache,
                firstKeysChecked: false,
                rosters: [
                    unsigned(
                        rosterStatement({
                            ...h.statements[2]!,
                            previousRosterDigest: junk,
                            signerUserId: child.userId,
                        }),
                    ),
                ],
            },
            expected: refused,
        });
        // The same chain verifying under other version 1 keys than the pin's: the warning.
        const other = await groupKeyAt(7);
        const elsewhere = await Promise.all(
            h.statements.slice(0, 2).map((roster) => signRoster(roster, other, organizer.signer)),
        );
        cases.push({
            name: 'first-keys-elsewhere',
            input: {
                ...fromOne(h),
                pins: [pin2],
                firstKeys: other.publicKey,
                rosters: elsewhere,
                successions: [],
            },
            expected: refused,
        });
    }
    // p3: a removed holder's rival succession tied before the real one, against group key marks.
    {
        const h = await history();
        await h.roster(organizer, [owner, holder.entry(['members'])]);
        await h.roster(organizer, [owner, holder.entry(['members'], 1, 'left')]);
        await h.succession(organizer);
        await h.roster(organizer, [owner, holder.entry(['members'], 1, 'left')], 2);
        const rivalKey = (await groupKeyAt(7)).publicKey;
        const early = await signedBy(
            groupSuccessionStatement({
                ...parseGroupSuccession(h.successions[0]!.statement),
                newEd25519PublicKey: rivalKey.ed25519PublicKey,
                newMlDsaPublicKey: rivalKey.mlDsaPublicKey,
                lastRosterVersion: 1,
                lastRosterDigest: await rosterDigest(h.rosters[0]!.statement),
                signerUserId: holder.userId,
            }),
            h.keys[0]!,
            holder,
        );
        cases.push({
            name: 'rival-succession-waits',
            input: {
                ...fromOne(h),
                pins: [await pinOf(h, 3, everyone)],
                firstKeysChecked: false,
                successions: [...h.successions, early],
            },
            expected: accepted(3),
        });
        const atTwo = await pinAfter(
            [],
            await acceptedOf(h, everyone, { rosters: h.rosters.slice(0, 2) }),
            CHECKED,
        );
        cases.push({
            name: 'rival-succession-mark-unmet',
            input: {
                ...fromOne(h),
                pins: [atTwo],
                firstKeysChecked: false,
                rosters: h.rosters.slice(0, 2),
                successions: [early],
            },
            expected: refused,
        });
        // Roster 3 under the real key 2 while only the rival is served: missing, refused.
        cases.push({
            name: 'rival-succession-real-withheld',
            input: {
                ...fromOne(h),
                pins: [await pinOf(h, 3, everyone)],
                firstKeysChecked: false,
                successions: [early],
            },
            expected: refused,
        });
        // Roster 3 signed by a holder under the rival key: a real other history, the warning.
        cases.push({
            name: 'rival-key-signed-roster',
            input: {
                ...fromOne(h),
                pins: [await pinOf(h, 3, everyone)],
                firstKeysChecked: false,
                rosters: [
                    ...h.rosters.slice(0, 2),
                    await signRoster(h.statements[2]!, await groupKeyAt(7), organizer.signer),
                ],
                successions: [early],
            },
            expected: fork('group-key', 2),
        });
        // Under the rival key but signed by the removed holder: nothing a holder signed, refused.
        cases.push({
            name: 'rival-key-roster-by-removed-holder',
            input: {
                ...fromOne(h),
                pins: [await pinOf(h, 3, everyone)],
                firstKeysChecked: false,
                rosters: [
                    ...h.rosters.slice(0, 2),
                    await signRoster(
                        { ...h.statements[2]!, signerUserId: holder.userId },
                        await groupKeyAt(7),
                        holder.signer,
                    ),
                ],
                successions: [early],
            },
            expected: refused,
        });
        // r12: under the rival key, signed by a holder, but breaking the departure rules (the
        // signer leaves on it, and no holder is left): refused, never the warning.
        cases.push({
            name: 'rival-key-roster-signer-leaves',
            input: {
                ...fromOne(h),
                pins: [await pinOf(h, 3, everyone)],
                firstKeysChecked: false,
                rosters: [
                    ...h.rosters.slice(0, 2),
                    await signRoster(
                        {
                            ...h.statements[2]!,
                            members: h.statements[2]!.members.map((entry) => ({
                                ...entry,
                                status: 'left' as const,
                            })),
                        },
                        await groupKeyAt(7),
                        organizer.signer,
                    ),
                ],
                successions: [early],
            },
            expected: refused,
        });
        // A succession whose "new" key is the key it replaces, and roster 3 signed under that key:
        // taken, it would let the replaced key go on signing.
        const first = h.keys[0]!.publicKey;
        cases.push({
            name: 'succession-to-the-old-key',
            input: {
                ...fromOne(h),
                rosters: [
                    ...h.rosters.slice(0, 2),
                    await signRoster(h.statements[2]!, h.keys[0]!, organizer.signer),
                ],
                successions: [
                    await signedBy(
                        groupSuccessionStatement({
                            ...parseGroupSuccession(h.successions[0]!.statement),
                            newEd25519PublicKey: first.ed25519PublicKey,
                            newMlDsaPublicKey: first.mlDsaPublicKey,
                        }),
                        h.keys[0]!,
                        organizer,
                    ),
                ],
            },
            expected: refused,
        });
    }
    // r8 (Fable F3), r10: the join mark, the roster that admitted the child (2, signed by the
    // adult) by its twelve-word code over the roster's digest, its group key and key version: met;
    // another roster, key or key version is the warning; a chain short of it is a rollback; a
    // shorter code is no mark.
    {
        const h = await history();
        await h.roster(organizer, [owner, adult.entry(['members'])]);
        await h.roster(adult, [owner, adult.entry(['members']), child.entry([])]);
        const atTwo = await rosterDigest(h.rosters[1]!.statement);
        const key1 = h.keys[0]!.publicKey;
        const mark = { rosterVersion: 2, code: await joinCode(atTwo, key1, 1) };
        const joining = (joinMark: typeof mark) => ({ ...fromOne(h), joinMark });
        cases.push({ name: 'join-mark-holds', input: joining(mark), expected: accepted(2) });
        cases.push({
            name: 'join-mark-other-roster',
            input: joining({
                ...mark,
                code: await joinCode(await rosterDigest(h.rosters[0]!.statement), key1, 1),
            }),
            expected: fork('roster', 2),
        });
        cases.push({
            name: 'join-mark-other-group-key',
            input: joining({
                ...mark,
                code: await joinCode(atTwo, (await groupKeyAt(2)).publicKey, 1),
            }),
            expected: fork('roster', 2),
        });
        cases.push({
            name: 'join-mark-other-group-key-version',
            input: joining({ ...mark, code: await joinCode(atTwo, key1, 2) }),
            expected: fork('roster', 2),
        });
        cases.push({
            name: 'join-mark-beyond-chain',
            input: joining({ ...mark, rosterVersion: 3 }),
            expected: refused,
        });
        cases.push({
            name: 'join-mark-short-code',
            input: joining({ ...mark, code: mark.code.slice(0, 11) }),
            expected: refused,
        });
        // After a succession: roster 3 is under key 2, and the code names key 2.
        const after = await history();
        await after.roster(organizer, [owner, adult.entry(['members'])]);
        await after.roster(organizer, [owner, adult.entry(['members']), holder.entry([])]);
        await after.succession(organizer);
        await after.roster(
            adult,
            [owner, adult.entry(['members']), holder.entry([]), child.entry([])],
            2,
        );
        const atThree = await rosterDigest(after.rosters[2]!.statement);
        cases.push({
            name: 'join-mark-after-succession',
            input: {
                ...fromOne(after),
                joinMark: {
                    rosterVersion: 3,
                    code: await joinCode(atThree, after.keys[1]!.publicKey, 2),
                },
            },
            expected: accepted(3),
        });
        cases.push({
            name: 'join-mark-after-succession-first-key',
            input: {
                ...fromOne(after),
                joinMark: {
                    rosterVersion: 3,
                    code: await joinCode(atThree, after.keys[0]!.publicKey, 1),
                },
            },
            expected: fork('roster', 3),
        });
        // The roster a succession is tied to is the last under the old key: a mark there names key 1.
        cases.push({
            name: 'join-mark-at-succession-tie',
            input: {
                ...fromOne(after),
                joinMark: {
                    rosterVersion: 2,
                    code: await joinCode(
                        await rosterDigest(after.rosters[1]!.statement),
                        after.keys[0]!.publicKey,
                        1,
                    ),
                },
            },
            expected: accepted(3),
        });
    }
    // r8: key 1, then key 2, then a succession from 2 back to key 1, roster 3 signed under it.
    {
        const h = await history();
        await h.roster(organizer, [owner, holder.entry(['members'])]);
        await h.succession(organizer);
        await h.roster(organizer, [owner, holder.entry(['members'])], 2);
        const back = await signedBy(
            groupSuccessionStatement({
                groupId: GROUP,
                oldVersion: 2,
                newVersion: 3,
                oldEd25519PublicKey: h.keys[1]!.publicKey.ed25519PublicKey,
                oldMlDsaPublicKey: h.keys[1]!.publicKey.mlDsaPublicKey,
                newEd25519PublicKey: h.keys[0]!.publicKey.ed25519PublicKey,
                newMlDsaPublicKey: h.keys[0]!.publicKey.mlDsaPublicKey,
                lastRosterVersion: 2,
                lastRosterDigest: await rosterDigest(h.rosters[1]!.statement),
                signerUserId: organizer.userId,
            }),
            h.keys[1]!,
            organizer,
        );
        const underFirst = await signRoster(
            {
                ...h.statements[1]!,
                rosterVersion: 3,
                previousRosterDigest: await rosterDigest(h.rosters[1]!.statement),
                groupKeyVersion: 3,
            },
            h.keys[0]!,
            organizer.signer,
        );
        cases.push({
            name: 'succession-back-to-an-earlier-key',
            input: {
                ...fromOne(h),
                rosters: [...h.rosters, underFirst],
                successions: [...h.successions, back],
            },
            expected: refused,
        });
    }
    // p1, p2: records under keys a fake link or a planted entry would retire; an own entry rolled back.
    {
        const h = await history();
        await h.roster(organizer, [owner, adult.entry([])]);
        const { next: adult2, link } = await succeed(adult);
        const fake = {
            ...link,
            oldMlDsaPublicKey: outsider.served.mlDsaPublicKey,
            newSigningPublicKey: outsider.served.signingPublicKey,
            signature: encode(new Uint8Array(3373)),
        };
        const probe = {
            writerUserId: adult.userId,
            signature: encode(await recordSignature(outsider.signer.signingKey)),
            pinned: null,
            served: servedKeysOf(adult2),
            links: [fake, link],
        };
        cases.push({
            name: 'fake-link-first',
            input: fromOne(h),
            record: probe,
            expected: reads('bad-signature', null, 1),
        });
        cases.push({
            name: 'fake-link-first-pinned',
            input: fromOne(h),
            record: { ...probe, pinned: await adult.pinned() },
            expected: reads('bad-signature', null, 1),
        });
        const restarted = await person(2, 2);
        const planted = await person(9);
        const { next: adult3, link: real } = await succeed(restarted);
        const p = await history();
        await p.roster(organizer, [owner, restarted.entry([]), holder.entry(['members'])]);
        await p.roster(holder, [
            owner,
            { ...planted.entry([]), userId: adult.userId },
            holder.entry(['members']),
        ]);
        await p.roster(organizer, [owner, adult3.entry([]), holder.entry(['members'])]);
        const fields = {
            oldKeyVersion: 1,
            newKeyVersion: 2,
            oldEncryptionPublicKey: planted.served.encryptionPublicKey,
            oldSigningPublicKey: planted.served.signingPublicKey,
            oldMlDsaPublicKey: planted.served.mlDsaPublicKey,
            newEncryptionPublicKey: restarted.served.encryptionPublicKey,
            newSigningPublicKey: restarted.served.signingPublicKey,
            newMlDsaPublicKey: restarted.served.mlDsaPublicKey,
            newKemPublicKey: restarted.served.kemPublicKey,
        };
        // Given the member's consent as well (a test can sign it), so these cases pin the rule
        // that chains start only at the first keys, apart from the consent rule.
        const forgedLink = {
            ...fields,
            signature: encode(
                await signHybrid(
                    await successionStatement({ ...fields, userId: adult.userId }),
                    planted.signer,
                ),
            ),
            consent: await consentOf(fields, adult.userId, planted.signer, restarted.signer),
        };
        const plantedProbe = {
            writerUserId: adult.userId,
            signature: encode(await recordSignature(planted.signer.signingKey)),
            pinned: null,
            served: servedKeysOf(adult3),
            links: [forgedLink, real],
        };
        cases.push({
            name: 'planted-forged-link',
            input: fromOne(p),
            record: plantedProbe,
            expected: reads('bad-signature', null, 3),
        });
        cases.push({
            name: 'planted-forged-link-pinned',
            input: fromOne(p),
            record: { ...plantedProbe, pinned: await adult3.pinned() },
            expected: reads('bad-signature', null, 3),
        });
        // F1: the planted keys are the adult's FIRST entry, so the walk starts at them; the real
        // keys follow at 2. A planter can sign the link from the planted keys but not the new
        // key's consent: one-sided or with junk consent, the link bridges nothing, and a record
        // under the planted keys reads bad-signature, never retired-key. With the real keys'
        // consent (a test can sign it) the same link does bridge.
        const pf = await history();
        await pf.roster(organizer, [
            owner,
            { ...planted.entry([]), userId: adult.userId },
            holder.entry(['members']),
        ]);
        await pf.roster(organizer, [owner, restarted.entry([]), holder.entry(['members'])]);
        const { consent: _, ...oneSidedForged } = forgedLink;
        const firstProbe = {
            writerUserId: adult.userId,
            signature: encode(await recordSignature(planted.signer.signingKey)),
            pinned: null,
            served: servedKeysOf(restarted),
            links: [oneSidedForged],
        };
        cases.push({
            name: 'planted-first-one-sided-link',
            input: fromOne(pf),
            record: firstProbe,
            expected: reads('bad-signature', null, 2),
        });
        // All a planter can make: the planted keys' half of the consent, valid, beside junk.
        cases.push({
            name: 'planted-first-planter-consent',
            input: fromOne(pf),
            record: {
                ...firstProbe,
                links: [
                    {
                        ...oneSidedForged,
                        consent: await consentOf(fields, adult.userId, planted.signer, null),
                    },
                ],
            },
            expected: reads('bad-signature', null, 2),
        });
        // And the new keys' half alone: both keys must agree to the link.
        cases.push({
            name: 'planted-first-new-half-only',
            input: fromOne(pf),
            record: {
                ...firstProbe,
                links: [
                    {
                        ...oneSidedForged,
                        consent: await consentOf(fields, adult.userId, null, restarted.signer),
                    },
                ],
            },
            expected: reads('bad-signature', null, 2),
        });
        cases.push({
            name: 'planted-first-consented',
            input: fromOne(pf),
            record: { ...firstProbe, links: [forgedLink] },
            expected: reads('retired-key', null, 2),
        });
        // r9 (Opus 2): the planter makes his own Q, consents to P→Q himself (he holds both), and
        // the server serves Q as the adult's identity. The first keys' chain counts only up to the
        // entry's keys, which P→Q never reaches: a record under P reads bad-signature.
        const [selfX, selfY] = [await person(10), await person(11)];
        const selfLink = async (to: Person) => {
            const f = {
                ...fields,
                newEncryptionPublicKey: to.served.encryptionPublicKey,
                newSigningPublicKey: to.served.signingPublicKey,
                newMlDsaPublicKey: to.served.mlDsaPublicKey,
                newKemPublicKey: to.served.kemPublicKey,
            };
            return {
                ...f,
                signature: encode(
                    await signHybrid(
                        await successionStatement({ ...f, userId: adult.userId }),
                        planted.signer,
                    ),
                ),
                consent: await consentOf(f, adult.userId, planted.signer, to.signer),
            };
        };
        cases.push({
            name: 'planted-first-self-consented',
            input: fromOne(pf),
            record: { ...firstProbe, served: servedKeysOf(selfX), links: [await selfLink(selfX)] },
            expected: reads('bad-signature', null, 2),
        });
        // r9 (Fable C): two self-consented links leaving P fork only the first keys' walk: the
        // adult's own records still read verified, and a forgery still reads bad-signature.
        const forkAtFirst = [await selfLink(selfX), await selfLink(selfY)];
        cases.push({
            name: 'planted-first-fork-verified',
            input: fromOne(pf),
            record: {
                ...firstProbe,
                signature: encode(await recordSignature(restarted.signer.signingKey)),
                links: forkAtFirst,
            },
            expected: reads('verified', GROUP, 2),
        });
        cases.push({
            name: 'planted-first-fork-forgery',
            input: fromOne(pf),
            record: {
                ...firstProbe,
                signature: encode(await recordSignature(outsider.signer.signingKey)),
                links: forkAtFirst,
            },
            expected: reads('bad-signature', null, 2),
        });
        // r9 (Opus 3): a genuine succession the new key never co-signed (the version 2 signature
        // alone, what every shipped client signs): the roster-lag walk takes it, since keys a
        // holder planted never start there, so the new key's record reads verified.
        const { consent: __, ...oneSided } = link;
        const newProbe = {
            writerUserId: adult.userId,
            signature: encode(await recordSignature(adult2.signer.signingKey)),
            pinned: null,
            served: servedKeysOf(adult2),
            links: [oneSided],
        };
        cases.push({
            name: 'one-sided-link-on-the-lag',
            input: fromOne(h),
            record: newProbe,
            expected: reads('verified', GROUP, 1),
        });
        // r9 (Opus 5): the server serves the entry's own keys while a link the member signed
        // leaves them: a rollback to the entry, unchecked, never verified under the replaced key.
        cases.push({
            name: 'served-rolled-back-to-entry',
            input: fromOne(h),
            record: {
                ...newProbe,
                signature: encode(await recordSignature(adult.signer.signingKey)),
                served: servedKeysOf(adult),
                links: [oneSided],
            },
            expected: reads('unchecked', null, 1),
        });
        // r9 (Opus 8), r10 (Fable 6), r11: more than 64 links that could join the adult's chain
        // (here, links from the entry's keys with junk signatures) are checked no further. The
        // entry's keys are public, so the server can always serve them: the overflow reads as
        // links that did not load, never as a verdict on the adult. A record under the entry's key
        // still verifies; one under the new key reads unchecked. Links with any other old keys are
        // free and never counted.
        const fromEntry = { ...oneSided, signature: encode(new Uint8Array(3373)) };
        const overflowing = [
            link,
            ...Array.from({ length: 64 }, (_, i) => ({ ...fromEntry, newKeyVersion: i + 2 })),
        ];
        cases.push({
            name: 'too-many-links',
            input: fromOne(h),
            record: {
                ...newProbe,
                signature: encode(await recordSignature(adult.signer.signingKey)),
                links: overflowing,
            },
            expected: reads('verified', GROUP, 1),
        });
        cases.push({
            name: 'too-many-links-new-key',
            input: fromOne(h),
            record: { ...newProbe, links: overflowing },
            expected: reads('unchecked', null, 1),
        });
        cases.push({
            name: 'junk-links-ignored',
            input: fromOne(h),
            record: {
                ...newProbe,
                links: [
                    link,
                    ...Array.from({ length: 65 }, (_, i) => ({
                        ...junkLink,
                        oldKeyVersion: i + 1,
                        newKeyVersion: i + 2,
                    })),
                ],
            },
            expected: reads('verified', GROUP, 1),
        });
        cases.push({
            name: 'one-sided-link-consented',
            input: fromOne(h),
            record: { ...newProbe, links: [link] },
            expected: reads('verified', GROUP, 1),
        });
        // r10 (Opus 2), r11: a reader who pinned the planted keys through "Trust as Acme does"
        // (trustedVia: the group) while the planted entry was the latest; the entry is put right.
        // A link from the planted keys on their version 2 signature alone is no edge from a pin
        // the group vouched for: key-conflict, never the planted keys retired as the adult's.
        const { consent: _plantedConsent, ...oneSidedPlanted } = forgedLink;
        cases.push({
            name: 'planted-pin-one-sided-link',
            input: fromOne(p),
            record: {
                ...plantedProbe,
                pinned: await planted.pinned(),
                pinnedVia: GROUP,
                links: [oneSidedPlanted, real],
            },
            expected: { ...accepted(3), record: { integrity: 'key-conflict', via: null } },
        });
        // The same through a planted FIRST entry (where the keys sit first in the history): the
        // pin's origin, not its place, asks consent.
        cases.push({
            name: 'planted-first-pin-one-sided-link',
            input: fromOne(pf),
            record: { ...firstProbe, pinned: await planted.pinned(), pinnedVia: GROUP },
            expected: { ...accepted(2), record: { integrity: 'key-conflict', via: null } },
        });
        // r11 (Opus 2): no false conflict for an honest member. The reader checked words over the
        // adult's second identity (a personal pin); the adult rotates again with a one-sided link,
        // folded in. The pin's walk takes the version 2 signature: the roster's verdict.
        const { next: second, link: toSecond } = await succeed(adult);
        const { next: third, link: toThird } = await succeed(second);
        const folded = await history();
        await folded.roster(organizer, [owner, adult.entry([])]);
        await folded.roster(organizer, [owner, second.entry([])]);
        await folded.roster(organizer, [owner, third.entry([])]);
        const strip = ({ consent: _c, ...rest }: SuccessionLink) => rest;
        cases.push({
            name: 'pin-at-folded-identity-one-sided',
            input: fromOne(folded),
            record: {
                writerUserId: adult.userId,
                signature: encode(await recordSignature(third.signer.signingKey)),
                pinned: await second.pinned(),
                served: servedKeysOf(third),
                links: [strip(toSecond), strip(toThird)],
            },
            expected: reads('verified', GROUP, 3),
        });
        // A pin at a newer identity: the earlier keys on the verified chain up to it are retired.
        cases.push({
            name: 'pin-newer-than-key',
            input: fromOne(p),
            record: {
                ...plantedProbe,
                signature: encode(await recordSignature(restarted.signer.signingKey)),
                pinned: await adult3.pinned(),
            },
            expected: reads('retired-key', null, 3),
        });
        const back = await history();
        await back.roster(organizer, [owner, adult.entry([])]);
        await back.roster(organizer, [owner, adult2.entry([])]);
        await back.roster(organizer, [owner, adult.entry([])]);
        cases.push({
            name: 'own-entry-rolled-back',
            input: {
                ...fromOne(back),
                me: { userId: adult.userId, identities: [adult, adult2].map(servedKeysOf) },
            },
            expected: accepted(3),
        });
    }
    // The sixth review: the person's own marks before anything served; version 1 keys a server
    // made up; and what the local tests alone used to cover (tie digest, succession order, the
    // extending first keys, the cache's binding, the group's kind).
    {
        const h = await history();
        await h.roster(organizer, [owner, adult.entry([])]);
        await h.roster(organizer, [owner, adult.entry(['billing'])]);
        await h.succession(organizer);
        await h.roster(organizer, [owner, adult.entry([])], 2);
        const pin2 = await pinOf(h, 2, everyone);
        const elsewhere = { ...pin2, rosterDigest: junk };
        const unsignedHead = {
            ...(await signRoster(
                { ...h.statements[2]!, previousRosterDigest: junk },
                h.keys[1]!,
                organizer.signer,
            )),
            signature: { ed25519: new Uint8Array(64), mlDsa: new Uint8Array(3309) },
            signerSignature: new Uint8Array(3373),
        };
        cases.push({
            name: 'pins-disagree-junk-served',
            input: { ...fromOne(h), pins: [pin2, elsewhere], rosters: [unsignedHead] },
            expected: fork('roster', 2),
        });
        // Bytes that are not even a roster or a succession, or a roster of another group: the
        // marks are compared before anything served is parsed, so the warning still shows.
        const malformed = { ...unsignedHead, statement: new TextEncoder().encode('[') };
        cases.push({
            name: 'pins-disagree-malformed-served',
            input: {
                ...fromOne(h),
                pins: [pin2, elsewhere],
                rosters: [...h.rosters, malformed],
                successions: [...h.successions, malformed],
            },
            expected: fork('roster', 2),
        });
        // r8: a pin whose check time is not the canonical ISO form is no pin.
        cases.push({
            name: 'pin-check-time-not-canonical',
            input: { ...fromOne(h), pins: [{ ...pin2, checkedAt: '2026-10-15 00:00:00' }] },
            expected: refused,
        });
        cases.push({
            name: 'pin-check-time-month-13',
            input: { ...fromOne(h), pins: [{ ...pin2, checkedAt: '2026-13-15T00:00:00.000Z' }] },
            expected: refused,
        });
        cases.push({
            name: 'pins-disagree-other-group-served',
            input: {
                ...fromOne(h),
                pins: [pin2, elsewhere],
                rosters: [
                    ...h.rosters,
                    await signRoster(
                        { ...h.statements[0]!, groupId: OTHER_GROUP },
                        h.keys[0]!,
                        organizer.signer,
                    ),
                ],
            },
            expected: fork('roster', 2),
        });
        const serverKey = await groupKeyAt(42);
        const madeUp = await signRoster(
            {
                ...h.statements[0]!,
                signerUserId: outsider.userId,
                members: [outsider.entry(['billing', 'guardian', 'members'])],
            },
            serverKey,
            outsider.signer,
        );
        cases.push({
            name: 'server-made-first-keys',
            input: {
                ...fromOne(h),
                pins: [pin2],
                firstKeysChecked: false,
                firstKeys: serverKey.publicKey,
                rosters: [madeUp],
                successions: [],
            },
            expected: refused,
        });
        // The real succession, its tie naming roster 2's version but another roster's digest.
        const real = parseGroupSuccession(h.successions[0]!.statement);
        const misTied = await signedBy(
            groupSuccessionStatement({
                ...real,
                lastRosterDigest: await rosterDigest(h.rosters[0]!.statement),
            }),
            h.keys[0]!,
            organizer,
        );
        cases.push({
            name: 'succession-tie-digest',
            input: { ...fromOne(h), successions: [misTied] },
            expected: refused,
        });
        // A succession out of key 2 tied before the one into it: ignored, the chain stays at key 2.
        const three = (await groupKeyAt(3)).publicKey;
        const early = await signedBy(
            groupSuccessionStatement({
                ...real,
                oldVersion: 2,
                newVersion: 3,
                oldEd25519PublicKey: h.keys[1]!.publicKey.ed25519PublicKey,
                oldMlDsaPublicKey: h.keys[1]!.publicKey.mlDsaPublicKey,
                newEd25519PublicKey: three.ed25519PublicKey,
                newMlDsaPublicKey: three.mlDsaPublicKey,
                lastRosterVersion: 1,
                lastRosterDigest: await rosterDigest(h.rosters[0]!.statement),
            }),
            h.keys[1]!,
            organizer,
        );
        cases.push({
            name: 'succession-tied-before-its-key',
            input: {
                ...fromOne(h),
                rosters: h.rosters.slice(0, 2),
                successions: [...h.successions, early],
            },
            expected: accepted(2),
        });
        const two = await acceptedTo(h, 2, everyone);
        cases.push({
            name: 'cache-other-first-keys',
            input: {
                ...fromOne(h),
                cache: two.cache,
                rosters: [h.rosters[2]!],
                firstKeys: serverKey.publicKey,
            },
            expected: refused,
        });
        const other2 = await signRoster(
            {
                ...h.statements[1]!,
                members: sortedMembers([owner, adult.entry([]), outsider.entry([], 2)]),
            },
            h.keys[0]!,
            organizer.signer,
        );
        cases.push({
            name: 'cache-other-statement',
            input: {
                ...fromOne(h),
                cache: { ...two.cache, statement: encode(other2.statement) },
                rosters: [],
            },
            expected: refused,
        });
        const asOrg = await signRoster(
            { ...h.statements[1]!, kind: 'org' },
            h.keys[0]!,
            organizer.signer,
        );
        cases.push({
            name: 'kind-changes',
            input: { ...fromOne(h), rosters: [h.rosters[0]!, asOrg], successions: [] },
            expected: refused,
        });
        // The real succession, naming another key as the one it replaces.
        const misnamed = await signedBy(
            groupSuccessionStatement({
                ...real,
                oldEd25519PublicKey: serverKey.publicKey.ed25519PublicKey,
                oldMlDsaPublicKey: serverKey.publicKey.mlDsaPublicKey,
            }),
            h.keys[0]!,
            organizer,
        );
        cases.push({
            name: 'succession-names-other-old-key',
            input: { ...fromOne(h), successions: [misnamed] },
            expected: refused,
        });
        // The real succession, signed by this group's key and holder, but for another group.
        const elsewhereGroup = await signedBy(
            groupSuccessionStatement({ ...real, groupId: OTHER_GROUP }),
            h.keys[0]!,
            organizer,
        );
        cases.push({
            name: 'succession-for-other-group',
            input: { ...fromOne(h), successions: [elsewhereGroup] },
            expected: refused,
        });
        // Two of the person's pins naming other version 1 keys: the warning, marks only.
        cases.push({
            name: 'pins-other-first-keys',
            input: {
                ...fromOne(h),
                pins: [
                    pin2,
                    {
                        ...pin2,
                        firstEd25519PublicKey: serverKey.publicKey.ed25519PublicKey,
                        firstMlDsaPublicKeyDigest: await digest(
                            decode(serverKey.publicKey.mlDsaPublicKey),
                        ),
                    },
                ],
            },
            expected: fork('group-key', 1),
        });
        // A pin past a succession the server now leaves out: the group key rolled back.
        const held = await pinAfter(
            [],
            await acceptedOf(h, everyone, { rosters: h.rosters.slice(0, 2) }),
            CHECKED,
        );
        cases.push({
            name: 'group-key-rollback',
            input: {
                ...fromOne(h),
                pins: [held],
                firstKeysChecked: false,
                rosters: h.rosters.slice(0, 2),
                successions: [],
            },
            expected: refused,
        });
    }
    // The sole signer's Ed25519 key beside someone else's ML-DSA key, served as theirs; and a
    // "succession" signed the same way, from the adult's keys with another ML-DSA key.
    {
        const h = await history();
        await h.roster(organizer, [owner, adult.entry([])]);
        await h.roster(organizer, [owner, adult.entry(['billing'])]);
        const forger = {
            signingKey: organizer.signer.signingKey,
            mlDsaSecretKey: outsider.signer.mlDsaSecretKey,
        };
        const forged = await Promise.all(
            h.rosters.map(async (r) => ({
                ...r,
                signerSignature: await signHybrid(r.statement, forger),
            })),
        );
        cases.push({
            name: 'signer-ml-dsa-substituted-sole',
            input: {
                ...fromOne(h),
                rosters: forged,
                mlDsaKeys: { [organizer.mlDsaDigest]: outsider.served.mlDsaPublicKey },
            },
            expected: refused,
        });
        const fields = {
            oldKeyVersion: 1,
            newKeyVersion: 2,
            oldEncryptionPublicKey: adult.served.encryptionPublicKey,
            oldSigningPublicKey: adult.served.signingPublicKey,
            oldMlDsaPublicKey: outsider.served.mlDsaPublicKey,
            newEncryptionPublicKey: outsider.served.encryptionPublicKey,
            newSigningPublicKey: outsider.served.signingPublicKey,
            newMlDsaPublicKey: outsider.served.mlDsaPublicKey,
            newKemPublicKey: outsider.served.kemPublicKey,
        };
        const halfForged = {
            ...fields,
            signature: encode(
                await signHybrid(await successionStatement({ ...fields, userId: adult.userId }), {
                    signingKey: adult.signer.signingKey,
                    mlDsaSecretKey: outsider.signer.mlDsaSecretKey,
                }),
            ),
        };
        cases.push({
            name: 'chain-start-ml-dsa-substituted',
            input: fromOne(h),
            record: {
                writerUserId: adult.userId,
                signature: encode(await recordSignature(outsider.signer.signingKey)),
                pinned: null,
                served: { ...servedKeysOf(outsider), keyVersion: 2 },
                links: [halfForged],
            },
            expected: reads('bad-signature', null, 2),
        });
        // A record of the adult's in a workspace that is not one of the group's areas: the roster
        // says nothing there.
        const outside = { ...RECORD, workspaceId: OTHER_AREA };
        cases.push({
            name: 'record-outside-areas',
            input: fromOne(h),
            record: {
                writerUserId: adult.userId,
                signature: encode(
                    await signStatement(
                        await metadataStatement(outside, ENVELOPE),
                        adult.signer.signingKey,
                    ),
                ),
                pinned: null,
                served: servedKeysOf(adult),
                links: [],
                workspaceId: OTHER_AREA,
            },
            expected: reads('unknown-signer', null, 2),
        });
    }
    // r7: a member's identity forked (two successions they signed from one key), and a pin at
    // their newer identity.
    {
        const h = await history();
        await h.roster(organizer, [owner, child.entry([])]);
        const { next: child2, link } = await succeed(child);
        const other = await person(4, 4);
        const dangling = await linkBetween(child, other);
        const probe = {
            writerUserId: child.userId,
            signature: encode(await recordSignature(child2.signer.signingKey)),
            pinned: null,
            served: servedKeysOf(child2),
            links: [dangling, link],
        };
        cases.push({
            name: 'identity-fork',
            input: fromOne(h),
            record: probe,
            expected: reads('unchecked', null, 1),
        });
        cases.push({
            name: 'identity-fork-pinned',
            input: fromOne(h),
            record: { ...probe, pinned: await child.pinned(), links: [link, dangling] },
            expected: reads('unchecked', null, 1),
        });
        cases.push({
            name: 'pinned-newer-identity',
            input: fromOne(h),
            record: {
                ...probe,
                signature: encode(await recordSignature(child.signer.signingKey)),
                pinned: await child2.pinned(),
                links: [link],
            },
            expected: reads('retired-key', null, 1),
        });
    }
    // r10 (Opus 6, Fable 4): a roster carries only the areas it creates or rotates: a new area at
    // version 1, a rotation one above the area's latest version on the chain. A rotation and a new
    // area are accepted; a row at a version already listed, a version skipped, or a new area (or a
    // first roster's area) above 1 is refused.
    {
        const standard = await standardAreas();
        const row = async (id: string, version: number, seed: number) => ({
            workspaceId: id,
            workspaceKeyVersion: version,
            commitment: await areaKeyCommitment(pattern(32, seed)),
        });
        const members = [owner, adult.entry(['members'])];
        const after = async (name: string, areas: RosterArea[], expected: CaseVerdict) => {
            const h = await history();
            await h.roster(organizer, members, 1, [...standard, await row(SECOND_AREA, 1, 79)]);
            await h.roster(adult, members, 1, areas);
            cases.push({ name, input: fromOne(h), expected });
        };
        await after(
            'areas-added',
            [await row(AREA, 2, 78), await row(THIRD_AREA, 1, 81)],
            accepted(2),
        );
        await after('areas-row-repeated', [...standard], refused);
        await after('areas-version-skipped', [await row(AREA, 3, 78)], refused);
        await after('areas-new-above-one', [await row(THIRD_AREA, 2, 81)], refused);
        // r12: a commitment depends on the key alone, so acceptance refuses a key used before, from
        // any client: a rotation to the area's own key (a no-op), to another area's key, or one key
        // for two areas.
        await after('areas-noop-rotation', [await row(AREA, 2, AREA_KEY_SEED)], refused);
        await after('areas-key-from-another-area', [await row(AREA, 2, 79)], refused);
        await after(
            'areas-same-key-twice',
            [await row(AREA, 2, 90), await row(THIRD_AREA, 1, 90)],
            refused,
        );
        const first = await history();
        await first.roster(organizer, members, 1, [await row(AREA, 2, 78)]);
        cases.push({
            name: 'areas-first-roster-above-one',
            input: fromOne(first),
            expected: refused,
        });
    }
    // r10 (Fable 1 = Opus 5): in a family a roster that marks anyone left rotates every area in the
    // same statement (the history rotates them by default); without, or with some areas unrotated,
    // it is refused. A company's removal is not held to it (its rosters do not say who opens what).
    // And no roster both removes a members holder and admits anyone.
    {
        const removal = async (
            name: string,
            kind: 'family' | 'org',
            areas: RosterArea[] | undefined,
            expected: CaseVerdict,
        ) => {
            const h = await history(kind);
            await h.roster(organizer, [owner, adult.entry([]), child.entry([])], 1, [
                ...(await standardAreas()),
                {
                    workspaceId: SECOND_AREA,
                    workspaceKeyVersion: 1,
                    commitment: await areaKeyCommitment(areaKeyAt(SECOND_AREA, 1)),
                },
            ]);
            await h.roster(
                organizer,
                [owner, adult.entry([], 1, 'left'), child.entry([])],
                1,
                areas,
            );
            cases.push({ name, input: fromOne(h), expected });
        };
        await removal('removal-rotates-every-area', 'family', undefined, accepted(2));
        await removal('removal-without-rotation', 'family', [], refused);
        await removal(
            'removal-rotates-some-areas',
            'family',
            [
                {
                    workspaceId: AREA,
                    workspaceKeyVersion: 2,
                    commitment: await areaKeyCommitment(areaKeyAt(AREA, 2)),
                },
            ],
            refused,
        );
        await removal('org-removal-without-rotation', 'org', [], accepted(2));
        const both = await history();
        await both.roster(organizer, [owner, holder.entry(['members'])]);
        await both.roster(organizer, [
            owner,
            holder.entry(['members'], 1, 'left'),
            child.entry([]),
        ]);
        cases.push({
            name: 'admission-on-holder-removal',
            input: fromOne(both),
            expected: refused,
        });
    }
    // r11 (Fable 1): the signer stays active on the roster they sign (a holder's departure, with
    // its rotations, is another holder's to sign), and a roster keeps an active members holder.
    {
        const self = await history();
        await self.roster(organizer, [owner, adult.entry(['members']), child.entry([])]);
        await self.roster(adult, [owner, adult.entry(['members'], 1, 'left'), child.entry([])]);
        cases.push({ name: 'signer-left-on-own-roster', input: fromOne(self), expected: refused });
        const last = await history();
        await last.roster(organizer, [owner, adult.entry(['members'])]);
        await last.roster(adult, [
            organizer.entry(['billing', 'guardian', 'members'], 1, 'left'),
            adult.entry([]),
        ]);
        cases.push({ name: 'last-holder-leaves', input: fromOne(last), expected: refused });
    }
    // r9: a reader who pinned the adult's first keys, the adult's entry now their next identity,
    // and the one link between them on its version 2 signature alone. The first keys' walk asks
    // consent of it (and refuses it); the pin's walk takes the version 2 signature: the verdict is
    // the roster's, never a key conflict. One cache serves both walks, keyed by the proof.
    {
        const h = await history();
        await h.roster(organizer, [owner, adult.entry([])]);
        const { next: adult2, link } = await succeed(adult);
        await h.roster(organizer, [owner, adult2.entry([])]);
        const { consent: _, ...oneSided } = link;
        cases.push({
            name: 'one-sided-first-link-pinned',
            input: fromOne(h),
            record: {
                writerUserId: adult.userId,
                signature: encode(await recordSignature(adult2.signer.signingKey)),
                pinned: await adult.pinned(),
                served: servedKeysOf(adult2),
                links: [oneSided],
            },
            expected: reads('verified', GROUP, 2),
        });
    }
    // r9 (Codex 2): two links whose fields, joined with "|", would read alike (the first's
    // signature "x|y", the second's KEM key ending "|x" with signature "y"), both carrying the
    // first's consent. Only the first holds, so the walk from the first keys reaches the entry
    // and the adult's first key reads retired; a verification cache that confused the two would
    // see a fork there instead.
    {
        const h = await history();
        await h.roster(organizer, [owner, adult.entry([])]);
        const { next: adult2, link } = await succeed(adult);
        await h.roster(organizer, [owner, adult2.entry([])]);
        cases.push({
            name: 'cache-key-collision',
            input: fromOne(h),
            record: {
                writerUserId: adult.userId,
                signature: encode(await recordSignature(adult.signer.signingKey)),
                pinned: null,
                served: servedKeysOf(adult2),
                links: [
                    { ...link, signature: 'x|y' },
                    { ...link, newKemPublicKey: `${link.newKemPublicKey}|x`, signature: 'y' },
                ],
            },
            expected: reads('retired-key', null, 2),
        });
    }
    // r7: the group walk keeps the strict verifier's rules on versions and served keys, passes
    // over unsigned links, and retires from a pin older than the member's first keys.
    {
        const h = await history();
        await h.roster(organizer, [owner, child.entry([])]);
        const { next: child2, link } = await succeed(child);
        const { next: child3, link: link23 } = await succeed(child2);
        const probe = {
            writerUserId: child.userId,
            signature: encode(await recordSignature(child2.signer.signingKey)),
            pinned: null,
            served: servedKeysOf(child2),
            links: [link],
        };
        cases.push({
            name: 'served-kem-substituted',
            input: fromOne(h),
            record: {
                ...probe,
                served: { ...servedKeysOf(child2), kemPublicKey: outsider.served.kemPublicKey },
            },
            expected: reads('bad-signature', null, 1),
        });
        cases.push({
            name: 'served-version-below-path',
            input: fromOne(h),
            // r8: the served version is not signed, so it decides nothing.
            record: { ...probe, served: { ...servedKeysOf(child2), keyVersion: 1 } },
            expected: reads('verified', GROUP, 1),
        });
        // r8: served as child2 while the child's own link to child3 is served too: the server
        // rolled the identity back. Unchecked, never verified under child2 nor bad under child3.
        cases.push({
            name: 'served-rolled-back',
            input: fromOne(h),
            record: { ...probe, links: [link, link23] },
            expected: reads('unchecked', null, 1),
        });
        cases.push({
            name: 'served-rolled-back-newer-record',
            input: fromOne(h),
            record: {
                ...probe,
                signature: encode(await recordSignature(child3.signer.signingKey)),
                links: [link, link23],
            },
            expected: reads('unchecked', null, 1),
        });
        cases.push({
            name: 'link-version-falls',
            input: fromOne(h),
            record: {
                ...probe,
                signature: encode(await recordSignature(child3.signer.signingKey)),
                served: servedKeysOf(child3),
                links: [
                    link,
                    await linkBetween(child2, child3, (f) => ({ ...f, oldKeyVersion: 1 })),
                ],
            },
            expected: reads('bad-signature', null, 1),
        });
        const unsigned = {
            ...link,
            newEncryptionPublicKey: outsider.served.encryptionPublicKey,
            newSigningPublicKey: outsider.served.signingPublicKey,
            newMlDsaPublicKey: outsider.served.mlDsaPublicKey,
            newKemPublicKey: outsider.served.kemPublicKey,
            signature: encode(new Uint8Array(3373)),
        };
        cases.push({
            name: 'unsigned-continuing-link-first',
            input: fromOne(h),
            record: { ...probe, links: [unsigned, link] },
            expected: reads('verified', GROUP, 1),
        });
        const later = await history();
        await later.roster(organizer, [owner, child2.entry([])]);
        cases.push({
            name: 'pin-older-than-first-keys',
            input: fromOne(later),
            record: {
                ...probe,
                signature: encode(await recordSignature(child.signer.signingKey)),
                pinned: await child.pinned(),
                served: servedKeysOf(child3),
                links: [link, link23],
            },
            expected: reads('retired-key', null, 1),
        });
        // r8: a reader pinned at the child's first identity, the entry already their second, the
        // second served at a version the server made up: the pin follows the chain, no conflict.
        cases.push({
            name: 'unsigned-version-no-conflict',
            input: fromOne(later),
            record: {
                ...probe,
                pinned: await child.pinned(),
                served: { ...servedKeysOf(child2), keyVersion: 3 },
                links: [link],
            },
            expected: reads('verified', GROUP, 1),
        });
    }
    return cases;
}

/*
 * The shipped strict verifier both twins keep for personal pins
 * (verifySuccessionChain): the chain is every link from the first one at the
 * pinned keys to the end of the list, in the order served. Junk before it is
 * skipped; junk after it, or the links out of order, and it does not hold.
 */
/* A link from `who`'s X25519 and Ed25519 keys, naming `to`'s ML-DSA key as the old one, to `to`'s keys. */
async function otherMlDsaLink(who: Person, to: Person): Promise<SuccessionLink> {
    const fields = {
        oldKeyVersion: 1,
        newKeyVersion: 2,
        oldEncryptionPublicKey: who.served.encryptionPublicKey,
        oldSigningPublicKey: who.served.signingPublicKey,
        oldMlDsaPublicKey: to.served.mlDsaPublicKey,
        newEncryptionPublicKey: to.served.encryptionPublicKey,
        newSigningPublicKey: to.served.signingPublicKey,
        newMlDsaPublicKey: to.served.mlDsaPublicKey,
        newKemPublicKey: to.served.kemPublicKey,
    };
    const signature = await signHybrid(
        await successionStatement({ ...fields, userId: who.userId }),
        {
            signingKey: who.signer.signingKey,
            mlDsaSecretKey: to.signer.mlDsaSecretKey,
        },
    );
    return { ...fields, signature: encode(signature) };
}

export async function chainCases() {
    const member = await person(4);
    const { next: second, link: first } = await succeed(member);
    const { next: third, link: next } = await succeed(second);
    const stranger = await person(5);
    const junk = { ...next, oldSigningPublicKey: stranger.served.signingPublicKey };
    const base = {
        userId: member.userId,
        pinned: await member.pinned(),
        served: servedKeysOf(third),
    };
    return [
        { ...base, name: 'chain-holds', links: [first, next], expected: true },
        { ...base, name: 'chain-junk-before', links: [junk, first, next], expected: true },
        { ...base, name: 'chain-junk-after', links: [first, next, junk], expected: false },
        // F1: personal shares keep the one-sided links every shipped client signed: links with
        // no consent hold on the personal chain the group walk refuses them on.
        {
            ...base,
            name: 'chain-one-sided',
            links: [first, next].map((link) => {
                const { consent: _, ...oneSided } = link;
                return oneSided;
            }),
            expected: true,
        },
        { ...base, name: 'chain-out-of-order', links: [next, first], expected: false },
        // The pin's X25519 and Ed25519 keys with another ML-DSA key, signed with that key's half.
        {
            ...base,
            name: 'chain-start-other-ml-dsa',
            served: { ...servedKeysOf(stranger), keyVersion: 2 },
            links: [await otherMlDsaLink(member, stranger)],
            expected: false,
        },
        // r8: a link signed over a statement whose new version is 2^53, beyond the safe integers
        // both twins bound key versions to (signed by hand: no builder makes such a statement).
        {
            ...base,
            name: 'chain-version-beyond-safe',
            served: { ...servedKeysOf(second), keyVersion: 2 ** 53 },
            links: [await beyondSafeLink(member, second)],
            expected: false,
        },
    ];
}

/*
 * Raw bytes against the statement grammar (design 2.1), the same list in both
 * twins: each judges the other's with its own parser.
 */
export function statementCases() {
    const text = (s: string) => new TextEncoder().encode(s);
    const list: [string, Uint8Array, boolean][] = [
        ['plain', text('["a",1,[2,["b"]]]'), true],
        ['largest-safe-integer', text('[9007199254740991]'), true],
        ['four-deep', text('[[[["a"]]]]'), true],
        ['five-deep', text('[[[[["a"]]]]]'), false],
        ['byte-order-mark', Uint8Array.from([0xef, 0xbb, 0xbf, ...text('[]')]), false],
        ['lone-surrogate', text('["\\ud800"]'), false],
        ['escape', text('["a\\"b"]'), false],
        ['non-ascii', text('["\u00e9"]'), false],
        ['beyond-safe-integer', text('[9007199254740993]'), false],
        ['float', text('[1.0]'), false],
        ['negative-zero', text('[-0]'), false],
        ['negative', text('[-1]'), false],
        ['exponent', text('[1e0]'), false],
        ['object', text('[{}]'), false],
        ['boolean', text('[true]'), false],
        ['null', text('[null]'), false],
        ['whitespace', text('[ 1]'), false],
        ['not-an-array', text('"a"'), false],
    ];
    return list.map(([name, bytes, expected]) => ({ name, statement: encode(bytes), expected }));
}

/* Whether this twin's parser takes a statement's bytes. */
export function statementVerdict(statement: string) {
    try {
        parseStatement(decode(statement), 'statement');
        return true;
    } catch {
        return false;
    }
}

/* A link from `who` to `next` at new key version 2^53, signed over the raw statement by `who`. */
async function beyondSafeLink(who: Person, next: Person): Promise<SuccessionLink> {
    const fields = {
        oldKeyVersion: who.keyVersion,
        newKeyVersion: 2 ** 53,
        oldEncryptionPublicKey: who.served.encryptionPublicKey,
        oldSigningPublicKey: who.served.signingPublicKey,
        oldMlDsaPublicKey: who.served.mlDsaPublicKey,
        newEncryptionPublicKey: next.served.encryptionPublicKey,
        newSigningPublicKey: next.served.signingPublicKey,
        newMlDsaPublicKey: next.served.mlDsaPublicKey,
        newKemPublicKey: next.served.kemPublicKey,
    };
    const statement = new TextEncoder().encode(
        JSON.stringify([
            'hushos/identity/succession',
            2,
            who.userId,
            fields.oldKeyVersion,
            fields.newKeyVersion,
            fields.oldEncryptionPublicKey,
            fields.oldSigningPublicKey,
            fields.oldMlDsaPublicKey,
            fields.newEncryptionPublicKey,
            fields.newSigningPublicKey,
            fields.newMlDsaPublicKey,
            await digest(decode(fields.newKemPublicKey)),
        ]),
    );
    return { ...fields, signature: encode(await signHybrid(statement, who.signer)) };
}

/*
 * What acceptRosters says of a case, in full: for an accepted chain every
 * field a twin must agree on (the latest roster, whether it dropped a holder
 * and a succession is due, the group key's digest, the creator, the reader's
 * wrong entries, every member's key history, the dead branches, the cache to
 * keep, and when asked the record's verdict and the next statement's), or a
 * fork with every side, or a refusal.
 */
export async function verdictOf(
    input: AcceptInput,
    record?: RecordProbe,
    next?: NextProbe,
): Promise<Record<string, unknown>> {
    try {
        const chain = await acceptRosters(input);
        if (chain.status !== 'accepted') return { ...chain };
        return {
            status: 'accepted',
            rosterVersion: chain.roster.rosterVersion,
            droppedHolder: chain.droppedHolder,
            successionDue: chain.successionDue,
            groupKeyDigest: chain.groupKeyDigest,
            creatorUserId: chain.creatorUserId,
            ownEntryWrongAt: chain.ownEntryWrongAt,
            ownEntryBehindAt: chain.ownEntryBehindAt,
            keyHistory: chain.keyHistory,
            deadBranches: chain.deadBranches,
            cache: chain.cache,
            ...(record ? { record: await recordVerdict(chain, record) } : {}),
            ...(next ? { next: await nextVerdict(chain, next, input.mlDsaKeys) } : {}),
        };
    } catch (error) {
        if (error instanceof Error && error.name === 'CryptoError') return { status: 'refused' };
        throw error;
    }
}

/* Whether a full verdict says what a case declares (for a fork, its kind, version and number of sides). */
export function says(verdict: Record<string, unknown>, expected: CaseVerdict) {
    return Object.entries(expected).every(([key, value]) =>
        key === 'sides'
            ? (verdict.sides as unknown[] | undefined)?.length === value
            : JSON.stringify(verdict[key]) === JSON.stringify(value),
    );
}

/*
 * Fold-ins both twins must judge alike: a member two successions ahead is
 * folded straight to their served identity; a link not signed by them moves
 * nothing; an entry at an inflated key version still follows the member's
 * chain from its keys.
 */
export async function foldInCases() {
    const adult = await person(2);
    const { next: adult2, link: first } = await succeed(adult);
    const { next: adult3, link: second } = await succeed(adult2);
    const forged = {
        ...first,
        signature: encode(new Uint8Array(decode(first.signature).length)),
        consent: encode(new Uint8Array(SUCCESSION_CONSENT_BYTES)),
    };
    // r9: a genuine link the new key never co-signed folds in on its version 2 signature.
    const { consent: _, ...oneSided } = first;
    const entry = adult.entry([], 1);
    return [
        {
            name: 'two-ahead',
            entry,
            served: adult3.served,
            links: [first, second],
            rosterVersion: 5,
        },
        { name: 'forged-link', entry, served: adult2.served, links: [forged], rosterVersion: 5 },
        {
            name: 'one-sided-link',
            entry,
            served: adult2.served,
            links: [oneSided],
            rosterVersion: 5,
        },
        {
            name: 'inflated-version',
            entry: { ...entry, keyVersion: 1000 },
            served: adult2.served,
            links: [first],
            rosterVersion: 5,
        },
    ];
}

export async function foldInVerdict(c: Awaited<ReturnType<typeof foldInCases>>[number]) {
    return foldInEntry(c.entry, c.served, c.links, c.rosterVersion);
}

/*
 * First rosters both twins must build to the same bytes, or refuse alike
 * (firstRoster, roster_first): the creator's entry normalized (roles sorted,
 * sinceVersion 1), rows computed from the keys and sorted, and every rule
 * acceptance holds roster version 1 to. `expected` is the statement
 * (base64url), or null for a refusal.
 */
export type FirstRosterCase = {
    name: string;
    groupId: string;
    kind: GroupKind;
    creator: RosterMember;
    areaKeys: { workspaceId: string; workspaceKey: string }[];
    expected: string | null;
};

export async function firstRosterCases(): Promise<Omit<FirstRosterCase, 'expected'>[]> {
    const organizer = await person(1);
    const key = (workspaceId: string, seed: number, length = 32) => ({
        workspaceId,
        workspaceKey: encode(pattern(length, seed)),
    });
    const of = (
        name: string,
        creator: RosterMember,
        areaKeys: { workspaceId: string; workspaceKey: string }[],
        kind: GroupKind = 'family',
        groupId = GROUP,
    ) => ({ name, groupId, kind, creator, areaKeys });
    return [
        // Roles out of order and a stale sinceVersion: firstRoster sets both.
        of('first-roster', { ...organizer.entry(['members', 'billing']), sinceVersion: 7 }, [
            key(AREA, AREA_KEY_SEED),
        ]),
        of('first-roster-no-areas', organizer.entry(['billing', 'members']), []),
        of('first-roster-two-areas', organizer.entry(['members']), [
            key(SECOND_AREA, 101),
            key(AREA, AREA_KEY_SEED),
        ]),
        of(
            'first-roster-org',
            organizer.entry(['data_admin', 'members']),
            [key(AREA, AREA_KEY_SEED)],
            'org',
        ),
        of('first-roster-not-holder', organizer.entry(['billing']), [key(AREA, AREA_KEY_SEED)]),
        of('first-roster-left', organizer.entry(['members'], 1, 'left'), [
            key(AREA, AREA_KEY_SEED),
        ]),
        of('first-roster-same-key-twice', organizer.entry(['members']), [
            key(AREA, AREA_KEY_SEED),
            key(SECOND_AREA, AREA_KEY_SEED),
        ]),
        of('first-roster-area-twice', organizer.entry(['members']), [
            key(AREA, AREA_KEY_SEED),
            key(AREA, 78),
        ]),
        of('first-roster-org-role-in-family', organizer.entry(['data_admin', 'members']), []),
        of('first-roster-short-key', organizer.entry(['members']), [key(AREA, AREA_KEY_SEED, 31)]),
        of(
            'first-roster-uppercase-group-id',
            organizer.entry(['members']),
            [],
            'family',
            GROUP.toUpperCase(),
        ),
    ];
}

/* This twin's first roster for a case: its statement (base64url), or null when refused. */
export async function firstRosterVerdict(c: Omit<FirstRosterCase, 'expected'>) {
    try {
        const roster = await firstRoster(c.groupId, c.creator, {
            kind: c.kind,
            areaKeys: c.areaKeys.map((k) => ({
                workspaceId: k.workspaceId,
                workspaceKey: decode(k.workspaceKey),
            })),
        });
        return encode(rosterStatement(roster));
    } catch (error) {
        if (error instanceof Error && error.name === 'CryptoError') return null;
        throw error;
    }
}

/*
 * Own entries both twins must make alike, or refuse (ownRosterEntry,
 * roster_entry_own): only from an identity whose keys statement holds for the
 * account. `expected` is the entry, or null for a refusal.
 */
export type OwnEntryCase = {
    name: string;
    userId: string;
    identity: ServedIdentity;
    roles: GroupRole[];
    expected: RosterMember | null;
};

export async function ownEntryCases(): Promise<Omit<OwnEntryCase, 'expected'>[]> {
    const [organizer, adult, adult2] = [await person(1), await person(2), await person(2, 2)];
    const of = (name: string, userId: string, identity: ServedIdentity) => ({
        name,
        userId,
        identity,
        roles: ['members', 'billing'] as GroupRole[],
    });
    return [
        of('own-entry', organizer.userId, organizer.served),
        of('own-entry-later-identity', adult2.userId, adult2.served),
        of('own-entry-other-account', adult.userId, organizer.served),
        of('own-entry-kem-swapped', organizer.userId, {
            ...organizer.served,
            kemPublicKey: adult.served.kemPublicKey,
        }),
        of('own-entry-another-keys-signature', organizer.userId, {
            ...organizer.served,
            keysSignature: adult.served.keysSignature,
        }),
        // A key version the keys statement never named.
        of('own-entry-key-version', organizer.userId, { ...organizer.served, keyVersion: 2 }),
        // The adult's replaced identity: its keys statement still holds, so an entry is made; that
        // it is not their newest is the signer check's and the creating client's to catch.
        of('own-entry-earlier-identity', adult.userId, adult.served),
    ];
}

/* This twin's own entry for a case, or null when refused. */
export async function ownEntryVerdict(c: Omit<OwnEntryCase, 'expected'>) {
    try {
        return await ownRosterEntry(c.userId, c.identity, { roles: c.roles });
    } catch (error) {
        if (error instanceof Error && error.name === 'CryptoError') return null;
        throw error;
    }
}

/*
 * Seals both twins make and must open, or refuse, alike: the two openers,
 * the sealer's history (a seal from before their identity was folded in, or
 * under their entry's keys after they moved on; never one under keys no roster
 * has folded in yet), and the keys that must never open one (a planted key
 * with its planter's link). Each case carries the chain to accept, the
 * envelope and what its opener is given; `reader` names whose secrets open it
 * and `claim` who the opener is told the reader is.
 */
export type SealCase = {
    name: string;
    kind: 'key' | 'grant';
    rosters: SignedGroupStatement[];
    mlDsaKeys: Record<string, string>;
    ctx: GroupKeySealContext | AreaGrantContext;
    envelope: Uint8Array;
    signerMlDsaPublicKey: string;
    history: { served: ServedKeys; links: SuccessionLink[] } | null;
    reader: { n: number; keyVersion: number };
    claim: { userId: string; keyVersion: number };
    expected: string;
};

export async function sealCases(): Promise<SealCase[]> {
    const [o, a, g, child] = (await Promise.all([1, 2, 3].map((n) => person(n)))).concat([
        await person(4, 2),
    ]) as [Person, Person, Person, Person];
    const planted = await person(9);
    const owner = o.entry(['billing', 'guardian', 'members']);
    const seed = pattern(64, 91);
    const workspaceKey = pattern(32, 77);
    const cases: SealCase[] = [];
    // Each seal names the sealer's latest accepted roster, `at`.
    const keyCtx = (holder: Person, sealer: Person, at: AcceptedRosters): GroupKeySealContext => ({
        groupId: GROUP,
        groupKeyVersion: 1,
        holderUserId: holder.userId,
        holderKeyVersion: 1,
        sealerUserId: sealer.userId,
        rosterVersion: at.roster.rosterVersion,
        rosterDigest: at.rosterDigest,
    });
    const push = (c: Omit<SealCase, 'claim'> & Partial<Pick<SealCase, 'claim'>>) =>
        cases.push({
            claim: { userId: userIdOf(c.reader.n), keyVersion: c.reader.keyVersion },
            ...c,
        });

    // A family at 1: the organizer, a `members` adult, a guardian, a child.
    const h = await history();
    await h.roster(o, [owner, a.entry(['members']), g.entry(['guardian']), child.entry([])]);
    const one = await acceptedOf(h, [o]);
    const keys1 = mlDsaKeysOf(o, a, g, child);
    const base = { rosters: [...h.rosters], mlDsaKeys: keys1, history: null };
    const keySeal = await sealGroupKey(seed, keyCtx(a, o, one), {
        chain: one,
        holderKemPublicKey: a.kemPublicKey,
        sealer: o.signer,
    });
    push({
        ...base,
        name: 'key-opens',
        kind: 'key',
        ctx: keyCtx(a, o, one),
        envelope: keySeal,
        signerMlDsaPublicKey: o.served.mlDsaPublicKey,
        reader: { n: 2, keyVersion: 1 },
        expected: encode(seed),
    });
    push({
        ...base,
        name: 'key-other-reader-version',
        kind: 'key',
        ctx: keyCtx(a, o, one),
        envelope: keySeal,
        signerMlDsaPublicKey: o.served.mlDsaPublicKey,
        reader: { n: 2, keyVersion: 1 },
        claim: { userId: a.userId, keyVersion: 2 },
        expected: 'refused',
    });
    push({
        ...base,
        name: 'key-seed-not-published',
        kind: 'key',
        ctx: keyCtx(a, o, one),
        envelope: await sealGroupKey(pattern(64, 5), keyCtx(a, o, one), {
            chain: one,
            holderKemPublicKey: a.kemPublicKey,
            sealer: o.signer,
        }),
        signerMlDsaPublicKey: o.served.mlDsaPublicKey,
        reader: { n: 2, keyVersion: 1 },
        expected: 'refused',
    });
    // g held `members` at 2 and sealed there; 3 takes the role away. Not theirs to hand out now.
    {
        const held = await history();
        const asOne = [owner, a.entry(['members']), g.entry(['guardian']), child.entry([])];
        await held.roster(o, asOne);
        await held.roster(o, [
            owner,
            a.entry(['members']),
            g.entry(['guardian', 'members']),
            child.entry([]),
        ]);
        const atTwo = await acceptedOf(held, [o]);
        const byG = await sealGroupKey(seed, keyCtx(a, g, atTwo), {
            chain: atTwo,
            holderKemPublicKey: a.kemPublicKey,
            sealer: g.signer,
        });
        await held.roster(o, asOne);
        push({
            rosters: [...held.rosters],
            mlDsaKeys: keys1,
            history: null,
            name: 'key-sealer-not-holder',
            kind: 'key',
            ctx: keyCtx(a, g, atTwo),
            envelope: byG,
            signerMlDsaPublicKey: g.served.mlDsaPublicKey,
            reader: { n: 2, keyVersion: 1 },
            expected: 'refused',
        });
    }
    const grantCtx: AreaGrantContext = {
        groupId: GROUP,
        workspaceId: AREA,
        workspaceKeyVersion: 1,
        granteeUserId: g.userId,
        granteeKeyVersion: 1,
        granterUserId: a.userId,
        rosterVersion: one.roster.rosterVersion,
        rosterDigest: one.rosterDigest,
    };
    const grant = await sealAreaGrant(workspaceKey, grantCtx, {
        chain: one,
        areaIdSeed: AREA_SEED,
        granteeKemPublicKey: g.kemPublicKey,
        granter: a.signer,
    });
    push({
        ...base,
        name: 'grant-opens',
        kind: 'grant',
        ctx: grantCtx,
        envelope: grant,
        signerMlDsaPublicKey: a.served.mlDsaPublicKey,
        reader: { n: 3, keyVersion: 1 },
        expected: encode(workspaceKey),
    });
    // At 2 the adult has left: their grant no longer opens.
    await h.roster(o, [owner, a.entry(['members'], 2, 'left'), g.entry([]), child.entry([])]);
    const two = { rosters: [...h.rosters], mlDsaKeys: keys1, history: null };
    push({
        ...two,
        name: 'grant-from-left-granter',
        kind: 'grant',
        ctx: grantCtx,
        envelope: grant,
        signerMlDsaPublicKey: a.served.mlDsaPublicKey,
        reader: { n: 3, keyVersion: 1 },
        expected: 'refused',
    });

    // The adult seals while a holder, then their next identity is folded in at 2.
    const { next: a2, link } = await succeed(a);
    const f = await history();
    await f.roster(o, [owner, a.entry(['members'])]);
    const before = await acceptedOf(f, [o, a]);
    const folded = await sealGroupKey(seed, keyCtx(o, a, before), {
        chain: before,
        holderKemPublicKey: o.kemPublicKey,
        sealer: a.signer,
    });
    await f.roster(o, [owner, a2.entry(['members'])]);
    const after = { rosters: [...f.rosters], mlDsaKeys: mlDsaKeysOf(o, a, a2) };
    const aHistory = { served: servedKeysOf(a2), links: [link] };
    const junkLink = {
        ...link,
        oldEncryptionPublicKey: g.served.encryptionPublicKey,
        signature: encode(new Uint8Array(3373)),
    };
    const opener = {
        kind: 'key' as const,
        ctx: keyCtx(o, a, before),
        envelope: folded,
        signerMlDsaPublicKey: a2.served.mlDsaPublicKey,
        reader: { n: 1, keyVersion: 1 },
    };
    push({
        ...after,
        ...opener,
        name: 'folded-sealer-opens',
        history: aHistory,
        expected: encode(seed),
    });
    push({
        ...after,
        ...opener,
        name: 'folded-sealer-needs-history',
        history: null,
        expected: 'refused',
    });
    push({
        ...after,
        ...opener,
        name: 'folded-sealer-junk-link',
        history: { ...aHistory, links: [junkLink, link, junkLink] },
        expected: encode(seed),
    });

    // A second successor the adult signed from the same key: a forked identity lends no history.
    const twin = await person(2, 4);
    const twinLink = await linkBetween(a, twin);
    push({
        ...after,
        ...opener,
        name: 'folded-sealer-forked',
        history: { ...aHistory, links: [twinLink, link] },
        expected: 'refused',
    });
    // a2 replaced in turn and not folded in. A seal under a2's keys (the entry's) still opens with
    // the served a3.
    const { next: a3, link: link23 } = await succeed(a2);
    const a3History = { served: servedKeysOf(a3), links: [link, link23] };
    const withA2 = await acceptedOf(f, [o, a, a2]);
    push({
        ...after,
        ...opener,
        name: 'entry-sealer-moved-on',
        ctx: keyCtx(o, a, withA2),
        envelope: await sealGroupKey(seed, keyCtx(o, a, withA2), {
            chain: withA2,
            holderKemPublicKey: o.kemPublicKey,
            sealer: a2.signer,
        }),
        signerMlDsaPublicKey: a3.served.mlDsaPublicKey,
        history: a3History,
        expected: encode(seed),
    });
    // r9: the seal from before the fold-in, with a2's own successor a3 served on its version 2
    // link alone: only the links before the entry's keys need consent, so it still opens.
    const { consent: _oneSidedConsent, ...oneSided23 } = link23;
    push({
        ...after,
        ...opener,
        name: 'folded-sealer-one-sided-after-entry',
        history: { served: servedKeysOf(a3), links: [link, oneSided23] },
        expected: encode(seed),
    });
    // a3 was folded in at 3 and sealed there; 4 puts a2 back. A seal under keys past the entry's
    // never opens, whether a3 is served (lagging-sealer-refused) or a4 beyond it (past-entry).
    const rolled = await history();
    await rolled.roster(o, [owner, a.entry(['members'])]);
    await rolled.roster(o, [owner, a2.entry(['members'])]);
    await rolled.roster(o, [owner, a3.entry(['members'])]);
    const withA3 = await acceptedOf(rolled, [o, a, a2, a3]);
    const byA3 = await sealGroupKey(seed, keyCtx(o, a, withA3), {
        chain: withA3,
        holderKemPublicKey: o.kemPublicKey,
        sealer: a3.signer,
    });
    await rolled.roster(o, [owner, a2.entry(['members'])]);
    const rolledBack = {
        rosters: [...rolled.rosters],
        mlDsaKeys: mlDsaKeysOf(o, a, a2, a3),
        ...opener,
        ctx: keyCtx(o, a, withA3),
        envelope: byA3,
    };
    push({
        ...rolledBack,
        name: 'lagging-sealer-refused',
        signerMlDsaPublicKey: a3.served.mlDsaPublicKey,
        history: a3History,
        expected: 'refused',
    });
    const { next: a4, link: link34 } = await succeed(a3);
    push({
        ...rolledBack,
        name: 'sealer-past-entry-refused',
        signerMlDsaPublicKey: a4.served.mlDsaPublicKey,
        history: { served: servedKeysOf(a4), links: [link, link23, link34] },
        expected: 'refused',
    });
    // While a holder's planted keys are a's entry, a's real chain never reaches it: a's own seal
    // from before does not open through it.
    const pa = await history();
    await pa.roster(o, [owner, a.entry(['members'])]);
    await pa.roster(o, [owner, { ...planted.entry(['members']), userId: a.userId }]);
    push({
        ...opener,
        rosters: [...pa.rosters],
        mlDsaKeys: mlDsaKeysOf(o, a, planted),
        name: 'planted-entry-lends-no-history',
        history: aHistory,
        expected: 'refused',
    });

    // The organizer replaced their identity, a roster folded it in at 2 and they sealed there; 3
    // puts the old keys back. The new keys open nothing while the entry names the old.
    const { next: o2, link: oLink } = await succeed(o);
    const r = await history();
    await r.roster(o, [owner, g.entry(['members'])]);
    await r.roster(o, [o2.entry(['billing', 'guardian', 'members']), g.entry(['members'])]);
    const withO2 = await acceptedOf(r, [o, o2, g]);
    const byO2 = await sealGroupKey(seed, keyCtx(g, o, withO2), {
        chain: withO2,
        holderKemPublicKey: g.kemPublicKey,
        sealer: o2.signer,
    });
    await r.roster(o2, [owner, g.entry(['members'])]);
    push({
        rosters: [...r.rosters],
        mlDsaKeys: mlDsaKeysOf(o, o2, g),
        name: 'replaced-sealer-not-folded-in',
        kind: 'key',
        ctx: keyCtx(g, o, withO2),
        envelope: byO2,
        signerMlDsaPublicKey: o2.served.mlDsaPublicKey,
        history: { served: servedKeysOf(o2), links: [oLink] },
        reader: { n: 3, keyVersion: 1 },
        expected: 'refused',
    });

    // r8 (Fable F2): the same family at 2 on the real chain and on a branch. g, active on both,
    // grants an area key on the branch: the grant names the branch roster and opens nothing on the
    // real chain; g's grant made on the real chain does. A seal from a roster the opener has not
    // reached yet opens nothing either.
    {
        const real = await history();
        await real.roster(o, [owner, a.entry(['members']), g.entry(['members'])]);
        const branch = await history();
        await branch.roster(o, [owner, a.entry(['members']), g.entry(['members'])]);
        await real.roster(o, [owner, a.entry(['members'], 1, 'left'), g.entry(['members'])]);
        await branch.roster(a, [
            owner,
            a.entry(['members']),
            g.entry(['members']),
            child.entry([]),
        ]);
        const keys = mlDsaKeysOf(o, a, g, child);
        const onBranch = await acceptedOf(branch, [o, a, g, child]);
        const onReal = await acceptedOf(real, [o, a, g]);
        const grantOn = (at: AcceptedRosters): AreaGrantContext => ({
            groupId: GROUP,
            workspaceId: AREA,
            workspaceKeyVersion: 1,
            granteeUserId: o.userId,
            granteeKeyVersion: 1,
            granterUserId: g.userId,
            rosterVersion: at.roster.rosterVersion,
            rosterDigest: at.rosterDigest,
        });
        const sealOn = (at: AcceptedRosters) =>
            sealAreaGrant(workspaceKey, grantOn(at), {
                chain: at,
                areaIdSeed: AREA_SEED,
                granteeKemPublicKey: o.kemPublicKey,
                granter: g.signer,
            });
        const asGrant = {
            rosters: [...real.rosters],
            mlDsaKeys: keys,
            kind: 'grant' as const,
            signerMlDsaPublicKey: g.served.mlDsaPublicKey,
            history: null,
            reader: { n: 1, keyVersion: 1 },
        };
        push({
            ...asGrant,
            name: 'grant-sealed-on-a-branch',
            ctx: grantOn(onBranch),
            envelope: await sealOn(onBranch),
            expected: 'refused',
        });
        push({
            ...asGrant,
            name: 'grant-sealed-on-the-chain',
            ctx: grantOn(onReal),
            envelope: await sealOn(onReal),
            expected: encode(workspaceKey),
        });
        push({
            ...asGrant,
            rosters: real.rosters.slice(0, 1),
            name: 'seal-from-a-newer-roster',
            ctx: grantOn(onReal),
            envelope: await sealOn(onReal),
            expected: 'refused',
        });
    }

    // A holder writes keys they hold into the child's entry at 2 and signs a link from them to the
    // child's real keys; the child's own entry is back at 3. A grant the planted keys made opens
    // nothing.
    const p = await history();
    await p.roster(o, [owner, g.entry(['guardian']), child.entry([])]);
    await p.roster(o, [
        owner,
        g.entry(['guardian']),
        { ...planted.entry([]), userId: child.userId },
    ]);
    const whilePlanted = await acceptedOf(p, [o, g, child, planted]);
    const plantedGrant: AreaGrantContext = {
        groupId: GROUP,
        workspaceId: AREA,
        workspaceKeyVersion: 1,
        granteeUserId: g.userId,
        granteeKeyVersion: 1,
        granterUserId: child.userId,
        rosterVersion: whilePlanted.roster.rosterVersion,
        rosterDigest: whilePlanted.rosterDigest,
    };
    await p.roster(o, [owner, g.entry(['guardian']), child.entry([], 3)]);
    const fields = {
        oldKeyVersion: 1,
        newKeyVersion: 2,
        oldEncryptionPublicKey: planted.served.encryptionPublicKey,
        oldSigningPublicKey: planted.served.signingPublicKey,
        oldMlDsaPublicKey: planted.served.mlDsaPublicKey,
        newEncryptionPublicKey: child.served.encryptionPublicKey,
        newSigningPublicKey: child.served.signingPublicKey,
        newMlDsaPublicKey: child.served.mlDsaPublicKey,
        newKemPublicKey: child.served.kemPublicKey,
    };
    // Given the child's consent as well (a test can sign it), so the case pins the first-keys
    // rule apart from the consent rule.
    const plantedLink = {
        ...fields,
        signature: encode(
            await signHybrid(
                await successionStatement({ ...fields, userId: child.userId }),
                planted.signer,
            ),
        ),
        consent: await consentOf(fields, child.userId, planted.signer, child.signer),
    };
    push({
        rosters: [...p.rosters],
        mlDsaKeys: mlDsaKeysOf(o, g, child, planted),
        name: 'planted-key-grant',
        kind: 'grant',
        ctx: plantedGrant,
        envelope: await sealAreaGrant(workspaceKey, plantedGrant, {
            chain: whilePlanted,
            areaIdSeed: AREA_SEED,
            granteeKemPublicKey: g.kemPublicKey,
            granter: planted.signer,
        }),
        signerMlDsaPublicKey: child.served.mlDsaPublicKey,
        history: { served: servedKeysOf(child), links: [plantedLink] },
        reader: { n: 3, keyVersion: 1 },
        expected: 'refused',
    });
    // F1: the planted keys are the child's FIRST entry, so the chain starts at them, and the
    // child's real keys follow at 2. A link from the planted keys the child never co-signed (all a
    // planter can serve: one-sided, or with junk for the consent) bridges nothing, and the planted
    // keys' grant opens nothing. With the child's consent, the same link carries it.
    {
        const pf = await history();
        await pf.roster(o, [
            owner,
            g.entry(['guardian']),
            { ...planted.entry([]), userId: child.userId },
        ]);
        const firstPlanted = await acceptedOf(pf, [o, g, child, planted]);
        const firstGrant: AreaGrantContext = {
            ...plantedGrant,
            rosterVersion: firstPlanted.roster.rosterVersion,
            rosterDigest: firstPlanted.rosterDigest,
        };
        await pf.roster(o, [owner, g.entry(['guardian']), child.entry([], 2)]);
        const envelope = await sealAreaGrant(workspaceKey, firstGrant, {
            chain: firstPlanted,
            areaIdSeed: AREA_SEED,
            granteeKemPublicKey: g.kemPublicKey,
            granter: planted.signer,
        });
        const { consent: _, ...oneSided } = plantedLink;
        const firstCase = {
            rosters: [...pf.rosters],
            mlDsaKeys: mlDsaKeysOf(o, g, child, planted),
            kind: 'grant' as const,
            ctx: firstGrant,
            envelope,
            signerMlDsaPublicKey: child.served.mlDsaPublicKey,
            reader: { n: 3, keyVersion: 1 },
        };
        push({
            ...firstCase,
            name: 'planted-first-key-grant',
            history: { served: servedKeysOf(child), links: [oneSided] },
            expected: 'refused',
        });
        push({
            ...firstCase,
            name: 'planted-first-key-grant-planter-consent',
            history: {
                served: servedKeysOf(child),
                links: [
                    {
                        ...oneSided,
                        consent: await consentOf(fields, child.userId, planted.signer, null),
                    },
                ],
            },
            expected: 'refused',
        });
        push({
            ...firstCase,
            name: 'planted-first-key-grant-consented',
            history: { served: servedKeysOf(child), links: [plantedLink] },
            expected: encode(workspaceKey),
        });
    }
    // r9: after AREA's rotation to version 2 (key pattern(32, 78)), a grant of version 1's key
    // (a reader needs it for older files) still opens, checked against the commitment roster 1
    // listed; version 2's opens too. Another key under either, or version 3, is never sealed
    // (sealerCases).
    {
        const r = await history();
        await r.roster(o, [owner, a.entry(['members']), g.entry([])]);
        await r.roster(o, [owner, a.entry(['members']), g.entry([])], 1, [
            {
                workspaceId: AREA,
                workspaceKeyVersion: 2,
                commitment: await areaKeyCommitment(pattern(32, 78)),
            },
        ]);
        const rotated = await acceptedOf(r, [o, a, g]);
        const ctxAt = (version: number): AreaGrantContext => ({
            groupId: GROUP,
            workspaceId: AREA,
            workspaceKeyVersion: version,
            granteeUserId: g.userId,
            granteeKeyVersion: 1,
            granterUserId: a.userId,
            rosterVersion: rotated.roster.rosterVersion,
            rosterDigest: rotated.rosterDigest,
        });
        for (const [name, version, key] of [
            ['grant-earlier-version-after-rotation', 1, workspaceKey],
            ['grant-rotated-version', 2, pattern(32, 78)],
        ] as const)
            push({
                rosters: [...r.rosters],
                mlDsaKeys: mlDsaKeysOf(o, a, g),
                history: null,
                name,
                kind: 'grant',
                ctx: ctxAt(version),
                envelope: await sealAreaGrant(key, ctxAt(version), {
                    chain: rotated,
                    areaIdSeed: AREA_SEED,
                    granteeKemPublicKey: g.kemPublicKey,
                    granter: a.signer,
                }),
                signerMlDsaPublicKey: a.served.mlDsaPublicKey,
                reader: { n: 3, keyVersion: 1 },
                expected: encode(key),
            });
    }
    // A key seal claimed by another reader than the holder it names.
    push({
        ...base,
        name: 'key-other-reader',
        kind: 'key',
        ctx: keyCtx(a, o, one),
        envelope: keySeal,
        signerMlDsaPublicKey: o.served.mlDsaPublicKey,
        reader: { n: 2, keyVersion: 1 },
        claim: { userId: o.userId, keyVersion: 1 },
        expected: 'refused',
    });
    // Keys planted as the adult's at 2 seal; the adult's real chain is served with a junk link
    // naming the planted keys beside it. Only links on the verified chain lend keys: refused.
    const q = await history();
    await q.roster(o, [owner, a.entry(['members'])]);
    await q.roster(o, [owner, { ...planted.entry(['members']), userId: a.userId }]);
    const asAdult = await acceptedOf(q, [o, a, planted]);
    await q.roster(o, [owner, a2.entry(['members'])]);
    const byPlanted = await sealGroupKey(seed, keyCtx(o, a, asAdult), {
        chain: asAdult,
        holderKemPublicKey: o.kemPublicKey,
        sealer: planted.signer,
    });
    const plantedJunk = {
        ...link,
        oldEncryptionPublicKey: planted.served.encryptionPublicKey,
        oldSigningPublicKey: planted.served.signingPublicKey,
        oldMlDsaPublicKey: planted.served.mlDsaPublicKey,
        signature: encode(new Uint8Array(3373)),
    };
    push({
        rosters: [...q.rosters],
        mlDsaKeys: mlDsaKeysOf(o, a, a2, planted),
        name: 'junk-link-names-planted-key',
        kind: 'key',
        ctx: keyCtx(o, a, asAdult),
        envelope: byPlanted,
        signerMlDsaPublicKey: a2.served.mlDsaPublicKey,
        history: { served: servedKeysOf(a2), links: [link, plantedJunk] },
        reader: { n: 1, keyVersion: 1 },
        expected: 'refused',
    });
    // The creator sealed key 1 to a, then left: their seals open nothing, key 1's included.
    const c = await history();
    await c.roster(o, [owner, a.entry(['members'])]);
    const atCreated = await acceptedOf(c, [o, a]);
    const byCreator = await sealGroupKey(seed, keyCtx(a, o, atCreated), {
        chain: atCreated,
        holderKemPublicKey: a.kemPublicKey,
        sealer: o.signer,
    });
    await c.roster(a, [
        o.entry(['billing', 'guardian', 'members'], 1, 'left'),
        a.entry(['members']),
    ]);
    push({
        rosters: [...c.rosters],
        mlDsaKeys: mlDsaKeysOf(o, a),
        name: 'creator-left-key-seal',
        kind: 'key',
        ctx: keyCtx(a, o, atCreated),
        envelope: byCreator,
        signerMlDsaPublicKey: o.served.mlDsaPublicKey,
        history: null,
        reader: { n: 2, keyVersion: 1 },
        expected: 'refused',
    });
    return cases;
}

/*
 * Key seals and grants both twins must make, or refuse to make, alike: only
 * an active holder (an active member, for a grant) seals, and only with the
 * Ed25519 and ML-DSA keys their entry names (a member seals after their
 * identity is folded in).
 */
export type SealerCase = {
    name: string;
    rosters: SignedGroupStatement[];
    mlDsaKeys: Record<string, string>;
    /* The context, its roster position aside: a sealer seals at its own latest accepted roster. */
    ctx: Omit<GroupKeySealContext, 'rosterVersion' | 'rosterDigest'>;
    holder: { n: number; keyVersion: number };
    sealer: { n: number; keyVersion: number };
    /* An area grant from the sealer to the holder instead of a key seal. */
    grant: boolean;
    /* The roster version the seal names, when not the sealer's latest (null). */
    at: number | null;
    /* A grant's workspace key (pattern(32, seed)) and key version. */
    grantKeySeed: number;
    grantKeyVersion: number;
    expected: 'sealed' | 'refused';
};

export async function sealerCases(): Promise<SealerCase[]> {
    const [o, g, outsider] = await Promise.all([person(1), person(3), person(5)]);
    const h = await history();
    await h.roster(o, [o.entry(['billing', 'guardian', 'members']), g.entry(['members'])]);
    const base = {
        rosters: [...h.rosters],
        mlDsaKeys: mlDsaKeysOf(o, g),
        ctx: {
            groupId: GROUP,
            groupKeyVersion: 1,
            holderUserId: g.userId,
            holderKeyVersion: 1,
            sealerUserId: o.userId,
        },
        holder: { n: 3, keyVersion: 1 },
        grant: false,
        at: null,
        grantKeySeed: AREA_KEY_SEED,
        grantKeyVersion: 1,
    };
    const plain = await history();
    await plain.roster(o, [o.entry(['billing', 'guardian', 'members']), g.entry([])]);
    const gone = await history();
    await gone.roster(o, [o.entry(['billing', 'guardian', 'members']), g.entry(['members'])]);
    await gone.roster(o, [
        o.entry(['billing', 'guardian', 'members']),
        g.entry(['members'], 1, 'left'),
    ]);
    const toOrganizer = {
        ...base,
        ctx: { ...base.ctx, holderUserId: o.userId, sealerUserId: g.userId },
        holder: { n: 1, keyVersion: 1 },
        sealer: { n: 3, keyVersion: 1 },
    };
    const half = await history();
    await half.roster(g, [
        g.entry(['billing', 'guardian', 'members']),
        { ...o.entry(['members']), mlDsaPublicKeyDigest: outsider.mlDsaDigest },
    ]);
    // Two rosters, the sealer a holder in both.
    const two = await history();
    await two.roster(o, [o.entry(['billing', 'guardian', 'members']), g.entry(['members'])]);
    await two.roster(o, [
        o.entry(['billing', 'guardian', 'members']),
        g.entry(['members', 'billing']),
    ]);
    return [
        {
            ...base,
            name: 'sealer-own-keys',
            sealer: { n: 1, keyVersion: 1 },
            expected: 'sealed',
        },
        {
            ...base,
            name: 'sealer-replaced-not-folded-in',
            sealer: { n: 1, keyVersion: 2 },
            expected: 'refused',
        },
        {
            ...base,
            name: 'sealer-not-themselves',
            sealer: { n: 3, keyVersion: 1 },
            expected: 'refused',
        },
        // Only an active `members` holder seals the key: g without it, then g after leaving.
        {
            ...toOrganizer,
            name: 'sealer-not-holder',
            rosters: [...plain.rosters],
            expected: 'refused',
        },
        { ...toOrganizer, name: 'sealer-left', rosters: [...gone.rosters], expected: 'refused' },
        // The sealer's entry names their Ed25519 key with another ML-DSA key: not their keys.
        {
            ...base,
            name: 'sealer-half-other-key',
            sealer: { n: 1, keyVersion: 1 },
            rosters: [...half.rosters],
            mlDsaKeys: mlDsaKeysOf(o, g, outsider),
            expected: 'refused',
        },
        // Area grants: from an active member, and from one who has left.
        {
            ...base,
            name: 'granter-active',
            sealer: { n: 1, keyVersion: 1 },
            grant: true,
            expected: 'sealed',
        },
        {
            ...toOrganizer,
            name: 'granter-left',
            rosters: [...gone.rosters],
            grant: true,
            expected: 'refused',
        },
        // A seal names the sealer's latest accepted roster: one naming an earlier roster on the
        // same chain is refused (a lagging seal carried forward), key seal and grant alike.
        {
            ...base,
            name: 'sealer-names-an-older-roster',
            sealer: { n: 1, keyVersion: 1 },
            rosters: [...two.rosters],
            at: 1,
            expected: 'refused',
        },
        {
            ...base,
            name: 'granter-names-an-older-roster',
            sealer: { n: 1, keyVersion: 1 },
            rosters: [...two.rosters],
            grant: true,
            at: 1,
            expected: 'refused',
        },
        // r9: a grant only of a key the latest roster lists: not another key at a listed version,
        // nor a version it does not list (a rotation is a roster first).
        {
            ...base,
            name: 'granter-key-not-listed',
            sealer: { n: 1, keyVersion: 1 },
            grant: true,
            grantKeySeed: 13,
            expected: 'refused',
        },
        {
            ...base,
            name: 'granter-version-not-listed',
            sealer: { n: 1, keyVersion: 1 },
            grant: true,
            grantKeyVersion: 2,
            expected: 'refused',
        },
    ];
}

export async function sealerVerdict(c: SealerCase): Promise<'sealed' | 'refused'> {
    const [holder, sealer] = await Promise.all([
        person(c.holder.n, c.holder.keyVersion),
        person(c.sealer.n, c.sealer.keyVersion),
    ]);
    const chain = await acceptRosters({
        groupId: GROUP,
        firstKeys: (await groupKeyAt(1)).publicKey,
        rosters: c.rosters,
        successions: [],
        mlDsaKeys: c.mlDsaKeys,
        ...READER,
    });
    if (chain.status !== 'accepted') return 'refused';
    const signer = sealer.signer;
    const at = c.at
        ? { rosterVersion: c.at, rosterDigest: chain.rosterDigests[c.at - 1]! }
        : { rosterVersion: chain.roster.rosterVersion, rosterDigest: chain.rosterDigest };
    try {
        if (c.grant)
            await sealAreaGrant(
                pattern(32, c.grantKeySeed),
                {
                    groupId: c.ctx.groupId,
                    workspaceId: AREA,
                    workspaceKeyVersion: c.grantKeyVersion,
                    granteeUserId: c.ctx.holderUserId,
                    granteeKeyVersion: c.ctx.holderKeyVersion,
                    granterUserId: c.ctx.sealerUserId,
                    ...at,
                },
                {
                    chain,
                    areaIdSeed: AREA_SEED,
                    granteeKemPublicKey: holder.kemPublicKey,
                    granter: signer,
                },
            );
        else
            await sealGroupKey(
                pattern(64, 91),
                { ...c.ctx, ...at },
                {
                    chain,
                    holderKemPublicKey: holder.kemPublicKey,
                    sealer: signer,
                },
            );
        return 'sealed';
    } catch (error) {
        if (error instanceof Error && error.name === 'CryptoError') return 'refused';
        throw error;
    }
}

/* What a seal case's opener gives: the payload (base64url), or refused. */
export async function sealVerdict(c: SealCase): Promise<string> {
    const reader = await person(c.reader.n, c.reader.keyVersion);
    try {
        const chain = await acceptRosters({
            groupId: GROUP,
            firstKeys: (await groupKeyAt(1)).publicKey,
            rosters: c.rosters,
            successions: [],
            mlDsaKeys: c.mlDsaKeys,
            ...READER,
        });
        if (chain.status !== 'accepted') return 'fork';
        const signer = decode(c.signerMlDsaPublicKey);
        const opened =
            c.kind === 'key'
                ? await openGroupKey(c.envelope, c.ctx as GroupKeySealContext, {
                      chain,
                      sealerMlDsaPublicKey: signer,
                      sealerHistory: c.history,
                      reader: c.claim,
                      holder: reader.secrets,
                  })
                : await openAreaGrant(c.envelope, c.ctx as AreaGrantContext, {
                      chain,
                      areaIdSeed: AREA_SEED,
                      granterMlDsaPublicKey: signer,
                      granterHistory: c.history,
                      reader: c.claim,
                      grantee: reader.secrets,
                  });
        return encode(opened);
    } catch (error) {
        if (error instanceof Error && error.name === 'CryptoError') return 'refused';
        throw error;
    }
}
