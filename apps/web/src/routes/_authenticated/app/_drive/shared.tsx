import { createFileRoute, Link } from '@tanstack/react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { DriveNode, ShareMount } from '@hushos/drive/client';
import type { LinkView, ShareView } from '@hushos/drive/api';
import {
    ContactIcon,
    CopyIcon,
    CopyPlusIcon,
    DownloadIcon,
    EllipsisIcon,
    EyeIcon,
    FlagIcon,
    Link2Icon,
    Link2OffIcon,
    RotateCcwIcon,
    TriangleAlertIcon,
    UserXIcon,
    UsersIcon,
} from 'lucide-react';
import { cn } from 'cn';
import { useEffect, useState, type ReactNode } from 'react';
import { useDrive } from '@/components/drive/drive-shell';
import { EmptyState, RowMenuButton, SkeletonRows } from '@/components/drive/file-list';
import { FileMark } from '@/components/drive/file-mark';
import { describeLink } from '@/components/drive/link-row';
import { Preview } from '@/components/drive/preview';
import { ReportDialog } from '@/components/drive/report-dialog';
import { ShareDialog } from '@/components/drive/share-dialog';
import { PageHeader } from '@/components/page-header';
import { PersonAvatar } from '@/components/person-avatar';
import {
    AlertDialog,
    AlertDialogCancel,
    AlertDialogContent,
    AlertDialogDescription,
    AlertDialogFooter,
    AlertDialogHeader,
    AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Button, buttonVariants } from '@/components/ui/button';
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuGroup,
    DropdownMenuItem,
    DropdownMenuSeparator,
    DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { toast } from '@/components/ui/toast';
import {
    driveClient,
    driveError,
    displayName,
    driveKeys,
    folderQueryOptions,
    formatBytes,
    formatWhen,
    mySharingQueryOptions,
    nodeSize,
    sharedQueryOptions,
} from '@/lib/drive';
import { downloadNodes } from '@/lib/downloads';
import { rotateAfterRevoke } from '@/lib/rotation';
import { saveCopy } from '@/lib/save-copy';
import { cue } from '@/lib/sounds';

export const Route = createFileRoute('/_authenticated/app/_drive/shared')({
    validateSearch: (search: Record<string, unknown>): { view?: 'by-me' } =>
        search.view === 'by-me' ? { view: 'by-me' } : {},
    head: () => ({ meta: [{ title: 'Shared · HushOS' }] }),
    component: Shared,
});

/*
 * Sharing in both directions. "With me": what other people gave this person a
 * key to, each a root of its own. "By me": every person and every link this
 * person shares with, and the means to stop each, asked once.
 */
const firstName = (name: string) => name.trim().split(/\s+/)[0] ?? name;

function Shared() {
    const { view } = Route.useSearch();
    const byMe = view === 'by-me';
    const queryClient = useQueryClient();
    // The other tab's list is fetched alongside the open one, so switching shows it at once.
    useEffect(() => {
        if (byMe) void queryClient.prefetchQuery(sharedQueryOptions);
        else void queryClient.prefetchQuery(mySharingQueryOptions);
    }, [queryClient, byMe]);
    const tab = (on: boolean) =>
        cn(
            'flex h-8 items-center rounded-sm px-4 text-sm font-semibold transition-colors outline-none focus-visible:outline-2 focus-visible:outline-ring',
            on
                ? 'bg-card text-foreground shadow-sm'
                : 'text-muted-foreground hover:text-foreground',
        );
    return (
        <div className="flex flex-1 flex-col">
            <PageHeader title="Shared">
                <Link to="/app/people" className={buttonVariants({ variant: 'outline' })}>
                    <ContactIcon />
                    People you share with
                </Link>
            </PageHeader>
            <div className="px-5 pb-4 sm:px-8">
                <div
                    role="tablist"
                    aria-label="Direction"
                    className="inline-flex rounded-md bg-muted p-1"
                >
                    <Link
                        to="/app/shared"
                        search={{}}
                        role="tab"
                        aria-selected={!byMe}
                        className={tab(!byMe)}
                    >
                        With me
                    </Link>
                    <Link
                        to="/app/shared"
                        search={{ view: 'by-me' }}
                        role="tab"
                        aria-selected={byMe}
                        className={tab(byMe)}
                    >
                        By me
                    </Link>
                </div>
            </div>
            {byMe ? <ByMe /> : <WithMe />}
        </div>
    );
}

