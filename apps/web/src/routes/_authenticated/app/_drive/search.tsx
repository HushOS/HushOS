import { createFileRoute, useLocation } from '@tanstack/react-router';
import { SearchView } from '@/components/drive/search-view';
import { searchFromHash } from '@/lib/search';

export const Route = createFileRoute('/_authenticated/app/_drive/search')({
    head: () => ({ meta: [{ title: 'Search · HushOS' }] }),
    component: DriveSearchPage,
});

function DriveSearchPage() {
    const hash = useLocation({ select: (location) => location.hash });
    const q = searchFromHash(hash);
    return (
        <>
            <SearchView query={q} />
        </>
    );
}
