import { createFileRoute } from '@tanstack/react-router';
import { DriveShell } from '@/components/drive/drive-shell';
import { FolderView } from '@/components/drive/folder-view';

export const Route = createFileRoute('/_authenticated/app/f/$folderId')({
    head: () => ({ meta: [{ title: 'Drive · HushOS' }] }),
    // The file open in the viewer, so a preview has a URL of its own and the
    // back button closes it.
    validateSearch: (search: Record<string, unknown>): { preview?: string } =>
        typeof search.preview === 'string' && /^[0-9a-f-]{36}$/.test(search.preview)
            ? { preview: search.preview }
            : {},
    component: DriveFolderPage,
});

function DriveFolderPage() {
    const { user } = Route.useRouteContext();
    const { folderId } = Route.useParams();
    return (
        <DriveShell user={user}>
            <FolderView key={folderId} folderId={folderId} />
        </DriveShell>
    );
}
