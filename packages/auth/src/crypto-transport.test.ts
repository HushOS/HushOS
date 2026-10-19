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

    test('moves the buffers it is asked to transfer, leaving them detached here', async () => {
        // A real MessageChannel stands in for the worker's port: it does what postMessage does.
        const channel = new MessageChannel();
        const worker = {
            onmessage: null as ((event: { data: unknown }) => void) | null,
            onerror: null as unknown,
            postMessage(message: unknown, transfer: Transferable[]) {
                channel.port1.postMessage(message, transfer);
            },
            terminate() {},
        };
        const crypto = createBrowserCryptoTransport(() => worker as unknown as Worker);
        const bytes = new Uint8Array(1024).fill(7);
        void crypto.request(
            'driveSourceAttach',
            { sourceId: 's', parts: [bytes] },
            { transfer: [bytes.buffer] },
        );
        expect(bytes.byteLength).toBe(0);
        const received = await new Promise<{ input: { parts: Uint8Array[] } }>((resolve) => {
            channel.port2.onmessage = (event) => resolve(event.data);
        });
        expect(received.input.parts[0]!.byteLength).toBe(1024);
        channel.port1.close();
        channel.port2.close();
    });
});
