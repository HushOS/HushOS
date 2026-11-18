import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import {
    bracketMatching,
    HighlightStyle,
    indentOnInput,
    syntaxHighlighting,
} from '@codemirror/language';
import { highlightSelectionMatches, search, searchKeymap } from '@codemirror/search';
import { Compartment, EditorState, type Extension, type Text } from '@codemirror/state';
import {
    crosshairCursor,
    drawSelection,
    dropCursor,
    EditorView,
    highlightActiveLine,
    highlightActiveLineGutter,
    highlightSpecialChars,
    keymap,
    lineNumbers,
    rectangularSelection,
} from '@codemirror/view';
import type { DriveNode } from '@hushos/drive/client';
import type { FileReader } from '@hushos/drive/downloads';
import { tags } from '@lezer/highlight';
import { useFormatForDisplay, useHotkey } from '@tanstack/react-hotkeys';
import { useQueryClient, type QueryClient } from '@tanstack/react-query';
import { useBlocker } from '@tanstack/react-router';
import { SaveIcon, TriangleAlertIcon } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Notice, Opening } from '@/components/drive/viewer-parts';
import { openStorageFull } from '@/components/drive/storage-full-dialog';
import { Spinner } from '@/components/motion';
import {
    AlertDialog,
    AlertDialogCancel,
    AlertDialogContent,
    AlertDialogDescription,
    AlertDialogFooter,
    AlertDialogHeader,
    AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import { unlockedNow } from '@/lib/auth-view';
import { deviceSession } from '@/lib/device-session';
import { driveError, folderQueryOptions, invalidateFolders, nodeSize } from '@/lib/drive';
import { editorLanguage, loadLanguage, preloadLanguages, wrapsLines } from '@/lib/editor-languages';
import { holdPageWhile } from '@/lib/leave-guard';
import { openReader, readAll, type ReadProgress } from '@/lib/previews';
import { RunStopped, SaveRefused, startSaveRun } from '@/lib/save-runs';
import { openText, READ_ONLY_WORDS, TEXT_EDIT_LIMIT, type ReadOnlyReason } from '@/lib/text-edit';
import { parseFailure, parseWarning, preloadParsers, structuredKind } from '@/lib/text-parse';
import {
    editTargetOf,
    openedTarget,
    saveCopy,
    savedTarget,
    saveVersion,
    type EditTarget,
    type StartRun,
} from '@/lib/text-save';

/*
 * The text editor (docs/editing-design.md section 1; Editing 1a): CodeMirror over the
 * file's current version, read again from the server, never the viewer's copy. Saving is
 * explicit (Save, Ctrl or Cmd+S), a new version through the save path, with the stale
 * choices when someone else saved first. A file it can't save byte for byte opens read-only
 * with a note. Its text lives in this component only: a lock or a sign-out unmounts the drive
 * and the text goes with it, and nothing is kept on this device (drafts are Editing 1c).
 *
 * Loaded on first use, never with the drive (the preload is Editing 1b).
 */

/*
 * The session's way out, shared with the viewer. `discarded`: the person chose to discard, so
 * nothing asks again. `finishing`: while a save or a copy is on its way (it may still publish), a
 * close waits on it instead of offering Discard: the promise says whether it landed, and the
 * editor says it is finishing meanwhile; null when nothing is on its way.
 */
export type EditGuard = { discarded: boolean; finishing?: () => Promise<boolean> | null };
type SessionToken = { opening: number; account: number };

/*
 * The editor with every grammar and parser it may use, fetched after unlock (lib/preload.ts,
 * editing-design.md section 4): which ones a device fetched never says what was edited.
 */
export async function preloadEditor() {
    await preloadLanguages();
    await preloadParsers();
}
type GuardRef = { readonly current: EditGuard };

type Phase =
    | { kind: 'loading'; progress: ReadProgress | null }
    | { kind: 'failed'; message: string }
    | { kind: 'read-only'; reason: ReadOnlyReason; text: string | null }
    | { kind: 'editing'; text: string };

/* The file being written, and the version this editor's text started from. */

export const editorWords = {
    save: 'Save',
    saving: 'Saving',
    saved: 'Saved',
    savedCopy: (name: string) => `Saved as “${name}”`,
    savedCopyEnded: 'Saved as a copy. Open it from its folder to keep editing.',
    savedCopyEndedLater:
        'Saved as a copy, without what you typed while it saved. Copy that text before you close.',
    failed: 'This file couldn’t be opened for editing.',
    movedAway: 'This file was moved or deleted, so it can’t be opened here.',
    tryAgain: 'Try again',
    staleTitle: 'This file changed',
    staleText:
        'Someone saved a newer version while you were editing. Your changes aren’t saved yet.',
    goneTitle: 'This file was moved or deleted',
    goneText: 'Your changes aren’t saved yet. Save them as a new file to keep them.',
    onTop: 'Save on top',
    copy: 'Save as a copy',
    theirs: 'Open theirs',
    cancel: 'Cancel',
    theirsTitle: 'Discard your changes?',
    theirsText: 'The newer version opens instead, and your changes are lost.',
    discard: 'Discard changes',
    theirsGone: 'This file is no longer there.',
    finishing: 'Finishing your save, then closing',
};

const lightDark = (light: string, dark: string) => `light-dark(${light}, ${dark})`;

/* The viewer's colours (Shiki's GitHub themes), so code looks the same open and in the editor. */
const highlight = HighlightStyle.define([
    {
        tag: [tags.keyword, tags.modifier, tags.operatorKeyword],
        color: lightDark('#cf222e', '#ff7b72'),
    },
    {
        tag: [tags.string, tags.special(tags.string), tags.regexp],
        color: lightDark('#0a3069', '#a5d6ff'),
    },
    { tag: [tags.comment, tags.meta], color: lightDark('#6e7781', '#8b949e'), fontStyle: 'italic' },
    {
        tag: [tags.number, tags.bool, tags.null, tags.atom, tags.constant(tags.name)],
        color: lightDark('#0550ae', '#79c0ff'),
    },
    {
        tag: [tags.function(tags.variableName), tags.function(tags.propertyName), tags.macroName],
        color: lightDark('#8250df', '#d2a8ff'),
    },
    {
        tag: [tags.typeName, tags.className, tags.namespace],
        color: lightDark('#953800', '#ffa657'),
    },
    { tag: [tags.tagName], color: lightDark('#116329', '#7ee787') },
    { tag: [tags.attributeName, tags.propertyName], color: lightDark('#0550ae', '#79c0ff') },
    { tag: tags.heading, fontWeight: 'bold', color: lightDark('#0550ae', '#79c0ff') },
    { tag: tags.emphasis, fontStyle: 'italic' },
    { tag: tags.strong, fontWeight: 'bold' },
    { tag: [tags.link, tags.url], textDecoration: 'underline' },
    { tag: tags.invalid, color: lightDark('#82071e', '#ffa198') },
    { tag: [tags.inserted], color: lightDark('#116329', '#7ee787') },
    { tag: [tags.deleted], color: lightDark('#82071e', '#ffa198') },
]);

/* The app's tokens, so the editor follows light, dark and high contrast as the page does. */
const theme = EditorView.theme({
    '&': {
        height: '100%',
        backgroundColor: 'var(--background)',
        color: 'var(--foreground)',
        fontSize: '13px',
    },
    '&.cm-focused': { outline: 'none' },
    '.cm-scroller': { fontFamily: 'var(--font-mono)', lineHeight: '1.6' },
    '.cm-content': { caretColor: 'var(--foreground)', paddingBlock: '12px' },
    '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--foreground)' },
    '.cm-gutters': {
        backgroundColor: 'var(--background)',
        color: 'var(--muted-foreground)',
        border: 'none',
    },
    '.cm-lineNumbers .cm-gutterElement': { paddingInline: '16px 12px' },
    '.cm-activeLine': { backgroundColor: 'var(--hover)' },
    '.cm-activeLineGutter': { backgroundColor: 'var(--hover)', color: 'var(--foreground)' },
    '.cm-selectionBackground, &.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground':
        { backgroundColor: 'color-mix(in oklch, var(--primary), transparent 72%)' },
    '.cm-selectionMatch': { backgroundColor: 'var(--highlight)' },
    '.cm-searchMatch': {
        backgroundColor: 'color-mix(in oklch, var(--warning), transparent 65%)',
        outline: '1px solid color-mix(in oklch, var(--warning), transparent 30%)',
    },
    '.cm-searchMatch.cm-searchMatch-selected': {
        backgroundColor: 'color-mix(in oklch, var(--primary), transparent 60%)',
    },
    '&.cm-focused .cm-matchingBracket': { backgroundColor: 'var(--highlight)' },
    '.cm-panels': {
        backgroundColor: 'var(--card)',
        color: 'var(--foreground)',
        fontFamily: 'var(--font-sans)',
    },
    '.cm-panels.cm-panels-top': { borderBottom: '1px solid var(--rule)' },
    '.cm-panel.cm-search': { padding: '8px 12px', fontSize: '13px' },
    '.cm-panel.cm-search input, .cm-panel.cm-search button': { fontSize: '13px' },
    '.cm-textfield': {
        backgroundColor: 'var(--background)',
        color: 'var(--foreground)',
        border: '1px solid var(--input)',
        borderRadius: '6px',
        padding: '4px 8px',
    },
    '.cm-button': {
        backgroundImage: 'none',
        backgroundColor: 'var(--card)',
        color: 'var(--foreground)',
        border: '1px solid var(--input)',
        borderRadius: '6px',
        padding: '4px 10px',
    },
    '.cm-specialChar': { color: 'var(--destructive)' },
});

