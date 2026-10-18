import { describe, expect, test } from 'vitest';
import { createAreaLedger } from './area-ledger';
import { family, ROOT, servedOf } from './device-record-testkit';
import { CHECKED, GROUP, pinOf, type Person } from './group-testkit';
import { NOT_THIS_ACCOUNT } from './protocol';
import {
    createGroupSession,
    type GroupHost,
    type GroupMessage,
    type GroupResults,
    type ServedChain,
} from './session-groups';

/*
 * The worker's acceptance commits only into the session and account it began
 * in (the core's commit_served and uncommit_served hold the same): a lock
 * (forget) or another account while the chain is being verified keeps nothing,
 * and a refusal or fork then touches nothing of the family either.
 */

async function sessionFor() {
    const f = await family();
    let current: Person = f.p1;
    const ledger = createAreaLedger();
    const host = {
        unlocked: () => ({ userId: current.userId, root: ROOT.slice(), keyVersion: 1 }),
        identity: () => ({ userId: f.p1.userId, served: f.p1.served, history: [] }),
        ledger,
    } as unknown as GroupHost;
    const session = createGroupSession(host);
    session.useSettings(f.p1.userId, { groups: { [GROUP]: await pinOf(f.h, 1, [f.p1, f.p2]) } });
    const accept = (served: ReturnType<typeof servedOf>) =>
        session.handle({
            id: 1,
            operation: 'groupAccept',
            input: {
                userId: f.p1.userId,
                groupId: GROUP,
                served: {
                    rosters: served.rosters,
                    successions: [],
                    firstKeys: f.h.keys[0]!.publicKey,
                    signerKeys: Object.fromEntries(
                        [f.p1, f.p2].map((p) => [p.mlDsaDigest, p.served.mlDsaPublicKey]),
                    ),
                } as ServedChain,
                record: null,
                checkedAt: CHECKED,
            },
        } as GroupMessage) as Promise<GroupResults['groupAccept']>;
    return { f, session, ledger, accept, switchTo: (who: Person) => (current = who) };
}

describe('an acceptance under a session that changed', () => {
    test('a lock while the chain is verified commits nothing', async () => {
        const { f, session, ledger, accept } = await sessionFor();
        const pending = accept(servedOf(f, { after: 0, through: 3 }));
        session.forget();
        await expect(pending).rejects.toThrow(NOT_THIS_ACCOUNT);
        expect(ledger.floor(GROUP)).toBeUndefined();
        expect(ledger.committedChain(GROUP)).toBeUndefined();
    });

    test('another account while a refusal is reached uncommits nothing of the family', async () => {
        const { f, ledger, accept, switchTo } = await sessionFor();
        expect((await accept(servedOf(f, { after: 0, through: 3 }))).status).toBe('accepted');
        // Junk claiming roster 3: refused, which would uncommit the family, but the account changed.
        const pending = accept(servedOf(f, { after: 0, through: 3, badSignature: true }));
        switchTo(f.p2);
        await expect(pending).rejects.toThrow(NOT_THIS_ACCOUNT);
        expect(ledger.floor(GROUP)?.roster.rosterVersion).toBe(3);
        expect(ledger.committedChain(GROUP)?.roster.rosterVersion).toBe(3);
    });

    test('the same runs with the session unchanged commit, and refuse and uncommit (the break-check)', async () => {
        const { f, ledger, accept } = await sessionFor();
        expect((await accept(servedOf(f, { after: 0, through: 3 }))).status).toBe('accepted');
        expect(ledger.committedChain(GROUP)?.roster.rosterVersion).toBe(3);
        await expect(
            accept(servedOf(f, { after: 0, through: 3, badSignature: true })),
        ).rejects.toThrow();
        expect(ledger.committedChain(GROUP)).toBeUndefined();
        expect(ledger.floor(GROUP)?.roster.rosterVersion).toBe(3);
    });
});
