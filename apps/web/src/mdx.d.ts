declare module '*.mdx' {
    import type { ComponentType } from 'react';
    import type { MDXComponents } from 'mdx/types';
    export const frontmatter: Record<string, unknown>;
    /* The `##` headings in order; see mdx-headings.ts. */
    export const headings: { id: string; title: string }[];
    const MDXContent: ComponentType<{ components?: MDXComponents }>;
    export default MDXContent;
}

/* The frontmatter alone; see `mdxMeta` in vite.config.ts. */
declare module '*.mdx?meta' {
    export const frontmatter: Record<string, unknown>;
}
