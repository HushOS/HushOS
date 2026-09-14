import { createFileRoute, Link } from '@tanstack/react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { FileIcon, FolderIcon, LinkIcon, ShieldAlertIcon, Trash2Icon } from 'lucide-react';
import { useState } from 'react';
import { DriveShell } from '@/components/drive/drive-shell';
import { LinkRow } from '@/components/drive/link-row';
import { Spinner } from '@/components/motion';
import { PageHeader } from '@/components/page-header';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { toast } from '@/components/ui/toast';
import { driveClient, driveError, driveKeys, formatWhen, sharedQueryOptions } from '@/lib/drive';
import { rotateAfterRevoke } from '@/lib/rotation';
import { cue } from '@/lib/sounds';

export const Route = createFileRoute('/_authenticated/app/shared')({
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
    const { user } = Route.useRouteContext();
    return (
        <DriveShell user={user}>
            <Shared />
        </DriveShell>
    );
}

function Shared() {
    const { view } = Route.useSearch();
    const byMe = view === 'by-me';
    return (
        <div className="flex flex-1 flex-col">
            <PageHeader
                eyebrow="Workspace"
                title="Shared"
                description="What others gave you a key to, and what you share out by account or by link. Bytes stay in the owner’s storage; stopping a share takes effect on the next request."
            >
                <div
                    role="tablist"
                    aria-label="Direction"
                    className="flex h-10 self-start border bg-card"
                >
                    <Link
                        to="/app/shared"
                        search={{}}
                        role="tab"
                        aria-selected={!byMe}
                        className={`eyebrow flex items-center px-4 ${byMe ? 'text-muted-foreground hover:bg-muted' : 'bg-primary text-primary-foreground'}`}
                    >
                        With me
                    </Link>
                    <Link
                        to="/app/shared"
                        search={{ view: 'by-me' }}
                        role="tab"
                        aria-selected={byMe}
                        className={`eyebrow flex items-center border-l px-4 ${byMe ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:bg-muted'}`}
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
        <p className="px-5 py-16 text-center font-mono text-xs text-muted-foreground sm:px-8">
            {children}
        </p>
    );
}

function WithMe() {
    const shares = useQuery(sharedQueryOptions);
    if (shares.isPending) return <Loading />;
    if (shares.isError) return <Failed error={shares.error} />;
    if (shares.data.length === 0) return <Empty>Nothing shared with you yet.</Empty>;
    return (
        <ul className="divide-y border-b">
            {shares.data.map((share) => (
                <li
                    key={share.id}
                    data-shared={share.node.name}
                    className="flex flex-wrap items-center gap-x-4 gap-y-2 px-5 py-3 sm:px-8"
                >
                    {share.node.kind === 'folder' ? (
                        <FolderIcon className="size-4 shrink-0 text-primary" />
                    ) : (
                        <FileIcon className="size-4 shrink-0 text-muted-foreground" />
                    )}
                    <div className="min-w-0 flex-1">
                        {share.error ? (
                            <p className="flex items-center gap-2 text-sm">
                                <ShieldAlertIcon className="size-4 text-destructive" />
                                Shared by {share.granter.name}
                            </p>
                        ) : share.node.kind === 'folder' ? (
                            <Link
                                to="/app/f/$folderId"
                                params={{ folderId: share.node.id }}
                                className="text-sm hover:underline"
                            >
                                {share.node.name}
                            </Link>
                        ) : (
                            <p className="text-sm">{share.node.name}</p>
                        )}
                        <p className="font-mono text-[11px] text-muted-foreground">
                            {share.granter.name} · {share.granter.email} ·{' '}
                            {share.role === 'editor' ? 'you can edit' : 'you can view'} ·{' '}
                            {formatWhen(share.createdAt)}
                        </p>
                        {share.error && (
                            <p role="alert" className="mt-1 font-mono text-[11px] text-destructive">
                                {share.error}{' '}
                                <Link to="/app/contacts" className="text-link">
                                    Open contacts
                                </Link>
                            </p>
                        )}
                    </div>
                </li>
            ))}
        </ul>
    );
}

function ByMe() {
    const queryClient = useQueryClient();
    const mine = useQuery({
        queryKey: [...driveKeys.all, 'mine'],
        queryFn: () => driveClient.mySharing(),
        staleTime: 15_000,
    });
    const [pending, setPending] = useState<string | null>(null);
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
            await queryClient.invalidateQueries({ queryKey: [...driveKeys.all, 'mine'] });
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
            ? { to: '/app/f/$folderId' as const, params: { folderId: node.id } }
            : null;
    return (
        <div className="flex flex-col gap-8 px-5 py-6 sm:px-8 sm:py-8">
            <section className="flex flex-col gap-3">
                <h2 className="eyebrow text-muted-foreground">
                    With accounts ({mine.data.shares.length})
                </h2>
                {mine.data.shares.length === 0 ? (
                    <p className="border bg-card px-4 py-3.5 font-mono text-xs text-muted-foreground">
                        None.
                    </p>
                ) : (
                    <ul className="border bg-card">
                        {mine.data.shares.map((share) => {
                            const link = location(share.node);
                            return (
                                <li
                                    key={share.id}
                                    data-by-me={share.grantee.email}
                                    className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b px-4 py-3 last:border-b-0"
                                >
                                    {share.node.kind === 'folder' ? (
                                        <FolderIcon className="size-4 shrink-0 text-primary" />
                                    ) : (
                                        <FileIcon className="size-4 shrink-0 text-muted-foreground" />
                                    )}
                                    <div className="min-w-0 flex-1">
                                        {link ? (
                                            <Link {...link} className="text-sm hover:underline">
                                                {share.node.name}
                                            </Link>
                                        ) : (
                                            <p className="text-sm">{share.node.name}</p>
                                        )}
                                        <p className="font-mono text-[11px] text-muted-foreground">
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
                <h2 className="eyebrow text-muted-foreground">
                    Links for anyone ({mine.data.links.length})
                </h2>
                {mine.data.links.length === 0 ? (
                    <p className="border bg-card px-4 py-3.5 font-mono text-xs text-muted-foreground">
                        None.
                    </p>
                ) : (
                    <ul className="divide-y border bg-card">
                        {mine.data.links.map((link) => {
                            const to = location(link.node);
                            return (
                                <LinkRow
                                    key={link.id}
                                    node={link.node}
                                    link={link}
                                    onChanged={() =>
                                        queryClient.invalidateQueries({
                                            queryKey: [...driveKeys.all, 'mine'],
                                        })
                                    }
                                    title={
                                        <p className="flex items-center gap-2 text-sm">
                                            <LinkIcon className="size-4 shrink-0 text-muted-foreground" />
                                            {to ? (
                                                <Link {...to} className="hover:underline">
                                                    {link.node.name}
                                                </Link>
                                            ) : (
                                                link.node.name
                                            )}
                                        </p>
                                    }
                                />
                            );
                        })}
                    </ul>
                )}
            </section>
        </div>
    );
}
