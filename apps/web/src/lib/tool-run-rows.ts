import { useSyncExternalStore } from 'react';

/*
 * A tool's runs as the transfers panel lists them (docs/file-tools-design.md, section 2, "Runs in
 * the transfers panel"): one row a run, with one headline, a line saying where it is, progress,
 * and Cancel, which asks first. While its result uploads, the row shows that upload (its bytes,
 * Pause and Resume) and the panel leaves the upload's own row out. Kept apart from any tool, so
 * the panel loads none of them.
 */

export type RunPhase = 'waiting' | 'making' | 'saving' | 'stopping' | 'done' | 'failed';

export type RunRow = {
    id: string;
    /* "Making Trip.pdf". */
    title: string;
    /* What stopping it is called, and what it says happens: "Stop making the PDF?". */
    cancelQuestion: string;
    cancelWarning: string;
    phase: RunPhase;
    line: string;
    /* Making: images done of all; saving: the upload's own bytes (`uploadId`). */
    progress: { value: number; max: number } | null;
    uploadId: string | null;
};

type Live = RunRow & { cancel: () => void };

let rows: Live[] = [];
const listeners = new Set<() => void>();
function changed() {
    rows = [...rows];
    for (const listener of listeners) listener();
}

export const toolRunRows = {
    subscribe: (listener: () => void) => {
        listeners.add(listener);
        return () => void listeners.delete(listener);
    },
    getState: () => rows as readonly Live[],
    add(row: Omit<RunRow, 'id'>, cancel: () => void) {
        const live: Live = { ...row, id: crypto.randomUUID(), cancel };
        rows.push(live);
        changed();
        return {
            id: live.id,
            update(patch: Partial<Omit<RunRow, 'id'>>) {
                const index = rows.findIndex((item) => item.id === live.id);
                if (index < 0) return;
                rows[index] = { ...rows[index]!, ...patch };
                changed();
            },
        };
    },
    /* Cancels a run that is still going; the row says how it stopped once it has. */
    cancel(id: string) {
        rows.find((row) => row.id === id)?.cancel();
    },
    /* Takes a run that ended off the list. */
    remove(id: string) {
        const before = rows.length;
        rows = rows.filter((row) => row.id !== id || !ended(row.phase));
        if (rows.length !== before) changed();
    },
    /* Sign-out: every row goes, names and all (a run still going is cancelled first). */
    forget() {
        for (const row of rows) if (!ended(row.phase)) row.cancel();
        rows = [];
        changed();
    },
    clearFinished() {
        const before = rows.length;
        rows = rows.filter((row) => !ended(row.phase));
        if (rows.length !== before) changed();
    },
};

export const ended = (phase: RunPhase) => phase === 'done' || phase === 'failed';

const EMPTY: readonly Live[] = [];
export function useToolRunRows() {
    return useSyncExternalStore(toolRunRows.subscribe, toolRunRows.getState, () => EMPTY);
}
