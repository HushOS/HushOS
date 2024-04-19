import rehypeShiki from '@shikijs/rehype';
import { defineConfig, s } from 'velite';

const slugify = (input: string) =>
    input
        .toLowerCase()
        .replace(/\s+/g, '-')
        .replace(/[^a-z0-9-]/g, '');

const icon = s.enum(['github', 'instagram', 'medium', 'twitter', 'youtube']);
const count = s.object({ total: s.number(), posts: s.number() }).default({ total: 0, posts: 0 });

const meta = s
    .object({
        title: s.string().optional(),
        description: s.string().optional(),
        keywords: s.array(s.string()).optional(),
    })
    .default({});

export default defineConfig({
    root: 'src/content',
    output: {
        data: '.velite',
        assets: 'public/static',
        base: '/static/',
        name: '[name]-[hash:6].[ext]',
        clean: true,
    },
    collections: {
        options: {
            name: 'Options',
            pattern: 'options/index.yml',
            single: true,
            schema: s.object({
                name: s.string().max(20),
                title: s.string().max(99),
                description: s.string().max(999).optional(),
                keywords: s.array(s.string()),
                author: s.object({
                    name: s.string(),
                    email: s.string().email(),
                    url: s.string().url(),
                }),
                links: s.array(
                    s.object({
                        text: s.string(),
                        link: s.string(),
                        type: s.enum(['navigation', 'footer', 'copyright']),
                    })
                ),
                socials: s.array(
                    s.object({
                        name: s.string(),
                        icon,
                        link: s.string().optional(),
                        image: s.image().optional(),
                    })
                ),
            }),
        },
        categories: {
            name: 'Category',
            pattern: 'categories/*.yml',
            schema: s
                .object({
                    name: s.string().max(20),
                    slug: s.slug('global', ['admin', 'login']),
                    cover: s.image().optional(),
                    description: s.string().max(999).optional(),
                    count,
                })
                .transform(data => ({ ...data, permalink: `/${data.slug}` })),
        },
        tags: {
            name: 'Tag',
            pattern: 'tags/index.yml',
            schema: s
                .object({
                    name: s.string().max(20),
                    slug: s.slug('global', ['admin', 'login']),
                    cover: s.image().optional(),
                    description: s.string().max(999).optional(),
                    count,
                })
                .transform(data => ({ ...data, permalink: `/${data.slug}` })),
        },
        pages: {
            name: 'Page',
            pattern: 'pages/**/*.mdx',
            schema: s
                .object({
                    title: s.string().max(99),
                    slug: s.slug('global', ['admin', 'login']),
                    body: s.mdx(),
                })
                .transform(data => ({ ...data, permalink: `/${data.slug}` })),
        },
        posts: {
            name: 'Post',
            pattern: 'posts/**/*.mdx',
            schema: s
                .object({
                    title: s.string().max(99),
                    slug: s.slug('post'),
                    date: s.isodate(),
                    updated: s.isodate().optional(),
                    cover: s.image().optional(),
                    video: s.file().optional(),
                    description: s.string().max(999).optional(),
                    draft: s.boolean().default(false),
                    featured: s.boolean().default(false),
                    categories: s.array(s.string()).default([]),
                    tags: s.array(s.string()).default([]),
                    meta: meta,
                    metadata: s.metadata(),
                    excerpt: s.excerpt(),
                    content: s.mdx(),
                })
                .transform(data => ({
                    ...data,
                    cover:
                        data.cover === undefined
                            ? `/api/og?title=${encodeURIComponent(data.title)}`
                            : data.cover,
                    permalink: `/blog/${data.slug}`,
                })),
        },
    },
    mdx: {
        rehypePlugins: [
            [
                rehypeShiki as any,
                {
                    themes: {
                        light: 'catppuccin-latte',
                        dark: 'catppuccin-mocha',
                    },
                },
            ],
        ],
    },
    markdown: {
        rehypePlugins: [
            [
                rehypeShiki as any,
                {
                    themes: {
                        light: 'catppuccin-latte',
                        dark: 'catppuccin-mocha',
                    },
                },
            ],
        ],
    },
    prepare: ({ categories, tags, posts }) => {
        const docs = posts.filter(i => process.env.NODE_ENV !== 'production' || !i.draft);

        // missing categories, tags from posts inlined
        const categoriesFromDoc = Array.from(
            new Set(docs.map(item => item.categories).flat())
        ).filter(i => categories.find(j => j.name === i) == null);
        categories.push(
            ...categoriesFromDoc.map(name => ({
                name,
                slug: slugify(name),
                permalink: '',
                count: { total: 0, posts: 0 },
            }))
        );
        categories.forEach(i => {
            i.count.posts = posts.filter(j => j.categories.includes(i.name)).length;
            i.count.total = i.count.posts;
            i.permalink = `/${i.slug}`;
        });

        const tagsFromDoc = Array.from(new Set(docs.map(item => item.tags).flat())).filter(
            i => tags.find(j => j.name === i) == null
        );
        tags.push(
            ...tagsFromDoc.map(name => ({
                name,
                slug: slugify(name),
                permalink: '',
                count: { total: 0, posts: 0 },
            }))
        );
        tags.forEach(i => {
            i.count.posts = posts.filter(j => j.tags.includes(i.name)).length;
            i.count.total = i.count.posts;
            i.permalink = `/${i.slug}`;
        });

        // return false to prevent velite from writing data to disk
    },
});
