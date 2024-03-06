import { posts } from '@@/.velite';

import { clientEnvs } from '@/env/client';

export default async function Sitemap() {
    return [
        {
            url: `https://${clientEnvs.NEXT_PUBLIC_DOMAIN}/`,
            lastModified: new Date().toISOString().split('T')[0],
        },
        {
            url: `https://${clientEnvs.NEXT_PUBLIC_DOMAIN}/blog`,
            lastModified: new Date(),
        },
        ...posts.map(post => ({
            url: `https://${clientEnvs.NEXT_PUBLIC_DOMAIN}/blog/${post.slug}`,
            lastModified: new Date(post.date).toISOString().split('T')[0],
        })),
    ];
}
