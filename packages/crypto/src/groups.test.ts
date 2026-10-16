import { areaKeyCommitment } from './area-keys';
import { describe, expect, test } from 'vitest';
import { CryptoError } from './errors';
import { fingerprintWords } from './fingerprint';
import {
    AREA_GRANT_BYTES,
    GROUP_KEY_SEAL_BYTES,
    areaGrantContext,
    areaGrantStatement,
    groupFingerprint,
    groupKeyPair,
    groupKeySealContext,
    groupKeySealStatement,
    groupSuccessionStatement,
    groupWords,
    memberSigner,
    openAreaGrant,
    openGroupKey,
    parseGroupSuccession,
    parseRoster,
    rosterStatement,
    MAX_ROSTER_AREA_ROWS,
    areasToRotate,
    MAX_ROSTER_MEMBERS,
    areaWriteVersion,
    nextAreaKey,
    sealAreaGrant,
    sealGroupKey,
    signGroup,
    verifyGroup,
    verifyMemberSignature,
    type AreaGrantContext,
    type GroupKeySealContext,
    type Roster,
    type AreaKey,
    MAX_FAMILY_AREAS,
} from './groups';
import {
    AREA,
    AREA_SEED,
    GROUP,
    OTHER_AREA,
    OTHER_AREA_SEED,
    OTHER_GROUP,
    acceptedOf,
    groupKeyAt,
    history,
    pattern,
    person,
    succeed,
    atRoster,
    consentOf,
    linkBetween,
    statementCases,
    statementVerdict,
    SECOND_AREA,
    standardAreas,
    areaKeyAt,
    CHECKED,
    mlDsaKeysOf,
    groupIdFor,
    type Person,
    servedKeysOf,
} from './group-testkit';
import {
    acceptStored,
    checkNextRoster,
    groupWriterTrust,
    nextRoster,
    pinAfter,
    type AcceptedRosters,
    acceptRosters,
    storedCacheOf,
} from './group-trust';
import { acceptStoredChain, storedRecord } from './group-trust-server';
import { checkId, deriveId } from './ids';
import { bytesOf, encodeStatement, MAX_STATEMENT_BYTES, parseStatement } from './canonical';
import { encode } from './keys';
import { mlDsaSign } from './pq';
import { sealHybrid } from './sealing';
import {
    IDENTITY_SIGNATURE_CONTEXT,
    digest,
    keysStatement,
    signHybrid,
    successionStatement,
    verifyHybrid,
} from './signatures';

/*
 * The group statements have one encoding each, the group key signs only with
 * both halves, and each seal opens only for its holder, from a sealer the
 * verified roster allows, under its own kind and context. Every refusal here
 * is a way a server or a former member would otherwise get a false key or a
 * false roster accepted.
 */

const text = (bytes: Uint8Array) => new TextDecoder().decode(bytes);
const bytes = (value: string) => new TextEncoder().encode(value);

async function family() {
    const [organizer, adult, child, outsider] = await Promise.all(
        [1, 2, 3, 4].map((n) => person(n)),
    );
    const roster: Roster = {
        groupId: GROUP,
        kind: 'family',
        rosterVersion: 1,
        previousRosterDigest: '',
        groupKeyVersion: 1,
        signerUserId: organizer!.userId,
        members: [
            organizer!.entry(['billing', 'guardian', 'members']),
            adult!.entry([]),
            child!.entry([]),
        ],
        areas: [],
    };
    return { organizer: organizer!, adult: adult!, child: child!, outsider: outsider!, roster };
}

describe('encoding', () => {
    test('a roster is the canonical array the design fixes, members and roles in byte order', async () => {
        const { organizer, adult, roster } = await family();
        const statement = text(rosterStatement(roster));
        const o = organizer.entry(['billing', 'guardian', 'members']);
        const a = adult.entry([]);
        expect(
            statement.startsWith(
                `["hushos/group/roster",1,"${GROUP}","family",1,"",1,"${organizer.userId}",[[`,
            ),
        ).toBe(true);
        expect(statement).toContain(
            `["${o.userId}",1,"${o.encryptionPublicKey}","${o.signingPublicKey}","${o.mlDsaPublicKeyDigest}","${o.kemPublicKeyDigest}","active",["billing","guardian","members"],1]`,
        );
        expect(statement).toContain(`,["${a.userId}",1,`);
        expect(statement).not.toContain(' ');
        // The digests are base64url of SHA-256, never hex.
        expect(o.mlDsaPublicKeyDigest).toBe(await digest(organizer.mlDsaPublicKey));
        expect(parseRoster(rosterStatement(roster))).toEqual(roster);
    });

    test('a roster that parses but re-encodes differently is refused', async () => {
        const { roster } = await family();
        const canonical = text(rosterStatement(roster));
        const variants = [
            canonical.replace('"hushos/group/roster",1,', '"hushos/group/roster", 1,'),
            canonical.replace('"family",1,', '"family",1.0,'),
            canonical.replace('"hushos/group/roster"', '"\\u0068ushos/group/roster"'),
            `${canonical}\n`,
            canonical.replace(`"${GROUP}"`, `"${GROUP.toUpperCase()}"`),
        ];
        for (const variant of variants)
            expect(() => parseRoster(bytes(variant)), variant.slice(0, 40)).toThrow(CryptoError);
    });

    test('a version above 2^53 - 1, an uppercase id and a hex digest are refused', async () => {
        const { organizer, roster } = await family();
        const canonical = text(rosterStatement(roster));
        expect(() =>
            parseRoster(bytes(canonical.replace(`"family",1,`, `"family",9007199254740992,`))),
        ).toThrow(CryptoError);
        expect(() => rosterStatement({ ...roster, groupKeyVersion: 2 ** 53 })).toThrow(
            'Invalid group key version.',
        );
        expect(() =>
            rosterStatement({ ...roster, signerUserId: organizer.userId.toUpperCase() }),
        ).toThrow('Invalid user id.');
        const hex = Buffer.from(organizer.mlDsaPublicKey.subarray(0, 32)).toString('hex');
        const entry = { ...roster.members[0]!, mlDsaPublicKeyDigest: hex };
        expect(() =>
            rosterStatement({ ...roster, members: [entry, ...roster.members.slice(1)] }),
        ).toThrow('Invalid key digest.');
        const succession = {
            groupId: GROUP,
            oldVersion: 2 ** 53 - 1,
            newVersion: 2 ** 53,
            oldEd25519PublicKey: encode(pattern(32, 1)),
            oldMlDsaPublicKey: encode(pattern(1952, 2)),
            newEd25519PublicKey: encode(pattern(32, 3)),
            newMlDsaPublicKey: encode(pattern(1952, 4)),
            lastRosterVersion: 1,
            lastRosterDigest: encode(pattern(32, 5)),
            signerUserId: organizer.userId,
        };
        expect(() => groupSuccessionStatement(succession)).toThrow('Invalid group key version.');
    });

    test('lists are strictly ascending without repeats, and a family has no company roles', async () => {
        const { organizer, adult, roster } = await family();
        const [first, second, third] = roster.members as [never, never, never];
        for (const members of [
            [second, first, third],
            [first, first, second],
        ])
            expect(() => rosterStatement({ ...roster, members })).toThrow(
                'Invalid roster members.',
            );
        for (const roles of [
            ['members', 'billing'],
            ['members', 'members'],
            ['data_admin'],
            ['owner'],
        ])
            expect(() =>
                rosterStatement({
                    ...roster,
                    members: [{ ...organizer.entry([]), roles: roles as never }, adult.entry([])],
                }),
            ).toThrow(CryptoError);
        // A company has them.
        expect(() =>
            rosterStatement({
                ...roster,
                kind: 'org',
                members: [organizer.entry(['data_admin', 'members', 'recovery']), adult.entry([])],
            }),
        ).not.toThrow();
    });

    test('the previous digest is the empty string exactly on version 1, and entries are no newer than the roster', async () => {
        const { roster } = await family();
        const digestOfAnything = encode(pattern(32, 9));
        expect(() =>
            rosterStatement({ ...roster, previousRosterDigest: digestOfAnything }),
        ).toThrow('Invalid roster digest.');
        expect(() => rosterStatement({ ...roster, rosterVersion: 2 })).toThrow(
            'Invalid roster digest.',
        );
        expect(() =>
            rosterStatement({
                ...roster,
                rosterVersion: 2,
                previousRosterDigest: digestOfAnything,
            }),
        ).not.toThrow();
        const ahead = { ...roster.members[0]!, sinceVersion: 2 };
        expect(() =>
            rosterStatement({ ...roster, members: [ahead, ...roster.members.slice(1)] }),
        ).toThrow('Invalid roster entry version.');
    });

    test('a succession names the next key version only, and re-encodes or is refused', async () => {
        const { organizer } = await family();
        const succession = {
            groupId: GROUP,
            oldVersion: 1,
            newVersion: 2,
            oldEd25519PublicKey: encode(pattern(32, 1)),
            oldMlDsaPublicKey: encode(pattern(1952, 2)),
            newEd25519PublicKey: encode(pattern(32, 3)),
            newMlDsaPublicKey: encode(pattern(1952, 4)),
            lastRosterVersion: 3,
            lastRosterDigest: encode(pattern(32, 5)),
            signerUserId: organizer.userId,
        };
        const statement = groupSuccessionStatement(succession);
        expect(text(statement)).toBe(
            JSON.stringify([
                'hushos/group/key-succession',
                1,
                GROUP,
                1,
                2,
                succession.oldEd25519PublicKey,
                succession.oldMlDsaPublicKey,
                succession.newEd25519PublicKey,
                succession.newMlDsaPublicKey,
                3,
                succession.lastRosterDigest,
                organizer.userId,
            ]),
        );
        expect(parseGroupSuccession(statement)).toEqual(succession);
        expect(() => groupSuccessionStatement({ ...succession, newVersion: 3 })).toThrow(
            'Invalid group key version.',
        );
        expect(() => parseGroupSuccession(bytes(text(statement).replace(',2,', ',3,')))).toThrow(
            CryptoError,
        );
    });

    test('each seal’s associated data is its statement without the final digest', async () => {
        const { organizer, adult } = await family();
        const sealed = pattern(100, 7);
        const sha = await digest(sealed);
        const keySeal: GroupKeySealContext = {
            groupId: GROUP,
            groupKeyVersion: 2,
            holderUserId: adult.userId,
            holderKeyVersion: 3,
            sealerUserId: organizer.userId,
            rosterVersion: 6,
            rosterDigest: sha,
        };
        expect(text(await groupKeySealStatement(keySeal, sealed))).toBe(
            `["hushos/group/key-seal",1,"${GROUP}",2,"${adult.userId}",3,"${organizer.userId}",6,"${sha}","${sha}"]`,
        );
        expect(text(groupKeySealContext(keySeal))).toBe(
            `["hushos/group/key-seal",1,"${GROUP}",2,"${adult.userId}",3,"${organizer.userId}",6,"${sha}"]`,
        );
        const grant: AreaGrantContext = {
            groupId: GROUP,
            workspaceId: AREA,
            workspaceKeyVersion: 4,
            granteeUserId: adult.userId,
            granteeKeyVersion: 1,
            granterUserId: organizer.userId,
            rosterVersion: 6,
            rosterDigest: sha,
        };
        expect(text(await areaGrantStatement(grant, sealed))).toBe(
            `["hushos/group/area-grant",1,"${GROUP}","${AREA}",4,"${adult.userId}",1,"${organizer.userId}",6,"${sha}","${sha}"]`,
        );
        expect(text(areaGrantContext(grant))).toBe(
            `["hushos/group/area-grant",1,"${GROUP}","${AREA}",4,"${adult.userId}",1,"${organizer.userId}",6,"${sha}"]`,
        );
    });
});

