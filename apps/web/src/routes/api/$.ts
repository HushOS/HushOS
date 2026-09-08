import { createFileRoute } from '@tanstack/react-router';
import { handleApiRequest } from '@/lib/api.server';

export const Route = createFileRoute('/api/$')({
    server: {
        handlers: {
            ANY: ({ request }) => handleApiRequest(request),
        },
    },
});
