import { useQuery } from '@tanstack/react-query';
import { createFileRoute, Navigate } from '@tanstack/react-router';
import { RotateCcwIcon, TriangleAlertIcon } from 'lucide-react';
import { EmptyState, SkeletonRows } from '@/components/drive/file-list';
import { useDrive } from '@/components/drive/drive-shell';
import { Button } from '@/components/ui/button';
import { familiesQueryOptions } from '@/lib/families-shell';
import { errorCopy } from '@/lib/groups/copy';

export const Route = createFileRoute('/_authenticated/app/_drive/families/')({
    head: () => ({ meta: [{ title: 'Family · HushOS' }] }),
    component: FamiliesRedirect,
});

/*
 * There is no list of families any more: an account is in one at most
 * (docs/families-shared-pool.md decision 2). Old links here go to that
 * family's page, or, for someone in none (or only waiting to join), to
 * Account → Family, where a family is created and invitations are listed.
 */
function FamiliesRedirect() {
    const { userId } = useDrive();
    const families = useQuery(familiesQueryOptions(userId));
    if (families.isPending) return <SkeletonRows rows={2} />;
    if (families.isError)
        return (
            <EmptyState
                icon={TriangleAlertIcon}
                tone="danger"
                title="Your family couldn’t be opened"
                body={errorCopy(families.error)}
            >
                <Button variant="outline" onClick={() => void families.refetch()}>
                    <RotateCcwIcon />
                    Try again
                </Button>
            </EmptyState>
        );
    const yours = families.data.find((at) => at.kind === 'family' && at.state === 'active');
    return yours ? (
        <Navigate to="/app/families/$groupId" params={{ groupId: yours.id }} replace />
    ) : (
        <Navigate to="/app/account" hash="family" replace />
    );
}
