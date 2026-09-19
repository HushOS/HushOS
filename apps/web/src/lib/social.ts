import { appEnv } from '@hushos/env/app';
import { queryOptions, type QueryClient } from '@tanstack/react-query';
import { createIsomorphicFn, createServerFn } from '@tanstack/react-start';

export const publicOrigin = createIsomorphicFn()
    .server(() => appEnv.APP_ORIGIN)
    .client(() => window.location.origin);

export type Operator = { name: string; jurisdiction: string | null; contact: string | null } | null;
/* Who runs this instance, for the legal pages. Loaders pass it to the document. */
export const readOperator = createIsomorphicFn()
    .server((): Operator =>
        appEnv.OPERATOR_NAME
            ? {
                  name: appEnv.OPERATOR_NAME,
                  jurisdiction: appEnv.OPERATOR_JURISDICTION ?? null,
                  contact: appEnv.OPERATOR_CONTACT ?? null,
              }
            : null,
    )
    .client((): Operator => null);
/*
 * Whose name the copyright line carries: the operator of this instance, as the
 * legal pages name them, or HushOS when none is set. Asked once per visit and
 * kept, since every public page draws the footer.
 */
const getOperatorNameServerFn = createServerFn().handler(() => appEnv.OPERATOR_NAME ?? null);
export const operatorNameQueryOptions = queryOptions({
    queryKey: ['operator', 'name'],
    queryFn: () => getOperatorNameServerFn(),
    staleTime: Number.POSITIVE_INFINITY,
});
export function operatorHint(queryClient: QueryClient) {
    return queryClient.ensureQueryData(operatorNameQueryOptions);
}

/* Organisation and product facts for search and AI crawlers, following the Start SEO and GEO guides. */
export function structuredData(origin: string) {
    return [
        {
            type: 'application/ld+json',
            children: JSON.stringify({
                '@context': 'https://schema.org',
                '@graph': [
                    {
                        '@type': 'Organization',
                        '@id': `${origin}/#organization`,
                        name: 'HushOS',
                        url: origin,
                        logo: `${origin}/brand/hushos-logo.svg`,
                        sameAs: ['https://github.com/HushOS'],
                    },
                    {
                        '@type': 'WebSite',
                        '@id': `${origin}/#website`,
                        url: origin,
                        name: 'HushOS',
                        publisher: { '@id': `${origin}/#organization` },
                    },
                    {
                        '@type': 'SoftwareApplication',
                        name: 'HushOS',
                        applicationCategory: 'BusinessApplication',
                        operatingSystem: 'Web',
                        url: origin,
                        description:
                            'An open-source, self-hostable productivity suite. Sign-in uses OPAQUE so the password never leaves the device; account keys are generated and wrapped in the browser.',
                        license: 'https://www.gnu.org/licenses/agpl-3.0.html',
                        offers: {
                            '@type': 'Offer',
                            price: '0',
                            priceCurrency: 'USD',
                            url: `${origin}/pricing`,
                        },
                    },
                ],
            }),
        },
    ];
}
/*
 * The full set of tags a shared link needs, for any public page: title and
 * description, the Open Graph and Twitter fields, and the site's image, so a
 * post or a comparison unfurls with a card rather than a bare link.
 */
export function pageSocialMeta(input: {
    origin: string;
    path: string;
    title: string;
    description: string;
    type?: 'website' | 'article';
    /* The card's key under /og/<key>.jpg; the site card when absent. */
    card?: string;
}) {
    const image = new URL(input.card ? `/og/${input.card}.jpg` : '/og.jpg', input.origin).href;
    return [
        { title: `${input.title} · HushOS` },
        { name: 'description', content: input.description },
        { property: 'og:type', content: input.type ?? 'website' },
        { property: 'og:site_name', content: 'HushOS' },
        { property: 'og:title', content: input.title },
        { property: 'og:description', content: input.description },
        { property: 'og:url', content: new URL(input.path, input.origin).href },
        { property: 'og:image', content: image },
        { property: 'og:image:type', content: 'image/jpeg' },
        { property: 'og:image:width', content: '1200' },
        { property: 'og:image:height', content: '630' },
        { property: 'og:image:alt', content: input.title },
        { name: 'twitter:card', content: 'summary_large_image' },
        { name: 'twitter:title', content: input.title },
        { name: 'twitter:description', content: input.description },
        { name: 'twitter:image', content: image },
    ];
}

export function publicSocialMeta(origin: string) {
    const title = 'HushOS · You hold the only key.';
    const description =
        'Private storage for your files, personal or work, that is simple to use. Locked on your device; open source; run it yourself if you like.';
    const image = new URL('/og.jpg', origin).href;
    return [
        { title },
        { name: 'description', content: description },
        { property: 'og:type', content: 'website' },
        { property: 'og:site_name', content: 'HushOS' },
        { property: 'og:title', content: title },
        { property: 'og:description', content: description },
        { property: 'og:image', content: image },
        { property: 'og:image:type', content: 'image/jpeg' },
        { property: 'og:image:width', content: '1200' },
        { property: 'og:image:height', content: '630' },
        { property: 'og:image:alt', content: title },
        { name: 'twitter:card', content: 'summary_large_image' },
        { name: 'twitter:title', content: title },
        { name: 'twitter:description', content: description },
        { name: 'twitter:image', content: image },
    ];
}
