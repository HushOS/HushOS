import type { NodeView } from '@hushos/drive/api';
import type { DriveNode } from '@hushos/drive/client';
import { SaveRefused, type RunPlan, type SaveRun } from '@hushos/drive/save-runs';
import { describe, expect, test } from 'vitest';
import { encodeText } from '@/lib/text-edit';
import { saveCopy, saveVersion } from '@/lib/text-save';

/*
 * The editor's save and its stale choices, over a stand-in for the save path
 * that keeps a folder the way the server does: each file's versions in order,
 * a new version refused `stale` when the file moved on from where the work
 * started, and a new file under the next free name. The save path itself is
 * tested against the real upload engine in packages/drive; this holds the
 * editor to asking it the right things.
 */

type Stored = { id: string; name: string; versions: { id: string; bytes: number[] }[] };

function bench(room = Infinity) {
    const files = new Map<string, Stored>();
    const plans: RunPlan[] = [];
    const sources: unknown[] = [];
    let ids = 0;
    const folder = { id: 'folder', kind: 'folder', workspaceId: 'w' } as DriveNode;
    const add = (name: string, text: string) => {
        const id = `n${++ids}`;
        files.set(id, { id, name, versions: [{ id: `v${++ids}`, bytes: [...encodeText(text)] }] });
        return id;
    };
    const current = (id: string) => files.get(id)!.versions.at(-1)!.id;
    const asNode = (id: string) =>
        ({
            id,
            kind: 'file',
            name: files.get(id)!.name,
            workspaceId: 'w',
            parentId: folder.id,
            metadata: { mime: 'text/plain' },
            integrity: null,
            currentVersion: { id: current(id) },
        }) as unknown as DriveNode;
    const view = (id: string) => ({ id, currentVersion: { id: current(id) } }) as NodeView;
    const flat = (bytes: Uint8Array | Uint8Array[]) =>
        (Array.isArray(bytes) ? bytes : [bytes]).flatMap((part) => [...part]);
    const start = async (plan: RunPlan): Promise<SaveRun> => {
        plans.push(plan);
        const needed = plan.results.reduce((sum, r) => sum + ('size' in r ? r.size : 0), 0);
        if (needed > room) throw new SaveRefused('no-room', 'no room');
        return {
            id: `run${plans.length}`,
            folder: () => Promise.reject(new Error('not asked')),
            file: async (result) => {
                sources.push(result.sources);
                const taken = new Set([...files.values()].map((f) => f.name.toLowerCase()));
                let name = result.name;
                for (let n = 2; taken.has(name.toLowerCase()); n++)
                    name = result.name.replace(/(\.[^.]+)?$/, ` (${n})$1`);
                const id = `n${++ids}`;
                files.set(id, {
                    id,
                    name,
                    versions: [{ id: `v${++ids}`, bytes: flat(result.bytes) }],
                });
                return view(id);
            },
            version: async (result) => {
                sources.push(result.sources);
                const stored = files.get(result.file.id);
                if (!stored) return { status: 'stale', currentVersionId: null };
                if (current(stored.id) !== result.startedFrom)
                    return { status: 'stale', currentVersionId: current(stored.id) };
                stored.versions.push({ id: `v${++ids}`, bytes: flat(result.bytes) });
                return { status: 'saved', node: view(stored.id) };
            },
            finish: async () => {},
            cancel: () => Promise.reject(new Error('not asked')),
            waiting: () => 0,
        };
    };
    /* Someone else's save from another device. */
    const theirs = (id: string, text: string) => {
        files.get(id)!.versions.push({ id: `v${++ids}`, bytes: [...encodeText(text)] });
        return current(id);
    };
    const text = (id: string, at = -1) =>
        new TextDecoder().decode(Uint8Array.from(files.get(id)!.versions.at(at)!.bytes));
    return { files, plans, sources, folder, add, asNode, start, theirs, text, current };
}

