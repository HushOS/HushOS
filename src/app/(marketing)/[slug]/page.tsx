import { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { pages } from '@@/.velite';

import { Main, Section } from '@/components/craft';
import { MDXContent } from '@/components/mdx-content';
import { Separator } from '@/components/ui/separator';
import { clientEnvs } from '@/env/client';

export const dynamicParams = false;

export function generateStaticParams() {
    return pages.map(({ slug }) => ({ slug }));
}

export function generateMetadata({ params: { slug } }: { params: { slug: string } }): Metadata {
    const page = pages.find(page => page.slug === slug);
    if (!page) {
        return {};
    }

    return {
        title: page.title,
        description: page.description,
        keywords: ['HushOS', page.title],
        openGraph: {
            title: page.title,
            description: page.description,
            type: 'article',
            url: `https://${clientEnvs.NEXT_PUBLIC_DOMAIN}/${slug}`,
        },
        twitter: {
            title: page.title,
            description: page.description,
            // images: getOgImageUrl(post.title),
            card: 'summary_large_image',
        },
        robots: {
            index: true,
            follow: true,
            googleBot: {
                index: true,
                follow: true,
                'max-video-preview': -1,
                'max-image-preview': 'large',
                'max-snippet': -1,
            },
        },
    };
}

export default function PostPage({ params: { slug } }: { params: { slug: string } }) {
    const page = pages.find(page => page.slug === slug)!;

    return (
        <Section>
            <h1 className='text-3xl'>{page.title}</h1>
            <h3>{page.description}</h3>
            <div className='pt-4'>
                <Separator />
            </div>
            <MDXContent code={page.body} />
        </Section>
    );
}
