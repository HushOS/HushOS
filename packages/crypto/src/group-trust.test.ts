import { describe, expect, test, vi } from 'vitest';
import {
    acceptRosters,
    joinCode,
    checkNextRoster,
    checkNextSuccession,
    droppedHolders,
    foldInEntry,
    groupIntegrityOf,
    groupWriterTrust,
    newRosterEntry,
    nextRoster,
    ownEntry,
    pinAfter,
    trustAsGroupDoes,
    type AcceptInput,
    type AcceptedRosters,
    type GroupReading,
    type RosterChain,
    type ServedIdentity,
} from './group-trust';
import {
    groupKeyDigest,
    groupKeyPair,
    groupSuccessionStatement,
    memberSigner,
    openGroupKey,
    sealGroupKey,
    parseGroupSuccession,
    rosterDigest,
    rosterStatement,
    signGroupSuccession,
    signRoster,
    type GroupRole,
    type GroupKeySuccession,
    type Roster,
    type RosterMember,
    type SignedGroupStatement,
} from './groups';
import {
    AREA,
    CHECKED,
    GROUP,
    OTHER_AREA,
    OTHER_GROUP,
    acceptedOf,
    acceptedTo,
    groupKeyAt,
    history,
    inputOf,
    mlDsaKeysOf,
    pattern,
    person,
    pinOf,
    signedBy,
    sortedMembers,
    succeed,
    linkBetween,
    consentOf,
    servedKeysOf,
    recordSignature,
    recordVerdict,
    type History,
    type Person,
} from './group-testkit';
import { keyDigest } from './fingerprint';
import { verifyIdentityKeys, type ServedKeys, type SuccessionLink } from './identity';
import { MAX_VERIFIED_LINKS, successionPath } from './succession-path';
import { decode, encode } from './keys';
import { pinVerified } from './pins';
import {
    digest,
    keysStatement,
    successionStatement,
    metadataStatement,
    metadataStatements,
    signHybrid,
    signStatement,
} from './signatures';

/*
 * Every device verifies the roster chain the server serves from version 1,
 * warns loudly only when the person's own marks (their pins, this device's
 * cache) disagree with each other or with that chain, ignores whatever else
 * was served beside it, and lets the roster vouch for writers only inside the
 * group's own areas. Each refusal is something a server, a removed holder or
 * a dishonest member would otherwise get past.
 */

const OWNER: GroupRole[] = ['billing', 'guardian', 'members'];

async function cast() {
    const [organizer, adult, holder, child, outsider] = await Promise.all(
        [1, 2, 3, 4, 5].map((n) => person(n)),
    );
    return {
        organizer: organizer!,
        adult: adult!,
        holder: holder!,
        child: child!,
        outsider: outsider!,
    };
}

/*
 * A family's history: the organizer creates it (1), admits a second holder
 * (2), the holder leaves (3), so the key is replaced (1 -> 2, tied to 3), and
 * the organizer signs on under the new key (4).
 */
async function family() {
    const people = await cast();
    const { organizer, adult, holder } = people;
    const h = await history();
    const owner = organizer.entry(OWNER);
    await h.roster(organizer, [owner, adult.entry([])]);
    await h.roster(organizer, [owner, adult.entry([]), holder.entry(['members'], 2)]);
    await h.roster(organizer, [owner, adult.entry([]), holder.entry(['members'], 3, 'left')]);
    await h.succession(organizer);
    await h.roster(organizer, [owner, adult.entry([]), holder.entry(['members'], 3, 'left')]);
    return { ...people, h, all: Object.values(people) };
}
type Family = Awaited<ReturnType<typeof family>>;

function newcomer(f: Family, over: Partial<AcceptInput> = {}): AcceptInput {
    return inputOf(f.h, f.all, over);
}

async function accepted(input: AcceptInput) {
    const chain = await acceptRosters(input);
    if (chain.status !== 'accepted') throw new Error(`expected an accepted chain, got a fork`);
    return chain;
}

/* A roster with fields changed, re-signed properly by the group key and `signer`. */
async function resigned(
    f: { h: History; organizer: Person },
    version: number,
    change: Partial<Roster>,
    signer: Person = f.organizer,
): Promise<SignedGroupStatement> {
    const roster = { ...f.h.statements[version - 1]!, ...change };
    if (change.members) roster.members = sortedMembers(change.members);
    return signRoster(roster, f.h.keys[roster.groupKeyVersion - 1]!, signer.signer);
}

/* A fork of `of` at `version` whose sides are exactly these digests, each with its sources and signer. */
function forkOf(
    result: RosterChain,
    of: 'roster' | 'group-key',
    version: number,
    sides: { digest: string; from: string[]; signerUserId: string | null }[],
) {
    expect(result).toEqual({
        status: 'fork',
        of,
        version,
        sides: [...sides].sort((x, y) => (x.digest < y.digest ? -1 : 1)),
    });
}

describe('accepting the chain the server serves', () => {
    test('a newcomer accepts the chain from version 1 through the key succession, once the words are checked', async () => {
        const f = await family();
        const chain = await accepted(newcomer(f));
        expect(chain.roster.rosterVersion).toBe(4);
        expect(chain.groupKeyVersion).toBe(2);
        expect(chain.groupKey).toEqual(f.h.keys[1]!.publicKey);
        expect(chain.creatorUserId).toBe(f.organizer.userId);
        expect(chain.successionDue).toBe(false);
        expect(chain.deadBranches).toEqual([]);
        expect(chain.rosterDigests).toEqual(
            await Promise.all(f.h.rosters.map((r) => rosterDigest(r.statement))),
        );
        // With no pin, no cache and no words check, nothing is taken on faith.
        await expect(acceptRosters(newcomer(f, { firstKeysChecked: false }))).rejects.toThrow(
            'have not been checked',
        );
    });

    test('rosters served beside the chain are dead branches: noted with their signer, never a warning', async () => {
        const f = await family();
        // F1: long after their removal, the holder signs another roster 2 under key 1.
        const back = await resigned(
            f,
            2,
            {
                signerUserId: f.holder.userId,
                members: [
                    f.organizer.entry(OWNER),
                    f.adult.entry([]),
                    f.holder.entry(['members'], 2),
                    f.outsider.entry([], 2),
                ],
            },
            f.holder,
        );
        // And the organizer's own roster 3 that the server never stored.
        const orphan = await resigned(f, 3, {
            members: [
                f.organizer.entry(OWNER),
                f.adult.entry(['billing'], 3),
                f.holder.entry(['members'], 3, 'left'),
            ],
        });
        const pin4 = await pinOf(f.h, 4, f.all);
        const full = await accepted(newcomer(f));
        for (const over of [{}, { pins: [pin4] }, { pins: [pin4], cache: full.cache }]) {
            const chain = await accepted(
                newcomer(f, { ...over, rosters: [...f.h.rosters, back, orphan] }),
            );
            expect(chain.rosterDigest).toBe(full.rosterDigest);
            expect(chain.deadBranches).toEqual([
                { version: 2, signerUserId: f.holder.userId },
                { version: 3, signerUserId: f.organizer.userId },
            ]);
        }
    });

    test('the chain is the latest roster linked back to version 1: two latest, a broken link or no version 1 are refused', async () => {
        const f = await family();
        const other4 = await resigned(f, 4, {
            members: [
                f.organizer.entry(OWNER),
                f.adult.entry(['billing'], 4),
                f.holder.entry(['members'], 3, 'left'),
            ],
        });
        for (const rosters of [
            [...f.h.rosters, other4],
            [other4, ...f.h.rosters],
        ])
            await expect(acceptRosters(newcomer(f, { rosters }))).rejects.toThrow(
                'more than one latest member list',
            );
        const elsewhere = await resigned(f, 4, {
            previousRosterDigest: encode(new Uint8Array(32).fill(7)),
        });
        await expect(
            acceptRosters(newcomer(f, { rosters: [...f.h.rosters.slice(0, 3), elsewhere] })),
        ).rejects.toThrow('does not follow the last one');
        await expect(
            acceptRosters(newcomer(f, { rosters: [f.h.rosters[0]!, ...f.h.rosters.slice(2)] })),
        ).rejects.toThrow('does not follow the last one');
        await expect(acceptRosters(newcomer(f, { rosters: f.h.rosters.slice(1) }))).rejects.toThrow(
            'does not follow the last one',
        );
        // A holder's second roster 3 chained to the real 3, and a 4 on it: four links, but not 1 to 4.
        const again3 = await resigned(f, 3, {
            previousRosterDigest: await rosterDigest(f.h.rosters[2]!.statement),
        });
        const on = await resigned(f, 4, {
            previousRosterDigest: await rosterDigest(again3.statement),
        });
        await expect(
            acceptRosters(newcomer(f, { rosters: [...f.h.rosters.slice(0, 3), again3, on] })),
        ).rejects.toThrow('does not follow the last one');
        // p4: an unsigned chain naming anyone as its signer, against a pin: refused, no warning.
        const junk: SignedGroupStatement[] = [];
        let previous = '';
        for (let version = 1; version <= 4; version++) {
            const statement = rosterStatement({
                ...f.h.statements[0]!,
                rosterVersion: version,
                previousRosterDigest: previous,
                signerUserId: f.child.userId,
                members: [f.child.entry(['members'])],
            });
            junk.push({
                statement,
                signature: { ed25519: new Uint8Array(64), mlDsa: new Uint8Array(3309) },
                signerSignature: new Uint8Array(3373),
            });
            previous = await rosterDigest(statement);
        }
        await expect(
            acceptRosters(
                newcomer(f, {
                    pins: [await pinOf(f.h, 2, f.all)],
                    firstKeysChecked: false,
                    rosters: junk,
                }),
            ),
        ).rejects.toThrow('not signed by the group key');
        // A roster a holder signed for another group, chained into this one.
        const foreign = await resigned(f, 2, { groupId: OTHER_GROUP });
        const after = await resigned(f, 3, {
            previousRosterDigest: await rosterDigest(foreign.statement),
        });
        await expect(
            acceptRosters(newcomer(f, { rosters: [f.h.rosters[0]!, foreign, after] })),
        ).rejects.toThrow('for another group');
    });

    test('refuses a roster or succession on the chain whose Ed25519 half is valid and ML-DSA half is not, and the reverse', async () => {
        const f = await family();
        const flip = (value: Uint8Array, at: number) => {
            const copy = value.slice();
            copy[at]! ^= 1;
            return copy;
        };
        const second = f.h.rosters[1]!;
        for (const signature of [
            { ...second.signature, mlDsa: flip(second.signature.mlDsa, 99) },
            { ...second.signature, ed25519: flip(second.signature.ed25519, 3) },
        ])
            await expect(
                acceptRosters(
                    newcomer(f, {
                        rosters: [
                            f.h.rosters[0]!,
                            { ...second, signature },
                            ...f.h.rosters.slice(2),
                        ],
                    }),
                ),
            ).rejects.toThrow('not signed by the group key');
        const succession = f.h.successions[0]!;
        for (const signature of [
            { ...succession.signature, mlDsa: flip(succession.signature.mlDsa, 99) },
            { ...succession.signature, ed25519: flip(succession.signature.ed25519, 3) },
        ])
            await expect(
                acceptRosters(newcomer(f, { successions: [{ ...succession, signature }] })),
            ).rejects.toThrow('not signed by the key it replaces');
        // A forged roster on the chain, under a key that is not the group's.
        const forged = await signRoster(
            f.h.statements[1]!,
            await groupKeyAt(9),
            f.organizer.signer,
        );
        await expect(
            acceptRosters(
                newcomer(f, { rosters: [f.h.rosters[0]!, forged, ...f.h.rosters.slice(2)] }),
            ),
        ).rejects.toThrow('not signed by the group key');
    });

    test('one statement served with other signatures: either copy that verifies will do', async () => {
        const f = await family();
        const again = await signRoster(f.h.statements[1]!, f.h.keys[0]!, f.organizer.signer);
        expect(
            (await accepted(newcomer(f, { rosters: [...f.h.rosters, again] }))).rosterDigest,
        ).toBe((await accepted(newcomer(f))).rosterDigest);
        const broken = {
            ...again,
            signature: {
                ...again.signature,
                mlDsa: again.signature.mlDsa.map((b, i) => (i === 9 ? b ^ 1 : b)),
            },
        };
        expect(
            (await accepted(newcomer(f, { rosters: [...f.h.rosters, broken] }))).roster
                .rosterVersion,
        ).toBe(4);
        expect(
            (await accepted(newcomer(f, { rosters: [broken, ...f.h.rosters] }))).roster
                .rosterVersion,
        ).toBe(4);
        await expect(
            acceptRosters(
                newcomer(f, { rosters: [f.h.rosters[0]!, broken, ...f.h.rosters.slice(2)] }),
            ),
        ).rejects.toThrow('not signed by the group key');
        const succession = await signedBy(f.h.successions[0]!.statement, f.h.keys[0]!, f.organizer);
        expect(
            (await accepted(newcomer(f, { successions: [...f.h.successions, succession] })))
                .groupKeyVersion,
        ).toBe(2);
    });

    test('refuses a roster whose signer was not an active `members` holder on the roster before', async () => {
        const f = await family();
        const promoted = await resigned(
            f,
            2,
            {
                signerUserId: f.adult.userId,
                members: [
                    f.organizer.entry(OWNER),
                    f.adult.entry(['members'], 2),
                    f.holder.entry(['members'], 2),
                ],
            },
            f.adult,
        );
        await expect(
            acceptRosters(newcomer(f, { rosters: [f.h.rosters[0]!, promoted] })),
        ).rejects.toThrow('not signed by a member who holds the group key');
        const ghost = await resigned(f, 4, { signerUserId: f.holder.userId }, f.holder);
        await expect(
            acceptRosters(newcomer(f, { rosters: [...f.h.rosters.slice(0, 3), ghost] })),
        ).rejects.toThrow('not signed by a member who holds the group key');
    });

    test('refuses a missing or wrong signer identity signature, and an ML-DSA key the entry does not name', async () => {
        const f = await family();
        const second = f.h.rosters[1]!;
        const rosters = (signed: SignedGroupStatement) => [
            f.h.rosters[0]!,
            signed,
            ...f.h.rosters.slice(2),
        ];
        const byOutsider = await signRoster(f.h.statements[1]!, f.h.keys[0]!, f.outsider.signer);
        for (const signerSignature of [
            new Uint8Array(0),
            second.signerSignature.subarray(0, 64),
            byOutsider.signerSignature,
        ])
            await expect(
                acceptRosters(newcomer(f, { rosters: rosters({ ...second, signerSignature }) })),
            ).rejects.toThrow('not signed by the member it names');
        await expect(
            acceptRosters(newcomer(f, { mlDsaKeys: mlDsaKeysOf(f.adult) })),
        ).rejects.toThrow('not signed by the member it names');
        // A forger of Ed25519 alone signs every statement with the organizer's Ed25519 key and their
        // own ML-DSA key, and the server serves that ML-DSA key under the organizer's digest.
        const forger = {
            signingKey: f.organizer.signer.signingKey,
            mlDsaSecretKey: f.outsider.signer.mlDsaSecretKey,
        };
        const forge = async (signed: SignedGroupStatement) => ({
            ...signed,
            signerSignature: await signHybrid(signed.statement, forger),
        });
        await expect(
            acceptRosters(
                newcomer(f, {
                    rosters: await Promise.all(f.h.rosters.map(forge)),
                    successions: await Promise.all(f.h.successions.map(forge)),
                    mlDsaKeys: {
                        ...mlDsaKeysOf(...f.all),
                        [f.organizer.mlDsaDigest]: f.outsider.served.mlDsaPublicKey,
                    },
                }),
            ),
        ).rejects.toThrow('not signed by the member it names');
    });
});

