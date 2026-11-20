import { writeFile } from 'node:fs/promises';
import {
    type Draft,
    draftContext,
    draftKey,
    draftKeyInfo,
    draftSlot,
    draftWorkspaceTag,
    sealDraft,
} from '../src/account/drafts';
import { encode } from '../src/primitives/keys';

/*
 * Writes crates/hushos-core/fixtures/drafts.json: one draft sealed by the web twin with a fixed
 * account key and nonce (its key, slot, associated data and record), the records and inputs
 * that must not open, and the restore decision's cases. Read by the core's drafts.rs tests and
 * packages/crypto/src/account/drafts.test.ts. Every refusal and every offer is stated by hand; only the
 * key, the slot and the record are computed. Run with `bun packages/crypto/scripts/draft-fixtures.ts`.
 */

const fixture = new URL('../../../crates/hushos-core/fixtures/drafts.json', import.meta.url);

const accountKey = Uint8Array.from({ length: 32 }, (_, index) => index + 1);
const nonce = Uint8Array.from({ length: 24 }, (_, index) => 0xa0 + index);
const place = {
    userId: '6b1a3f0e-2c4d-4e5f-8a9b-0c1d2e3f4a5b',
    workspaceId: '0d4f2a1b-9c8e-4f7a-b6d5-e4c3b2a1f0e9',
    nodeId: '5f0c1d2e-3a4b-4c5d-9e6f-7a8b9c0d1e2f',
};
const draft: Draft = {
    frame: {
        baseVersionId: '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d',
        encoding: 'utf-16le',
        lineEnding: 'crlf',
        mixed: true,
        savedAt: 1_763_650_440_000,
    },
    text: 'Draft canary 🦀 über\nsecond line\n',
    selection: { from: 14, to: 20 },
    sourceVersionId: '4e3d2c1b-0a9f-4e8d-9c7b-6a5f4e3d2c1b',
};

const key = await draftKey(accountKey, place);
const record = await sealDraft(accountKey, place, draft, nonce);
const parsed = JSON.parse(record) as Record<string, unknown>;
const withField = (name: string, value: unknown) => JSON.stringify({ ...parsed, [name]: value });
const sealed = Buffer.from(parsed.sealed as string, 'base64url');
const flipped = Uint8Array.from(sealed);
flipped[1 + 24 + 3]! ^= 0x01;

const OTHER = '1c2d3e4f-5a6b-4c7d-8e9f-a0b1c2d3e4f5';

await writeFile(
    fixture,
    `${JSON.stringify(
        {
            accountKey: encode(accountKey),
            ...place,
            keyInfo: draftKeyInfo(place),
            key: encode(key),
            slot: await draftSlot(accountKey, place),
            workspaceTag: await draftWorkspaceTag(accountKey, place.userId, place.workspaceId),
            draft,
            associatedData: new TextDecoder().decode(draftContext(place, draft.frame.savedAt)),
            nonce: encode(nonce),
            record,
            refusals: [
                { name: 'another user', userId: OTHER },
                { name: 'another workspace', workspaceId: OTHER },
                { name: 'another node', nodeId: OTHER },
                { name: 'another account key', accountKey: encode(new Uint8Array(32).fill(9)) },
                { name: 'another time', record: withField('savedAt', draft.frame.savedAt + 1) },
                { name: 'no time', record: withField('savedAt', null) },
                {
                    name: 'a changed ciphertext byte',
                    record: withField('sealed', Buffer.from(flipped).toString('base64url')),
                },
                {
                    name: 'cut short',
                    record: withField('sealed', sealed.subarray(0, -1).toString('base64url')),
                },
                { name: 'another record version', record: withField('v', 2) },
                { name: 'not a record', record: 'draft' },
            ],
            offers: [
                {
                    name: 'nothing changed since: restored as an edit',
                    draftBase: draft.frame.baseVersionId,
                    draftText: 'mine',
                    openedVersion: draft.frame.baseVersionId,
                    openedText: 'theirs',
                    offer: 'current',
                },
                {
                    name: 'the same version in capitals is still current',
                    draftBase: draft.frame.baseVersionId,
                    draftText: 'mine',
                    openedVersion: draft.frame.baseVersionId.toUpperCase(),
                    openedText: 'theirs',
                    offer: 'current',
                },
                {
                    name: 'someone saved since: the stale choices',
                    draftBase: draft.frame.baseVersionId,
                    draftText: 'mine',
                    openedVersion: OTHER,
                    openedText: 'theirs',
                    offer: 'stale',
                },
                {
                    name: 'no version to compare: the stale choices',
                    draftBase: draft.frame.baseVersionId,
                    draftText: 'mine',
                    openedVersion: null,
                    openedText: 'theirs',
                    offer: 'stale',
                },
                {
                    name: 'the file already holds the text: dropped',
                    draftBase: draft.frame.baseVersionId,
                    draftText: 'same',
                    openedVersion: OTHER,
                    openedText: 'same',
                    offer: 'same',
                },
            ],
        },
        null,
        4,
    )}\n`,
);
key.fill(0);
