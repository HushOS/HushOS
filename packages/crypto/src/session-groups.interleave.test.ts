import { beforeAll, describe, expect, test, vi } from 'vitest';
import { ROOT, sessionOf } from './device-record-testkit';
import type * as Aead from './aead';
import type * as Trust from './group-trust';
import { GROUP, mlDsaKeysOf, pinOf } from './group-testkit';
import { family } from './join-testkit';
import { encode } from './keys';
import type { GroupPin } from './pins';
import type * as Pq from './pq';
import { FAMILY_FORGOTTEN, GUARD_CONFLICT, SPLIT_CHAIN } from './protocol';
import type {
    GroupMessage,
    GroupResults,
    ServedChain,
    SignedStatementWire,
} from './session-groups';
import type { SignedGroupStatement } from './groups';

/*
 * The worker's acceptance and wipe, interleaved where they await
 * (docs/optional-verification.md 2.8): an acceptance paused once its chain is
 * verified and before it commits, a wipe paused while it works out the floor's
 * guard, with another acceptance or a wipe run whole in between. Serial
 * scenarios never reach these orders; the core's twins are the
 * `interleaved_*` tests in crates/hushos-core/src/device_record.rs.
 */

// Each signature verified once, for real (see pq-memo-testkit.ts).
vi.mock('./pq', async (original) =>
    (await import('./pq-memo-testkit')).verifyOnce(await original<typeof Pq>()),
);

/* A pause armed for the next call of acceptRosters ('verify'), pinAfter ('pin') or decryptKey ('decrypt', a device record opening): it waits after the real call returns. */
const { hold, pause } = vi.hoisted(() => {
    type Armed = { reach: () => void; wait: Promise<void> };
    const armed: Record<'verify' | 'pin' | 'decrypt', Armed[]> = {
        verify: [],
        pin: [],
        decrypt: [],
    };
    return {
        hold: async (kind: 'verify' | 'pin' | 'decrypt') => {
            const next = armed[kind].shift();
            if (!next) return;
            next.reach();
            await next.wait;
        },
        pause: (kind: 'verify' | 'pin' | 'decrypt') => {
            let reach!: () => void;
            let release!: () => void;
            const reached = new Promise<void>((resolve) => (reach = resolve));
            const wait = new Promise<void>((resolve) => (release = resolve));
            armed[kind].push({ reach, wait });
            return { reached, release };
        },
    };
});
vi.mock('./aead', async (original) => {
    const real = await original<typeof Aead>();
    return {
        ...real,
        decryptKey: async (...args: Parameters<typeof real.decryptKey>) => {
            const out = await real.decryptKey(...args);
            await hold('decrypt');
            return out;
        },
    };
});
vi.mock('./group-trust', async (original) => {
    const real = await original<typeof Trust>();
    return {
        ...real,
        acceptRosters: async (...args: Parameters<typeof real.acceptRosters>) => {
            const out = await real.acceptRosters(...args);
            await hold('verify');
            return out;
        },
        pinAfter: async (...args: Parameters<typeof real.pinAfter>) => {
            const out = await real.pinAfter(...args);
            await hold('pin');
            return out;
        },
    };
});

const NOW = '2026-10-18T12:00:00.000Z';
const wire = (signed: SignedGroupStatement): SignedStatementWire => ({
    statement: encode(signed.statement),
    signature: { ed25519: encode(signed.signature.ed25519), mlDsa: encode(signed.signature.mlDsa) },
    signerSignature: encode(signed.signerSignature),
});

/*
 * Person 1's session with the settings pin at `succ`'s roster 2 (group key 1),
 * and the two histories above it: `succ` and `succOther` take other
 * successions to key 2 at roster 2, then the same roster 3 statement, so their
 * roster 3 digests are one and only the group key differs.
 */
async function setup() {
    const f = await family();
    const served = (which: 'succ' | 'succOther', through: number): ServedChain => {
        const h = f[which];
        return {
            rosters: h.rosters.slice(0, through).map(wire),
            successions: through > 2 ? h.successions.map(wire) : [],
            firstKeys: f.succ.keys[0]!.publicKey,
            signerKeys: mlDsaKeysOf(f.p1, f.p2, f.p3),
        };
    };
    const pin = await pinOf(f.succ, 2, [f.p1, f.p3]);
    const open = () => {
        const session = sessionOf(f.p1, ROOT);
        session.useSettings(f.p1.userId, { groups: { [GROUP]: pin } });
        let id = 0;
        const sync = (chain: ServedChain, guard: GroupPin | null, record: string | null = null) =>
            session.handle({
                id: ++id,
                operation: 'groupAccept',
                input: {
                    userId: f.p1.userId,
                    groupId: GROUP,
                    served: chain,
                    record,
                    checkedAt: NOW,
                    guard,
                },
            } as GroupMessage) as Promise<GroupResults['groupAccept']>;
        const forget = (guard: GroupPin | null) =>
            session.handle({
                id: ++id,
                operation: 'groupForget',
                input: { groupId: GROUP, guard, checkedAt: NOW },
            } as GroupMessage) as Promise<GroupResults['groupForget']>;
        return { session, ledger: session.ledger, sync, forget };
    };
    const guardOf = (result: GroupResults['groupAccept']) => {
        if (result.status !== 'accepted' || !result.guard) throw new Error('no guard handed back');
        return result.guard;
    };
    const recordOf = (result: GroupResults['groupAccept']) => {
        if (result.status !== 'accepted' || !result.record) throw new Error('no record');
        return result.record;
    };
    return { f, served, open, guardOf, recordOf };
}

