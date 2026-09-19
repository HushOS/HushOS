import type { ComponentType } from 'react';
import { postSlug } from '@/lib/content';

/* The compiled posts, keyed by slug. Only the post page imports this, so only it carries them. */
const modules = import.meta.glob<{ default: ComponentType }>('../content/blog/*.mdx', {
    eager: true,
});

export const postBodies = Object.fromEntries(
    Object.entries(modules).map(([path, module]) => [postSlug(path), module.default]),
);
