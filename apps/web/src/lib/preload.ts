import { claimDiagramsForPreload } from '@/lib/diagram-owner';

/*
 * Every viewer, syntax grammar and thumbnailer the app loads on first use,
 * fetched once after unlock when the browser is idle. Otherwise which chunks
 * a device fetched (pdf.js, SheetJS, the Rust grammar, the video demuxer)
 * would tell whoever serves the app what kind of file was just opened or
 * uploaded, though the file itself is end-to-end encrypted. Only inside the
 * app, after unlock: a public page or a link visitor never pays for it.
 *
 * Not the text editor: its code (CodeMirror, every language, the parsers, the check's worker) comes
 * in whole with the first Edit (text-editor.tsx editorAssets), whatever kind of file, so it says only
 * that someone edits (editing-design.md section 4). No viewer may import any of it.
 */
let started = false;

function whenIdle(work: () => void) {
    if ('requestIdleCallback' in window) window.requestIdleCallback(work, { timeout: 15_000 });
    else setTimeout(work, 3_000);
}

export function preloadViewers() {
    if (started || typeof window === 'undefined') return;
    started = true;
    // Diagrams are the preload's from now on: a view opened before it gets there never fetches them first.
    claimDiagramsForPreload();
    whenIdle(() => {
        // One after another, so the fetches never crowd out what the person is doing.
        void (async () => {
            const steps: (() => Promise<unknown>)[] = [
                () => import('@/components/drive/pdf-viewer').then((m) => m.preloadPdf()),
                () => import('@/components/drive/office-viewer').then((m) => m.preloadOffice()),
                () => import('@/components/drive/rich-text'),
                // pele and its twelve diagram types, one worker file (lib/mermaid.ts), never per type.
                () => import('@/lib/mermaid').then((m) => m.preloadMermaid()),
                () => import('@/components/drive/json-view').then((m) => m.preloadJsonView()),
                // The archive reader opens like a viewer (docs/file-tools-design.md, "Dependencies").
                () => import('@/components/drive/archive-view').then((m) => m.preloadArchive()),
                () => import('@/lib/highlight').then((m) => m.preloadGrammars()),
                () => import('@/lib/thumbnails').then((m) => m.preloadThumbnailer()),
            ];
            for (const step of steps) await step().catch(() => {});
            document.documentElement.dataset.viewersPreloaded = 'true';
        })();
    });
}
