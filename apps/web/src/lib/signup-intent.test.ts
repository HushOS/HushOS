import { Elysia, t } from 'elysia';
import { describe, expect, test } from 'vitest';
// The source, not the module: importing the handlers needs a whole server environment.
import source from './api.server.ts?raw';
import { intentSchema } from './signup-intent';

/*
 * The intent sign-up sends with its email (`/auth/register/email`), through Elysia as the server
 * mounts it: a field the schema doesn't name is dropped before the handler sees it, so the
 * currency a family tier was shown in has to be named, or its checkout falls back to the
 * visitor's locale. The server's route is held to this schema by its source.
 */
function registerEmail() {
    const seen: unknown[] = [];
    const app = new Elysia().post(
        '/auth/register/email',
        { body: t.Object({ email: t.String(), intent: t.Optional(intentSchema) }) },
        ({ body }) => {
            seen.push(body.intent);
            return { ok: true };
        },
    );
    const post = (intent: unknown) =>
        app.handle(
            new Request('http://localhost/auth/register/email', {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ email: 'rosa@example.com', intent }),
            }),
        );
    return { seen, post };
}

describe('the sign-up intent at the HTTP boundary', () => {
    test('keeps the currency a family tier was shown in', async () => {
        const { seen, post } = registerEmail();
        const response = await post({
            plan: 'prod_family_pro',
            referral: 'ROSA10',
            currency: 'gbp',
        });
        expect(response.status).toBe(200);
        expect(seen).toEqual([{ plan: 'prod_family_pro', referral: 'ROSA10', currency: 'gbp' }]);
    });

    test('refuses a currency that isn’t a lowercase three-letter code', async () => {
        for (const currency of ['GBP', 'pounds', 'gb', 'g1p']) {
            const { seen, post } = registerEmail();
            expect((await post({ plan: 'prod_family_pro', currency })).status).toBe(422);
            expect(seen).toEqual([]);
        }
    });

    test('is the schema the server’s register route takes', () => {
        expect(source).toMatch(/import \{ intentSchema \} from '@\/lib\/signup-intent';/);
        expect(source).toMatch(
            /'\/auth\/register\/email',\s*\{ body: t\.Object\(\{ email: emailSchema, intent: t\.Optional\(intentSchema\) \}\) \}/,
        );
        expect(source).not.toMatch(/const intentSchema =/);
    });
});