function Failed({ error, onRetry }: { error: unknown; onRetry: () => void }) {
    return (
        <EmptyState
            icon={TriangleAlertIcon}
            tone="danger"
            title="Couldn’t load what’s shared"
            body={`${driveError(error)} Check your connection and try again.`}
        >
            <Button variant="outline" onClick={onRetry}>
                <RotateCcwIcon />
                Try again
            </Button>
        </EmptyState>
    );
}

/* A shared item's name: a folder opens as a folder, a file in the viewer. */
function ItemName({ node, onPreview }: { node: DriveNode; onPreview: (node: DriveNode) => void }) {
    const className = 'truncate text-left text-[15px] font-medium hover:underline';
    return node.kind === 'folder' ? (
        node.parentId === null ? (
            <Link to="/app/drive" className={className}>
                {displayName(node)}
            </Link>
        ) : (
            <Link to="/app/drive/f/$folderId" params={{ folderId: node.id }} className={className}>
                {node.name}
            </Link>
        )
    ) : (
        <button
            type="button"
            className={cn('cursor-pointer', className)}
            onClick={() => onPreview(node)}
        >
            {node.name}
        </button>
    );
}

function WithMe() {
    const { rootId } = useDrive();
    const queryClient = useQueryClient();
    const shares = useQuery(sharedQueryOptions);
    const [previewing, setPreviewing] = useState<DriveNode | null>(null);
    const [reporting, setReporting] = useState<DriveNode | null>(null);

    async function saveToMine(node: DriveNode) {
        try {
            const root = (await queryClient.fetchQuery(folderQueryOptions(rootId))).folder;
            await saveCopy(queryClient, [node], root);
            cue('droplet');
            toast.add({
                type: 'success',
                title: `Saving “${node.name}” to your files`,
                description: 'It shows up in My files as it copies.',
            });
        } catch (cause) {
            cue('error');
            toast.add({
                type: 'error',
                title: 'Couldn’t save a copy',
                description: driveError(cause),
            });
        }
    }

    if (shares.isPending) return <SkeletonRows />;
    if (shares.isError)
        return <Failed error={shares.error} onRetry={() => void shares.refetch()} />;
    if (shares.data.length === 0)
        return (
            <EmptyState
                icon={UsersIcon}
                title="Nothing shared with you yet"
                body="When someone shares a folder or file with you, it shows up here."
            />
        );
    const files = shares.data.flatMap((share) =>
        share.node.kind === 'file' && !share.error ? [share.node] : [],
    );
    return (
        <>
            <div
                aria-hidden="true"
                className={cn(
                    WITH_ME,
                    'h-10 border-b border-rule text-xs font-semibold text-muted-foreground',
                )}
            >
                <span className="col-span-2">Name</span>
                <span className="max-md:hidden">From</span>
                <span className="max-sm:hidden">Shared</span>
                <span className="text-right max-lg:hidden">Size</span>
                <span />
            </div>
            <ul aria-label="Shared with me" className="flex flex-col">
                {shares.data.map((share) => (
                    <WithMeRow
                        key={share.id}
                        share={share}
                        onPreview={setPreviewing}
                        onSave={(node) => void saveToMine(node)}
                        onReport={setReporting}
                    />
                ))}
            </ul>
            <Preview
                files={files}
                current={previewing}
                onChange={setPreviewing}
                onDownload={(node) => downloadNodes([node])}
            />
            <ReportDialog
                node={reporting}
                via={{ share: true }}
                signedIn
                open={reporting !== null}
                onOpenChange={(open) => !open && setReporting(null)}
            />
        </>
    );
}

/* Thumbnail, name, from whom, when, size, menu: the columns drop away as the window narrows. */
const WITH_ME =
    'grid grid-cols-[2.5rem_minmax(0,1fr)_3.5rem] items-center gap-x-4 pr-3 pl-5 sm:grid-cols-[2.5rem_minmax(0,1fr)_8rem_4rem] sm:pr-5 sm:pl-8 md:grid-cols-[2.5rem_minmax(0,1fr)_minmax(0,16rem)_8rem_4rem] lg:grid-cols-[2.5rem_minmax(0,1fr)_minmax(0,16rem)_8rem_6rem_4rem]';