describe('group signatures', () => {
    test('hold only with both halves, each under the group key and the group context', async () => {
        const key = await groupKeyAt(1);
        const other = await groupKeyAt(2);
        const message = bytes('["hushos/group/roster"]');
        const signature = await signGroup(message, key);
        expect(await verifyGroup(message, signature, key.publicKey)).toBe(true);
        const flipped = (value: Uint8Array, at: number) => {
            const copy = value.slice();
            copy[at]! ^= 1;
            return copy;
        };
        // A valid Ed25519 half beside a broken ML-DSA half, and the reverse.
        expect(
            await verifyGroup(
                message,
                { ...signature, mlDsa: flipped(signature.mlDsa, 100) },
                key.publicKey,
            ),
        ).toBe(false);
        expect(
            await verifyGroup(
                message,
                { ...signature, ed25519: flipped(signature.ed25519, 5) },
                key.publicKey,
            ),
        ).toBe(false);
        // Either half from another group key.
        const foreign = await signGroup(message, other);
        expect(
            await verifyGroup(message, { ...signature, mlDsa: foreign.mlDsa }, key.publicKey),
        ).toBe(false);
        expect(
            await verifyGroup(message, { ...signature, ed25519: foreign.ed25519 }, key.publicKey),
        ).toBe(false);
        expect(await verifyGroup(bytes('["hushos/group/rostes"]'), signature, key.publicKey)).toBe(
            false,
        );
    });

    test('a group key’s ML-DSA signature under the identity context is no group signature, and the reverse', async () => {
        const key = await groupKeyAt(1);
        const message = bytes('statement');
        const signature = await signGroup(message, key);
        const asIdentity = mlDsaSign(message, key.mlDsaSecretKey, IDENTITY_SIGNATURE_CONTEXT);
        expect(await verifyGroup(message, { ...signature, mlDsa: asIdentity }, key.publicKey)).toBe(
            false,
        );
        // The group signature presented as a hybrid identity signature by the same keys.
        const joined = new Uint8Array([...signature.ed25519, ...signature.mlDsa]);
        const keys = {
            signingPublicKey: Buffer.from(key.publicKey.ed25519PublicKey, 'base64url'),
            mlDsaPublicKey: Buffer.from(key.publicKey.mlDsaPublicKey, 'base64url'),
        };
        expect(await verifyHybrid(message, joined, keys)).toBe(false);
        const identity = await signHybrid(message, {
            signingKey: key.signingKey,
            mlDsaSecretKey: key.mlDsaSecretKey,
        });
        expect(await verifyHybrid(message, identity, keys)).toBe(true);
    });

    test('the group key is the seed’s: Ed25519 from its first half, ML-DSA from its second', async () => {
        const seed = pattern(64, 3);
        const key = await groupKeyPair(seed);
        const changed = seed.slice();
        changed[40]! ^= 1;
        const other = await groupKeyPair(changed);
        expect(other.publicKey.ed25519PublicKey).toBe(key.publicKey.ed25519PublicKey);
        expect(other.publicKey.mlDsaPublicKey).not.toBe(key.publicKey.mlDsaPublicKey);
        await expect(groupKeyPair(seed.subarray(1))).rejects.toThrow('Invalid group key.');
    });
});

describe('group fingerprint', () => {
    test('matches a third implementation and changes with either key or the group', async () => {
        const fill = (byte: number, length: number) => encode(new Uint8Array(length).fill(byte));
        const key = { ed25519PublicKey: fill(1, 32), mlDsaPublicKey: fill(2, 1952) };
        // Computed with Python's hashlib over the same layout.
        expect(await groupFingerprint(GROUP, key)).toBe(
            'a9f4 8ca9 8691 f94f dcd9 ecad f0a7 4d03 b0eb 1231',
        );
        const words = await groupWords(GROUP, key);
        expect(words).toHaveLength(12);
        expect(words).toEqual(fingerprintWords(await groupFingerprint(GROUP, key)));
        const prints = new Set([
            await groupFingerprint(GROUP, key),
            await groupFingerprint(GROUP, { ...key, ed25519PublicKey: fill(3, 32) }),
            await groupFingerprint(GROUP, { ...key, mlDsaPublicKey: fill(4, 1952) }),
            await groupFingerprint(OTHER_GROUP, key),
        ]);
        expect(prints.size).toBe(4);
        await expect(groupFingerprint(GROUP.toUpperCase(), key)).rejects.toThrow(
            'Invalid group id.',
        );
    });
});

