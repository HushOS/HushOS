import { createFileRoute } from '@tanstack/react-router';
import { TagsView } from '@/components/drive/tags-view';

export const Route = createFileRoute('/_authenticated/app/_drive/tags/')({
    head: () => ({ meta: [{ title: 'Tags · HushOS' }] }),
    component: TagsView,
});
