import { afterEach, describe, expect, test, vi } from 'vitest';
import { totpCode, totpStep } from '@hushos/crypto/two-step/server';

/*
 * Where the two-step key comes from (docs/two-step-design.md 8, owner decision
 * 7), and what a change of key leaves working. The key seals every
 * authenticator secret and keys every backup code, so a key that differed
 * between two processes, or after the OPAQUE setup moved from the database to
 * the environment as the self-hosting guide advises, would lock out everyone
 * with a second step at once.
 */

const SETUP = Buffer.alloc(96, 5).toString('base64url');
const KEY_A = Buffer.alloc(32, 0xa1).toString('base64url');
const KEY_B = Buffer.alloc(32, 0xb2).toString('base64url');
const USER = { id: '1c8f2d3e-4e5b-4c6d-9e7f-8091a2b3c4d5', email: 'owner@hush.example' };
const SALT = Buffer.alloc(16, 9);

afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
});

/* The two-step module as a server started with this environment loads it. */
async function startWith(env: {
    setup: 'environment' | 'database';
    key?: string;
    previous?: string;
    origin?: string;
}) {
    vi.resetModules();
    vi.stubEnv('APP_ORIGIN', env.origin ?? 'https://hush.example');
    vi.stubEnv('EMAIL_ADAPTER', 'log');
    vi.stubEnv('EMAIL_FROM', 'HushOS <hushos@hushos.test>');
    vi.stubEnv('OPAQUE_SERVER_SETUP', env.setup === 'environment' ? SETUP : '');
    vi.stubEnv('TWO_STEP_KEY', env.key ?? '');
    vi.stubEnv('TWO_STEP_PREVIOUS_KEY', env.previous ?? '');
    const asked: string[] = [];
    vi.doMock('@hushos/db', () => ({
        authRepository: {
            // The row a server without OPAQUE_SERVER_SETUP keeps its setup in.
            ensureServerSecret: async (name: string) => {
                asked.push(name);
                return SETUP;
            },
        },
        twoStepRepository: {
            BACKUP_CODE_COUNT: 10,
            ensureState: async () => ({ backupCodeSalt: SALT }),
        },
    }));
    const twoStep = await import('./two-step');
    return { twoStep, asked };
}

function base32Decode(text: string) {
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
    const out: number[] = [];
    let buffer = 0;
    let bits = 0;
    for (const char of text) {
        buffer = (buffer << 5) | alphabet.indexOf(char);
        bits += 5;
        if (bits >= 8) {
            out.push((buffer >>> (bits - 8)) & 0xff);
            bits -= 8;
        }
    }
    return Uint8Array.from(out);
}

/* An authenticator app made by one server, as its row is stored, with a code for it now. */
async function appMadeBy(server: Awaited<ReturnType<typeof startWith>>) {
    const app = await server.twoStep.newTotp(USER);
    const row = {
        id: app.row.id,
        userId: app.row.userId,
        totpKeyId: app.row.keyId,
        totpNonce: app.row.nonce,
        totpSecret: app.row.secret,
    };
    return { row, code: await totpCode(base32Decode(app.shown.secret), totpStep()) };
}

describe('the two-step key', () => {
    test('is the same whether the OPAQUE setup is in the environment or in the database', async () => {
        const fromDatabase = await startWith({ setup: 'database' });
        const app = await appMadeBy(fromDatabase);
        const before = (await fromDatabase.twoStep.twoStepKeys()).current;
        expect(fromDatabase.asked).toEqual(['opaque-setup:primary']);

        // The operator moves the setup into the environment: the database is not asked.
        const fromEnvironment = await startWith({ setup: 'environment' });
        const after = (await fromEnvironment.twoStep.twoStepKeys()).current;
        expect(fromEnvironment.asked).toEqual([]);
        expect(after.id).toEqual(before.id);
        expect(Buffer.from(after.key)).toEqual(Buffer.from(before.key));
        // A secret sealed before the move still checks a code after it.
        expect(await fromEnvironment.twoStep.appSteps(app.row, app.code)).toEqual([totpStep()]);
    });

    test('set for the first time takes over new secrets, and strands none sealed under the derived key', async () => {
        const derived = await startWith({ setup: 'environment' });
        const old = await appMadeBy(derived);

        const explicit = await startWith({ setup: 'environment', key: KEY_A });
        const keys = await explicit.twoStep.twoStepKeys();
        expect(Buffer.from(keys.current.key).toString('base64url')).toBe(KEY_A);
        expect(await explicit.twoStep.appSteps(old.row, old.code)).toEqual([totpStep()]);
        const fresh = await appMadeBy(explicit);
        expect(fresh.row.totpKeyId).toEqual(keys.current.id);
        expect(fresh.row.totpKeyId).not.toEqual(old.row.totpKeyId);
        // A server that does not have the new key cannot open what it sealed.
        await expect(derived.twoStep.appSteps(fresh.row, fresh.code)).rejects.toMatchObject({
            status: 503,
        });
    });

    test('replaced by another keeps the old one’s secrets only while TWO_STEP_PREVIOUS_KEY names it', async () => {
        const first = await startWith({ setup: 'environment', key: KEY_A });
        const app = await appMadeBy(first);

        const rotated = await startWith({ setup: 'environment', key: KEY_B, previous: KEY_A });
        expect(await rotated.twoStep.appSteps(app.row, app.code)).toEqual([totpStep()]);
        expect((await appMadeBy(rotated)).row.totpKeyId).not.toEqual(app.row.totpKeyId);

        // Without it the row names a key nobody has: an outage to fix, never a wrong code.
        const forgotten = await startWith({ setup: 'environment', key: KEY_B });
        await expect(forgotten.twoStep.appSteps(app.row, app.code)).rejects.toMatchObject({
            name: 'AuthError',
            status: 503,
        });
    });

    test('names each backup code it hashed, so a set made under one key says which', async () => {
        const derived = await startWith({ setup: 'environment' });
        const explicit = await startWith({ setup: 'environment', key: KEY_A });
        const [under, over] = [
            await derived.twoStep.newBackupCodes(USER.id),
            await explicit.twoStep.newBackupCodes(USER.id),
        ];
        expect(under!.shown).toHaveLength(10);
        expect(new Set(under!.shown).size).toBe(10);
        const ids = (set: typeof under) =>
            new Set(set!.stored.map((code) => code.keyId.toString('hex')));
        expect(ids(under).size).toBe(1);
        expect(ids(over).size).toBe(1);
        expect([...ids(under)]).not.toEqual([...ids(over)]);
        // Stored as 32-byte hashes, none of them a code as it was shown.
        for (const stored of under!.stored) {
            expect(stored.codeHash).toHaveLength(32);
            for (const shown of under!.shown)
                expect(stored.codeHash.includes(Buffer.from(shown.replace('-', '')))).toBe(false);
        }
    });

    test('labels the authenticator entry HushOS on hushos.com, and with the host on any other server', async () => {
        const issuerOf = async (origin: string) => {
            const { twoStep } = await startWith({ setup: 'environment', origin });
            const uri = new URL((await twoStep.newTotp(USER)).shown.uri);
            return [uri.searchParams.get('issuer'), decodeURIComponent(uri.pathname)];
        };
        expect(await issuerOf('https://hushos.com')).toEqual([
            'HushOS',
            '/HushOS:owner@hush.example',
        ]);
        expect(await issuerOf('https://files.example.org:8443')).toEqual([
            'HushOS (files.example.org:8443)',
            '/HushOS (files.example.org:8443):owner@hush.example',
        ]);
    });
});
