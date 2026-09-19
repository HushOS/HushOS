import { contentSize, tagsOf, type DriveNode } from '@hushos/drive/client';
import { useQuery } from '@tanstack/react-query';
import {
    ChevronRightIcon,
    DownloadIcon,
    EyeIcon,
    EyeOffIcon,
    PackageIcon,
    Share2Icon,
    XIcon,
} from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { CopyValue } from '@/components/copy-value';
import { FileMark } from '@/components/drive/file-mark';
import { TagStamps } from '@/components/drive/tag-stamp';
import { PendingLabel } from '@/components/motion';
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

/* An everyday fact: the key, a dotted leader beneath, the value at the right. */
function Fact({ label, children }: { label: string; children: ReactNode }) {
    return (
        <div className="flex items-baseline justify-between gap-4 border-b border-dotted border-rule py-2">
            <dt className="eyebrow shrink-0 text-muted-foreground">{label}</dt>
            <dd className="min-w-0 text-right text-sm tabular-nums wrap-anywhere">{children}</dd>
        </div>
    );
}

/* A technical fact, read character by character and often copied: mono, and selectable. */
function Technical({ label, value, copy }: { label: string; value: string; copy?: boolean }) {
    return (
        <div className="border-b border-dotted border-rule py-2 last:border-b-0">
            <dt className="eyebrow text-muted-foreground">{label}</dt>
            <dd className="mt-1.5 min-w-0 font-mono text-[11px] leading-relaxed wrap-anywhere select-text">
                {copy ? (
                    <CopyValue
                        value={value}
                        label={`Copy ${label.toLowerCase()}`}
                        wrap
                        className="text-[11px]"
                    />
                ) : (
                    value
                )}
            </dd>
        </div>
    );
}

function Fold({ title, name, children }: { title: string; name: string; children: ReactNode }) {
    return (
        <details data-info={name} className="group border-t border-rule">
            <summary className="flex cursor-pointer list-none items-center gap-1.5 py-3 text-sm font-medium select-none [&::-webkit-details-marker]:hidden">
                <ChevronRightIcon
                    aria-hidden="true"
                    className="size-3.5 text-muted-foreground transition-transform group-open:rotate-90"
                />
                {title}
            </summary>
            <div className="flex flex-col gap-3 pb-4">{children}</div>
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
        <div className="flex h-36 items-center justify-center overflow-hidden rounded-xs">
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
                title: 'The sealed copy was not saved',
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

    return (
        <>
            <p className="text-sm leading-relaxed text-muted-foreground">
                The keys below are what lock this item. They live only on your devices. Anyone who
                has them and the stored bytes can read the{' '}
                {node.kind === 'folder' ? 'names inside this folder' : 'file'} without HushOS, so
                treat a key file like the file itself.
            </p>
            <div className="flex flex-wrap gap-2">
                <Button
                    variant="outline"
                    size="sm"
                    disabled={pending}
                    onClick={() => void reveal()}
                >
                    {shown ? <EyeOffIcon /> : <EyeIcon />}
                    <PendingLabel
                        pending={pending && !shown}
                        idle={shown ? 'Hide keys' : 'Reveal keys'}
                        busy="Opening"
                    />
                </Button>
                <Button variant="outline" size="sm" disabled={pending} onClick={() => void save()}>
                    <DownloadIcon />
                    Download key file
                </Button>
            </div>
            {shown && keys && (
                <dl data-info="keys" className="rounded-xs bg-muted px-3">
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
            <p className="text-sm leading-relaxed text-muted-foreground">
                A sealed copy is this {node.kind === 'folder' ? 'folder' : 'file'} exactly as the
                service holds it: the stored bytes, still encrypted, and every record's envelopes,
                with no key and no name in the clear. Keep it offline; with the key file it reads
                without HushOS.
            </p>
            <div>
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
        </>
    );
}

export function ItemDetails({ node, heading, location, onTags, onShare }: ItemDetailsProps) {
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
            <Preview node={node} />
            {heading(node.name)}
            <dl data-info="details">
                <Fact label="Type">{typeOf(node)}</Fact>
                {version && (
                    <Fact label="Size">{size === null ? 'Unknown' : formatBytes(size)}</Fact>
                )}
                <Fact label="Modified">
                    {formatWhen(node.metadata?.modified ?? node.updatedAt)}
                </Fact>
                <Fact label="Created">{formatWhen(node.createdAt)}</Fact>
                {location && <Fact label="Location">{location}</Fact>}
                {version && version.objectStatus !== 'ready' && (
                    <Fact label="Status">{status}</Fact>
                )}
                <div className="flex items-baseline justify-between gap-4 border-b border-dotted border-rule py-2">
                    <dt className="eyebrow shrink-0 text-muted-foreground">Tags</dt>
                    <dd className="flex min-w-0 flex-wrap items-center justify-end gap-2">
                        {tagIds.length ? (
                            <TagStamps
                                tagIds={tagIds}
                                registry={registry}
                                itemName={node.name}
                                max={16}
                                className="flex-wrap justify-end"
                            />
                        ) : (
                            <span className="text-sm text-muted-foreground">None</span>
                        )}
                        {onTags && (
                            <button
                                type="button"
                                className="text-link cursor-pointer text-xs"
                                onClick={() => onTags(node)}
                            >
                                Edit
                            </button>
                        )}
                    </dd>
                </div>
            </dl>
            {onShare && (
                <Button className="self-start" size="sm" onClick={() => onShare(node)}>
                    <Share2Icon />
                    Share
                </Button>
            )}
            <div>
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
            className="sticky top-3 m-3 ml-0 flex transform-gpu will-change-transform max-h-[calc(100svh-12.5rem)] w-[300px] shrink-0 flex-col self-start overflow-y-auto overscroll-contain rounded-xs bg-popover text-popover-foreground shadow-overlay"
        >
            <div className="flex items-center justify-between gap-2 py-2 pr-2 pl-4">
                <p className="eyebrow text-muted-foreground">Details</p>
                <Button variant="ghost" size="icon-sm" aria-label="Close details" onClick={onClose}>
                    <XIcon />
                </Button>
            </div>
            <div className="px-4 pb-4">
                {node ? (
                    <ItemDetails
                        node={node}
                        heading={(name) => (
                            <h2 className="text-lg leading-snug font-bold wrap-anywhere">{name}</h2>
                        )}
                        {...details}
                    />
                ) : (
                    <p className="py-6 text-sm text-muted-foreground">
                        Select one item to see its details
                    </p>
                )}
            </div>
        </aside>
    );
}
