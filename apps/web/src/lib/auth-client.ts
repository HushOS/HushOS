import { createBrowserCryptoTransport } from '@hushos/auth/crypto-transport';
import {
    createBrowserDeviceIdentityStore,
    createBrowserDeviceKeyStore,
} from '@hushos/auth/device-storage';
import { createAuthClient } from '@hushos/auth/client';
import { authApi } from '@/lib/auth-api';
import { describeBrowser } from '@/lib/device-name';

export const authClient = createAuthClient(
    () =>
        createBrowserCryptoTransport(
            () => new Worker(new URL('./auth.worker.ts', import.meta.url), { type: 'module' }),
        ),
    createBrowserDeviceKeyStore(),
    authApi,
    {
        identities: createBrowserDeviceIdentityStore(),
        describeDevice: describeBrowser,
        // Removed from the account: Drive's mirror, stashed uploads and a saved return go too,
        // and a failure is reported so the wipe is tried again. Loaded on demand; the dynamic
        // import keeps sign-out.ts out of this module.
        onRemoved: () => import('@/lib/sign-out').then(({ clearDevice }) => clearDevice()),
    },
);
