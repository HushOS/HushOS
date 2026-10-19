import { createFileRoute, Outlet } from '@tanstack/react-router';
import { FamiliesGate } from '@/components/families/families-gate';

/* Account → Family: shown only where families are served (FamiliesGate). */
export const Route = createFileRoute('/_authenticated/app/_drive/family')({
    component: () => (
        <FamiliesGate>
            <Outlet />
        </FamiliesGate>
    ),
});
