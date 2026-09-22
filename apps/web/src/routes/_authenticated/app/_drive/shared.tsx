import { createFileRoute, Link } from '@tanstack/react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ShieldAlertIcon, Trash2Icon } from 'lucide-react';
import { useEffect, useState } from 'react';
import { FileMark } from '@/components/drive/file-mark';
import { LinkRow } from '@/components/drive/link-row';
import { Preview } from '@/components/drive/preview';
import { Spinner } from '@/components/motion';
import { PageHeader } from '@/components/page-header';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { toast } from '@/components/ui/toast';
import {
    driveClient,
    driveError,
    driveKeys,
    formatWhen,
    mySharingQueryOptions,
    sharedQueryOptions,
} from '@/lib/drive';
import { downloadNodes } from '@/lib/downloads';
import type { DriveNode } from '@hushos/drive/client';
import { rotateAfterRevoke } from '@/lib/rotation';
import { cue } from '@/lib/sounds';

export const Route = createFileRoute('/_authenticated/app/_drive/shared')({
    validateSearch: (search: Record<string, unknown>): { view?: 'by-me' } =>
        search.view === 'by-me' ? { view: 'by-me' } : {},
    head: () => ({ meta: [{ title: 'Shared · HushOS' }] }),
    component: SharedPage,
});

/*
 * One place for sharing in both directions. "With me": what other people
 * gave this person a key to, each a root of its own. "By me": every account
 * share and every link this person has out, with the means to stop each.
 */
function SharedPage() {
    return (
        <>
            <Shared />
        </>
    );
}

/* A small segmented control: the chosen direction takes the sheet's colour in a quiet tray. */
const tab = 'flex h-8 items-center rounded-xs px-3.5 text-[13px] font-semibold transition-colors';
const tabChosen = 'bg-card text-foreground';
const tabIdle = 'text-muted-foreground hover:text-foreground';

function Shared() {
    const { view } = Route.useSearch();
    const byMe = view === 'by-me';
    const queryClient = useQueryClient();
    // The other tab's list is fetched alongside the open one, so switching shows it at once.
    useEffect(() => {
        if (byMe) void queryClient.prefetchQuery(sharedQueryOptions);
        else void queryClient.prefetchQuery(mySharingQueryOptions);
    }, [queryClient, byMe]);
    return (
        <div className="flex flex-1 flex-col">
            <PageHeader
                eyebrow="Workspace"
                title="Shared"
                description="Files and folders people have shared with you, and what you have shared with others by account or by link."
            >
                <div
                    role="tablist"
                    aria-label="Direction"
                    className="flex self-start rounded-md bg-muted p-0.5"
                >
                    <Link
                        to="/app/shared"
                        search={{}}
                        role="tab"
                        aria-selected={!byMe}
                        className={`${tab} ${byMe ? tabIdle : tabChosen}`}
                    >
                        With me
                    </Link>
                    <Link
                        to="/app/shared"
                        search={{ view: 'by-me' }}
                        role="tab"
                        aria-selected={byMe}
                        className={`${tab} ${byMe ? tabChosen : tabIdle}`}
                    >
                        By me
                    </Link>
                </div>
            </PageHeader>
            {byMe ? <ByMe /> : <WithMe />}
        </div>
    );
}

function Loading() {
    return (
        <div className="flex flex-1 items-center justify-center py-24 text-muted-foreground">
            <Spinner />
        </div>
    );
}
function Failed({ error }: { error: unknown }) {
    return (
        <div className="px-5 py-6 sm:px-8">
            <Alert variant="destructive">
                <AlertTitle>Could not load</AlertTitle>
                <AlertDescription>{driveError(error)}</AlertDescription>
            </Alert>
        </div>
    );
}
function Empty({ children }: { children: string }) {
    return (
        <p className="max-w-xl px-5 py-8 text-sm leading-relaxed text-muted-foreground sm:px-8">
            {children}
        </p>
    );
}

