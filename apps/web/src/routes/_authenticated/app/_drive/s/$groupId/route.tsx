import { createFileRoute, Outlet } from '@tanstack/react-router';
import { FamilySpaceScope } from '@/components/families/family-space';

/* A family's space: its folders (components/families/family-space.tsx). */
export const Route = createFileRoute('/_authenticated/app/_drive/s/$groupId')({
    head: () => ({ meta: [{ title: 'Family folders · HushOS' }] }),
    component: FamilySpaceLayout,
});

function FamilySpaceLayout() {
    const { groupId } = Route.useParams();
    return (
        <FamilySpaceScope groupId={groupId}>
            <Outlet />
        </FamilySpaceScope>
    );
}
