import {
    PDFArray,
    PDFBool,
    PDFDict,
    PDFDocument,
    PDFHexString,
    PDFName,
    PDFNull,
    PDFNumber,
    PDFPage,
    PDFPageLeaf,
    PDFParser,
    PDFRawStream,
    PDFRef,
    PDFStream,
    PDFString,
    type PDFContext,
    type PDFObject,
} from '@cantoo/pdf-lib';
import { prunedResources, Unreadable } from './content';
import {
    PDF_MAX_BYTES,
    PDF_TOOLS_MAX_PAGES,
    type PageInfo,
    type PdfFlags,
    type Rotation,
} from './protocol';

/*
 * PDF structure for Edit pages (docs/file-tools-design.md, feature (c)), with @cantoo/pdf-lib in the
 * PDF tools worker: reading a PDF's pages, its warnings and its refusals, and building new PDFs from
 * pages of one or several. The core's twin is crates/hushos-core/src/tools/pdf_tools.rs (lopdf, on
 * the phones); both are held to e2e/fixtures/pdfs/expected.json, rule for rule:
 *
 * - **Refused:** an `/Encrypt` entry in the trailer (`encrypted`), before anything else is looked at;
 *   a file that doesn't parse, a catalog or page tree that isn't a dictionary, a page tree node met
 *   twice (a cycle), deeper than PAGE_TREE_MAX_DEPTH, a kid that is missing or isn't a dictionary,
 *   or no pages at all (`damaged`); more than PDF_TOOLS_MAX_PAGES pages (`too-many-pages`).
 * - **The page tree is walked here,** without recursion and never by pdf-lib (whose walk follows a
 *   cycle forever). A node is a page when its /Type is /Page, a tree node when it is /Pages, and
 *   otherwise by whether it has /Kids. MediaBox, CropBox, Resources and Rotate are inherited down.
 * - **A page's size** is its MediaBox (US Letter when it has none); its rotation is /Rotate when it is
 *   a whole multiple of 90, turned into 0, 90, 180 or 270, and 0 otherwise.
 * - **Warnings:** `signed` when an AcroForm field (its /FT inherited from its parents) is /Sig and its
 *   value is a dictionary with /ByteRange; `outline` when the catalog's /Outlines has a /First;
 *   `form` when the AcroForm's /Fields is a non-empty array.
 * - **Every output is new:** pages copied into a new document, each with its inherited entries made
 *   its own and its /Rotate set, nothing else of the source's catalog (no outline, no AcroForm), no
 *   document information dictionary (no Producer, Creator or dates), no object streams.
 * - **Copying is bounded:** objects are copied once each by reference (a reference cycle is copied
 *   as a cycle), a reference to another page or to a page tree node becomes null (so an annotation's
 *   /P never drags the whole source in), and direct nesting deeper than NESTING_MAX_DEPTH is damage.
 */

/* Page tree levels walked before a file is taken for damaged; real files use a handful. */
export const PAGE_TREE_MAX_DEPTH = 256;
/* AcroForm field levels and fields looked at for a signature; past them the search stops, no refusal. */
const FIELD_MAX_DEPTH = 64;
const FIELDS_MAX = 10_000;
/* Arrays and dictionaries inside one another, directly, past which a page is damaged. */
const NESTING_MAX_DEPTH = 512;
/* Letter, when a page has no MediaBox anywhere above it (what readers assume). */
const DEFAULT_SIZE = { width: 612, height: 792 };

export type PdfRefusal = 'encrypted' | 'damaged' | 'too-many-pages' | 'too-large';

export class PdfRefused extends Error {
    constructor(readonly reason: PdfRefusal) {
        super(reason);
        this.name = 'PdfRefused';
    }
}

const INHERITED = ['Resources', 'MediaBox', 'CropBox', 'Rotate'] as const;
type Inherited = Partial<Record<(typeof INHERITED)[number], PDFObject>>;

type PageNode = {
    /* The page's own dictionary as the source holds it. */
    leaf: PDFDict;
    /* Its reference, or null for a page written directly into its parent's /Kids. */
    ref: PDFRef | null;
    inherited: Inherited;
    info: PageInfo;
};

