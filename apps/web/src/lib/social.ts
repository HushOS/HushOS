import { authEnv } from '@hushos/env/auth';
import { createIsomorphicFn } from '@tanstack/react-start';

export const publicOrigin = createIsomorphicFn()
    .server(() => authEnv.APP_ORIGIN)
    .client(() => window.location.origin);
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
                        offers: { '@type': 'Offer', price: '0', priceCurrency: 'USD' },
                    },
                ],
            }),
        },
    ];
}
export function publicSocialMeta(origin: string, kind: 'home' | 'share' = 'home') {
    const title =
        kind === 'home' ? 'HushOS · A private place for your work' : 'Shared with you · HushOS';
    const description =
        kind === 'home'
            ? 'An open-source, self-hostable productivity suite. Your password never leaves your device.'
            : 'A private share on HushOS.';
    const image = new URL(kind === 'home' ? '/og.jpg' : '/share-og.jpg', origin).href;
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