/* Whether the editor takes changes. */
const fixed = (editable: boolean) => [
    EditorState.readOnly.of(!editable),
    EditorView.editable.of(editable),
];

/* Everything but the language, wrapping and whether it may be changed. */
function baseExtensions(): Extension[] {
    return [
        lineNumbers(),
        highlightActiveLineGutter(),
        highlightSpecialChars(),
        history(),
        drawSelection(),
        dropCursor(),
        EditorState.allowMultipleSelections.of(true),
        indentOnInput(),
        syntaxHighlighting(highlight),
        bracketMatching(),
        rectangularSelection(),
        crosshairCursor(),
        highlightActiveLine(),
        highlightSelectionMatches(),
        search({ top: true }),
        // Tab stays the page's (focus moves on), so the keyboard never gets stuck in the editor.
        keymap.of([...defaultKeymap, ...searchKeymap, ...historyKeymap]),
        theme,
    ];
}

/*
 * The file's folder and the file as the server lists them now, asked for in the file's own folder
 * and workspace and held to them (editTargetOf): the save path looks the file up there again
 * before sealing, and a listing answering for another folder is refused.
 */
async function targetOf(queryClient: QueryClient, file: DriveNode) {
    const listing = await queryClient.fetchQuery({
        ...folderQueryOptions(file.parentId!, file.workspaceId),
        staleTime: 0,
    });
    return { ...editTargetOf(listing, file), children: listing.children };
}

