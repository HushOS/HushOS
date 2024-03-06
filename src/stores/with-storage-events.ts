import { Mutate, StoreApi } from 'zustand';

type StoreWithPersist<T, U> = Mutate<StoreApi<T>, [['zustand/persist', U]]>;

export function withStorageEvents<T, U>(store: StoreWithPersist<T, U>) {
    const storageEventCallback = (e: StorageEvent) => {
        if (e.key === store.persist.getOptions().name && e.newValue) {
            store.persist.rehydrate();
        }
    };

    if (typeof window === 'undefined') {
        return () => {};
    }

    window.addEventListener('storage', storageEventCallback);

    return () => {
        window.removeEventListener('storage', storageEventCallback);
    };
}