describe('acceptances and wipes interleaved', () => {
    beforeAll(() => family());

    test('an acceptance verified over a floor another moved to another group key at the same roster commits nothing, and its guard then holds no wipe of that floor', async () => {
        const { f, served, open, guardOf } = await setup();
        const device = open();
        const two = guardOf(await device.sync(served('succ', 2), null));
        // Both runs begin over the floor at roster 2, key 1. The one through succOther pauses
        // verified; the one through succ commits meanwhile (its guard write then fails: not kept).
        const paused = pause('verify');
        const other = device.sync(served('succOther', 3), two);
        await paused.reached;
        const first = await device.sync(served('succ', 3), two);
        expect(first).toMatchObject({ status: 'accepted', view: { rosterVersion: 3 } });
        paused.release();
        // Same roster digest at 3, another key 2: beside the floor, never committed over it.
        await expect(other).rejects.toThrow(SPLIT_CHAIN);
        const floor = device.ledger.floor(GROUP)!;
        expect(floor.groupKeys[1]).toEqual(f.succ.keys[1]!.publicKey);
        expect(device.ledger.committedChain(GROUP)).toBe(floor);
        // The other history's guard, as another device's acceptance of it would hand back: it
        // disagrees with the floor, so the wipe is refused and the floor stays a mark.
        const elsewhere = open();
        await elsewhere.sync(served('succ', 2), null);
        const beside = guardOf(await elsewhere.sync(served('succOther', 3), two));
        await expect(device.forget(beside)).rejects.toThrow(GUARD_CONFLICT);
        expect(device.ledger.floor(GROUP)).toBe(floor);
        await expect(device.sync(served('succOther', 3), null)).resolves.toMatchObject({
            status: 'fork',
            fork: { of: 'group-key', version: 2 },
        });
    });

    test('a wipe works its guard out again when an acceptance moves the floor while it awaits', async () => {
        const { served, open, guardOf } = await setup();
        const device = open();
        const two = guardOf(await device.sync(served('succ', 2), null));
        // The wipe holds the guard for roster 2, which covers the floor it read; it pauses while
        // that floor's pin is worked out, and an acceptance through roster 3 commits meanwhile.
        const paused = pause('pin');
        const wipe = device.forget(two);
        await paused.reached;
        await expect(device.sync(served('succ', 3), two)).resolves.toMatchObject({
            status: 'accepted',
        });
        paused.release();
        // Over the floor it read it would forget; over the floor now held, roster 3 is not covered.
        const result = await wipe;
        expect(result).toMatchObject({ forgotten: false, unreadable: false });
        expect(result.guard).toMatchObject({ rosterVersion: 3, keyVersion: 2 });
        expect(device.ledger.floor(GROUP)?.roster.rosterVersion).toBe(3);
    });

    test('an acceptance begun before a wipe commits nothing after it, so the family does not come back', async () => {
        const { served, open, guardOf } = await setup();
        const device = open();
        const two = guardOf(await device.sync(served('succ', 2), null));
        const paused = pause('verify');
        const later = device.sync(served('succ', 3), two);
        await paused.reached;
        // The not-member wipe lands while it is verified: the held guard covers the floor at 2.
        await expect(device.forget(two)).resolves.toMatchObject({ forgotten: true, guard: null });
        paused.release();
        await expect(later).rejects.toThrow(FAMILY_FORGOTTEN);
        expect(device.ledger.floor(GROUP)).toBeUndefined();
        expect(device.ledger.committedChain(GROUP)).toBeUndefined();
        // Begun after the wipe, the same run is taken (the break-check).
        await expect(device.sync(served('succ', 3), two)).resolves.toMatchObject({
            status: 'accepted',
            view: { rosterVersion: 3 },
        });
    });

    test('an acceptance a wipe overtakes while its record is still being opened commits nothing, so an older floor does not come back', async () => {
        const { served, open, guardOf, recordOf } = await setup();
        const device = open();
        const first = await device.sync(served('succ', 2), null);
        const [two, record] = [guardOf(first), recordOf(first)];
        const three = guardOf(await device.sync(served('succ', 3), two));
        // A late run from the record and guard at roster 2 pauses while its record is opened,
        // before it has read anything of the family; the wipe, with the guard matching the floor
        // at 3, lands then.
        const paused = pause('decrypt');
        const late = device.sync(served('succ', 2), two, record);
        await paused.reached;
        await expect(device.forget(three)).resolves.toMatchObject({ forgotten: true, guard: null });
        paused.release();
        // It would verify against no floor at all and commit roster 2: the family back, lower.
        await expect(late).rejects.toThrow(FAMILY_FORGOTTEN);
        expect(device.ledger.floor(GROUP)).toBeUndefined();
        expect(device.ledger.committedChain(GROUP)).toBeUndefined();
    });
});