/* A shared file has no folder to open it from: its name opens the same viewer a folder row would. */
function FileButton({ node, onOpen }: { node: DriveNode; onOpen: (node: DriveNode) => void }) {
    return (
        <button
            type="button"
            className="cursor-pointer text-left text-sm font-medium wrap-anywhere hover:underline"
            onClick={() => onOpen(node)}
        >
            {node.name}
        </button>
    );
}

function WithMe() {
    const shares = useQuery(sharedQueryOptions);
    const [previewing, setPreviewing] = useState<DriveNode | null>(null);
    if (shares.isPending) return <Loading />;
    if (shares.isError) return <Failed error={shares.error} />;
    if (shares.data.length === 0) return <Empty>Nothing shared with you yet.</Empty>;
    const files = shares.data.flatMap((share) =>
        share.node.kind === 'file' && !share.error ? [share.node] : [],
    );
    return (
        <ul className="divide-y divide-rule border-b border-rule">
            {shares.data.map((share) => (
                <li
                    key={share.id}
                    data-shared={share.node.name}
                    className="flex min-h-[46px] flex-wrap items-center gap-x-3.5 gap-y-2 px-5 py-2 transition-colors hover:bg-muted sm:px-8"
                >
                    <span className="flex w-[30px] shrink-0 justify-center">
                        {share.error ? (
                            <FileMark kind={share.node.kind} name={share.node.name} />
                        ) : (
                            <FileMark node={share.node} />
                        )}
                    </span>
                    <div className="min-w-0 flex-1">
                        {share.error ? (
                            <p className="flex items-center gap-2 text-sm">
                                <ShieldAlertIcon className="size-4 text-destructive" />
                                Shared by {share.granter.name}
                            </p>
                        ) : share.node.kind === 'folder' ? (
                            <Link
                                to="/app/drive/f/$folderId"
                                params={{ folderId: share.node.id }}
                                className="text-sm font-medium wrap-anywhere hover:underline"
                            >
                                {share.node.name}
                            </Link>
                        ) : (
                            <FileButton node={share.node} onOpen={setPreviewing} />
                        )}
                        <p className="text-xs text-muted-foreground tabular-nums">
                            {share.granter.name} · {share.granter.email} ·{' '}
                            {share.role === 'editor' ? 'you can edit' : 'you can view'} ·{' '}
                            {formatWhen(share.createdAt)}
                        </p>
                        {share.error && (
                            <p role="alert" className="mt-1 text-xs text-destructive">
                                {share.error}{' '}
                                <Link to="/app/contacts" className="text-link">
                                    Open contacts
                                </Link>
                            </p>
                        )}
                    </div>
                </li>
            ))}
            <Preview
                files={files}
                current={previewing}
                onChange={setPreviewing}
                onDownload={(node) => downloadNodes([node])}
            />
        </ul>
    );
}

