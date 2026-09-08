import { createBrowserCryptoTransport } from '@hushos/auth/crypto-transport';
import { createBrowserDeviceKeyStore } from '@hushos/auth/device-storage';
import { createAuthClient } from '@hushos/auth/client';

export const authClient = createAuthClient(
    () =>
        createBrowserCryptoTransport(
            () => new Worker(new URL('./auth.worker.ts', import.meta.url), { type: 'module' }),
        ),
    createBrowserDeviceKeyStore(),
);