describe('seals and grants', () => {
    const OWNER: ('billing' | 'guardian' | 'members')[] = ['billing', 'guardian', 'members'];

    /*
     * Rosters `lists` signed by the organizer (or `signers[i]`, for a roster the organizer leaves
     * on), a succession by `successor` after roster `after` when given.
     */
    async function accepted(
        f: Awaited<ReturnType<typeof family>>,
        lists: ((p: Awaited<ReturnType<typeof family>>) => ReturnType<Person['entry']>[])[],
        succession?: { after: number; by: Person },
        kind: 'family' | 'org' = 'family',
        signers: Person[] = [],
    ) {
        const h = await history(kind);
        for (const [index, list] of lists.entries()) {
            await h.roster(signers[index] ?? f.organizer, list(f), h.keys.length);
            if (succession && index + 1 === succession.after) await h.succession(succession.by);
        }
        return acceptedOf(h, [f.organizer, f.adult, f.child, f.outsider]);
    }

    test('the group key opens for its holder, from an active `members` holder, to the published key', async () => {
        const f = await family();
        const { organizer, adult, outsider } = f;
        const holders = (p: typeof f) => [
            p.organizer.entry(OWNER),
            p.adult.entry(['members']),
            p.child.entry([]),
        ];
        const chain = await accepted(f, [holders]);
        const seed = pattern(64, 91);
        const ctx: GroupKeySealContext = {
            groupId: GROUP,
            groupKeyVersion: 1,
            holderUserId: adult.userId,
            holderKeyVersion: 1,
            sealerUserId: organizer.userId,
            ...atRoster(chain),
        };
        const seal = (at: GroupKeySealContext, seedOf = seed, over: object = {}) =>
            sealGroupKey(seedOf, at, {
                chain,
                holderKemPublicKey: adult.kemPublicKey,
                sealer: organizer.signer,
                ...over,
            });
        const envelope = await seal(ctx);
        expect(envelope).toHaveLength(GROUP_KEY_SEAL_BYTES);
        const open = (
            over: Partial<Parameters<typeof openGroupKey>[2]> = {},
            at = ctx,
            sealed = envelope,
        ) =>
            openGroupKey(sealed, at, {
                chain,
                sealerMlDsaPublicKey: organizer.mlDsaPublicKey,
                reader: { userId: adult.userId, keyVersion: 1 },
                holder: adult.secrets,
                ...over,
            });
        expect(await open()).toEqual(seed);
        // A seed that does not derive the published key.
        await expect(open({}, ctx, await seal(ctx, pattern(64, 5)))).rejects.toThrow(
            'not the group’s published key',
        );
        // A key version the verified chain does not reach.
        await expect(
            open({}, { ...ctx, groupKeyVersion: 2 }, await seal({ ...ctx, groupKeyVersion: 2 })),
        ).rejects.toThrow('not one the group has published');
        // A sealer who is no longer a `members` holder on the accepted roster (and did not create the group).
        const byAdult = { ...ctx, holderUserId: organizer.userId, sealerUserId: adult.userId };
        const adultSeal = await seal(byAdult, seed, {
            holderKemPublicKey: organizer.kemPublicKey,
            sealer: adult.signer,
        });
        const asOrganizer = {
            sealerMlDsaPublicKey: adult.mlDsaPublicKey,
            reader: { userId: organizer.userId, keyVersion: 1 },
            holder: organizer.secrets,
        };
        expect(await open(asOrganizer, byAdult, adultSeal)).toEqual(seed);
        const demoted = await accepted(f, [
            holders,
            (p) => [p.organizer.entry(OWNER), p.adult.entry([]), p.child.entry([])],
        ]);
        await expect(open({ ...asOrganizer, chain: demoted }, byAdult, adultSeal)).rejects.toThrow(
            'not sealed by a member who holds it',
        );
        // The creator's version 1 seal opens only while they are active: once they have left,
        // their seals open nothing, version 1's included.
        const leaving = (p: typeof f) => [
            p.organizer.entry(OWNER, 1, 'left'),
            p.adult.entry(['members']),
            p.child.entry([]),
        ];
        // r11: the organizer's departure is the adult's to sign, a holder who stays.
        const left = await accepted(f, [holders, leaving], { after: 2, by: adult }, 'family', [
            organizer,
            adult,
        ]);
        expect(left.creatorUserId).toBe(organizer.userId);
        await expect(open({ chain: left })).rejects.toThrow('not sealed by a member who holds it');
        // A later key the creator sealed: not theirs to hand out once they have left.
        const withKey2 = await accepted(f, [holders, holders], { after: 1, by: organizer });
        const later = { ...ctx, groupKeyVersion: 2 };
        const laterSeal = await seal(later, pattern(64, 92));
        expect(await open({ chain: withKey2 }, later, laterSeal)).toEqual(pattern(64, 92));
        await expect(open({ chain: left }, later, laterSeal)).rejects.toThrow(
            'not sealed by a member who holds it',
        );
        // The sealer's ML-DSA key as served, when the roster names another.
        await expect(open({ sealerMlDsaPublicKey: outsider.mlDsaPublicKey })).rejects.toThrow(
            'not the ones on the group’s member list',
        );
        // Another holder's keys open nothing, and the seal is never made to a non-holder.
        await expect(open({ holder: organizer.secrets })).rejects.toThrow('could not be opened');
        const plain = await accepted(f, [
            (p) => [p.organizer.entry(OWNER), p.adult.entry([]), p.child.entry([])],
        ]);
        await expect(seal({ ...ctx, ...atRoster(plain) }, seed, { chain: plain })).rejects.toThrow(
            'only to members who hold it',
        );
        // To a KEM key the entry does not name.
        await expect(
            seal(ctx, seed, { holderKemPublicKey: outsider.kemPublicKey }),
        ).rejects.toThrow('not the ones on the group’s member list');
    });

    async function granted() {
        const f = await family();
        const { organizer, adult } = f;
        const members = (p: typeof f) => [
            p.organizer.entry(OWNER),
            p.adult.entry([]),
            p.child.entry([]),
        ];
        const chain = await accepted(f, [members]);
        const workspaceKey = pattern(32, 77);
        const ctx: AreaGrantContext = {
            groupId: GROUP,
            workspaceId: AREA,
            workspaceKeyVersion: 1,
            granteeUserId: adult.userId,
            granteeKeyVersion: 1,
            granterUserId: organizer.userId,
            ...atRoster(chain),
        };
        const envelope = await sealAreaGrant(workspaceKey, ctx, {
            chain,
            areaIdSeed: AREA_SEED,
            granteeKemPublicKey: adult.kemPublicKey,
            granter: organizer.signer,
        });
        const open = (
            over: Partial<Parameters<typeof openAreaGrant>[2]> = {},
            at = ctx,
            sealed = envelope,
        ) =>
            openAreaGrant(sealed, at, {
                chain,
                areaIdSeed: AREA_SEED,
                granterMlDsaPublicKey: organizer.mlDsaPublicKey,
                reader: { userId: adult.userId, keyVersion: 1 },
                grantee: adult.secrets,
                ...over,
            });
        return { ...f, chain, members, workspaceKey, ctx, envelope, open };
    }

    test('a seal from before the sealer’s identity was folded in still opens through their chain; a key only planted never does', async () => {
        const f = await family();
        const { organizer, adult, outsider } = f;
        const { next: adult2, link } = await succeed(adult);
        const own = organizer.entry(OWNER);
        const h = await history();
        await h.roster(organizer, [own, adult.entry(['members'])]);
        const before = await acceptedOf(h, [organizer, adult]);
        // A holder writes the outsider's keys as the adult's for one roster, then the adult's
        // next identity is folded in.
        await h.roster(organizer, [own, { ...outsider.entry(['members']), userId: adult.userId }]);
        const planted = await acceptedOf(h, [organizer, adult, outsider]);
        await h.roster(organizer, [own, adult2.entry(['members'])]);
        const after = await acceptedOf(h, [organizer, adult, outsider, adult2]);
        const seed = pattern(64, 91);
        const ctx: GroupKeySealContext = {
            groupId: GROUP,
            groupKeyVersion: 1,
            holderUserId: organizer.userId,
            holderKeyVersion: 1,
            sealerUserId: adult.userId,
            ...atRoster(before),
        };
        const atPlanted = { ...ctx, ...atRoster(planted) };
        const byAdult = await sealGroupKey(seed, ctx, {
            chain: before,
            holderKemPublicKey: organizer.kemPublicKey,
            sealer: adult.signer,
        });
        const byPlanted = await sealGroupKey(seed, atPlanted, {
            chain: planted,
            holderKemPublicKey: organizer.kemPublicKey,
            sealer: outsider.signer,
        });
        const history2 = { served: adult2.served, links: [link] };
        const open = (envelope: Uint8Array, sealerHistory: typeof history2 | null) =>
            openGroupKey(envelope, envelope === byPlanted ? atPlanted : ctx, {
                chain: after,
                sealerMlDsaPublicKey: adult2.mlDsaPublicKey,
                sealerHistory,
                reader: { userId: organizer.userId, keyVersion: 1 },
                holder: organizer.secrets,
            });
        expect(await open(byAdult, history2)).toEqual(seed);
        await expect(open(byAdult, null)).rejects.toThrow('not sealed by a member who holds it');
        await expect(open(byPlanted, history2)).rejects.toThrow(
            'not sealed by a member who holds it',
        );
        // A link served in front naming the adult's old X25519 and Ed25519 keys with the outsider's
        // ML-DSA key is not on the verified chain, and lends the outsider nothing.
        const fake = {
            ...link,
            oldMlDsaPublicKey: outsider.served.mlDsaPublicKey,
            signature: encode(new Uint8Array(3373)),
        };
        await expect(open(byPlanted, { ...history2, links: [fake, link] })).rejects.toThrow(
            'not sealed by a member who holds it',
        );
        // Nor does an unsigned link from the planted keys themselves: only links on a verified chain count.
        const fromPlanted = {
            ...link,
            oldEncryptionPublicKey: outsider.served.encryptionPublicKey,
            oldSigningPublicKey: outsider.served.signingPublicKey,
            oldMlDsaPublicKey: outsider.served.mlDsaPublicKey,
            signature: encode(new Uint8Array(3373)),
        };
        await expect(open(byPlanted, { ...history2, links: [fromPlanted, link] })).rejects.toThrow(
            'not sealed by a member who holds it',
        );
        // The same for an area grant.
        const workspaceKey = pattern(32, 77);
        const grantCtx: AreaGrantContext = {
            groupId: GROUP,
            workspaceId: AREA,
            workspaceKeyVersion: 1,
            granteeUserId: organizer.userId,
            granteeKeyVersion: 1,
            granterUserId: adult.userId,
            ...atRoster(before),
        };
        const grant = await sealAreaGrant(workspaceKey, grantCtx, {
            chain: before,
            areaIdSeed: AREA_SEED,
            granteeKemPublicKey: organizer.kemPublicKey,
            granter: adult.signer,
        });
        const openGrant = (granterHistory: typeof history2 | null) =>
            openAreaGrant(grant, grantCtx, {
                chain: after,
                areaIdSeed: AREA_SEED,
                granterMlDsaPublicKey: adult2.mlDsaPublicKey,
                granterHistory,
                reader: { userId: organizer.userId, keyVersion: 1 },
                grantee: organizer.secrets,
            });
        expect(await openGrant(history2)).toEqual(workspaceKey);
        await expect(openGrant(null)).rejects.toThrow();
    });

    test('r6: a planted key never grants as the member; a replaced identity seals only once a roster folds it in', async () => {
        const [o, g, child, planted] = await Promise.all([
            person(1),
            person(2),
            person(4, 2),
            person(9),
        ]);
        const own = o.entry(OWNER);
        const h = await history();
        await h.roster(o, [own, g.entry(['guardian']), child.entry([])]);
        await h.roster(o, [
            own,
            g.entry(['guardian']),
            { ...planted.entry([]), userId: child.userId },
        ]);
        const whilePlanted = await acceptedOf(h, [o, g, child, planted]);
        await h.roster(o, [own, g.entry(['guardian']), child.entry([], 3)]);
        const chain = await acceptedOf(h, [o, g, child, planted]);
        // The planter's link from the planted keys to the child's: it verifies, but the planted set
        // is not where the child's chain starts.
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
        // Given the child's consent as well (a test can sign it), to pin the first-keys rule.
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
        const grantCtx: AreaGrantContext = {
            groupId: GROUP,
            workspaceId: AREA,
            workspaceKeyVersion: 1,
            granteeUserId: g.userId,
            granteeKeyVersion: 1,
            granterUserId: child.userId,
            ...atRoster(whilePlanted),
        };
        const byPlanted = await sealAreaGrant(pattern(32, 77), grantCtx, {
            chain: whilePlanted,
            areaIdSeed: AREA_SEED,
            granteeKemPublicKey: g.kemPublicKey,
            granter: planted.signer,
        });
        await expect(
            openAreaGrant(byPlanted, grantCtx, {
                chain,
                areaIdSeed: AREA_SEED,
                granterMlDsaPublicKey: child.mlDsaPublicKey,
                granterHistory: { served: child.served, links: [plantedLink] },
                reader: { userId: g.userId, keyVersion: 1 },
                grantee: g.secrets,
            }),
        ).rejects.toThrow('not signed by the member who made it');
        // Once the child's own entry is back, the planted keys grant nothing.
        await expect(
            sealAreaGrant(
                pattern(32, 77),
                { ...grantCtx, ...atRoster(chain) },
                {
                    chain,
                    areaIdSeed: AREA_SEED,
                    granteeKemPublicKey: g.kemPublicKey,
                    granter: planted.signer,
                },
            ),
        ).rejects.toThrow('not the sealer’s keys');
        // The organizer replaced their identity: until a roster folds it in, the new keys seal
        // nothing, and a seal made under them elsewhere does not open here, history or not.
        const { next: o2, link } = await succeed(o);
        const keyCtx: Omit<GroupKeySealContext, 'rosterVersion' | 'rosterDigest'> = {
            groupId: GROUP,
            groupKeyVersion: 1,
            holderUserId: g.userId,
            holderKeyVersion: 1,
            sealerUserId: o.userId,
        };
        const withMembers = await history();
        await withMembers.roster(o, [own, g.entry(['members'])]);
        const members = await acceptedOf(withMembers, [o, g]);
        const oHistory = { served: o2.served, links: [link] };
        await expect(
            sealGroupKey(
                pattern(64, 91),
                { ...keyCtx, ...atRoster(members) },
                {
                    chain: members,
                    holderKemPublicKey: g.kemPublicKey,
                    sealer: o2.signer,
                },
            ),
        ).rejects.toThrow('not the sealer’s keys');
        await withMembers.roster(o, [o2.entry(OWNER), g.entry(['members'])]);
        const folded = await acceptedOf(withMembers, [o, o2, g]);
        const atFolded = { ...keyCtx, ...atRoster(folded) };
        const byNew = await sealGroupKey(pattern(64, 91), atFolded, {
            chain: folded,
            holderKemPublicKey: g.kemPublicKey,
            sealer: o2.signer,
        });
        const openWith = (
            chain: AcceptedRosters,
            sealerHistory: typeof oHistory | null,
            reader = { userId: g.userId, keyVersion: 1 },
        ) =>
            openGroupKey(byNew, atFolded, {
                chain,
                sealerMlDsaPublicKey: o2.mlDsaPublicKey,
                sealerHistory,
                reader,
                holder: g.secrets,
            });
        expect(await openWith(folded, null)).toEqual(pattern(64, 91));
        // Not on a chain short of the roster that folded the new keys in (r8: seals name it).
        await expect(openWith(members, oHistory)).rejects.toThrow(
            'sealed on a member list this device does not have',
        );
        // Junk appended to the history changes nothing.
        expect(
            await openWith(folded, {
                ...oHistory,
                links: [link, { ...link, signature: encode(new Uint8Array(3373)) }],
            }),
        ).toEqual(pattern(64, 91));
        // A key seal opens only for the holder it names, at their key version.
        await expect(openWith(folded, null, { userId: o.userId, keyVersion: 1 })).rejects.toThrow(
            'not sealed to this account',
        );
        await expect(openWith(folded, null, { userId: g.userId, keyVersion: 2 })).rejects.toThrow(
            'not sealed to this account',
        );
    });

    test('r7: only an active holder seals, under both keys its entry names; a forked identity lends no history', async () => {
        const [o, a, g, outsider] = await Promise.all([person(1), person(2), person(3), person(5)]);
        const own = o.entry(OWNER);
        const h = await history();
        await h.roster(o, [own, a.entry(['members']), g.entry([])]);
        const chain = await acceptedOf(h, [o, a, g]);
        await h.roster(o, [own, a.entry(['members'], 2, 'left'), g.entry([])]);
        const left = await acceptedOf(h, [o, a, g]);
        const keyCtx = (sealer: string, at: AcceptedRosters = chain): GroupKeySealContext => ({
            groupId: GROUP,
            groupKeyVersion: 1,
            holderUserId: o.userId,
            holderKeyVersion: 1,
            sealerUserId: sealer,
            ...atRoster(at),
        });
        const seed = pattern(64, 91);
        // Not a holder (g has no `members`), or a holder who has left: no key seal.
        await expect(
            sealGroupKey(seed, keyCtx(g.userId), {
                chain,
                holderKemPublicKey: o.kemPublicKey,
                sealer: g.signer,
            }),
        ).rejects.toThrow('sealed only by a member who holds it');
        await expect(
            sealGroupKey(seed, keyCtx(a.userId, left), {
                chain: left,
                holderKemPublicKey: o.kemPublicKey,
                sealer: a.signer,
            }),
        ).rejects.toThrow('sealed only by a member who holds it');
        // The entry's Ed25519 key with another ML-DSA key: not the sealer's keys.
        const halfOther = {
            signingKey: a.signer.signingKey,
            mlDsaSecretKey: outsider.signer.mlDsaSecretKey,
        };
        await expect(
            sealGroupKey(seed, keyCtx(a.userId), {
                chain,
                holderKemPublicKey: o.kemPublicKey,
                sealer: halfOther,
            }),
        ).rejects.toThrow('not the sealer’s keys');
        // A grant from someone who has left: refused before anything is sealed.
        const grantCtx: AreaGrantContext = {
            groupId: GROUP,
            workspaceId: AREA,
            workspaceKeyVersion: 1,
            granteeUserId: g.userId,
            granteeKeyVersion: 1,
            granterUserId: a.userId,
            ...atRoster(left),
        };
        await expect(
            sealAreaGrant(pattern(32, 77), grantCtx, {
                chain: left,
                areaIdSeed: AREA_SEED,
                granteeKemPublicKey: g.kemPublicKey,
                granter: a.signer,
            }),
        ).rejects.toThrow('granted only by active members');
        // A seal from before a's identity changed opens with their history, unless a second
        // successor they signed from the same key makes it a fork: then no history counts.
        const byA = await sealGroupKey(seed, keyCtx(a.userId), {
            chain,
            holderKemPublicKey: o.kemPublicKey,
            sealer: a.signer,
        });
        const { next: a2, link } = await succeed(a);
        const other = await person(2, 9);
        const second = await linkBetween(a, other);
        // a's identity folded in at 2.
        const g2 = await history();
        await g2.roster(o, [own, a.entry(['members']), g.entry([])]);
        await g2.roster(o, [own, a2.entry(['members']), g.entry([])]);
        const folded = await acceptedOf(g2, [o, a, a2, g]);
        const open = (links: (typeof link)[]) =>
            openGroupKey(byA, keyCtx(a.userId), {
                chain: folded,
                sealerMlDsaPublicKey: a2.mlDsaPublicKey,
                sealerHistory: { served: a2.served, links },
                reader: { userId: o.userId, keyVersion: 1 },
                holder: o.secrets,
            });
        expect(await open([link])).toEqual(seed);
        for (const links of [
            [link, second],
            [second, link],
        ])
            await expect(open(links)).rejects.toThrow('not sealed by a member who holds it');
        // a2 replaced in turn (not folded in). A seal under a2's keys, the entry's, still opens with
        // a3 served; a3 seals nothing until a roster folds it in.
        const { next: a3, link: link23 } = await succeed(a2);
        const openOn = (
            envelope: Uint8Array,
            at: GroupKeySealContext,
            on: AcceptedRosters,
            served: Person,
            links: (typeof link)[],
        ) =>
            openGroupKey(envelope, at, {
                chain: on,
                sealerMlDsaPublicKey: served.mlDsaPublicKey,
                sealerHistory: { served: served.served, links },
                reader: { userId: o.userId, keyVersion: 1 },
                holder: o.secrets,
            });
        const atFolded = keyCtx(a.userId, folded);
        const byA2 = await sealGroupKey(seed, atFolded, {
            chain: folded,
            holderKemPublicKey: o.kemPublicKey,
            sealer: a2.signer,
        });
        expect(await openOn(byA2, atFolded, folded, a3, [link, link23])).toEqual(seed);
        await expect(
            sealGroupKey(seed, atFolded, {
                chain: folded,
                holderKemPublicKey: o.kemPublicKey,
                sealer: a3.signer,
            }),
        ).rejects.toThrow('not the sealer’s keys');
        // a3 folded in at 3 and sealing there; 4 puts a2 back. a3's seal opens neither on a chain
        // short of roster 3 nor on the one whose entry is a2 again: keys past the entry's never
        // count, a3 served or a4 beyond it.
        await g2.roster(o, [own, a3.entry(['members']), g.entry([])]);
        const withA3 = await acceptedOf(g2, [o, a, a2, a3, g]);
        const atA3 = keyCtx(a.userId, withA3);
        const byA3 = await sealGroupKey(seed, atA3, {
            chain: withA3,
            holderKemPublicKey: o.kemPublicKey,
            sealer: a3.signer,
        });
        await expect(openOn(byA3, atA3, folded, a3, [link, link23])).rejects.toThrow(
            'sealed on a member list this device does not have',
        );
        await g2.roster(o, [own, a2.entry(['members']), g.entry([])]);
        const rolledBack = await acceptedOf(g2, [o, a, a2, a3, g]);
        await expect(openOn(byA3, atA3, rolledBack, a3, [link, link23])).rejects.toThrow(
            'not sealed by a member who holds it',
        );
        const { next: a4, link: link34 } = await succeed(a3);
        await expect(openOn(byA3, atA3, rolledBack, a4, [link, link23, link34])).rejects.toThrow(
            'not sealed by a member who holds it',
        );
        // While a holder's planted keys are a's entry, a's real chain (a to a2) never reaches the
        // entry, so it vouches for none of a's keys: a's own earlier seal does not open.
        const p = await history();
        await p.roster(o, [own, a.entry(['members']), g.entry([])]);
        await p.roster(o, [own, { ...outsider.entry(['members']), userId: a.userId }, g.entry([])]);
        await expect(
            openGroupKey(byA, keyCtx(a.userId), {
                chain: await acceptedOf(p, [o, a, outsider, g]),
                sealerMlDsaPublicKey: a2.mlDsaPublicKey,
                sealerHistory: { served: a2.served, links: [link] },
                reader: { userId: o.userId, keyVersion: 1 },
                holder: o.secrets,
            }),
        ).rejects.toThrow('not the ones on the group’s member list');
    });

    test('an area grant opens for its grantee', async () => {
        const { envelope, open, workspaceKey } = await granted();
        expect(envelope).toHaveLength(AREA_GRANT_BYTES);
        expect(await open()).toEqual(workspaceKey);
    });

    test('r10 (decision 4): after the area rotates, its earlier grants still open, in either order', async () => {
        const f = await granted();
        const { organizer, adult, ctx, envelope, open, workspaceKey } = f;
        // The child leaves: the family's removal rotates AREA to version 2 on the same roster.
        const rotated = await accepted(f, [
            f.members,
            (p) => [p.organizer.entry(OWNER), p.adult.entry([]), p.child.entry([], 1, 'left')],
        ]);
        expect(areaWriteVersion(rotated, AREA)).toBe(2);
        const later = { ...ctx, workspaceKeyVersion: 2, ...atRoster(rotated) };
        const sealed = await sealAreaGrant(areaKeyAt(AREA, 2), later, {
            chain: rotated,
            areaIdSeed: AREA_SEED,
            granteeKemPublicKey: adult.kemPublicKey,
            granter: organizer.signer,
        });
        expect(await open({ chain: rotated }, later, sealed)).toEqual(areaKeyAt(AREA, 2));
        // No high-water mark: the version 1 grant opens after the version 2 one has.
        expect(await open({ chain: rotated }, ctx, envelope)).toEqual(workspaceKey);
    });

    test('a grant from a left granter, for another group or workspace, or another reader does not open', async () => {
        const f = await granted();
        const { organizer, adult, child, ctx, open } = f;
        // r11: the organizer leaves on a roster another holder signs, and a holder remains.
        const left = await accepted(
            f,
            [
                f.members,
                (p) => [p.organizer.entry(OWNER), p.adult.entry(['members']), p.child.entry([])],
                (p) => [
                    p.organizer.entry(OWNER, 1, 'left'),
                    p.adult.entry(['members']),
                    p.child.entry([]),
                ],
            ],
            undefined,
            'family',
            [organizer, organizer, adult],
        );
        await expect(open({ chain: left })).rejects.toThrow('not from an active member');
        await expect(open({}, { ...ctx, groupId: OTHER_GROUP })).rejects.toThrow('another group');
        // A version the roster does not list (r9): refused before anything is opened.
        await expect(open({}, { ...ctx, workspaceKeyVersion: 4 })).rejects.toThrow(
            'key version is not on the group’s member list',
        );
        await expect(open({ reader: { userId: child.userId, keyVersion: 1 } })).rejects.toThrow(
            'not for this account’s keys',
        );
        await expect(open({ reader: { userId: adult.userId, keyVersion: 2 } })).rejects.toThrow(
            'not for this account’s keys',
        );
        // Never granted to a former member.
        const gone = await accepted(f, [
            f.members,
            (p) => [p.organizer.entry(OWNER), p.adult.entry([], 1, 'left'), p.child.entry([])],
        ]);
        await expect(
            sealAreaGrant(
                f.workspaceKey,
                { ...ctx, ...atRoster(gone) },
                {
                    chain: gone,
                    areaIdSeed: AREA_SEED,
                    granteeKemPublicKey: adult.kemPublicKey,
                    granter: organizer.signer,
                },
            ),
        ).rejects.toThrow('only to active members');
    });

    test('a grant naming this group for a workspace not derived under it opens nothing', async () => {
        const { organizer, adult, chain, ctx, open } = await granted();
        // Another group's area, by its own seed: genuine, but not this group's.
        const foreign = { ...ctx, workspaceId: OTHER_AREA };
        const sealed = await sealHybrid(
            pattern(32, 1),
            {
                encryptionPublicKey: Buffer.from(adult.served.encryptionPublicKey, 'base64url'),
                kemPublicKey: adult.kemPublicKey,
            },
            organizer.signer,
            {
                info: 'hushos/group/area-grant/v1',
                associatedData: areaGrantContext(foreign),
                statement: (bytes) => areaGrantStatement(foreign, bytes),
                noun: 'grant',
                invalid: 'x',
                unsigned: 'x',
            },
        );
        await expect(open({ areaIdSeed: OTHER_AREA_SEED }, foreign, sealed)).rejects.toThrow(
            'does not belong to the group',
        );
        // This group's area id with a seed that does not derive it.
        await expect(open({ areaIdSeed: OTHER_AREA_SEED })).rejects.toThrow(
            'does not belong to the group',
        );
        // Nor is such a grant ever sealed.
        await expect(
            sealAreaGrant(pattern(32, 1), foreign, {
                chain,
                areaIdSeed: OTHER_AREA_SEED,
                granteeKemPublicKey: adult.kemPublicKey,
                granter: organizer.signer,
            }),
        ).rejects.toThrow('does not belong to the group');
    });

    test('a grant sealed under another seal kind’s info, or another context as associated data, does not open', async () => {
        const { organizer, adult, ctx, open, workspaceKey } = await granted();
        const recipient = {
            encryptionPublicKey: Buffer.from(adult.served.encryptionPublicKey, 'base64url'),
            kemPublicKey: adult.kemPublicKey,
        };
        const statement = (sealed: Uint8Array) => areaGrantStatement(ctx, sealed);
        const messages = { noun: 'grant', invalid: 'x', unsigned: 'x' };
        // Signed correctly for this grant, but keyed under the key seal's info.
        const otherInfo = await sealHybrid(pattern(32, 1), recipient, organizer.signer, {
            info: 'hushos/group/key-seal/v1',
            associatedData: areaGrantContext(ctx),
            statement,
            ...messages,
        });
        await expect(open({}, ctx, otherInfo)).rejects.toThrow('could not be opened');
        // Or bound to another grant's context.
        const otherContext = await sealHybrid(pattern(32, 1), recipient, organizer.signer, {
            info: 'hushos/group/area-grant/v1',
            associatedData: areaGrantContext({ ...ctx, workspaceKeyVersion: 9 }),
            statement,
            ...messages,
        });
        await expect(open({}, ctx, otherContext)).rejects.toThrow('could not be opened');
        // The control: the same construction with this grant's own info and context opens.
        const genuine = await sealHybrid(workspaceKey, recipient, organizer.signer, {
            info: 'hushos/group/area-grant/v1',
            associatedData: areaGrantContext(ctx),
            statement,
            ...messages,
        });
        expect(await open({}, ctx, genuine)).toEqual(workspaceKey);
        // r9: the same, delivering another key under the listed version: the commitment refuses it
        // (only a granter who skipped sealAreaGrant's own check can make one).
        const otherKey = await sealHybrid(pattern(32, 1), recipient, organizer.signer, {
            info: 'hushos/group/area-grant/v1',
            associatedData: areaGrantContext(ctx),
            statement,
            ...messages,
        });
        await expect(open({}, ctx, otherKey)).rejects.toThrow(
            'not the one the group’s member list names',
        );
    });

    test('a member signature checked through the roster needs the ML-DSA key the entry names', async () => {
        const f = await family();
        const { organizer, outsider } = f;
        const chain = await accepted(f, [(p) => [p.organizer.entry(OWNER), p.adult.entry([])]]);
        const message = bytes('roster bytes');
        // The outsider signs with the organizer's Ed25519 key beside their own ML-DSA key,
        // and the server serves the outsider's ML-DSA key as the organizer's.
        const forged = await signHybrid(message, {
            signingKey: organizer.signer.signingKey,
            mlDsaSecretKey: outsider.signer.mlDsaSecretKey,
        });
        expect(
            await verifyHybrid(message, forged, {
                signingPublicKey: Buffer.from(organizer.served.signingPublicKey, 'base64url'),
                mlDsaPublicKey: outsider.mlDsaPublicKey,
            }),
        ).toBe(true);
        expect(
            await verifyMemberSignature(
                chain,
                organizer.userId,
                outsider.mlDsaPublicKey,
                message,
                forged,
            ),
        ).toBe(false);
        await expect(
            memberSigner(chain, organizer.userId, outsider.mlDsaPublicKey),
        ).rejects.toThrow('not the ones on the group’s member list');
        const genuine = await signHybrid(message, organizer.signer);
        expect(
            await verifyMemberSignature(
                chain,
                organizer.userId,
                organizer.mlDsaPublicKey,
                message,
                genuine,
            ),
        ).toBe(true);
        expect(
            await verifyMemberSignature(
                chain,
                outsider.userId,
                outsider.mlDsaPublicKey,
                message,
                genuine,
            ),
        ).toBe(false);
    });
});