describe('the person’s marks', () => {
    test('a pin is a mark the chain must reach and pass through; a pin it does not pass through is the warning', async () => {
        const f = await family();
        const pin2 = await pinOf(f.h, 2, f.all);
        const pin4 = await pinOf(f.h, 4, f.all);
        expect((await accepted(newcomer(f, { pins: [pin2, pin4] }))).roster.rosterVersion).toBe(4);
        // Other first keys served, each half, against the pin's: refused before anything else is
        // looked at, whatever the server signed under them (r6 p1: a server-made group key and a
        // roster 1 naming a made-up creator are a refusal, never the warning).
        const other7 = await groupKeyAt(7);
        const otherKey = other7.publicKey;
        const real = f.h.keys[0]!.publicKey;
        const elsewhereKeyed = await Promise.all(
            f.h.statements
                .slice(0, 2)
                .map((roster) => signRoster(roster, other7, f.organizer.signer)),
        );
        for (const firstKeys of [
            { ...real, ed25519PublicKey: otherKey.ed25519PublicKey },
            { ...real, mlDsaPublicKey: otherKey.mlDsaPublicKey },
            otherKey,
        ])
            for (const rosters of [f.h.rosters, elsewhereKeyed])
                await expect(
                    acceptRosters(
                        newcomer(f, { pins: [pin2], firstKeys, rosters, successions: [] }),
                    ),
                ).rejects.toThrow('not the group keys whose words were checked');
        // Two of the person's own pins naming other version 1 keys: the warning, marks only.
        const firstMark = async (key: { ed25519PublicKey: string; mlDsaPublicKey: string }) =>
            digest(
                new Uint8Array([
                    ...decode(key.ed25519PublicKey),
                    ...decode(await digest(decode(key.mlDsaPublicKey))),
                ]),
            );
        const otherFirst = {
            ...pin2,
            firstEd25519PublicKey: otherKey.ed25519PublicKey,
            firstMlDsaPublicKeyDigest: await digest(decode(otherKey.mlDsaPublicKey)),
        };
        forkOf(await acceptRosters(newcomer(f, { pins: [pin2, otherFirst] })), 'group-key', 1, [
            { digest: await firstMark(real), from: ['pin'], signerUserId: null },
            { digest: await firstMark(otherKey), from: ['pin'], signerUserId: null },
        ]);
        // Served only up to an older version than a pin: a rollback.
        await expect(
            acceptRosters(newcomer(f, { pins: [pin4], rosters: f.h.rosters.slice(0, 3) })),
        ).rejects.toThrow('older member list');
        // A pin naming another roster 2: the person was shown another history. Both sides named.
        const other = await resigned(f, 2, {
            members: [f.organizer.entry(OWNER), f.adult.entry([]), f.outsider.entry([], 2)],
        });
        const otherDigest = await rosterDigest(other.statement);
        const elsewhere = { ...pin2, rosterDigest: otherDigest };
        forkOf(await acceptRosters(newcomer(f, { pins: [elsewhere] })), 'roster', 2, [
            { digest: otherDigest, from: ['pin'], signerUserId: null },
            { digest: pin2.rosterDigest, from: ['served'], signerUserId: f.organizer.userId },
        ]);
        // Two of the person's own pins at one version: the warning, decided before anything served
        // is looked at, so neither side names a signer; and even when what is served is junk.
        const junkHead = {
            ...(await resigned(f, 4, { previousRosterDigest: encode(new Uint8Array(32).fill(7)) })),
            signature: { ed25519: new Uint8Array(64), mlDsa: new Uint8Array(3309) },
            signerSignature: new Uint8Array(3373),
        };
        for (const pins of [
            [pin2, elsewhere],
            [elsewhere, pin2],
        ])
            for (const rosters of [[...f.h.rosters, other], [junkHead], []])
                forkOf(await acceptRosters(newcomer(f, { pins, rosters })), 'roster', 2, [
                    { digest: otherDigest, from: ['pin'], signerUserId: null },
                    { digest: pin2.rosterDigest, from: ['pin'], signerUserId: null },
                ]);
        // A malformed pin is refused with the usual error, never a crash.
        await expect(
            acceptRosters(newcomer(f, { pins: [{ ...pin4, keyVersion: 0 }] })),
        ).rejects.toThrow('Invalid group key version.');
    });

    test('two pins disagreeing on a group key choose no succession: the warning names just the two pins', async () => {
        const f = await family();
        const pin4 = await pinOf(f.h, 4, f.all);
        for (const seed of [7, 8, 9]) {
            const rival = await groupKeyDigest((await groupKeyAt(seed)).publicKey);
            forkOf(
                await acceptRosters(
                    newcomer(f, { pins: [pin4, { ...pin4, groupKeyDigest: rival }] }),
                ),
                'group-key',
                2,
                [
                    { digest: rival, from: ['pin'], signerUserId: null },
                    { digest: pin4.groupKeyDigest, from: ['pin'], signerUserId: null },
                ],
            );
        }
    });

    test('group key marks: a pin naming another key at a version, or two pins disagreeing (F6), are the warning', async () => {
        const f = await family();
        const pin4 = await pinOf(f.h, 4, f.all);
        const rival = (await groupKeyAt(8)).publicKey;
        const rivalDigest = await groupKeyDigest(rival);
        forkOf(
            await acceptRosters(newcomer(f, { pins: [{ ...pin4, groupKeyDigest: rivalDigest }] })),
            'group-key',
            2,
            [
                { digest: rivalDigest, from: ['pin'], signerUserId: null },
                { digest: pin4.groupKeyDigest, from: ['served'], signerUserId: f.organizer.userId },
            ],
        );
        forkOf(
            await acceptRosters(
                newcomer(f, { pins: [pin4, { ...pin4, groupKeyDigest: rivalDigest }] }),
            ),
            'group-key',
            2,
            [
                { digest: rivalDigest, from: ['pin'], signerUserId: null },
                { digest: pin4.groupKeyDigest, from: ['pin'], signerUserId: null },
            ],
        );
        // A key the chain does not reach is a rollback.
        await expect(
            acceptRosters(newcomer(f, { pins: [{ ...pin4, keyVersion: 3 }] })),
        ).rejects.toThrow('older member list');
    });

    test('the pin written after acceptance is the chain’s, with every pin’s area marks and the earliest check', async () => {
        const f = await family();
        const chain = await accepted(newcomer(f));
        const settings = {
            ...(await pinOf(f.h, 2, f.all)),
            areas: { [AREA]: 3 },
            checkedAt: '2026-10-16T00:00:00.000Z',
        };
        const device = { ...(await pinOf(f.h, 3, f.all)), areas: { [AREA]: 1, [OTHER_AREA]: 2 } };
        expect(await pinAfter([settings, device], chain, '2026-10-17T00:00:00.000Z')).toMatchObject(
            {
                rosterVersion: 4,
                rosterDigest: chain.rosterDigest,
                keyVersion: 2,
                groupKeyDigest: chain.groupKeyDigest,
                areas: { [AREA]: 3, [OTHER_AREA]: 2 },
                checkedAt: CHECKED,
            },
        );
        const now = '2026-10-17T09:30:00.000Z';
        expect((await pinAfter([], chain, now)).checkedAt).toBe(now);
        await expect(
            pinAfter(
                [{ ...settings, rosterDigest: encode(new Uint8Array(32).fill(4)) }],
                chain,
                now,
            ),
        ).rejects.toThrow('not on the accepted member list');
        // r8 (Codex 4): a check time outside the canonical ISO form is refused, given or held.
        for (const bad of ['now', '2026-10-17 09:30:00', '2026-13-01T00:00:00.000Z', '\u{10000}'])
            await expect(pinAfter([], chain, bad)).rejects.toThrow('Invalid group pin');
        await expect(pinAfter([{ ...settings, checkedAt: '\uE000' }], chain, now)).rejects.toThrow(
            'Invalid group pin',
        );
    });
});

describe('the entry rules', () => {
    test('an entry never disappears, and a changed entry carries the roster version it changed at', async () => {
        const f = await family();
        const dropped = await resigned(f, 2, {
            members: [f.organizer.entry(OWNER), f.holder.entry(['members'], 2)],
        });
        await expect(
            acceptRosters(newcomer(f, { rosters: [f.h.rosters[0]!, dropped] })),
        ).rejects.toThrow('does not follow from the one before');
        const stale = await resigned(f, 2, {
            members: [
                f.organizer.entry(OWNER),
                f.adult.entry(['members'], 1),
                f.holder.entry(['members'], 2),
            ],
        });
        await expect(
            acceptRosters(newcomer(f, { rosters: [f.h.rosters[0]!, stale] })),
        ).rejects.toThrow('does not follow from the one before');
    });

    test('key versions are a holder’s claim: probes 1, 1b, 1c and F2 all go through, and the member stays followable', async () => {
        const { organizer, adult, holder, outsider } = await cast();
        const { next: adult2, link } = await succeed(adult);
        const restarted = await person(2, 2);
        const { next: adult3 } = await succeed(restarted);
        const chainOf = async (...lists: RosterMember[][]) => {
            const h = await history();
            for (const members of lists)
                await h.roster(organizer, [organizer.entry(OWNER), ...members]);
            return acceptedOf(h, [organizer]);
        };
        // Probe 1: started over without a link, then succeeded: two versions above the entry.
        expect((await chainOf([adult.entry([])], [adult3.entry([])])).roster.rosterVersion).toBe(2);
        // 1b, 1c: a wrong entry is put right by going back, or by the same version.
        const wrong = { ...outsider.entry([]), userId: adult.userId, keyVersion: 2 };
        expect(
            (await chainOf([adult.entry([])], [wrong], [adult.entry([])])).roster.rosterVersion,
        ).toBe(3);
        expect(
            (await chainOf([adult.entry([])], [wrong], [adult2.entry([])])).roster.rosterVersion,
        ).toBe(3);
        // F2: the adult's keys written at version 1000; their real succession is still followed.
        const inflated = await chainOf(
            [adult.entry([])],
            [{ ...adult.entry([]), keyVersion: 1000 }],
        );
        const entry = inflated.roster.members.find((m) => m.userId === adult.userId)!;
        expect((await foldInEntry(entry, adult2.served, [link], 3)).changed).toBe(true);
        const record = {
            workspaceId: AREA,
            nodeId: '0e0e0e0e-0e0e-4e0e-8e0e-0e0e0e0e0e0e',
            kind: 'file' as const,
            metadataVersion: 1,
        };
        const envelope = new Uint8Array(96).fill(5);
        const trust = await groupWriterTrust({
            groupId: GROUP,
            areas: { [AREA]: 1 },
            reading: { status: 'accepted', chain: inflated },
            workspaceId: AREA,
            writerUserId: adult.userId,
            pinned: null,
            served: adult2.served,
            links: [link],
        });
        expect(
            await groupIntegrityOf(
                () => metadataStatements(record, envelope),
                await signStatement(
                    await metadataStatement(record, envelope),
                    adult2.signer.signingKey,
                ),
                trust,
                null,
            ),
        ).toEqual({ integrity: 'verified', via: GROUP });
        // And a words check re-adds them at any version.
        const h = await history();
        await h.roster(organizer, [
            organizer.entry(OWNER),
            { ...adult.entry([]), keyVersion: 1000 },
            holder.entry(['members']),
        ]);
        const chain = await acceptedOf(h, [organizer]);
        const roster = await nextRoster(
            chain,
            [organizer.entry(OWNER), adult2.entry([]), holder.entry(['members'])],
            {
                signerUserId: organizer.userId,
            },
        );
        h.rosters.push(await signRoster(roster, h.keys[0]!, organizer.signer));
        expect(
            (await acceptedOf(h, [organizer])).roster.members.find((m) => m.userId === adult.userId)
                ?.keyVersion,
        ).toBe(2);
    });
});

