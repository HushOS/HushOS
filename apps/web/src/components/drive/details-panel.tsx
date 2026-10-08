import { contentSize, tagsOf, type DriveNode } from '@hushos/drive/client';
import { useQuery } from '@tanstack/react-query';
import { ChevronDownIcon, DownloadIcon, PackageIcon, XIcon } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { CopyValue } from '@/components/copy-value';
import { AccessCell, useAccessIndex } from '@/components/drive/access';
import { FileMark } from '@/components/drive/file-mark';
import { TagStamps } from '@/components/drive/tag-stamp';
import { Button } from '@/components/ui/button';
import { toast } from '@/components/ui/toast';
import { driveClient, driveError, formatBytes, formatWhen } from '@/lib/drive';
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

/* A technical fact, read character by character and often copied: mono, and selectable. */
function Technical({ label, value, copy }: { label: string; value: string; copy?: boolean }) {
    return (
        <div className="border-b border-rule py-2 last:border-b-0">
            <dt className="text-xs font-semibold text-muted-foreground">{label}</dt>
            <dd className="mt-1.5 min-w-0 font-mono text-[11px] leading-relaxed wrap-anywhere select-text">
                {copy ? (
                    <CopyValue value={value} label={label} wrap className="text-[11px]" />
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
            const exported = await driveClient.exportKeys(node);
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
                    ? 'For keeping a copy outside HushOS: everything in this folder exactly as it is stored, still encrypted, and a key file that opens the folder’s names. Keep the two apart.'
                    : 'For keeping a copy outside HushOS: the file exactly as it is stored, still encrypted, and a key file that opens it. Keep the two apart. Anyone with both can open the file.'}
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
                    />
                    {keys.content && (
                        <>
                            <Technical label="Content key" value={keys.content.key} copy />
                            <Technical label="Content nonce" value={keys.content.nonce} copy />
                        </>
                    )}
                </dl>
            )}
        </>
    );
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
    const registry = useQuery(tagsQueryOptions).data ?? null;
    const tagIds = registry ? tagsOf(registry, node.id) : [];
    const version = node.kind === 'file' ? node.currentVersion : null;
    const size = contentSize(node);
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
                <Fact label="Changed">{formatWhen(node.metadata?.modified ?? node.updatedAt)}</Fact>
                <Fact label="Created">{formatWhen(node.createdAt)}</Fact>
                {location && <Fact label="Folder">{location}</Fact>}
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
            </dl>
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
    return (
        <aside
            aria-label="Details"
            data-details=""
            // Never taller than the room beneath the header and the folder's two lines, so opening a
            // section scrolls the panel and the page stays where it is.
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
