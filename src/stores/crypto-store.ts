import { create } from 'zustand';
import { persist } from 'zustand/middleware';

import { createSuperJSONStorage } from '@/stores/super-json-storage';
import { withStorageEvents } from '@/stores/with-storage-events';

export type State = {
    masterKey: string | null;
    privateKey: string | null;
    publicKey: string | null;
    signingPublicKey: string | null;
    signingPrivateKey: string | null;
    recoveryKeyMnemonic: string | null;
};

export type Actions = {
    setData: (data: Partial<State>) => void;
    hasRequiredKeys: () => boolean;
};

const initialAuthState: State = {
    masterKey: null,

    privateKey: null,
    publicKey: null,

    signingPublicKey: null,
    signingPrivateKey: null,

    recoveryKeyMnemonic: null,
};

export const useCryptoStore = create<State & Actions>()(
    persist(
        (set, get) => ({
            ...initialAuthState,

            setData: data => set({ ...data }),

            hasRequiredKeys: () => {
                const { masterKey, privateKey, signingPrivateKey } = get();
                return !!(masterKey && privateKey && signingPrivateKey);
            },
        }),
        {
            name: 'crypto-store',
            partialize: state => ({
                masterKey: state.masterKey,
                privateKey: state.privateKey,
                signingPrivateKey: state.signingPrivateKey,
            }),
            storage: createSuperJSONStorage(),
        }
    )
);

withStorageEvents(useCryptoStore);
