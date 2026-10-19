import type { FileReader } from '@hushos/drive/downloads';
import type { Root } from 'hast';
import { fromHtml } from 'hast-util-from-html';
import { sanitize, defaultSchema, type Schema } from 'hast-util-sanitize';
import { cn } from 'cn';
import { FileQuestionIcon } from 'lucide-react';
import { useEffect, useState } from 'react';
import { CodeView, HastView } from '@/components/drive/rich-text';
import { Notice, Opening, useSourceSwitch, viewerWords } from '@/components/drive/viewer-parts';
import { languageFor } from '@/lib/highlight';
import { readAll, type ReadProgress, rememberPreview } from '@/lib/previews';
import {
    clipSheet,
    firstRowIsHeader,
    OFFICE_LIMIT,
    sheetSource,
    slideOutline,
    type OfficeKind,
    type Slide,
} from '@/lib/office';
import '@/components/drive/rich-text.css';

/*
 * Office documents on the device. Word goes through mammoth to HTML, which is
 * then treated exactly like Markdown output: parsed to a tree, sanitised
 * against an allowlist, rendered as elements, never as HTML. Spreadsheets go
 * through SheetJS to cells. Presentations become a text outline, since the
 * browser cannot lay a slide out faithfully: an outline of titles beside the
 * chosen slide's text. Every renderer is loaded on first use; nothing leaves
 * the page.
 */

/* Every renderer the viewer loads on first use, fetched ahead of it (see lib/preload.ts). */
export async function preloadOffice() {
    await Promise.all([import('mammoth'), import('xlsx')]);
}

