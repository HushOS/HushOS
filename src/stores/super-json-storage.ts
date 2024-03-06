import SuperJSON from 'superjson';
import { PersistStorage } from 'zustand/middleware';

export function createSuperJSONStorage<T>(): PersistStorage<T> {
    return {
        getItem: (name: string) => {
            const str = localStorage.getItem(name);
            if (!str) return null;
            return SuperJSON.parse(str);
        },
        setItem: (name, value) => {
            localStorage.setItem(name, SuperJSON.stringify(value));
        },
        removeItem: name => localStorage.removeItem(name),
    };
}
