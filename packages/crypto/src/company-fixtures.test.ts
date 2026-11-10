import { unverifiedHeads } from './committed-heads';
import { describe, expect, test } from 'vitest';
import { listCaseVerdict, type ListCase, type ListStepVerdict } from './company-lists-testkit';
import { companyKeys, sealItemVerdict, type SealItem } from './company-testkit';
import { openPreviousNoticeSeed } from './custody';
import {
    AREA,
    GROUP,
    HEADS_DIGEST,
    OWNER_ROLES,
    areaKeyAt,
    custodyAt,
    kitAt,
    listDigestAt,
    person,
    rootKeyAt,
    verdictOf,
} from './group-testkit';
import {
    acceptRosters,
    firstRoster,
    nextRoster,
    type AcceptInput,
    type AcceptedRosters,
    type GroupAnchor,
    type GroupChainCache,
} from './group-trust';
import { parseRoster, rosterStatement, type SignedGroupStatement } from './groups';
import { decode, encode } from './keys';
import core from './__fixtures__/core-company.json';

/*
 * A company as the Rust core makes it (crates/hushos-core/examples/
 * company_fixtures.rs), judged and opened here: the history its builders
 * wrote, to the same verdict and the same bytes this twin's builders write;
 * the company key, kit and notice keys from the shared seeds; and its seals.
 * The other direction is crates/hushos-core/tests/web_company_fixtures.rs.
 */

type Served = {
    statement: string;
    signature: { ed25519: string; mlDsa: string };
    signerSignature: string;
    kitSignature?: string;
};

const signed = (value: Served): SignedGroupStatement => ({
    statement: decode(value.statement),
    signature: { ed25519: decode(value.signature.ed25519), mlDsa: decode(value.signature.mlDsa) },
    signerSignature: decode(value.signerSignature),
    ...(value.kitSignature ? { kitSignature: decode(value.kitSignature) } : {}),
});

const history = core.history.input;
const input: AcceptInput = {
    groupId: GROUP,
    firstKeys: history.firstKeys,
    anchor: history.anchor as GroupAnchor,
    pins: [],
    rosters: (history.rosters as Served[]).map(signed),
    successions: [],
    mlDsaKeys: history.mlDsaKeys as Record<string, string>,
    me: history.me as AcceptInput['me'],
    cache: null,
};

async function chainAt(through: number): Promise<AcceptedRosters> {
    const chain = await acceptRosters({ ...input, rosters: input.rosters.slice(0, through) });
    if (chain.status !== 'accepted') throw new Error('not accepted');
    return chain;
}

