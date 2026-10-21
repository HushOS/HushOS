import { useQuery } from '@tanstack/react-query';
import { createFileRoute } from '@tanstack/react-router';
import { RotateCcwIcon } from 'lucide-react';
import { EmptyState, SkeletonRows } from '@/components/drive/file-list';
import { useDrive } from '@/components/drive/drive-shell';
import { FamilyPage } from '@/components/families/family-page';
import { NoFamily } from '@/components/families/no-family';
import { Button } from '@/components/ui/button';
import { activeFamily, familiesQueryOptions, familiesSyncQueryOptions } from '@/lib/families';
import { useBackFromCheckout, useCheckoutOpening } from '@/lib/family-checkout';
import { errorCopy } from '@/lib/groups/copy';

export const Route = createFileRoute('/_authenticated/app/_drive/family/')({
    head: () => ({ meta: [{ title: 'Family · HushOS' }] }),
    // Back from Polar's checkout: `checkout_id` says a plan is on its way. From Plans on a locked
    // device: `create` is the family tier chosen there, priced in `currency`.
    validateSearch: (
        search: Record<string, unknown>,
    ): { checkout_id?: string; create?: string; currency?: string } => ({
        ...(typeof search.checkout_id === 'string' ? { checkout_id: search.checkout_id } : {}),
        ...(typeof search.create === 'string' ? { create: search.create } : {}),
        ...(typeof search.currency === 'string' ? { currency: search.currency } : {}),
    }),
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
    const { checkout_id: checkoutId, create, currency } = Route.useSearch();
    const families = useQuery(familiesQueryOptions(userId));
    // Read here, never started: the Drive runtime runs it.
    const pass = useQuery({ ...familiesSyncQueryOptions(userId), enabled: false });
    // Back from a family's checkout, it goes on here, to the family (lib/family-checkout.ts); a
    // family being made for its checkout leaves this page as it was until the browser leaves.
    useBackFromCheckout(userId, { stay: !create });
    const opening = useCheckoutOpening(userId);
    if (families.isPending) return <SkeletonRows rows={3} />;
    if (families.isError)
        return (
            <EmptyState title="Your family couldn’t be opened" body={errorCopy(families.error)}>
                <Button variant="outline" onClick={() => void families.refetch()}>
                    <RotateCcwIcon />
                    Try again
                </Button>
            </EmptyState>
        );
    const notices = pass.data?.notices ?? [];
    const yours = opening ? undefined : activeFamily(families.data);
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
            create={create ? { planId: create, currency } : undefined}
        />
    );
}
