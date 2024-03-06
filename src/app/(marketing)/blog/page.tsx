import { Metadata } from 'next';
import Link from 'next/link';
import { posts } from '@@/.velite';

import { Separator } from '@/components/ui/separator';
import { clientEnvs } from '@/env/client';

export const metadata: Metadata = {
    title: 'Blog',
    keywords: ['HushOS', 'Blog'],
    description: 'Your privacy operating system!',
    openGraph: {
        title: 'Blog',
        url: `https://${clientEnvs.NEXT_PUBLIC_DOMAIN}/blog`,
        description: 'Your privacy operating system!',
        // images: getOgImageUrl('Blog'),
        type: 'website',
    },
    twitter: {
        title: 'Blog',
        description: 'Your privacy operating system!',
        // images: getOgImageUrl('Blog'),
        card: 'summary_large_image',
    },
};

export default function BlogPage() {
    return (
        <>
            {posts.map(post => (
                <div key={post.slug} className='space-y-2'>
                    <Link href={post.permalink}>
                        <h2 className='text-3xl'>{post.title}</h2>
                    </Link>
                    <div className='space-x-2 text-xs text-muted-foreground'>
                        <time dateTime={post.date}>{new Date(post.date).toDateString()}</time>
                        <span>·</span>
                        <span>{post.categories}</span>
                    </div>
                    <div className='pt-4'>
                        <Separator />
                    </div>
                </div>
            ))}
        </>
    );
}
