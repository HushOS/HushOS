import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import {
    bracketMatching,
    HighlightStyle,
    indentOnInput,
    syntaxHighlighting,
} from '@codemirror/language';
import { highlightSelectionMatches, search, searchKeymap } from '@codemirror/search';
import {
    Compartment,
    EditorSelection,
    EditorState,
    type Extension,
    type Text,
} from '@codemirror/state';
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
import { type Draft, type DraftPlace, draftOffer } from '@hushos/crypto/drafts';
import type { DriveNode } from '@hushos/drive/client';
import type { FileReader } from '@hushos/drive/downloads';
import { tags } from '@lezer/highlight';
import { useFormatForDisplay, useHotkey } from '@tanstack/react-hotkeys';
import { useQueryClient, type QueryClient } from '@tanstack/react-query';
import { useBlocker } from '@tanstack/react-router';
import { SaveIcon, TriangleAlertIcon } from 'lucide-react';
import {
    Component,
    lazy,
    Suspense,
    useCallback,
    useEffect,
    useLayoutEffect,
    useRef,
    useState,
    type ReactNode,
} from 'react';
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
import { useIsDesktop } from '@/hooks/use-mobile';
import { segmentOn, segmentTrack } from '@/components/ui/segment';
import { unlockedNow } from '@/lib/auth-view';
import { deviceSession } from '@/lib/device-session';
import {
    clientFor,
    driveError,
    folderQueryOptions,
    invalidateFolders,
    nodeSize,
} from '@/lib/drive';
import { flushBeforeLock } from '@/lib/draft-flush';
import {
    createDraftWriter,
    drafts,
    draftWhen,
    type DraftSnapshot,
    type DraftWriter,
} from '@/lib/drafts';
import { allLanguages, editorLanguage, loadLanguage, wrapsLines } from '@/lib/editor-languages';
import { frameThrottle, type FrameThrottle } from '@/lib/frame-throttle';
import { holdPageWhile } from '@/lib/leave-guard';
import { MARKDOWN_LIMIT } from '@/lib/markdown-limit';
import { openReader, previewKindOf, readAll, type ReadProgress } from '@/lib/previews';
import { RunStopped, SaveRefused, startSaveRun } from '@/lib/save-runs';
import {
    type Block,
    lineForOffset,
    measureBlocks,
    offsetForLine,
    ScrollLink,
    type ScrollPane,
    type Side,
} from '@/lib/scroll-sync';
import {
    mixedNote,
    openText,
    READ_ONLY_WORDS,
    saveBytes,
    savedState,
    TEXT_EDIT_LIMIT,
    utf8Length,
    writable,
    type ReadOnlyReason,
    type SaveState,
    type TextFormat,
} from '@/lib/text-edit';
import { startCheck, type Check } from '@/lib/text-check';
import { parseWarning, preloadParsers, structuredKindOf } from '@/lib/text-parse';
import {
    editTargetOf,
    openedTarget,
    saveCopy,
    savedTarget,
    saveVersion,
    type EditTarget,
    type StartRun,
} from '@/lib/text-save';
import { cn } from '@/lib/utils';

/* The viewer's Markdown renderer, for the preview beside the source: one of the editor's assets (editorAssets). */
const EditorPreview = lazy(() =>
    import('@/components/drive/editor-preview').then((m) => ({ default: m.EditorPreview })),
);

/*
 * The text editor (docs/editing-design.md section 1; Editing 1a and 1b): CodeMirror over the
 * file's current version, read again from the server, never the viewer's copy. Saving is
 * explicit (Save, Ctrl or Cmd+S), a new version through the save path, with the stale
 * choices when someone else saved first. A save writes the file's own encoding, byte order mark
 * and line breaks (saveBytes); a file it can't save byte for byte opens read-only with a note.
 * Markdown shows the viewer's rendering beside the source on a wide screen, following typing and
 * scrolling with it both ways, and Source or Preview on a narrow one. Its text lives in this
 * component: a lock or a sign-out unmounts the drive and the text goes with it. What was typed and
 * not saved is kept as a draft (Editing 1c, lib/drafts.ts): sealed on this device a couple of
 * seconds after a change, and before a lock, so reopening the file after a closed tab, a crash or a
 * lock and unlock offers it back.
 *
 * Not in the post-unlock preload: the first Edit fetches the editor with every grammar, parser and
 * the preview's renderer (editorAssets), the same set whatever the file, so which chunks a device
 * fetched says only that someone edits, never what kind of file.
 */

/*
 * The session's way out, shared with the viewer. `discarded`: the person chose to discard, so
 * nothing asks again. `finishing`: while a save or a copy is on its way (it may still publish), a
 * close waits on it instead of offering Discard: the promise says whether it landed, and the
 * editor says it is finishing meanwhile; null when nothing is on its way. `deciding`: "Discard
 * your changes?" is open: nothing starts a save until it is answered (Keep editing).
 */
