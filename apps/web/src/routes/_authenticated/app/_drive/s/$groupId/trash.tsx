import { createFileRoute, Navigate } from '@tanstack/react-router';

/*
 * The family folders' Trash, at its old address: it is the family's tab of Trash now, beside
 * My files' (docs/families-shared-pool.md 7.1).
 */
export const Route = createFileRoute('/_authenticated/app/_drive/s/$groupId/trash')({
    component: () => <Navigate to="/app/trash" search={{ view: 'family' }} replace />,
});
