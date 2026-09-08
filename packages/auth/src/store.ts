import { createStore } from 'zustand/vanilla';
import { createJSONStorage, persist } from 'zustand/middleware';
import type { RememberedAccount } from '@hushos/crypto';

type AuthState = {
    unlockedUserId: string | null;
    restoring: boolean;
    rememberError: string;
    device: RememberedAccount | null;
    lockRevision: number;
};
function isDevice(value: unknown): value is RememberedAccount {
    if (!value || typeof value !== 'object') return false;
    const v = value as Record<string, unknown>;
    return (
        v.version === 1 &&
        Number.isSafeInteger(v.keyVersion) &&
        Number(v.keyVersion) > 0 &&
        Number.isSafeInteger(v.credentialVersion) &&
        Number(v.credentialVersion) > 0 &&
        typeof v.userId === 'string' &&
        /^[a-f0-9-]{36}$/.test(v.userId) &&
        typeof v.deviceKeyId === 'string' &&
        v.deviceKeyId.length <= 100 &&
        typeof v.nonce === 'string' &&
        /^[A-Za-z0-9_-]{16}$/.test(v.nonce) &&
        typeof v.encryptedKey === 'string' &&
        /^[A-Za-z0-9_-]{64}$/.test(v.encryptedKey)
    );
}
export function createAuthStore() {
    return createStore<AuthState>()(
        persist(
            (): AuthState => ({
                unlockedUserId: null,
                restoring: false,
                rememberError: '',
                device: null,
                lockRevision: 0,
            }),
            {
                name: 'hushos-device-unlock',
                version: 1,
                storage: createJSONStorage(() => localStorage),
                skipHydration: true,
                partialize: (state) => ({ device: state.device, lockRevision: state.lockRevision }),
                merge: (persisted, current) => {
                    const saved =
                        persisted && typeof persisted === 'object'
                            ? (persisted as Record<string, unknown>)
                            : {};
                    return {
                        ...current,
                        device: isDevice(saved.device) ? saved.device : null,
                        lockRevision:
                            typeof saved.lockRevision === 'number' &&
                            Number.isSafeInteger(saved.lockRevision)
                                ? saved.lockRevision
                                : 0,
                    };
                },
            },
        ),
    );
}
