import { createFileRoute } from '@tanstack/react-router';
import { TagView } from '@/components/drive/tag-view';

export const Route = createFileRoute('/_authenticated/app/_drive/tags/$tagId')({
    head: () => ({ meta: [{ title: 'Tag · HushOS' }] }),
    component: DriveTagPage,
});

function DriveTagPage() {
    const { tagId } = Route.useParams();
    return <TagView key={tagId} tagId={tagId} />;
}
