import { describe, expect, test } from 'vitest';
import { areaKeyCommitment, areaRootCommitment } from './area-keys';
import {
    MAX_FAMILY_AREAS,
    areaWriteVersion,
    areasToRotate,
    checkAreaRoot,
    openAreaGrant,
    parseRoster,
    rosterStatement,
    sealAreaGrant,
    signRoster,
    type AreaGrantContext,
    type Roster,
} from './groups';
import {
    AREA,
    AREA_SEED,
    GROUP,
    SECOND_AREA,
    acceptedOf,
    areaKeyAt,
    atRoster,
    groupKeyAt,
    history,
    keyRowAt,
    mlDsaKeysOf,
    pattern,
    person,
    rootKeyAt,
    tombstoneAt,
    READER,
    type Person,
} from './group-testkit';
import { acceptRosters, checkNextRoster, firstRoster, nextRoster } from './group-trust';
import { encode } from './keys';

/*
 * Roster format 2 (docs/groups-design.md 2.10): each area version commits to
 * its root's key under its own label (F14), and an area is retired by a
 * tombstone (F11). Each test fails on a defect a member would notice: a root
 * rolled back, a folder brought back, a removal that stalls on a deleted
 * folder, a grant into a deleted folder. crates/hushos-core holds the same
 * rules (group_trust.rs, groups.rs, `format_2` tests).
 */

const OWNER = ['billing', 'guardian', 'members'] as const;

async function people() {
    const [o, a] = await Promise.all([person(1), person(2)]);
    return { o, a, owner: o.entry([...OWNER]), members: [o.entry([...OWNER]), a.entry([])] };
}

/* The chain after signing `rosters` (each a format 2 roster a builder made) under group key 1. */
async function chainOf(rosters: Roster[], signer: Person, who: Person[]) {
    const key = await groupKeyAt(1);
    const chain = await acceptRosters({
        groupId: GROUP,
        firstKeys: key.publicKey,
        rosters: await Promise.all(rosters.map((r) => signRoster(r, key, signer.signer))),
        successions: [],
        mlDsaKeys: mlDsaKeysOf(...who),
        ...READER,
    });
    if (chain.status !== 'accepted') throw new Error('forked');
    return chain;
}