function ByMe() {
    const queryClient = useQueryClient();
    const mine = useQuery(mySharingQueryOptions);
    const [pending, setPending] = useState<string | null>(null);
    const [previewing, setPreviewing] = useState<DriveNode | null>(null);
    async function stop(
        kind: 'share' | 'link',
        id: string,
        node: Parameters<typeof driveClient.revokeShare>[0],
        who: string,
    ) {
        setPending(id);
        try {
            if (kind === 'share') await driveClient.revokeShare(node, id);
            else await driveClient.revokeLink(node, id);
            await queryClient.invalidateQueries({ queryKey: driveKeys.mine });
            cue('droplet');
            toast.add({ type: 'success', title: `Sharing with ${who} stopped` });
            void rotateAfterRevoke(queryClient, node);
        } catch (error) {
            cue('error');
            toast.add({ type: 'error', title: 'Could not stop', description: driveError(error) });
        } finally {
            setPending(null);
        }
    }
    if (mine.isPending) return <Loading />;
    if (mine.isError) return <Failed error={mine.error} />;
    if (mine.data.shares.length === 0 && mine.data.links.length === 0)
        return (
            <Empty>
                You are not sharing anything yet. Select a folder or file and press Share.
            </Empty>
        );
    const location = (node: { kind: string; parentId: string | null; id: string }) =>
        node.kind === 'folder'
            ? { to: '/app/drive/f/$folderId' as const, params: { folderId: node.id } }
            : null;
    return (
        <div className="flex flex-col gap-10 px-5 py-6 sm:px-8 sm:py-8">
            <section className="flex flex-col gap-3">
                <h2 className="text-lg font-bold">With accounts ({mine.data.shares.length})</h2>
                {mine.data.shares.length === 0 ? (
                    <p className="text-sm text-muted-foreground">None.</p>
                ) : (
                    <ul className="divide-y divide-rule rounded-md border border-rule">
                        {mine.data.shares.map((share) => {
                            const link = location(share.node);
                            return (
                                <li
                                    key={share.id}
                                    data-by-me={share.grantee.email}
                                    className="flex min-h-[46px] flex-wrap items-center gap-x-3.5 gap-y-2 px-4 py-2 transition-colors hover:bg-muted"
                                >
                                    <span className="flex w-[30px] shrink-0 justify-center">
                                        <FileMark node={share.node} />
                                    </span>
                                    <div className="min-w-0 flex-1">
                                        {link ? (
                                            <Link
                                                {...link}
                                                className="text-sm font-medium wrap-anywhere hover:underline"
                                            >
                                                {share.node.name}
                                            </Link>
                                        ) : (
                                            <FileButton node={share.node} onOpen={setPreviewing} />
                                        )}
                                        <p className="text-xs text-muted-foreground tabular-nums">
                                            {share.grantee.name} · {share.grantee.email} ·{' '}
                                            {share.role === 'editor' ? 'can edit' : 'can view'} ·
                                            since {formatWhen(share.createdAt)}
                                        </p>
                                    </div>
                                    <Button
                                        variant="ghost"
                                        size="xs"
                                        aria-label={`Stop sharing ${share.node.name} with ${share.grantee.name}`}
                                        disabled={pending !== null}
                                        onClick={() =>
                                            void stop(
                                                'share',
                                                share.id,
                                                share.node,
                                                share.grantee.name,
                                            )
                                        }
                                    >
                                        <Trash2Icon />
                                        <span className="max-sm:sr-only">Stop</span>
                                    </Button>
                                </li>
                            );
                        })}
                    </ul>
                )}
            </section>
            <section className="flex flex-col gap-3">
                <h2 className="text-lg font-bold">Links for anyone ({mine.data.links.length})</h2>
                {mine.data.links.length === 0 ? (
                    <p className="text-sm text-muted-foreground">None.</p>
                ) : (
                    <ul className="divide-y divide-rule rounded-md border border-rule">
                        {mine.data.links.map((link) => {
                            const to = location(link.node);
                            return (
                                <LinkRow
                                    key={link.id}
                                    node={link.node}
                                    link={link}
                                    onChanged={() =>
                                        queryClient.invalidateQueries({
                                            queryKey: driveKeys.mine,
                                        })
                                    }
                                    title={
                                        <p className="flex items-center gap-3 text-sm">
                                            <span className="flex w-[30px] shrink-0 justify-center">
                                                <FileMark node={link.node} />
                                            </span>
                                            {to ? (
                                                <Link
                                                    {...to}
                                                    className="font-medium hover:underline"
                                                >
                                                    {link.node.name}
                                                </Link>
                                            ) : (
                                                <FileButton
                                                    node={link.node}
                                                    onOpen={setPreviewing}
                                                />
                                            )}
                                        </p>
                                    }
                                />
                            );
                        })}
                    </ul>
                )}
            </section>
            <Preview
                files={[
                    ...mine.data.shares.map((share) => share.node),
                    ...mine.data.links.map((link) => link.node),
                ].filter(
                    (node, index, all) =>
                        node.kind === 'file' && all.findIndex((n) => n.id === node.id) === index,
                )}
                current={previewing}
                onChange={setPreviewing}
                onDownload={(node) => downloadNodes([node])}
            />
        </div>
    );
}