function WithMeRow({
    share,
    onPreview,
    onSave,
    onReport,
}: {
    share: ShareMount;
    onPreview: (node: DriveNode) => void;
    onSave: (node: DriveNode) => void;
    onReport: (node: DriveNode) => void;
}) {
    const from = firstName(share.granter.name);
    const role = share.role === 'editor' ? 'can edit' : 'can view';
    if (share.error)
        return (
            <li
                data-shared={share.node.name}
                className="flex h-16 items-center gap-4 border-b border-rule pr-5 pl-5 sm:pr-8 sm:pl-8"
            >
                <span className="flex size-10 shrink-0 items-center justify-center rounded-full bg-destructive-soft text-destructive">
                    <TriangleAlertIcon className="size-[18px]" aria-hidden="true" />
                </span>
                <span className="flex min-w-0 flex-col">
                    <span className="truncate text-[15px] font-medium">
                        Shared by {share.granter.name}
                    </span>
                    <span role="alert" className="text-[13px] text-destructive">
                        Couldn’t open this. {share.error}{' '}
                        <Link
                            to="/app/people"
                            className="font-semibold underline underline-offset-2"
                        >
                            Go to People you share with
                        </Link>
                    </span>
                </span>
            </li>
        );
    return (
        <li
            data-shared={share.node.name}
            className={cn(WITH_ME, 'h-14 border-b border-rule hover:bg-muted')}
        >
            <span className="flex size-10 items-center justify-center">
                <FileMark node={share.node} size="list" />
            </span>
            <span className="flex min-w-0 flex-col">
                <ItemName node={share.node} onPreview={onPreview} />
                <span className="truncate text-[13px] text-muted-foreground md:hidden">
                    From {from} · {role}
                </span>
            </span>
            <span className="flex min-w-0 items-center gap-2 text-[13px] max-md:hidden">
                <PersonAvatar name={share.granter.name} seed={share.granter.id} size={24} />
                <span className="truncate" title={share.granter.email}>
                    From {from} · {role}
                </span>
            </span>
            <span className="text-[13px] text-muted-foreground tabular-nums max-sm:hidden">
                {formatWhen(share.createdAt)}
            </span>
            <span className="text-right text-[13px] text-muted-foreground tabular-nums max-lg:hidden">
                {share.node.kind === 'folder' ? '–' : formatBytes(nodeSize(share.node))}
            </span>
            <span className="flex justify-end">
                <DropdownMenu>
                    <DropdownMenuTrigger
                        render={<RowMenuButton aria-label={`More for ${share.node.name}`} />}
                    >
                        <EllipsisIcon className="size-5" aria-hidden="true" />
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end" className="w-60">
                        <DropdownMenuGroup>
                            {share.node.kind === 'folder' ? (
                                <DropdownMenuItem
                                    render={
                                        <Link
                                            to="/app/drive/f/$folderId"
                                            params={{ folderId: share.node.id }}
                                        />
                                    }
                                >
                                    <EyeIcon aria-hidden="true" />
                                    Open
                                </DropdownMenuItem>
                            ) : (
                                <DropdownMenuItem onClick={() => onPreview(share.node)}>
                                    <EyeIcon aria-hidden="true" />
                                    Preview
                                </DropdownMenuItem>
                            )}
                            <DropdownMenuItem onClick={() => downloadNodes([share.node])}>
                                <DownloadIcon aria-hidden="true" />
                                Download
                            </DropdownMenuItem>
                            <DropdownMenuItem onClick={() => onSave(share.node)}>
                                <CopyPlusIcon aria-hidden="true" />
                                Save a copy to my files
                            </DropdownMenuItem>
                        </DropdownMenuGroup>
                        <DropdownMenuSeparator />
                        <DropdownMenuGroup>
                            <DropdownMenuItem onClick={() => onReport(share.node)}>
                                <FlagIcon aria-hidden="true" />
                                Report
                            </DropdownMenuItem>
                        </DropdownMenuGroup>
                    </DropdownMenuContent>
                </DropdownMenu>
            </span>
        </li>
    );
}

type Stop =
    | { kind: 'share'; share: ShareView & { node: DriveNode } }
    | { kind: 'link'; link: LinkView & { node: DriveNode } };