describe('group and area ids', () => {
    const SCOPE = '11111111-1111-4111-8111-111111111111';
    const counting = encode(Uint8Array.from({ length: 16 }, (_, i) => i));

    test('derive the known answers of a third implementation', async () => {
        // Computed with Python's hashlib over ["hushos/id",1,kind,scope,seed].
        expect(await deriveId('group', SCOPE, counting)).toBe(
            '42c6fdd2-9543-8b80-91e2-96fabf53d061',
        );
        expect(await deriveId('workspace', SCOPE, counting)).toBe(
            '6407e0fd-93df-8a89-98a2-3322d10516a8',
        );
    });

    test('an id not derived from its seed and scope is refused with one answer', async () => {
        const id = await deriveId('group', SCOPE, counting);
        expect(await checkId('group', SCOPE, counting, id)).toBe(id);
        const refusals = [
            () => checkId('group', GROUP, counting, id),
            () => checkId('workspace', SCOPE, counting, id),
            () => checkId('group', SCOPE, encode(new Uint8Array(16).fill(1)), id),
            () => checkId('group', SCOPE, 'not a seed', id),
            () => checkId('group', SCOPE, counting, id.toUpperCase()),
        ];
        for (const refusal of refusals)
            await expect(refusal()).rejects.toThrow(
                'This id was not made for this workspace or group.',
            );
    });
});