describe('a company made by the Rust core', () => {
    test('its history is accepted here to the verdict the core gave, its recovery and company record included', async () => {
        const verdict = await verdictOf(input);
        expect(verdict).toEqual(core.history.expected);
        expect(verdict.recoveries).toEqual([
            { rosterVersion: 4, signerUserId: (await person(5)).userId },
        ]);
        // Without the kit's signature the core's recovery roster is no roster here either.
        const { kitSignature: _, ...bare } = input.rosters[3]!;
        await expect(
            acceptRosters({ ...input, rosters: [...input.rosters.slice(0, 3), bare] }),
        ).rejects.toThrow('not signed with the company’s recovery kit');
    });

    test('the core’s cache of that chain continues here, and one with a part edited does not', async () => {
        const cache = core.history.expected.cache as unknown as GroupChainCache;
        const from = (edited: GroupChainCache) =>
            acceptRosters({ ...input, anchor: null, rosters: [], cache: edited });
        const chain = await from(structuredClone(cache));
        expect(chain.status).toBe('accepted');
        expect((chain as AcceptedRosters).recoveries).toHaveLength(1);
        expect((chain as AcceptedRosters).cache).toEqual(cache);
        const org = cache.org!;
        for (const edited of [
            { ...cache, org: { ...org, signerKeys: {} } },
            { ...cache, org: { ...org, custodyKeys: org.custodyKeys.slice(1) } },
            { ...cache, org: { ...org, dataAdmins: {} } },
            { ...cache, cacheVersion: 2 },
        ])
            await expect(from(edited as GroupChainCache)).rejects.toThrow(
                'Invalid member list cache.',
            );
    });

    test('this twin’s builders write the core’s rosters byte for byte', async () => {
        const owner = await person(1);
        const first = await firstRoster(GROUP, owner.entry(OWNER_ROLES), {
            kind: 'org',
            areaKeys: [
                {
                    workspaceId: AREA,
                    workspaceKey: areaKeyAt(AREA, 1),
                    rootKey: rootKeyAt(AREA, 1),
                    areaKind: 'shared',
                    listDigest: listDigestAt(AREA, 1),
                },
            ],
            org: {
                custodyKey: (await custodyAt(1)).publicKey,
                kit: (await kitAt(1)).publicKeys,
                heads: unverifiedHeads(HEADS_DIGEST),
            },
        });
        expect(encode(rosterStatement(first))).toBe(encode(input.rosters[0]!.statement));
        // Roster 3 replaces the company key and changes no entry: `same`, from either twin.
        const two = await chainAt(2);
        const third = await nextRoster(two, [...two.roster.members], {
            signerUserId: owner.userId,
            org: {
                heads: unverifiedHeads(HEADS_DIGEST),
                custodyKey: (await custodyAt(2)).publicKey,
            },
        });
        expect(encode(rosterStatement(third))).toBe(encode(input.rosters[2]!.statement));
        expect(parseRoster(input.rosters[2]!.statement).membersSame).toBeDefined();
        // Roster 4, the kit holder's own promotion.
        const three = await chainAt(3);
        const keeper = await person(5);
        const fourth = await nextRoster(
            three,
            three.roster.members.map((entry) =>
                entry.userId === keeper.userId ? { ...entry, roles: [...OWNER_ROLES] } : entry,
            ),
            { signerUserId: keeper.userId, org: { heads: unverifiedHeads(HEADS_DIGEST) } },
        );
        expect(encode(rosterStatement(fourth))).toBe(encode(input.rosters[3]!.statement));
    });

    test('the company key, the kit and the notice keys derive here as in the core', async () => {
        const ours = await companyKeys();
        expect(core.keys.custody).toEqual(ours.custody);
        expect(core.keys.kits).toEqual(ours.kits);
        const { wrapped: _, ...notice } = ours.notice;
        expect(core.keys.notice).toMatchObject(notice);
        // The core's wrapped previous notice seed (its own nonce) opens here, and under nothing else.
        const theirs = core.keys.notice;
        expect(
            encode(
                await openPreviousNoticeSeed(
                    decode(theirs.wrapped),
                    decode(theirs.next),
                    theirs.ctx,
                ),
            ),
        ).toBe(theirs.seed);
        await expect(
            openPreviousNoticeSeed(decode(theirs.wrapped), decode(theirs.seed), theirs.ctx),
        ).rejects.toThrow();
    });

    test('its seals open here as the core said, and a kit seal with a byte moved no longer checks', async () => {
        const items = core.seals.items as unknown as SealItem[];
        expect(items.map((item) => item.kind)).toEqual([
            'custody-seal',
            'kit-seal',
            'key-escrow',
            'custody-key-seal',
            'recovery-request',
            'custody-previous',
            'custody-seal',
        ]);
        for (const item of items)
            expect(await sealItemVerdict(item, chainAt), item.name).toEqual(item.expected);
        // The core's kit seal checks here only because both twins make the same bytes from the
        // same coins.
        const kit = items.find((item) => item.kind === 'kit-seal')!;
        const moved = decode(kit.envelope);
        moved[200]! ^= 1;
        expect(await sealItemVerdict({ ...kit, envelope: encode(moved) }, chainAt)).toMatchObject({
            check: 'refused',
        });
    });

    test('a folder’s lists and heads the core signed read here, step by step, as the core read them', async () => {
        // A base list, two additions, a key change's base list, the heads four rosters commit
        // (each built by the core over what a device read) and a dismissal, all made with the
        // core's builders (companies-design 2.3): the same states, the same record.
        const made = core.lists as unknown as ListCase & { expected: ListStepVerdict[] };
        const served = (served: typeof made.input) => ({
            ...served,
            groupId: GROUP,
            rosters: (served.rosters as unknown as Served[]).map(signed),
            successions: [],
        });
        const verdict = await listCaseVerdict({ ...made, input: served(made.input) });
        expect(verdict).toEqual(made.expected);
        const [before, after, rotated] = verdict as ListStepVerdict[] as [
            ListStepVerdict,
            ListStepVerdict,
            ListStepVerdict,
        ];
        if ('error' in before.lists || 'error' in after.lists || 'error' in rotated.lists)
            throw new Error('refused');
        expect([before.lists.state, after.lists.state]).toEqual(['ahead', 'level']);
        expect(after.lists.people.map((person) => person.role)).toEqual([
            'manager',
            'manager',
            'viewer',
        ]);
        // The key change's base list is numbered past the head, and leaves the viewer out.
        expect([rotated.lists.state, rotated.lists.workspaceKeyVersion]).toEqual(['level', 2]);
        expect(rotated.lists.listVersion).toBe(4);
        expect(rotated.lists.people.map((person) => person.role)).toEqual(['manager', 'manager']);
        expect(rotated.dismissals).toEqual(['verified']);
        // One byte of the core's addition moved: this twin refuses it, and nothing reaches the head.
        const step = made.steps[1]!;
        const moved = decode(step.served![1]!.signature);
        moved[100]! ^= 1;
        const [tampered] = await listCaseVerdict({
            ...made,
            input: served(made.input),
            steps: [
                {
                    ...step,
                    served: [
                        step.served![0]!,
                        { ...step.served![1]!, signature: encode(moved) },
                        step.served![2]!,
                    ],
                },
            ],
        });
        if ('error' in tampered!.lists) throw new Error('refused');
        expect(tampered!.lists.state).toBe('forked');
        expect(tampered!.lists.refused.map((at) => [at.listVersion, at.reason])).toEqual([
            [2, 'This list is not signed by the member it names.'],
        ]);
    });
});
