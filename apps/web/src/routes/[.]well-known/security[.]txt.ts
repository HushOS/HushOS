import { createFileRoute } from '@tanstack/react-router';
import { securityTxt } from '@/lib/security-txt.server';

export const Route = createFileRoute('/.well-known/security.txt')({
    server: { handlers: { GET: () => securityTxt() } },
});
