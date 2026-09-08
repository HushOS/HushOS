import type { ComponentType } from 'react';

export type PostMeta = {
    title: string;
    description: string;
    date: string;
    author: string;
};

type Module = { default: ComponentType; frontmatter: PostMeta };

/* Every post ships in the bundle; the blog is small and server-rendered. */
const modules = import.meta.glob<Module>('../content/blog/*.mdx', { eager: true });

export const posts = Object.entries(modules)
    .map(([path, module]) => ({
        slug: path
            .split('/')
            .pop()!
            .replace(/\.mdx$/, ''),
        meta: module.frontmatter,
        Content: module.default,
    }))
    .sort((a, b) => b.meta.date.localeCompare(a.meta.date));

export function formatDate(value: string) {
    return new Date(value).toLocaleDateString('en-GB', {
        day: 'numeric',
        month: 'long',
        year: 'numeric',
    });
}
