import { describe, expect, test } from 'vitest';
import { createBrowserCryptoTransport } from './crypto-transport';

/*
 * The worker's `invalid` (a saved unlock that does not open) reaches the caller, which erases
 * the saved unlock for it and only for it; a lock's rejection never carries it.
 */
describe('the browser transport', () => {
    function transport() {
        const worker = {
            onmessage: null as ((event: { data: unknown }) => void) | null,
            onerror: null as unknown,
            postMessage() {},
            terminate() {},
        };
        const crypto = createBrowserCryptoTransport(() => worker as unknown as Worker);
        return { crypto, reply: (data: unknown) => worker.onmessage!({ data }) };
    }

    test('passes on a refusal marked invalid', async () => {
        const { crypto, reply } = transport();
        const opening = crypto.request('restore', {} as never);
        reply({ id: 1, error: 'does not open', invalid: true });
        await expect(opening).rejects.toMatchObject({ invalid: true });
    });

    test('marks neither an unmarked refusal nor a lock invalid', async () => {
        const { crypto, reply } = transport();
        const refused = crypto.request('restore', {} as never).catch((error: unknown) => error);
        reply({ id: 1, error: 'Something went wrong on this device.' });
        expect(await refused).not.toHaveProperty('invalid');
        const cut = crypto.request('restore', {} as never).catch((error: unknown) => error);
        crypto.lock();
        expect(await cut).not.toHaveProperty('invalid');
    });
});
