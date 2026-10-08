/*
 * Alpine, the HushOS design tokens. This file is the only place a colour, size or
 * typeface is decided; `bun run tokens` writes it out for the web (CSS custom
 * properties), iOS (SwiftUI) and Android (Compose). Names describe the role, not
 * the hue, so a client never asks for "green" and the palette can move under it.
 */

/*
 * Four schemes: light and dark, each with a high-contrast twin that meets WCAG AAA
 * (7:1 for every text role, 4.5:1 for borders, focus and meaningful marks). High
 * contrast follows `prefers-contrast: more`, iOS Increase Contrast and Android's
 * contrast setting.
 */
export { contrast, luminance } from './contrast';

export type Scheme = 'light' | 'dark' | 'lightHigh' | 'darkHigh';

export interface Role {
    light: string;
    dark: string;
    lightHigh: string;
    darkHigh: string;
    /** One line for the generated files and the design board. */
    use: string;
}

export const color = {
    surface: {
        light: '#FFFFFF',
        dark: '#161A26',
        lightHigh: '#FFFFFF',
        darkHigh: '#0A0D16',
        use: 'Sheets, cards, list groups, inputs.',
    },
    ground: {
        light: '#F3F4F8',
        dark: '#0E111A',
        lightHigh: '#F2F4F9',
        darkHigh: '#000000',
        use: 'Screen background behind surfaces.',
    },
    ink: {
        light: '#17203A',
        dark: '#E4E8F4',
        lightHigh: '#070B18',
        darkHigh: '#FFFFFF',
        use: 'Text and icons.',
    },
    inkMuted: {
        light: '#5A6380',
        dark: '#9AA3BE',
        lightHigh: '#2E3650',
        darkHigh: '#D3D9EA',
        use: 'Metadata and labels. Never for anything clickable.',
    },
    rule: {
        light: '#E2E5EE',
        dark: '#262B3A',
        lightHigh: '#5F6886',
        darkHigh: '#8D95AF',
        use: 'Hairlines and dividers.',
    },
    field: {
        light: '#7A8299',
        dark: '#6A7390',
        lightHigh: '#1B2238',
        darkHigh: '#D3D9EA',
        use: 'Input and outline-button borders; 3:1 against the surface so edges stay visible.',
    },
    primary: {
        light: '#2C428E',
        dark: '#AAB8F4',
        lightHigh: '#1A2C6B',
        darkHigh: '#C9D3FF',
        use: 'Hush blue, the one brand colour: primary buttons, links, active navigation, tint.',
    },
    primaryPressed: {
        light: '#24387A',
        dark: '#BCC7F8',
        lightHigh: '#0F1E52',
        darkHigh: '#E0E6FF',
        use: 'Primary while pressed.',
    },
    onPrimary: {
        light: '#FFFFFF',
        dark: '#121833',
        lightHigh: '#FFFFFF',
        darkHigh: '#05081A',
        use: 'Text and icons on primary.',
    },
    tint: {
        light: '#DCE3F7',
        dark: '#232A44',
        lightHigh: '#DCE2F5',
        darkHigh: '#1F2849',
        use: 'Selection, hover, active navigation background, soft chips. Never the only sign of a state: selected rows add a check; navigation and segmented controls use a solid fill or a bold label.',
    },
    onTint: {
        light: '#2C428E',
        dark: '#C0CBF8',
        lightHigh: '#122057',
        darkHigh: '#E6EBFF',
        use: 'Text on tint.',
    },
    folderBack: {
        light: '#8B9BD3',
        dark: '#3D4C80',
        lightHigh: '#3E52A0',
        darkHigh: '#7D8FD6',
        use: 'Folder glyph, back sheet.',
    },
    folderFront: {
        light: '#B9C4EA',
        dark: '#52629A',
        lightHigh: '#5A6DB8',
        darkHigh: '#AEBBEE',
        use: 'Folder glyph, front sheet.',
    },
    warning: {
        light: '#87530D',
        dark: '#E3B46A',
        lightHigh: '#5E3700',
        darkHigh: '#FFD38F',
        use: 'Cautions: a fair password, a yellow tag. Never links, which are marked in primary.',
    },
    warningSoft: {
        light: '#F7EDDC',
        dark: '#33281A',
        lightHigh: '#F7EDDC',
        darkHigh: '#2B1F0B',
        use: 'Behind a caution.',
    },
    success: {
        light: '#24704F',
        dark: '#7FD1AD',
        lightHigh: '#0C4A30',
        darkHigh: '#A3EBC8',
        use: 'Finished transfers and confirmations.',
    },
    successSoft: {
        light: '#DDEFE5',
        dark: '#16302A',
        lightHigh: '#DDEFE5',
        darkHigh: '#0E2A20',
        use: 'Behind success notices.',
    },
    danger: {
        light: '#B3261E',
        dark: '#F2A69F',
        lightHigh: '#7E120C',
        darkHigh: '#FFB8B0',
        use: 'Destructive actions and errors.',
    },
    dangerSoft: {
        light: '#F8E3E1',
        dark: '#3A1F1D',
        lightHigh: '#F8E3E1',
        darkHigh: '#3D1512',
        use: 'Behind destructive notices.',
    },
    snackbar: {
        light: '#1E2638',
        dark: '#E4E8F4',
        lightHigh: '#070B18',
        darkHigh: '#FFFFFF',
        use: 'Snackbar and toast container.',
    },
    onSnackbar: {
        light: '#F1F3F9',
        dark: '#17203A',
        lightHigh: '#FFFFFF',
        darkHigh: '#05081A',
        use: 'Text on snackbars.',
    },
    snackbarAction: {
        light: '#AAB8F4',
        dark: '#2C428E',
        lightHigh: '#C9D3FF',
        darkHigh: '#1A2C6B',
        use: 'Action on snackbars.',
    },
    edge: {
        light: '#17203A14',
        dark: '#FFFFFF14',
        lightHigh: '#1B2238',
        darkHigh: '#D3D9EA',
        use: 'Outline on raised surfaces: faint normally, a solid border in high contrast where shadows carry no meaning.',
    },
    avatar1: {
        light: '#DCE3F7',
        dark: '#2A3358',
        lightHigh: '#DCE2F5',
        darkHigh: '#1F2849',
        use: 'Avatar tint 1, so people are told apart without a second accent.',
    },
    onAvatar1: {
        light: '#2C428E',
        dark: '#C9D3FF',
        lightHigh: '#122057',
        darkHigh: '#E6EBFF',
        use: 'Initials on avatar tint 1.',
    },
    avatar2: {
        light: '#EADFF3',
        dark: '#3A2C4A',
        lightHigh: '#E8DCF3',
        darkHigh: '#2E2040',
        use: 'Avatar tint 2, so people are told apart without a second accent.',
    },
    onAvatar2: {
        light: '#563F6E',
        dark: '#E2CFF4',
        lightHigh: '#3B2453',
        darkHigh: '#F1E5FF',
        use: 'Initials on avatar tint 2.',
    },
    avatar3: {
        light: '#F5E6CC',
        dark: '#3D2F17',
        lightHigh: '#F5E3C4',
        darkHigh: '#33240A',
        use: 'Avatar tint 3, so people are told apart without a second accent.',
    },
    onAvatar3: {
        light: '#6E460C',
        dark: '#F3D6A6',
        lightHigh: '#4E2F00',
        darkHigh: '#FFE2B0',
        use: 'Initials on avatar tint 3.',
    },
    avatar4: {
        light: '#D9EDE3',
        dark: '#183A2D',
        lightHigh: '#D3EADF',
        darkHigh: '#0E2A20',
        use: 'Avatar tint 4, so people are told apart without a second accent.',
    },
    onAvatar4: {
        light: '#1F6446',
        dark: '#A8E6C8',
        lightHigh: '#0C4A30',
        darkHigh: '#BFF3DA',
        use: 'Initials on avatar tint 4.',
    },
    scrim: {
        light: '#17203A59',
        dark: '#00000099',
        lightHigh: '#070B1880',
        darkHigh: '#000000CC',
        use: 'Behind sheets and dialogs.',
    },
} as const satisfies Record<string, Role>;

