import { authClient } from '@/lib/auth-client';
import { compareAndSetSettings, familyGuardStore, readSettingsForFamilies } from '@/lib/contacts';
import { groupsApi } from './api';
import { familyGuardOf, groupWriteLock, type GroupContext, type RotationSource } from './context';
import {
    createIndexedDbGroupStore,
    createUnavailableGroupStore,
    deleteAreaMirrors,
    type GroupStore,
} from './store';

/*
 * The families data layer as the app runs it: the real routes, the crypto
 * worker behind the auth client, IndexedDB, the settings document and Web
 * Locks. One context per unlocked account; the rotation source arrives with
 * the family folder clients (plan steps 6 and 7).
 */

let store: GroupStore | undefined;
function deviceStore() {
    store ??=
        typeof indexedDB === 'undefined'
            ? createUnavailableGroupStore()
            : createIndexedDbGroupStore();
    return store;
}

let rotations: RotationSource | null = null;

/* Every lock and unlock moves this on (GroupContext.session). */
let unlocks = 0;
authClient.store.subscribe((state, previous) => {
    if (state.unlockedUserId !== previous.unlockedUserId) unlocks++;
});
export function provideRotations(source: RotationSource | null) {
    rotations = source;
}

export function groupContext(userId: string): GroupContext {
    const requireUnlocked = () => {
        if (authClient.store.getState().unlockedUserId !== userId)
            throw new Error('Unlock your account first.');
    };
    return {
        userId,
        api: groupsApi,
        rpc: (operation, input) => {
            requireUnlocked();
            return authClient.rpc(operation, input);
        },
        store: deviceStore(),
        settings: {
            read: () => readSettingsForFamilies(userId),
            write: (version, settings) => compareAndSetSettings(userId, version, settings),
        },
        guard: familyGuardOf(familyGuardStore, userId),
        session: () => unlocks,
        lock: groupWriteLock,
        sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
        now: () => new Date(),
        identities: async () => {
            const [{ identity }, { identities: history }] = await Promise.all([
                authClient.identity(),
                authClient.identityHistory(),
            ]);
            return { identity, history };
        },
        deleteMirrors: deleteAreaMirrors,
        get rotations() {
            return rotations;
        },
    };
}