describe('the next roster and succession', () => {
    test('a roster nextRoster builds is always one acceptRosters takes', async () => {
        const f = await family();
        let chain = await accepted(newcomer(f));
        const { next: adult2, link } = await succeed(f.adult);
        const steps: ((c: AcceptedRosters) => Promise<RosterMember[]>)[] = [
            async () => [
                f.organizer.entry(OWNER),
                f.adult.entry([]),
                f.holder.entry(['members'], 3, 'left'),
                f.child.entry([]),
            ],
            async (c) => [
                f.organizer.entry(OWNER),
                (
                    await foldInEntry(
                        c.roster.members.find((m) => m.userId === f.adult.userId)!,
                        adult2.served,
                        [link],
                        6,
                    )
                ).entry,
                f.holder.entry(['members'], 3, 'left'),
                f.child.entry(['members']),
            ],
            async (c) =>
                c.roster.members.map((m) =>
                    m.userId === f.child.userId ? { ...m, roles: [] } : m,
                ),
        ];
        for (const step of steps) {
            const roster = await nextRoster(chain, await step(chain), {
                signerUserId: f.organizer.userId,
            });
            const signed = await signRoster(
                roster,
                f.h.keys[chain.groupKeyVersion - 1]!,
                f.organizer.signer,
            );
            await checkNextRoster(chain, signed, mlDsaKeysOf(...f.all), null);
            f.h.rosters.push(signed);
            f.h.statements.push(roster);
            chain = await accepted(newcomer(f));
            expect(chain.roster).toEqual(roster);
        }
        expect(chain.successionDue).toBe(true);
        await expect(
            nextRoster(chain, chain.roster.members, { signerUserId: f.organizer.userId }),
        ).rejects.toThrow('must be replaced first');
        // The succession, checked before it is signed and stored, then the next roster under it.
        await f.h.succession(f.organizer);
        await checkNextSuccession(chain, f.h.successions.at(-1)!, mlDsaKeysOf(...f.all));
        chain = await accepted(newcomer(f));
        const roster = await nextRoster(chain, chain.roster.members, {
            signerUserId: f.organizer.userId,
        });
        expect(roster.groupKeyVersion).toBe(3);
        f.h.rosters.push(await signRoster(roster, f.h.keys[2]!, f.organizer.signer));
        expect((await accepted(newcomer(f))).roster.rosterVersion).toBe(8);
    });

    test('nextRoster refuses what no device would accept: a lost entry, a non-holder signer', async () => {
        const f = await family();
        const chain = await accepted(newcomer(f));
        await expect(
            nextRoster(chain, [f.organizer.entry(OWNER), f.adult.entry([])], {
                signerUserId: f.organizer.userId,
            }),
        ).rejects.toThrow('does not follow from the one before');
        await expect(
            nextRoster(chain, chain.roster.members, { signerUserId: f.adult.userId }),
        ).rejects.toThrow('not signed by a member who holds the group key');
    });

    test('checkNextRoster is acceptance itself; with the members’ identities it also refuses keys a member never had', async () => {
        const f = await family();
        const chain = await accepted(newcomer(f));
        const keys = mlDsaKeysOf(...f.all);
        const base: Roster = {
            ...chain.roster,
            rosterVersion: 5,
            previousRosterDigest: chain.rosterDigest,
            members: chain.roster.members.map((m) =>
                m.userId === f.adult.userId ? { ...m, roles: ['billing'], sinceVersion: 5 } : m,
            ),
        };
        const candidates: [string, Promise<SignedGroupStatement>][] = [
            ['honest', signRoster(base, f.h.keys[1]!, f.organizer.signer)],
            [
                'skips a version',
                signRoster(
                    {
                        ...base,
                        rosterVersion: 6,
                        members: base.members.map((m) =>
                            m.sinceVersion === 5 ? { ...m, sinceVersion: 6 } : m,
                        ),
                    },
                    f.h.keys[1]!,
                    f.organizer.signer,
                ),
            ],
            [
                'another parent',
                signRoster(
                    { ...base, previousRosterDigest: encode(new Uint8Array(32).fill(1)) },
                    f.h.keys[1]!,
                    f.organizer.signer,
                ),
            ],
            [
                'under the replaced key',
                signRoster({ ...base, groupKeyVersion: 1 }, f.h.keys[0]!, f.organizer.signer),
            ],
            [
                'names the replaced key, signed by the current one',
                signRoster({ ...base, groupKeyVersion: 1 }, f.h.keys[1]!, f.organizer.signer),
            ],
            [
                'names an unpublished key',
                signRoster({ ...base, groupKeyVersion: 3 }, f.h.keys[1]!, f.organizer.signer),
            ],
            [
                'another kind',
                signRoster({ ...base, kind: 'org' }, f.h.keys[1]!, f.organizer.signer),
            ],
            [
                'by a former holder',
                signRoster(
                    { ...base, signerUserId: f.holder.userId },
                    f.h.keys[1]!,
                    f.holder.signer,
                ),
            ],
            ['by an unsigned signer', signedBy(rosterStatement(base), f.h.keys[1]!, null)],
            ['by another key', signRoster(base, await groupKeyAt(9), f.organizer.signer)],
            [
                'drops an entry',
                signRoster(
                    { ...base, members: base.members.slice(1) },
                    f.h.keys[1]!,
                    f.organizer.signer,
                ),
            ],
        ];
        for (const [what, pending] of candidates) {
            const signed = await pending;
            const byCheck = await checkNextRoster(chain, signed, keys, null).then(
                () => 'accepted',
                () => 'refused',
            );
            const byChain = await acceptRosters(
                newcomer(f, { rosters: [...f.h.rosters, signed] }),
            ).then(
                (result) => result.status,
                () => 'refused',
            );
            expect(byCheck, what).toBe(byChain);
            expect(byCheck, what).toBe(what === 'honest' ? 'accepted' : 'refused');
        }
        // A holder writing keys the member never had (F2, F3): accepted by devices, refused by the
        // server, which holds every identity each member has had.
        const identities = Object.fromEntries(f.all.map((p) => [p.userId, [p.served]]));
        const planted = await signRoster(
            {
                ...base,
                members: base.members.map((m) =>
                    m.userId === f.adult.userId
                        ? { ...f.outsider.entry(['billing'], 5), userId: f.adult.userId }
                        : m,
                ),
            },
            f.h.keys[1]!,
            f.organizer.signer,
        );
        await checkNextRoster(chain, planted, keys, null);
        await expect(checkNextRoster(chain, planted, keys, identities)).rejects.toThrow(
            'never had',
        );
        // The outsider's own identity listed under the adult's id: its keys statement names the outsider.
        await expect(
            checkNextRoster(chain, planted, keys, {
                ...identities,
                [f.adult.userId]: [f.outsider.served],
            }),
        ).rejects.toThrow('never had');
        const inflated = await signRoster(
            {
                ...base,
                members: base.members.map((m) =>
                    m.userId === f.adult.userId ? { ...m, keyVersion: 1000 } : m,
                ),
            },
            f.h.keys[1]!,
            f.organizer.signer,
        );
        await expect(checkNextRoster(chain, inflated, keys, identities)).rejects.toThrow(
            'never had',
        );
        await checkNextRoster(chain, await candidates[0]![1], keys, identities);
        // Entries whose keys did not change need no identity: only the changed ones are looked up.
        await checkNextRoster(chain, await candidates[0]![1], keys, {});
    });

    test('F4: checkNextSuccession refuses a succession tied before the latest roster, which would stall the group', async () => {
        const { organizer, adult, holder } = await cast();
        const h = await history();
        await h.roster(organizer, [
            organizer.entry(OWNER),
            adult.entry([]),
            holder.entry(['members']),
        ]);
        await h.roster(organizer, [
            organizer.entry(OWNER),
            adult.entry([]),
            holder.entry(['members'], 2, 'left'),
        ]);
        const chain = await acceptedOf(h, [organizer]);
        const keys = mlDsaKeysOf(organizer, holder);
        const succession = async (tie: number, signer = organizer) => {
            const old = h.keys[0]!;
            const next = await groupKeyAt(2);
            return signGroupSuccession(
                {
                    groupId: GROUP,
                    oldVersion: 1,
                    newVersion: 2,
                    oldEd25519PublicKey: old.publicKey.ed25519PublicKey,
                    oldMlDsaPublicKey: old.publicKey.mlDsaPublicKey,
                    newEd25519PublicKey: next.publicKey.ed25519PublicKey,
                    newMlDsaPublicKey: next.publicKey.mlDsaPublicKey,
                    lastRosterVersion: tie,
                    lastRosterDigest: await rosterDigest(h.rosters[tie - 1]!.statement),
                    signerUserId: signer.userId,
                },
                old,
                signer.signer,
            );
        };
        await expect(checkNextSuccession(chain, await succession(1), keys)).rejects.toThrow(
            'not tied to a roster',
        );
        await expect(checkNextSuccession(chain, await succession(2, holder), keys)).rejects.toThrow(
            'not signed by a member who holds',
        );
        await checkNextSuccession(chain, await succession(2), keys);
        // Stored anyway, it holds from the roster it is tied to, so the roster after it, under
        // the old key, does not: every device refuses the chain. Only the server's check stops it.
        await expect(
            acceptRosters(inputOf(h, [organizer], { successions: [await succession(1)] })),
        ).rejects.toThrow('has been replaced');
    });
});

describe('group key succession', () => {
    /* The family's succession with `change` applied, signed by key 1 and `signer` as given. */
    async function rewritten(
        f: Family,
        change: Partial<GroupKeySuccession>,
        signer: Person | null = f.organizer,
    ) {
        const succession = { ...parseGroupSuccession(f.h.successions[0]!.statement), ...change };
        return signedBy(groupSuccessionStatement(succession), f.h.keys[0]!, signer);
    }

    test('two successions from one key that both hold: refused, unless a group key mark chooses', async () => {
        const f = await family();
        const rivalKey = (await groupKeyAt(8)).publicKey;
        const rival = await rewritten(f, {
            newEd25519PublicKey: rivalKey.ed25519PublicKey,
            newMlDsaPublicKey: rivalKey.mlDsaPublicKey,
        });
        for (const successions of [
            [...f.h.successions, rival],
            [rival, ...f.h.successions],
        ])
            await expect(acceptRosters(newcomer(f, { successions }))).rejects.toThrow(
                'more than one group key succession',
            );
        const pin = await pinOf(f.h, 4, f.all);
        expect(
            (await accepted(newcomer(f, { pins: [pin], successions: [rival, ...f.h.successions] })))
                .groupKey,
        ).toEqual(f.h.keys[1]!.publicKey);
        // And the other way: a mark from a device that took the rival chooses the rival.
        const three = f.h.rosters.slice(0, 3);
        const theirs = await accepted(newcomer(f, { rosters: three, successions: [rival] }));
        const rivalPin = await pinAfter([], theirs, CHECKED);
        expect(
            (
                await accepted(
                    newcomer(f, {
                        pins: [rivalPin],
                        rosters: three,
                        successions: [...f.h.successions, rival],
                    }),
                )
            ).groupKey,
        ).toEqual(rivalKey);
    });

    test("p3: a removed holder's rival succession tied early waits for the marked one; the warning only if a holder-signed roster holds under it", async () => {
        const { organizer, holder } = await cast();
        const h = await history();
        const own = organizer.entry(OWNER);
        await h.roster(organizer, [own, holder.entry(['members'])]);
        await h.roster(organizer, [own, holder.entry(['members'], 1, 'left')]);
        await h.succession(organizer);
        await h.roster(organizer, [own, holder.entry(['members'], 1, 'left')]);
        const people = [organizer, holder];
        const pin = await pinOf(h, 3, people);
        const rivalKey = (await groupKeyAt(7)).publicKey;
        const real = parseGroupSuccession(h.successions[0]!.statement);
        const early = await signedBy(
            groupSuccessionStatement({
                ...real,
                newEd25519PublicKey: rivalKey.ed25519PublicKey,
                newMlDsaPublicKey: rivalKey.mlDsaPublicKey,
                lastRosterVersion: 1,
                lastRosterDigest: await rosterDigest(h.rosters[0]!.statement),
                signerUserId: holder.userId,
            }),
            h.keys[0]!,
            holder,
        );
        const marked = { pins: [pin], firstKeysChecked: false };
        expect(
            (await acceptedOf(h, people, { ...marked, successions: [...h.successions, early] }))
                .roster.rosterVersion,
        ).toBe(3);
        // Without the real succession (withheld), the mark (here a pin from a device at 2 that took
        // it) is never met: a rollback, refused, never the warning.
        const atTwo = await pinAfter(
            [],
            await acceptedOf(h, people, { rosters: h.rosters.slice(0, 2) }),
            CHECKED,
        );
        await expect(
            acceptRosters(
                inputOf(h, people, {
                    pins: [atTwo],
                    firstKeysChecked: false,
                    rosters: h.rosters.slice(0, 2),
                    successions: [early],
                }),
            ),
        ).rejects.toThrow('older member list');
        // A roster under the real key 2 while only the rival is served: the succession is missing.
        await expect(
            acceptRosters(inputOf(h, people, { ...marked, successions: [early] })),
        ).rejects.toThrow('succession is missing');
        // A roster a holder signed under the rival key: a real other history the person's mark
        // contradicts, the warning.
        const underRival = await signRoster(
            {
                ...h.statements[2]!,
                members: sortedMembers([own, holder.entry(['members'], 1, 'left')]),
            },
            await groupKeyAt(7),
            organizer.signer,
        );
        forkOf(
            await acceptRosters(
                inputOf(h, people, {
                    ...marked,
                    rosters: [...h.rosters.slice(0, 2), underRival],
                    successions: [early],
                }),
            ),
            'group-key',
            2,
            [
                { digest: pin.groupKeyDigest, from: ['pin'], signerUserId: null },
                {
                    digest: await groupKeyDigest(rivalKey),
                    from: ['served'],
                    signerUserId: holder.userId,
                },
            ],
        );
        // Under the rival key, but signed by the removed holder (no longer a holder at roster 2):
        // nothing a holder signed, so a refusal, never the warning.
        const byRemoved = await signRoster(
            { ...h.statements[2]!, signerUserId: holder.userId },
            await groupKeyAt(7),
            holder.signer,
        );
        await expect(
            acceptRosters(
                inputOf(h, people, {
                    ...marked,
                    rosters: [...h.rosters.slice(0, 2), byRemoved],
                    successions: [early],
                }),
            ),
        ).rejects.toThrow('succession is missing');
        // A newcomer, with no mark to choose: the rival is taken at 1 and roster 2 is under a replaced key.
        await expect(
            acceptRosters(inputOf(h, people, { successions: [...h.successions, early] })),
        ).rejects.toThrow('has been replaced');
    });

    test('a succession that does not hold is ignored: the one that does is taken, or the key is missing; one tied too early stalls', async () => {
        const f = await family();
        const other = (await groupKeyAt(8)).publicKey;
        const keys = {
            newEd25519PublicKey: other.ed25519PublicKey,
            newMlDsaPublicKey: other.mlDsaPublicKey,
        };
        const cases: [SignedGroupStatement, string][] = [
            [await rewritten(f, keys, null), 'not signed by the member it names'],
            // p4b: in order and tied to the real roster, by the holder who is gone by then.
            [
                await rewritten(f, { ...keys, signerUserId: f.holder.userId }, f.holder),
                'not signed by a member who holds',
            ],
            [
                await rewritten(f, {
                    ...keys,
                    lastRosterDigest: await rosterDigest(f.h.rosters[1]!.statement),
                }),
                'not tied to a roster',
            ],
            [
                await rewritten(f, {
                    oldEd25519PublicKey: other.ed25519PublicKey,
                    oldMlDsaPublicKey: other.mlDsaPublicKey,
                }),
                'not signed by the key it replaces',
            ],
            // Signed by this group's key and holder, but for another group.
            [
                await rewritten(f, { ...keys, groupId: OTHER_GROUP }),
                'not signed by the key it replaces',
            ],
            // A "new" key that is the old one.
            [
                await rewritten(f, {
                    newEd25519PublicKey: f.h.keys[0]!.publicKey.ed25519PublicKey,
                    newMlDsaPublicKey: f.h.keys[0]!.publicKey.mlDsaPublicKey,
                }),
                'does not replace the key with a new one',
            ],
        ];
        for (const [rival, why] of cases) {
            expect(
                (await accepted(newcomer(f, { successions: [...f.h.successions, rival] })))
                    .groupKeyVersion,
            ).toBe(2);
            await expect(acceptRosters(newcomer(f, { successions: [rival] }))).rejects.toThrow(why);
        }
        await expect(acceptRosters(newcomer(f, { successions: [] }))).rejects.toThrow(
            'succession is missing',
        );
        // Tied to version 2, though version 3 was then signed under key 1: it holds when roster 2
        // is reached, and roster 3 does not (F4; the server must not store it).
        const early = await rewritten(f, {
            ...keys,
            lastRosterVersion: 2,
            lastRosterDigest: await rosterDigest(f.h.rosters[1]!.statement),
        });
        for (const successions of [[...f.h.successions, early], [early]])
            await expect(acceptRosters(newcomer(f, { successions }))).rejects.toThrow(
                'has been replaced',
            );
    });

    test('P4: a former holder of an old key gets nothing from a roster or succession under it', async () => {
        const { organizer, adult, holder, outsider } = await cast();
        const h = await history();
        await h.roster(organizer, [organizer.entry(OWNER), holder.entry(['members'])]);
        await h.roster(organizer, [organizer.entry(OWNER), holder.entry(['members'], 2, 'left')]);
        await h.succession(organizer);
        for (let i = 0; i < 4; i++)
            await h.roster(
                organizer,
                [
                    organizer.entry(OWNER),
                    holder.entry(['members'], 2, 'left'),
                    adult.entry(i % 2 ? ['billing'] : []),
                ],
                2,
            );
        const far = await signedBy(
            groupSuccessionStatement({
                ...parseGroupSuccession(h.successions[0]!.statement),
                lastRosterVersion: 100,
                signerUserId: holder.userId,
            }),
            h.keys[0]!,
            null,
        );
        const people = [organizer, outsider];
        expect(
            (await acceptedOf(h, people, { successions: [...h.successions, far] })).groupKeyVersion,
        ).toBe(2);
        // Another roster 6 under key 1, by them or by anyone: two latest rosters, refused; at an
        // older version beside the chain, a dead branch.
        const rival = await signedBy(
            rosterStatement({
                ...h.statements[5]!,
                groupKeyVersion: 1,
                signerUserId: holder.userId,
                members: sortedMembers([
                    organizer.entry(OWNER),
                    { ...outsider.entry(['members'], 6), userId: holder.userId },
                ]),
            }),
            h.keys[0]!,
            outsider,
        );
        await expect(
            acceptRosters(inputOf(h, people, { rosters: [...h.rosters, rival] })),
        ).rejects.toThrow('more than one latest');
        await h.roster(
            organizer,
            [organizer.entry(OWNER), holder.entry(['members'], 2, 'left'), adult.entry([])],
            2,
        );
        expect(
            (await acceptedOf(h, people, { rosters: [...h.rosters, rival] })).deadBranches,
        ).toEqual([{ version: 6, signerUserId: holder.userId }]);
    });

    test('a roster signed by a key after its succession is refused', async () => {
        const f = await family();
        const late = await signRoster(
            {
                ...f.h.statements[3]!,
                rosterVersion: 5,
                previousRosterDigest: await rosterDigest(f.h.rosters[3]!.statement),
                groupKeyVersion: 1,
            },
            f.h.keys[0]!,
            f.organizer.signer,
        );
        await expect(
            acceptRosters(newcomer(f, { rosters: [...f.h.rosters, late] })),
        ).rejects.toThrow('has been replaced');
        const h = await history();
        const owner = f.organizer.entry(OWNER);
        await h.roster(f.organizer, [owner]);
        await h.roster(f.organizer, [owner, f.adult.entry([], 2)]);
        await h.succession(f.organizer);
        await h.roster(f.organizer, [owner, f.adult.entry([], 2), f.child.entry([], 3)], 1);
        await expect(acceptRosters(inputOf(h, [f.organizer]))).rejects.toThrow('has been replaced');
    });

    test('a roster after a `members` holder’s removal without a succession is refused', async () => {
        const f = await family();
        const h = await history();
        const owner = f.organizer.entry(OWNER);
        await h.roster(f.organizer, [owner, f.adult.entry([]), f.holder.entry(['members'])]);
        await h.roster(f.organizer, [
            owner,
            f.adult.entry([]),
            f.holder.entry(['members'], 2, 'left'),
        ]);
        expect((await accepted(inputOf(h, [f.organizer]))).successionDue).toBe(true);
        await h.roster(f.organizer, [
            owner,
            f.adult.entry(['members'], 3),
            f.holder.entry(['members'], 2, 'left'),
        ]);
        await expect(acceptRosters(inputOf(h, [f.organizer]))).rejects.toThrow(
            'must be replaced first',
        );
        const g = await history();
        await g.roster(f.organizer, [owner, f.holder.entry(['members'])]);
        await g.roster(f.organizer, [owner, f.holder.entry([], 2)]);
        await g.roster(f.organizer, [owner, f.holder.entry([], 2), f.adult.entry([], 3)]);
        await expect(acceptRosters(inputOf(g, [f.organizer]))).rejects.toThrow(
            'must be replaced first',
        );
    });

    test('successions are tied in order: one tied before the one into its key does not hold', async () => {
        const { organizer, adult } = await cast();
        const h = await history();
        await h.roster(organizer, [organizer.entry(OWNER), adult.entry([])]);
        await h.roster(organizer, [organizer.entry(OWNER), adult.entry(['billing'])]);
        await h.succession(organizer);
        const third = (await groupKeyAt(3)).publicKey;
        const early = await signedBy(
            groupSuccessionStatement({
                groupId: GROUP,
                oldVersion: 2,
                newVersion: 3,
                oldEd25519PublicKey: h.keys[1]!.publicKey.ed25519PublicKey,
                oldMlDsaPublicKey: h.keys[1]!.publicKey.mlDsaPublicKey,
                newEd25519PublicKey: third.ed25519PublicKey,
                newMlDsaPublicKey: third.mlDsaPublicKey,
                lastRosterVersion: 1,
                lastRosterDigest: await rosterDigest(h.rosters[0]!.statement),
                signerUserId: organizer.userId,
            }),
            h.keys[1]!,
            organizer,
        );
        expect(
            (await acceptedOf(h, [organizer], { successions: [...h.successions, early] }))
                .groupKeyVersion,
        ).toBe(2);
        // A roster under key 3 needs it: the real 2 -> 3 is withheld and the early one does not hold.
        await h.succession(organizer);
        await h.roster(organizer, [organizer.entry(OWNER), adult.entry([])], 3);
        await expect(
            acceptRosters(inputOf(h, [organizer], { successions: [h.successions[0]!, early] })),
        ).rejects.toThrow('out of order');
        // A pin's key version is never taken back.
        const chain = await acceptedOf(h, [organizer], { rosters: h.rosters.slice(0, 2) });
        await expect(
            acceptRosters(
                inputOf(h, [organizer], {
                    pins: [await pinAfter([], chain, CHECKED)],
                    rosters: h.rosters.slice(0, 2),
                    successions: [],
                }),
            ),
        ).rejects.toThrow('older member list');
    });
});