export type SourcePdf = {
    context: PDFContext;
    pages: PageNode[];
    flags: PdfFlags;
    /* Every page tree node's reference, pages included: a reference to one is never copied. */
    treeRefs: Set<string>;
    /* Its optional content groups (layers) and those switched off, or null without any. */
    layers: Layers | null;
};

export type Layers = { groups: PDFRef[]; off: Set<string> };

const tag = (ref: PDFRef) => `${ref.objectNumber} ${ref.generationNumber}`;
const name = (value: string) => PDFName.of(value);

function resolve(context: PDFContext, value: PDFObject | undefined): PDFObject | undefined {
    return value instanceof PDFRef ? context.lookup(value) : value;
}

function numberOf(value: PDFObject | undefined): number | null {
    return value instanceof PDFNumber ? value.asNumber() : null;
}

export function rotationOf(value: number | null): Rotation {
    if (value === null || !Number.isFinite(value) || !Number.isInteger(value) || value % 90 !== 0)
        return 0;
    return (((value % 360) + 360) % 360) as Rotation;
}

function sizeOf(context: PDFContext, box: PDFObject | undefined) {
    const array = resolve(context, box);
    if (!(array instanceof PDFArray) || array.size() !== 4) return DEFAULT_SIZE;
    const values = array.asArray().map((item) => numberOf(resolve(context, item)));
    if (values.some((value) => value === null)) return DEFAULT_SIZE;
    const [x1, y1, x2, y2] = values as number[];
    return { width: Math.abs(x2! - x1!), height: Math.abs(y2! - y1!) };
}

/*
 * Parses `bytes` and walks its pages. `onProgress` is called as parsing moves through the file and
 * as pages are walked, never from a timer, so a parser that stops moving lets the watchdog stop it.
 */
export async function readPdf(
    bytes: Uint8Array,
    { onProgress = () => {}, maxPages = PDF_TOOLS_MAX_PAGES } = {},
): Promise<SourcePdf> {
    // 500 objects a tick: pdf-lib yields between them, and the offset tells whether it moved on.
    const parser = PDFParser.forBytesWithOptions(bytes, 500);
    const offset = () => (parser as unknown as { bytes: { offset(): number } }).bytes.offset();
    let seen = -1;
    const ticker = setInterval(() => {
        const now = offset();
        if (now !== seen) onProgress();
        seen = now;
    }, 1000);
    let context: PDFContext;
    try {
        context = await parser.parseDocument();
    } catch {
        // pdf-lib's own refusals, and a stack overflowing on nesting it recursed into.
        throw new PdfRefused('damaged');
    } finally {
        clearInterval(ticker);
    }
    if (context.trailerInfo.Encrypt) throw new PdfRefused('encrypted');
    const catalog = resolve(context, context.trailerInfo.Root);
    if (!(catalog instanceof PDFDict)) throw new PdfRefused('damaged');
    const { pages, treeRefs } = walkPages(context, catalog, maxPages, onProgress);
    return {
        context,
        pages,
        flags: flagsOf(context, catalog),
        treeRefs,
        layers: layersOf(context, catalog),
    };
}

/*
 * The catalog's optional content: every group, and those off by its default configuration (/D):
 * with /BaseState /OFF, all but those listed /ON; otherwise those listed /OFF. Copied pages keep
 * their groups, so an output says the same groups are off, or a hidden layer would show.
 */
function layersOf(context: PDFContext, catalog: PDFDict): Layers | null {
    const properties = resolve(context, catalog.get(name('OCProperties')));
    if (!(properties instanceof PDFDict)) return null;
    const list = (value: PDFObject | undefined) => {
        const array = resolve(context, value);
        if (!(array instanceof PDFArray)) return [];
        return array.asArray().filter((item): item is PDFRef => item instanceof PDFRef);
    };
    const groups = list(properties.get(name('OCGs'))).filter(
        (ref) => context.lookup(ref) instanceof PDFDict,
    );
    if (groups.length === 0) return null;
    const config = resolve(context, properties.get(name('D')));
    const settings = config instanceof PDFDict ? config : null;
    const base = settings ? resolve(context, settings.get(name('BaseState'))) : undefined;
    const known = new Set(groups.map(tag));
    let off: Set<string>;
    if (base === name('OFF')) {
        const on = new Set(list(settings?.get(name('ON'))).map(tag));
        off = new Set([...known].filter((group) => !on.has(group)));
    } else {
        off = new Set(
            list(settings?.get(name('OFF')))
                .map(tag)
                .filter((group) => known.has(group)),
        );
    }
    return { groups, off };
}

