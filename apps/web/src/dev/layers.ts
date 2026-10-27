/*
 * The surfaces HushOS stacks, bottom to top, as DESIGN.md (Colors, Elevation & Depth,
 * Shapes, Motion) and the web code define them today. The Layers page is drawn from
 * this list alone, so a fuller definition (a Grammar section of DESIGN.md) drops in
 * here. `shadow`, `hairline` and `radius` are what the code draws; `differs` says where
 * DESIGN.md asks for something else.
 */

export const SHADOWS = ['none', 'sm', 'md', 'lg', 'xl'] as const;
export const HAIRLINES = ['none', 'rule', 'edge', 'field'] as const;
export const RADII = ['none', 'chip', 'control', 'card', 'sheet'] as const;

export type Look = {
    shadow: (typeof SHADOWS)[number];
    hairline: (typeof HAIRLINES)[number];
    radius: (typeof RADII)[number];
};

export type Layer = Look & {
    id: string;
    name: string;
    /* Its name in the stack diagram, where room is short. */
    short: string;
    use: string;
    /* The colour roles it paints with. */
    surface: string;
    ink: string;
    motion: string;
    source: string;
    differs?: string;
};

export const LAYERS: readonly Layer[] = [
    {
        id: 'desk',
        name: 'Desk',
        short: 'Desk',
        use: 'The ground behind everything: the window, the web sidebar, behind grouped lists.',
        surface: 'ground',
        ink: 'ink',
        shadow: 'none',
        hairline: 'none',
        radius: 'none',
        motion: 'None.',
        source: 'styles.css (--desk, --background)',
    },
    {
        id: 'sheet',
        name: 'Sheet',
        short: 'Sheet',
        use: 'The page: one surface panel, inset 10px from the window on a desk, full-bleed on a phone.',
        surface: 'surface',
        ink: 'ink',
        shadow: 'none',
        hairline: 'rule',
        radius: 'card',
        motion: 'None; a 2px primary hairline across its top while a page loads.',
        source: 'routes/_authenticated/app/route.tsx (SidebarInset)',
        differs:
            'DESIGN.md gives the page panel the sm shadow (shadow-sheet); the app draws the rule alone.',
    },
    {
        id: 'card',
        name: 'Card',
        short: 'Card',
        use: 'Facts and settings inside a page. Inline, so no shadow.',
        surface: 'surface',
        ink: 'ink',
        shadow: 'none',
        hairline: 'rule',
        radius: 'control',
        motion: 'None.',
        source: 'components/ui/card.tsx',
        differs:
            'DESIGN.md names card (16) for fact boxes; ui/card.tsx uses rounded-md, control (10).',
    },
    {
        id: 'panel',
        name: 'Panel',
        short: 'Panel',
        use: 'Info: the 320px details panel beside the list on a wide window.',
        surface: 'surface',
        ink: 'ink',
        shadow: 'md',
        hairline: 'rule',
        radius: 'sheet',
        motion: 'None; it sticks while the list scrolls.',
        source: 'components/drive/details-panel.tsx',
        differs:
            'DESIGN.md puts the details panel on the card radius (16); the panel uses rounded-2xl, sheet (20).',
    },
    {
        id: 'popover',
        name: 'Popover and menu',
        short: 'Menu',
        use: 'Actions and small choices over the page, anchored to what opened them.',
        surface: 'surface',
        ink: 'ink',
        shadow: 'lg',
        hairline: 'rule',
        radius: 'card',
        motion: 'Fades and zooms in from 95%, 100ms, from its side.',
        source: 'components/ui/dropdown-menu.tsx, popover.tsx, select.tsx',
    },
    {
        id: 'dialog',
        name: 'Dialog',
        short: 'Dialog',
        use: 'One decision over the scrim; the confirm repeats the verb.',
        surface: 'surface',
        ink: 'ink',
        shadow: 'xl',
        hairline: 'edge',
        radius: 'sheet',
        motion: 'Fades and scales from 98%, 150ms ease-out-soft; the scrim fades 150ms.',
        source: 'components/ui/dialog.tsx, alert-dialog.tsx',
    },
    {
        id: 'toast',
        name: 'Toast',
        short: 'Toast',
        use: 'Confirms what already happened, bottom right, with at most one way back.',
        surface: 'snackbar',
        ink: 'on-snackbar',
        shadow: 'xl',
        hairline: 'none',
        radius: 'card',
        motion: 'Rises from 150% with a fade, 400ms ease-out-expo; goes after 3.5s.',
        source: 'components/ui/toast.tsx',
        differs: 'DESIGN.md gives toasts the lg shadow; ui/toast.tsx uses shadow-xl.',
    },
];

export function lookStyle(look: Look, layer: Pick<Layer, 'surface' | 'ink'>) {
    return {
        background: `var(--${layer.surface})`,
        color: `var(--${layer.ink})`,
        boxShadow: look.shadow === 'none' ? 'none' : `var(--elevation-${look.shadow})`,
        border: look.hairline === 'none' ? '0' : `1px solid var(--${look.hairline})`,
        borderRadius: look.radius === 'none' ? 0 : `var(--radius-${look.radius})`,
    };
}