function ByMe() {
    const queryClient = useQueryClient();
    const mine = useQuery(mySharingQueryOptions);
    const [previewing, setPreviewing] = useState<DriveNode | null>(null);
    const [sharing, setSharing] = useState<DriveNode | null>(null);
    const [stopping, setStopping] = useState<Stop | null>(null);
    const [busy, setBusy] = useState<string | null>(null);

    async function stop(target: Stop) {
        const node = target.kind === 'share' ? target.share.node : target.link.node;
        setBusy(target.kind === 'share' ? target.share.id : target.link.id);
        try {
            if (target.kind === 'share') await driveClient.revokeShare(node, target.share.id);
            else await driveClient.revokeLink(node, target.link.id);
            await queryClient.invalidateQueries({ queryKey: driveKeys.mine });
            cue('droplet');
            toast.add(
                target.kind === 'share'
                    ? {
                          type: 'success',
                          title: `${target.share.grantee.name} can’t open “${displayName(node)}” any more`,
                      }
                    : {
                          type: 'success',
                          title: 'Link turned off',
                          description: `“${displayName(node)}” no longer opens from it.`,
                      },
            );
            void rotateAfterRevoke(queryClient, node);
        } catch (cause) {
            cue('error');
            toast.add({
                type: 'error',
                title:
                    target.kind === 'share'
                        ? 'Couldn’t stop sharing'
                        : 'Couldn’t turn the link off',
                description: driveError(cause),
            });
        } finally {
            setBusy(null);
        }
    }
    async function copy(link: LinkView & { node: DriveNode }) {
        try {
            const url = await driveClient.linkUrl(link.node, link, window.location.origin);
            if (!url)
                throw new Error(
                    'This link was made before links could be shown again. Make a new one.',
                );
            await navigator.clipboard.writeText(url);
            cue('success', { volume: 0.4 });
            toast.add({ type: 'success', title: 'Link copied' });
        } catch (cause) {
            cue('error');
            toast.add({
                type: 'error',
                title: 'Couldn’t copy the link',
                description: driveError(cause),
            });
        }
    }

    if (mine.isPending) return <SkeletonRows />;
    if (mine.isError) return <Failed error={mine.error} onRetry={() => void mine.refetch()} />;
    if (mine.data.shares.length === 0 && mine.data.links.length === 0)
        return (
            <EmptyState
                icon={UsersIcon}
                title="You haven’t shared anything yet"
                body="Choose Share on any folder or file to let someone open it."
            />
        );
    const files = [
        ...mine.data.shares.map((entry) => entry.node),
        ...mine.data.links.map((entry) => entry.node),
    ].filter(
        (node, index, all) =>
            node.kind === 'file' && all.findIndex((other) => other.id === node.id) === index,
    );
    return (
        <div className="flex flex-col gap-8 pb-8">
            <Section
                title={`With people (${mine.data.shares.length})`}
                empty="You’re not sharing with anyone."
            >
                {mine.data.shares.map((share) => (
                    <OutgoingRow
                        key={share.id}
                        node={share.node}
                        data={{ 'data-by-me': share.grantee.email }}
                        detail={
                            <span className="flex min-w-0 items-center gap-1.5">
                                <PersonAvatar
                                    name={share.grantee.name}
                                    seed={share.grantee.id}
                                    size={18}
                                />
                                <span className="truncate">
                                    {share.grantee.name} ·{' '}
                                    {share.role === 'editor' ? 'can edit' : 'can view'} · since{' '}
                                    {formatWhen(share.createdAt, { lower: true })}
                                </span>
                            </span>
                        }
                        onPreview={setPreviewing}
                    >
                        <Button
                            variant="outline"
                            size="sm"
                            className="max-md:hidden"
                            onClick={() => setSharing(share.node)}
                        >
                            Who can open
                        </Button>
                        <Button
                            variant="destructive-outline"
                            size="sm"
                            aria-label={`Stop sharing ${share.node.name} with ${share.grantee.name}`}
                            disabled={busy !== null}
                            onClick={() => setStopping({ kind: 'share', share })}
                        >
                            <UserXIcon />
                            <span className="max-sm:sr-only">Stop sharing</span>
                        </Button>
                    </OutgoingRow>
                ))}
            </Section>
            <Section title={`Links (${mine.data.links.length})`} empty="No links are on.">
                {mine.data.links.map((link) => (
                    <OutgoingRow
                        key={link.id}
                        node={link.node}
                        data={{ 'data-link': link.id }}
                        detail={
                            <span className="flex min-w-0 items-center gap-1.5">
                                <Link2Icon
                                    className="size-3.5 shrink-0 text-primary"
                                    strokeWidth={2.4}
                                    aria-hidden="true"
                                />
                                <span className="truncate">
                                    Anyone with the link · {describeLink(link)}
                                </span>
                            </span>
                        }
                        onPreview={setPreviewing}
                    >
                        <Button variant="outline" size="sm" onClick={() => void copy(link)}>
                            <CopyIcon />
                            <span className="max-sm:sr-only">Copy link</span>
                        </Button>
                        <Button
                            variant="outline"
                            size="sm"
                            className="max-md:hidden"
                            onClick={() => setSharing(link.node)}
                        >
                            Who can open
                        </Button>
                        <Button
                            variant="destructive-outline"
                            size="sm"
                            aria-label={`Turn off the link to ${link.node.name}`}
                            disabled={busy !== null}
                            onClick={() => setStopping({ kind: 'link', link })}
                        >
                            <Link2OffIcon />
                            <span className="max-sm:sr-only">Turn off link</span>
                        </Button>
                    </OutgoingRow>
                ))}
            </Section>
            <Preview
                files={files}
                current={previewing}
                onChange={setPreviewing}
                onDownload={(node) => downloadNodes([node])}
            />
            <ShareDialog
                node={sharing}
                open={sharing !== null}
                onOpenChange={(open) => {
                    if (open) return;
                    setSharing(null);
                    void queryClient.invalidateQueries({ queryKey: driveKeys.mine });
                }}
            />
            <AlertDialog
                open={stopping !== null}
                onOpenChange={(open) => !open && setStopping(null)}
            >
                <AlertDialogContent>
                    <AlertDialogHeader>
                        <AlertDialogTitle>
                            {stopping?.kind === 'link'
                                ? 'Turn off this link?'
                                : stopping
                                  ? `Stop sharing “${displayName(stopping.share.node)}”?`
                                  : ''}
                        </AlertDialogTitle>
                        <AlertDialogDescription>
                            {stopping?.kind === 'link'
                                ? `Anyone who has it can’t open “${displayName(stopping.link.node)}” any more. Other links keep working.`
                                : stopping
                                  ? `${stopping.share.grantee.name} can’t open it in HushOS any more. Copies they already downloaded stay with them. You can share it again later.`
                                  : ''}
                        </AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                        <AlertDialogCancel>Cancel</AlertDialogCancel>
                        <Button
                            variant="destructive"
                            onClick={() => {
                                const target = stopping;
                                setStopping(null);
                                if (target) void stop(target);
                            }}
                        >
                            {stopping?.kind === 'link' ? 'Turn off link' : 'Stop sharing'}
                        </Button>
                    </AlertDialogFooter>
                </AlertDialogContent>
            </AlertDialog>
        </div>
    );
}

