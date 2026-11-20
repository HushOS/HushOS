import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import {
    type Draft,
    DraftError,
    DRAFT_MAX_AGE_MS,
    DRAFT_TEXT_LIMIT,
    draftContext,
    draftKey,
    draftOffer,
    draftSavedAt,
    draftSlot,
    draftsToDrop,
    openDraft,
    sealDraft,
} from './drafts';
import { decode, encode } from './keys';

/*
 * The web twin held to the core by crates/hushos-core/fixtures/drafts.json: the same key, slot,
 * associated data and record bytes for a fixed key and nonce, every refusal, every offer.
 */
type Refusal = {
    name: string;
    userId?: string;
    workspaceId?: string;
    nodeId?: string;
    accountKey?: string;
    record?: string;
};
const fixture = JSON.parse(
    readFileSync(
        join(import.meta.dirname, '../../../crates/hushos-core/fixtures/drafts.json'),
        'utf8',
    ),
) as {
    accountKey: string;
    userId: string;
    workspaceId: string;
    nodeId: string;
    keyInfo: string;
    key: string;
    slot: string;
    draft: Draft;
    associatedData: string;
    nonce: string;
    record: string;
    refusals: Refusal[];
    offers: {
        name: string;
        draftBase: string;
        draftText: string;
        openedVersion: string | null;
        openedText: string;
        offer: string;
    }[];
};
const root = decode(fixture.accountKey, 32);
const place = { userId: fixture.userId, workspaceId: fixture.workspaceId, nodeId: fixture.nodeId };

describe('draft key and slot', () => {
    test('the key is HKDF of the root under exactly hushos/drafts/v1 and the file', async () => {
        // Built here from the literal label, never from the module's: a renamed label fails.
        const info = `["hushos/drafts/v1","${fixture.userId}","${fixture.workspaceId}","${fixture.nodeId}"]`;
        expect(info).toBe(fixture.keyInfo);
        const material = await crypto.subtle.importKey('raw', root.slice(), 'HKDF', false, [
            'deriveBits',
        ]);
        const expected = new Uint8Array(
            await crypto.subtle.deriveBits(
                {
                    name: 'HKDF',
                    hash: 'SHA-256',
                    salt: new Uint8Array(32),
                    info: new TextEncoder().encode(info),
                },
                material,
                256,
            ),
        );
        expect(encode(expected)).toBe(fixture.key);
        expect(encode(await draftKey(root, place))).toBe(fixture.key);
        expect(await draftSlot(root, place)).toBe(fixture.slot);
    });

    test('each file and each account has its own key and slot', async () => {
        const other = { ...place, nodeId: '1c2d3e4f-5a6b-4c7d-8e9f-a0b1c2d3e4f5' };
        expect(encode(await draftKey(root, other))).not.toBe(fixture.key);
        expect(await draftSlot(root, other)).not.toBe(fixture.slot);
        const shared = { ...place, workspaceId: '1c2d3e4f-5a6b-4c7d-8e9f-a0b1c2d3e4f5' };
        expect(await draftSlot(root, shared)).not.toBe(fixture.slot);
        expect(await draftSlot(new Uint8Array(32).fill(9), place)).not.toBe(fixture.slot);
    });
});

describe('sealing and opening', () => {
    test('the web seals the core’s record byte for byte and opens it', async () => {
        expect(new TextDecoder().decode(draftContext(place, fixture.draft.frame))).toBe(
            fixture.associatedData,
        );
        expect(await sealDraft(root, place, fixture.draft, decode(fixture.nonce, 24))).toBe(
            fixture.record,
        );
        expect(await openDraft(root, place, fixture.record)).toEqual(fixture.draft);
        expect(draftSavedAt(fixture.record)).toBe(fixture.draft.frame.savedAt);
    });

    test('a draft moved to another account, file, base, format or time, or changed, does not open', async () => {
        expect(fixture.refusals.length).toBeGreaterThanOrEqual(12);
        for (const refusal of fixture.refusals) {
            const key = refusal.accountKey ? decode(refusal.accountKey, 32) : root;
            const where = {
                userId: refusal.userId ?? place.userId,
                workspaceId: refusal.workspaceId ?? place.workspaceId,
                nodeId: refusal.nodeId ?? place.nodeId,
            };
            await expect(
                openDraft(key, where, refusal.record ?? fixture.record),
                refusal.name,
            ).rejects.toThrow(DraftError);
        }
    });

    test('a record sealed now, given another base, format or time beside it, does not open', async () => {
        const record = await sealDraft(root, place, fixture.draft);
        expect(await openDraft(root, place, record)).toEqual(fixture.draft);
        const fields = JSON.parse(record) as Record<string, unknown>;
        const swaps: [string, unknown][] = [
            ['base', '1c2d3e4f-5a6b-4c7d-8e9f-a0b1c2d3e4f5'],
            ['encoding', 'utf-8'],
            ['lineEnding', 'lf'],
            ['mixed', false],
            ['savedAt', fixture.draft.frame.savedAt - 1],
        ];
        for (const [name, value] of swaps)
            await expect(
                openDraft(root, place, JSON.stringify({ ...fields, [name]: value })),
                name,
            ).rejects.toThrow(DraftError);
    });

    test('a fresh seal never repeats a nonce, and the text is not in the record', async () => {
        const one = await sealDraft(root, place, fixture.draft);
        const two = await sealDraft(root, place, fixture.draft);
        expect(one).not.toBe(two);
        expect(one).not.toContain('canary');
        expect(await openDraft(root, place, one)).toEqual(fixture.draft);
    });

    test('text past the editor’s limit, or with half a character, is refused', async () => {
        const at = { ...fixture.draft, selection: null };
        const full = { ...at, text: 'a'.repeat(DRAFT_TEXT_LIMIT) };
        expect(
            (await openDraft(root, place, await sealDraft(root, place, full))).text,
        ).toHaveLength(DRAFT_TEXT_LIMIT);
        await expect(
            sealDraft(root, place, { ...at, text: 'a'.repeat(DRAFT_TEXT_LIMIT + 1) }),
        ).rejects.toThrow('too large');
        await expect(sealDraft(root, place, { ...at, text: 'half \ud83e' })).rejects.toThrow(
            'half of a character',
        );
    });
});

describe('restore decision', () => {
    test('matches the core’s', () => {
        for (const offer of fixture.offers)
            expect(
                draftOffer(
                    { baseVersionId: offer.draftBase, text: offer.draftText },
                    { versionId: offer.openedVersion, text: offer.openedText },
                ),
                offer.name,
            ).toBe(offer.offer);
    });
});

describe('caps', () => {
    const day = 24 * 60 * 60 * 1000;
    test('the oldest go past fifty, and the one being written is kept and counted', () => {
        const now = 40 * day;
        const entries = Array.from({ length: 55 }, (_, n) => ({
            slot: `s${String(n).padStart(2, '0')}`,
            savedAt: now - n * 1000,
        }));
        expect(draftsToDrop(entries, now)).toEqual(['s50', 's51', 's52', 's53', 's54']);
        expect(draftsToDrop(entries, now, 's54')).toEqual(['s49', 's50', 's51', 's52', 's53']);
    });

    test('thirty days old is kept, a millisecond more is dropped, unreadable goes', () => {
        const now = 100 * day;
        expect(
            draftsToDrop(
                [
                    { slot: 'edge', savedAt: now - DRAFT_MAX_AGE_MS },
                    { slot: 'past', savedAt: now - DRAFT_MAX_AGE_MS - 1 },
                    { slot: 'bad', savedAt: null },
                ],
                now,
            ),
        ).toEqual(['bad', 'past']);
    });
});
