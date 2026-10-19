import { useQuery } from '@tanstack/react-query';
import { createFileRoute } from '@tanstack/react-router';
import { RotateCcwIcon, TriangleAlertIcon } from 'lucide-react';
import { EmptyState, SkeletonRows } from '@/components/drive/file-list';
import { useDrive } from '@/components/drive/drive-shell';
import { FamilyPage } from '@/components/families/family-page';
import { NoFamily } from '@/components/families/no-family';
import { Button } from '@/components/ui/button';
import { activeFamily, familiesQueryOptions, familiesSyncQueryOptions } from '@/lib/families';
import { errorCopy } from '@/lib/groups/copy';

export const Route = createFileRoute('/_authenticated/app/_drive/family/')({
    head: () => ({ meta: [{ title: 'Family · HushOS' }] }),
    // Back from Polar's checkout: `checkout_id` says a plan is on its way.
    validateSearch: (search: Record<string, unknown>): { checkout_id?: string } =>
        typeof search.checkout_id === 'string' ? { checkout_id: search.checkout_id } : {},
    component: FamilyRoute,
});

/*
 * Account → Family (docs/families-shared-pool.md 7.2): the family page of the
 * one family the account is in, or, in none, Create a family and the
 * invitations sent to it. The app-wide pass's notices (the Drive runtime runs
 * it, and it empties the outbox before any family page syncs) are shown here
 * for every family, including one the account has left.
 */
function FamilyRoute() {
    const { userId } = useDrive();
    const { checkout_id: checkoutId } = Route.useSearch();
    const families = useQuery(familiesQueryOptions(userId));
    // Read here, never started: the Drive runtime runs it.
    const pass = useQuery({ ...familiesSyncQueryOptions(userId), enabled: false });
    if (families.isPending) return <SkeletonRows rows={3} />;
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
    const notices = pass.data?.notices ?? [];
    const yours = activeFamily(families.data);
    if (yours)
        return (
            <FamilyPage
                key={yours.id}
                groupId={yours.id}
                checkoutId={checkoutId}
                appNotices={notices}
            />
        );
    return (
        <NoFamily
            userId={userId}
            families={families.data}
            notices={notices}
            nameOf={(id) => families.data.find((at) => at.id === id)?.name}
        />
    );
}
