import { createFileRoute } from '@tanstack/react-router';
import { useDrive } from '@/components/drive/drive-shell';
import { FolderView } from '@/components/drive/folder-view';

export const Route = createFileRoute('/_authenticated/app/_drive/drive/')({
    head: () => ({ meta: [{ title: 'Drive · HushOS' }] }),
    // The file open in the viewer, so a preview has a URL of its own and the
    // back button closes it.
    validateSearch: (search: Record<string, unknown>): { preview?: string } =>
        typeof search.preview === 'string' && /^[0-9a-f-]{36}$/.test(search.preview)
            ? { preview: search.preview }
            : {},
    component: DriveRootPage,
});

function RootFolder() {
    const { rootId } = useDrive();
    return <FolderView key={rootId} folderId={rootId} />;
}

function DriveRootPage() {
    return (
        <>
            <RootFolder />
        </>
    );
}