export type EditGuard = {
    discarded: boolean;
    deciding?: boolean;
    finishing?: () => Promise<boolean> | null;
};
type SessionToken = { opening: number; account: number };

type GuardRef = { readonly current: EditGuard };

/*
 * Every grammar and parser, whatever file the editor opens: the first Edit fetches the whole set (in
 * one fixed order) while the editor says it is opening, never one that names the file's kind
 * (editing-design.md section 4). Already fetched, it costs nothing.
 */
function editorAssets() {
    return Promise.all([
        allLanguages(),
        preloadParsers(),
        // The Markdown preview's renderer too, whatever kind of file is open. Its failure is the
        // preview's to show (PreviewBoundary), never a reason to leave the text uncoloured or unchecked.
        import('@/components/drive/editor-preview').catch(() => {}),
    ]).then(() => {});
}

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
    source: 'Source',
    preview: 'Preview',
    previewTooLong: 'This file is too long to preview while you edit.',
    previewFailed: 'The preview couldn’t be shown.',
    halfCharacter: 'This text has half of an emoji or symbol in it. Delete it, then save.',
    refreshPreview: 'Refresh preview',
    restoreOffer: (when: string) => `Restore your unsaved changes from ${when}`,
    restore: 'Restore',
    discardDraft: 'Discard',
    draftNotKept: 'Your unsaved changes couldn’t be kept on this device.',
};

/* A draft found when the file opened, waiting for Restore or Discard. */
type DraftOfferShown = {
    draft: Draft;
    kind: 'current' | 'stale';
    /* The version the file opened at: Save on top goes after it. */
    openedVersionId: string | null;
    place: DraftPlace;
};

/* Past this, a draft that hasn't been read is taken for none: a store that won't answer never holds up editing. */
const DRAFT_READ_MS = 2_000;

/* The file's draft, or null for none, one that couldn't be read in time, or a store that failed. */
async function readDraft(place: DraftPlace) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
        return await Promise.race([
            drafts().read(place),
            new Promise<null>((resolve) => {
                timer = setTimeout(() => resolve(null), DRAFT_READ_MS);
            }),
        ]);
    } catch {
        return null;
    } finally {
        clearTimeout(timer);
    }
}

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

/*
 * Whether the text is past what the Markdown renderer takes (MARKDOWN_LIMIT, in UTF-8 bytes), counted
 * only when its length can't already tell: UTF-8 never takes fewer bytes than UTF-16 units, nor more
 * than three for one.
 */
function tooLongToPreview(doc: Text) {
    if (doc.length > MARKDOWN_LIMIT) return true;
    if (doc.length * 3 <= MARKDOWN_LIMIT) return false;
    let bytes = 0;
    for (const lines = doc.iter(); !lines.next().done;) {
        bytes += utf8Length(lines.value);
        if (bytes > MARKDOWN_LIMIT) return true;
    }
    return false;
}

/*
 * The preview follows typing only up to this length: parsing and rendering Markdown runs on the main
 * thread on every frame that has a change. Measured on a fast laptop against a production build
 * (60 keys, one every 80 ms): at 32K characters 48 of them left a task of about 50 ms (three dropped
 * frames each); from 8K to 24K, at most one did (about half that per key at 16K). A phone or a slow
 * laptop takes a few times as long, so the bound is 16K. A longer text is rendered when the preview
 * comes into view, then again on Refresh preview.
 */
const PREVIEW_LIVE_LIMIT = 16 * 1024;

/*
 * The source as a scroll pane: a fractional line from CodeMirror's line blocks (a wrapped line is one
 * block), so a position inside a long paragraph maps inside its rendering.
 */
function sourcePane(view: EditorView): ScrollPane {
    const scroller = view.scrollDOM;
    /* Where the document's first line starts in the scroller's content. */
    const documentAt = () =>
        view.documentTop - scroller.getBoundingClientRect().top + scroller.scrollTop;
    return {
        scroller,
        lineAt: (top) => {
            const height = top - documentAt();
            if (height <= 0) return 1;
            const block = view.lineBlockAtHeight(height);
            const line = view.state.doc.lineAt(block.from).number;
            const within = block.height > 0 ? (height - block.top) / block.height : 0;
            return line + Math.min(Math.max(within, 0), 0.999);
        },
        topOf: (line) => {
            const doc = view.state.doc;
            const number = Math.min(Math.max(Math.floor(line), 1), doc.lines);
            const block = view.lineBlockAt(doc.line(number).from);
            const within = Math.min(Math.max(line - number, 0), 1);
            return documentAt() + block.top + within * block.height;
        },
    };
}