/* A page's own /UserUnit: points in one unit of its boxes, a positive number, or 1. */
function userUnitOf(context: PDFContext, dict: PDFDict) {
    const unit = numberOf(resolve(context, dict.get(name('UserUnit'))));
    return unit !== null && Number.isFinite(unit) && unit > 0 ? unit : 1;
}

function walkPages(
    context: PDFContext,
    catalog: PDFDict,
    maxPages: number,
    onProgress: () => void,
) {
    const pages: PageNode[] = [];
    const treeRefs = new Set<string>();
    const seenDicts = new Set<PDFDict>();
    type Work = { node: PDFObject | undefined; inherited: Inherited; depth: number };
    const stack: Work[] = [{ node: catalog.get(name('Pages')), inherited: {}, depth: 0 }];
    while (stack.length) {
        const { node, inherited, depth } = stack.pop()!;
        if (depth > PAGE_TREE_MAX_DEPTH) throw new PdfRefused('damaged');
        const ref = node instanceof PDFRef ? node : null;
        if (ref) {
            if (treeRefs.has(tag(ref))) throw new PdfRefused('damaged');
            treeRefs.add(tag(ref));
        }
        const dict = resolve(context, node);
        if (!(dict instanceof PDFDict)) throw new PdfRefused('damaged');
        if (seenDicts.has(dict)) throw new PdfRefused('damaged');
        seenDicts.add(dict);
        const own: Inherited = { ...inherited };
        for (const key of INHERITED) {
            const value = dict.get(name(key));
            if (value !== undefined && value !== PDFNull) own[key] = value;
        }
        const type = resolve(context, dict.get(name('Type')));
        const kids = resolve(context, dict.get(name('Kids')));
        const isTree =
            type === name('Pages') || (type !== name('Page') && kids instanceof PDFArray);
        if (isTree) {
            if (!(kids instanceof PDFArray)) throw new PdfRefused('damaged');
            const items = kids.asArray();
            // Work waiting is bounded as pages are: past it, more pages than a run takes.
            if (stack.length + items.length > maxPages + PAGE_TREE_MAX_DEPTH)
                throw new PdfRefused('too-many-pages');
            for (let index = items.length - 1; index >= 0; index--)
                stack.push({ node: items[index], inherited: own, depth: depth + 1 });
            continue;
        }
        if (pages.length >= maxPages) throw new PdfRefused('too-many-pages');
        const box = sizeOf(context, own.MediaBox);
        const unit = userUnitOf(context, dict);
        const size = { width: box.width * unit, height: box.height * unit };
        pages.push({
            leaf: dict,
            ref,
            inherited: own,
            info: { ...size, rotate: rotationOf(numberOf(resolve(context, own.Rotate))) },
        });
        if (pages.length % 100 === 0) onProgress();
    }
    if (pages.length === 0) throw new PdfRefused('damaged');
    return { pages, treeRefs };
}

function flagsOf(context: PDFContext, catalog: PDFDict): PdfFlags {
    const outlines = resolve(context, catalog.get(name('Outlines')));
    const outline =
        outlines instanceof PDFDict &&
        resolve(context, outlines.get(name('First'))) instanceof PDFDict;
    const acroForm = resolve(context, catalog.get(name('AcroForm')));
    const fields =
        acroForm instanceof PDFDict ? resolve(context, acroForm.get(name('Fields'))) : undefined;
    const form = fields instanceof PDFArray && fields.size() > 0;
    return { signed: form && hasSignature(context, fields), outline, form };
}