describe('the device’s cache', () => {
    test('continuing from the cache gives the chain verifying from version 1 gives', async () => {
        const f = await family();
        const three = await acceptedTo(f.h, 3, f.all);
        const fast = await accepted(
            newcomer(f, {
                cache: three.cache,
                rosters: [f.h.rosters[3]!],
                firstKeysChecked: false,
            }),
        );
        const full = await accepted(newcomer(f));
        expect(fast.cache).toEqual(full.cache);
        expect(fast.roster).toEqual(full.roster);
        expect((await accepted(newcomer(f, { cache: full.cache, rosters: [] }))).cache).toEqual(
            full.cache,
        );
    });

    test('the cache is the person’s mark: a chain off it is the warning, a succession off it is ignored', async () => {
        const f = await family();
        const two = await acceptedTo(f.h, 2, f.all);
        const four = await accepted(newcomer(f));
        const rivalKey = (await groupKeyAt(8)).publicKey;
        const rival = await signedBy(
            groupSuccessionStatement({
                ...parseGroupSuccession(f.h.successions[0]!.statement),
                newEd25519PublicKey: rivalKey.ed25519PublicKey,
                newMlDsaPublicKey: rivalKey.mlDsaPublicKey,
            }),
            f.h.keys[0]!,
            f.organizer,
        );
        expect(
            (await accepted(newcomer(f, { cache: four.cache, rosters: [], successions: [rival] })))
                .groupKey,
        ).toEqual(f.h.keys[1]!.publicKey);
        // A pin at a version the cache holds that names another roster.
        const other = await resigned(f, 2, {
            members: [f.organizer.entry(OWNER), f.adult.entry([]), f.outsider.entry([], 2)],
        });
        const otherDigest = await rosterDigest(other.statement);
        const elsewhere = { ...(await pinOf(f.h, 2, f.all)), rosterDigest: otherDigest };
        forkOf(
            await acceptRosters(
                newcomer(f, { cache: two.cache, rosters: f.h.rosters.slice(2), pins: [elsewhere] }),
            ),
            'roster',
            2,
            [
                { digest: otherDigest, from: ['pin'], signerUserId: null },
                { digest: two.rosterDigest, from: ['cache'], signerUserId: f.organizer.userId },
            ],
        );
        // A cache of the other roster 2, and the chain served from 1.
        const g = await history();
        await g.roster(f.organizer, [f.organizer.entry(OWNER), f.adult.entry([])]);
        await g.roster(f.organizer, [
            f.organizer.entry(OWNER),
            f.adult.entry([]),
            f.outsider.entry([], 2),
        ]);
        const theirs = await acceptedTo(g, 2, f.all);
        forkOf(await acceptRosters(newcomer(f, { cache: theirs.cache })), 'roster', 2, [
            { digest: theirs.rosterDigest, from: ['cache'], signerUserId: f.organizer.userId },
            { digest: two.rosterDigest, from: ['served'], signerUserId: f.organizer.userId },
        ]);
        // Rosters after it that do not link to its last roster, signed or not (p7): no warning,
        // fetch the chain again from version 1, where the cache is a mark.
        const branch = await resigned(f, 3, {
            previousRosterDigest: encode(new Uint8Array(32).fill(7)),
        });
        const unsigned = {
            ...branch,
            signature: { ed25519: new Uint8Array(64), mlDsa: new Uint8Array(3309) },
            signerSignature: new Uint8Array(3373),
        };
        for (const rosters of [[branch], [unsigned]])
            await expect(acceptRosters(newcomer(f, { cache: two.cache, rosters }))).rejects.toThrow(
                'fetch it again from version 1',
            );
        // A cache that verified the rival group key, and the chain served from 1.
        const sawRival = await accepted(
            newcomer(f, { rosters: f.h.rosters.slice(0, 3), successions: [rival] }),
        );
        forkOf(await acceptRosters(newcomer(f, { cache: sawRival.cache })), 'group-key', 2, [
            {
                digest: await groupKeyDigest(rivalKey),
                from: ['cache'],
                signerUserId: f.organizer.userId,
            },
            { digest: four.groupKeyDigest, from: ['served'], signerUserId: f.organizer.userId },
        ]);
        // Rosters from the middle with a cache are neither extension nor whole chain.
        await expect(
            acceptRosters(newcomer(f, { cache: two.cache, rosters: f.h.rosters.slice(1) })),
        ).rejects.toThrow('does not follow the last one');
    });

    test('a chain taking back a group key the cache verified is a rollback', async () => {
        const f = await family();
        const three = await accepted(newcomer(f, { rosters: f.h.rosters.slice(0, 3) }));
        expect(three.groupKeyVersion).toBe(2);
        await expect(
            acceptRosters(
                newcomer(f, {
                    cache: three.cache,
                    rosters: f.h.rosters.slice(0, 3),
                    successions: [],
                }),
            ),
        ).rejects.toThrow('older member list');
    });

    test('probes 3a-3c: a cache outside its form, of another group, or not through its roster is refused', async () => {
        const f = await family();
        const { cache } = await acceptedTo(f.h, 2, f.all);
        const rest = f.h.rosters.slice(2);
        const set = {
            encryptionPublicKey: f.adult.served.encryptionPublicKey,
            signingPublicKey: f.adult.served.signingPublicKey,
            mlDsaPublicKeyDigest: f.adult.mlDsaDigest,
        };
        const broken: unknown[] = [
            { ...cache, keyHistory: { [f.adult.userId]: [{ ...set, signingPublicKey: 'nope' }] } },
            { ...cache, keyHistory: { [f.adult.userId]: set } },
            { ...cache, keyHistory: { [f.adult.userId.toUpperCase()]: [] } },
            { ...cache, keyHistory: { [f.adult.userId]: [set, set] } },
            { ...cache, groupId: OTHER_GROUP },
            { ...cache, rosterDigests: [cache.rosterDigests[0]!, cache.rosterDigests[0]!] },
            { ...cache, rosterDigests: [cache.rosterDigests[0]!] },
            { ...cache, rosterDigests: [cache.rosterDigests[1]!] },
            { ...cache, statement: encode(f.h.rosters[0]!.statement) },
            { ...cache, groupKeys: [] },
            {
                ...cache,
                successions: [
                    {
                        lastRosterVersion: 1,
                        digest: cache.rosterDigests[0],
                        signerUserId: f.organizer.userId,
                    },
                ],
            },
            { ...cache, ownEntryWrongAt: [3] },
            { ...cache, droppedHolder: 'no' },
            { ...cache, creatorUserId: 'someone' },
        ];
        for (const value of broken)
            await expect(
                acceptRosters(newcomer(f, { cache: value as typeof cache, rosters: rest })),
            ).rejects.toThrow('Invalid member list cache.');
        await expect(
            acceptRosters(
                newcomer(f, { cache, rosters: rest, firstKeys: (await groupKeyAt(7)).publicKey }),
            ),
        ).rejects.toThrow('not the group keys whose words were checked');
        // A cache through 4, given nothing to extend it with: it alone must hold together.
        const { cache: four } = await accepted(newcomer(f));
        const foreign = await resigned(f, 4, { groupId: OTHER_GROUP });
        for (const value of [
            { ...four, groupKeys: four.groupKeys.slice(0, 1), successions: [] },
            { ...four, successions: [{ ...four.successions[0]!, lastRosterVersion: 99 }] },
            {
                ...four,
                statement: encode(foreign.statement),
                rosterDigests: [
                    ...four.rosterDigests.slice(0, 3),
                    await rosterDigest(foreign.statement),
                ],
            },
        ])
            await expect(acceptRosters(newcomer(f, { cache: value, rosters: [] }))).rejects.toThrow(
                'Invalid member list cache.',
            );
    });
});

/* The person's served identity with `change`, its keys statement signed again by `signer`. */
async function reSigned(
    who: Person,
    change: Partial<ServedIdentity>,
    signer: { signingKey: Uint8Array; mlDsaSecretKey: Uint8Array },
): Promise<ServedIdentity> {
    const { keysSignature: _, ...keys } = { ...who.served, ...change };
    return {
        ...keys,
        keysSignature: encode(
            await signHybrid(await keysStatement({ userId: who.userId, ...keys }), signer),
        ),
    };
}