/*
 * The link between the source and the preview (lib/scroll-sync.ts), over the panes on screen when it is
 * asked: a hidden one (the narrow switch's other) has no layout to read. The preview's blocks are measured
 * once per rendering or change of size (`previewBlocks`, emptied then) and kept for every scroll between.
 */
function scrollLinkFor(refs: {
    source: { readonly current: EditorView | null };
    sourceHost: { readonly current: HTMLElement | null };
    preview: { readonly current: HTMLElement | null };
    previewBlocks: { current: Block[] | null };
}) {
    const shownNow = (element: HTMLElement | null) =>
        element !== null && element.getClientRects().length > 0;
    return new ScrollLink(() => {
        const panes: Partial<Record<Side, ScrollPane>> = {};
        const source = refs.source.current;
        if (source && shownNow(refs.sourceHost.current)) panes.source = sourcePane(source);
        const scroller = refs.preview.current;
        if (scroller && shownNow(scroller)) {
            const blocks = () => (refs.previewBlocks.current ??= measureBlocks(scroller));
            panes.preview = {
                scroller,
                lineAt: (top) => lineForOffset(blocks(), top),
                topOf: (line) => offsetForLine(blocks(), line),
            };
        }
        return panes;
    });
}

/*
 * The preview's own failure (its renderer's chunk didn't load, or the renderer threw) stays in the
 * preview: without this it would unmount the editor and lose the text. A new text tries again.
 */
class PreviewBoundary extends Component<
    { text: string; children: ReactNode },
    { text: string; failed: boolean }
