import { createFileRoute } from '@tanstack/react-router';
import { assetLinks } from '@/lib/app-links.server';

export const Route = createFileRoute('/.well-known/assetlinks.json')({
    server: { handlers: { GET: () => assetLinks() } },
});