describe('folding in changes', () => {
    test('a new member’s entry comes only from the keys their words check confirmed', async () => {
        const { adult, outsider } = await cast();
        const pin = await adult.pin();
        expect(
            await newRosterEntry(pin, adult.served, {
                roles: ['members', 'billing'],
                rosterVersion: 4,
            }),
        ).toEqual(adult.entry(['billing', 'members'], 4));
        await expect(
            newRosterEntry(
                pin,
                { ...adult.served, kemPublicKey: outsider.served.kemPublicKey },
                { roles: [], rosterVersion: 4 },
            ),
        ).rejects.toThrow('not the keys whose words were checked');
        await expect(
            newRosterEntry(
                pin,
                await reSigned(adult, { kemPublicKey: outsider.served.kemPublicKey }, adult.signer),
                { roles: [], rosterVersion: 4 },
            ),
        ).rejects.toThrow('not the keys whose words were checked');
        await expect(
            newRosterEntry(
                { ...pin, fingerprint: '0000 0000 0000 0000 0000 0000 0000 0000 0000 0000' },
                adult.served,
                { roles: [], rosterVersion: 4 },
            ),
        ).rejects.toThrow('not the keys whose words were checked');
        // The words-checked keys, with a keys statement the adult never signed.
        await expect(
            newRosterEntry(
                pin,
                { ...adult.served, keysSignature: outsider.served.keysSignature },
                { roles: [], rosterVersion: 4 },
            ),
        ).rejects.toThrow('not the keys whose words were checked');
    });

    test('an identity change is followed only through its succession chain, from the entry’s keys at any key version', async () => {
        const { adult, outsider } = await cast();
        const { next: adult2, link: first } = await succeed(adult);
        const { next: adult3, link: second } = await succeed(adult2);
        const entry = adult.entry([], 2);
        expect(await foldInEntry(entry, adult2.served, [first], 5)).toEqual({
            entry: adult2.entry([], 5),
            changed: true,
            needsCheck: false,
        });
        expect(await foldInEntry(entry, adult3.served, [first, second], 5)).toEqual({
            entry: adult3.entry([], 5),
            changed: true,
            needsCheck: false,
        });
        expect(
            (await foldInEntry({ ...entry, keyVersion: 1000 }, adult2.served, [first], 5)).changed,
        ).toBe(true);
        const forgedLink = {
            ...first,
            signature: encode(new Uint8Array(decode(first.signature).length)),
            consent: encode(new Uint8Array(2 * 3373)),
        };
        // r9 (Opus 3): fold-in walks from the entry's keys, where consent buys nothing: the
        // version 2 link alone folds the identity in, as it did before round 8.
        const { consent: _, ...oneSided } = first;
        expect((await foldInEntry(entry, adult2.served, [oneSided], 5)).changed).toBe(true);
        for (const [served, links] of [
            [adult2.served, []],
            [{ ...outsider.served, keyVersion: 2 }, [first]],
            [adult2.served, [forgedLink]],
            [await reSigned(adult2, {}, outsider.signer), [first]],
        ] as const)
            expect(await foldInEntry(entry, served, [...links], 5)).toEqual({
                entry,
                changed: false,
                needsCheck: true,
            });
        expect(await foldInEntry(entry, adult.served, [], 5)).toEqual({
            entry,
            changed: false,
            needsCheck: false,
        });
    });

    test('the next roster is chained, sorted and canonical, sets sinceVersion itself; a member checks their own entry', async () => {
        const f = await family();
        const chain = await accepted(newcomer(f));
        const roster = await nextRoster(
            chain,
            [
                { ...f.holder.entry(['members'], 3, 'left'), sinceVersion: 4 },
                { ...f.adult.entry(['members', 'billing']), sinceVersion: 1 },
                { ...f.organizer.entry(OWNER), sinceVersion: 99 },
            ],
            { signerUserId: f.organizer.userId },
        );
        expect(roster.rosterVersion).toBe(5);
        expect(roster.groupKeyVersion).toBe(2);
        expect(roster.members.map((m) => m.userId)).toEqual([
            f.organizer.userId,
            f.adult.userId,
            f.holder.userId,
        ]);
        expect(roster.members[1]!.roles).toEqual(['billing', 'members']);
        expect(Object.fromEntries(roster.members.map((m) => [m.userId, m.sinceVersion]))).toEqual({
            [f.organizer.userId]: 1,
            [f.adult.userId]: 5,
            [f.holder.userId]: 3,
        });
        expect(await ownEntry(roster, { userId: f.adult.userId, ...f.adult.served })).toBe('ok');
        expect(await ownEntry(roster, { userId: f.outsider.userId, ...f.outsider.served })).toBe(
            'absent',
        );
        expect(await ownEntry(roster, { userId: f.adult.userId, ...f.outsider.served })).toBe(
            'wrong',
        );
        expect(droppedHolders(f.h.statements[1]!, [f.organizer.userId])).toEqual([f.holder.userId]);
        expect(droppedHolders(f.h.statements[1]!, [f.organizer.userId, f.holder.userId])).toEqual(
            [],
        );
        expect(droppedHolders(f.h.statements[2]!, [f.organizer.userId])).toEqual([]);
    });

    test('“Trust as Acme does” writes a version 3 pin with the roster’s ML-DSA and ML-KEM digests', async () => {
        const f = await family();
        const { adult, outsider } = f;
        const chain = await accepted(newcomer(f));
        const contact = { email: 'a@example.com', name: 'A', pinnedAt: CHECKED };
        const pin = await trustAsGroupDoes(chain, adult.userId, adult.served, contact);
        expect(await pinVerified(pin)).toBe(true);
        expect(pin.mlDsaPublicKeyHash).toBe(await keyDigest(adult.mlDsaPublicKey));
        expect(pin.kemPublicKeyHash).toBe(await keyDigest(adult.kemPublicKey));
        expect(pin).toEqual({
            ...(await adult.pin()),
            email: 'a@example.com',
            name: 'A',
            trustedVia: GROUP,
        });
        // r11 (Opus 2): a pin the group vouched for admits no one; the same keys after a words
        // check do.
        await expect(
            newRosterEntry(pin, adult.served, { roles: [], rosterVersion: 9 }),
        ).rejects.toThrow('whose words were checked');
        const { trustedVia: _, ...checked } = pin;
        expect(
            (await newRosterEntry(checked, adult.served, { roles: [], rosterVersion: 9 })).userId,
        ).toBe(adult.userId);
        await expect(
            trustAsGroupDoes(
                chain,
                adult.userId,
                { ...adult.served, mlDsaPublicKey: outsider.served.mlDsaPublicKey },
                contact,
            ),
        ).rejects.toThrow('not the keys on the group’s member list');
        const forged = await reSigned(
            adult,
            { mlDsaPublicKey: outsider.served.mlDsaPublicKey },
            { signingKey: adult.signer.signingKey, mlDsaSecretKey: outsider.signer.mlDsaSecretKey },
        );
        await expect(trustAsGroupDoes(chain, adult.userId, forged, contact)).rejects.toThrow(
            'not the keys on the group’s member list',
        );
        // The entry's very keys, with a keys statement the adult never signed.
        const unsigned = { ...adult.served, keysSignature: outsider.served.keysSignature };
        await expect(trustAsGroupDoes(chain, adult.userId, unsigned, contact)).rejects.toThrow(
            'not the keys on the group’s member list',
        );
        await expect(
            trustAsGroupDoes(chain, f.holder.userId, f.holder.served, contact),
        ).rejects.toThrow('not the keys on the group’s member list');
    });
});

