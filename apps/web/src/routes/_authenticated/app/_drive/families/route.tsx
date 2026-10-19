import { createFileRoute, Outlet } from '@tanstack/react-router';
import { FamiliesGate } from '@/components/families/families-gate';

/* The old families addresses: shown only where families are served (FamiliesGate). */
export const Route = createFileRoute('/_authenticated/app/_drive/families')({
    component: () => (
        <FamiliesGate>
            <Outlet />
        </FamiliesGate>
    ),
});
