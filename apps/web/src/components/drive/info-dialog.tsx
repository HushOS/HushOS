import { contentSize, type DriveNode } from '@hushos/drive/client';
import { DownloadIcon, EyeIcon, EyeOffIcon } from 'lucide-react';
import { useState } from 'react';
import { CopyValue } from '@/components/copy-value';
import { PendingLabel } from '@/components/motion';
import { Button } from '@/components/ui/button';
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogHeader,
    DialogTitle,
} from '@/components/ui/dialog';
import { toast } from '@/components/ui/toast';
import { driveClient, driveError, formatBytes, formatWhen } from '@/lib/drive';
import { cue } from '@/lib/sounds';

/*
 * Everything the app knows about one item, and on request the keys that
 * protect it. The keys never leave the crypto worker until the person asks:
 * one click reveals them here, another saves them as a key file, so a file
 * can be decrypted without HushOS by anyone holding the file and the key.
 */
export function InfoDialog({
    node,
    open,
    onOpenChange,
}: {
    node: DriveNode | null;
    open: boolean;
    onOpenChange: (open: boolean) => void;
}) {
    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent className="sm:max-w-xl">
                {node && <Info key={node.id} node={node} />}
            </DialogContent>
        </Dialog>
    );
}

type Keys = Awaited<ReturnType<typeof driveClient.exportKeys>>;

function Row({ label, value, copy }: { label: string; value: string; copy?: boolean }) {
    return (
        <div className="grid border-b last:border-b-0 sm:grid-cols-[9rem_minmax(0,1fr)]">
            <span className="eyebrow flex items-center px-4 pt-2 text-muted-foreground sm:border-r sm:py-2.5">
                {label}
            </span>
            <div className="min-w-0 px-4 py-2 font-mono text-xs wrap-anywhere sm:py-2.5">
                {copy ? (
                    <CopyValue value={value} label={`Copy ${label.toLowerCase()}`} wrap />
                ) : (
                    value
                )}
            </div>
        </div>
    );
}

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

function Info({ node }: { node: DriveNode }) {
    const version = node.kind === 'file' ? node.currentVersion : null;
    const size = contentSize(node);
    const [keys, setKeys] = useState<Keys | null>(null);
    const [shown, setShown] = useState(false);
    const [pending, setPending] = useState(false);

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
            <DialogHeader>
                <DialogTitle className="wrap-anywhere">{node.name}</DialogTitle>
                <DialogDescription>
                    {node.kind === 'folder'
                        ? 'What the app knows about this folder, and the key that protects it.'
                        : 'What the app knows about this file, and the keys that protect it.'}
                </DialogDescription>
            </DialogHeader>
            <div className="border bg-card" data-info="details">
                <Row
                    label="Kind"
                    value={node.kind === 'folder' ? 'Folder' : (node.metadata?.mime ?? 'File')}
                />
                {version && (
                    <>
                        <Row label="Size" value={size === null ? 'Unknown' : formatBytes(size)} />
                        {(node.content?.thumbnailBytes ?? 0) > 0 && (
                            <Row
                                label="Thumbnail"
                                value={`${formatBytes(node.content!.thumbnailBytes)} · sealed inside this file's object`}
                            />
                        )}
                        <Row
                            label="Stored"
                            value={`${formatBytes(Number(version.ciphertextSize))} · ${version.chunkCount} ${version.chunkCount === 1 ? 'chunk' : 'chunks'} of ${formatBytes(version.chunkSize)}`}
                        />
                        <Row
                            label="Object"
                            value={`ws/${node.workspaceId}/${version.objectId}`}
                            copy
                        />
                        <Row label="Version" value={version.id} copy />
                        <Row
                            label="Status"
                            value={
                                version.objectStatus === 'ready'
                                    ? 'Stored and confirmed'
                                    : version.objectStatus === 'missing'
                                      ? 'Missing from the store'
                                      : 'Still uploading'
                            }
                        />
                    </>
                )}
                <Row
                    label="Modified"
                    value={formatWhen(node.metadata?.modified ?? node.updatedAt)}
                />
                <Row label="Created" value={formatWhen(node.createdAt)} />
                <Row label="Item id" value={node.id} copy />
                <Row label="Workspace" value={node.workspaceId} copy />
                <Row label="Key epoch" value={String(node.keyEpoch)} />
            </div>

            <div className="flex flex-col gap-3">
                <p className="text-sm leading-relaxed text-muted-foreground">
                    The keys below are what lock this item. They live only on your devices. Anyone
                    who has them and the stored bytes can read the{' '}
                    {node.kind === 'folder' ? 'names inside this folder' : 'file'} without HushOS,
                    so treat a key file like the file itself.
                </p>
                <div className="flex flex-wrap gap-2">
                    <Button variant="outline" disabled={pending} onClick={() => void reveal()}>
                        {shown ? <EyeOffIcon /> : <EyeIcon />}
                        <PendingLabel
                            pending={pending && !shown}
                            idle={shown ? 'Hide keys' : 'Reveal keys'}
                            busy="Opening"
                        />
                    </Button>
                    <Button variant="outline" disabled={pending} onClick={() => void save()}>
                        <DownloadIcon />
                        Download key file
                    </Button>
                </div>
                {shown && keys && (
                    <div className="border bg-card" data-info="keys">
                        <Row
                            label={node.kind === 'folder' ? 'Folder key' : 'File key'}
                            value={keys.nodeKey}
                            copy
                        />
                        {keys.content && (
                            <>
                                <Row label="Content key" value={keys.content.key} copy />
                                <Row label="Content nonce" value={keys.content.nonce} copy />
                            </>
                        )}
                    </div>
                )}
            </div>
        </>
    );
}