/* A field, its /FT inherited from its parents, that is /Sig with a value holding /ByteRange. */
function hasSignature(context: PDFContext, fields: PDFArray) {
    type Work = { node: PDFObject; type: PDFObject | undefined; depth: number };
    const stack: Work[] = fields.asArray().map((node) => ({ node, type: undefined, depth: 0 }));
    const seen = new Set<PDFDict>();
    let looked = 0;
    while (stack.length && looked < FIELDS_MAX) {
        const { node, type, depth } = stack.pop()!;
        const field = resolve(context, node);
        if (!(field instanceof PDFDict) || seen.has(field) || depth > FIELD_MAX_DEPTH) continue;
        seen.add(field);
        looked++;
        const own = resolve(context, field.get(name('FT'))) ?? type;
        if (own === name('Sig')) {
            const value = resolve(context, field.get(name('V')));
            if (value instanceof PDFDict && value.has(name('ByteRange'))) return true;
        }
        const kids = resolve(context, field.get(name('Kids')));
        if (kids instanceof PDFArray)
            for (const kid of kids.asArray())
                stack.push({ node: kid, type: own, depth: depth + 1 });
    }
    return false;
}

/* One page of a new PDF: which source, which of its pages, and the rotation it is to have. */
export type PlannedPage = { source: number; page: number; rotate: Rotation };

/*
 * A new PDF of `planned` pages, copied from `sources` in that order. `onPage` after each page, so the
 * watchdog hears of a long build.
 */
export async function buildPdf(
    sources: readonly SourcePdf[],
    planned: readonly PlannedPage[],
    { onPage = () => {}, maxBytes = PDF_MAX_BYTES } = {},
) {
    if (planned.length === 0 || planned.length > PDF_TOOLS_MAX_PAGES)
        throw new Error('A PDF needs between one and the most pages.');
    const doc = await PDFDocument.create({ updateMetadata: false });
    const dest = doc.context;
    // Stream bytes copied so far, across sources: past the limit, refused before anything is saved.
    const written = { bytes: 0 };
    // Each output page's reference, made first, so a link from one copied page to another lands.
    const targets = planned.map(() => dest.nextRef());
    const copiers = sources.map((source, index) => {
        const pageRefs = new Map<string, PDFRef>();
        planned.forEach((page, at) => {
            if (page.source !== index) return;
            const ref = source.pages[page.page]?.ref;
            if (ref) pageRefs.set(tag(ref), targets[at]!);
        });
        return new Copier(source, dest, pageRefs, written, maxBytes);
    });
    for (const [at, page] of planned.entries()) {
        const source = sources[page.source];
        const node = source?.pages[page.page];
        if (!source || !node) throw new Error('A page asked for isn’t in its PDF.');
        const copier = copiers[page.source]!;
        const map = new Map<PDFName, PDFObject>();
        for (const [key, value] of node.leaf.entries()) {
            // The parent is the new tree; the resources are cut to what the page draws, below.
            if (key === name('Parent') || key === name('Resources')) continue;
            // A null inherited entry is absent: the tree's value, found by the walk, is copied below.
            if (INHERITED.some((inherited) => key === name(inherited)) && isNull(source, value))
                continue;
            map.set(key, copier.value(value, 0));
        }
        for (const key of INHERITED) {
            const value = node.inherited[key];
            if (key !== 'Resources' && value !== undefined && !map.has(name(key)))
                map.set(name(key), copier.value(value, 0));
        }
        // Only the resources this page's drawing names: never a shared dictionary's whole contents.
        const own = node.leaf.get(name('Resources'));
        const resources =
            own !== undefined && !isNull(source, own) ? own : node.inherited.Resources;
        if (resources !== undefined) {
            let pruned: PDFObject;
            try {
                pruned = prunedResources(
                    source.context,
                    resources,
                    node.leaf.get(name('Contents')),
                );
            } catch (error) {
                if (error instanceof Unreadable) throw new PdfRefused('damaged');
                throw error;
            }
            map.set(name('Resources'), copier.value(pruned, 0));
        }
        map.set(name('Type'), name('Page'));
        map.set(name('Rotate'), PDFNumber.of(page.rotate));
        copier.drain();
        const leaf = PDFPageLeaf.fromMapWithContext(map, dest, false);
        dest.assign(targets[at]!, leaf);
        doc.insertPage(at, PDFPage.of(leaf, targets[at]!, doc));
        onPage();
        await Promise.resolve();
    }
    // Every layer of a source a page came from, those off still off.
    const groups: PDFObject[] = [];
    const off: PDFObject[] = [];
    for (const [index, source] of sources.entries()) {
        if (!source.layers || !planned.some((page) => page.source === index)) continue;
        const copier = copiers[index]!;
        for (const group of source.layers.groups) {
            const copied = copier.ref(group);
            if (copied === PDFNull) continue;
            groups.push(copied);
            if (source.layers.off.has(tag(group))) off.push(copied);
        }
        copier.drain();
    }
    if (groups.length) {
        const settings = PDFDict.withContext(dest);
        settings.set(name('Order'), dest.obj(groups));
        if (off.length) settings.set(name('OFF'), dest.obj(off));
        const properties = PDFDict.withContext(dest);
        properties.set(name('OCGs'), dest.obj(groups));
        properties.set(name('D'), settings);
        doc.catalog.set(name('OCProperties'), properties);
    }
    const made = await doc.save({
        useObjectStreams: false,
        addDefaultPage: false,
        updateFieldAppearances: false,
    });
    if (made.byteLength > maxBytes) throw new PdfRefused('too-large');
    return made;
}

