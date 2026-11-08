import { MAX_TRASH_BATCH } from '@hushos/drive/protocol';
import { describe, expect, test } from 'vitest';
import {
    boundBody,
    DEFAULT_BODY_BYTES,
    ROTATION_BODY_BYTES,
    TRASH_BATCH_BODY_BYTES,
} from '@/lib/body-caps';

/*
 * The API's edge for writes: a body past its route's cap is refused before anything parses it,
 * and the largest body a client sends still reaches the route as it was sent.
 */

const ORIGIN = 'http://localhost';
const ID = '0b6d4a3e-2c1f-4d5e-8a9b-1c2d3e4f5a6b';
const id = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
const send = (method: string, path: string, body?: string, headers: Record<string, string> = {}) =>
    new Request(`${ORIGIN}${path}`, {
        method,
        headers: { 'content-type': 'application/json', ...headers },
        body,
    });
const signedIn = async () => null;
const signedOut = async () =>
    Response.json({ message: 'Sign in to continue.', code: 'forbidden' }, { status: 401 });

async function refused(answer: Request | Response, status: number) {
    expect(answer).toBeInstanceOf(Response);
    expect((answer as Response).status).toBe(status);
}

describe('a batch trash, restore or purge body', () => {
    test('past its cap is a 413', async () => {
        const huge = JSON.stringify({ nodeIds: Array.from({ length: 400 }, (_, n) => id(n)) });
        expect(huge.length).toBeGreaterThan(TRASH_BATCH_BODY_BYTES);
        expect(huge.length).toBeLessThan(DEFAULT_BODY_BYTES);
        for (const route of ['trash-batch', 'restore-batch', 'purge-batch']) {
            const answer = await boundBody(
                send('POST', `/api/drive/workspaces/${ID}/${route}`, huge),
                signedIn,
            );
            await refused(answer, 413);
            expect(await (answer as Response).json()).toMatchObject({ code: 'too-large' });
        }
    });

    test('the largest batch a client may send fits, and reaches the route as it was sent', async () => {
        const body = JSON.stringify({
            nodeIds: Array.from({ length: MAX_TRASH_BATCH }, (_, n) => id(n)),
        });
        const answer = await boundBody(
            send('POST', `/api/drive/workspaces/${ID}/trash-batch/`, body),
            signedIn,
        );
        expect(answer).toBeInstanceOf(Request);
        expect(await (answer as Request).text()).toBe(body);
    });
});

describe('every other write', () => {
    test('is held to the default cap, whatever its route, signed in or not', async () => {
        const huge = 'x'.repeat(DEFAULT_BODY_BYTES + 1);
        for (const [method, path] of [
            ['POST', `/api/drive/nodes/${ID}/trash`],
            ['POST', '/api/billing/checkout'],
            ['POST', `/api/admin/reports/${ID}/notes`],
            ['DELETE', `/api/drive/links/${ID}`],
            ['POST', '/api/drive/links/versions/urls'],
        ])
            await refused(await boundBody(send(method!, path!, huge), signedIn), 413);
    });

    test('a declared Content-Length past the cap is refused before the body is read', async () => {
        let pulled = 0;
        const body = new ReadableStream<Uint8Array>({
            pull(controller) {
                pulled += 1;
                controller.enqueue(new Uint8Array(1024));
            },
        });
        const request = new Request(`${ORIGIN}/api/billing/checkout`, {
            method: 'POST',
            headers: { 'content-length': String(DEFAULT_BODY_BYTES + 1) },
            body,
            // @ts-expect-error Node and Bun need this for a streamed request body.
            duplex: 'half',
        });
        await refused(await boundBody(request, signedIn), 413);
        // At most what the stream queued before it was cancelled, never the body it claimed.
        expect(pulled).toBeLessThan(4);
    });

    test('a larger route still takes its largest real body', async () => {
        const parts = Array.from({ length: 10_000 }, (_, n) => ({
            partNumber: n + 1,
            etag: `"${n.toString(16).padStart(32, '0')}"`,
        }));
        const body = JSON.stringify({ parts });
        expect(body.length).toBeGreaterThan(DEFAULT_BODY_BYTES);
        const answer = await boundBody(
            send('POST', `/api/drive/uploads/${ID}/complete`, body),
            signedIn,
        );
        expect(answer).toBeInstanceOf(Request);
        expect(await (answer as Request).text()).toBe(body);
    });

    test('a read goes on untouched', async () => {
        const request = new Request(`${ORIGIN}/api/drive/workspace`);
        expect(await boundBody(request, signedOut)).toBe(request);
    });
});

describe('a cap past the default', () => {
    const path = `/api/drive/nodes/${ID}/rotation/nodes`;

    test('is read only once signed in: the body is never read for a stranger', async () => {
        let pulled = 0;
        const body = new ReadableStream<Uint8Array>({
            pull(controller) {
                pulled += 1;
                controller.enqueue(new Uint8Array(1024));
            },
        });
        const request = new Request(`${ORIGIN}${path}`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body,
            // @ts-expect-error Node and Bun need this for a streamed request body.
            duplex: 'half',
        });
        await refused(await boundBody(request, signedOut), 401);
        expect(pulled).toBeLessThan(4);
        // The same for every larger cap but a report's, which a link holder files with no session.
        for (const [method, route] of [
            ['POST', '/api/drive/folders'],
            ['POST', `/api/drive/uploads/${ID}/complete`],
            ['PUT', `/api/drive/workspaces/${ID}/documents/tags`],
            ['POST', `/api/admin/reports/${ID}/keys`],
        ])
            await refused(await boundBody(send(method!, route!, '{}'), signedOut), 401);
        expect(await boundBody(send('POST', '/api/drive/reports', '{}'), signedOut)).toBeInstanceOf(
            Request,
        );
    });

    test('a rotation takes megabytes when signed in, and a declared body past its cap is refused', async () => {
        const big = 'x'.repeat(8 * 1024 * 1024);
        expect(await boundBody(send('POST', path, big), signedIn)).toBeInstanceOf(Request);
        const declared = new Request(`${ORIGIN}${path}`, {
            method: 'POST',
            headers: { 'content-length': String(ROTATION_BODY_BYTES + 1) },
            body: '{}',
        });
        await refused(await boundBody(declared, signedIn), 413);
    });
});
