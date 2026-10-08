import { createFileRoute } from '@tanstack/react-router';
import { HomeView } from '@/components/drive/home-view';

/* Home, where the app opens: what changed lately, across every folder. */
export const Route = createFileRoute('/_authenticated/app/_drive/')({
    head: () => ({ meta: [{ title: 'Home · HushOS' }] }),
    // The file open in the viewer, so a preview has a URL of its own and the
    // back button closes it.
    validateSearch: (search: Record<string, unknown>): { preview?: string } =>
        typeof search.preview === 'string' && /^[0-9a-f-]{36}$/.test(search.preview)
            ? { preview: search.preview }
            : {},
    component: HomeView,
});