describe('round 8', () => {
    const OWNER_ROLES: ('billing' | 'guardian' | 'members')[] = ['billing', 'guardian', 'members'];

    test('Opus 6: the sealer’s Ed25519 key comes from its seed; a libsodium key whose halves disagree seals nothing', async () => {
        const [o, a, outsider] = await Promise.all([person(1), person(2), person(5)]);
        const h = await history();
        await h.roster(o, [o.entry(OWNER_ROLES), a.entry(['members'])]);
        const chain = await acceptedOf(h, [o, a]);
        const ctx = {
            groupId: GROUP,
            groupKeyVersion: 1,
            holderUserId: o.userId,
            holderKeyVersion: 1,
            sealerUserId: a.userId,
            ...atRoster(chain),
        };
        const seal = (signingKey: Uint8Array) =>
            sealGroupKey(pattern(64, 91), ctx, {
                chain,
                holderKemPublicKey: o.kemPublicKey,
                sealer: { signingKey, mlDsaSecretKey: a.signer.mlDsaSecretKey },
            });
        // The outsider's seed with a's public half: the entry's key on its face, not the seed's.
        const mixed = new Uint8Array(64);
        mixed.set(outsider.signer.signingKey.subarray(0, 32));
        mixed.set(a.signer.signingKey.subarray(32), 32);
        await expect(seal(mixed)).rejects.toThrow('not the sealer’s keys');
        // a's seed with another public half: the seed's key is the entry's, but libsodium signs
        // with the stored half, so the seal would verify under no one's key. Refused up front.
        const foreignHalf = new Uint8Array(64);
        foreignHalf.set(a.signer.signingKey.subarray(0, 32));
        foreignHalf.set(outsider.signer.signingKey.subarray(32), 32);
        await expect(seal(foreignHalf)).rejects.toThrow('not the sealer’s keys');
        await expect(seal(a.signer.signingKey.subarray(0, 48))).rejects.toThrow(
            'not the sealer’s keys',
        );
        await expect(seal(a.signer.signingKey.subarray(0, 32))).rejects.toThrow(
            'not the sealer’s keys',
        );
        // a's own libsodium key, seed and public half together, seals.
        expect(await seal(a.signer.signingKey)).toHaveLength(4597);
    });

    test('Fable F2 and the sameGroup check: seals name the sealer’s latest roster; another group’s context is refused as such', async () => {
        const [o, a] = await Promise.all([person(1), person(2)]);
        const h = await history();
        await h.roster(o, [o.entry(OWNER_ROLES), a.entry(['members'])]);
        const one = await acceptedOf(h, [o, a]);
        await h.roster(o, [o.entry(OWNER_ROLES), a.entry(['members', 'billing'])]);
        const two = await acceptedOf(h, [o, a]);
        const ctx = {
            groupId: GROUP,
            groupKeyVersion: 1,
            holderUserId: a.userId,
            holderKeyVersion: 1,
            sealerUserId: o.userId,
        };
        const seal = (at: AcceptedRosters, on: AcceptedRosters, groupId = GROUP) =>
            sealGroupKey(
                pattern(64, 91),
                { ...ctx, groupId, ...atRoster(at) },
                {
                    chain: on,
                    holderKemPublicKey: a.kemPublicKey,
                    sealer: o.signer,
                },
            );
        // Sealing names the latest roster the sealer accepted, never an earlier one.
        await expect(seal(one, two)).rejects.toThrow('names the latest member list');
        await expect(seal(two, two, OTHER_GROUP)).rejects.toThrow('This is for another group.');
        const atOne = await seal(one, one);
        const open = (on: AcceptedRosters, at = one, groupId = GROUP) =>
            openGroupKey(
                atOne,
                { ...ctx, groupId, ...atRoster(at) },
                {
                    chain: on,
                    sealerMlDsaPublicKey: o.mlDsaPublicKey,
                    reader: { userId: a.userId, keyVersion: 1 },
                    holder: a.secrets,
                },
            );
        expect(await open(two)).toEqual(pattern(64, 91));
        await expect(open(two, one, OTHER_GROUP)).rejects.toThrow('This is for another group.');
        // A roster position the opener's chain does not hold, by version or by digest.
        const atTwo = await seal(two, two);
        await expect(
            openGroupKey(
                atTwo,
                { ...ctx, ...atRoster(two) },
                {
                    chain: one,
                    sealerMlDsaPublicKey: o.mlDsaPublicKey,
                    reader: { userId: a.userId, keyVersion: 1 },
                    holder: a.secrets,
                },
            ),
        ).rejects.toThrow('sealed on a member list this device does not have');
        await expect(
            open(two, { ...one, rosterDigest: two.rosterDigest } as AcceptedRosters),
        ).rejects.toThrow('sealed on a member list this device does not have');
        // A grant names its roster the same way, and refuses another group's context as such.
        const grant = {
            groupId: OTHER_GROUP,
            workspaceId: AREA,
            workspaceKeyVersion: 1,
            granteeUserId: a.userId,
            granteeKeyVersion: 1,
            granterUserId: o.userId,
            ...atRoster(two),
        };
        await expect(
            sealAreaGrant(pattern(32, 1), grant, {
                chain: two,
                areaIdSeed: 'pMrxFz5ki7HY_iVLcpi_5Q',
                granteeKemPublicKey: a.kemPublicKey,
                granter: o.signer,
            }),
        ).rejects.toThrow('This is for another group.');
    });

    test('Codex 3 and 6: one statement grammar and size cap in parse and encode, and a roster member cap', async () => {
        const text = (s: string) => new TextEncoder().encode(s);
        for (const { name, statement, expected } of statementCases())
            expect(statementVerdict(statement), name).toBe(expected);
        expect(() =>
            parseStatement(new Uint8Array(MAX_STATEMENT_BYTES + 1).fill(0x20), 'x'),
        ).toThrow();
        const long = `["${'a'.repeat(MAX_STATEMENT_BYTES)}"]`;
        expect(() => parseStatement(text(long), 'x')).toThrow();
        expect(() => encodeStatement(['a'.repeat(MAX_STATEMENT_BYTES)])).toThrow(
            'Invalid statement.',
        );
        for (const bad of [[1.5], [-1], [-0], [true], [{}], ['a"b'], ['é'], [[[[['deep']]]]]])
            expect(() => encodeStatement(bad), JSON.stringify(bad)).toThrow('Invalid statement.');
        // A roster of MAX_ROSTER_MEMBERS entries builds; one more does not, nor parses.
        const o = await person(1);
        const entry = o.entry(OWNER_ROLES);
        const members = Array.from({ length: MAX_ROSTER_MEMBERS + 1 }, (_, i) => ({
            ...entry,
            userId: `${i.toString(16).padStart(8, '0')}-abcd-4abc-8abc-abcdefabcdef`,
        }));
        const roster = {
            groupId: GROUP,
            kind: 'org' as const,
            rosterVersion: 1,
            previousRosterDigest: '',
            groupKeyVersion: 1,
            signerUserId: members[0]!.userId,
            members: members.slice(0, MAX_ROSTER_MEMBERS),
        };
        const bytes = rosterStatement(roster);
        expect(parseRoster(bytes).members).toHaveLength(MAX_ROSTER_MEMBERS);
        expect(() => rosterStatement({ ...roster, members })).toThrow('Invalid roster members.');
        const over = JSON.parse(new TextDecoder().decode(bytes));
        over[8].push(
            [...over[8].at(-1)].map((v: unknown, i: number) =>
                i === 0 ? members.at(-1)!.userId : v,
            ),
        );
        expect(() => parseRoster(text(JSON.stringify(over)))).toThrow('Invalid roster members.');
        // A large statement encodes to base64url without exceeding the engine's argument limit.
        expect(encode(bytes).length).toBeGreaterThan(65536);
    }, 30_000); // builds 10,000-member rosters and 4 MiB statements: about 6 s on a CI runner

    test('Codex 1 and 5: identity key versions stop at 2^53 - 1; an empty byte string is never canonical', async () => {
        const [a, b] = await Promise.all([person(2), person(3)]);
        const link = {
            userId: a.userId,
            oldKeyVersion: 1,
            newKeyVersion: 2 ** 53,
            oldEncryptionPublicKey: a.served.encryptionPublicKey,
            oldSigningPublicKey: a.served.signingPublicKey,
            oldMlDsaPublicKey: a.served.mlDsaPublicKey,
            newEncryptionPublicKey: b.served.encryptionPublicKey,
            newSigningPublicKey: b.served.signingPublicKey,
            newMlDsaPublicKey: b.served.mlDsaPublicKey,
            newKemPublicKey: b.served.kemPublicKey,
        };
        await expect(successionStatement(link)).rejects.toThrow('Invalid key version.');
        expect(await successionStatement({ ...link, newKeyVersion: 2 ** 53 - 1 })).toBeInstanceOf(
            Uint8Array,
        );
        await expect(
            keysStatement({
                userId: a.userId,
                keyVersion: 2 ** 53,
                encryptionPublicKey: a.served.encryptionPublicKey,
                signingPublicKey: a.served.signingPublicKey,
                mlDsaPublicKey: a.served.mlDsaPublicKey,
                kemPublicKey: a.served.kemPublicKey,
            }),
        ).rejects.toThrow('Invalid key version.');
        expect(() => bytesOf('', 0, 'x')).toThrow('Invalid x.');
    });
});

