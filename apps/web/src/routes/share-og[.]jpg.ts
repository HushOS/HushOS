import { createFileRoute } from '@tanstack/react-router';
import { socialImage } from '@/lib/og.server';
// Generic preview prepared for future share pages; it exposes no share metadata.
export const Route = createFileRoute('/share-og.jpg')({
    server: { handlers: { GET: () => socialImage('share') } },
});
