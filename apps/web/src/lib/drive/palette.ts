import type { DriveNode } from '@hushos/drive/client';
import { useSyncExternalStore } from 'react';

/*
 * The command center's view of wherever the person is. The folder view lends
 * it the folder's actions and the folders in view while it is on screen; the
 * rest (going places, the trash, the device) needs nothing from the page. One
 * store, so the palette can live at the app's root and Mod+K works everywhere.
 */

export type PaletteActions = {
    newFolder: () => void;
    rename: () => void;
    move: () => void;
    copy: () => void;
    versions: () => void;
    share: () => void;
    download: () => void;
    trash: () => void;
    tags?: () => void;
    upload?: () => void;
};

export type PaletteContext = {
    folders: DriveNode[];
    parentId: string | null;
    selection: DriveNode[];
    rows: number;
    view: 'list' | 'grid';
    setView: (view: 'list' | 'grid') => void;
    selectAll: () => void;
    clearSelection: () => void;
    actions: PaletteActions;
};

type State = { open: boolean; query: string; context: PaletteContext | null };

let state: State = { open: false, query: '', context: null };
const listeners = new Set<() => void>();
function emit() {
    for (const listener of listeners) listener();
}

/* The folder view calls this on every render it is mounted for, and with null on the way out. */
export function lendPaletteContext(context: PaletteContext | null) {
    state = { ...state, context };
    // Nobody is looking while it is closed; the next open reads the latest.
    if (state.open || context === null) emit();
}
export function setPaletteQuery(query: string) {
    if (state.query === query) return;
    state = { ...state, query };
    emit();
}
/* Opens with a query already typed, for a header box that hands its text over. */
export function openPalette(query = '') {
    state = { ...state, open: true, query };
    emit();
}
export function setPaletteOpen(open: boolean) {
    if (state.open === open) return;
    state = { ...state, open };
    emit();
}
function subscribe(listener: () => void) {
    listeners.add(listener);
    return () => listeners.delete(listener);
}
export function usePaletteState() {
    return useSyncExternalStore(
        subscribe,
        () => state,
        () => state,
    );
}
/* Just the flag: the folder view lends context on every render, so it must not re-render on it. */
export function usePaletteOpen() {
    return useSyncExternalStore(
        subscribe,
        () => state.open,
        () => false,
    );
}