/* Lock or sign-out: no account unlocked here, or this browser's session ending. Nothing waits on changes then. */
const sessionEnding = () => unlockedNow() === null || !deviceSession.open();

/* What went wrong with a save, in the save path's own words where it has them. */
function saveFailure(error: unknown) {
    if (error instanceof RunStopped || error instanceof SaveRefused) return error.message;
    return driveError(error);
}

/* Large text isn't checked as it changes: parsing megabytes of YAML on every pause would stall typing. */
const CHECK_LIMIT = 2 * 1024 * 1024;

export function TextEditor({
    node,
    actions,
    guard,
    askDiscard,
    onTarget,
    onDirty,
    onLeave,
    onFinishing,
}: {
    /* The file as the viewer listed it when Edit was pressed. */
    node: DriveNode;
    /* Where Save and its status go: the viewer's header. */
    actions: HTMLElement | null;
    /* Set by the viewer once the person chose to discard: nothing asks again on the way out. */
    guard: GuardRef;
    /* The viewer's "Discard your changes?": true to discard. */
    askDiscard: () => Promise<boolean>;
    /* The file being written changed (Save as a copy, Open theirs): the header names it. */
    onTarget: (file: DriveNode) => void;
    onDirty: (dirty: boolean) => void;
    /* A move away was let through (nothing unsaved, or it was discarded): the session ends. */
    onLeave: () => void;
    /* How the viewer's Close waits on a save on its way (EditGuard.finishing). */
    onFinishing: (wait: () => Promise<boolean> | null) => void;
}) {
    const queryClient = useQueryClient();
    const leaving = useRef(onLeave);
    const mounted = useRef(true);
    useEffect(() => {
        mounted.current = true;
        return () => {
            mounted.current = false;
        };
    }, []);
    /* Which opened text is on screen: moved on by Open theirs, so no earlier work publishes over it. */
    const opening = useRef(0);
    /* Open theirs looking up their version: nothing is typed or saved meanwhile. */
    const [reloading, setReloading] = useState(false);
    useEffect(() => {
        leaving.current = onLeave;
    });
    const [phase, setPhase] = useState<Phase>({ kind: 'loading', progress: null });
    const [loadFrom, setLoadFrom] = useState(node);
    const [attempt, setAttempt] = useState(0);
    const target = useRef<EditTarget>(openedTarget(node));
    const host = useRef<HTMLDivElement>(null);
    const view = useRef<EditorView | null>(null);
    /* Whether the text may be changed: off for a read-only file, and once a copy's file can't be told. */
    const editability = useRef(new Compartment());
    const saved = useRef<Text | null>(null);
    const [dirty, setDirty] = useState(false);
    const dirtyNow = useRef(false);
    const endedNow = useRef(false);
    const [saving, setSaving] = useState(false);
    const savingNow = useRef(false);
    const reloadingNow = useRef(false);
    /* The save or copy on its way, settled with whether it landed; a close waits on it. */
    const pending = useRef<{ done: Promise<boolean>; settle: (landed: boolean) => void } | null>(
        null,
    );
    /* A close is waiting on the save on its way: the editor says so. */
    const [finishing, setFinishing] = useState(false);
    const [status, setStatus] = useState<string | null>(null);
    const [failure, setFailure] = useState<string | null>(null);
    const [warning, setWarning] = useState<string | null>(null);
    const [edits, setEdits] = useState(0);
    const [stale, setStale] = useState<{ currentVersionId: string | null } | null>(null);
    const staleNow = useRef(false);
    useEffect(() => {
        savingNow.current = saving;
        staleNow.current = stale !== null;
        reloadingNow.current = reloading;
    }, [saving, stale, reloading]);
    const [confirmTheirs, setConfirmTheirs] = useState(false);
    /* Saved as a copy whose file can't be told: the session is over, nothing more is saved. */
    const [ended, setEnded] = useState(false);
    const language = editorLanguage(loadFrom.name);
    const checks = structuredKind(language);

    const markDirty = useCallback(
        (value: boolean) => {
            if (dirtyNow.current === value) return;
            dirtyNow.current = value;
            setDirty(value);
            onDirty(value);
        },
        [onDirty],
    );

    // Read the version afresh: the bytes saved later are these, edited. Whoever asks for a
    // read (Try again, Open theirs) shows the opening ring first; this only publishes.
    useEffect(() => {
        let active = true;
        let reader: FileReader | null = null;
        // Read for this account session only: a lock, a sign-out or another sign-in meanwhile shows nothing.
        const account = deviceSession.generation();
        const still = () => active && deviceSession.generation() === account;
        void (async () => {
            // The file as the server lists it now: a listing on screen can be a version behind
            // (another device's save the feed hasn't brought yet), and editing that one would end
            // in the stale choices at once.
            const listed = await targetOf(queryClient, loadFrom).catch(() => null);
            if (!still()) return;
            // Never the row the viewer held: it may be a version behind (or no longer where it was). No
            // answer: Try again; no such file in its folder any more: it was moved or deleted.
            if (!listed?.file) {
                setPhase({
                    kind: 'failed',
                    message: listed ? editorWords.movedAway : editorWords.failed,
                });
                return;
            }
            const file = listed.file;
            if (file !== loadFrom) onTarget(file);
            const size = nodeSize(file);
            if (size !== null && size > TEXT_EDIT_LIMIT) {
                setPhase({ kind: 'read-only', reason: 'too-large', text: null });
                return;
            }
            try {
                reader = openReader(file, true);
                // One byte past the limit is enough to know it's too large.
                const { bytes } = await readAll(
                    reader,
                    TEXT_EDIT_LIMIT + 1,
                    (progress) => still() && setPhase({ kind: 'loading', progress }),
                );
                if (!still()) return;
                const text = openText(bytes);
                target.current = openedTarget(file);
                setPhase(
                    text.editable
                        ? { kind: 'editing', text: text.text }
                        : { kind: 'read-only', reason: text.reason, text: text.text },
                );
            } catch {
                if (still()) setPhase({ kind: 'failed', message: editorWords.failed });
            }
        })();
        return () => {
            active = false;
            void reader?.close();
        };
    }, [loadFrom, attempt, queryClient, onTarget]);

    // The editor itself, once there is text to show.
    const shown = phase.kind === 'editing' || phase.kind === 'read-only' ? phase : null;
    const shownText = shown?.text ?? null;
    const editable = shown?.kind === 'editing';
    useEffect(() => {
        const parent = host.current;
        if (!parent || shownText === null) return;
        let active = true;
        const languageSlot = new Compartment();
        const made = new EditorView({
            parent,
            state: EditorState.create({
                doc: shownText,
                extensions: [
                    baseExtensions(),
                    languageSlot.of([]),
                    editability.current.of(fixed(editable)),
                    wrapsLines(language) ? EditorView.lineWrapping : [],
                    EditorView.contentAttributes.of({
                        'aria-label': `Contents of ${loadFrom.name}`,
                        spellcheck: 'false',
                        autocorrect: 'off',
                        autocapitalize: 'off',
                    }),
                    EditorView.updateListener.of((update) => {
                        if (!update.docChanged || !saved.current) return;
                        markDirty(!update.state.doc.eq(saved.current));
                        setEdits((count) => count + 1);
                    }),
                ],
            }),
        });
        view.current = made;
        saved.current = made.state.doc;
        markDirty(false);
        setEdits((count) => count + 1);
        // The language comes in after the text shows, then colours it.
        void loadLanguage(language).then((extension) => {
            if (active) made.dispatch({ effects: languageSlot.reconfigure(extension) });
        });
        if (editable) made.focus();
        return () => {
            active = false;
            made.destroy();
            if (view.current === made) view.current = null;
            saved.current = null;
        };
    }, [shownText, editable, language, loadFrom.name, markDirty]);

    // The structured-text check, a moment after typing stops. It never stops a save.
    useEffect(() => {
        const current = view.current;
        if (!checks || !current || !editable) return;
        const timer = window.setTimeout(() => {
            const doc = current.state.doc;
            if (doc.length > CHECK_LIMIT) {
                setWarning(null);
                return;
            }
            void parseFailure(checks, doc.toString()).then((failed) => {
                if (view.current !== current) return;
                setWarning(failed ? parseWarning(checks, failed.line) : null);
            });
        }, 500);
        return () => window.clearTimeout(timer);
    }, [edits, checks, editable]);

    // Leaving the page with changes asks first; a lock or a sign-out (no account unlocked) never waits on it.
    useEffect(
        () => holdPageWhile(() => dirtyNow.current && !guard.current.discarded && !sessionEnding()),
        [guard],
    );
    /* A save or a copy begins: nothing else saves, and a close waits on it from here. */
    const beginSaving = useCallback(() => {
        let settle: (landed: boolean) => void = () => {};
        const done = new Promise<boolean>((resolve) => {
            settle = resolve;
        });
        pending.current = { done, settle };
        savingNow.current = true;
        setSaving(true);
    }, []);
    /* It settled: `landed`, whether it published (a close then goes on; otherwise the editor stays). */
    const endSaving = useCallback((landed: boolean) => {
        const was = pending.current;
        pending.current = null;
        savingNow.current = false;
        if (mounted.current) setSaving(false);
        was?.settle(landed);
    }, []);
    /* A close while a save is on its way: never Discard (it may still publish); it waits, and says so. */
    const waitForSave = useCallback(() => {
        const was = pending.current;
        if (!was) return null;
        setFinishing(true);
        return was.done.finally(() => {
            if (mounted.current) setFinishing(false);
        });
    }, []);
    useEffect(() => {
        onFinishing(waitForSave);
    }, [onFinishing, waitForSave]);

    // So does a move within the app (Back, a link), wherever it leads; a lock or a sign-out never waits.
    const blocker = useBlocker({
        // Wherever it goes (a public page included); only a lock or a sign-out isn't held up. Decided
        // at once, so the router holds the move (Back included) until the person answers below.
        // A move let through ends the session: Back that drops the viewer's address closes it.
        shouldBlockFn: () => {
            if (
                (!dirtyNow.current && !savingNow.current) ||
                guard.current.discarded ||
                sessionEnding()
            ) {
                leaving.current();
                return false;
            }
            return true;
        },
        withResolver: true,
        enableBeforeUnload: false,
    });
    const blocked = blocker.status === 'blocked';
    const answer = useRef(blocker);
    useEffect(() => {
        answer.current = blocker;
    });
    useEffect(() => {
        if (!blocked) return;
        // Answered even once this editor is gone: discarding unmounts it before the answer lands, and
        // the held move must still go on (or be put back).
        const held = answer.current;
        void (async () => {
            // A save on its way may still publish: never Discard then. The move waits for it, goes on
            // once it landed (asking first if typed meanwhile), and is put back if it didn't.
            const finishing = waitForSave();
            if (finishing) {
                const landed = await finishing;
                if (held.status !== 'blocked') return;
                if (!landed) return held.reset();
                if (!dirtyNow.current) {
                    leaving.current();
                    return held.proceed();
                }
            }
            const discard = await askDiscard();
            if (held.status !== 'blocked') return;
            if (discard) held.proceed();
            else held.reset();
        })();
    }, [blocked, askDiscard, waitForSave]);

    const start: StartRun = useCallback((plan) => startSaveRun(queryClient, plan), [queryClient]);

    /*
     * The editor session a piece of work began in: this editor still mounted and not discarded, the
     * same account session (no lock, no sign-out, no other sign-in since), and the same opened text
     * (Open theirs starts another). Every save, copy and Open theirs takes one before its first wait
     * and asks it right before a run starts and before anything it found reaches the screen.
     */
    const token = useCallback(
        (): SessionToken => ({ opening: opening.current, account: deviceSession.generation() }),
        [],
    );
    const live = useCallback(
        (taken: SessionToken) =>
            mounted.current &&
            !guard.current.discarded &&
            !sessionEnding() &&
            deviceSession.generation() === taken.account &&
            opening.current === taken.opening,
        [guard],
    );

    /* After a save landed: the editor's text is the file's now, from that version on. */
    const settled = useCallback(
        (doc: Text, file: DriveNode, versionId: string | null) => {
            // The version this save published, never one read from a listing afterwards (which may
            // already be someone else's). Unknown, the next save asks the stale question. A copy
            // is still signed from the version the text was read from, never this row.
            target.current = savedTarget(target.current, file, versionId);
            saved.current = doc;
            markDirty(!(view.current?.state.doc.eq(doc) ?? true));
            void invalidateFolders(queryClient, file.parentId);
        },
        [queryClient, markDirty],
    );

    const save = useCallback(
        async (onTopOf?: string) => {
            const current = view.current;
            if (!current || saving || savingNow.current || !editable || ended || reloading) return;
            const taken = token();
            const doc = current.state.doc;
            const { file, startedFrom } = target.current;
            let landed = false;
            beginSaving();
            setStatus(null);
            setFailure(null);
            try {
                const listing = await targetOf(queryClient, file);
                if (!live(taken)) return;
                // The file as listed now (its current version, its key): the save path holds the
                // version it replaces to the one this text started from, or Save on top's.
                const listed = listing.file;
                if (!listed) {
                    setStale({ currentVersionId: null });
                    return;
                }
                const result = await saveVersion(
                    start,
                    {
                        file: listed,
                        folder: listing.folder,
                        startedFrom: onTopOf ?? startedFrom,
                        text: doc.toString(),
                    },
                    { stillOn: () => live(taken) },
                );
                if (!live(taken)) return;
                if (result.status === 'stale') {
                    setStale({ currentVersionId: result.currentVersionId });
                    return;
                }
                settled(doc, listed, result.versionId);
                landed = true;
                setStatus(editorWords.saved);
            } catch (error) {
                if (!live(taken)) return;
                if (error instanceof SaveRefused && error.reason === 'no-room' && error.room)
                    openStorageFull();
                setFailure(saveFailure(error));
            } finally {
                endSaving(landed);
            }
        },
        [
            saving,
            editable,
            ended,
            reloading,
            queryClient,
            start,
            settled,
            token,
            live,
            beginSaving,
            endSaving,
        ],
    );

    const copy = useCallback(async () => {
        const current = view.current;
        if (!current || reloading || savingNow.current) return;
        const taken = token();
        const doc = current.state.doc;
        const { file, source } = target.current;
        let landed = false;
        beginSaving();
        setStatus(null);
        setFailure(null);
        try {
            const listing = await targetOf(queryClient, file);
            if (!live(taken)) return;
            const made = await saveCopy(
                start,
                { file, source, folder: listing.folder, text: doc.toString() },
                { stillOn: () => live(taken) },
            );
            if (!live(taken)) return;
            // From here on the editor writes the copy: the file someone else saved is left as theirs.
            // The copy is the run's own (its id, and the version its upload minted, never the reply
            // row's); a listing only supplies its row, in the same folder and workspace, asked twice.
            const locate = async () =>
                (await targetOf(queryClient, file).catch(() => null))?.children.find(
                    (child) =>
                        child.id === made.node?.id &&
                        child.workspaceId === listing.folder.workspaceId &&
                        child.parentId === listing.folder.id,
                );
            const listed = made.node ? ((await locate()) ?? (await locate())) : undefined;
            if (!live(taken)) return;
            // Published either way: a close waiting on it goes on (asking first if typed meanwhile).
            landed = true;
            if (made.node && listed) {
                settled(doc, listed, made.versionId);
                onTarget(listed);
                setStatus(editorWords.savedCopy(listed.name));
            } else {
                // Saved, but which file it became can't be told: nothing more is saved from here
                // (never into the file someone else saved). The text stays, read-only, to copy from;
                // what was typed while it saved isn't in the copy, so leaving still asks.
                setEnded(true);
                endedNow.current = true;
                current.dispatch({ effects: editability.current.reconfigure(fixed(false)) });
                saved.current = doc;
                const later = !current.state.doc.eq(doc);
                markDirty(later);
                setStatus(later ? editorWords.savedCopyEndedLater : editorWords.savedCopyEnded);
            }
        } catch (error) {
            if (!live(taken)) return;
            if (error instanceof SaveRefused && error.reason === 'no-room' && error.room)
                openStorageFull();
            setFailure(saveFailure(error));
        } finally {
            endSaving(landed);
        }
    }, [
        queryClient,
        start,
        settled,
        onTarget,
        markDirty,
        reloading,
        token,
        live,
        beginSaving,
        endSaving,
    ]);

    /* Their version, as listed now, opened in place of this text. */
    const openTheirs = useCallback(async () => {
        const current = view.current;
        const { file } = target.current;
        setStatus(null);
        setFailure(null);
        // From here this text is on its way out: nothing typed or saved meanwhile (it would be lost).
        setReloading(true);
        current?.dispatch({ effects: editability.current.reconfigure(fixed(false)) });
        const taken = token();
        const listed = (await targetOf(queryClient, file).catch(() => null))?.file;
        if (!live(taken)) return;
        setReloading(false);
        if (!listed) {
            // Nothing opened in its place: the text is the person's to edit again.
            current?.dispatch({
                effects: editability.current.reconfigure(fixed(!endedNow.current)),
            });
            setFailure(editorWords.theirsGone);
            return;
        }
        // A new opened text: any earlier work still on its way publishes nothing over it.
        opening.current += 1;
        markDirty(false);
        onTarget(listed);
        setPhase({ kind: 'loading', progress: null });
        setLoadFrom(listed);
    }, [queryClient, onTarget, markDirty, token, live]);

    // Always the editor's while it is open (the browser's Save Page never opens over it); it saves
    // only when there are changes and nothing else is under way.
    useHotkey(
        'Mod+S',
        () => {
            if (
                editable &&
                dirtyNow.current &&
                !endedNow.current &&
                !savingNow.current &&
                !staleNow.current &&
                !reloadingNow.current
            )
                void save();
        },
        { preventDefault: true },
    );

    const format = useFormatForDisplay();
    const savable = editable && dirty && !saving && !ended && !reloading;
    const header = actions
        ? createPortal(
              <div className="flex min-w-0 items-center gap-3">
                  {warning && (
                      <output className="flex min-w-0 items-center gap-1.5 text-[13px] text-warning max-sm:hidden">
                          <TriangleAlertIcon className="size-3.5 shrink-0" />
                          <span className="truncate">{warning}</span>
                      </output>
                  )}
                  {finishing ? (
                      <output className="truncate text-[13px] text-muted-foreground">
                          {editorWords.finishing}
                      </output>
                  ) : failure ? (
                      <span
                          role="alert"
                          className="min-w-0 truncate text-[13px] text-destructive"
                          title={failure}
                      >
                          {failure}
                      </span>
                  ) : (
                      status &&
                      // The end of a copy that can't be located says so while there are changes too.
                      (!dirty || ended) && (
                          <output className="truncate text-[13px] text-muted-foreground">
                              {status}
                          </output>
                      )
                  )}
                  {editable && (
                      <Button
                          disabled={!savable}
                          onClick={() => void save()}
                          title={`${editorWords.save} (${format('Mod+S')})`}
                      >
                          {saving ? <Spinner /> : <SaveIcon />}
                          {saving ? editorWords.saving : editorWords.save}
                      </Button>
                  )}
              </div>,
              actions,
          )
        : null;

    let body;
    if (phase.kind === 'loading') body = <Opening name={loadFrom.name} progress={phase.progress} />;
    else if (phase.kind === 'failed')
        body = (
            <Notice title={phase.message}>
                <Button
                    variant="outline"
                    onClick={() => {
                        setPhase({ kind: 'loading', progress: null });
                        setAttempt((count) => count + 1);
                    }}
                >
                    {editorWords.tryAgain}
                </Button>
            </Notice>
        );
    else if (phase.kind === 'read-only' && phase.text === null)
        body = <Notice title={READ_ONLY_WORDS[phase.reason]} />;
    else
        body = (
            <div className="flex min-h-0 flex-1 flex-col">
                {phase.kind === 'read-only' && (
                    <p className="shrink-0 border-b border-rule bg-accent px-5 py-2.5 text-sm text-accent-foreground">
                        {READ_ONLY_WORDS[phase.reason]}
                    </p>
                )}
                {warning && (
                    // On a phone the header has no room for it: said here instead, and read out the same way.
                    <output className="flex shrink-0 items-center gap-1.5 border-b border-rule px-5 py-2 text-[13px] text-warning sm:hidden">
                        <TriangleAlertIcon aria-hidden="true" className="size-3.5 shrink-0" />
                        {warning}
                    </output>
                )}
                <div ref={host} data-text-editor className="min-h-0 flex-1 overflow-hidden" />
            </div>
        );

    const gone = stale !== null && stale.currentVersionId === null;
    return (
        <>
            {header}
            {body}
            <AlertDialog
                open={stale !== null && !confirmTheirs}
                onOpenChange={(open) => !open && setStale(null)}
            >
                <AlertDialogContent>
                    <AlertDialogHeader>
                        <AlertDialogTitle>
                            {gone ? editorWords.goneTitle : editorWords.staleTitle}
                        </AlertDialogTitle>
                        <AlertDialogDescription>
                            {gone ? editorWords.goneText : editorWords.staleText}
                        </AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter className="sm:flex-wrap">
                        <AlertDialogCancel>{editorWords.cancel}</AlertDialogCancel>
                        {!gone && (
                            <Button variant="outline" onClick={() => setConfirmTheirs(true)}>
                                {editorWords.theirs}
                            </Button>
                        )}
                        <Button
                            variant={gone ? 'default' : 'outline'}
                            onClick={() => {
                                setStale(null);
                                void copy();
                            }}
                        >
                            {editorWords.copy}
                        </Button>
                        {!gone && (
                            <Button
                                onClick={() => {
                                    const onTop = stale?.currentVersionId ?? undefined;
                                    setStale(null);
                                    void save(onTop);
                                }}
                            >
                                {editorWords.onTop}
                            </Button>
                        )}
                    </AlertDialogFooter>
                </AlertDialogContent>
            </AlertDialog>
            <AlertDialog
                open={confirmTheirs}
                onOpenChange={(open) => {
                    if (open) return;
                    // Back to the three choices: nothing was discarded.
                    setConfirmTheirs(false);
                }}
            >
                <AlertDialogContent>
                    <AlertDialogHeader>
                        <AlertDialogTitle>{editorWords.theirsTitle}</AlertDialogTitle>
                        <AlertDialogDescription>{editorWords.theirsText}</AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                        <AlertDialogCancel>{editorWords.cancel}</AlertDialogCancel>
                        <Button
                            variant="destructive"
                            onClick={() => {
                                setConfirmTheirs(false);
                                setStale(null);
                                void openTheirs();
                            }}
                        >
                            {editorWords.discard}
                        </Button>
                    </AlertDialogFooter>
                </AlertDialogContent>
            </AlertDialog>
        </>
    );
}
