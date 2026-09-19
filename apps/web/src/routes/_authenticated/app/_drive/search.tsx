import { createFileRoute } from '@tanstack/react-router';
import { SearchView } from '@/components/drive/search-view';

export const Route = createFileRoute('/_authenticated/app/_drive/search')({
    head: () => ({ meta: [{ title: 'Search · HushOS' }] }),
    // The query lives in the URL so back, forward and a shared link all work.
    validateSearch: (search: Record<string, unknown>): { q?: string } =>
        typeof search.q === 'string' && search.q.trim() ? { q: search.q.trim().slice(0, 200) } : {},
    component: DriveSearchPage,
});

function DriveSearchPage() {
    const { q } = Route.useSearch();
    return (
        <>
            <SearchView query={q ?? ''} />
        </>
    );
}
