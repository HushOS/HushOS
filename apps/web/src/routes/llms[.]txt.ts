import { createFileRoute } from '@tanstack/react-router';
import { getCatalogueServerFn } from '@/lib/billing';
import { comparisons } from '@/lib/compare';
import { posts } from '@/lib/content';
import { formatQuota } from '@/lib/queries';
import { publicOrigin } from '@/lib/social';

/*
 * Guidance for AI systems, per the TanStack Start GEO guide and llmstxt.org:
 * an H1, a summary, then sections of Markdown links, one per line.
 */
export const Route = createFileRoute('/llms.txt')({
    server: {
        handlers: {
            GET: async () => {
                const origin = publicOrigin();
                const catalogue = await getCatalogueServerFn();
                const plans = catalogue.enabled
                    ? [
                          `- Free: ${formatQuota(catalogue.freeQuotaBytes)} of encrypted storage.`,
                          ...catalogue.plans.map(
                              (plan) =>
                                  `- ${plan.name}: ${formatQuota(plan.quotaBytes)} per ${plan.interval}, ${Object.entries(
                                      plan.prices,
                                  )
                                      .map(
                                          ([currency, amount]) =>
                                              `${(amount / 100).toFixed(2)} ${currency.toUpperCase()}`,
                                      )
                                      .join(' / ')}.`,
                          ),
                          `- [Full details](${origin}/pricing)`,
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
- File and folder keys are made on the device and wrapped under the workspace key; content is padded (Padmé) and encrypted in 8 MiB chunks with XChaCha20-Poly1305 before it leaves. The server sees ciphertext, the tree's shape and padded sizes, never names or contents: below 256 bytes everything is 256, otherwise at most 6.25% is added, so a file's size is known only to within roughly 2 KiB around 50 KB, 32 KiB around 1 MB, 2 MiB around 100 MB and 32 MiB around 1 GB.
- Every change is signed by the account that wrote it. Devices check signatures against keys their person compared in person and mark anything else Unverified, or Couldn't check when the check cannot run. The server stores the writer as an account id alone; link visitors get no signatures or writers.
- Reports are sealed to operator keys the server provides, so whoever runs a server can open what is reported to it.
- Every account has an invite link; someone who joins through it earns both people extra storage. Creators can be enrolled as affiliates with a coupon code and a page showing the plans with their discount.
- Mission: make the private choice the easy choice. Drive is the first part of a productivity suite built the same way.
- Licence: GNU AGPL-3.0. Source: [github.com/HushOS](https://github.com/HushOS)
- Runs with Docker Compose; see the self-hosting guide in the repository.
- The hosted service starts free with 2 GB; inviting a friend earns both people more storage; paid plans add storage and are billed by Polar as merchant of record. Self-hosted instances set their own allowance and have no billing.

## Pricing (hosted service)

${plans}

## Pages

- [HushOS](${origin}/): product overview
- [About](${origin}/about): what HushOS is, why it exists, what it promises
${comparisons.map((entry) => `- [HushOS vs ${entry.name}](${origin}/vs/${entry.slug}): HushOS compared with ${entry.name}`).join('\n')}
- [Security](${origin}/security): security model (sign-in, keys, Drive, sharing, reports)
- [Roadmap](${origin}/roadmap): what has shipped, what is being built now, and what is planned
- [Pricing](${origin}/pricing): plans and prices
- [Design guidelines](${origin}/design.md): DESIGN.md format
- [Terms of Service](${origin}/terms)
- [Privacy Policy](${origin}/privacy)
- [Create an account](${origin}/register)

## Blog

${posts.map((post) => `- [${post.meta.title}](${origin}/blog/${post.slug}): ${post.meta.description}`).join('\n')}
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
