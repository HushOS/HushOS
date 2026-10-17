import { describe, expect, test } from 'vitest';
import { CryptoError } from './errors';
import { GROUP, history, mlDsaKeysOf, person, type History, type Person } from './group-testkit';
import { acceptStoredChain, storedRecord } from './group-trust-server';
import { parseGroupSuccession, type SignedGroupStatement } from './groups';
import { encode } from './keys';

/*
 * F10 (docs/groups-invariants.md): the server's acceptance of what it stores,
 * fed records a bug, a bad migration or someone with the database could
 * leave behind. Each must be refused with the rule it breaks, never accepted
 * as a chain and never skipped over to a shorter one, because the server
 * checks every new roster against what this returns. What the core cannot
 * see, a history cut off after its last good link (a valid shorter chain),
 * the server's rebuild refuses by comparing its head row (packages/groups,
 * "a stored history the server's own acceptance refuses").
 */

const NOT_GROUP_SIGNED = 'This roster is not signed by the group key.';
const NOT_MEMBER = 'This is not signed by the member it names.';
const NOT_BY_OLD_KEY = 'This group key succession is not signed by the key it replaces.';
const NOT_FOLLOWING = 'This roster does not follow the last one.';
const NO_SUCCESSION = 'A group key succession is missing.';
const REPLACED_KEY = 'This roster was signed by a group key that has been replaced.';
const OUT_OF_ORDER = 'This group key succession is out of order.';
const BAD_CACHE = 'Invalid member list cache.';

type People = { o: Person; a: Person; b: Person };
async function people(): Promise<People> {
    const [o, a, b] = await Promise.all([person(1), person(2), person(3)]);
    return { o, a, b };
}

/*
 * Four rosters and two successions: b admitted at 2, the key replaced, b made
 * a holder at 3 under key 2, the key replaced again, a role change at 4 under
 * key 3. Every link is needed by the one after it.
 */
async function stored({ o, a, b }: People) {
    const owner = o.entry(['billing', 'guardian', 'members']);
    const h = await history();
    await h.roster(o, [owner, a.entry(['members'])]);
    await h.roster(o, [owner, a.entry(['members']), b.entry([])]);
    await h.succession(o);
    await h.roster(o, [owner, a.entry(['members']), b.entry(['members'])]);
    await h.succession(o);
    await h.roster(o, [owner, a.entry(['billing', 'members']), b.entry(['members'])]);
    return h;
}

/* What the server passes when it rebuilds from its rows: the stored version 1 keys, no record. */
function rebuild(h: History, { o, a, b }: People, over: Partial<StoredInput> = {}): StoredInput {
    return {
        groupId: GROUP,
        firstKeys: h.keys[0]!.publicKey,
        rosters: [...h.rosters],
        successions: [...h.successions],
        mlDsaKeys: mlDsaKeysOf(o, a, b),
        cache: null,
        ...over,
    };
}
type StoredInput = Parameters<typeof acceptStoredChain>[0];

/* The statement with `from` replaced by `to` once, its signatures kept: what a bad write leaves. */
function edited(signed: SignedGroupStatement, from: string, to: string): SignedGroupStatement {
    const text = new TextDecoder().decode(signed.statement);
    expect(text.split(from)).toHaveLength(2);
    return { ...signed, statement: new TextEncoder().encode(text.replace(from, to)) };
}
const flipped = (bytes: Uint8Array, at = 7) => {
    const copy = Uint8Array.from(bytes);
    copy[at]! ^= 1;
    return copy;
};

async function refused(input: StoredInput, message: string) {
    const outcome = await acceptStoredChain(input).then(
        (chain) => chain,
        (error: unknown) => error,
    );
    expect(outcome).toBeInstanceOf(CryptoError);
    expect((outcome as Error).message).toBe(message);
}

