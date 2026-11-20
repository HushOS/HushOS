import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, expect, test, vi } from 'vitest';
import type { DriveNode } from '@hushos/drive/client';

/*
 * Edit pages' dialog against a stand-in engine and drawer: a save whose thumbnails are still being
 * drawn when the dialog goes, or the device locks, saves nothing; a look that won't start says so
 * rather than reading for ever; a page turned while its first drawing is under way stops that one
 * before drawing again, and draws again after a failure.
 */

const engine = vi.hoisted(() => ({ inspectPdfs: vi.fn() }));
vi.mock('@/lib/pdf-tools/make', () => ({
    inspectPdfs: engine.inspectPdfs,
    refusalWords: () => 'refused',
}));
const drawing = vi.hoisted(() => ({
    thumbnail: vi.fn<() => Promise<Uint8Array | null>>(),
    draws: [] as {
        rotate: number;
        settle: (ok: boolean) => void;
        cancel: ReturnType<typeof vi.fn>;
    }[],
}));
vi.mock('@/lib/pdf-tools/page-thumbnails', () => ({
    openPageDrawer: async () => ({
        draw: (_page: number, rotate: number) => {
            let settle!: (ok: boolean) => void;
            const promise = new Promise<void>((resolve, reject) => {
                settle = (ok) => (ok ? resolve() : reject(new Error('drawn badly')));
            });
            const entry = { rotate, settle, cancel: vi.fn(() => settle(false)) };
            drawing.draws.push(entry);
            return { promise, cancel: entry.cancel };
        },
        thumbnail: drawing.thumbnail,
        close: () => {},
    }),
}));
vi.mock('@/lib/drive/runs/save-runs', () => ({
    suggestedName: async (_client: unknown, _folder: unknown, name: string) => name,
}));
const epoch = vi.hoisted(() => ({ value: 0 }));
vi.mock('@/lib/drive/runs/tool-run-rows', () => ({ toolRunRows: { epoch: () => epoch.value } }));
vi.mock('@/lib/drive/drive', () => ({
    driveKeys: { all: ['drive'] },
    formatBytes: (bytes: number) => `${bytes} B`,
    nodeSize: (node: DriveNode) => Number(node.currentVersion?.plaintextSize ?? 0),
}));

// The thumbnails draw once in view: every observed canvas is in view at once here.
class SeenAtOnce {
    constructor(private readonly callback: IntersectionObserverCallback) {}
    observe() {
        this.callback([{ isIntersecting: true } as IntersectionObserverEntry], this as never);
    }
    disconnect() {}
}
vi.stubGlobal('IntersectionObserver', SeenAtOnce);

const pdf = {
    id: 'n1',
    kind: 'file',
    name: 'Report.pdf',
    parentId: 'f1',
    workspaceId: 'w1',
    metadata: { mime: 'application/pdf' },
    currentVersion: { id: 'v1', plaintextSize: '1000', objectStatus: 'ready' },
} as unknown as DriveNode;
const folder = {
    id: 'f1',
    kind: 'folder',
    workspaceId: 'w1',
    name: 'Docs',
} as unknown as DriveNode;

async function open(onSave = vi.fn(), onOpenChange = vi.fn()) {
    const { PdfPagesDialog } = await import('./pdf-pages-dialog');
    const queryClient = new QueryClient();
    const view = render(
        <QueryClientProvider client={queryClient}>
            <PdfPagesDialog
                folder={folder}
                files={[pdf]}
                onOpenChange={onOpenChange}
                onSave={onSave}
            />
        </QueryClientProvider>,
    );
    return { view, onSave, onOpenChange };
}

beforeEach(() => {
    engine.inspectPdfs.mockReset();
    engine.inspectPdfs.mockReturnValue({
        result: Promise.resolve([
            {
                ok: true,
                pages: [
                    { width: 612, height: 792, rotate: 0 },
                    { width: 612, height: 792, rotate: 0 },
                ],
                flags: { signed: false, outline: false, form: false },
            },
        ]),
        cancel: vi.fn(),
    });
    drawing.thumbnail.mockReset();
    drawing.draws.length = 0;
    epoch.value = 0;
    vi.resetModules();
});

