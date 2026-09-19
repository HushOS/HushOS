import { createFileRoute, Outlet } from '@tanstack/react-router';
import { DriveShell } from '@/components/drive/drive-shell';

/*
 * Every page that needs the account unlocked and the workspace open sits under
 * this layout: the shell gates once, holds the Drive context, and the pages
 * beneath it come and go without it.
 */
export const Route = createFileRoute('/_authenticated/app/_drive')({
    component: DriveLayout,
});

function DriveLayout() {
    const { user } = Route.useRouteContext();
    return (
        <DriveShell user={user}>
            <Outlet />
        </DriveShell>
    );
}