export type ColorRole = keyof typeof color;

/** Avatar tones as role pairs: background and the initials drawn on it. */
export const avatar = [
    { background: 'avatar1', ink: 'onAvatar1' },
    { background: 'avatar2', ink: 'onAvatar2' },
    { background: 'avatar3', ink: 'onAvatar3' },
    { background: 'avatar4', ink: 'onAvatar4' },
] as const satisfies readonly { background: keyof typeof color; ink: keyof typeof color }[];

export const font = {
    /** Brand face: web everywhere, native for large titles and onboarding headlines only. */
    brand: 'Geist',
    /** Recovery words and codes. */
    mono: 'Geist Mono',
} as const;

/** Sizes in px (web), pt (iOS) and sp (Android) share the same numbers. */
export const type = {
    display: { size: 72, weight: 800, tracking: -0.035, leading: 1.02 },
    titleLarge: { size: 34, weight: 800, tracking: -0.03, leading: 1.1 },
    title: { size: 22, weight: 700, tracking: -0.015, leading: 1.25 },
    headline: { size: 17, weight: 600, tracking: 0, leading: 1.3 },
    body: { size: 16, weight: 400, tracking: 0, leading: 1.55 },
    callout: { size: 15, weight: 400, tracking: 0, leading: 1.45 },
    footnote: { size: 13, weight: 400, tracking: 0, leading: 1.35 },
    label: { size: 12, weight: 600, tracking: 0.06, leading: 1 },
} as const;

