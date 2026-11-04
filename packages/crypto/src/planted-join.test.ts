import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { acceptRosters, type AcceptInput, type GroupAnchor, type JoinMark } from './group-trust';
import type { ServedKeys } from './identity';
import { decode } from './keys';
import { codeAt, pairCode, pairMatch, type SignedStatementWire } from './session-groups';
import { pinKeysOfServed } from './pins';

/*
 * A real iOS 0.10.0 join over a planted entry (crates/hushos-core/fixtures/v0.10.0/planted-join.json,
 * made by the 0.10.0 core itself, planted_join.rs beside it), held against this
 * twin (docs/optional-verification.md 3.4, "Older apps"). The organizer let
 * person 2 in at roster 2 under keys the server made; person 2's 0.10.0 phone
 * matched the join code over them and joined, finding its entry wrong only
 * afterwards. Here: that device gets no pair code at that roster, the
 * organizer's pair code with it is not the code 0.10.0 compared, and the
 * one-way path (the old join code read to the phone) gives the organizer's
 * device nothing to save. crates/hushos-core/tests/planted_join.rs is the twin.
 */

type Json = Record<string, any>;
const f: Json = JSON.parse(
    readFileSync(
        join(import.meta.dirname, '../../../crates/hushos-core/fixtures/v0.10.0/planted-join.json'),
        'utf8',
    ),
);
const rosters = (f.rosters as Json[]).map((at) => ({
    statement: decode(at.statement),
    signature: { ed25519: decode(at.signature.ed25519), mlDsa: decode(at.signature.mlDsa) },
    signerSignature: decode(at.signerSignature),
}));
const wires = (f.rosters as Json[]).map(
    (at) => ({ statement: at.statement }) as SignedStatementWire,
);
const me = (who: 'manager' | 'newcomer') => ({
    userId: f[who].userId as string,
    identities: [f[who].identity as ServedKeys],
});
const compared: string[] = f.preview.code;

async function chainAs(who: 'manager' | 'newcomer', anchor: GroupAnchor, joinMark?: JoinMark) {
    const input: AcceptInput = {
        groupId: f.groupId,
        firstKeys: f.firstKeys,
        anchor,
        pins: [],
        rosters,
        successions: [],
        mlDsaKeys: f.signerKeys,
        me: me(who),
        cache: null,
        joinMark: joinMark ?? null,
    };
    const chain = await acceptRosters(input);
    if (chain.status !== 'accepted') throw new Error('accepted');
    return chain;
}

describe('a 0.10.0 join over a planted entry', () => {
    test('is taken here as 0.10.0 took it, and its entry found wrong alike', async () => {
        const chain = await chainAs('newcomer', 'join', { rosterVersion: 2, code: compared });
        expect(chain.ownEntryWrongAt).toEqual(f.joined.ownEntryWrongAt);
        expect(chain.rosterDigests).toEqual(f.joined.rosterDigests);
    });

    test('leaves the newcomer’s device no pair code at the planted entry', async () => {
        const chain = await chainAs('newcomer', 'join', { rosterVersion: 2, code: compared });
        expect(await pairCode(chain, me('newcomer'), f.manager.userId, wires)).toEqual({
            status: 'own-entry-wrong',
            rosterVersion: 2,
        });
    });

    test('gives the organizer a pair code with the newcomer that is not the code 0.10.0 compared', async () => {
        const chain = await chainAs('manager', 'created');
        const shown = await pairCode(chain, me('manager'), f.newcomer.userId, wires);
        expect(shown).toMatchObject({ status: 'code', rosterVersion: 2 });
        expect(shown.status === 'code' && shown.code).not.toEqual(compared);
    });

    test('the one-way path gives the old phone its code and the organizer’s device nothing to save', async () => {
        const chain = await chainAs('manager', 'created');
        // The old join code, for the 0.10.0 phone: the very code it compared.
        expect(await codeAt(chain, 2)).toEqual(compared);
        // Taken as a family check's "They match", it is no pair code: no check record, no pin,
        // whatever the organizer's device pinned of the planted keys.
        expect(
            await pairMatch({
                chain,
                me: me('manager'),
                otherUserId: f.newcomer.userId,
                rosters: wires,
                rosterVersion: 2,
                code: compared,
                guard: null,
                settingsPin: await pinKeysOfServed(f.planted, 'seen'),
                checkedAt: '2026-10-18T12:00:00.000Z',
            }),
        ).toEqual({ check: null, pin: null });
    });
});
