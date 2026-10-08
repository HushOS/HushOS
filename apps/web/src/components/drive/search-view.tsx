import type { CatalogueHit } from '@hushos/drive/client';
import { Link } from '@tanstack/react-router';
import { useHotkey } from '@tanstack/react-hotkeys';
import { useState } from 'react';
import type { DriveNode } from '@hushos/drive/client';
import { RotateCcwIcon } from 'lucide-react';
import { AccessCell, useAccessIndex } from '@/components/drive/access';
import { useDrive } from '@/components/drive/drive-shell';
import { FileMark } from '@/components/drive/file-mark';
import { Highlight } from '@/components/drive/highlight';
import { useOpenNode } from '@/lib/open-node';
import { Spinner } from '@/components/motion';
import { PageHeader } from '@/components/page-header';
import { Button } from '@/components/ui/button';
import { driveClient, formatBytes, formatWhen, nodeSize, useCatalogueState } from '@/lib/drive';

/*
 * The full list of matches for a query, from the catalogue: every folder and
 * file whose name, extension, tags or path the words land on, best first,
 * opened where it lives. Nothing is asked of the server, and the answer is as
 * complete as the build is; while rows are still opening the footer says so.
 * Shared folders are not part of the catalogue yet, so they are not searched.
 */

const LIMIT = 200;

export function SearchView({ query }: { query: string }) {
    const catalogue = useCatalogueState();
    const { workspaceId } = useDrive();
    const { open, folderLink } = useOpenNode();
    const access = useAccessIndex(true);
    const inherited = (node: DriveNode) =>
        driveClient.ancestorsOf(node.id).some((ancestor) => access.has(ancestor.id));
    const [focus, setFocus] = useState<{ query: string; index: number }>({ query, index: 0 });
    // A new query starts at the top; the index is kept per query, without an effect.
    const focused = focus.query === query ? focus.index : 0;
    // The catalogue state is read above, so this recomputes as rows open.
    const hits: CatalogueHit[] = query ? driveClient.search(query, LIMIT) : [];

    const enabled = hits.length > 0;
    useHotkey(
        'ArrowDown',
        () => setFocus({ query, index: Math.min(focused + 1, hits.length - 1) }),
        { enabled },
    );
    useHotkey('ArrowUp', () => setFocus({ query, index: Math.max(focused - 1, 0) }), {
        enabled,
    });
    useHotkey('Enter', () => hits[focused] && open(hits[focused].node), { enabled });

    const building = catalogue.phase === 'pulling' || catalogue.phase === 'opening';
    return (
        <div className="flex flex-col">
            <PageHeader
                title={query ? <>Results for “{query}”</> : 'Search My files'}
                description="Names, tags, folders and file types, matched word by word on this device. Shared folders are not searched yet."
            />
            {!query && (
                <p className="px-5 py-12 text-sm text-muted-foreground sm:px-8">
                    Press / or ⌘K anywhere in the app, or choose Search in the sidebar.
                </p>
            )}
            {query && catalogue.phase === 'idle' && (
                <div className="flex items-center justify-center py-24 text-muted-foreground">
                    <Spinner />
                </div>
            )}
            {query && catalogue.phase === 'failed' && (
                <div className="flex flex-col items-start gap-3 px-5 py-12 sm:px-8">
                    <p className="text-sm text-muted-foreground">
                        Search couldn’t get ready in this browser.
                        {catalogue.error ? ` ${catalogue.error}` : ''}
                    </p>
                    <Button
                        variant="outline"
                        onClick={() => void driveClient.buildCatalogue(workspaceId)}
                    >
                        <RotateCcwIcon />
                        Try again
                    </Button>
                </div>
            )}
            {query && catalogue.phase !== 'idle' && hits.length === 0 && (
                <p className="px-5 py-12 text-sm text-muted-foreground sm:px-8">
                    {building ? 'Nothing yet. Search is still getting ready.' : 'No matches.'}
                </p>
            )}
            {hits.length > 0 && (
                <table
                    aria-label={`Results for ${query}`}
                    className="w-full table-fixed border-collapse"
                >
                    <thead>
                        <tr className="h-10 border-b border-rule text-xs font-semibold text-muted-foreground">
                            <th scope="col" className="pl-5 text-left sm:pl-8">
                                Name
                            </th>
                            <th scope="col" className="hidden w-[22%] text-left lg:table-cell">
                                Who can open
                            </th>
                            <th scope="col" className="hidden w-40 text-left sm:table-cell">
                                Changed
                            </th>
                            <th scope="col" className="w-28 pr-5 text-right sm:pr-8">
                                Size
                            </th>
                        </tr>
                    </thead>
                    <tbody>
                        {hits.map(({ node, path }, index) => {
                            const size = nodeSize(node);
                            const target =
                                node.kind === 'folder'
                                    ? folderLink(node.id)
                                    : node.parentId
                                      ? {
                                            ...folderLink(node.parentId),
                                            search: { preview: node.id },
                                        }
                                      : { to: '/app/drive' as const };
                            return (
                                <tr
                                    key={node.id}
                                    data-node-id={node.id}
                                    className={`h-14 border-b border-rule ${index === focused ? 'bg-muted' : ''}`}
                                    onMouseEnter={() => setFocus({ query, index })}
                                >
                                    <td className="min-w-0 pl-5 sm:pl-8">
                                        <Link
                                            {...target}
                                            className="flex min-w-0 items-center gap-4 text-[15px] font-medium hover:[&>span>span:first-child]:underline"
                                        >
                                            <FileMark node={node} size="list" />
                                            <span className="flex min-w-0 flex-col">
                                                <span className="truncate">
                                                    <Highlight text={node.name} query={query} />
                                                </span>
                                                <span className="truncate text-[13px] font-normal text-muted-foreground">
                                                    {path.join(' › ')}
                                                </span>
                                            </span>
                                        </Link>
                                    </td>
                                    <td className="hidden min-w-0 pr-4 lg:table-cell">
                                        <AccessCell
                                            access={access.get(node.id)}
                                            inherited={inherited(node)}
                                        />
                                    </td>
                                    <td className="hidden text-[13px] text-muted-foreground tabular-nums sm:table-cell">
                                        {formatWhen(node.metadata?.modified ?? node.updatedAt)}
                                    </td>
                                    <td className="pr-5 text-right text-[13px] text-muted-foreground tabular-nums sm:pr-8">
                                        {node.kind === 'folder'
                                            ? '–'
                                            : Number.isNaN(size)
                                              ? 'Missing'
                                              : formatBytes(size!)}
                                    </td>
                                </tr>
                            );
                        })}
                    </tbody>
                </table>
            )}
            {query && catalogue.phase !== 'idle' && (
                <p className="px-5 py-3 text-[13px] text-muted-foreground tabular-nums sm:px-8">
                    {hits.length === LIMIT
                        ? `First ${LIMIT} matches`
                        : `${hits.length} ${hits.length === 1 ? 'match' : 'matches'}`}
                    {building && ' · search is still getting ready'}
                </p>
            )}
        </div>
    );
}