function Section({
    title,
    empty,
    children,
}: {
    title: string;
    empty: string;
    children: ReactNode[];
}) {
    return (
        <section className="flex flex-col">
            <h2 className="border-b border-rule px-5 pb-2 text-[15px] font-bold sm:px-8">
                {title}
            </h2>
            {children.length === 0 ? (
                <p className="px-5 py-4 text-sm text-muted-foreground sm:px-8">{empty}</p>
            ) : (
                <ul className="flex flex-col">{children}</ul>
            )}
        </section>
    );
}

function OutgoingRow({
    node,
    detail,
    data,
    onPreview,
    children,
}: {
    node: DriveNode;
    detail: ReactNode;
    data: Record<string, string>;
    onPreview: (node: DriveNode) => void;
    children: ReactNode;
}) {
    return (
        <li
            {...data}
            className="flex min-h-16 items-center gap-4 border-b border-rule py-2 pr-3 pl-5 hover:bg-muted sm:pr-5 sm:pl-8"
        >
            <span className="flex size-10 shrink-0 items-center justify-center">
                <FileMark node={node} size="list" />
            </span>
            <span className="flex min-w-0 flex-1 flex-col">
                <ItemName node={node} onPreview={onPreview} />
                <span className="min-w-0 text-[13px] text-muted-foreground">{detail}</span>
            </span>
            <span className="flex shrink-0 items-center gap-2">{children}</span>
        </li>
    );
}
