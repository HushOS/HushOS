import { createFileRoute, Navigate } from '@tanstack/react-router';

/*
 * A family's old address: the family page is /app/family now, for the one
 * family the account is in. Links already sent keep working, a checkout's
 * return included. The join screen keeps its address (./join).
 */
export const Route = createFileRoute('/_authenticated/app/_drive/families/$groupId/')({
    validateSearch: (search: Record<string, unknown>): { checkout_id?: string } =>
        typeof search.checkout_id === 'string' ? { checkout_id: search.checkout_id } : {},
    component: OldFamilyAddress,
});

function OldFamilyAddress() {
    const search = Route.useSearch();
    return <Navigate to="/app/family" search={search} replace />;
}