const schema: Schema = {
    ...defaultSchema,
    clobber: [],
    attributes: {
        ...defaultSchema.attributes,
        // Images inside a document arrive as data URIs from the decrypted bytes; nothing remote.
        img: [['src', /^data:image\//], 'alt'],
        td: [...(defaultSchema.attributes?.td ?? []), 'colSpan', 'rowSpan'],
        th: [...(defaultSchema.attributes?.th ?? []), 'colSpan', 'rowSpan'],
    },
    protocols: { ...defaultSchema.protocols, href: ['http', 'https', 'mailto'], src: ['data'] },
};

type Loaded =
    | { kind: 'docx'; tree: Root; warnings: number }
    | {
          kind: 'sheet';
          sheets: { name: string; clipped: ReturnType<typeof clipSheet> }[];
          /* The text itself, for delimited files, so the table can be flipped to its source. */
          source: string | null;
      }
    | { kind: 'slides'; slides: Slide[] };

async function load(kind: OfficeKind, bytes: Uint8Array): Promise<Loaded> {
    switch (kind) {
        case 'docx': {
            const mammoth = await import('mammoth');
            const result = await mammoth.convertToHtml({
                arrayBuffer: bytes.buffer as ArrayBuffer,
            });
            const tree = sanitize(fromHtml(result.value, { fragment: true }), schema) as Root;
            return { kind, tree, warnings: result.messages.length };
        }
        case 'sheet': {
            const XLSX = await import('xlsx');
            const source = sheetSource(bytes);
            const book = XLSX.read(source.data, {
                type: source.type,
                cellDates: true,
                dense: true,
            });
            return {
                kind,
                source: source.type === 'string' ? source.data : null,
                sheets: book.SheetNames.map((name) => ({
                    name,
                    clipped: clipSheet(
                        XLSX.utils.sheet_to_json<unknown[]>(book.Sheets[name]!, {
                            header: 1,
                            raw: false,
                            defval: null,
                        }),
                    ),
                })),
            };
        }
        case 'slides':
            return { kind, slides: slideOutline(bytes) };
    }
}

export function OfficeViewer({
    source,
    versionId,
    kind,
    name,
    limit = OFFICE_LIMIT,
    onDownload,
}: {
    /* The file to read, or its bytes when a previous open remembered them. */
    source: FileReader | Uint8Array;
    versionId: string | null;
    kind: OfficeKind;
    name: string;
    /*
     * How much may be read. The viewer checks the size against the large-file
     * card before this chunk loads, so a file here is already within it.
     */
    limit?: number;
    onDownload: () => void;
}) {
    const [state, setState] = useState<Loaded | null>(null);
    const [failure, setFailure] = useState(false);
    const [progress, setProgress] = useState<ReadProgress | null>(null);
    useEffect(() => {
        let active = true;
        const read =
            source instanceof Uint8Array
                ? Promise.resolve({ bytes: source })
                : readAll(source, limit, (value) => active && setProgress(value));
        read.then(({ bytes }) => {
            if (versionId && !(source instanceof Uint8Array))
                rememberPreview(versionId, {
                    kind: 'document',
                    data: bytes,
                    bytes: bytes.byteLength,
                });
            return load(kind, bytes);
        })
            .then((loaded) => {
                if (active) setState(loaded);
            })
            .catch(() => {
                if (active) setFailure(true);
            });
        return () => {
            active = false;
        };
    }, [source, versionId, kind, limit]);
    if (failure)
        return (
            <Notice
                icon={
                    <FileQuestionIcon
                        className="size-8 text-muted-foreground"
                        strokeWidth={1.6}
                        aria-hidden="true"
                    />
                }
                title={viewerWords.broken}
                text={viewerWords.brokenText}
                onDownload={onDownload}
            />
        );
    if (!state) return <Opening name={name} progress={progress} />;
    const empty =
        (state.kind === 'sheet' && state.sheets.length === 0) ||
        (state.kind === 'slides' && state.slides.length === 0) ||
        (state.kind === 'docx' && state.tree.children.length === 0);
    if (empty) return <Notice title={viewerWords.nothing} onDownload={onDownload} />;
    switch (state.kind) {
        case 'docx':
            return (
                <div
                    data-viewer-body
                    tabIndex={-1}
                    className="flex-1 overflow-auto px-3 py-4 outline-none sm:px-6 sm:py-8"
                    data-office="docx"
                >
                    <div className="sheet mx-auto max-w-4xl">
                        <article className="rt-markdown">
                            <HastView tree={state.tree} />
                        </article>
                    </div>
                </div>
            );
        case 'sheet':
            return <SheetView sheets={state.sheets} source={state.source} name={name} />;
        case 'slides':
            return <SlidesView slides={state.slides} />;
    }
}

/*
 * Tables per sheet, with the sheets as tabs along the bottom, where people look
 * for them. A delimited file offers Formatted | Source in the header.
 */
function SheetView({
    sheets,
    source,
    name,
}: {
    sheets: { name: string; clipped: ReturnType<typeof clipSheet> }[];
    source: string | null;
    name: string;
}) {
    const [active, setActive] = useState(0);
    const raw = useSourceSwitch(source !== null);
    const sheet = sheets[active] ?? sheets[0]!;
    if (raw && source !== null)
        return (
            <div
                data-viewer-body
                tabIndex={-1}
                className="min-h-0 flex-1 overflow-auto px-3 py-4 outline-none sm:px-6 sm:py-8"
                data-office="sheet"
            >
                <div className="sheet mx-auto flex w-full max-w-5xl min-w-0 flex-col">
                    <CodeView text={source} language={languageFor(name)} />
                </div>
            </div>
        );
    const { cells, width, moreRows, moreCols } = sheet.clipped;
    // A delimited file's first row, when it names its columns, is a header, not data row 1
    // (firstRowIsHeader). A workbook's rows are numbered from 1 as the spreadsheet numbers them.
    const header = source !== null && firstRowIsHeader(cells, width) ? cells[0]! : null;
    const body = header ? cells.slice(1) : cells;
    const totalRows = body.length + moreRows;
    const count = (n: number) => n.toLocaleString('en-GB');
    const clipped =
        moreRows > 0 || moreCols > 0
            ? [
                  moreRows > 0 && `${count(body.length)} of ${count(totalRows)} rows`,
                  moreCols > 0 && `${count(width)} of ${count(width + moreCols)} columns`,
              ]
                  .filter(Boolean)
                  .join(' and ')
            : null;
    return (
        <div
            data-viewer-body
            tabIndex={-1}
            className="flex min-h-0 flex-1 flex-col p-3 outline-none sm:p-6"
            data-office="sheet"
        >
            {/* Clipped to its rounded corners: the sticky row numbers would otherwise paint over them. */}
            <div className="mx-auto flex min-h-0 w-full max-w-5xl flex-col overflow-hidden rounded-xl bg-card shadow-sm [clip-path:inset(0_round_var(--radius-xl))]">
                {clipped && (
                    // Said before the table, where it is read first: only part of the file is here.
                    <p
                        data-sheet-clipped
                        className="shrink-0 border-b border-rule px-4 py-2 text-[13px] text-muted-foreground"
                    >
                        Showing {clipped}. Download it to see them all.
                    </p>
                )}
                <div className="min-h-0 flex-1 overflow-auto">
                    <table className="min-w-full border-collapse text-[13px] tabular-nums">
                        {header && (
                            <thead className="sticky top-0 z-10">
                                <tr>
                                    <td
                                        aria-hidden="true"
                                        className="sticky left-0 z-10 w-10 border-r border-b border-rule bg-muted"
                                    />
                                    {Array.from({ length: width }, (_, c) => (
                                        <th
                                            key={c}
                                            scope="col"
                                            title={header[c] ?? ''}
                                            className="max-w-64 truncate border-r border-b border-rule bg-card px-3 py-1.5 text-left font-semibold whitespace-nowrap"
                                        >
                                            {header[c] ?? ''}
                                        </th>
                                    ))}
                                    {/* The grid runs on to the card's edge. */}
                                    <td
                                        aria-hidden="true"
                                        className="w-full border-b border-rule bg-card"
                                    />
                                </tr>
                            </thead>
                        )}
                        <tbody>
                            {body.map((row, r) => (
                                <tr key={r}>
                                    <th
                                        scope="row"
                                        className="sticky left-0 w-10 border-r border-b border-rule bg-muted px-2 py-1.5 text-center font-normal text-muted-foreground"
                                    >
                                        {r + 1}
                                    </th>
                                    {Array.from({ length: width }, (_, c) => (
                                        <td
                                            key={c}
                                            className="max-w-64 truncate border-r border-b border-rule px-3 py-1.5 whitespace-nowrap"
                                        >
                                            {row[c] ?? ''}
                                        </td>
                                    ))}
                                    <td
                                        aria-hidden="true"
                                        className="w-full border-b border-rule"
                                    />
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
                {sheets.length > 1 && (
                    <div
                        role="tablist"
                        aria-label="Sheets"
                        className="flex h-10 shrink-0 items-end gap-1 overflow-x-auto border-t border-rule bg-muted px-2"
                    >
                        {sheets.map((entry, index) => (
                            <button
                                key={entry.name}
                                type="button"
                                role="tab"
                                aria-selected={index === active}
                                onClick={() => setActive(index)}
                                className={cn(
                                    'h-8 shrink-0 cursor-pointer rounded-t-md px-4 text-[13px] whitespace-nowrap outline-none focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring',
                                    index === active
                                        ? 'border-x border-t border-rule bg-card font-bold text-foreground'
                                        : 'text-muted-foreground hover:text-foreground',
                                )}
                            >
                                {entry.name}
                            </button>
                        ))}
                    </div>
                )}
            </div>
        </div>
    );
}

/*
 * An outline of the slides' titles beside the chosen slide's text. Layout and
 * images aren't drawn; the browser can't lay a slide out faithfully.
 */
function SlidesView({ slides }: { slides: Slide[] }) {
    const [at, setAt] = useState(0);
    const slide = slides[at] ?? slides[0]!;
    const titleOf = (entry: Slide) => entry.title ?? entry.paragraphs[0] ?? `Slide ${entry.number}`;
    return (
        <div
            data-viewer-body
            tabIndex={-1}
            className="flex min-h-0 flex-1 flex-col gap-4 overflow-auto px-3 py-4 outline-none sm:px-6 sm:py-8 md:flex-row"
            data-office="slides"
        >
            <ol
                aria-label="Slides"
                className="flex shrink-0 gap-1 overflow-x-auto md:w-56 md:flex-col md:overflow-x-visible md:overflow-y-auto"
            >
                {slides.map((entry, index) => (
                    <li key={entry.number} className="shrink-0 md:shrink">
                        <button
                            type="button"
                            aria-current={index === at ? 'true' : undefined}
                            onClick={() => setAt(index)}
                            className={cn(
                                'flex w-full max-w-56 cursor-pointer gap-2 rounded-md px-2.5 py-2 text-left text-[13px] outline-none focus-visible:outline-2 focus-visible:outline-ring',
                                index === at
                                    ? 'bg-accent font-bold text-accent-foreground'
                                    : 'hover:bg-card',
                            )}
                        >
                            <span className="w-4 shrink-0 text-muted-foreground tabular-nums">
                                {entry.number}
                            </span>
                            <span className="truncate">{titleOf(entry)}</span>
                        </button>
                    </li>
                ))}
            </ol>
            <section
                data-slide={slide.number}
                className="mx-auto flex aspect-video w-full max-w-4xl min-w-0 flex-col justify-center gap-4 self-start overflow-auto rounded-xl bg-card p-6 shadow-sm sm:p-10"
            >
                <span className="text-[13px] font-semibold text-muted-foreground">
                    Slide {slide.number}
                </span>
                {slide.title && (
                    <h2 className="text-2xl leading-tight font-extrabold tracking-[-0.02em] sm:text-[30px]">
                        {slide.title}
                    </h2>
                )}
                {slide.paragraphs.length > 0 && (
                    <ul className="flex list-disc flex-col gap-1.5 pl-5 text-base">
                        {slide.paragraphs.map((paragraph, index) => (
                            <li key={index}>{paragraph}</li>
                        ))}
                    </ul>
                )}
            </section>
        </div>
    );
}
