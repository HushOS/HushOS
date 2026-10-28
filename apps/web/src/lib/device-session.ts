import type { UploadSession } from '@hushos/drive/transfers';
import { authClient } from '@/lib/auth-client';
import { onSignedOutElsewhere } from '@/lib/device-data';

type AuthStore = {
    subscribe(
        listener: (
            state: { unlockedUserId: string | null },
            previous: { unlockedUserId: string | null },
        ) => void,
    ): () => void;
};

/*
 * Whether this tab may start work that writes what the device keeps for an account, and for
 * which session. A sign-out, in this tab or heard from another, shuts it and moves the
 * generation on; only a sign-in opens it again: the account unlocking anew, which after a
 * sign-out takes a new session (there is no saved unlock left to restore). Work that runs a
 * while before it writes (a copy reading its bytes, a move) takes the generation as it starts
 * and is refused when a sign-out came in between, even if someone signed in again since.
 */
export function createDeviceSession(store: AuthStore): UploadSession & { signedOut(): void } {
    let generation = 0;
    let open = true;
    store.subscribe((state, previous) => {
        if (!open && state.unlockedUserId && state.unlockedUserId !== previous.unlockedUserId)
            open = true;
    });
    return {
        open: () => open,
        generation: () => generation,
        signedOut() {
            generation++;
            open = false;
        },
    };
}

export const deviceSession = createDeviceSession(authClient.store);
onSignedOutElsewhere(() => deviceSession.signedOut());
