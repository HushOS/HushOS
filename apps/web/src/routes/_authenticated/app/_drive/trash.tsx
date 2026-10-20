import { useQuery } from '@tanstack/react-query';
import { createFileRoute } from '@tanstack/react-router';
import { useDrive } from '@/components/drive/drive-shell';
import { TrashView } from '@/components/drive/trash-view';
import { FamilySpaceScope } from '@/components/families/family-space';
import { FamilyTrashList } from '@/components/families/family-trash';
import { activeFamily, familiesQueryOptions, useGroupsEnabled } from '@/lib/families-shell';

export const Route = createFileRoute('/_authenticated/app/_drive/trash')({
    head: () => ({ meta: [{ title: 'Trash · HushOS' }] }),
    component: DriveTrashPage,
});

/*
 * Trash: My files', and for someone in a family the family folders' as a second section of
 * the same page (docs/families-shared-pool.md 7.1). Each keeps its own rules: My files' is
 * yours alone; the family folders' is everyone's in the family.
 */
function DriveTrashPage() {
    const { userId } = useDrive();
    const groups = useGroupsEnabled();
    const families = useQuery({ ...familiesQueryOptions(userId), enabled: groups });
    const family = groups ? activeFamily(families.data) : undefined;
    return (
        <>
            <TrashView section={family ? 'My files' : undefined} followed={Boolean(family)} />
            {family && (
                <section
                    id="family"
                    aria-labelledby="family-trash"
                    className="flex scroll-mt-4 flex-col pt-8"
                >
                    <h2
                        id="family-trash"
                        className="px-5 pb-2 text-lg font-bold tracking-[-0.01em] sm:px-8"
                    >
                        Family folders
                    </h2>
                    <FamilySpaceScope groupId={family.id} joinScreen={false}>
                        <FamilyTrashList />
                    </FamilySpaceScope>
                </section>
            )}
        </>
    );
}