describe('roster format 2 (design 2.10)', () => {
    test('the root commitment has its own label: a known answer, never the area key’s', async () => {
        // An independent HKDF-SHA-256 (Python's hmac) over 32 bytes of 9.
        const key = new Uint8Array(32).fill(9);
        expect(await areaRootCommitment(key)).toBe('5BrsGtJdWLo9wvZQh3JBv-Sxey7IKfqk6SCY2qFS3eA');
        expect(await areaKeyCommitment(key)).toBe('DeklaQOlULr4P8bdSFSC_53YH1zj8EHdlkSEK4PrMyw');
        await expect(areaRootCommitment(new Uint8Array(31))).rejects.toThrow(
            'Invalid area root key',
        );
    });

    test('format 1 rosters parse to exactly what they did, and format 2 rows round-trip', async () => {
        const { o, members } = await people();
        const one = await firstRoster(GROUP, o.entry([...OWNER]), {
            kind: 'family',
            areaKeys: [{ workspaceId: AREA, workspaceKey: areaKeyAt(AREA, 1) }],
        });
        const bytes = rosterStatement(one);
        expect(new TextDecoder().decode(bytes)).toMatch(/^\["hushos\/group\/roster",1,/);
        expect(parseRoster(bytes)).toEqual(one);
        expect('format' in parseRoster(bytes)).toBe(false);
        const two: Roster = {
            ...one,
            format: 2,
            members,
            areas: [await keyRowAt(AREA, 1), tombstoneAt(SECOND_AREA, 2)],
        };
        expect(parseRoster(rosterStatement(two))).toEqual(two);
        // A format 1 statement cannot carry a root commitment or a tombstone, nor format 2 a key
        // row without its root, nor a tombstone with a key.
        expect(() => rosterStatement({ ...two, format: 1 })).toThrow('Invalid roster area');
        const { rootCommitment: _, ...noRoot } = await keyRowAt(AREA, 1);
        expect(() => rosterStatement({ ...two, areas: [noRoot] })).toThrow();
        const keyed = (await keyRowAt(AREA, 1)).commitment;
        expect(() =>
            rosterStatement({ ...two, areas: [{ ...tombstoneAt(AREA, 2), commitment: keyed }] }),
        ).toThrow('Invalid roster area');
        // The statement's version is the format: a format 2 statement relabelled 1 is refused.
        const relabelled = new TextEncoder().encode(
            new TextDecoder().decode(rosterStatement(two)).replace('roster",2,', 'roster",1,'),
        );
        expect(() => parseRoster(relabelled)).toThrow();
    });

    test('builders take a root key with every format 2 key, and never build a lower format', async () => {
        const { o, a, members } = await people();
        await expect(
            firstRoster(GROUP, o.entry([...OWNER]), {
                kind: 'family',
                format: 2,
                areaKeys: [{ workspaceId: AREA, workspaceKey: areaKeyAt(AREA, 1) }],
            }),
        ).rejects.toThrow('folder’s key');
        await expect(
            firstRoster(GROUP, o.entry([...OWNER]), {
                kind: 'family',
                areaKeys: [
                    {
                        workspaceId: AREA,
                        workspaceKey: areaKeyAt(AREA, 1),
                        rootKey: rootKeyAt(AREA, 1),
                    },
                ],
            }),
        ).rejects.toThrow('format');
        const first = await firstRoster(GROUP, o.entry([...OWNER]), {
            kind: 'family',
            format: 2,
            areaKeys: [
                {
                    workspaceId: AREA,
                    workspaceKey: areaKeyAt(AREA, 1),
                    rootKey: rootKeyAt(AREA, 1),
                },
            ],
        });
        expect(first.areas).toEqual([await keyRowAt(AREA, 1)]);
        const v1 = await firstRoster(GROUP, o.entry([...OWNER]), {
            kind: 'family',
            areaKeys: [{ workspaceId: AREA, workspaceKey: areaKeyAt(AREA, 1) }],
        });
        const chain = await chainOf([first], o, [o, a]);
        // Never down: format 1 on a format 2 chain, nor a retirement in format 1.
        await expect(
            nextRoster(chain, members, { signerUserId: o.userId, format: 1 }),
        ).rejects.toThrow('older format');
        const v1Chain = await chainOf([v1], o, [o, a]);
        await expect(
            nextRoster(v1Chain, members, { signerUserId: o.userId, retireAreas: [AREA] }),
        ).rejects.toThrow('format');
        // A rotation that keeps the root's key is refused before anyone signs it.
        await expect(
            nextRoster(chain, members, {
                signerUserId: o.userId,
                areaKeys: [
                    {
                        workspaceId: AREA,
                        workspaceKey: areaKeyAt(AREA, 2),
                        rootKey: rootKeyAt(AREA, 1),
                    },
                ],
            }),
        ).rejects.toThrow('folder key was used before');
        // Switching up at a boundary: the chain's next roster in format 2, its rotation committed.
        const up = await nextRoster(v1Chain, members, {
            signerUserId: o.userId,
            format: 2,
            areaKeys: [
                {
                    workspaceId: AREA,
                    workspaceKey: areaKeyAt(AREA, 2),
                    rootKey: rootKeyAt(AREA, 2),
                },
            ],
        });
        expect(up.format).toBe(2);
        const switched = await chainOf([v1, up], o, [o, a]);
        expect(await checkAreaRoot(switched, AREA, 2, rootKeyAt(AREA, 2))).toBe(true);
        expect(await checkAreaRoot(switched, AREA, 1, rootKeyAt(AREA, 9))).toBe(false);
        // And after it, nextRoster builds format 2 by default.
        expect((await nextRoster(switched, members, { signerUserId: o.userId })).format).toBe(2);
    });

    test('a reader takes an area root as current only by its commitment', async () => {
        const { o, a, members } = await people();
        const h = await history('family', { format: 2 });
        await h.roster(o, members);
        const chain = await acceptedOf(h, [o, a]);
        expect(await checkAreaRoot(chain, AREA, 1, rootKeyAt(AREA, 1))).toBe(true);
        // An earlier or another root key wrapped under the same area version: refused.
        await expect(checkAreaRoot(chain, AREA, 1, rootKeyAt(AREA, 2))).rejects.toThrow(
            'folder’s key is not the one',
        );
        await expect(checkAreaRoot(chain, AREA, 2, rootKeyAt(AREA, 2))).rejects.toThrow(
            'not on the group’s member list',
        );
        // A format 1 chain committed to no root: the caller keeps the envelope rule.
        const old = await history();
        await old.roster(o, members);
        expect(await checkAreaRoot(await acceptedOf(old, [o, a]), AREA, 1, pattern(32, 1))).toBe(
            false,
        );
    });

    test('a retired area is written, granted and rotated no more, and its earlier grants still open', async () => {
        const { o, a, owner } = await people();
        const members = [owner, a.entry([])];
        const first = await firstRoster(GROUP, owner, {
            kind: 'family',
            format: 2,
            areaKeys: [
                {
                    workspaceId: AREA,
                    workspaceKey: areaKeyAt(AREA, 1),
                    rootKey: rootKeyAt(AREA, 1),
                },
                {
                    workspaceId: SECOND_AREA,
                    workspaceKey: areaKeyAt(SECOND_AREA, 1),
                    rootKey: rootKeyAt(SECOND_AREA, 1),
                },
            ],
        });
        // nextRoster puts the first roster's member list in place for the second.
        const admitted = await nextRoster(await chainOf([first], o, [o, a]), members, {
            signerUserId: o.userId,
        });
        const before = await chainOf([first, admitted], o, [o, a]);
        const ctx: AreaGrantContext = {
            groupId: GROUP,
            workspaceId: AREA,
            workspaceKeyVersion: 1,
            granteeUserId: a.userId,
            granteeKeyVersion: 1,
            granterUserId: o.userId,
            ...atRoster(before),
        };
        const seal = (chain: typeof before, at: AreaGrantContext) =>
            sealAreaGrant(areaKeyAt(AREA, 1), at, {
                chain,
                areaIdSeed: AREA_SEED,
                granteeKemPublicKey: a.kemPublicKey,
                granter: o.signer,
            });
        const envelope = await seal(before, ctx);
        const retire = await nextRoster(before, members, {
            signerUserId: o.userId,
            retireAreas: [AREA],
        });
        expect(retire.areas).toEqual([tombstoneAt(AREA, 2)]);
        const retired = await chainOf([first, admitted, retire], o, [o, a]);
        expect(retired.retiredAreas).toEqual([AREA]);
        expect(areaWriteVersion(retired, AREA)).toBeNull();
        expect(areaWriteVersion(retired, SECOND_AREA)).toBe(1);
        await expect(checkAreaRoot(retired, AREA, 1, rootKeyAt(AREA, 1))).rejects.toThrow(
            'deleted',
        );
        await expect(seal(retired, { ...ctx, ...atRoster(retired) })).rejects.toThrow('deleted');
        const opened = await openAreaGrant(envelope, ctx, {
            chain: retired,
            areaIdSeed: AREA_SEED,
            granterMlDsaPublicKey: o.mlDsaPublicKey,
            reader: { userId: a.userId, keyVersion: 1 },
            grantee: a.secrets,
        });
        expect(opened).toEqual(areaKeyAt(AREA, 1));
        // A removal rotates only the live area; a second tombstone or a new key is refused.
        const removing = [owner, a.entry([], 1, 'left')];
        expect(areasToRotate(retired, removing)).toEqual([SECOND_AREA]);
        const removal = await nextRoster(retired, removing, {
            signerUserId: o.userId,
            areaKeys: [
                {
                    workspaceId: SECOND_AREA,
                    workspaceKey: areaKeyAt(SECOND_AREA, 2),
                    rootKey: rootKeyAt(SECOND_AREA, 2),
                },
            ],
        });
        expect(
            (await chainOf([first, admitted, retire, removal], o, [o, a])).roster.rosterVersion,
        ).toBe(4);
        await expect(
            nextRoster(retired, members, { signerUserId: o.userId, retireAreas: [AREA] }),
        ).rejects.toThrow('deleted');
        await expect(
            nextRoster(retired, members, {
                signerUserId: o.userId,
                areaKeys: [
                    {
                        workspaceId: AREA,
                        workspaceKey: areaKeyAt(AREA, 3),
                        rootKey: rootKeyAt(AREA, 3),
                    },
                ],
            }),
        ).rejects.toThrow('deleted');
        // checkNextRoster is acceptance: a hand-built revival is refused there too.
        const key = await groupKeyAt(1);
        const revival = await signRoster(
            { ...removal, areas: [await keyRowAt(AREA, 3)], members },
            key,
            o.signer,
        );
        await expect(checkNextRoster(retired, revival, mlDsaKeysOf(o, a), null)).rejects.toThrow();
    });

    test('a retired area stops counting toward the family’s 1,024', async () => {
        const { o, a, owner } = await people();
        const ids = Array.from(
            { length: MAX_FAMILY_AREAS },
            (_, i) => `${i.toString(16).padStart(8, '0')}-abcd-4abc-8abc-abcdefabcdef`,
        );
        const keyOf = (i: number, version: number, root: number) => {
            const key = new Uint8Array(32);
            new DataView(key.buffer).setUint32(0, i);
            key[4] = version;
            key[5] = root;
            return key;
        };
        const rows = await Promise.all(
            ids.map(async (workspaceId, i) => ({
                workspaceId,
                workspaceKeyVersion: 1,
                commitment: await areaKeyCommitment(keyOf(i, 1, 0)),
                rootCommitment: await areaRootCommitment(keyOf(i, 1, 1)),
            })),
        );
        const members = [owner, a.entry([])];
        const h = await history('family', { format: 2 });
        await h.roster(o, members, 1, rows);
        const chain = await acceptedOf(h, [o, a]);
        const extra = {
            workspaceId: SECOND_AREA,
            workspaceKey: pattern(32, 79),
            rootKey: pattern(32, 80),
        };
        await expect(
            nextRoster(chain, members, { signerUserId: o.userId, areaKeys: [extra] }),
        ).rejects.toThrow('at most 1,024 areas');
        // Retiring one makes room for one, in the same roster.
        const swap = await nextRoster(chain, members, {
            signerUserId: o.userId,
            areaKeys: [extra],
            retireAreas: [ids[0]!],
        });
        await h.roster(o, members, 1, swap.areas);
        const after = await acceptedOf(h, [o, a]);
        expect(Object.keys(after.areaKeys)).toHaveLength(MAX_FAMILY_AREAS + 1);
        // A removal still fits one roster: the 1,024 live areas, never the retired one.
        const removing = [owner, a.entry([], 1, 'left')];
        const rotate = areasToRotate(after, removing);
        expect(rotate).toHaveLength(MAX_FAMILY_AREAS);
        expect(rotate).not.toContain(ids[0]);
        const removal = await nextRoster(after, removing, {
            signerUserId: o.userId,
            areaKeys: rotate.map((workspaceId) => {
                const i = workspaceId === SECOND_AREA ? 5000 : ids.indexOf(workspaceId);
                return { workspaceId, workspaceKey: keyOf(i, 2, 0), rootKey: keyOf(i, 2, 1) };
            }),
        });
        await h.roster(o, removing, 1, removal.areas);
        expect((await acceptedOf(h, [o, a])).roster.rosterVersion).toBe(3);
        expect(encode(rosterStatement(removal)).length).toBeLessThan(260_000);
    }, 120_000);
});