describe('scoped verdicts', () => {
    const NODE = '0e0e0e0e-0e0e-4e0e-8e0e-0e0e0e0e0e0e';
    const envelope = new Uint8Array(96).fill(5);
    const statementIn = (workspaceId: string) => ({
        workspaceId,
        nodeId: NODE,
        kind: 'file' as const,
        metadataVersion: 1,
    });
    const signedRecord = async (signingKey: Uint8Array, workspaceId = AREA) =>
        signStatement(await metadataStatement(statementIn(workspaceId), envelope), signingKey);

    /* The verdict for `writer`'s record; their served identity and links loaded (none) unless `over` says otherwise. */
    async function verdictIn(
        chain: AcceptedRosters,
        writer: Person,
        over: Partial<Parameters<typeof groupWriterTrust>[0]> = {},
        workspaceId = AREA,
        signature?: Uint8Array,
    ) {
        const trust = await groupWriterTrust({
            groupId: GROUP,
            areas: { [AREA]: 1 },
            reading: { status: 'accepted', chain },
            workspaceId,
            writerUserId: writer.userId,
            pinned: null,
            served: writer.served,
            links: [],
            ...over,
        });
        return groupIntegrityOf(
            () => metadataStatements(statementIn(workspaceId), envelope),
            signature ?? (await signedRecord(writer.signer.signingKey, workspaceId)),
            trust,
            null,
        );
    }

    async function setting() {
        const f = await family();
        const chain = await accepted(newcomer(f));
        const verdict = (
            who: Person,
            over: Partial<Parameters<typeof groupWriterTrust>[0]> = {},
            workspaceId = AREA,
            signature?: Uint8Array,
        ) => verdictIn(chain, who, over, workspaceId, signature);
        return { ...f, chain, verdict };
    }

    test('roster trust gives `verified` inside the group’s areas and nothing outside them', async () => {
        const { adult, outsider, verdict } = await setting();
        expect(await verdict(adult)).toEqual({ integrity: 'verified', via: GROUP });
        expect(await verdict(adult, {}, OTHER_AREA)).toEqual({
            integrity: 'unknown-signer',
            via: null,
        });
        expect(
            await verdict(adult, {}, AREA, await signedRecord(outsider.signer.signingKey)),
        ).toEqual({ integrity: 'bad-signature', via: null });
        expect(await verdict(outsider)).toEqual({ integrity: 'unknown-signer', via: null });
    });

    test('probes 4, 4b, and 7: a forged or bit-flipped record reads bad; with the writer’s chain not loaded, unchecked', async () => {
        const f = await family();
        const chain = await accepted(newcomer(f, { pins: [await pinOf(f.h, 4, f.all)] }));
        const real = await signedRecord(f.adult.signer.signingKey);
        const flipped = real.slice();
        flipped[0]! ^= 1;
        for (const signature of [flipped, await signedRecord(f.outsider.signer.signingKey)]) {
            expect(await verdictIn(chain, f.adult, {}, AREA, signature)).toEqual({
                integrity: 'bad-signature',
                via: null,
            });
            for (const over of [{ served: null }, { links: null }])
                expect(await verdictIn(chain, f.adult, over, AREA, signature)).toEqual({
                    integrity: 'unchecked',
                    via: null,
                });
        }
        // A record their roster key holds reads verified whether or not the chain loaded.
        expect(await verdictIn(chain, f.adult, { served: null, links: null })).toEqual({
            integrity: 'verified',
            via: GROUP,
        });
    });

    test('a personal pin that agrees reads as personally verified', async () => {
        const { adult, verdict } = await setting();
        expect(await verdict(adult, { pinned: await adult.pinned() })).toEqual({
            integrity: 'verified',
            via: null,
        });
    });

    test('a legitimate identity succession is followed, not reported as a key conflict', async () => {
        const f = await family();
        const { next, link } = await succeed(f.adult);
        let chain = await accepted(newcomer(f));
        const roster5 = await nextRoster(
            chain,
            [f.organizer.entry(OWNER), next.entry([], 5), f.holder.entry(['members'], 3, 'left')],
            { signerUserId: f.organizer.userId },
        );
        f.h.rosters.push(await signRoster(roster5, f.h.keys[1]!, f.organizer.signer));
        chain = await accepted(newcomer(f));
        const over = { pinned: await f.adult.pinned(), served: next.served, links: [link] };
        expect(await verdictIn(chain, next, over)).toEqual({ integrity: 'verified', via: GROUP });
        const trust = await groupWriterTrust({
            groupId: GROUP,
            areas: { [AREA]: 1 },
            reading: { status: 'accepted', chain },
            workspaceId: AREA,
            writerUserId: next.userId,
            ...over,
        });
        expect(trust.trust === 'roster' && trust.followed).toEqual(next.served);
        expect(
            await verdictIn(chain, next, over, AREA, await signedRecord(f.adult.signer.signingKey)),
        ).toEqual({ integrity: 'retired-key', via: null });
        expect(await verdictIn(chain, next, { ...over, links: [] })).toEqual({
            integrity: 'key-conflict',
            via: null,
        });
    });

    test('probes 2a, 2b: a writer whose succession no roster has folded in yet reads as themselves', async () => {
        const f = await setting();
        const { next: adult2, link } = await succeed(f.adult);
        const newKey = await signedRecord(adult2.signer.signingKey);
        const lag = { served: adult2.served, links: [link] };
        expect(await f.verdict(f.adult, lag, AREA, newKey)).toEqual({
            integrity: 'verified',
            via: GROUP,
        });
        expect(await f.verdict(f.adult, lag)).toEqual({ integrity: 'retired-key', via: null });
        expect(
            await f.verdict(f.adult, { ...lag, pinned: await adult2.pinned() }, AREA, newKey),
        ).toEqual({ integrity: 'verified', via: null });
        const oldPin = { ...lag, pinned: await f.adult.pinned() };
        expect(await f.verdict(f.adult, oldPin, AREA, newKey)).toEqual({
            integrity: 'verified',
            via: null,
        });
        const trust = await groupWriterTrust({
            groupId: GROUP,
            areas: { [AREA]: 1 },
            reading: { status: 'accepted', chain: f.chain },
            workspaceId: AREA,
            writerUserId: f.adult.userId,
            ...oldPin,
        });
        expect(trust.trust === 'roster' && trust.followed).toEqual(adult2.served);
        // Their own served identity with no links: the new key is no one's.
        expect(await f.verdict(f.adult, {}, AREA, newKey)).toEqual({
            integrity: 'bad-signature',
            via: null,
        });
        expect(await f.verdict(f.adult, { served: null, links: null }, AREA, newKey)).toEqual({
            integrity: 'unchecked',
            via: null,
        });
        const forgedLink = {
            ...link,
            signature: encode(new Uint8Array(decode(link.signature).length)),
            consent: encode(new Uint8Array(2 * 3373)),
        };
        expect(await f.verdict(f.adult, { ...lag, links: [forgedLink] }, AREA, newKey)).toEqual({
            integrity: 'bad-signature',
            via: null,
        });
        // r9 (Opus 3): the real version 2 link without the successor's consent holds on the
        // roster-lag walk, which starts at the entry's keys, never at keys a holder planted.
        const { consent: _, ...oneSided } = link;
        expect(await f.verdict(f.adult, { ...lag, links: [oneSided] }, AREA, newKey)).toEqual({
            integrity: 'verified',
            via: GROUP,
        });
        const { next: adult3, link: second } = await succeed(adult2);
        expect(
            await f.verdict(f.adult, { served: adult3.served, links: [link] }, AREA, newKey),
        ).toEqual({ integrity: 'bad-signature', via: null });
        const two = { served: adult3.served, links: [link, second] };
        expect(
            await f.verdict(f.adult, two, AREA, await signedRecord(adult3.signer.signingKey)),
        ).toEqual({ integrity: 'verified', via: GROUP });
        expect(await f.verdict(f.adult, two, AREA, newKey)).toEqual({
            integrity: 'retired-key',
            via: null,
        });
    });

    test('a chain from the pin to keys the roster does not name is still a key conflict', async () => {
        const f = await setting();
        const { next: second } = await succeed(f.adult);
        const { next: third, link } = await succeed(second);
        expect(
            await f.verdict(f.adult, {
                pinned: await second.pinned(),
                served: third.served,
                links: [link],
            }),
        ).toEqual({ integrity: 'key-conflict', via: null });
    });

    test('a disagreeing pin is a key conflict, and unchecked when what it needs did not load', async () => {
        const { adult, outsider, verdict } = await setting();
        const pinned = await outsider.pinned();
        expect(await verdict(adult, { pinned })).toEqual({ integrity: 'key-conflict', via: null });
        expect(await verdict(adult, { pinned, served: null })).toEqual({
            integrity: 'unchecked',
            via: null,
        });
        expect(await verdict(adult, { pinned, links: null })).toEqual({
            integrity: 'unchecked',
            via: null,
        });
        const half = { ...(await adult.pinned()), mlDsaPublicKeyHash: pinned.mlDsaPublicKeyHash };
        expect(await verdict(adult, { pinned: half, served: null })).toEqual({
            integrity: 'unchecked',
            via: null,
        });
    });

    test('a former member’s writing is marked, never clean', async () => {
        const { holder, verdict } = await setting();
        expect(await verdict(holder)).toEqual({ integrity: 'former-member', via: null });
        expect(await verdict(holder, { pinned: await holder.pinned() })).toEqual({
            integrity: 'former-member',
            via: null,
        });
    });

    test('P1, F3: an earlier key reads retired only along the member’s own chain; a key a holder planted never', async () => {
        const { organizer, adult, outsider } = await cast();
        const { next: adult2, link } = await succeed(adult);
        const h = await history();
        await h.roster(organizer, [organizer.entry(OWNER), adult.entry([])]);
        await h.roster(organizer, [
            organizer.entry(OWNER),
            { ...outsider.entry([]), userId: adult.userId, keyVersion: 2 },
        ]);
        await h.roster(organizer, [organizer.entry(OWNER), adult2.entry([])]);
        const first = await acceptedTo(h, 2, [organizer]);
        await h.roster(organizer, [organizer.entry(OWNER), adult2.entry(['billing'])]);
        const chained = { served: adult2.served, links: [link] };
        for (const chain of [
            await acceptedOf(h, [organizer]),
            await acceptedOf(h, [organizer], { cache: first.cache, rosters: h.rosters.slice(2) }),
        ]) {
            expect(chain.keyHistory[adult.userId]!.map((s) => s.signingPublicKey)).toEqual([
                adult.served.signingPublicKey,
                outsider.served.signingPublicKey,
                adult2.served.signingPublicKey,
            ]);
            expect(
                await verdictIn(
                    chain,
                    adult2,
                    chained,
                    AREA,
                    await signedRecord(adult.signer.signingKey),
                ),
            ).toEqual({ integrity: 'retired-key', via: null });
            expect(
                await verdictIn(
                    chain,
                    adult2,
                    chained,
                    AREA,
                    await signedRecord(outsider.signer.signingKey),
                ),
            ).toEqual({ integrity: 'bad-signature', via: null });
            expect(await verdictIn(chain, adult2, chained)).toEqual({
                integrity: 'verified',
                via: GROUP,
            });
            // Without the links, the old key cannot be told from a planted one.
            expect(
                await verdictIn(
                    chain,
                    adult2,
                    { links: null },
                    AREA,
                    await signedRecord(adult.signer.signingKey),
                ),
            ).toEqual({ integrity: 'unchecked', via: null });
        }
    });

    test('r7: two successions the member signed from one key are an identity fork, unchecked whatever the order; a pin at the newer identity still retires the old key', async () => {
        const { organizer } = await cast();
        const member = await person(4);
        const h = await history();
        await h.roster(organizer, [organizer.entry(OWNER), member.entry([])]);
        const chain = await acceptedOf(h, [organizer, member]);
        const { next: member2, link } = await succeed(member);
        const byOld = await signedRecord(member.signer.signingKey);
        const byNew = await signedRecord(member2.signer.signingKey);
        const base = { served: member2.served, links: [link] };
        expect(await verdictIn(chain, member, { ...base, pinned: null }, AREA, byOld)).toEqual({
            integrity: 'retired-key',
            via: null,
        });
        // Pinned at the newer identity: the old key is still theirs, earlier on the chain to it.
        expect(
            await verdictIn(
                chain,
                member,
                { ...base, pinned: await member2.pinned() },
                AREA,
                byOld,
            ),
        ).toEqual({ integrity: 'retired-key', via: null });
        // A second successor the member signed from the same key (a race, or a retried upload).
        const other = await person(4, 9);
        const dangling = await linkBetween(member, other);
        for (const links of [
            [link, dangling],
            [dangling, link],
        ])
            for (const pinned of [null, await member.pinned()])
                expect(
                    await verdictIn(
                        chain,
                        member,
                        { served: member2.served, links, pinned },
                        AREA,
                        byNew,
                    ),
                ).toEqual({ integrity: 'unchecked', via: null });
        // The same link served twice is no fork.
        expect(
            await verdictIn(
                chain,
                member,
                { served: member2.served, links: [link, link], pinned: null },
                AREA,
                byNew,
            ),
        ).toEqual({ integrity: 'verified', via: GROUP });
    });

    test('r7: the group walk keeps the strict verifier’s version and served-key rules; a pin older than the member’s first keys retires from itself', async () => {
        const { organizer, outsider } = await cast();
        const member = await person(4);
        const { next: member2, link } = await succeed(member);
        const { next: member3, link: link23 } = await succeed(member2);
        const h = await history();
        await h.roster(organizer, [organizer.entry(OWNER), member.entry([])]);
        const chain = await acceptedOf(h, [organizer, member]);
        const byMember2 = await signedRecord(member2.signer.signingKey);
        const read = (served: ServedKeys, links: SuccessionLink[], record = byMember2) =>
            verdictIn(chain, member, { served, links, pinned: null }, AREA, record);
        expect(await read(servedKeysOf(member2), [link])).toEqual({
            integrity: 'verified',
            via: GROUP,
        });
        // The served identity with another ML-KEM key: no path, so the new key vouches for nothing.
        const bad = { integrity: 'bad-signature', via: null };
        expect(
            await read({ ...servedKeysOf(member2), kemPublicKey: outsider.served.kemPublicKey }, [
                link,
            ]),
        ).toEqual(bad);
        // r8: the served version is not signed, so a lower one decides nothing.
        expect(await read({ ...servedKeysOf(member2), keyVersion: 1 }, [link])).toEqual({
            integrity: 'verified',
            via: GROUP,
        });
        // A link whose old version falls below the one before it: the path stops there.
        const falling = await linkBetween(member2, member3, (f) => ({ ...f, oldKeyVersion: 1 }));
        const byMember3 = await signedRecord(member3.signer.signingKey);
        expect(await read(servedKeysOf(member3), [link, link23], byMember3)).toEqual({
            integrity: 'verified',
            via: GROUP,
        });
        expect(await read(servedKeysOf(member3), [link, falling], byMember3)).toEqual(bad);
        // A pin from before the member joined (their first keys on the chain are member2's): the
        // pinned key is theirs too, retired along the chain from the pin.
        const later = await history();
        await later.roster(organizer, [organizer.entry(OWNER), member2.entry([])]);
        const joined = await acceptedOf(later, [organizer, member2]);
        expect(
            await verdictIn(
                joined,
                member,
                {
                    served: servedKeysOf(member3),
                    links: [link, link23],
                    pinned: await member.pinned(),
                },
                AREA,
                await signedRecord(member.signer.signingKey),
            ),
        ).toEqual({ integrity: 'retired-key', via: null });
    });

    test('p1: only the links the succession chain verified retire keys; a fake link served in front retires nothing', async () => {
        const { organizer, adult, outsider } = await cast();
        const h = await history();
        await h.roster(organizer, [organizer.entry(OWNER), adult.entry([])]);
        const chain = await acceptedOf(h, [organizer]);
        const { next: adult2, link } = await succeed(adult);
        // The adult's old X25519 and Ed25519 keys, another ML-DSA key, the outsider's signing key
        // as the "new" one, and no valid signature: the verifier skips it, so must the retiring.
        const fake = {
            ...link,
            oldMlDsaPublicKey: outsider.served.mlDsaPublicKey,
            newSigningPublicKey: outsider.served.signingPublicKey,
            signature: encode(new Uint8Array(3373)),
        };
        const forged = await signedRecord(outsider.signer.signingKey);
        for (const pinned of [null, await adult.pinned()]) {
            for (const links of [[link], [fake, link]])
                expect(
                    await verdictIn(
                        chain,
                        adult,
                        { pinned, served: adult2.served, links },
                        AREA,
                        forged,
                    ),
                ).toEqual({ integrity: 'bad-signature', via: null });
            // Junk in front of, or after, the real link changes nothing (r6 p5).
            for (const links of [
                [fake, link],
                [link, fake],
                [link, { ...link, signature: encode(new Uint8Array(3373)) }],
            ])
                expect(
                    await verdictIn(
                        chain,
                        adult,
                        { pinned, served: adult2.served, links },
                        AREA,
                        await signedRecord(adult.signer.signingKey),
                    ),
                ).toEqual({ integrity: 'retired-key', via: null });
        }
    });

    test('p2: a planted key never reads retired, even with a link its planter signed: chains start only from the member’s first keys', async () => {
        const { organizer } = await cast();
        const adult = await person(2, 2);
        const insider = await person(3);
        const planted = await person(9);
        const { next: adult3, link: real } = await succeed(adult);
        const h = await history();
        const own = organizer.entry(OWNER);
        await h.roster(organizer, [own, adult.entry([]), insider.entry(['members'])]);
        await h.roster(insider, [
            own,
            { ...planted.entry([]), userId: adult.userId },
            insider.entry(['members']),
        ]);
        await h.roster(organizer, [own, adult3.entry([]), insider.entry(['members'])]);
        const chain = await acceptedOf(h, [organizer, insider]);
        // The insider holds the planted keys, so can sign a "succession" from them to the adult's.
        const fields = {
            oldKeyVersion: 1,
            newKeyVersion: 2,
            oldEncryptionPublicKey: planted.served.encryptionPublicKey,
            oldSigningPublicKey: planted.served.signingPublicKey,
            oldMlDsaPublicKey: planted.served.mlDsaPublicKey,
            newEncryptionPublicKey: adult.served.encryptionPublicKey,
            newSigningPublicKey: adult.served.signingPublicKey,
            newMlDsaPublicKey: adult.served.mlDsaPublicKey,
            newKemPublicKey: adult.served.kemPublicKey,
        };
        // Given the adult's consent as well (a test can sign it): this pins the first-keys rule
        // apart from the consent rule (round 8 F1 cases cover a link without it).
        const forgedLink = {
            ...fields,
            signature: encode(
                await signHybrid(
                    await successionStatement({ ...fields, userId: adult.userId }),
                    planted.signer,
                ),
            ),
            consent: await consentOf(fields, adult.userId, planted.signer, adult.signer),
        };
        const byPlanted = await signedRecord(planted.signer.signingKey);
        const loaded = { served: adult3.served, links: [forgedLink, real] };
        // Relying on the roster: chains start only from the adult's first keys, so the planted
        // set never starts one, link or no link.
        expect(await verdictIn(chain, adult3, loaded, AREA, byPlanted)).toEqual({
            integrity: 'bad-signature',
            via: null,
        });
        expect(
            await verdictIn(
                chain,
                adult3,
                loaded,
                AREA,
                await signedRecord(adult.signer.signingKey),
            ),
        ).toEqual({ integrity: 'retired-key', via: null });
        expect(
            await verdictIn(chain, adult3, { ...loaded, links: [real] }, AREA, byPlanted),
        ).toEqual({ integrity: 'bad-signature', via: null });
        // A personal pin retires only along the chain from itself: never the planted key.
        for (const pinned of [await adult3.pinned(), await adult.pinned()])
            expect(await verdictIn(chain, adult3, { ...loaded, pinned }, AREA, byPlanted)).toEqual({
                integrity: 'bad-signature',
                via: null,
            });
        // A pin at the adult's newer identity: their earlier keys on the verified chain up to it
        // (from their first keys) still read as retired; the planted ones never.
        expect(
            await verdictIn(
                chain,
                adult3,
                { ...loaded, pinned: await adult3.pinned() },
                AREA,
                await signedRecord(adult.signer.signingKey),
            ),
        ).toEqual({ integrity: 'retired-key', via: null });
        expect(
            await verdictIn(
                chain,
                adult3,
                { ...loaded, pinned: await adult.pinned() },
                AREA,
                await signedRecord(adult.signer.signingKey),
            ),
        ).toEqual({ integrity: 'retired-key', via: null });
    });

    test('a roster that fails to load is `unchecked`; a forked one falls back to personal checks', async () => {
        const { adult } = await setting();
        const reading = (r: GroupReading) =>
            groupWriterTrust({
                groupId: GROUP,
                areas: { [AREA]: 1 },
                reading: r,
                workspaceId: AREA,
                writerUserId: adult.userId,
                pinned: null,
                served: null,
                links: null,
            });
        expect(await reading({ status: 'unavailable' })).toEqual({ trust: 'unchecked' });
        expect(await reading({ status: 'fork' })).toEqual({ trust: 'outside' });
        // Another group's accepted chain says nothing about this one.
        const { chain } = await setting();
        expect(
            await groupWriterTrust({
                groupId: OTHER_GROUP,
                areas: { [AREA]: 1 },
                reading: { status: 'accepted', chain },
                workspaceId: AREA,
                writerUserId: adult.userId,
                pinned: null,
                served: null,
                links: null,
            }),
        ).toEqual({ trust: 'unchecked' });
    });
    test('r10 (Fable 6): a session’s verification cache carries across verdicts and holds only the links it verified', async () => {
        const f = await setting();
        const { next: adult2, link } = await succeed(f.adult);
        const lag = { served: adult2.served, links: [link] };
        const verified = new Map<string, boolean>();
        const newKey = await signedRecord(adult2.signer.signingKey);
        expect(await f.verdict(f.adult, { ...lag, verified }, AREA, newKey)).toEqual({
            integrity: 'verified',
            via: GROUP,
        });
        const size = verified.size;
        expect(size).toBeGreaterThan(0);
        // The same verdict again verifies nothing new.
        expect(await f.verdict(f.adult, { ...lag, verified }, AREA, newKey)).toEqual({
            integrity: 'verified',
            via: GROUP,
        });
        expect(verified.size).toBe(size);
        // A forged copy of the link it holds is its own entry, and refused.
        const forged = {
            ...link,
            signature: encode(new Uint8Array(decode(link.signature).length)),
            consent: encode(new Uint8Array(2 * 3373)),
        };
        expect(
            await f.verdict(f.adult, { ...lag, links: [forged], verified }, AREA, newKey),
        ).toEqual({ integrity: 'bad-signature', via: null });
    });
});