describe('round 9', () => {
    test('r12 (final 1): an area key commitment is HKDF of the key alone, under the v2 info', async () => {
        // Known answer, computed apart from either twin: HKDF-SHA-256(32 bytes of 7, salt 32 zero
        // bytes, info "hushos/group/area-key/v2"), base64url.
        expect(await areaKeyCommitment(new Uint8Array(32).fill(7))).toBe(
            'QeVVJkoRU9t43GAdo9MEOT7DgN0pnhyEEctuo9nXDnY',
        );
        const key = pattern(32, 77);
        expect(await areaKeyCommitment(Uint8Array.from(key))).toBe(await areaKeyCommitment(key));
        expect(await areaKeyCommitment(pattern(32, 78))).not.toBe(await areaKeyCommitment(key));
        for (const bad of [pattern(31, 77), new Uint8Array(33)])
            await expect(areaKeyCommitment(bad)).rejects.toThrow('Invalid workspace key.');
    });

    test('r10: a roster carries the areas it creates or rotates, one row each, sorted, at most 256', async () => {
        const { roster } = await family();
        const standard = await standardAreas();
        const second = {
            workspaceId: SECOND_AREA,
            workspaceKeyVersion: 4,
            commitment: await areaKeyCommitment(pattern(32, 79)),
        };
        const listed = { ...roster, areas: [...standard, second] };
        const statement = text(rosterStatement(listed));
        expect(
            statement.endsWith(
                `,[["${AREA}",1,"${standard[0]!.commitment}"],["${SECOND_AREA}",4,"${second.commitment}"]]]`,
            ),
        ).toBe(true);
        expect(parseRoster(rosterStatement(listed))).toEqual(listed);
        expect(text(rosterStatement(roster)).endsWith(',[]]')).toBe(true);
        for (const areas of [
            [standard[0]!, standard[0]!],
            [second, ...standard],
            [standard[0]!, { ...second, workspaceId: AREA }],
            [{ ...standard[0]!, commitment: 'AA' }],
            [{ ...standard[0]!, workspaceId: AREA.toUpperCase() }],
            [{ ...standard[0]!, workspaceKeyVersion: 0 }],
        ])
            expect(
                () => rosterStatement({ ...roster, areas }),
                JSON.stringify(areas).slice(0, 60),
            ).toThrow(CryptoError);
        // The per-roster cap, and a nine-part roster (the form before areas) no longer parses.
        const many = Array.from({ length: MAX_ROSTER_AREA_ROWS + 1 }, (_, i) => ({
            ...standard[0]!,
            workspaceId: `${i.toString(16).padStart(8, '0')}-abcd-4abc-8abc-abcdefabcdef`,
        }));
        expect(() => rosterStatement({ ...roster, areas: many })).toThrow('Invalid roster areas.');
        expect(() => rosterStatement({ ...roster, areas: many.slice(1) })).not.toThrow();
        const nine = JSON.parse(statement) as unknown[];
        nine.pop();
        expect(() => parseRoster(bytes(JSON.stringify(nine)))).toThrow('Invalid roster.');
    });

    test('Opus 1 / Fable A: an honest member kept behind cannot pass on a key the real chain does not list', async () => {
        const [o, g, h, b] = await Promise.all([person(1), person(2), person(3), person(4)]);
        const owner = o.entry(['billing', 'guardian', 'members']);
        const real = await history();
        await real.roster(o, [owner, g.entry([]), h.entry(['members']), b.entry([])]);
        // G's device stays here: H still active, AREA at version 1.
        const behind = await acceptedOf(real, [o, g, h, b]);
        // On the real chain H is removed, AREA rotated to version 2 on the same roster (the rules
        // ask it), and the key replaced.
        await real.roster(o, [owner, g.entry([]), h.entry(['members'], 2, 'left'), b.entry([])]);
        await real.succession(o);
        const rotated = areaKeyAt(AREA, 2);
        const latest = await acceptedOf(real, [o, g, h, b]);
        expect(areaWriteVersion(latest, AREA)).toBe(2);
        expect(areaWriteVersion(behind, AREA)).toBe(1);
        expect(areaWriteVersion(latest, SECOND_AREA)).toBeNull();
        // G rotating on its own view: version 2 is not on G's latest roster, so nothing is sealed.
        const ctx: AreaGrantContext = {
            groupId: GROUP,
            workspaceId: AREA,
            workspaceKeyVersion: 2,
            granteeUserId: b.userId,
            granteeKeyVersion: 1,
            granterUserId: g.userId,
            ...atRoster(behind),
        };
        const options = {
            chain: behind,
            areaIdSeed: AREA_SEED,
            granteeKemPublicKey: b.kemPublicKey,
            granter: g.signer,
        };
        await expect(sealAreaGrant(pattern(32, 90), ctx, options)).rejects.toThrow(
            'not the one the group’s member list names',
        );
        // A granter who skips that check (H's key under version 2, named at roster 1): B's
        // latest roster lists version 2 with the real key's commitment, so it opens nothing.
        const recipient = {
            encryptionPublicKey: Buffer.from(b.served.encryptionPublicKey, 'base64url'),
            kemPublicKey: b.kemPublicKey,
        };
        const forged = await sealHybrid(pattern(32, 90), recipient, g.signer, {
            info: 'hushos/group/area-grant/v1',
            associatedData: areaGrantContext(ctx),
            statement: (sealed) => areaGrantStatement(ctx, sealed),
            noun: 'grant',
            invalid: 'x',
            unsigned: 'x',
        });
        const open = (envelope: Uint8Array, at: AcceptedRosters) =>
            openAreaGrant(envelope, ctx, {
                chain: at,
                areaIdSeed: AREA_SEED,
                granterMlDsaPublicKey: g.mlDsaPublicKey,
                reader: { userId: b.userId, keyVersion: 1 },
                grantee: b.secrets,
            });
        await expect(open(forged, latest)).rejects.toThrow(
            'not the one the group’s member list names',
        );
        // On G's own view version 2 is not listed at all.
        await expect(open(forged, behind)).rejects.toThrow(
            'key version is not on the group’s member list',
        );
        // The real rotated key, granted the same way, opens on the real chain.
        const genuine = await sealHybrid(rotated, recipient, g.signer, {
            info: 'hushos/group/area-grant/v1',
            associatedData: areaGrantContext(ctx),
            statement: (sealed) => areaGrantStatement(ctx, sealed),
            noun: 'grant',
            invalid: 'x',
            unsigned: 'x',
        });
        expect(await open(genuine, latest)).toEqual(rotated);
        // Version 1's key, which readers need for older files, still opens on the real chain (its
        // commitment is the one roster 1 listed); another key under version 1 does not.
        const v1 = { ...ctx, workspaceKeyVersion: 1 };
        const sealedAt = (key: Uint8Array) =>
            sealHybrid(key, recipient, g.signer, {
                info: 'hushos/group/area-grant/v1',
                associatedData: areaGrantContext(v1),
                statement: (sealed) => areaGrantStatement(v1, sealed),
                noun: 'grant',
                invalid: 'x',
                unsigned: 'x',
            });
        const openV1 = async (key: Uint8Array) =>
            openAreaGrant(await sealedAt(key), v1, {
                chain: latest,
                areaIdSeed: AREA_SEED,
                granterMlDsaPublicKey: g.mlDsaPublicKey,
                reader: { userId: b.userId, keyVersion: 1 },
                grantee: b.secrets,
            });
        expect(await openV1(pattern(32, 77))).toEqual(pattern(32, 77));
        await expect(openV1(pattern(32, 90))).rejects.toThrow(
            'not the one the group’s member list names',
        );
    });

    test('r10, r11: nextRoster turns new area keys into rows; a removal rotates every area; no admission on a holder removal', async () => {
        const [o, a, h, c] = await Promise.all([person(1), person(2), person(3), person(4)]);
        const owner = o.entry(['billing', 'guardian', 'members']);
        const hist = await history();
        await hist.roster(o, [owner, a.entry([]), h.entry(['members'])]);
        const chain = await acceptedOf(hist, [o, a, h]);
        const members = [owner, a.entry([]), h.entry(['members'])];
        const next = (list: typeof members, areaKeys?: AreaKey[]) =>
            nextRoster(chain, list, { signerUserId: o.userId, areaKeys });
        expect((await next(members)).areas).toEqual([]);
        const rotation = { workspaceId: AREA, workspaceKey: pattern(32, 78) };
        const created = { workspaceId: SECOND_AREA, workspaceKey: pattern(32, 79) };
        const row = await nextAreaKey(chain, AREA, rotation.workspaceKey);
        const fresh = await nextAreaKey(chain, SECOND_AREA, created.workspaceKey);
        expect([row.workspaceKeyVersion, fresh.workspaceKeyVersion]).toEqual([2, 1]);
        expect((await next(members, [created, rotation])).areas).toEqual([row, fresh]);
        // r11 (Opus 6): no key the group had before, in this area or another, passes for new;
        // nor one key for two areas, nor one area twice.
        const earlier = pattern(32, 77);
        await expect(next(members, [{ ...rotation, workspaceKey: earlier }])).rejects.toThrow(
            'earlier keys',
        );
        await expect(next(members, [{ ...created, workspaceKey: earlier }])).rejects.toThrow(
            'earlier keys',
        );
        await expect(nextAreaKey(chain, SECOND_AREA, earlier)).rejects.toThrow('earlier keys');
        await expect(
            next(members, [rotation, { ...created, workspaceKey: rotation.workspaceKey }]),
        ).rejects.toThrow('earlier keys');
        await expect(next(members, [rotation, rotation])).rejects.toThrow('Invalid roster areas');
        await expect(next(members, [{ ...rotation, workspaceId: 'toString' }])).rejects.toThrow(
            CryptoError,
        );
        // A family removal: every area rotates on the same roster, and only then.
        const removing = [owner, a.entry([], 1, 'left'), h.entry(['members'])];
        expect(areasToRotate(chain, removing)).toEqual([AREA]);
        expect(areasToRotate(chain, members)).toEqual([]);
        await expect(next(removing)).rejects.toThrow('rotates every area');
        expect((await next(removing, [rotation])).areas).toEqual([row]);
        // A holder's removal and an admission on one roster: refused, however the areas rotate.
        await expect(
            next([owner, a.entry([]), h.entry(['members'], 1, 'left'), c.entry([])], [rotation]),
        ).rejects.toThrow('No one is admitted');
    });

    test('r11 (Opus 1 = Fable 2): a family at 1,024 areas can still remove someone, and makes no 1,025th', async () => {
        const [o, a, h] = await Promise.all([person(1), person(2), person(3)]);
        const owner = o.entry(['billing', 'guardian', 'members']);
        const ids = Array.from(
            { length: MAX_FAMILY_AREAS },
            (_, i) => `${i.toString(16).padStart(8, '0')}-abcd-4abc-8abc-abcdefabcdef`,
        );
        const keyOf = (i: number, version: number) => {
            const key = new Uint8Array(32);
            new DataView(key.buffer).setUint32(0, i);
            key[4] = version;
            return key;
        };
        const rows = await Promise.all(
            ids.map(async (workspaceId, i) => ({
                workspaceId,
                workspaceKeyVersion: 1,
                commitment: await areaKeyCommitment(keyOf(i, 1)),
            })),
        );
        const members = [owner, a.entry([]), h.entry(['members'])];
        const hist = await history();
        await hist.roster(o, members, 1, rows);
        const chain = await acceptedOf(hist, [o, a, h]);
        expect(Object.keys(chain.areaKeys)).toHaveLength(MAX_FAMILY_AREAS);
        // No 1,025th area, as nextRoster builds it or as a hand-built roster carries it.
        const extra = { workspaceId: SECOND_AREA, workspaceKey: pattern(32, 79) };
        await expect(
            nextRoster(chain, members, { signerUserId: o.userId, areaKeys: [extra] }),
        ).rejects.toThrow('at most 1,024 areas');
        const over = await history();
        await over.roster(o, members, 1, rows);
        await over.roster(o, members, 1, [
            await nextAreaKey(chain, SECOND_AREA, extra.workspaceKey),
        ]);
        await expect(acceptedOf(over, [o, a, h])).rejects.toThrow('at most 1,024 areas');
        // The removal rotates all 1,024 in one roster, as nextRoster builds it, and it holds.
        const removing = [owner, a.entry([], 1, 'left'), h.entry(['members'])];
        const areaKeys = areasToRotate(chain, removing).map((workspaceId) => ({
            workspaceId,
            workspaceKey: keyOf(ids.indexOf(workspaceId), 2),
        }));
        const removal = await nextRoster(chain, removing, { signerUserId: o.userId, areaKeys });
        expect(removal.areas).toHaveLength(MAX_FAMILY_AREAS);
        expect(rosterStatement(removal).length).toBeLessThan(120_000);
        await hist.roster(o, removing, 1, removal.areas);
        expect((await acceptedOf(hist, [o, a, h])).roster.rosterVersion).toBe(2);
    }, 120_000);

    test('r11 (Opus 7): an inherited name is no area', async () => {
        const [o, a] = await Promise.all([person(1), person(2)]);
        const hist = await history();
        await hist.roster(o, [o.entry(['billing', 'guardian', 'members']), a.entry([])]);
        const chain = await acceptedOf(hist, [o, a]);
        for (const name of ['constructor', 'toString', '__proto__', AREA.toUpperCase()])
            expect(areaWriteVersion(chain, name)).toBeNull();
        expect(areaWriteVersion(chain, AREA)).toBe(1);
        await expect(nextAreaKey(chain, 'toString', pattern(32, 90))).rejects.toThrow(CryptoError);
    });

    test('r10 (Opus 1): the server’s acceptance makes a StoredChain, which checkNext continues and nothing else takes', async () => {
        const [o, a] = await Promise.all([person(1), person(2)]);
        const owner = o.entry(['billing', 'guardian', 'members']);
        const h = await history();
        await h.roster(o, [owner, a.entry(['members'])]);
        const input = {
            groupId: GROUP,
            firstKeys: h.keys[0]!.publicKey,
            rosters: [...h.rosters],
            successions: [],
            mlDsaKeys: mlDsaKeysOf(o, a),
            cache: null,
        };
        const one = await acceptStoredChain(input);
        expect(one.status).toBe('stored');
        expect(Object.isFrozen(one)).toBe(true);
        await h.roster(o, [owner, a.entry(['members', 'billing'])]);
        const two = await checkNextRoster(one, h.rosters[1]!, mlDsaKeysOf(o, a), null);
        expect([two.status, two.roster.rosterVersion]).toEqual(['stored', 2]);
        // A reader's accepted chain continues to a StoredChain too: the server's record, never the reader's.
        const accepted = await acceptedOf(h, [o, a], { rosters: [h.rosters[0]!] });
        expect(
            (await checkNextRoster(accepted, h.rosters[1]!, mlDsaKeysOf(o, a), null)).status,
        ).toBe('stored');
        const record = storedRecord(two);
        expect(record.origin).toBe('server');
        expect('cache' in two).toBe(false);
        const again = await acceptStoredChain({ ...input, rosters: [], cache: record });
        expect(again.rosterDigest).toBe(two.rosterDigest);
        // r11 (Opus 3): the server's record is no reader's cache, by type and at run time; nor
        // is a reader's cache the server's.
        await expect(
            acceptRosters({
                groupId: GROUP,
                firstKeys: h.keys[0]!.publicKey,
                firstKeysChecked: false,
                pins: [],
                rosters: [],
                successions: [],
                mlDsaKeys: mlDsaKeysOf(o, a),
                me: { userId: a.userId, identities: [servedKeysOf(a)] },
                // @ts-expect-error The server's record is not a GroupChainCache.
                cache: record,
            }),
        ).rejects.toThrow('Invalid member list cache');
        await expect(
            acceptStoredChain({
                ...input,
                rosters: [],
                // @ts-expect-error A device's cache is not the server's record.
                cache: accepted.cache,
            }),
        ).rejects.toThrow('Invalid member list cache');
        expect(() => storedRecord(accepted as unknown as typeof two)).toThrow(
            'not a member list the server accepted',
        );
        expect(() => storedCacheOf(two, Symbol('stored acceptance') as never)).toThrow(
            'Only the server',
        );
        // No seal, opening or verdict takes a stored chain (refused at runtime; a type error too).
        const asAccepted = two as unknown as AcceptedRosters;
        const refusal = 'not a member list this device accepted';
        expect(() => areaWriteVersion(asAccepted, AREA)).toThrow(refusal);
        await expect(nextAreaKey(asAccepted, AREA, pattern(32, 90))).rejects.toThrow(refusal);
        await expect(pinAfter([], asAccepted, CHECKED)).rejects.toThrow(refusal);
        await expect(
            groupWriterTrust({
                groupId: GROUP,
                areas: { [AREA]: 1 },
                reading: { status: 'accepted', chain: asAccepted },
                workspaceId: AREA,
                writerUserId: a.userId,
                pinned: null,
                served: null,
                links: null,
            }),
        ).rejects.toThrow(refusal);
        await expect(
            sealAreaGrant(
                pattern(32, 77),
                {
                    groupId: GROUP,
                    workspaceId: AREA,
                    workspaceKeyVersion: 1,
                    granteeUserId: a.userId,
                    granteeKeyVersion: 1,
                    granterUserId: o.userId,
                    rosterVersion: 2,
                    rosterDigest: two.rosterDigest,
                },
                {
                    chain: asAccepted,
                    areaIdSeed: AREA_SEED,
                    granteeKemPublicKey: a.kemPublicKey,
                    granter: o.signer,
                },
            ),
        ).rejects.toThrow(refusal);
        // Other stored version 1 keys are refused: the anchor is the keys stored.
        await expect(
            acceptStoredChain({ ...input, firstKeys: (await groupKeyAt(2)).publicKey }),
        ).rejects.toThrow();
        // A copy is no stored chain, and only the server entry holds the capability.
        await expect(
            checkNextRoster({ ...two }, h.rosters[1]!, mlDsaKeysOf(o, a), null),
        ).rejects.toThrow();
        await expect(acceptStored(input, Symbol('stored acceptance') as never)).rejects.toThrow(
            'Only the server',
        );
        // The testkit for stored groups: a group id derived under its creator, accounts a test
        // stored, no areas.
        const creator = await person(1, 1, { userId: '5e5e5e5e-5e5e-4e5e-8e5e-5e5e5e5e5e5e' });
        const groupId = await groupIdFor(creator.userId, AREA_SEED);
        const stored = await history('family', { groupId, areas: [] });
        await stored.roster(creator, [creator.entry(['billing', 'guardian', 'members'])]);
        const chain = await acceptStoredChain({
            groupId,
            firstKeys: stored.keys[0]!.publicKey,
            rosters: stored.rosters,
            successions: [],
            mlDsaKeys: mlDsaKeysOf(creator),
            cache: null,
        });
        expect([chain.groupId, chain.roster.members[0]!.userId]).toEqual([groupId, creator.userId]);
        expect(chain.areaKeys).toEqual({});
    });

    test('Opus 3: in a seal’s history, links after the entry’s keys need only their version 2 signature', async () => {
        const [o, a, g] = await Promise.all([person(1), person(2), person(3)]);
        const owner = o.entry(['billing', 'guardian', 'members']);
        const { next: a2, link } = await succeed(a);
        const { next: a3, link: second } = await succeed(a2);
        const { consent: _, ...oneSided } = second;
        const h = await history();
        await h.roster(o, [owner, a.entry(['members']), g.entry([])]);
        const before = await acceptedOf(h, [o, a, g]);
        const workspaceKey = pattern(32, 77);
        const ctx: AreaGrantContext = {
            groupId: GROUP,
            workspaceId: AREA,
            workspaceKeyVersion: 1,
            granteeUserId: g.userId,
            granteeKeyVersion: 1,
            granterUserId: a.userId,
            ...atRoster(before),
        };
        const grant = await sealAreaGrant(workspaceKey, ctx, {
            chain: before,
            areaIdSeed: AREA_SEED,
            granteeKemPublicKey: g.kemPublicKey,
            granter: a.signer,
        });
        // a2 folded in; a3 since, on a version 2 link alone, served now.
        await h.roster(o, [owner, a2.entry(['members']), g.entry([])]);
        const after = await acceptedOf(h, [o, a, a2, g]);
        const open = (links: (typeof link)[]) =>
            openAreaGrant(grant, ctx, {
                chain: after,
                areaIdSeed: AREA_SEED,
                granterMlDsaPublicKey: a2.mlDsaPublicKey,
                granterHistory: { served: a3.served, links },
                reader: { userId: g.userId, keyVersion: 1 },
                grantee: g.secrets,
            });
        expect(await open([link, oneSided])).toEqual(workspaceKey);
        // Before the entry, consent is still asked: the first link on its version 2 signature alone opens nothing.
        const { consent: __, ...firstOneSided } = link;
        await expect(open([firstOneSided, oneSided])).rejects.toThrow();
    });
});
