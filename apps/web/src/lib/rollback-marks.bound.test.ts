// @vitest-environment node
import { updateRollbackMarks, RollbackMarksError } from '@hushos/crypto/rollback-marks';
import { beforeEach, describe, expect, test, vi } from 'vitest';

/*
 * The app's own marks (the functions contacts.ts and own-identity.ts call), with the worker
 * and the settings key stood in for, in a browser without Web Locks.
 */
const world = vi.hoisted(() => ({
    maya: '0f6d6c1e-2a49-4d8b-9b1a-4b3f4b8c1d01',
    key: crypto.getRandomValues(new Uint8Array(32)) as Uint8Array<ArrayBuffer>,
    /* The settings endpoint: answering, or refusing. */
    settings: 'answers' as 'answers' | 'refuses',
}));
vi.mock('@/lib/auth-client', () => ({
    authClient: {
        store: { getState: () => ({ unlockedUserId: world.maya }), subscribe: () => () => {} },
        rpc: async (
            operation: string,
            input: { userId: string; envelope: string | null; marks: object },
        ) => {
            if (operation !== 'rollbackMarksUpdate') throw new Error(`unexpected ${operation}`);
            // A worker answers a little later, so updates from one tab can interleave.
            await new Promise((resolve) => setTimeout(resolve, 5));
            try {
                return {
                    refused: false,
                    ...(await updateRollbackMarks(
                        world.key,
                        input.userId,
                        input.envelope,
                        input.marks,
                    )),
                };
            } catch (error) {
                if (error instanceof RollbackMarksError) return { refused: true };
                throw error;
            }
        },
    },
}));
vi.mock('@/lib/contacts', () => ({
    marksKeyReady: async () => {
        if (world.settings === 'refuses') throw new Error('Something went wrong.');
        return { nonce: 'n', ciphertext: 'c' };
    },
}));
// localStorage, and no Web Locks. (Node: jsdom's bytes don't reach libsodium.)
const items = new Map<string, string>();
const localStorage = {
    getItem: (key: string) => items.get(key) ?? null,
    setItem: (key: string, value: string) => void items.set(key, String(value)),
    removeItem: (key: string) => void items.delete(key),
    key: (index: number) => [...items.keys()][index] ?? null,
    clear: () => items.clear(),
    get length() {
        return items.size;
    },
};
vi.stubGlobal('window', { localStorage });
vi.stubGlobal('navigator', {});
const marks = await import('./rollback-marks');
const MAYA = world.maya;

beforeEach(() => {
    localStorage.clear();
    world.settings = 'answers';
});

describe('keeping marks', () => {
    test('a mark that cannot be kept fails the step that would take what it marks', async () => {
        // The server will not serve the settings key the first mark needs.
        world.settings = 'refuses';
        await expect(marks.rememberIdentitySeen(MAYA, 2, 2)).rejects.toBeInstanceOf(
            marks.MarksUnsavedError,
        );
        await expect(marks.rememberSettingsSeen(MAYA, 3)).rejects.toBeInstanceOf(
            marks.MarksUnsavedError,
        );
    });
});