> {
    state = { text: this.props.text, failed: false };
    static getDerivedStateFromProps(
        props: { text: string },
        state: { text: string; failed: boolean },
    ) {
        return props.text === state.text ? null : { text: props.text, failed: false };
    }
    static getDerivedStateFromError() {
        return { failed: true };
    }
    render() {
        if (!this.state.failed) return this.props.children;
        return (
            <p className="px-6 py-10 text-center text-sm text-muted-foreground">
                {editorWords.previewFailed}
            </p>
        );
    }
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
    onRead,
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
    /*
     * The version the text now is: read (with the row it was read from), or published by a save or a
     * copy. The viewer's marks speak for it (lib/editor-marks.ts).
     */
    onRead: (versionId: string | null, row?: DriveNode) => void;
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
    /* The editor on screen, for its scroll events: a new one comes with Open theirs. */
    const [sourceView, setSourceView] = useState<EditorView | null>(null);
    /* Whether the text may be changed: off for a read-only file, and once a copy's file can't be told. */
    const editability = useRef(new Compartment());
    const saved = useRef<Text | null>(null);
    /*
     * The session's saves (lib/text-edit.ts SaveState): the format found when the file opened, kept
     * whatever is saved since, and the text and bytes last opened or saved, so a text still as it
     * was writes those bytes again. Null while nothing editable is open.
     */
    const saveState = useRef<SaveState | null>(null);
    /* The open file's encoding and line breaks: a mixed file says which a save writes. */
    const [textFormat, setTextFormat] = useState<TextFormat | null>(null);
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
    /* The restore offer on screen, mirrored for the draft writer and the editor's editability. */
    const [offer, setOfferShown] = useState<DraftOfferShown | null>(null);
    const offerNow = useRef<DraftOfferShown | null>(null);
    const setOffer = useCallback((value: DraftOfferShown | null) => {
        offerNow.current = value;
        setOfferShown(value);
    }, []);
    /* A draft is looked for once, at the first open: never again after Open theirs. */
    const draftAsked = useRef(false);
    /* The account session this editor opened under: no draft is written for another. */
    const openedUnder = useRef(deviceSession.generation());
    /* The last draft couldn't be kept (quota, past the limit): said in one quiet line. */
    const [draftNotKept, setDraftNotKept] = useState(false);
    const writer = useRef<DraftWriter | null>(null);
    /* Whether the editor on screen takes changes (a read-only file's never writes a draft). */
    const editableNow = useRef(false);
    const language = editorLanguage(loadFrom.name);
    /*
     * Markdown shows the viewer's rendering beside the source (Source or Preview on a narrow screen),
     * decided by the row the text was read from (it may be newer than the one Edit was pressed on).
     */
    const [markdown, setMarkdown] = useState(false);
    const [pane, setPane] = useState<'source' | 'preview'>('source');
    /*
     * What the preview shows: the text it rendered (null: too long to render), and whether the editor
     * has changed since while too long to follow typing (Refresh preview renders it again).
     */
    const [preview, setPreview] = useState<{ text: string | null; stale: boolean } | null>(null);
    /* Rendered only while it can be seen: beside the source on a wide screen, or chosen on a narrow one. */
    const wide = useIsDesktop();
    const previewShown = markdown && (wide || pane === 'preview');
    // By the name's language, or the recorded type when the name gives none (an extensionless JSON file).
    const checks = structuredKindOf(language, loadFrom.metadata?.mime);

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
        // The editor's whole fixed set, fetched beside the read: the text shows once both are here.
        const assets = editorAssets();
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
                await assets;
                if (!still()) return;
                const text = openText(bytes);
                // The first open only: a draft of this file from an earlier session (a closed tab, a
                // crash, a lock), offered before the text can be changed, never once Open theirs reloads.
                let found: DraftOfferShown | null = null;
                const account = unlockedNow();
                if (text.editable && !draftAsked.current && account) {
                    draftAsked.current = true;
                    const place = {
                        userId: account,
                        workspaceId: file.workspaceId,
                        nodeId: file.id,
                    };
                    const draft = await readDraft(place);
                    if (!still()) return;
                    if (draft) {
                        const versionId = file.currentVersion?.id ?? null;
                        const kind = draftOffer(
                            { baseVersionId: draft.frame.baseVersionId, text: draft.text },
                            { versionId, text: text.text },
                        );
                        // The file already holds that text: nothing to offer, and the draft is spent.
                        if (kind === 'same')
                            void drafts()
                                .remove(place)
                                .catch(() => {});
                        else found = { draft, kind, openedVersionId: versionId, place };
                    }
                }
                target.current = openedTarget(file);
                // A copy of its own: what a save writes unchanged is exactly these bytes, nothing around them.
                saveState.current = text.editable
                    ? { format: text.format, text: text.text, bytes: bytes.slice() }
                    : null;
                setTextFormat(text.editable ? text.format : null);
                setMarkdown(previewKindOf(file.name, file.metadata?.mime) === 'markdown');
                onRead(file.currentVersion?.id ?? null, file);
                if (found) setOffer(found);
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
    }, [loadFrom, attempt, queryClient, onTarget, onRead, setOffer]);

    /* Read when the editor closes: the offer still up, and whether the person chose to leave. */
    const offerShown = useCallback(() => offerNow.current !== null, []);
    const discardedNow = useCallback(() => guard.current.discarded, [guard]);
    /* Where the file being written keeps its draft, for the account unlocked now. */
    const placeNow = useCallback((): DraftPlace | null => {
        const userId = unlockedNow();
        const { file } = target.current;
        return userId ? { userId, workspaceId: file.workspaceId, nodeId: file.id } : null;
    }, []);
    /*
     * The text as it is now, for the draft writer, or null when nothing may be written: no editable
     * text on screen, the offer still unanswered, a copy whose file can't be told, Open theirs under
     * way, or no version the text started from.
     */
    const draftSnapshot = useCallback((): DraftSnapshot | null => {
        const current = view.current;
        const baseline = saved.current;
        const state = saveState.current;
        const { startedFrom } = target.current;
        const place = placeNow();
        if (
            !current ||
            !baseline ||
            !state ||
            !startedFrom ||
            !place ||
            !editableNow.current ||
            offerNow.current ||
            endedNow.current ||
            reloadingNow.current
        )
            return null;
        const doc = current.state.doc;
        const { anchor, head } = current.state.selection.main;
        return {
            place,
            atBaseline: doc.eq(baseline),
            draft: () => {
                const text = doc.toString();
                if (!writable(text)) return null;
                return {
                    frame: {
                        baseVersionId: startedFrom,
                        encoding: state.format.encoding,
                        lineEnding: state.format.lineEnding,
                        mixed: state.format.mixed,
                        savedAt: 0,
                    },
                    text,
                    selection: { from: anchor, to: head },
                };
            },
        };
    }, [placeNow]);
    // Drafts (lib/drafts.ts): the text sealed a couple of seconds after a change, when the page is
    // hidden or left, and before a lock; removed once the text is the file's again, on Discard, on
    // Open theirs and after a copy took it elsewhere. Declared before the editor itself, so closing
    // still reads its text.
    useEffect(() => {
        const made = createDraftWriter({
            snapshot: draftSnapshot,
            locked: () => sessionEnding() || deviceSession.generation() !== openedUnder.current,
            store: drafts(),
            onKept: (kept) => {
                if (mounted.current) setDraftNotKept(!kept);
            },
        });
        writer.current = made;
        const unregister = flushBeforeLock(() => made.flush());
        const left = () => void made.flush();
        const hidden = () => {
            if (document.visibilityState === 'hidden') void made.flush();
        };
        document.addEventListener('visibilitychange', hidden);
        window.addEventListener('pagehide', left);
        return () => {
            document.removeEventListener('visibilitychange', hidden);
            window.removeEventListener('pagehide', left);
            unregister();
            // An unanswered offer keeps its draft. Closed by choice (Discard, or nothing to keep), the
            // draft goes; a lock, a sign-out or leaving the drive keeps what was typed (written now,
            // unless the lock came first).
            if (!offerShown()) {
                const place = placeNow();
                if (!discardedNow()) void made.flush();
                else if (place) void made.remove(place);
            }
            made.stop();
            if (writer.current === made) writer.current = null;
        };
    }, [draftSnapshot, placeNow, offerShown, discardedNow]);

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
                    editability.current.of(fixed(editable && !offerNow.current)),
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
                        writer.current?.changed();
                    }),
                ],
            }),
        });
        view.current = made;
        editableNow.current = editable;
        setSourceView(made);
        saved.current = made.state.doc;
        markDirty(false);
        setEdits((count) => count + 1);
        // The language comes in after the text shows, then colours it.
        void editorAssets()
            .then(() => loadLanguage(language))
            .then((extension) => {
                if (active) made.dispatch({ effects: languageSlot.reconfigure(extension) });
            });
        if (editable && !offerNow.current) made.focus();
        return () => {
            active = false;
            made.destroy();
            if (view.current === made) {
                view.current = null;
                editableNow.current = false;
            }
            setSourceView((shown) => (shown === made ? null : shown));
            saved.current = null;
        };
    }, [shownText, editable, language, loadFrom.name, markDirty]);

    // The structured-text check, a moment after typing stops, off the main thread (lib/text-check.ts).
    // It never stops a save; a newer edit or a close ends a check still running, worker and all.
    useEffect(() => {
        const current = view.current;
        if (!checks || !current || !editable) return;
        let check: Check | null = null;
        let ended = false;
        const timer = window.setTimeout(() => {
            const doc = current.state.doc;
            if (doc.length > CHECK_LIMIT) {
                setWarning(null);
                return;
            }
            const text = doc.toString();
            // Its worker only once every parser (and the worker's own code) is fetched: never first.
            void editorAssets().then(() => {
                if (ended) return;
                const running = startCheck(checks, text);
                check = running;
                void running.result.then((failed) => {
                    if (view.current !== current || check !== running) return;
                    // Not checked (ended, or too large to check without a worker): no warning either way.
                    if (failed === 'skipped') return setWarning(null);
                    setWarning(failed ? parseWarning(checks, failed.line) : null);
                });
            });
        }, 500);
        return () => {
            ended = true;
            window.clearTimeout(timer);
            const running = check;
            check = null;
            running?.cancel();
        };
    }, [edits, checks, editable]);

    // The Markdown preview, following typing at most once a frame (never waiting for it to stop): the
    // viewer's renderer, sanitized the same way (images and links named, never fetched). Past the
    // renderer's limit it says so instead. Nothing is scheduled or mounted while it can't be seen; it
    // shows the text as it is now when it can. Past PREVIEW_LIVE_LIMIT it stops following typing and
    // offers Refresh preview instead.
    /*
     * The editor and the document (CodeMirror's are immutable: a change is a new one) the preview last
     * rendered: a new editor (Open theirs) renders at once, and only a document that differs is stale.
     */
    const previewedFrom = useRef<EditorView | null>(null);
    const previewedDoc = useRef<Text | null>(null);
    const renderPreview = useCallback(() => {
        const current = view.current;
        if (!current) return;
        const doc = current.state.doc;
        previewedFrom.current = current;
        previewedDoc.current = doc;
        setPreview({ text: tooLongToPreview(doc) ? null : doc.toString(), stale: false });
    }, [setPreview]);
    /* Leading and trailing, at most once a frame: the first keystroke shows at once, the last always. */
    const followTyping = useRef<FrameThrottle | null>(null);
    useEffect(() => {
        const throttle = frameThrottle(renderPreview);
        followTyping.current = throttle;
        return () => throttle.cancel();
    }, [renderPreview]);
    useEffect(() => {
        const current = view.current;
        if (!previewShown || !current) {
            followTyping.current?.cancel();
            previewedFrom.current = null;
            previewedDoc.current = null;
            setPreview(null);
            return;
        }
        // At once when it comes into view or a new text opens, so it never opens empty or on older text.
        if (previewedFrom.current !== current) {
            followTyping.current?.cancel();
            const timer = window.setTimeout(renderPreview, 0);
            return () => window.clearTimeout(timer);
        }
        // Already showing this text (a render that landed before this effect saw its count): nothing to do.
        if (current.state.doc === previewedDoc.current) return;
        if (current.state.doc.length > PREVIEW_LIVE_LIMIT) {
            followTyping.current?.cancel();
            setPreview((shown) => (shown && !shown.stale ? { ...shown, stale: true } : shown));
            return;
        }
        followTyping.current?.call();
    }, [edits, previewShown, renderPreview]);

    // Scrolling together (lib/scroll-sync.ts): beside each other, either pane moves the other; on a
    // narrow screen, switching between them keeps the line that was at the top.
    const previewScroller = useRef<HTMLElement>(null);
    /* The preview's blocks as last measured; null once it renders again or changes size. */
    const previewBlocks = useRef<Block[] | null>(null);
    /* A narrow switch's line, until the pane switched to can be put there. */
    const keptLine = useRef<{ side: Side; line: number } | null>(null);
    /* Made on first use, outside render: it reads the panes' refs only when asked. */
    const linkRef = useRef<ScrollLink | null>(null);
    const scrollLink = useCallback(
        () =>
            (linkRef.current ??= scrollLinkFor({
                source: view,
                sourceHost: host,
                preview: previewScroller,
                previewBlocks,
            })),
        [],
    );
    const sideBySide = markdown && wide;
    useEffect(() => {
        const scroller = previewScroller.current;
        if (!sideBySide || !sourceView || !scroller || !previewShown) return;
        const fromSource = () => scrollLink().scrolled('source');
        const fromPreview = () => scrollLink().scrolled('preview');
        sourceView.scrollDOM.addEventListener('scroll', fromSource, { passive: true });
        scroller.addEventListener('scroll', fromPreview, { passive: true });
        return () => {
            sourceView.scrollDOM.removeEventListener('scroll', fromSource);
            scroller.removeEventListener('scroll', fromPreview);
        };
    }, [sideBySide, sourceView, previewShown, scrollLink]);
    /* The preview changed (rendered again, or resized): measured afresh, and put where the source is. */
    const previewMoved = useCallback(() => {
        previewBlocks.current = null;
        const kept = keptLine.current;
        if (kept?.side === 'preview') {
            if (scrollLink().show('preview', kept.line)) keptLine.current = null;
            return;
        }
        // Typing: the source keeps the cursor in view, and the preview follows the source.
        if (sideBySide) scrollLink().follow('source');
    }, [scrollLink, sideBySide]);
    useLayoutEffect(() => {
        if (preview) previewMoved();
    }, [preview, previewMoved]);
    /*
     * The preview's body, watched for its own size from when it mounts until it unmounts (a callback ref):
     * Open theirs or a narrow switch mounts a new body, and the observer follows it, never the old one.
     */
    const latestPreviewMoved = useRef(previewMoved);
    useEffect(() => {
        latestPreviewMoved.current = previewMoved;
    });
    const previewBody = useCallback((body: HTMLDivElement | null) => {
        if (!body) return;
        const observer = new ResizeObserver(() => latestPreviewMoved.current());
        observer.observe(body);
        return () => observer.disconnect();
    }, []);
    /* Source or Preview on a narrow screen, keeping the line at the top of the one left. */
    const switchPane = (next: 'source' | 'preview') => {
        if (next === pane) return;
        const line = scrollLink().lineOf(pane);
        keptLine.current = line === null ? null : { side: next, line };
        setPane(next);
    };
    useLayoutEffect(() => {
        const kept = keptLine.current;
        if (pane !== 'source' || kept?.side !== 'source') return;
        keptLine.current = null;
        // CodeMirror measures again once it is shown: put the line at the top after that too.
        scrollLink().show('source', kept.line);
        const frame = requestAnimationFrame(() => scrollLink().show('source', kept.line));
        return () => cancelAnimationFrame(frame);
    }, [pane, scrollLink]);

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

    /* After a save landed: the editor's text is the file's now, from that version on, as `bytes`. */
    const settled = useCallback(
        (doc: Text, file: DriveNode, versionId: string | null, bytes: Uint8Array) => {
            const state = saveState.current;
            if (state) {
                // Written in one line break from here on, unless the save sent the bytes it had.
                if (bytes !== state.bytes) setTextFormat((was) => was && { ...was, mixed: false });
                saveState.current = savedState(state, doc.toString(), bytes);
            }
            // The version this save published, never one read from a listing afterwards (which may
            // already be someone else's). Unknown, the next save asks the stale question. A copy
            // is still signed from the version the text was read from, never this row.
            target.current = savedTarget(target.current, file, versionId);
            // The header names and marks `file` from here only if it lists this very version (a copy's row, as
            // located); a save's row from before it never does (lib/editor-marks.ts nextRead).
            onRead(versionId, file);
            saved.current = doc;
            markDirty(!(view.current?.state.doc.eq(doc) ?? true));
            // The text is the file's now: its draft goes (or holds only what was typed meanwhile).
            void writer.current?.flush();
            void invalidateFolders(queryClient, file.parentId);
        },
        [queryClient, markDirty, onRead],
    );

    /* "Discard your changes?" is open, or was answered Discard: nothing starts a save. */
    const askedToLeave = useCallback(
        () => guard.current.deciding === true || guard.current.discarded,
        [guard],
    );

    const save = useCallback(
        async (onTopOf?: string) => {
            const current = view.current;
            if (!current || saving || savingNow.current || !editable || ended || reloading) return;
            // Asked whether to discard (or discarded): a save started now could publish what is thrown away.
            if (askedToLeave()) return;
            const taken = token();
            const doc = current.state.doc;
            const { file, startedFrom } = target.current;
            const state = saveState.current;
            if (!state) return;
            // In the file's encoding, byte order mark and line breaks; unchanged, the bytes it had.
            const bytes = saveBytes(state, doc.toString());
            // Half of a character can't be written as typed: nothing is saved, and the text stays.
            if (!bytes) return setFailure(editorWords.halfCharacter);
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
                        bytes,
                    },
                    { stillOn: () => live(taken) },
                );
                if (!live(taken)) return;
                if (result.status === 'stale') {
                    setStale({ currentVersionId: result.currentVersionId });
                    return;
                }
                settled(doc, listed, result.versionId, bytes);
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
            askedToLeave,
        ],
    );

    const copy = useCallback(async () => {
        const current = view.current;
        if (!current || reloading || savingNow.current || askedToLeave()) return;
        const taken = token();
        const doc = current.state.doc;
        const { file, source } = target.current;
        const before = placeNow();
        const state = saveState.current;
        if (!state) return;
        // The copy keeps the file's encoding and line breaks too.
        const bytes = saveBytes(state, doc.toString());
        if (!bytes) return setFailure(editorWords.halfCharacter);
        let landed = false;
        beginSaving();
        setStatus(null);
        setFailure(null);
        try {
            const listing = await targetOf(queryClient, file);
            if (!live(taken)) return;
            const made = await saveCopy(
                start,
                { file, source, folder: listing.folder, bytes },
                {
                    stillOn: () => live(taken),
                    // Who wrote what the copy is made from, as trust stands now (not when it opened).
                    check: (nodes) => clientFor(file.workspaceId).checkNow(nodes),
                },
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
                // The text went into the copy: the file it came from keeps no draft of it.
                if (before) void writer.current?.remove(before);
                settled(doc, listed, made.versionId, bytes);
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
        placeNow,
        reloading,
        token,
        live,
        beginSaving,
        endSaving,
        askedToLeave,
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
        // This session's changes are discarded (the person confirmed it): so is their draft.
        const place = placeNow();
        if (place) void writer.current?.remove(place);
        // A new opened text: any earlier work still on its way publishes nothing over it.
        opening.current += 1;
        markDirty(false);
        onTarget(listed);
        setPhase({ kind: 'loading', progress: null });
        setLoadFrom(listed);
    }, [queryClient, onTarget, markDirty, token, live, placeNow]);

    /* The offer answered: the text takes changes again. */
    const closeOffer = useCallback(() => {
        setOffer(null);
        const current = view.current;
        if (!current) return;
        current.dispatch({ effects: editability.current.reconfigure(fixed(!endedNow.current)) });
        current.focus();
    }, [setOffer]);
    /*
     * Restore: the draft's text in place of the opened one, as an unsaved edit (Undo goes back), in the
     * session's format it was typed under. Someone saved since: the stale choices at once, and a save
     * still starts from the draft's version, so nothing lands over theirs without asking.
     */
    const restoreDraft = useCallback(() => {
        const shown = offerNow.current;
        const current = view.current;
        const state = saveState.current;
        if (!shown || !current || !state) return;
        const { draft } = shown;
        const format: TextFormat = {
            encoding: draft.frame.encoding,
            lineEnding: draft.frame.lineEnding,
            mixed: draft.frame.mixed,
        };
        saveState.current = { ...state, format };
        setTextFormat(format);
        if (shown.kind === 'stale')
            target.current = { ...target.current, startedFrom: draft.frame.baseVersionId };
        closeOffer();
        const end = draft.text.length;
        const at = (offset: number) => Math.min(offset, end);
        current.dispatch({
            changes: { from: 0, to: current.state.doc.length, insert: draft.text },
            selection: draft.selection
                ? EditorSelection.single(at(draft.selection.from), at(draft.selection.to))
                : undefined,
            scrollIntoView: true,
            userEvent: 'input.restore',
        });
        if (shown.kind === 'stale') setStale({ currentVersionId: shown.openedVersionId });
    }, [closeOffer]);
    /* The offer takes the keyboard when it shows, as the editor would have: Restore is one key away. */
    const restoreButton = useRef<HTMLButtonElement>(null);
    useEffect(() => {
        if (offer) restoreButton.current?.focus();
    }, [offer]);
    /* Discard: the draft goes, nothing more is asked; the text stays as the file holds it. */
    const discardDraft = useCallback(() => {
        const shown = offerNow.current;
        if (!shown) return;
        void writer.current?.remove(shown.place);
        closeOffer();
    }, [closeOffer]);

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
                !reloadingNow.current &&
                !askedToLeave()
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
                  {markdown && shownText !== null && (
                      // A narrow screen shows one at a time; a wide one shows both side by side.
                      <fieldset
                          className={cn(
                              'm-0 inline-flex min-w-0 shrink-0 rounded-md border-0 p-0.5 lg:hidden',
                              segmentTrack,
                          )}
                      >
                          <legend className="sr-only">Show</legend>
                          {(['source', 'preview'] as const).map((value) => (
                              <button
                                  key={value}
                                  type="button"
                                  aria-pressed={pane === value}
                                  onClick={() => switchPane(value)}
                                  className={cn(
                                      'h-8 cursor-pointer rounded-sm px-2.5 text-[13px] font-semibold outline-none focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-ring sm:px-3',
                                      pane === value
                                          ? segmentOn
                                          : 'text-muted-foreground hover:text-foreground',
                                  )}
                              >
                                  {value === 'source' ? editorWords.source : editorWords.preview}
                              </button>
                          ))}
                      </fieldset>
                  )}
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
                  {draftNotKept && !failure && !finishing && (
                      <output className="truncate text-[13px] text-muted-foreground max-sm:hidden">
                          {editorWords.draftNotKept}
                      </output>
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
                {offer && (
                    <div
                        data-draft-offer
                        className="flex shrink-0 flex-wrap items-center gap-x-4 gap-y-2 border-b border-rule bg-accent px-5 py-2.5 text-sm text-accent-foreground"
                    >
                        <p className="min-w-0 flex-1">
                            {editorWords.restoreOffer(draftWhen(offer.draft.frame.savedAt))}
                        </p>
                        <div className="flex shrink-0 gap-2">
                            <Button variant="outline" onClick={discardDraft}>
                                {editorWords.discardDraft}
                            </Button>
                            {/* Asked before anything else: the text can't be changed until it is answered. */}
                            <Button ref={restoreButton} variant="outline" onClick={restoreDraft}>
                                {editorWords.restore}
                            </Button>
                        </div>
                    </div>
                )}
                {phase.kind === 'read-only' && (
                    <p className="shrink-0 border-b border-rule bg-accent px-5 py-2.5 text-sm text-accent-foreground">
                        {READ_ONLY_WORDS[phase.reason]}
                    </p>
                )}
                {phase.kind === 'editing' && textFormat && mixedNote(textFormat) && (
                    <p className="shrink-0 border-b border-rule bg-accent px-5 py-2.5 text-sm text-accent-foreground">
                        {mixedNote(textFormat)}
                    </p>
                )}
                {warning && (
                    // On a phone the header has no room for it: said here instead, and read out the same way.
                    <output className="flex shrink-0 items-center gap-1.5 border-b border-rule px-5 py-2 text-[13px] text-warning sm:hidden">
                        <TriangleAlertIcon aria-hidden="true" className="size-3.5 shrink-0" />
                        {warning}
                    </output>
                )}
                <div className="flex min-h-0 flex-1">
                    <div
                        ref={host}
                        data-text-editor
                        className={cn(
                            'min-h-0 min-w-0 flex-1 overflow-hidden',
                            markdown && pane === 'preview' && 'max-lg:hidden',
                        )}
                    />
                    {previewShown && (
                        // Beside the source on a wide screen; in its place on a narrow one, when chosen.
                        <section
                            ref={previewScroller}
                            aria-label={editorWords.preview}
                            data-markdown-preview
                            // No scroll anchoring: the preview moves only with the source or the person.
                            className="min-h-0 min-w-0 flex-1 overflow-auto border-rule [overflow-anchor:none] lg:border-l"
                        >
                            <div ref={previewBody}>
                                {preview?.stale && (
                                    <div className="sticky top-0 z-10 flex justify-end border-b border-rule bg-background px-4 py-2">
                                        <Button variant="outline" onClick={renderPreview}>
                                            {editorWords.refreshPreview}
                                        </Button>
                                    </div>
                                )}
                                {preview?.text === null ? (
                                    <p className="px-6 py-10 text-center text-sm text-muted-foreground">
                                        {editorWords.previewTooLong}
                                    </p>
                                ) : (
                                    preview && (
                                        // A failure here stays in this pane: the source, its text and Save go on.
                                        <PreviewBoundary text={preview.text}>
                                            <Suspense fallback={null}>
                                                {/* Fences stay plain until the preload has every grammar: typing one never fetches its language's. */}
                                                <EditorPreview text={preview.text} />
                                            </Suspense>
                                        </PreviewBoundary>
                                    )
                                )}
                            </div>
                        </section>
                    )}
                </div>
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
