import { createFileRoute, redirect } from '@tanstack/react-router';

/* /app opens Drive for now; an overview of the suite will take this place later. */
export const Route = createFileRoute('/_authenticated/app/')({
    beforeLoad: () => {
        throw redirect({ to: '/app/drive', replace: true });
    },
});
