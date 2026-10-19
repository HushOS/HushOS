import { useStore } from 'zustand';
import { createStore } from 'zustand/vanilla';
import { authClient } from '@/lib/auth-client';

type AuthState = ReturnType<typeof authClient.store.getState>;

/*
 * The auth store as the screen draws it. Signing out locks this device before the app is left,
 * and every gate that reads the store would redraw the page under the sign-out (the locked
 * screen, "Opening", an emptied folder) for the moment before the sign-in page replaces it.
 * While a sign-out holds the view, components draw the state it started from. Code that uses
 * keys reads authClient.store itself, which is locked at once.
 */
const view = createStore<{ held: AuthState | null; dim: boolean }>(() => ({
    held: null,
    dim: false,
}));

export function useAuthView<T>(select: (state: AuthState) => T): T {
    const live = useStore(authClient.store, select);
    const held = useStore(view, (state) => state.held);
    return held ? select(held) : live;
}

/* Whether the app is dimmed while a sign-out that left no busy control on screen works. */
export function useSigningOutCover() {
    return useStore(view, (state) => state.held !== null && state.dim);
}

/* Who is unlocked here this moment, for an action about to use keys: never held. */
export function unlockedNow() {
    return authClient.store.getState().unlockedUserId;
}

/* Holds the view at what it shows now; the returned function lets it go. */
export function holdAuthView({ dim = false }: { dim?: boolean } = {}) {
    view.setState({ held: authClient.store.getState(), dim });
    return () => view.setState({ held: null, dim: false });
}
