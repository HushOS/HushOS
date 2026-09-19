import { createFileRoute } from '@tanstack/react-router';
import { socialImage } from '@/lib/og.server';
export const Route = createFileRoute('/og.jpg')({
    server: { handlers: { GET: () => socialImage('home') } },
});
