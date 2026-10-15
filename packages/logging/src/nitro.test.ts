import { describe, expect, test } from 'vitest';
import { createError } from 'evlog';
import { safeErrorHandler } from './nitro';

/*
 * An error that escapes a server route reaches the framework, which prints it
 * whole. Its message can carry what the request held, so it must never get
 * there as it was thrown: only its class and code go on the request's event.
 */
function logger() {
    const lines: unknown[] = [];
    return {
        lines,
        log: {
            set: (fields: unknown) => void lines.push(fields),
            error: (error: unknown) => void lines.push(error),
            warn: (message: unknown) => void lines.push(message),
        } as never,
    };
}
const failing = (error: unknown) => async () => {
    throw error;
};

describe('an error escaping a server route', () => {
    test('goes on with no message, and the event keeps only its class', async () => {
        const { lines, log } = logger();
        const handle = safeErrorHandler(() => log);
        const thrown = await handle(failing(new TypeError('No account for maya@example.com')))
            .then(() => null)
            .catch((error: unknown) => error);
        expect(thrown).toBeInstanceOf(Error);
        expect((thrown as Error).message).toBe('Request failed.');
        expect((thrown as { status: number }).status).toBe(500);
        expect((thrown as Error).cause).toBeUndefined();
        expect(lines).toContainEqual({ failure: { kind: 'TypeError' } });
        // Logged as an error, so the event carries the failure at error level.
        expect(
            lines.some((line) => line instanceof Error && line.message === 'Request failed.'),
        ).toBe(true);
        expect(JSON.stringify(lines)).not.toContain('maya@example.com');
    });

    test('a client error keeps its status, is a warning, and keeps nothing else', async () => {
        const { lines, log } = logger();
        const error = Object.assign(new Error('File “Tax 2025.pdf” is too large'), {
            status: 413,
        });
        const thrown = await safeErrorHandler(() => log)(failing(error)).catch((e: unknown) => e);
        expect(thrown).toMatchObject({ message: 'Request failed.', status: 413 });
        expect(lines).toContainEqual('Request refused.');
        expect(lines.some((line) => line instanceof Error)).toBe(false);
        expect(JSON.stringify(lines)).not.toContain('Tax 2025');
    });

    test('a status outside 400–599, or a thrown string, goes on as a plain 500', async () => {
        const { log } = logger();
        const handle = safeErrorHandler(() => log);
        const redirectish = Object.assign(new Error('to /secret'), { status: 302 });
        await expect(handle(failing(redirectish))).rejects.toMatchObject({ status: 500 });
        const polar = Object.assign(new Error('card 4242'), { statusCode: 422 });
        await expect(handle(failing(polar))).rejects.toMatchObject({ status: 422 });
        await expect(handle(failing('token=abc123'))).rejects.toMatchObject({
            message: 'Request failed.',
            status: 500,
        });
    });

    test('an HTTPError thrown on purpose, and a client that went away, pass as they are', async () => {
        const { lines, log } = logger();
        const handle = safeErrorHandler(() => log);
        const deliberate = Object.assign(new Error('Try again in a minute.'), {
            name: 'HTTPError',
            status: 429,
        });
        await expect(handle(failing(deliberate))).rejects.toBe(deliberate);
        const aborted = new DOMException('The client went away', 'AbortError');
        await expect(handle(failing(aborted))).rejects.toBe(aborted);
        expect(lines).toEqual([]);
    });

    test('an Error that merely carries isNotFound is not taken for the router’s', async () => {
        const { log } = logger();
        const fake = Object.assign(new Error('maya@example.com'), { isNotFound: true });
        await expect(safeErrorHandler(() => log)(failing(fake))).rejects.toMatchObject({
            message: 'Request failed.',
        });
    });

    test('lets the router’s redirects and not-found pass untouched', async () => {
        const { lines, log } = logger();
        const handle = safeErrorHandler(() => log);
        const redirect = new Response(null, { status: 307, headers: { location: '/login' } });
        await expect(handle(failing(redirect))).rejects.toBe(redirect);
        const notFound = { isNotFound: true };
        await expect(handle(failing(notFound))).rejects.toBe(notFound);
        expect(lines).toEqual([]);
    });

    test('still answers evlog’s own errors as their JSON', async () => {
        const { log } = logger();
        const thrown = await safeErrorHandler(() => log)(
            failing(createError({ message: 'Plan limit reached', status: 402 })),
        ).catch((e: unknown) => e);
        expect(thrown).toBeInstanceOf(Response);
        expect((thrown as Response).status).toBe(402);
    });

    test('without a request logger, still never passes the message on', async () => {
        const thrown = await safeErrorHandler(() => {
            throw new Error('outside a request');
        })(failing(new Error('token=abc123'))).catch((e: unknown) => e);
        expect((thrown as Error).message).toBe('Request failed.');
    });
});