describe('saving an edit', () => {
    test('a save is a new version holding exactly the edited text', async () => {
        const b = bench();
        const id = b.add('notes.txt', 'café\n');
        const file = b.asNode(id);
        const saved = await saveVersion(b.start, {
            file,
            folder: b.folder,
            startedFrom: file.currentVersion!.id,
            text: 'café ✓\n',
        });
        expect(saved).toEqual({ status: 'saved', versionId: b.current(id) });
        expect(b.files.get(id)!.versions).toHaveLength(2);
        expect(b.text(id)).toBe('café ✓\n');
        // Planned as its UTF-8 bytes (not its length in characters) and without a thumbnail.
        expect(b.plans[0]).toEqual({ targets: [file], results: [{ size: 10, thumbnail: false }] });
    });

    test('a second save goes on from the version the first one made', async () => {
        const b = bench();
        const id = b.add('notes.txt', 'a');
        const file = b.asNode(id);
        const first = await saveVersion(b.start, {
            file,
            folder: b.folder,
            startedFrom: file.currentVersion!.id,
            text: 'ab',
        });
        if (first.status !== 'saved') throw new Error('first save');
        const second = await saveVersion(b.start, {
            file,
            folder: b.folder,
            startedFrom: first.versionId,
            text: 'abc',
        });
        expect(second.status).toBe('saved');
        expect(
            b.files.get(id)!.versions.map((v) => b.text(id, b.files.get(id)!.versions.indexOf(v))),
        ).toEqual(['a', 'ab', 'abc']);
    });

    test('a room refusal saves nothing', async () => {
        const b = bench(3);
        const id = b.add('notes.txt', 'a');
        const file = b.asNode(id);
        await expect(
            saveVersion(b.start, {
                file,
                folder: b.folder,
                startedFrom: file.currentVersion!.id,
                text: 'more than three',
            }),
        ).rejects.toBeInstanceOf(SaveRefused);
        expect(b.files.get(id)!.versions).toHaveLength(1);
    });
});

describe('when someone else saved first', () => {
    async function stale() {
        const b = bench();
        const id = b.add('notes.txt', 'start\n');
        const file = b.asNode(id);
        const theirs = b.theirs(id, 'theirs\n');
        const saved = await saveVersion(b.start, {
            file,
            folder: b.folder,
            startedFrom: file.currentVersion!.id,
            text: 'mine\n',
        });
        return { b, id, file, theirs, saved };
    }

    test('the save is refused naming their version, and nothing of mine is published', async () => {
        const { b, id, theirs, saved } = await stale();
        expect(saved).toEqual({ status: 'stale', currentVersionId: theirs });
        expect(b.files.get(id)!.versions).toHaveLength(2);
        expect(b.text(id)).toBe('theirs\n');
        expect(b.files.size).toBe(1);
    });

    test('Save on top makes a new version after theirs; both stay in history', async () => {
        const { b, id, file, saved } = await stale();
        if (saved.status !== 'stale') throw new Error('stale');
        const onTop = await saveVersion(b.start, {
            file,
            folder: b.folder,
            startedFrom: saved.currentVersionId,
            text: 'mine\n',
        });
        expect(onTop.status).toBe('saved');
        const versions = b.files.get(id)!.versions;
        expect(versions).toHaveLength(3);
        expect(b.text(id, 1)).toBe('theirs\n');
        expect(b.text(id)).toBe('mine\n');
    });

    test('Save as a copy makes a sibling under the next free name and leaves theirs current', async () => {
        const { b, id, file } = await stale();
        b.add('notes (2).txt', 'already here');
        const made = await saveCopy(b.start, { file, folder: b.folder, text: 'mine\n' });
        const copy = b.files.get(made!.id)!;
        expect(copy.name).toBe('notes (3).txt');
        expect(b.text(copy.id)).toBe('mine\n');
        expect(b.text(id)).toBe('theirs\n');
        expect(b.files.get(id)!.versions).toHaveLength(2);
        // Into the file's folder, signed as its source is: never the person's own writing.
        expect(b.plans.at(-1)!.targets).toEqual([b.folder]);
        expect(b.sources.at(-1)).toEqual([{ node: file, source: 'drive' }]);
        expect(b.sources[0]).toBe('own-writing');
    });

    test('a file gone from its folder is stale with no version to save on top of', async () => {
        const b = bench();
        const id = b.add('notes.txt', 'start');
        const file = b.asNode(id);
        b.files.delete(id);
        const saved = await saveVersion(b.start, {
            file,
            folder: b.folder,
            startedFrom: file.currentVersion!.id,
            text: 'mine',
        });
        expect(saved).toEqual({ status: 'stale', currentVersionId: null });
    });
});
