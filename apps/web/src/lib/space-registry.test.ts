import { describe, expect, test } from 'vitest';
import { createSpaceRegistry, FOLDER_GONE } from './space-registry';

/*
 * Routing a family folder's work to its own client. The personal client
 * judges records by personal pins alone, so falling back to it for a folder
 * that was a family's would re-sign a former member's record as one's own: a
 * forgotten folder must throw, never fall back.
 */
type Fake = {
    name: string;
    closed: number;
    seen: Set<string>;
    close(): void;
    knows(id: string): boolean;
};
const fake = (name: string, seen: string[] = []): Fake => ({
    name,
    closed: 0,
    seen: new Set(seen),
    close() {
        this.closed++;
    },
    knows(id: string) {
        return this.seen.has(id);
    },
});
const GROUP = 'g1';

describe('space registry', () => {
    test('a family folder forgotten or pruned fails closed, never falling back to the personal client', () => {
        const personal = fake('personal');
        const spaces = createSpaceRegistry<Fake>(() => personal);
        const family = fake('family', ['photo']);
        const other = fake('other');
        spaces.register('ws-a', { groupId: GROUP, client: family, refuseWrite: () => null });
        spaces.register('ws-b', { groupId: 'g2', client: other, refuseWrite: () => null });
        expect(spaces.clientFor('ws-a')).toBe(family);
        expect(spaces.clientOfNode('photo')).toBe(family);
        // Never registered: one's own Drive (or a share), as before families.
        expect(spaces.clientFor('ws-personal')).toBe(personal);
        expect(spaces.clientFor(null)).toBe(personal);

        spaces.prune(GROUP, []);
        expect(family.closed).toBe(1);
        expect(() => spaces.clientFor('ws-a')).toThrow(FOLDER_GONE);
        expect(spaces.refuseWrite({ id: 'x', keyEpoch: 9, workspaceId: 'ws-a' })).toBe(FOLDER_GONE);
        expect(spaces.clientOfNode('photo')).toBe(personal);
        // Another family's folder is untouched by the prune.
        expect(spaces.clientFor('ws-b')).toBe(other);

        // Listed again by a later sync: registered, and reachable once more.
        spaces.register('ws-a', { groupId: GROUP, client: family, refuseWrite: () => null });
        expect(spaces.clientFor('ws-a')).toBe(family);
        spaces.forget('ws-b');
        expect(() => spaces.clientFor('ws-b')).toThrow(FOLDER_GONE);
    });

    test('a prune keeps the folders still listed, and asks each folder why a write is refused', () => {
        const spaces = createSpaceRegistry<Fake>(() => fake('personal'));
        const kept = fake('kept');
        spaces.register('ws-a', {
            groupId: GROUP,
            client: kept,
            refuseWrite: (f) => (f.keyEpoch < 5 ? 'wait' : null),
        });
        spaces.register('ws-gone', {
            groupId: GROUP,
            client: fake('gone'),
            refuseWrite: () => null,
        });
        spaces.prune(GROUP, ['ws-a']);
        expect(spaces.clientFor('ws-a')).toBe(kept);
        expect(kept.closed).toBe(0);
        expect(spaces.refuseWrite({ id: 'f', keyEpoch: 4, workspaceId: 'ws-a' })).toBe('wait');
        expect(spaces.refuseWrite({ id: 'f', keyEpoch: 5, workspaceId: 'ws-a' })).toBeNull();
        expect(spaces.refuseWrite({ id: 'f', keyEpoch: 1, workspaceId: 'ws-personal' })).toBeNull();
        expect(() => spaces.clientFor('ws-gone')).toThrow(FOLDER_GONE);
    });
});
