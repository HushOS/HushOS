import { createFileRoute, redirect } from '@tanstack/react-router';

/* Contacts became People you share with; old links and bookmarks land there. */
export const Route = createFileRoute('/_authenticated/app/_drive/contacts')({
    beforeLoad: () => {
        throw redirect({ to: '/app/people', replace: true });
    },
});
