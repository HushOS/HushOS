import type { NodeView } from '@hushos/drive/api';
import type { DriveNode } from '@hushos/drive/client';
import {
    RecordNotUpdated,
    resultSignatures,
    RunStopped,
    SaveRefused,
    type ResultSources,
    type RunPlan,
    type SaveRun,
} from '@hushos/drive/save-runs';
import { describe, expect, test } from 'vitest';
import { encodeText } from '@/lib/text-edit';
import {
    editTargetOf,
    openedTarget,
    saveCopy,
    savedTarget,
    saveVersion,
    SessionEnded,
} from '@/lib/text-save';

/*
 * The editor's save and its stale choices, over a stand-in for the save path
 * that keeps a folder the way the server does: each file's versions in order,
 * a new version refused `stale` when the file moved on from where the work
 * started, and a new file under the next free name. The save path itself is
 * tested against the real upload engine in packages/drive; this holds the
 * editor to asking it the right things.
 */

type Stored = { id: string; name: string; versions: { id: string; bytes: number[] }[] };

function bench(room = Infinity, finishFailures = 0) {
    const ends = { finishes: 0, releases: 0 };
    let failing = finishFailures;
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
                const minted = `v${++ids}`;
                files.set(id, { id, name, versions: [{ id: minted, bytes: flat(result.bytes) }] });
                result.onVersion?.(minted);
                return view(id);
            },
            version: async (result) => {
                sources.push(result.sources);
                const stored = files.get(result.file.id);
                if (!stored) return { status: 'stale', currentVersionId: null };
                if (current(stored.id) !== result.startedFrom)
                    return { status: 'stale', currentVersionId: current(stored.id) };
                stored.versions.push({ id: `v${++ids}`, bytes: flat(result.bytes) });
                return { status: 'saved', node: view(stored.id), versionId: current(stored.id) };
            },
            finish: async () => {
                ends.finishes += 1;
                if (failing-- > 0) throw new RecordNotUpdated();
            },
            cancel: async () => new RunStopped('cancelled', 'Cancelled.', 'nothing', 1),
            release: () => {
                ends.releases += 1;
            },
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
    return { files, plans, sources, ends, folder, add, asNode, start, theirs, text, current };
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
        const made = await saveCopy(b.start, {
            file,
            source: file,
            folder: b.folder,
            text: 'mine\n',
        });
        const copy = b.files.get(made.node!.id)!;
        expect(made.versionId).toBe(copy.versions[0]!.id);
        expect(copy.name).toBe('notes (3).txt');
        expect(b.text(copy.id)).toBe('mine\n');
        expect(b.text(id)).toBe('theirs\n');
        expect(b.files.get(id)!.versions).toHaveLength(2);
        // Into the file's folder, signed as its source is: never the person's own writing.
        expect(b.plans.at(-1)!.targets).toEqual([b.folder]);
        expect(b.sources.at(-1)).toEqual([{ node: file, source: 'drive' }]);
        expect(b.sources[0]).toBe('own-writing');
    });

    test('a later copy is signed as the text’s source, never as the copy’s row now reads', async () => {
        const b = bench();
        const id = b.add('notes.txt', 'start');
        const opened = {
            ...b.asNode(id),
            integrity: { metadata: 'unverified', version: 'unverified' },
        } as unknown as DriveNode;
        const first = openedTarget(opened);
        const made = await saveCopy(b.start, {
            file: first.file,
            source: first.source,
            folder: b.folder,
            text: 'mine',
        });
        // Before the editor finds its copy, someone replaces it with a version that checks as verified.
        const theirs = b.theirs(made.node!.id, 'theirs');
        const listed = {
            ...b.asNode(made.node!.id),
            integrity: { metadata: 'verified', version: 'verified' },
        } as unknown as DriveNode;
        const next = savedTarget(first, listed, made.versionId);
        expect(next.file).toBe(listed);
        expect(next.startedFrom).toBe(made.versionId);
        expect(next.startedFrom).not.toBe(theirs);
        await saveCopy(b.start, {
            file: next.file,
            source: next.source,
            folder: b.folder,
            text: 'mine again',
        });
        // Both copies carry the Unverified file's form: re-sealed, never the person's ordinary word.
        for (const sources of b.sources)
            expect(resultSignatures(sources as ResultSources)).toEqual({
                metadata: 'resealed',
                version: 'resealed',
            });
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

describe('ending the run', () => {
    const noPause = () => Promise.resolve();

    test('a record this device wouldn’t update is asked again, never the upload', async () => {
        const b = bench(Infinity, 2);
        const id = b.add('notes.txt', 'a');
        const file = b.asNode(id);
        const saved = await saveVersion(
            b.start,
            { file, folder: b.folder, startedFrom: file.currentVersion!.id, text: 'ab' },
            { pause: noPause },
        );
        expect(saved.status).toBe('saved');
        expect(b.files.get(id)!.versions).toHaveLength(2);
        expect(b.ends).toEqual({ finishes: 3, releases: 0 });
    });

    test('a run that never finishes is let go of, and what it saved is still said saved', async () => {
        const b = bench(Infinity, 99);
        const id = b.add('notes.txt', 'a');
        const file = b.asNode(id);
        const saved = await saveVersion(
            b.start,
            { file, folder: b.folder, startedFrom: file.currentVersion!.id, text: 'ab' },
            { pause: noPause },
        );
        expect(saved).toEqual({ status: 'saved', versionId: b.current(id) });
        expect(b.files.get(id)!.versions).toHaveLength(2);
        expect(b.ends.releases).toBe(1);
    });
});

describe('where a save goes', () => {
    const file = {
        id: 'doc',
        kind: 'file',
        workspaceId: 'w',
        parentId: 'folder',
        currentVersion: { id: 'v1' },
    } as unknown as DriveNode;
    const folder = { id: 'folder', kind: 'folder', workspaceId: 'w' } as DriveNode;

    test('the file’s own folder and the file in it', () => {
        expect(editTargetOf({ folder, children: [file] }, file)).toEqual({ folder, file });
    });

    test('a listing answering for another folder or workspace is refused', () => {
        const elsewhere = { ...folder, id: 'other' } as DriveNode;
        expect(() => editTargetOf({ folder: elsewhere, children: [file] }, file)).toThrow();
        const otherDrive = { ...folder, workspaceId: 'x' } as DriveNode;
        expect(() => editTargetOf({ folder: otherDrive, children: [file] }, file)).toThrow();
    });

    test('a row with the file’s id from another workspace or folder is not the file', () => {
        const twin = { ...file, workspaceId: 'x' } as DriveNode;
        const moved = { ...file, parentId: 'other' } as DriveNode;
        expect(editTargetOf({ folder, children: [twin, moved] }, file).file).toBeNull();
    });
});

test('a save names the version it published, not the one its reply row shows by then', async () => {
    const file = {
        id: 'doc',
        kind: 'file',
        name: 'notes.txt',
        workspaceId: 'w',
        parentId: 'folder',
        metadata: { mime: null },
        currentVersion: { id: 'v1' },
    } as unknown as DriveNode;
    const run = {
        version: async () => ({
            status: 'saved' as const,
            node: { id: 'doc', currentVersion: { id: 'v-theirs-after' } } as NodeView,
            versionId: 'v-mine',
        }),
        finish: async () => {},
    } as unknown as SaveRun;
    const saved = await saveVersion(async () => run, {
        file,
        folder: { id: 'folder', kind: 'folder', workspaceId: 'w' } as DriveNode,
        startedFrom: 'v1',
        text: 'x',
    });
    expect(saved).toEqual({ status: 'saved', versionId: 'v-mine' });
});

test('a save whose editor session ended before its run starts uploads nothing', async () => {
    const b = bench();
    const id = b.add('notes.txt', 'a');
    const file = b.asNode(id);
    await expect(
        saveVersion(
            b.start,
            { file, folder: b.folder, startedFrom: file.currentVersion!.id, text: 'b' },
            { stillOn: () => false },
        ),
    ).rejects.toBeInstanceOf(SessionEnded);
    await expect(
        saveCopy(
            b.start,
            { file, source: file, folder: b.folder, text: 'b' },
            { stillOn: () => false },
        ),
    ).rejects.toBeInstanceOf(SessionEnded);
    expect(b.plans).toHaveLength(0);
    expect(b.files.get(id)!.versions).toHaveLength(1);
    expect(b.files.size).toBe(1);
});

test('a save whose editor session ends while its run starts uploads nothing and retires the empty run', async () => {
    const b = bench();
    const id = b.add('notes.txt', 'a');
    const file = b.asNode(id);
    // On while the folder was found; ended (Discard) while the run waited for room, its lock and its record.
    let on = true;
    const start = async (plan: Parameters<typeof b.start>[0]) => {
        const run = await b.start(plan);
        on = false;
        return run;
    };
    await expect(
        saveVersion(
            start,
            { file, folder: b.folder, startedFrom: file.currentVersion!.id, text: 'b' },
            { stillOn: () => on },
        ),
    ).rejects.toBeInstanceOf(SessionEnded);
    expect(b.files.get(id)!.versions).toHaveLength(1);
    expect(b.ends.finishes).toBe(1);
    on = true;
    const startCopy = async (plan: Parameters<typeof b.start>[0]) => {
        const run = await b.start(plan);
        on = false;
        return run;
    };
    await expect(
        saveCopy(
            startCopy,
            { file, source: file, folder: b.folder, text: 'b' },
            { stillOn: () => on },
        ),
    ).rejects.toBeInstanceOf(SessionEnded);
    expect(b.files.size).toBe(1);
    expect(b.ends.finishes).toBe(2);
});
