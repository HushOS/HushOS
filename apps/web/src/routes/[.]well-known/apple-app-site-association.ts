import { createFileRoute } from '@tanstack/react-router';
import { appleAppSiteAssociation } from '@/lib/site/app-links.server';

export const Route = createFileRoute('/.well-known/apple-app-site-association')({
    server: { handlers: { GET: () => appleAppSiteAssociation() } },
});
