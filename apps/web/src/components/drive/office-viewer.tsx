import type { FileReader } from '@hushos/drive/downloads';
import type { Root } from 'hast';
import { fromHtml } from 'hast-util-from-html';
import { sanitize, defaultSchema, type Schema } from 'hast-util-sanitize';
import { CodeIcon, Table2Icon } from 'lucide-react';
import { useEffect, useState } from 'react';
import { CodeView, HastView } from '@/components/drive/rich-text';
import { Spinner } from '@/components/motion';
import { Button } from '@/components/ui/button';
import { languageFor } from '@/lib/highlight';
import { readAll } from '@/lib/previews';
import {
    clipSheet,
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
 * browser cannot lay a slide out faithfully. Every renderer is loaded on first
 * use; nothing leaves the page.
 */

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
    reader,
    kind,
    name,
}: {
    reader: FileReader;
    kind: OfficeKind;
    name: string;
}) {
    const [state, setState] = useState<Loaded | null>(null);
    const [error, setError] = useState<string | null>(null);
    useEffect(() => {
        let active = true;
        readAll(reader, OFFICE_LIMIT)
            .then(({ bytes, truncated }) => {
                if (truncated)
                    throw new Error(`Documents preview up to ${OFFICE_LIMIT / 1024 / 1024} MiB.`);
                return load(kind, bytes);
            })
            .then((loaded) => {
                if (active) setState(loaded);
            })
            .catch((cause: unknown) => {
                if (active)
                    setError(
                        cause instanceof Error ? cause.message : 'The document could not be read.',
                    );
            });
        return () => {
            active = false;
        };
    }, [reader, kind]);
    if (error)
        return (
            <div className="flex flex-1 items-center justify-center p-8 text-center font-mono text-xs text-destructive">
                {error}
            </div>
        );
    if (!state)
        return (
            <div className="flex flex-1 items-center justify-center text-muted-foreground">
                <Spinner />
            </div>
        );
    switch (state.kind) {
        case 'docx':
            return (
                <div className="flex-1 overflow-auto bg-card px-6 py-8 sm:px-10" data-office="docx">
                    <article className="rt-markdown mx-auto max-w-3xl">
                        <HastView tree={state.tree} />
                    </article>
                </div>
            );
        case 'sheet':
            return <SheetView sheets={state.sheets} source={state.source} name={name} />;
        case 'slides':
            return <SlidesView slides={state.slides} name={name} />;
    }
}

/* Tables per sheet; a delimited file can be flipped to its text and back. */
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
    const [raw, setRaw] = useState(false);
    const sheet = sheets[active] ?? sheets[0];
    if (!sheet)
        return (
            <div className="flex flex-1 items-center justify-center font-mono text-xs text-muted-foreground">
                This workbook has no sheets.
            </div>
        );
    const { cells, width, moreRows, moreCols } = sheet.clipped;
    const toggle = source !== null && (
        <div className="flex shrink-0 justify-end border-b px-3 py-1">
            <Button
                variant="ghost"
                size="xs"
                aria-pressed={raw}
                onClick={() => setRaw((value) => !value)}
            >
                {raw ? <Table2Icon /> : <CodeIcon />}
                {raw ? 'Show table' : 'Show source'}
            </Button>
        </div>
    );
    if (raw && source !== null)
        return (
            <div className="flex min-h-0 flex-1 flex-col overflow-auto bg-card" data-office="sheet">
                {toggle}
                <CodeView text={source} language={languageFor(name)} />
            </div>
        );
    return (
        <div className="flex min-h-0 flex-1 flex-col bg-card" data-office="sheet">
            {toggle}
            {sheets.length > 1 && (
                <div role="tablist" aria-label="Sheets" className="flex flex-wrap border-b">
                    {sheets.map((entry, index) => (
                        <button
                            key={entry.name}
                            type="button"
                            role="tab"
                            aria-selected={index === active}
                            onClick={() => setActive(index)}
                            className={`eyebrow px-4 py-2 ${index === active ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:bg-muted'}`}
                        >
                            {entry.name}
                        </button>
                    ))}
                </div>
            )}
            <div className="min-h-0 flex-1 overflow-auto">
                <table className="border-collapse font-mono text-xs">
                    <tbody>
                        {cells.map((row, r) => (
                            <tr key={r} className="border-b">
                                <th
                                    scope="row"
                                    className="sticky left-0 border-r bg-muted px-2 py-1 text-right font-normal text-muted-foreground tabular-nums"
                                >
                                    {r + 1}
                                </th>
                                {Array.from({ length: width }, (_, c) => (
                                    <td
                                        key={c}
                                        className="max-w-64 truncate border-r px-2 py-1 whitespace-nowrap"
                                    >
                                        {row[c] ?? ''}
                                    </td>
                                ))}
                            </tr>
                        ))}
                    </tbody>
                </table>
            </div>
            {(moreRows > 0 || moreCols > 0) && (
                <p className="border-t px-4 py-2 font-mono text-[11px] text-muted-foreground">
                    Showing the first {cells.length} rows and {width} columns
                    {moreRows ? `; ${moreRows} more rows` : ''}
                    {moreCols ? `; ${moreCols} more columns` : ''}. Download the file for the rest.
                </p>
            )}
        </div>
    );
}

function SlidesView({ slides, name }: { slides: Slide[]; name: string }) {
    return (
        <div className="flex-1 overflow-auto bg-card px-6 py-8 sm:px-10" data-office="slides">
            <div className="mx-auto flex max-w-3xl flex-col gap-4">
                <p className="font-mono text-[11px] text-muted-foreground">
                    The text of {name}, slide by slide. Layout and images are not rendered; download
                    the file to see them.
                </p>
                {slides.length === 0 && (
                    <p className="font-mono text-xs text-muted-foreground">No slides with text.</p>
                )}
                {slides.map((slide) => (
                    <section
                        key={slide.number}
                        className="border px-5 py-4"
                        data-slide={slide.number}
                    >
                        <p className="eyebrow mb-2 text-muted-foreground">Slide {slide.number}</p>
                        {slide.title && <h2 className="text-lg font-medium">{slide.title}</h2>}
                        {slide.paragraphs.map((paragraph, index) => (
                            <p key={index} className="mt-1 text-sm leading-relaxed">
                                {paragraph}
                            </p>
                        ))}
                    </section>
                ))}
            </div>
        </div>
    );
}
