import { createFileRoute } from '@tanstack/react-router';
import { getCatalogueServerFn } from '@/lib/billing';
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

> An open-source, self-hostable productivity suite. Built so people can verify how it protects them instead of taking the maintainers' word for it.

## Key facts

- Sign-in uses OPAQUE, a password-authenticated key exchange. The server never receives the password, not even a hash of it.
- Each account key is generated in the browser and wrapped by the password and by a 24-word recovery phrase. Resetting the password keeps the same key.
- Account settings support password changes and recovery-key or master-key rotation, each requiring the current password and revoking existing sessions. Master-key rotation also replaces the recovery phrase and rewraps the account's workspace grants; workspace keys are random and independent of the account key.
- Drive follows the same model: file keys are made on the device and content is encrypted before it leaves.
- Licence: GNU AGPL-3.0. Source: https://github.com/HushOS
- Runs with Docker Compose; see the self-hosting guide in the repository.
- The hosted service starts free with 1 GiB; paid plans add storage and are billed by Polar as merchant of record. Self-hosted instances set their own allowance and have no billing.

## Pricing (hosted service)

${plans}

## Pages

- ${origin}/ : product overview
- ${origin}/security : security model (sign-in, password changes, key rotation, recovery)
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
