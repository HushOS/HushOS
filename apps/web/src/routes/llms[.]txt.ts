import { createFileRoute } from '@tanstack/react-router';
import { getCatalogueServerFn } from '@/lib/billing';
import { comparisons } from '@/lib/compare';
import { formatGiB } from '@/lib/queries';
import { publicOrigin } from '@/lib/social';

/* Plain-text guidance for AI systems, per the TanStack Start GEO guide. */
export const Route = createFileRoute('/llms.txt')({
    server: {
        handlers: {
            GET: async () => {
                const origin = publicOrigin();
                const catalogue = await getCatalogueServerFn();
                const plans = catalogue.enabled
                    ? [
                          `- Free: ${formatGiB(catalogue.freeQuotaBytes)} of encrypted storage.`,
                          ...catalogue.plans.map(
                              (plan) =>
                                  `- ${plan.name}: ${formatGiB(plan.quotaBytes)} per ${plan.interval}, ${Object.entries(
                                      plan.prices,
                                  )
                                      .map(
                                          ([currency, amount]) =>
                                              `${(amount / 100).toFixed(2)} ${currency.toUpperCase()}`,
                                      )
                                      .join(' / ')}.`,
                          ),
                          `- Full details: ${origin}/pricing`,
                      ].join('\n')
                    : '- This instance is self-hosted and has no paid plans.';
                const body = `# HushOS

> Private storage for your files, personal or work, that is simple to use. Open source and self-hostable. Files are encrypted on the person's device; the service cannot read them.

## Key facts

- HushOS Drive: folders, resumable uploads, previews (images, PDF, video, audio, Markdown, code, Word, spreadsheets, CSV), versions, trash, a grid with thumbnails, and an installable web app.
- Sharing: a folder or file can be shared with another HushOS account as viewer or editor, or by a link that needs no account, with an optional password and expiry. Stopping a share or link rotates the keys beneath it.
- Anyone who can see shared content can report it; operators triage reports, remove content, and can file with authorities. Privacy is not a shield for abuse.
- Sign-in uses OPAQUE, a password-authenticated key exchange. The server never receives the password, not even a hash of it.
- Each account key is generated in the browser and wrapped by the password and by a 24-word recovery phrase. Resetting the password keeps the same key.
- File and folder keys are made on the device and wrapped under the workspace key; content is encrypted in 8 MiB chunks with XChaCha20-Poly1305 before it leaves. The server sees ciphertext, sizes and the tree's shape, never names or contents.
- Every account has an invite link; someone who joins through it earns both people extra storage. Creators can be enrolled as affiliates with a coupon code and a page showing the plans with their discount.
- Mission: make the private choice the easy choice. Drive is the first part of a productivity suite built the same way.
- Licence: GNU AGPL-3.0. Source: https://github.com/HushOS
- Runs with Docker Compose; see the self-hosting guide in the repository.
- The hosted service starts free with 2 GiB; inviting a friend earns both people more storage; paid plans add storage and are billed by Polar as merchant of record. Self-hosted instances set their own allowance and have no billing.

## Pricing (hosted service)

${plans}

## Pages

- ${origin}/ : product overview
- ${origin}/about : what HushOS is, why it exists, what it promises
${comparisons.map((entry) => `- ${origin}/vs/${entry.slug} : HushOS compared with ${entry.name}`).join('\n')}
- ${origin}/security : security model (sign-in, keys, Drive, sharing, reports)
- ${origin}/pricing : plans and prices
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
