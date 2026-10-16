import { describe, expect, test, vi } from 'vitest';

/*
 * The consent backfill (docs/groups-server.md 5) as the domain answers it.
 * Each upload costs the server two hybrid verifications, so an account's
 * uploads are bounded before the repository (which does that work) is
 * reached; and every repository answer becomes the status a client acts on.
 * The rate limiter here counts, so the bound is exercised, not stubbed.
 */
process.env.APP_ORIGIN = 'https://hush.example';
process.env.OPAQUE_SERVER_SETUP = 'A'.repeat(120);
process.env.TRUSTED_PROXY_HEADER = 'x-forwarded-for';
process.env.EMAIL_ADAPTER = 'log';
process.env.EMAIL_FROM = 'HushOS <hushos@hushos.test>';

const USER = { id: '1c8f2d3e-4e5b-4c6d-9e7f-8091a2b3c4d5', credentialVersion: 1 };
const TOKEN = 'k'.repeat(43);
const counts = new Map<string, number>();
const backfilled: unknown[] = [];
let answer: { status: string; stored?: boolean } = { status: 'ok', stored: true };

vi.mock('@hushos/db', () => ({
    adminRepository: {},
    groupsRepository: {},
    authRepository: {
        getSession: async () => ({ user: USER }),
        consumeRateLimit: async (bucket: Buffer, count: number) => {
            const key = bucket.toString('hex');
            const used = (counts.get(key) ?? 0) + 1;
            counts.set(key, used);
            return used <= count;
        },
        backfillSuccessionConsent: async (input: unknown) => {
            backfilled.push(input);
            return answer;
        },
    },
}));

const auth = await import('./server');
const consent = Buffer.alloc(6746, 7).toString('base64url');

async function status(promise: Promise<unknown>) {
    try {
        await promise;
        return 200;
    } catch (error) {
        if (error instanceof auth.AuthError) return error.status;
        throw error;
    }
}

describe('the consent backfill', () => {
    test('maps each answer: stored, already stored, no link, a version 1 link, forged, signed out', async () => {
        const cases: [typeof answer, number | { stored: boolean }][] = [
            [{ status: 'ok', stored: true }, { stored: true }],
            [{ status: 'ok', stored: false }, { stored: false }],
            [{ status: 'no-link' }, 404],
            [{ status: 'not-upgraded' }, 409],
            [{ status: 'bad-signature' }, 400],
            [{ status: 'session' }, 401],
        ];
        for (const [repository, expected] of cases) {
            answer = repository;
            const call = auth.backfillSuccessionConsent(TOKEN, { oldKeyVersion: 1, consent });
            if (typeof expected === 'number') expect(await status(call)).toBe(expected);
            else expect(await call).toEqual(expected);
        }
        // Not 6746 bytes: refused before the repository.
        const before = backfilled.length;
        expect(
            await status(
                auth.backfillSuccessionConsent(TOKEN, {
                    oldKeyVersion: 1,
                    consent: consent.slice(0, -4),
                }),
            ),
        ).toBe(400);
        expect(backfilled).toHaveLength(before);
    });

    test('the 61st upload in an hour is 429, and the repository never sees it', async () => {
        counts.clear();
        answer = { status: 'ok', stored: false };
        for (let i = 0; i < 60; i += 1)
            expect(
                await auth.backfillSuccessionConsent(TOKEN, { oldKeyVersion: 1, consent }),
            ).toEqual({ stored: false });
        const before = backfilled.length;
        expect(
            await status(auth.backfillSuccessionConsent(TOKEN, { oldKeyVersion: 1, consent })),
        ).toBe(429);
        expect(backfilled).toHaveLength(before);
    });
});