function isNull(source: SourcePdf, value: PDFObject) {
    const resolved = resolve(source.context, value);
    return resolved === undefined || resolved === PDFNull;
}

/* Copies objects of one source into the new document: each reference once, without recursing into references. */
class Copier {
    readonly #copied = new Map<string, PDFRef>();
    readonly #pending: { from: PDFRef; to: PDFRef }[] = [];

    constructor(
        private readonly source: SourcePdf,
        private readonly dest: PDFContext,
        /* Pages of this source in the output, by reference: links to them land on their copies. */
        private readonly pageRefs: Map<string, PDFRef>,
        /* Stream bytes copied into the output so far, across every source's copier, and the most allowed. */
        private readonly written: { bytes: number },
        private readonly maxBytes: number,
    ) {}

    value(object: PDFObject, depth: number): PDFObject {
        if (depth > NESTING_MAX_DEPTH) throw new PdfRefused('damaged');
        if (object instanceof PDFRef) return this.ref(object);
        if (object instanceof PDFDict) {
            const copy = PDFDict.withContext(this.dest);
            for (const [key, value] of object.entries())
                copy.set(key, this.value(value, depth + 1));
            return copy;
        }
        if (object instanceof PDFArray) {
            const copy = PDFArray.withContext(this.dest);
            for (const item of object.asArray()) copy.push(this.value(item, depth + 1));
            return copy;
        }
        if (object instanceof PDFStream) {
            const dict = this.value(object.dict, depth + 1) as PDFDict;
            const contents =
                object instanceof PDFRawStream ? object.contents : object.getContents();
            // Counted as copied: an output bound to pass its limit stops here, never in save().
            this.written.bytes += contents.byteLength;
            if (this.written.bytes > this.maxBytes) throw new PdfRefused('too-large');
            return PDFRawStream.of(dict, contents);
        }
        if (
            object instanceof PDFName ||
            object instanceof PDFNumber ||
            object instanceof PDFString ||
            object instanceof PDFHexString ||
            object instanceof PDFBool
        )
            return object.clone();
        // Null, and an object pdf-lib couldn't parse.
        return PDFNull;
    }

    ref(ref: PDFRef): PDFObject {
        const key = tag(ref);
        const page = this.pageRefs.get(key);
        if (page) return page;
        // Another page, or a node of the source's page tree: never copied (it would bring the tree).
        if (this.source.treeRefs.has(key)) return PDFNull;
        const known = this.#copied.get(key);
        if (known) return known;
        if (this.source.context.lookup(ref) === undefined) return PDFNull;
        const to = this.dest.nextRef();
        this.#copied.set(key, to);
        this.#pending.push({ from: ref, to });
        return to;
    }

    /* Copies every object referenced so far, and what they reference in turn. */
    drain() {
        while (this.#pending.length) {
            const { from, to } = this.#pending.pop()!;
            const object = this.source.context.lookup(from);
            this.dest.assign(to, object === undefined ? PDFNull : this.value(object, 0));
        }
    }
}