describe('chains across identity changes', () => {
    test('a `members` holder who replaces their identity mid-chain keeps signing, checked under each key in turn', async () => {
        const { organizer, adult, holder } = await cast();
        const { next: organizer2 } = await succeed(organizer);
        const h = await history();
        await h.roster(organizer, [organizer.entry(OWNER), holder.entry(['members'])]);
        await h.roster(organizer, [
            organizer.entry(OWNER),
            holder.entry(['members']),
            adult.entry([]),
        ]);
        await h.roster(holder, [
            organizer2.entry(OWNER),
            holder.entry(['members']),
            adult.entry([]),
        ]);
        await h.roster(organizer2, [
            organizer2.entry(OWNER),
            holder.entry(['members']),
            adult.entry(['billing']),
        ]);
        const chain = await acceptedOf(h, [organizer, organizer2, holder]);
        expect(chain.roster.rosterVersion).toBe(4);
        await expect(acceptRosters(inputOf(h, [organizer, holder]))).rejects.toThrow(
            'not signed by the member it names',
        );
        await expect(acceptRosters(inputOf(h, [organizer2, holder]))).rejects.toThrow(
            'not signed by the member it names',
        );
    });

    test('every roster whose entry for the reader names keys that are not theirs is reported, even if put right later', async () => {
        const { organizer, adult, outsider } = await cast();
        const h = await history();
        await h.roster(organizer, [organizer.entry(OWNER), adult.entry([])]);
        await h.roster(organizer, [
            organizer.entry(OWNER),
            { ...outsider.entry([]), userId: adult.userId, keyVersion: 2 },
        ]);
        const { next: adult2 } = await succeed(adult);
        await h.roster(organizer, [organizer.entry(OWNER), adult2.entry([])]);
        const chain = await acceptedOf(h, [organizer], {
            me: { userId: adult.userId, identities: [adult.served, adult2.served] },
        });
        expect(chain.ownEntryWrongAt).toEqual([2]);
        // An entry moved back to an identity the reader has replaced: reported too, though it is theirs.
        await h.roster(organizer, [organizer.entry(OWNER), adult.entry([])]);
        await h.roster(organizer, [organizer.entry(OWNER), adult2.entry(['billing'])]);
        const me = { userId: adult.userId, identities: [adult.served, adult2.served] };
        expect((await acceptedOf(h, [organizer], { me })).ownEntryWrongAt).toEqual([2, 4]);
        const three = await acceptedTo(h, 3, [organizer]);
        expect(
            (
                await acceptedOf(h, [organizer], {
                    me,
                    cache: { ...three.cache, ownEntryWrongAt: [2] },
                    rosters: h.rosters.slice(3),
                })
            ).ownEntryWrongAt,
        ).toEqual([2, 4]);
    });
});

describe('what only acceptRosters makes', () => {
    test('an accepted chain is frozen, and a copy of it opens and vouches for nothing', async () => {
        const f = await family();
        const chain = await accepted(newcomer(f));
        expect(() => {
            (chain as { roster: Roster }).roster = f.h.statements[0]!;
        }).toThrow(TypeError);
        expect(() => (chain.groupKeys as unknown as unknown[]).pop()).toThrow(TypeError);
        expect(() => (chain.roster.members as RosterMember[]).pop()).toThrow(TypeError);
        expect(() => {
            (chain.keyHistory as Record<string, unknown[]>)[f.adult.userId] = [];
        }).toThrow(TypeError);
        const copy = {
            ...chain,
            groupKeys: [(await groupKeyPair(pattern(64, 200))).publicKey],
        } as AcceptedRosters;
        const ctx = {
            groupId: GROUP,
            groupKeyVersion: 1,
            holderUserId: f.organizer.userId,
            holderKeyVersion: 1,
            sealerUserId: f.organizer.userId,
            rosterVersion: chain.roster.rosterVersion,
            rosterDigest: chain.rosterDigest,
        };
        const notAccepted = 'not a member list this device';
        await expect(
            sealGroupKey(pattern(64, 91), ctx, {
                chain: copy,
                holderKemPublicKey: f.organizer.kemPublicKey,
                sealer: f.organizer.signer,
            }),
        ).rejects.toThrow(notAccepted);
        const envelope = await sealGroupKey(pattern(64, 91), ctx, {
            chain,
            holderKemPublicKey: f.organizer.kemPublicKey,
            sealer: f.organizer.signer,
        });
        await expect(
            openGroupKey(envelope, ctx, {
                chain: copy,
                sealerMlDsaPublicKey: f.organizer.mlDsaPublicKey,
                reader: { userId: f.organizer.userId, keyVersion: 1 },
                holder: f.organizer.secrets,
            }),
        ).rejects.toThrow(notAccepted);
        await expect(memberSigner(copy, f.adult.userId, f.adult.mlDsaPublicKey)).rejects.toThrow(
            notAccepted,
        );
        await expect(
            groupWriterTrust({
                groupId: GROUP,
                areas: { [AREA]: 1 },
                reading: { status: 'accepted', chain: copy },
                workspaceId: AREA,
                writerUserId: f.adult.userId,
                pinned: null,
                served: null,
                links: null,
            }),
        ).rejects.toThrow(notAccepted);
        await expect(
            nextRoster(copy, chain.roster.members, { signerUserId: f.organizer.userId }),
        ).rejects.toThrow(notAccepted);
        await expect(pinAfter([], copy, CHECKED)).rejects.toThrow(notAccepted);
        await expect(checkNextRoster(copy, f.h.rosters[3]!, {}, null)).rejects.toThrow(notAccepted);
        await expect(checkNextSuccession(copy, f.h.successions[0]!, {})).rejects.toThrow(
            notAccepted,
        );
        await expect(
            trustAsGroupDoes(copy, f.adult.userId, f.adult.served, {
                email: '',
                name: '',
                pinnedAt: CHECKED,
            }),
        ).rejects.toThrow(notAccepted);
    });

    test('an accepted chain cannot be written out by hand (a type error)', async () => {
        const f = await family();
        const chain = await accepted(newcomer(f));
        const written: {
            [K in keyof AcceptedRosters as K extends string ? K : never]: AcceptedRosters[K];
        } = chain;
        // @ts-expect-error a written-out object lacks the brand only acceptRosters sets
        const forged: AcceptedRosters = written;
        expect(forged).toBe(chain);
    });
});

describe('round 8', () => {
    test('Opus 1: the person’s own marks disagreeing are the warning even beside malformed or foreign served statements', async () => {
        const { organizer, adult } = await cast();
        const h = await history();
        await h.roster(organizer, [organizer.entry(OWNER), adult.entry([])]);
        await h.roster(organizer, [organizer.entry(OWNER), adult.entry(['billing'])]);
        const people = [organizer, adult];
        const pin2 = await pinOf(h, 2, people);
        const elsewhere = { ...pin2, rosterDigest: encode(new Uint8Array(32).fill(9)) };
        const malformed = { ...h.rosters[0]!, statement: new TextEncoder().encode('[') };
        const foreign = await signRoster(
            { ...h.statements[0]!, groupId: OTHER_GROUP },
            h.keys[0]!,
            organizer.signer,
        );
        for (const extra of [malformed, foreign]) {
            const chain = await acceptRosters(
                inputOf(h, people, { pins: [pin2, elsewhere], rosters: [...h.rosters, extra] }),
            );
            expect(chain.status).toBe('fork');
            // With the person's marks agreeing, the same junk is a plain refusal.
            await expect(
                acceptRosters(inputOf(h, people, { pins: [pin2], rosters: [...h.rosters, extra] })),
            ).rejects.toThrow();
        }
    });

    test('Opus 5: a succession back to any earlier group key is refused, not only to the old one', async () => {
        const { organizer, holder } = await cast();
        const h = await history();
        await h.roster(organizer, [organizer.entry(OWNER), holder.entry(['members'])]);
        await h.succession(organizer);
        await h.roster(organizer, [organizer.entry(OWNER), holder.entry(['members'])], 2);
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
        await expect(
            acceptRosters(
                inputOf(h, [organizer, holder], {
                    rosters: [...h.rosters, underFirst],
                    successions: [...h.successions, back],
                }),
            ),
        ).rejects.toThrow('does not replace the key with a new one');
    });

    test('Opus 3: a served identity the member has already replaced reads unchecked; an own entry moved to a replaced identity is noted', async () => {
        const { organizer, adult } = await cast();
        const { next: adult2, link } = await succeed(adult);
        const { next: adult3, link: link23 } = await succeed(adult2);
        const h = await history();
        await h.roster(organizer, [organizer.entry(OWNER), adult.entry([])]);
        const chain = await acceptedOf(h, [organizer, adult]);
        const read = async (by: Person) =>
            recordVerdict(chain, {
                writerUserId: adult.userId,
                signature: encode(await recordSignature(by.signer.signingKey)),
                pinned: null,
                served: servedKeysOf(adult2),
                links: [link, link23],
            });
        expect(await read(adult2)).toEqual({ integrity: 'unchecked', via: null });
        expect(await read(adult3)).toEqual({ integrity: 'unchecked', via: null });
        // The reader's own entry moved to their second identity while they hold a third.
        const behind = await history();
        await behind.roster(organizer, [organizer.entry(OWNER), adult3.entry([])]);
        await behind.roster(organizer, [organizer.entry(OWNER), adult2.entry([])]);
        const me = { userId: adult.userId, identities: [adult, adult2, adult3].map(servedKeysOf) };
        const seen = await acceptedOf(behind, [organizer, adult2, adult3], { me });
        expect(seen.ownEntryWrongAt).toEqual([2]);
        const forward = await history();
        await forward.roster(organizer, [organizer.entry(OWNER), adult.entry([])]);
        await forward.roster(organizer, [organizer.entry(OWNER), adult2.entry([])]);
        const noted = await acceptedOf(forward, [organizer, adult, adult2], { me });
        expect(noted.ownEntryWrongAt).toEqual([]);
        expect(noted.ownEntryBehindAt).toEqual([1, 2]);
        expect(
            (
                await acceptedOf(forward, [organizer, adult, adult2], {
                    me: { ...me, identities: me.identities.slice(0, 2) },
                })
            ).ownEntryBehindAt,
        ).toEqual([1]);
    });

    test('Opus 4: an unsigned served key version never turns a followed succession into a key conflict', async () => {
        const { organizer, adult } = await cast();
        const { next: adult2, link } = await succeed(adult);
        const h = await history();
        await h.roster(organizer, [organizer.entry(OWNER), adult2.entry([])]);
        const chain = await acceptedOf(h, [organizer, adult2]);
        const signature = encode(await recordSignature(adult2.signer.signingKey));
        for (const keyVersion of [2, 3, 9])
            expect(
                await recordVerdict(chain, {
                    writerUserId: adult.userId,
                    signature,
                    pinned: await adult.pinned(),
                    served: { ...servedKeysOf(adult2), keyVersion },
                    links: [link],
                }),
            ).toEqual({ integrity: 'verified', via: GROUP });
    });

    test('Fable F3, r10: the join mark holds the chain to the roster that admitted the newcomer, by a twelve-word code', async () => {
        const { organizer, adult, child } = await cast();
        const h = await history();
        await h.roster(organizer, [organizer.entry(OWNER), adult.entry(['members'])]);
        await h.roster(adult, [organizer.entry(OWNER), adult.entry(['members']), child.entry([])]);
        const people = [organizer, adult, child];
        const digest = await rosterDigest(h.rosters[1]!.statement);
        const key = h.keys[0]!.publicKey;
        const code = await joinCode(digest, key, 1);
        expect(code).toHaveLength(12);
        const mark = { rosterVersion: 2, code };
        const accept = (joinMark: typeof mark) => acceptRosters(inputOf(h, people, { joinMark }));
        expect((await accept(mark)).status).toBe('accepted');
        // Another roster, another group key, another key version: each the warning, both sides named.
        for (const other of [
            await joinCode(await rosterDigest(h.rosters[0]!.statement), key, 1),
            await joinCode(digest, (await groupKeyAt(2)).publicKey, 1),
            await joinCode(digest, key, 2),
        ]) {
            const fork = await accept({ ...mark, code: other });
            expect(fork).toMatchObject({ status: 'fork', of: 'roster', version: 2 });
            expect((fork as { sides: { from: string[] }[] }).sides.map((s) => s.from)).toEqual(
                expect.arrayContaining([['join'], ['served']]),
            );
        }
        await expect(accept({ ...mark, rosterVersion: 3 })).rejects.toThrow('older member list');
        for (const bad of [
            code.slice(0, 11),
            [...code, code[0]!],
            code.map((w) => w.toUpperCase()),
        ])
            await expect(accept({ ...mark, code: bad })).rejects.toThrow('Invalid join mark');
    });
});

