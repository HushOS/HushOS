import { contentSize, tagsOf, type DriveNode } from '@hushos/drive/client';
import { integrityIssues, type IntegrityIssue } from '@hushos/drive/trust';
import { useQuery } from '@tanstack/react-query';
import { ChevronDownIcon, DownloadIcon, PackageIcon, XIcon } from 'lucide-react';
import { Fragment, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { CopyValue } from '@/components/copy-value';
import { AccessCell, useAccessIndex } from '@/components/drive/access';
import {
    SavedFromLinkLine,
    UnverifiedMark,
    useSignerNames,
} from '@/components/drive/unverified-mark';
import { useFamilyArea } from '@/components/drive/family-area';
import { FileMark } from '@/components/drive/file-mark';
import { TagStamps } from '@/components/drive/tag-stamp';
import { Button } from '@/components/ui/button';
import { toast } from '@/components/ui/toast';
import { useAuthView } from '@/lib/auth-view';
import {
    changedByLabel,
    changedByWords,
    droppedLines,
    rekeyedLines,
    rekeyTechnical,
    verifiedByLine,
    vouchedByLine,
} from '@/lib/integrity-lines';
import { clientFor, driveError, formatBytes, formatWhen, type driveClient } from '@/lib/drive';
import { extensionOf } from '@/lib/previews';
import { saveSealedCopy } from '@/lib/sealed-copy';
import { useSharpImage } from '@/lib/sharp-image';
import { cue } from '@/lib/sounds';
import { tagsQueryOptions } from '@/lib/tags';
import { useThumbnail } from '@/lib/thumbnails';

/*
 * Everything the app knows about one item, and on request the keys that
 * protect it. The everyday facts come first; the identifiers, and the ways
 * to keep a copy that reads without HushOS, sit folded beneath them. The keys
 * never leave the crypto worker until the person asks: one click reveals them
 * here, another saves them as a key file.
 *
 * The same content is a panel docked beside the list on a wide screen and a
 * dialog on a narrow one (see info-dialog.tsx).
 */

type Keys = Awaited<ReturnType<typeof driveClient.exportKeys>>;

export type ItemDetailsProps = {
    node: DriveNode;
    /* Where the name goes: a heading in the panel, the dialog's title in the dialog. */
    heading: (name: string) => ReactNode;
    /* The path of folders the item sits in, where the caller knows it. */
    location?: string | undefined;
    /* Opens the tag editor for this item; absent for an item that cannot be tagged here. */
    onTags?: ((node: DriveNode) => void) | undefined;
    /* Opens sharing for this item; absent for an item that is someone else's. */
    onShare?: ((node: DriveNode) => void) | undefined;
    /* Whether a folder above it is shared, so it opens to the same people. */
    inherited?: boolean | undefined;
    /* The name above the preview: a dialog's title shares its row with the close button. */
    nameFirst?: boolean | undefined;
};

/* The key file: enough to decrypt the object without HushOS, and nothing about anyone else. */
function keyFile(node: DriveNode, keys: Keys) {
    const version = node.kind === 'file' ? node.currentVersion : null;
    return {
        format: 'hushos-keys',
        version: 2,
        node: {
            id: node.id,
            workspaceId: node.workspaceId,
            kind: node.kind,
            name: node.name,
            keyEpoch: keys.keyEpoch,
            key: keys.nodeKey,
        },
        content:
            version && keys.content
                ? {
                      versionId: version.id,
                      objectId: version.objectId,
                      objectPath: `ws/${node.workspaceId}/${version.objectId}`,
                      suite: version.contentSuite,
                      cipher: 'xchacha20poly1305-ietf',
                      chunkSize: version.chunkSize,
                      chunkCount: version.chunkCount,
                      plaintextSize: keys.content.plaintextSize,
                      ciphertextSize: version.ciphertextSize,
                      key: keys.content.key,
                      nonce: keys.content.nonce,
                      /* The trailer after the last chunk, under a key derived from the content key. */
                      thumbnail: keys.content.thumbnailBytes
                          ? {
                                bytes: keys.content.thumbnailBytes,
                                nonceIndex: version.chunkCount,
                                keyDerivation:
                                    'libsodium crypto_kdf_derive_from_key(32, 1, "hushthmb", key)',
                            }
                          : null,
                  }
                : null,
        encoding: 'base64url',
        exportedAt: new Date().toISOString(),
    };
}

function typeOf(node: DriveNode) {
    if (node.kind === 'folder') return 'Folder';
    const extension = extensionOf(node.name);
    return extension ? `${extension.toUpperCase()} file` : 'File';
}

/* An everyday fact: the label on the left, the value beside it. */
function Fact({ label, children }: { label: string; children: ReactNode }) {
    return (
        <>
            <dt className="text-muted-foreground">{label}</dt>
            <dd className="min-w-0 tabular-nums wrap-anywhere">{children}</dd>
        </>
    );
}

const capitalised = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

/*
 * A person's words with any address in them breaking where it reads well: between words, then
 * before the @, and inside the part before it only when that alone is wider than the column,
 * never first at the hyphens a generated address is full of.
 */
function PersonWords({ text }: { text: string }) {
    const parts = text.split(/(\(?[^\s()]+@[^\s()]+\)?)/);
    return parts.map((part, index) => {
        const at = index % 2 === 1 ? part.lastIndexOf('@') : -1;
        if (at < 0) return part;
        return (
            <Fragment key={index}>
                <span className="inline-block max-w-full wrap-anywhere">{part.slice(0, at)}</span>
                <wbr />
                <span className="inline-block max-w-full wrap-anywhere">{part.slice(at)}</span>
            </Fragment>
        );
    });
}

/* A technical fact, read character by character and often copied: mono, and selectable. */
function Technical({
    label,
    value,
    copy,
    secret,
}: {
    label: string;
    value: string;
    copy?: boolean;
    secret?: boolean;
}) {
    return (
        <div className="border-b border-rule py-2 last:border-b-0">
            <dt className="text-xs font-semibold text-muted-foreground">{label}</dt>
            <dd className="mt-1.5 min-w-0 font-mono text-[11px] leading-relaxed wrap-anywhere select-text">
                {copy ? (
                    <CopyValue
                        value={value}
                        label={label}
                        wrap
                        secret={secret}
                        className="text-[11px]"
                    />
                ) : (
                    value
                )}
            </dd>
        </div>
    );
}

/* A closed section for what most people never need. */
function Fold({ title, name, children }: { title: string; name: string; children: ReactNode }) {
    return (
        <details data-info={name} className="group border-b border-rule last:border-b-0">
            <summary className="flex h-11 cursor-pointer list-none items-center gap-2 px-3 text-sm font-semibold select-none [&::-webkit-details-marker]:hidden">
                <span className="flex-1">{title}</span>
                <span className="text-xs font-normal text-muted-foreground">For experts</span>
                <ChevronDownIcon
                    aria-hidden="true"
                    className="size-4 text-muted-foreground transition-transform group-open:rotate-180"
                />
            </summary>
            <div className="flex flex-col gap-3 border-t border-rule p-3">{children}</div>
        </details>
    );
}

/* A panel-sized look needs more than a thumbnail gives a dense screen; past this the thumbnail stands. */
const SHARP_PREVIEW_LIMIT = 16 * 1024 * 1024;

function Preview({ node }: { node: DriveNode }) {
    const thumbnail = useThumbnail(node);
    const sharp = useSharpImage(node, SHARP_PREVIEW_LIMIT);
    const source = sharp.url ?? thumbnail;
    return (
        <div className="flex h-40 items-center justify-center overflow-hidden rounded-xl bg-muted">
            {source ? (
                <img
                    src={source}
                    alt=""
                    draggable={false}
                    className="size-full object-contain"
                    onError={sharp.onError}
                />
            ) : (
                <FileMark node={node} size="large" />
            )}
        </div>
    );
}

/* The keys and the sealed copy. Keyed by item where it is used, so one item's keys never show under another's name. */
function OwnCopy({ node }: { node: DriveNode }) {
    const [keys, setKeys] = useState<Keys | null>(null);
    const [shown, setShown] = useState(false);
    const [pending, setPending] = useState(false);
    const [packing, setPacking] = useState(false);

    async function load() {
        if (keys) return keys;
        setPending(true);
        try {
            const exported = await clientFor(node.workspaceId).exportKeys(node);
            setKeys(exported);
            return exported;
        } catch (error) {
            cue('error');
            toast.add({
                type: 'error',
                title: 'Keys not available',
                description: driveError(error),
            });
            return null;
        } finally {
            setPending(false);
        }
    }
    async function reveal() {
        if (shown) {
            setShown(false);
            return;
        }
        if (await load()) setShown(true);
    }
    async function sealedCopy() {
        setPacking(true);
        try {
            const name = await saveSealedCopy(node);
            cue('success', { volume: 0.4 });
            toast.add({ type: 'success', title: 'Sealed copy saved', description: name });
        } catch (error) {
            cue('error');
            toast.add({
                type: 'error',
                title: 'Couldn’t save the sealed copy',
                description: driveError(error),
            });
        } finally {
            setPacking(false);
        }
    }
    async function save() {
        const exported = await load();
        if (!exported) return;
        const blob = new Blob([JSON.stringify(keyFile(node, exported), null, 4)], {
            type: 'application/json',
        });
        const url = URL.createObjectURL(blob);
        const anchor = document.createElement('a');
        anchor.href = url;
        anchor.download = `${node.name}.keys.json`;
        anchor.click();
        setTimeout(() => URL.revokeObjectURL(url), 10_000);
        cue('success', { volume: 0.4 });
    }

    // One line says what the two downloads are for; the raw keys are a link away.
    return (
        <>
            <p className="text-[13px] leading-snug text-muted-foreground">
                {node.kind === 'folder'
                    ? 'For keeping a copy outside HushOS: everything in this folder exactly as it is stored, still encrypted, and a key file that opens all of it, names and files. Keep the two apart. Both are saved under the folder’s name.'
                    : 'For keeping a copy outside HushOS: the file exactly as it is stored, still encrypted, and a key file that opens it. Keep the two apart. Anyone with both can open the file. Both are saved under the file’s name.'}
            </p>
            <div className="flex flex-wrap gap-2">
                <Button variant="outline" size="sm" disabled={pending} onClick={() => void save()}>
                    <DownloadIcon />
                    Download key file
                </Button>
                {/* The label stays put: a small copy is packed faster than a swap could be read. */}
                <Button
                    variant="outline"
                    size="sm"
                    disabled={packing}
                    onClick={() => void sealedCopy()}
                >
                    <PackageIcon />
                    Download sealed copy
                </Button>
            </div>
            <button
                type="button"
                disabled={pending}
                onClick={() => void reveal()}
                className="w-fit cursor-pointer text-[13px] font-semibold text-primary underline underline-offset-2 hover:text-primary-hover disabled:cursor-default disabled:opacity-60"
            >
                {shown ? 'Hide keys' : pending ? 'Opening keys' : 'Show keys'}
            </button>
            {shown && keys && (
                <dl data-info="keys" className="rounded-md bg-muted px-3">
                    <Technical
                        label={node.kind === 'folder' ? 'Folder key' : 'File key'}
                        value={keys.nodeKey}
                        copy
                        secret
                    />
                    {keys.content && (
                        <>
                            <Technical label="Content key" value={keys.content.key} copy secret />
                            <Technical label="Content nonce" value={keys.content.nonce} copy />
                        </>
                    )}
                </dl>
            )}
        </>
    );
}

/* Who wrote what did not verify, as this person can name them: from their own pins only. */
function ChangedBy({ issue }: { issue: IntegrityIssue }) {
    const userId = useAuthView((state) => state.unlockedUserId);
    return <span>{changedByWords(issue, useSignerNames(userId, true))}</span>;
}

export function ItemDetails({
    node,
    heading,
    location,
    onTags,
    onShare,
    inherited = false,
    nameFirst = false,
}: ItemDetailsProps) {
    const access = useAccessIndex(Boolean(onShare));
    // A family folder's items: no tags here yet (they are one's own registry's), and the
    // family's word on who wrote them.
    const area = useFamilyArea();
    const registry = useQuery({ ...tagsQueryOptions, enabled: !area }).data ?? null;
    const tagIds = registry ? tagsOf(registry, node.id) : [];
    const userId = useAuthView((state) => state.unlockedUserId);
    const names = useSignerNames(userId, true);
    // In a family folder the verdict says whose word vouched (`via`); elsewhere a writer pinned
    // on a family's word does.
    const verifiedBy = area
        ? verifiedByLine(node, { groupId: area.groupId, name: area.family }, names.vouchers)
        : vouchedByLine(node, names);
    const version = node.kind === 'file' ? node.currentVersion : null;
    const size = contentSize(node);
    const unverified = integrityIssues(node);
    // A re-keyed item names both people: who wrote it and who locked it again.
    const rekeyed = rekeyedLines(node, names);
    const dropped = droppedLines(node, names);
    const notes = node.integrity?.rekeyed;
    const status =
        version === null
            ? null
            : version.objectStatus === 'ready'
              ? 'Stored and confirmed'
              : version.objectStatus === 'missing'
                ? 'Missing from the store'
                : 'Still uploading';

    return (
        <div className="flex min-w-0 flex-col gap-4">
            {nameFirst && heading(node.name)}
            <Preview node={node} />
            {!nameFirst && heading(node.name)}
            {onShare && (
                <div className="flex flex-col gap-1.5 rounded-xl bg-muted px-3.5 py-3">
                    <span className="text-xs font-semibold text-muted-foreground">
                        Who can open
                    </span>
                    <AccessCell access={access.get(node.id)} inherited={inherited} detail />
                    <button
                        type="button"
                        onClick={() => onShare(node)}
                        className="cursor-pointer self-start text-[13px] font-semibold text-primary underline underline-offset-2 hover:text-primary-hover"
                    >
                        Change who can open
                    </button>
                </div>
            )}
            <dl
                data-info="details"
                className="grid grid-cols-[6.5rem_minmax(0,1fr)] gap-x-4 gap-y-2.5 text-sm"
            >
                <Fact label="Kind">{typeOf(node)}</Fact>
                {version && (
                    <Fact label="Size">{size === null ? 'Unknown' : formatBytes(size)}</Fact>
                )}
                {/*
                 * Two events on two clocks: Changed is the file's own last change, as the
                 * uploader's device dated it (sealed with its name); Added is when it reached
                 * HushOS, on the server's clock. Not "Created": the content usually changed
                 * before it was added.
                 */}
                <Fact label="Changed">{formatWhen(node.metadata?.modified ?? node.updatedAt)}</Fact>
                <Fact label="Added">{formatWhen(node.createdAt)}</Fact>
                {location && <Fact label="Folder">{location}</Fact>}
                {/* Only when something did not verify: a verified item says nothing about it. */}
                {unverified.length > 0 && (
                    <Fact label={changedByLabel(unverified[0]!)}>
                        <span className="inline-flex flex-wrap items-center gap-2">
                            <ChangedBy issue={unverified[0]!} />
                            <UnverifiedMark node={node} />
                        </span>
                    </Fact>
                )}
                {rekeyed.writtenBy && unverified.length === 0 && (
                    <Fact label="Written by">
                        <span data-written-by>
                            <PersonWords text={rekeyed.writtenBy} />
                        </span>
                    </Fact>
                )}
                {/* Who locked it again, as a fact beside the others rather than a line under them. */}
                {rekeyed.replacedBy.length > 0 && (
                    <Fact label="Keys replaced by">
                        <span data-keys-replaced className="flex flex-col">
                            {rekeyed.replacedBy.map((line) => (
                                <span key={line}>
                                    <PersonWords
                                        text={capitalised(line.replace(/^Keys replaced by /, ''))}
                                    />
                                </span>
                            ))}
                        </span>
                    </Fact>
                )}
                {verifiedBy && (
                    <Fact label="Checked">
                        <span data-verified-by>{verifiedBy}</span>
                    </Fact>
                )}
                {version && version.objectStatus !== 'ready' && (
                    <Fact label="Status">
                        <span
                            className={
                                version.objectStatus === 'missing'
                                    ? 'font-semibold text-destructive'
                                    : undefined
                            }
                        >
                            {version.objectStatus === 'missing'
                                ? 'Missing. Upload it again, or move it to Trash.'
                                : 'Still uploading'}
                        </span>
                    </Fact>
                )}
                {!area && (
                    <>
                        <dt className="pt-0.5 text-muted-foreground">Tags</dt>
                        <dd className="flex min-w-0 flex-wrap items-center gap-1.5">
                            {tagIds.length ? (
                                <TagStamps
                                    tagIds={tagIds}
                                    registry={registry}
                                    itemName={node.name}
                                    max={16}
                                    className="flex-wrap"
                                />
                            ) : (
                                <span>None</span>
                            )}
                            {onTags && (
                                <button
                                    type="button"
                                    className="cursor-pointer text-[13px] font-semibold text-primary underline underline-offset-2 hover:text-primary-hover"
                                    onClick={() => onTags(node)}
                                >
                                    Edit
                                </button>
                            )}
                        </dd>
                    </>
                )}
            </dl>
            <SavedFromLinkLine node={node} />
            {dropped.map((line) => (
                <p key={line} data-origin-dropped className="text-[13px] text-muted-foreground">
                    {line}
                </p>
            ))}
            <div className="rounded-xl border border-rule">
                <Fold title="Keep your own copy" name="own-copy">
                    <OwnCopy key={node.id} node={node} />
                </Fold>
                <Fold title="Technical details" name="technical">
                    <dl>
                        <Technical
                            label="Kind"
                            value={
                                node.kind === 'folder' ? 'Folder' : (node.metadata?.mime ?? 'File')
                            }
                        />
                        {version && (
                            <>
                                {(node.content?.thumbnailBytes ?? 0) > 0 && (
                                    <Technical
                                        label="Thumbnail"
                                        value={`${formatBytes(node.content!.thumbnailBytes)} · sealed inside this file's object`}
                                    />
                                )}
                                <Technical
                                    label="Stored"
                                    value={`${formatBytes(Number(version.ciphertextSize))} · ${version.chunkCount} ${version.chunkCount === 1 ? 'chunk' : 'chunks'} of ${formatBytes(version.chunkSize)}`}
                                />
                                <Technical
                                    label="Object"
                                    value={`ws/${node.workspaceId}/${version.objectId}`}
                                    copy
                                />
                                <Technical label="Version" value={version.id} copy />
                                <Technical label="Status" value={status!} />
                            </>
                        )}
                        {notes?.metadata && (
                            <>
                                <Technical
                                    label="Written by"
                                    value={notes.metadata.writer?.id ?? 'Not named'}
                                    copy={Boolean(notes.metadata.writer)}
                                />
                                <Technical
                                    label="Keys replaced by"
                                    value={notes.metadata.by?.id ?? 'Not named'}
                                    copy={Boolean(notes.metadata.by)}
                                />
                                <Technical
                                    label="Key change"
                                    value={rekeyTechnical(notes.metadata)}
                                />
                            </>
                        )}
                        {notes?.version && (
                            <Technical
                                label="Version key change"
                                value={rekeyTechnical(notes.version)}
                            />
                        )}
                        <Technical label="Item id" value={node.id} copy />
                        <Technical label="Workspace" value={node.workspaceId} copy />
                        <Technical label="Key epoch" value={String(node.keyEpoch)} />
                    </dl>
                </Fold>
            </div>
        </div>
    );
}

/*
 * The panel beside the list. It stays open as the selection moves and follows
 * the one selected item; with none or several there is nothing to describe.
 * The caller places it; it keeps to the viewport and scrolls on its own.
 */
export function DetailsPanel({
    node,
    onClose,
    ...details
}: Omit<ItemDetailsProps, 'node' | 'heading'> & {
    node: DriveNode | null;
    onClose: () => void;
}) {
    const panel = useRef<HTMLElement>(null);
    const fitRef = useRef<() => void>(() => {});
    /*
     * Never taller than the room between where the panel starts and the foot of the page, so
     * opening a section scrolls the panel and the page stays where it is. Where it starts depends
     * on what sits above the list (a folder's notice, an access banner) and on how far the page
     * has scrolled before the panel sticks, so it is measured rather than assumed. The selection
     * bar's wrapper is kept out too: the panel ends above the bar, which floats across the page,
     * and on a short list the panel would otherwise make the page scroll, scrolling would let it
     * grow, and so on.
     */
    useLayoutEffect(() => {
        const element = panel.current;
        if (!element) return;
        const sheet = element.closest<HTMLElement>('[data-scroll-restoration-id="app-sheet"]');
        let frame = 0;
        const fit = () => {
            const bottom = sheet?.getBoundingClientRect().bottom ?? window.innerHeight;
            const top = Math.max(element.getBoundingClientRect().top, 0);
            const bar = (sheet ?? document).querySelector<HTMLElement>('[data-selection-room]');
            // The floating bar's top, from the foot of the sheet: the wrapper's sticky offset plus its
            // height, less its top padding (the gap above the bar, which the panel may use).
            let below = 0;
            if (bar) {
                const style = getComputedStyle(bar);
                below =
                    (parseFloat(style.bottom) || 0) +
                    bar.offsetHeight -
                    (parseFloat(style.paddingTop) || 0);
            }
            // 12px below it, as beside and above it; 20px above the floating bar, so its shadow
            // and the panel's never meet.
            const room = Math.floor(bottom - top - (bar ? 20 : 12) - below);
            element.style.maxHeight = `${Math.max(room, 160)}px`;
        };
        fitRef.current = fit;
        const schedule = () => {
            cancelAnimationFrame(frame);
            frame = requestAnimationFrame(fit);
        };
        fit();
        const scroller = sheet ?? window;
        scroller.addEventListener('scroll', schedule, { passive: true });
        window.addEventListener('resize', schedule);
        // A notice appearing or going above the list moves the panel without any scroll. The
        // view keeps at least the sheet's height, so on a short list the notice shrinks the row
        // the panel sits in (it fills the rest) rather than the view: both are watched.
        const observer = new ResizeObserver(schedule);
        for (const box of [element.parentElement, element.parentElement?.parentElement])
            if (box) observer.observe(box);
        return () => {
            cancelAnimationFrame(frame);
            scroller.removeEventListener('scroll', schedule);
            window.removeEventListener('resize', schedule);
            observer.disconnect();
        };
    }, []);
    // A selection made or cleared brings the bar's wrapper or takes it away: measured again.
    useLayoutEffect(() => fitRef.current());
    return (
        <aside
            ref={panel}
            aria-label="Details"
            data-details=""
            className="sticky top-3 m-3 ml-0 flex max-h-[calc(100svh-12.5rem)] w-[320px] shrink-0 transform-gpu flex-col self-start overflow-y-auto overscroll-contain rounded-2xl border border-rule bg-card text-card-foreground shadow-md will-change-transform"
        >
            <div className="flex items-center justify-between gap-2 py-2 pr-2 pl-4">
                <p className="text-sm font-semibold text-muted-foreground">Info</p>
                <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label="Close details"
                    title="Close"
                    onClick={onClose}
                >
                    <XIcon />
                </Button>
            </div>
            <div className="px-4 pb-4">
                {node ? (
                    <ItemDetails
                        node={node}
                        heading={(name) => (
                            <h2 className="text-lg leading-snug font-bold tracking-[-0.01em] wrap-anywhere">
                                {name}
                            </h2>
                        )}
                        {...details}
                    />
                ) : (
                    <p className="py-6 text-sm text-muted-foreground">
                        Select one item to see its info.
                    </p>
                )}
            </div>
        </aside>
    );
}
