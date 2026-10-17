import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { parseStatement } from './canonical';
import { CryptoError } from './errors';
import {
    areaGrantStatement,
    groupKeySealStatement,
    groupSuccessionStatement,
    parseGroupSuccession,
    parseRoster,
    rosterStatement,
    type AreaGrantContext,
    type GroupKeySealContext,
    type Roster,
} from './groups';
import { decode } from './keys';
import { digest } from './signatures';
import core from './__fixtures__/core-groups.json';

/*
 * Rosters, group key successions and the two seals' statements, over
 * generated input: refused with a CryptoError and nothing else, a parsed
 * statement re-encodes to its own bytes, and a built one parses back to what
 * was built. Starting from the fixture history's own statements and editing
 * them reaches the checks past the grammar (order, roles per kind, versions,
 * digests), which arbitrary bytes rarely do.
 */

async function refusedOrValue<T>(run: () => T | Promise<T>): Promise<T | null> {
    try {
        return await run();
    } catch (error) {
        if (error instanceof CryptoError) return null;
        throw error;
    }
}

const utf8 = (text: string) => new TextEncoder().encode(text);
const rosters = core.rosters.map((served) => decode(served.statement));
const successions = core.successions.map((served) => decode(served.statement));

/* Values an edit puts in a statement's field: the protocol's shapes, their edges, and noise. */
const field = fc.oneof(
    fc.constantFrom(
        '',
        'family',
        'org',
        'members',
        'data_admin',
        'left',
        '0a0a0a0a-0a0a-4a0a-8a0a-0a0a0a0a0a0a',
        '0A0A0A0A-0A0A-4A0A-8A0A-0A0A0A0A0A0A',
        'Il2SxfIo1S4PS06zLGBCauJ8YSWSafkxQzIRzFlKTK8',
        'Il2SxfIo1S4PS06zLGBCauJ8YSWSafkxQzIRzFlKTK9',
    ),
    fc.constantFrom(0, 1, 2, 4, 2 ** 53 - 1, 2 ** 53),
    fc.string({ maxLength: 6 }),
    fc.constant([]),
);

/* A statement with one value somewhere inside it replaced, or one list item dropped or repeated. */
function edited(statements: Uint8Array[]) {
    return fc
        .tuple(fc.nat(statements.length - 1), fc.nat(), fc.nat(3), field)
        .map(([which, at, how, value]) => {
            const parts = JSON.parse(new TextDecoder().decode(statements[which])) as unknown[];
            const slots: [unknown[], number][] = [];
            const walk = (list: unknown[]) =>
                list.forEach((item, i) => {
                    slots.push([list, i]);
                    if (Array.isArray(item)) walk(item);
                });
            walk(parts);
            const [list, i] = slots[at % slots.length]!;
            if (how === 0) list.splice(i, 1);
            else if (how === 1) list.splice(i, 0, list[i]);
            else list[i] = value;
            return utf8(JSON.stringify(parts));
        });
}

describe('rosters and successions, over generated input', () => {
    it('parse a roster only from its canonical bytes, and refuse everything else with a CryptoError', async () => {
        await fc.assert(
            fc.asyncProperty(
                fc.oneof(edited(rosters), fc.uint8Array({ maxLength: 48 })),
                async (bytes) => {
                    const roster = await refusedOrValue(() => parseRoster(bytes));
                    if (roster) expect(rosterStatement(roster)).toEqual(bytes);
                },
            ),
            { numRuns: 500 },
        );
    });

    it('parse a succession only from its canonical bytes, one key version apart', async () => {
        await fc.assert(
            fc.asyncProperty(
                fc.oneof(edited(successions), fc.uint8Array({ maxLength: 48 })),
                async (bytes) => {
                    const succession = await refusedOrValue(() => parseGroupSuccession(bytes));
                    if (succession) {
                        expect(groupSuccessionStatement(succession)).toEqual(bytes);
                        expect(succession.newVersion).toBe(succession.oldVersion + 1);
                    }
                },
            ),
            { numRuns: 500 },
        );
    });

    it('encode a roster object only when it is canonical, and parse it back to the same roster', async () => {
        const base = core.rosters.map((served) => served.roster as Roster);
        const changed = fc
            .tuple(fc.nat(base.length - 1), fc.nat(), fc.nat(), field)
            .map(([which, member, key, value]) => {
                const roster = structuredClone(base[which]!) as unknown as Record<string, unknown>;
                const members = roster.members as Record<string, unknown>[];
                const target = key % 2 === 0 ? roster : members[member % members.length]!;
                const keys = Object.keys(target);
                target[keys[key % keys.length]!] = value;
                return roster as unknown as Roster;
            });
        await fc.assert(
            fc.asyncProperty(changed, async (roster) => {
                const statement = await refusedOrValue(() => rosterStatement(roster));
                if (statement)
                    expect(parseRoster(statement)).toEqual({
                        ...roster,
                        areas: roster.areas ?? [],
                    });
            }),
            { numRuns: 500 },
        );
    });
});

describe('seal statements, over generated contexts', () => {
    const id = fc.oneof(
        fc.constantFrom(
            '0a0a0a0a-0a0a-4a0a-8a0a-0a0a0a0a0a0a',
            'A0A0A0A0-0A0A-4A0A-8A0A-0A0A0A0A0A0A',
        ),
        fc.string({ maxLength: 4 }),
    );
    const count = fc.oneof(fc.constantFrom(0, 1, 2 ** 53 - 1, 2 ** 53, 1.5, -1), fc.nat(9));
    const digested = fc.oneof(
        fc.constantFrom('', 'Il2SxfIo1S4PS06zLGBCauJ8YSWSafkxQzIRzFlKTK8'),
        fc.string({ maxLength: 4 }),
    );

    it('build a key seal or grant statement only from a valid context, ending in the digest of what was sealed', async () => {
        const keySeal = fc.record({
            groupId: id,
            groupKeyVersion: count,
            holderUserId: id,
            holderKeyVersion: count,
            sealerUserId: id,
            rosterVersion: count,
            rosterDigest: digested,
        });
        const grant = fc.record({
            groupId: id,
            workspaceId: id,
            workspaceKeyVersion: count,
            granteeUserId: id,
            granteeKeyVersion: count,
            granterUserId: id,
            rosterVersion: count,
            rosterDigest: digested,
        });
        await fc.assert(
            fc.asyncProperty(
                fc.oneof(
                    keySeal.map(
                        (ctx) => (sealed: Uint8Array) =>
                            groupKeySealStatement(ctx as GroupKeySealContext, sealed),
                    ),
                    grant.map(
                        (ctx) => (sealed: Uint8Array) =>
                            areaGrantStatement(ctx as AreaGrantContext, sealed),
                    ),
                ),
                fc.uint8Array({ maxLength: 16 }),
                async (statement, sealed) => {
                    const bytes = await refusedOrValue(() => statement(sealed));
                    if (bytes)
                        expect(parseStatement(bytes, 'statement').at(-1)).toBe(
                            await digest(sealed),
                        );
                },
            ),
            { numRuns: 500 },
        );
    });
});