/*
 * Elevation, tinted with ink so shadows read as the same scene as the blue. Dark mode
 * leans on deeper black and a faint top highlight, because a navy shadow vanishes there.
 * Native clients use their platform's elevation; these are for the web and the board.
 */
export const shadow = {
    sm: {
        light: '0 1px 2px rgb(23 32 58 / 0.06), 0 1px 1px rgb(23 32 58 / 0.04)',
        dark: '0 1px 2px rgb(0 0 0 / 0.5)',
        lightHigh: 'none',
        darkHigh: 'none',
        use: 'Resting controls and cards.',
    },
    md: {
        light: '0 6px 16px -4px rgb(23 32 58 / 0.12), 0 2px 4px rgb(23 32 58 / 0.05)',
        dark: '0 8px 20px -6px rgb(0 0 0 / 0.6), inset 0 1px 0 rgb(255 255 255 / 0.04)',
        lightHigh: 'none',
        darkHigh: 'none',
        use: 'Raised cards, glass bars, floating buttons.',
    },
    lg: {
        light: '0 18px 44px -14px rgb(23 32 58 / 0.24), 0 4px 10px rgb(23 32 58 / 0.06)',
        dark: '0 20px 48px -12px rgb(0 0 0 / 0.7), inset 0 1px 0 rgb(255 255 255 / 0.05)',
        lightHigh: 'none',
        darkHigh: 'none',
        use: 'Menus, popovers, selection bars, toasts.',
    },
    xl: {
        light: '0 30px 72px -18px rgb(23 32 58 / 0.34), 0 8px 20px rgb(23 32 58 / 0.08)',
        dark: '0 32px 80px -16px rgb(0 0 0 / 0.8), inset 0 1px 0 rgb(255 255 255 / 0.06)',
        lightHigh: 'none',
        darkHigh: 'none',
        use: 'Dialogs and sheets.',
    },
} as const satisfies Record<string, Role>;

/** Named by role so they never collide with a platform's own scale. */
export const radius = { chip: 6, control: 10, card: 16, sheet: 20, full: 9999 } as const;

export const space = { 1: 4, 2: 8, 3: 12, 4: 16, 6: 24, 8: 32, 12: 48, 20: 80 } as const;

/** Minimum touch target and list row height. */
export const size = { control: 44, row: 56, rowLarge: 64 } as const;