test('a save still drawing its thumbnails when the dialog goes saves nothing', async () => {
    let finish!: (bytes: Uint8Array | null) => void;
    drawing.thumbnail.mockReturnValue(new Promise((resolve) => (finish = resolve)));
    const { view, onSave } = await open();
    const user = userEvent.setup();
    const dialog = await screen.findByRole('dialog');
    await within(dialog).findAllByRole('button', { name: /^Rotate page/ });
    await user.click(within(dialog).getByRole('button', { name: 'Remove page 2' }));
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(drawing.thumbnail).toHaveBeenCalled());
    // Cancel while the thumbnail is drawn: the dialog goes, then the thumbnail comes.
    view.unmount();
    await act(async () => finish(new Uint8Array([1])));
    expect(onSave).not.toHaveBeenCalled();
});

test('a lock while the thumbnails are drawn saves nothing either', async () => {
    let finish!: (bytes: Uint8Array | null) => void;
    drawing.thumbnail.mockReturnValue(new Promise((resolve) => (finish = resolve)));
    const { onSave } = await open();
    const user = userEvent.setup();
    const dialog = await screen.findByRole('dialog');
    await within(dialog).findAllByRole('button', { name: /^Rotate page/ });
    await user.click(within(dialog).getByRole('button', { name: 'Remove page 2' }));
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(drawing.thumbnail).toHaveBeenCalled());
    epoch.value++;
    await act(async () => finish(null));
    expect(onSave).not.toHaveBeenCalled();
});

test('the save goes ahead once its thumbnails are drawn and nothing went', async () => {
    drawing.thumbnail.mockResolvedValue(new Uint8Array([7]));
    const { onSave } = await open();
    const user = userEvent.setup();
    const dialog = await screen.findByRole('dialog');
    await within(dialog).findAllByRole('button', { name: /^Rotate page/ });
    await user.click(within(dialog).getByRole('button', { name: 'Remove page 2' }));
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    expect(onSave.mock.calls[0]![0]).toMatchObject({ kind: 'version', startedFrom: 'v1' });
});

test('a look that will not start says so, never reading for ever', async () => {
    engine.inspectPdfs.mockImplementation(() => {
        throw new Error('the worker would not start');
    });
    await open();
    const dialog = await screen.findByRole('dialog');
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(
        "This file couldn't be processed.",
    );
    expect(within(dialog).queryByText('Reading the pages')).toBeNull();
});

test('turning a page stops its drawing under way before drawing again, and draws after a failure', async () => {
    drawing.thumbnail.mockResolvedValue(null);
    await open();
    const user = userEvent.setup();
    const dialog = await screen.findByRole('dialog');
    await within(dialog).findAllByRole('button', { name: /^Rotate page/ });
    await waitFor(() => expect(drawing.draws).toHaveLength(2));
    const first = drawing.draws[0]!;
    await user.click(within(dialog).getByRole('button', { name: 'Rotate page 1' }));
    // The first drawing was stopped, and the next one started only after it settled.
    expect(first.cancel).toHaveBeenCalled();
    await waitFor(() => expect(drawing.draws.some((draw) => draw.rotate === 90)).toBe(true));
    const turned = drawing.draws.find((draw) => draw.rotate === 90)!;
    await act(async () => turned.settle(false));
    const canvas = () => dialog.querySelector('[data-page="0:0"] canvas') as HTMLCanvasElement;
    await waitFor(() => expect(canvas()).toHaveClass('hidden'));
    // Turned again: drawn again, shown again.
    await user.click(within(dialog).getByRole('button', { name: 'Rotate page 1' }));
    await waitFor(() => expect(drawing.draws.some((draw) => draw.rotate === 180)).toBe(true));
    expect(canvas()).not.toHaveClass('hidden');
});
