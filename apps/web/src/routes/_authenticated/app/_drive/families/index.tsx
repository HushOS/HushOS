import { createFileRoute, Navigate } from '@tanstack/react-router';

/* The old list of families: an account is in one at most, at Account → Family. */
export const Route = createFileRoute('/_authenticated/app/_drive/families/')({
    component: () => <Navigate to="/app/family" replace />,
});