describe('round 9', () => {
    /*
     * A planter's first keys P as the adult's first entry, the adult's real keys R at 2 (the
     * entry), and links the planter can make: P→Q and P→Q' with both halves of the consent his own.
     */
    async function plantedFirst() {
        const { organizer, adult, outsider } = await cast();
        const [planted, real, q, q2] = await Promise.all([
            person(9),
            person(2, 2),
            person(10),
            person(11),
        ]);
        const h = await history();
        await h.roster(organizer, [
            organizer.entry(OWNER),
            { ...planted.entry([]), userId: adult.userId },
        ]);
        await h.roster(organizer, [organizer.entry(OWNER), real.entry([])]);
        const chain = await acceptedOf(h, [organizer, adult, planted, real]);
        const fromPlanted = async (to: typeof q, consentBy: typeof q | null = to) => {
            const fields = {
                oldKeyVersion: 1,
                newKeyVersion: 2,
                oldEncryptionPublicKey: planted.served.encryptionPublicKey,
                oldSigningPublicKey: planted.served.signingPublicKey,
                oldMlDsaPublicKey: planted.served.mlDsaPublicKey,
                newEncryptionPublicKey: to.served.encryptionPublicKey,
                newSigningPublicKey: to.served.signingPublicKey,
                newMlDsaPublicKey: to.served.mlDsaPublicKey,
                newKemPublicKey: to.served.kemPublicKey,
            };
            return {
                ...fields,
                signature: encode(
                    await signHybrid(
                        await successionStatement({ ...fields, userId: adult.userId }),
                        planted.signer,
                    ),
                ),
                consent: await consentOf(
                    fields,
                    adult.userId,
                    planted.signer,
                    consentBy?.signer ?? null,
                ),
            };
        };
        const read = async (signingKey: Uint8Array, served: ServedKeys, links: SuccessionLink[]) =>
            recordVerdict(chain, {
                writerUserId: adult.userId,
                signature: encode(await recordSignature(signingKey)),
                pinned: null,
                served,
                links,
            });
        return { adult, outsider, planted, real, q, q2, chain, fromPlanted, read };
    }

    test('Opus 2: a planted first key never reads retired through a successor its planter consented to', async () => {
        const f = await plantedFirst();
        // P→Q, both halves the planter's, Q served: the first keys' chain never reaches the entry.
        expect(
            await f.read(f.planted.signer.signingKey, servedKeysOf(f.q), [
                await f.fromPlanted(f.q),
            ]),
        ).toEqual({ integrity: 'bad-signature', via: null });
        // The control: P→R with the adult's own consent reaches the entry, and P reads retired.
        expect(
            await f.read(f.planted.signer.signingKey, servedKeysOf(f.real), [
                await f.fromPlanted(f.real),
            ]),
        ).toEqual({ integrity: 'retired-key', via: null });
        // P→R on the planter's half alone, or one-sided: no consent, no chain from the first keys.
        const { consent: _, ...oneSided } = await f.fromPlanted(f.real);
        for (const link of [await f.fromPlanted(f.real, null), oneSided])
            expect(await f.read(f.planted.signer.signingKey, servedKeysOf(f.real), [link])).toEqual(
                { integrity: 'bad-signature', via: null },
            );
    });

    test('Fable C: two links leaving the first keys void only that walk, never the member’s verdicts', async () => {
        const f = await plantedFirst();
        const links = [await f.fromPlanted(f.q), await f.fromPlanted(f.q2)];
        expect(await f.read(f.real.signer.signingKey, servedKeysOf(f.real), links)).toEqual({
            integrity: 'verified',
            via: GROUP,
        });
        expect(await f.read(f.outsider.signer.signingKey, servedKeysOf(f.real), links)).toEqual({
            integrity: 'bad-signature',
            via: null,
        });
        // The same fork at the entry's keys still makes the member unchecked.
        const { next: r2, link: toR2 } = await succeed(f.real);
        // A second successor of the real keys, at the same next version: another account's keys.
        const toQ2 = await linkBetween(f.real, await person(12, 3));
        expect(await f.read(f.real.signer.signingKey, servedKeysOf(r2), [toR2, toQ2])).toEqual({
            integrity: 'unchecked',
            via: null,
        });
    });

    test('Opus 5: a served identity that is the walk’s own start, with a verified link leaving it, is stale', async () => {
        const { adult } = await cast();
        const { next: adult2, link } = await succeed(adult);
        const { consent: _, ...oneSided } = link;
        expect(
            await successionPath(adult.userId, await adult.pinned(), servedKeysOf(adult), [
                oneSided,
            ]),
        ).toEqual({ status: 'stale' });
        // Nothing leaving it: no path, and no rollback either.
        expect(
            await successionPath(adult.userId, await adult.pinned(), servedKeysOf(adult), []),
        ).toEqual({ status: 'none' });
        expect(
            await successionPath(adult.userId, await adult.pinned(), servedKeysOf(adult2), [
                oneSided,
            ]),
        ).toEqual({ status: 'path', links: [oneSided] });
    });

    test('Opus 3: consent is asked only before the entry’s keys: the first keys’ walk, not the lag, pin or fold-in', async () => {
        const { adult } = await cast();
        const { next: adult2, link } = await succeed(adult);
        const { next: adult3, link: second } = await succeed(adult2);
        const strip = (l: SuccessionLink) => {
            const { consent: _, ...rest } = l;
            return rest;
        };
        const until = await adult2.pinned();
        // Consent until adult2: the one-sided first link stops the walk; once past adult2 the
        // version 2 signature is enough.
        expect(
            await successionPath(
                adult.userId,
                await adult.pinned(),
                servedKeysOf(adult3),
                [strip(link), strip(second)],
                { consentUntil: until },
            ),
        ).toEqual({ status: 'none' });
        expect(
            await successionPath(
                adult.userId,
                await adult.pinned(),
                servedKeysOf(adult3),
                [link, strip(second)],
                { consentUntil: until },
            ),
        ).toEqual({ status: 'path', links: [link, strip(second)] });
        // Without consentUntil, version 2 signatures carry the whole way; a junk signature does not.
        expect(
            await successionPath(adult.userId, await adult.pinned(), servedKeysOf(adult3), [
                strip(link),
                strip(second),
            ]),
        ).toEqual({ status: 'path', links: [strip(link), strip(second)] });
        const junk = { ...strip(link), signature: encode(new Uint8Array(3373)) };
        expect(
            await successionPath(adult.userId, await adult.pinned(), servedKeysOf(adult3), [
                { ...junk, consent: link.consent },
                strip(second),
            ]),
        ).toEqual({ status: 'none' });
    });

    test('Opus 8: more than 64 links are checked no further, and the cache tells members apart', async () => {
        const { adult, outsider } = await cast();
        const { next: adult2, link } = await succeed(adult);
        const junk = Array.from({ length: 63 }, () => ({ ...link, signature: 'AA' }));
        expect(
            await successionPath(adult.userId, await adult.pinned(), servedKeysOf(adult2), [
                link,
                ...junk,
            ]),
        ).toEqual({ status: 'path', links: [link] });
        expect(
            await successionPath(adult.userId, await adult.pinned(), servedKeysOf(adult2), [
                link,
                ...junk,
                junk[0]!,
            ]),
        ).toEqual({ status: 'too-many' });
        // One map across two members: the adult's link verified for the adult is nothing for
        // another account (the statement names the account; so does the cache key).
        const verified = new Map<string, boolean>();
        expect(
            (
                await successionPath(
                    adult.userId,
                    await adult.pinned(),
                    servedKeysOf(adult2),
                    [link],
                    {
                        verified,
                    },
                )
            ).status,
        ).toBe('path');
        expect(
            (
                await successionPath(
                    outsider.userId,
                    await adult.pinned(),
                    servedKeysOf(adult2),
                    [link],
                    {
                        verified,
                    },
                )
            ).status,
        ).toBe('none');
    });

    test('Opus 1 / Fable A: a cache whose area keys do not match its last roster is refused', async () => {
        const { organizer, adult } = await cast();
        const h = await history();
        await h.roster(organizer, [organizer.entry(OWNER), adult.entry([])]);
        const chain = await acceptedOf(h, [organizer, adult]);
        const accept = (cache: typeof chain.cache) =>
            acceptRosters(inputOf(h, [organizer, adult], { cache, rosters: [], successions: [] }));
        expect((await accept(chain.cache)).status).toBe('accepted');
        const listed = chain.cache.areaKeys[AREA]![0]!;
        const other = encode(new Uint8Array(32).fill(3));
        const tampered: Record<string, string[]>[] = [
            {},
            { [AREA]: [other] },
            { [AREA]: [listed, other] },
            { [AREA]: [listed], [OTHER_AREA]: [other] },
        ];
        for (const areaKeys of tampered)
            await expect(accept({ ...chain.cache, areaKeys })).rejects.toThrow(
                'Invalid member list cache',
            );
    });

    test('Codex 1: an identity’s keys statement holds only for the account asked about, whatever it carries', async () => {
        const { organizer, adult } = await cast();
        expect(await verifyIdentityKeys(adult.userId, adult.served)).toBe(true);
        expect(
            // As a server or a caller would hand it over, with the account it claims inside.
            await verifyIdentityKeys(organizer.userId, {
                ...adult.served,
                userId: adult.userId,
            } as typeof adult.served),
        ).toBe(false);
    });
});

describe('round 10', () => {
    test('Fable 6 / Opus 7: only links from the member’s own key sets count toward the cap', async () => {
        const { adult, outsider } = await cast();
        const { next: adult2, link } = await succeed(adult);
        const { link: elsewhere } = await succeed(outsider);
        // A hundred junk links from keys this member never held: never verified, never counted.
        const junk = Array.from({ length: 100 }, (_, i) => ({
            ...elsewhere,
            signature: encode(new Uint8Array(3373).fill(i)),
        }));
        expect(
            await successionPath(adult.userId, await adult.pinned(), servedKeysOf(adult2), [
                ...junk,
                link,
            ]),
        ).toEqual({ status: 'path', links: [link] });
        // Once those keys are a key set the chain lists for the member, they count.
        expect(
            await successionPath(
                adult.userId,
                await adult.pinned(),
                servedKeysOf(adult2),
                [...junk, link],
                { memberKeys: [await outsider.pinned()] },
            ),
        ).toEqual({ status: 'too-many' });
        expect(
            await successionPath(
                adult.userId,
                await adult.pinned(),
                servedKeysOf(adult2),
                [...junk.slice(0, 63), link],
                { memberKeys: [await outsider.pinned()] },
            ),
        ).toEqual({ status: 'path', links: [link] });
    });

    test('Fable 6: links leaving keys the walk reaches count too, so junk mid-chain cannot buy unlimited work', async () => {
        const { adult } = await cast();
        const { next: adult2, link } = await succeed(adult);
        const { next: adult3, link: second } = await succeed(adult2);
        const junk = (count: number) =>
            Array.from({ length: count }, (_, i) => ({
                ...second,
                signature: encode(new Uint8Array(3373).fill(i + 1)),
            }));
        const start = await adult.pinned();
        const at = (links: SuccessionLink[]) =>
            successionPath(adult.userId, start, servedKeysOf(adult3), links);
        // 1 from the start, then at adult2 the real link and 62 junk ones: 64 counted, walked.
        expect(await at([link, second, ...junk(62)])).toEqual({
            status: 'path',
            links: [link, second],
        });
        // 64 junk ones leaving adult2's keys: 66 counted once the walk is there.
        expect(await at([link, second, ...junk(64)])).toEqual({ status: 'too-many' });
    });

    test('the server entry refuses to load in a browser build', async () => {
        const globals = globalThis as { document?: unknown };
        globals.document = {};
        try {
            vi.resetModules();
            await expect(import('./group-trust-server')).rejects.toThrow('browser build');
        } finally {
            delete globals.document;
            vi.resetModules();
        }
    });

    test('Codex 3a: the cache knows a link by its fields, not by what it says when serialized', async () => {
        const { adult } = await cast();
        const { next: adult2, link } = await succeed(adult);
        const verified = new Map<string, boolean>();
        const start = await adult.pinned();
        const walk = (links: SuccessionLink[]) =>
            successionPath(adult.userId, start, servedKeysOf(adult2), links, { verified });
        expect((await walk([link])).status).toBe('path');
        const forged = {
            ...link,
            signature: encode(new Uint8Array(3373)),
            consent: encode(new Uint8Array(2 * 3373)),
            toJSON: () => ({ ...link }),
        };
        expect(JSON.stringify(forged)).toBe(JSON.stringify(link));
        expect(await walk([forged])).toEqual({ status: 'none' });
        // A link whose field is not a string is no link, cached or not.
        expect(await walk([{ ...link, signature: 5 as unknown as string }])).toEqual({
            status: 'none',
        });
    });
});

describe('round 11', () => {
    test('Opus 5: the session cache keeps at most 4,096 results, the least recently used dropped first', async () => {
        const { adult } = await cast();
        const { next: adult2, link } = await succeed(adult);
        const verified = new Map<string, boolean>();
        for (let i = 0; i < MAX_VERIFIED_LINKS; i++) verified.set(`old-${i}`, true);
        expect(
            await successionPath(adult.userId, await adult.pinned(), servedKeysOf(adult2), [link], {
                verified,
            }),
        ).toEqual({ status: 'path', links: [link] });
        expect(verified.size).toBe(MAX_VERIFIED_LINKS);
        expect(verified.has('old-0')).toBe(false);
        expect(verified.has(`old-${MAX_VERIFIED_LINKS - 1}`)).toBe(true);
        // Keys are digests, never the link itself (each a few hundred bytes, not kilobytes).
        const fresh = [...verified.keys()].filter((key) => !key.startsWith('old-'));
        expect(fresh.length).toBeGreaterThan(0);
        for (const key of fresh) expect(key).toMatch(/^[0-9a-f]{64}$/);
    });

    test('Opus 4 = Fable 3: too many links on a pinned reader’s walk read as links that did not load', async () => {
        const f = await family();
        const chain = await accepted(newcomer(f));
        const { next: adult2, link } = await succeed(f.adult);
        const { consent: _, ...oneSided } = link;
        const junk = Array.from({ length: 64 }, (_, i) => ({
            ...oneSided,
            signature: encode(new Uint8Array(3373)),
            newKeyVersion: i + 2,
        }));
        const trust = await groupWriterTrust({
            groupId: GROUP,
            areas: { [AREA]: 1 },
            reading: { status: 'accepted', chain },
            workspaceId: AREA,
            writerUserId: f.adult.userId,
            pinned: await f.adult.pinned(),
            served: adult2.served,
            links: [link, ...junk],
        });
        // The pin agrees with the entry: the roster's word, the entry's key current, nothing
        // followed or retired, and the links counted as not loaded.
        expect(trust).toMatchObject({
            trust: 'roster',
            via: null,
            followed: null,
            linksLoaded: false,
        });
        expect(trust.trust === 'roster' && trust.signer.retired).toEqual([]);
    });
});

describe('round 12', () => {
    test('final 2, 3: a pin carries its origin; a group-trusted pin that agrees names the group; an empty origin is no pin', async () => {
        const f = await family();
        const chain = await accepted(newcomer(f));
        const trust = async (trustedVia: string | null) =>
            groupWriterTrust({
                groupId: GROUP,
                areas: { [AREA]: 1 },
                reading: { status: 'accepted', chain },
                workspaceId: AREA,
                writerUserId: f.adult.userId,
                pinned: { ...(await f.adult.pinned()), trustedVia },
                served: f.adult.served,
                links: [],
            });
        expect(await trust(null)).toMatchObject({ trust: 'roster', via: null });
        expect(await trust(GROUP)).toMatchObject({ trust: 'roster', via: GROUP });
        expect(await trust('')).toEqual({ trust: 'unchecked' });
        // Admission refuses any origin, an empty one included.
        const pin = await trustAsGroupDoes(chain, f.adult.userId, f.adult.served, {
            email: 'a@example.com',
            name: 'A',
            pinnedAt: '2026-10-01T00:00:00.000Z',
        });
        for (const trustedVia of [GROUP, ''])
            await expect(
                newRosterEntry({ ...pin, trustedVia }, f.adult.served, {
                    roles: [],
                    rosterVersion: 9,
                }),
            ).rejects.toThrow('whose words were checked');
    });
});
