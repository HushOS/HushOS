import type { TagColour, TagPreset, TagRegistry } from '@hushos/drive/client';
import { queryOptions, useQuery, type QueryClient } from '@tanstack/react-query';
import { useMemo } from 'react';
import { driveClient, useCatalogueState } from '@/lib/drive';

/*
 * The tag registry as the query layer sees it, and what a tag looks like. The
 * registry is the workspace's sealed document; the counts come from the
 * catalogue on this device, so they follow the build and the feed.
 */
export const tagKeys = { registry: ['drive', 'tags'] as const };

export const tagsQueryOptions = queryOptions({
    queryKey: tagKeys.registry,
    queryFn: () => driveClient.tags(true),
    staleTime: 30_000,
});

export function invalidateTags(queryClient: QueryClient) {
    return queryClient.invalidateQueries({ queryKey: tagKeys.registry });
}

/* The five presets as the swatch's background; a hex colour paints itself. */
export const TAG_SWATCH: Record<TagPreset, string> = {
    blue: 'bg-primary',
    ink: 'bg-ink',
    yellow: 'bg-warning',
    teal: 'bg-success',
    coral: 'bg-destructive',
};
export const TAG_COLOUR_LABEL: Record<TagPreset, string> = {
    blue: 'Blue',
    ink: 'Ink',
    yellow: 'Yellow',
    teal: 'Teal',
    coral: 'Coral',
};
/*
 * A stamp's ink: the colour as CSS and the text that reads on it. A preset
 * brings its own foreground token, so it follows the theme; a hex colour gets
 * ink or sheet-coloured text, whichever contrasts more with it, and a rim of
 * itself a shade deeper so a white or pale tag keeps an edge on the page.
 */
const TAG_INK: Record<TagPreset, { fill: string; text: string }> = {
    blue: { fill: 'var(--primary)', text: 'var(--primary-foreground)' },
    ink: { fill: 'var(--ink)', text: 'var(--card)' },
    yellow: { fill: 'var(--warning)', text: 'var(--warning-foreground)' },
    teal: { fill: 'var(--success)', text: 'var(--success-foreground)' },
    coral: { fill: 'var(--destructive)', text: 'var(--destructive-foreground)' },
};
function luminance(hex: string) {
    const channel = (at: number) => {
        const c = Number.parseInt(hex.slice(at, at + 2), 16) / 255;
        return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    };
    return 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5);
}
// A hex tag is the same in both themes, so its text is too: the light theme's ink and sheet.
const INK = '#1c2848';
const SHEET = '#fcfbf7';
const INK_LUMINANCE = luminance(INK);
const SHEET_LUMINANCE = luminance(SHEET);
export function tagInk(colour: TagColour | null): { fill: string; text: string } {
    if (colour && colour in TAG_INK) return TAG_INK[colour as TagPreset];
    if (colour) {
        const fill = luminance(colour);
        const onInk = (fill + 0.05) / (INK_LUMINANCE + 0.05);
        const onSheet = (SHEET_LUMINANCE + 0.05) / (fill + 0.05);
        return { fill: colour, text: onInk >= onSheet ? INK : SHEET };
    }
    return { fill: 'var(--muted-foreground)', text: 'var(--card)' };
}
export function swatchProps(colour: TagColour | null) {
    if (colour && colour in TAG_SWATCH)
        return { className: TAG_SWATCH[colour as TagPreset], style: undefined };
    if (colour) return { className: '', style: { backgroundColor: colour } };
    return { className: 'bg-muted-foreground', style: undefined };
}

export function tagById(registry: TagRegistry | null | undefined, id: string) {
    return registry?.tags.find((tag) => tag.id === id) ?? null;
}

/* Live items per tag on this device; recomputed as the catalogue opens rows and as the registry arrives. */
export function useTagCounts() {
    const state = useCatalogueState();
    const registry = useQuery(tagsQueryOptions).data;
    // eslint-disable-next-line react-hooks/exhaustive-deps
    return useMemo(() => driveClient.tagCounts(), [state.phase, state.opened, registry]);
}
