import { createFileRoute } from '@tanstack/react-router';
import { TrashView } from '@/components/drive/trash-view';

export const Route = createFileRoute('/_authenticated/app/_drive/trash')({
    head: () => ({ meta: [{ title: 'Trash · HushOS' }] }),
    component: DriveTrashPage,
});

function DriveTrashPage() {
    return (
        <>
            <TrashView />
        </>
    );
}
