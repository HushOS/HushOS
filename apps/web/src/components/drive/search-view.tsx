import type { CatalogueHit } from '@hushos/drive/client';
import { Link } from '@tanstack/react-router';
import { useHotkey } from '@tanstack/react-hotkeys';
import { useState } from 'react';
import { FileMark } from '@/components/drive/file-mark';
import { Highlight } from '@/components/drive/highlight';
import { useOpenNode } from '@/lib/open-node';
import { Spinner } from '@/components/motion';
import { PageHeader } from '@/components/page-header';
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
    const { open, folderLink } = useOpenNode();
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
                title={query ? <>Results for “{query}”</> : 'Search your Drive'}
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
                <p className="px-5 py-12 text-sm text-muted-foreground sm:px-8">
                    The catalogue could not be built on this device.
                    {catalogue.error ? ` ${catalogue.error}` : ''}
                </p>
            )}
            {query && catalogue.phase !== 'idle' && hits.length === 0 && (
                <p className="px-5 py-12 text-sm text-muted-foreground sm:px-8">
                    {building ? 'Nothing yet. Your Drive is still being indexed.' : 'No matches.'}
                </p>
            )}
            {hits.length > 0 && (
                <table
                    aria-label={`Results for ${query}`}
                    className="w-full table-fixed border-collapse"
                >
                    <thead>
                        <tr className="border-b border-rule">
                            <th
                                scope="col"
                                className="eyebrow py-2.5 pl-5 text-left text-muted-foreground sm:pl-8"
                            >
                                Name
                            </th>
                            <th
                                scope="col"
                                className="eyebrow hidden w-40 py-2.5 text-left text-muted-foreground sm:table-cell"
                            >
                                Modified
                            </th>
                            <th
                                scope="col"
                                className="eyebrow w-28 py-2.5 pr-5 text-right text-muted-foreground sm:pr-8"
                            >
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
                                    className={`h-[46px] border-b border-rule ${index === focused ? 'bg-muted' : ''}`}
                                    onMouseEnter={() => setFocus({ query, index })}
                                >
                                    <td className="min-w-0 py-2 pl-5 sm:pl-8">
                                        <Link
                                            {...target}
                                            className="flex min-w-0 items-center gap-3 text-sm font-medium"
                                        >
                                            <FileMark node={node} />
                                            <span className="flex min-w-0 flex-col">
                                                <span className="truncate">
                                                    <Highlight text={node.name} query={query} />
                                                </span>
                                                <span className="truncate text-xs font-normal text-muted-foreground">
                                                    {path.join(' › ')}
                                                </span>
                                            </span>
                                        </Link>
                                    </td>
                                    <td className="hidden py-2 text-sm text-muted-foreground tabular-nums sm:table-cell">
                                        {formatWhen(node.metadata?.modified ?? node.updatedAt)}
                                    </td>
                                    <td className="py-2 pr-5 text-right text-sm text-muted-foreground tabular-nums sm:pr-8">
                                        {node.kind === 'folder'
                                            ? '-'
                                            : Number.isNaN(size)
                                              ? 'Unavailable'
                                              : formatBytes(size!)}
                                    </td>
                                </tr>
                            );
                        })}
                    </tbody>
                </table>
            )}
            {query && catalogue.phase !== 'idle' && (
                <p className="px-5 py-3 text-xs text-muted-foreground tabular-nums sm:px-8">
                    {hits.length === LIMIT
                        ? `First ${LIMIT} matches`
                        : `${hits.length} ${hits.length === 1 ? 'match' : 'matches'}`}
                    {building && ` · still indexing, ${catalogue.opened} items opened so far`}
                </p>
            )}
        </div>
    );
}
