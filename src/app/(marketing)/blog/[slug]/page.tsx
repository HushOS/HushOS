import { Metadata } from 'next';
import { posts } from '@@/.velite';

import { MDXContent } from '@/components/mdx-content';
import { Separator } from '@/components/ui/separator';
import { clientEnvs } from '@/env/client';

export const dynamicParams = false;

export function generateStaticParams() {
    return posts.map(({ slug }) => ({ slug }));
}

export function generateMetadata({ params: { slug } }: { params: { slug: string } }): Metadata {
    const post = posts.find(post => post.slug === slug);
    if (!post) {
        return {};
    }

    return {
        title: post.title,
        description: post.excerpt,
        keywords: [
            'HushOS',
            ...post.tags.filter(Boolean).map(tag => tag),
            ...post.categories.filter(Boolean).map(tag => tag),
        ],
        openGraph: {
            title: post.title,
            description: post.excerpt,
            images:
                typeof post.cover === 'string'
                    ? post.cover
                    : {
                          url: post.cover.src,
                      },
            publishedTime: post.date,
            type: 'article',
            url: `https://${clientEnvs.NEXT_PUBLIC_DOMAIN}/blog/${slug}`,
        },
        twitter: {
            title: post.title,
            description: post.excerpt,
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
    const post = posts.find(post => post.slug === slug)!;

    return (
        <div key={post.slug} className='space-y-2'>
            <h1 className='text-3xl'>{post.title}</h1>
            <div className='space-x-2 text-xs text-muted-foreground'>
                <time dateTime={post.date}>{new Date(post.date).toDateString()}</time>
                <span>·</span>
                <span>{post.categories}</span>
            </div>
            <div className='pt-4'>
                <Separator />
            </div>
            <MDXContent code={post.content} />
        </div>
    );
}
