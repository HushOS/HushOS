import { createFileRoute } from '@tanstack/react-router';
import { publicOrigin } from '@/lib/social';

/* Plain-text guidance for AI systems, per the TanStack Start GEO guide. */
export const Route = createFileRoute('/llms.txt')({
    server: {
        handlers: {
            GET: () => {
                const origin = publicOrigin();
                const body = `# HushOS

> An open-source, self-hostable productivity suite. Built so people can verify how it protects them instead of taking the maintainers' word for it.

## Key facts

- Sign-in uses OPAQUE, a password-authenticated key exchange. The server never receives the password, not even a hash of it.
- Each account key is generated in the browser and wrapped by the password and by a 24-word recovery phrase. Resetting the password keeps the same key.
- Account settings support password changes and recovery-key or master-key rotation, each requiring the current password and revoking existing sessions. Master-key rotation also replaces the recovery phrase and currently requires no used or reserved storage.
- Drive file storage and content encryption are not implemented yet.
- Licence: GNU AGPL-3.0. Source: https://github.com/HushOS
- Runs with Docker Compose; see the self-hosting guide in the repository.

## Pages

- ${origin}/ : product overview
- ${origin}/security : security model (sign-in, password changes, key rotation, recovery)
- ${origin}/design.md : design guidelines (DESIGN.md format)
- ${origin}/terms : Terms of Service
- ${origin}/privacy : Privacy Policy
- ${origin}/register : create an account
`;
                return new Response(body, {
                    headers: {
                        'Content-Type': 'text/plain; charset=utf-8',
                        'Cache-Control': 'public, max-age=3600',
                    },
                });
            },
        },
    },
});
