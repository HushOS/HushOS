import { useQuery } from '@tanstack/react-query';
import { createFileRoute, Outlet } from '@tanstack/react-router';
import { TriangleAlertIcon, UsersIcon } from 'lucide-react';
import { EmptyState, SkeletonRows } from '@/components/drive/file-list';
import { Button } from '@/components/ui/button';
import { capabilitiesQueryOptions } from '@/lib/families-shell';

/*
 * Every families page: shown only when the server says it serves families
 * (`/drive/capabilities` reports `groups: true`). Elsewhere the pages say so
 * plainly instead of offering buttons whose routes would answer 501.
 */
export const Route = createFileRoute('/_authenticated/app/_drive/families')({
    component: FamiliesLayout,
});

function FamiliesLayout() {
    const capabilities = useQuery(capabilitiesQueryOptions);
    if (capabilities.isPending) return <SkeletonRows rows={3} />;
    if (capabilities.isError)
        return (
            <EmptyState
                icon={TriangleAlertIcon}
                tone="danger"
                title="This page couldn’t be opened"
                body="Couldn’t reach HushOS. Check your connection, then retry."
            >
                <Button variant="outline" onClick={() => void capabilities.refetch()}>
                    Try again
                </Button>
            </EmptyState>
        );
    if (capabilities.data?.groups !== true)
        return (
            <EmptyState
                icon={UsersIcon}
                title="Families aren’t available here"
                body="This HushOS server doesn’t offer families."
            />
        );
    return <Outlet />;
}
