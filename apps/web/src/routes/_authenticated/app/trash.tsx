import { createFileRoute } from '@tanstack/react-router';
import { DriveShell } from '@/components/drive/drive-shell';
import { TrashView } from '@/components/drive/trash-view';

export const Route = createFileRoute('/_authenticated/app/trash')({
    head: () => ({ meta: [{ title: 'Trash · HushOS' }] }),
    component: DriveTrashPage,
});

function DriveTrashPage() {
    const { user } = Route.useRouteContext();
    return (
        <DriveShell user={user}>
            <TrashView />
        </DriveShell>
    );
}
