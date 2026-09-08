import type { Mutate, StoreApi } from 'zustand/vanilla';

type StoreWithPersist<T, U> = Mutate<StoreApi<T>, [['zustand/persist', U]]>;
export function withStorageEvents<T, U>(store: StoreWithPersist<T, U>, onClear: () => void) {
    if (typeof window === 'undefined') return () => {};
    const callback = (event: StorageEvent) => {
        if (event.storageArea !== window.localStorage) return;
        if (event.key !== null && event.key !== store.persist.getOptions().name) return;
        // removeItem and clear are meaningful for logout too.
        if (event.newValue === null) onClear();
        else void store.persist.rehydrate();
    };
    window.addEventListener('storage', callback);
    return () => window.removeEventListener('storage', callback);
}
