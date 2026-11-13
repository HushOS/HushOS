// @vitest-environment node
import { readFileSync } from 'node:fs';
import { Elysia, t, type AnySchema } from 'elysia';
import { beforeAll, describe, expect, test } from 'vitest';
import { readKeyOptions, readLoginReply } from '../../../../../packages/auth/src/login-reply';
import { keyOptionsResponse, loginFinishResponse } from '@/lib/api/auth-responses.server';
import type * as Shared from '@/lib/api/shared.server';
import { loadApi } from '@/test/api-app';

/*
 * A passkey or security key as the second step, held to the fixture the phones' core is held to
 * (crates/hushos-core/fixtures/two-step-keys.json, read too by tests/two_step_keys.rs). The
 * core proves a phone asks a key, and answers the server, exactly as the fixture states. This
 * proves the other half: the fixture's server replies are ones this server's schemas emit, the
 * web reads them the same way, and the fixture's requests are ones this server's routes take
 * whole. Together: a phone and a browser ask a key the same thing and send the same answer.
 */

const fixture = JSON.parse(
    readFileSync(
        new URL('../../../../../crates/hushos-core/fixtures/two-step-keys.json', import.meta.url),
        'utf8',
    ),
);

/* The request schemas sit beside the API's shared context, which reads the server's settings. */
let schemas: typeof Shared;
beforeAll(async () => {
    await loadApi();
    schemas = await import('@/lib/api/shared.server');
});

/* What a route with `schema` hands on: its reply (or its body) after Elysia's own checks. */
async function through(kind: 'reply' | 'body', schema: AnySchema, value: unknown) {
    const app =
        kind === 'reply'
            ? new Elysia().get('/', { response: { 200: schema } }, () => value as never)
            : new Elysia().post('/', { body: schema }, ({ body }) => body as never);
    const response = await app.handle(
        kind === 'reply'
            ? new Request('http://localhost/')
            : new Request('http://localhost/', {
                  method: 'POST',
                  headers: { 'content-type': 'application/json' },
                  body: JSON.stringify(value),
              }),
    );
    return { status: response.status, body: await response.json().catch(() => null) };
}

describe('the key fixture the phones are held to', () => {
    test('its step is a reply this server sends, and the web reads it as the core does', async () => {
        const sent = await through('reply', loginFinishResponse, { twoStep: fixture.step });
        expect(sent).toEqual({ status: 200, body: { twoStep: fixture.step } });
        const read = readLoginReply(sent.body);
        if (read.kind !== 'step') throw new Error('Not a step.');
        expect(read.challenge.methods).toEqual(fixture.methods);
        // What the web hands the browser is what the core hands the phone's sheet.
        expect(read.challenge.webauthn).toEqual(fixture.request);
        expect(read.challenge.defaultUnavailable).toBeUndefined();
    });

    test('the answer a phone sends is one the step routes take whole', async () => {
        const taken = await through('body', schemas.stepAnswerSchema, fixture.answer);
        expect(taken).toEqual({ status: 200, body: fixture.answer });
        // What a platform hands back carries more (extension results, a user handle): the
        // server would drop it, and the phones do not send it.
        const handed = await through('body', schemas.stepAnswerSchema, {
            token: fixture.token,
            proof: { kind: 'webauthn', response: fixture.handedAssertion },
        });
        expect(handed).toEqual({ status: 200, body: fixture.answer });
    });

    test('the options are a reply this server sends, and a phone’s registration is a body its route takes whole', async () => {
        const sent = await through('reply', keyOptionsResponse, fixture.options);
        expect(sent).toEqual({ status: 200, body: fixture.options });
        expect(readKeyOptions(sent.body)).toEqual({
            registrationToken: fixture.options.registrationToken,
            options: fixture.options.options,
        });
        const body = t.Object({
            registrationToken: schemas.tokenSchema,
            name: t.Optional(t.String({ minLength: 1, maxLength: 200 })),
            response: schemas.keyRegistrationSchema,
        });
        const taken = await through('body', body, fixture.registrationBody);
        expect(taken).toEqual({ status: 200, body: fixture.registrationBody });
    });
});