describe('the stored chain fed a corrupt record', () => {
    test('a stored roster or succession with tampered bytes is refused at that link', async () => {
        const who = await people();
        const h = await stored(who);
        expect((await acceptStoredChain(rebuild(h, who))).roster.rosterVersion).toBe(4);
        const atRoster = (index: number, statement: SignedGroupStatement) =>
            rebuild(h, who, { rosters: h.rosters.map((r, i) => (i === index ? statement : r)) });

        // Roster 2 edited to make b a holder, its signatures kept.
        const b2 = edited(h.rosters[1]!, '"active",[],2]', '"active",["members"],2]');
        // As the head it fails its signatures; below the head the next roster no longer links to it.
        await refused(
            rebuild(h, who, { rosters: [h.rosters[0]!, b2], successions: [] }),
            NOT_GROUP_SIGNED,
        );
        await refused(atRoster(1, b2), NOT_FOLLOWING);
        // Either half of the group's hybrid signature alone, and the signer's own signature.
        const r3 = h.rosters[2]!;
        await refused(
            atRoster(2, {
                ...r3,
                signature: { ...r3.signature, ed25519: flipped(r3.signature.ed25519) },
            }),
            NOT_GROUP_SIGNED,
        );
        await refused(
            atRoster(2, {
                ...r3,
                signature: { ...r3.signature, mlDsa: flipped(r3.signature.mlDsa) },
            }),
            NOT_GROUP_SIGNED,
        );
        await refused(
            atRoster(2, { ...r3, signerSignature: flipped(r3.signerSignature) }),
            NOT_MEMBER,
        );
        // The first succession edited to hand over to another key.
        const s1 = h.successions[0]!;
        const newKey = parseGroupSuccession(s1.statement).newEd25519PublicKey;
        const swapped = `${newKey[0] === 'A' ? 'B' : 'A'}${newKey.slice(1)}`;
        await refused(
            rebuild(h, who, { successions: [edited(s1, newKey, swapped), h.successions[1]!] }),
            NOT_BY_OLD_KEY,
        );
        await refused(
            rebuild(h, who, {
                successions: [
                    { ...s1, signerSignature: flipped(s1.signerSignature) },
                    h.successions[1]!,
                ],
            }),
            NOT_MEMBER,
        );
    });

    test('a missing roster or succession is refused, from version 1 and from the server’s record', async () => {
        const who = await people();
        const h = await stored(who);
        await refused(
            rebuild(h, who, { rosters: h.rosters.filter((_, i) => i !== 1) }),
            NOT_FOLLOWING,
        );
        await refused(rebuild(h, who, { successions: [h.successions[1]!] }), NO_SUCCESSION);
        await refused(rebuild(h, who, { successions: [h.successions[0]!] }), NO_SUCCESSION);
        // Continuing from the record kept at roster 2: roster 3 missing after it.
        const two = await acceptStoredChain(
            rebuild(h, who, { rosters: h.rosters.slice(0, 2), successions: [] }),
        );
        const record = storedRecord(two);
        await refused(rebuild(h, who, { rosters: [h.rosters[3]!], cache: record }), NOT_FOLLOWING);
        expect(
            (
                await acceptStoredChain(
                    rebuild(h, who, { rosters: h.rosters.slice(2), cache: record }),
                )
            ).roster.rosterVersion,
        ).toBe(4);
    });

    test('a roster or succession out of order is refused; rows merely listed out of order are the same chain', async () => {
        const who = await people();
        const { o, a, b } = who;
        const owner = o.entry(['billing', 'guardian', 'members']);
        // A roster signed under key 1 after the succession that replaced it.
        const late = await history();
        await late.roster(o, [owner, a.entry(['members'])]);
        await late.succession(o);
        await late.roster(o, [owner, a.entry(['members']), b.entry([])], 1);
        await refused(rebuild(late, who), REPLACED_KEY);
        // A succession tied to roster 1 while roster 2 is still under the key it replaces.
        const early = await history();
        await early.roster(o, [owner, a.entry(['members'])]);
        await early.succession(o);
        const longer = await history();
        await longer.roster(o, [owner, a.entry(['members'])]);
        await longer.roster(o, [owner, a.entry(['members']), b.entry([])]);
        await refused(rebuild(longer, who, { successions: [early.successions[0]!] }), REPLACED_KEY);
        // The second succession tied before the first: refused once a roster needs its key.
        const back = await history();
        await back.roster(o, [owner, a.entry(['members'])]);
        await back.succession(o);
        await back.succession(o);
        const h = await stored(who);
        await refused(
            rebuild(h, who, { successions: [h.successions[0]!, back.successions[1]!] }),
            OUT_OF_ORDER,
        );
        // Links are trusted, row order is not: rows listed backwards are the same chain, head and all.
        const forwards = await acceptStoredChain(rebuild(h, who));
        const backwards = await acceptStoredChain(
            rebuild(h, who, {
                rosters: [...h.rosters].reverse(),
                successions: [...h.successions].reverse(),
            }),
        );
        expect([backwards.rosterDigest, backwards.groupKeyVersion]).toEqual([
            forwards.rosterDigest,
            3,
        ]);
    });

    test('a corrupt record is refused, never continued', async () => {
        const who = await people();
        const h = await stored(who);
        const two = await acceptStoredChain(
            rebuild(h, who, { rosters: h.rosters.slice(0, 2), successions: [] }),
        );
        const record = storedRecord(two);
        const rest = { rosters: h.rosters.slice(2), cache: record };
        // The head roster in the record edited (b made a holder): its digest no longer matches,
        // though roster 3 still links to the digest the record lists.
        const edit = edited(h.rosters[1]!, '"active",[],2]', '"active",["members"],2]');
        await refused(
            rebuild(h, who, { ...rest, cache: { ...record, statement: encode(edit.statement) } }),
            BAD_CACHE,
        );
        // One roster digest dropped: the record says it is at another version than its head.
        await refused(
            rebuild(h, who, {
                ...rest,
                cache: { ...record, rosterDigests: record.rosterDigests.slice(1) },
            }),
            BAD_CACHE,
        );
        // Another group's record.
        await refused(
            rebuild(h, who, {
                ...rest,
                cache: { ...record, groupId: 'ffffffff-ffff-4fff-8fff-ffffffffffff' },
            }),
            BAD_CACHE,
        );
    });
});
