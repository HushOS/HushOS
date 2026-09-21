---
version: alpha
name: HushOS Paper
description: Design system for HushOS, an open-source, self-hostable, end-to-end encrypted productivity suite. Your files are documents, so the drive is a desk. A warm desk, sheets of paper lying on it, ink-blue text, one blue, hairline rules. Dark tokens carry a -dark suffix.
colors:
    primary: '#2c428e'
    primary-hover: '#24387a'
    on-primary: '#fcfbf7'
    primary-dark: '#aab8f4'
    primary-hover-dark: '#bcc7f8'
    on-primary-dark: '#121833'
    ink: '#1c2848'
    ink-dark: '#dfe3f2'
    background: '#e6e2d9'
    background-dark: '#13151b'
    foreground: '#1c2848'
    foreground-dark: '#dfe3f2'
    surface: '#fcfbf7'
    surface-dark: '#1c1f28'
    surface-raised: '#fffef9'
    surface-raised-dark: '#21242e'
    muted: '#f1efe7'
    muted-dark: '#252935'
    on-muted: '#5a6483'
    on-muted-dark: '#969eb8'
    accent: '#e3e7f5'
    accent-dark: '#262c45'
    on-accent: '#2c428e'
    on-accent-dark: '#b3c0f7'
    border: '#d3d1ca'
    border-dark: '#30343f'
    input-border: '#b9bccb'
    input-border-dark: '#3a4052'
    success: '#2a7a5e'
    success-dark: '#7fd1ad'
    on-success: '#fcfbf7'
    on-success-dark: '#0d1f18'
    success-soft: '#dcede4'
    success-soft-dark: '#1a2f29'
    warning: '#9a5a12'
    warning-dark: '#e8b774'
    on-warning: '#fcfbf7'
    on-warning-dark: '#241707'
    warning-soft: '#f4e6cf'
    warning-soft-dark: '#33291a'
    error: '#a8322a'
    error-dark: '#f09a90'
    on-error: '#fcfbf7'
    on-error-dark: '#2a0f0c'
    error-soft: '#f5dfdb'
    error-soft-dark: '#3a2020'
typography:
    headline-display:
        fontFamily: Atkinson Hyperlegible Next Variable
        fontSize: 60px
        fontWeight: 700
        lineHeight: 1.05
        letterSpacing: -0.025em
    headline-lg:
        fontFamily: Atkinson Hyperlegible Next Variable
        fontSize: 24px
        fontWeight: 700
        lineHeight: 1.25
        letterSpacing: -0.025em
    headline-md:
        fontFamily: Atkinson Hyperlegible Next Variable
        fontSize: 18px
        fontWeight: 700
        lineHeight: 1.35
    body-lg:
        fontFamily: Atkinson Hyperlegible Next Variable
        fontSize: 18px
        fontWeight: 400
        lineHeight: 1.6
    body-md:
        fontFamily: Atkinson Hyperlegible Next Variable
        fontSize: 15px
        fontWeight: 400
        lineHeight: 1.6
    body-sm:
        fontFamily: Atkinson Hyperlegible Next Variable
        fontSize: 14px
        fontWeight: 400
        lineHeight: 1.6
    value-mono:
        fontFamily: Geist Mono Variable
        fontSize: 13px
        fontWeight: 400
        lineHeight: 1.5
    eyebrow:
        fontFamily: Atkinson Hyperlegible Next Variable
        fontSize: 12px
        fontWeight: 600
        lineHeight: 1
    button:
        fontFamily: Atkinson Hyperlegible Next Variable
        fontSize: 14px
        fontWeight: 600
        lineHeight: 1
rounded:
    xs: 2px
    md: 3px
    xl: 4px
    full: 9999px
spacing:
    base: 4px
    xs: 4px
    sm: 8px
    md: 16px
    lg: 24px
    xl: 32px
    2xl: 48px
    gutter: 20px
    gutter-desktop: 40px
    row-height: 48px
    control-height: 40px
    control-height-sm: 32px
    control-height-lg: 48px
    sidebar-width: 256px
    sidebar-width-icon: 48px
    container-reading: 672px
    container-auth: 672px
components:
    sheet:
        backgroundColor: '{colors.surface}'
        rounded: '{rounded.xs}'
    card:
        backgroundColor: '{colors.surface-raised}'
        rounded: '{rounded.md}'
    button-primary:
        backgroundColor: '{colors.primary}'
        textColor: '{colors.on-primary}'
        rounded: '{rounded.md}'
        height: '{spacing.control-height}'
        padding: 16px
        typography: '{typography.button}'
    button-primary-hover:
        backgroundColor: '{colors.primary-hover}'
    button-secondary:
        backgroundColor: '{colors.ink}'
        textColor: '{colors.surface}'
        rounded: '{rounded.md}'
        height: '{spacing.control-height}'
    button-outline:
        backgroundColor: '{colors.surface}'
        textColor: '{colors.foreground}'
        rounded: '{rounded.md}'
        height: '{spacing.control-height}'
        padding: 16px
    button-outline-hover:
        backgroundColor: '{colors.muted}'
    button-ghost:
        backgroundColor: transparent
        textColor: '{colors.foreground}'
        height: '{spacing.control-height}'
    button-destructive:
        backgroundColor: '{colors.error}'
        textColor: '{colors.on-error}'
        rounded: '{rounded.md}'
        height: '{spacing.control-height}'
    input:
        backgroundColor: '{colors.surface}'
        textColor: '{colors.foreground}'
        rounded: '{rounded.md}'
        height: '{spacing.control-height}'
        padding: 12px
        typography: '{typography.body-md}'
    badge:
        rounded: '{rounded.xs}'
        height: 22px
        padding: 8px
        typography: '{typography.eyebrow}'
        backgroundColor: '{colors.accent}'
        textColor: '{colors.on-accent}'
    badge-success:
        backgroundColor: '{colors.success-soft}'
        textColor: '{colors.success}'
    badge-warning:
        backgroundColor: '{colors.warning-soft}'
        textColor: '{colors.warning}'
    badge-error:
        backgroundColor: '{colors.error-soft}'
        textColor: '{colors.error}'
    row-selected:
        backgroundColor: '{colors.accent}'
    nav-item:
        textColor: '{colors.on-muted}'
        backgroundColor: '{colors.background}'
    nav-item-active:
        backgroundColor: '{colors.surface}'
        textColor: '{colors.foreground}'
    checkbox:
        size: 18px
        rounded: '{rounded.xs}'
        backgroundColor: '{colors.surface}'
    checkbox-checked:
        backgroundColor: '{colors.primary}'
        textColor: '{colors.on-primary}'
    menu:
        backgroundColor: '{colors.surface-raised}'
        rounded: '{rounded.md}'
        padding: 4px
    menu-item:
        height: 36px
        padding: 8px
        typography: '{typography.body-sm}'
    sidebar:
        backgroundColor: '{colors.background}'
        width: '{spacing.sidebar-width}'
---

# HushOS Paper

HushOS asks people to put private things in it. Before any feature, the interface has one job: make that feel like a reasonable decision. Paper is how it does that. Your files are documents, so the drive is a desk: a warm ground, a sheet of paper lying on it that holds the page, and a card lifted a little higher when something needs an answer. It is the calmest register a screen can have, and the most legible one. The tokens above are normative; the prose explains how to apply them.

It applies to `apps/web`. Tokens are implemented in `apps/web/src/styles.css` as single `light-dark()` values; the hex values above are the same values. Primitives live in `apps/web/src/components/ui` (shadcn Base UI, retuned) and the product pieces in `apps/web/src/components` (`site-header.tsx`, `auth-layout.tsx`, `app-sidebar.tsx`, `drive/file-mark.tsx`). Brand assets live in `apps/web/public/brand` and are generated from `apps/web/src/lib/brand.ts` with `bun run brand:assets`. This document is served publicly at `/design.md`.

## Overview

HushOS is an open-source, self-hostable, end-to-end encrypted productivity suite, beginning with Drive. Its first audience is ordinary people who want their files private without learning anything to get it, for personal life as much as for work; its second is the people who would rather verify than trust: developers, privacy-minded professionals, self-hosters. Copy on public pages is written for the first audience; the security page is written for the second.

The personality is calm, legible and plain-spoken. Think of a tidy desk with one document on it: a warm ground, a clean sheet, ink-blue writing, a highlighter, a few ruled lines. The metaphor is carried by shape and shadow only. There are no paper textures, no torn edges, no stamps made to look inked, no serif faces, no illustrations.

Principles:

1. **Desk, sheet, card.** The page ground is the desk. Content lies on a sheet (`sheet`: the sheet colour, a 2px radius, the sheet shadow), one sheet per page region, never a sheet per row. Anything lifted above the sheet (a dialog, a menu, a popover, the details panel, a toast) is a card: the raised colour and the overlay shadow.
2. **Ink-blue, never black.** Text is ink-blue. Links, the primary button, focus and the one accent are the same blue. Nothing else points.
3. **Few lines.** Rules are hairlines of translucent ink between rows on a sheet. Spacing separates everything else; vertical dividers appear only between two genuinely different regions.
4. **Set to be read.** One humanist sans, in sentence case, for headings, labels, buttons and copy. Mono is kept for characters read one by one.
5. **Say only what the code does.** Copy describes implemented behaviour (OPAQUE sign-in, client-side key wrapping, recovery phrase, open source). It never claims more than the code does.
6. **State is a soft fill with a word in it.** Locked, unlocked, verified, failed: an ink-strength colour on its own soft fill, and one sentence next to it.
7. **Quiet motion, quiet sound.** Short transitions, no overshoot, a small acoustic signature on presses. Both respect user preferences.

## Colors

Light mode is a warm desk with off-white paper on it; dark mode is the same desk with the lamp off: a blue-black ground, sheets a step lighter, pale ink. Neither uses gradients. In code every value is one `light-dark()` pair, so a component never names a theme.

- **Desk / background (#e6e2d9, dark #13151b):** the page ground, the sidebar, the space around a sheet.
- **Sheet / surface (#fcfbf7, dark #1c1f28):** the surface that holds a page's content; also the active nav tab, outline buttons and fields.
- **Card / surface-raised (#fffef9, dark #21242e):** dialogs, menus, popovers, toasts, the details panel. Always with the overlay shadow.
- **Ink (#1c2848, dark #dfe3f2):** all text, and the solid fill of the secondary button and the avatar.
- **Muted (#f1efe7, dark #252935):** the hover fill on a sheet and the quiet fill of a field or a file mark. **Muted text (#5a6483, dark #969eb8)** is for labels and metadata only.
- **Primary (#2c428e, dark #aab8f4; hover #24387a, dark #bcc7f8):** the one blue. The primary button, links, focus outlines, the checked checkbox, a folder's edge. Text on it is #fcfbf7 in light and #121833 in dark.
- **Accent, the highlighter (#e3e7f5, dark #262c45; text #2c428e, dark #b3c0f7):** the selected row, the open folder, a chosen option, a folder's face, the default badge.
- **Rule (ink at 13% alpha):** hairlines on a sheet. **Border (#d3d1ca, dark #30343f)** is the solid hairline for edges that sit on the desk. **Input (#b9bccb, dark #3a4052)** is the slightly stronger edge of a field or an outline button.
- **Success (#2a7a5e, dark #7fd1ad), Warning (#9a5a12, dark #e8b774), Error (#a8322a, dark #f09a90):** ink-strength, so they read as text. Each has a soft fill (success #dcede4 / #1a2f29, warning #f4e6cf / #33291a, error #f5dfdb / #3a2020) for blocks and pills, and an on-colour (#fcfbf7 in light; #0d1f18, #241707, #2a0f0c in dark) for the rare solid fill.
- **Shadows** are ink-tinted in light (ink at 12%, 45% and 55% alpha) and near-black in dark.

## Typography

Atkinson Hyperlegible Next Variable carries everything that is read; Geist Mono Variable carries what is read character by character. Both are bundled from Fontsource; the sans has a local Arial fallback stretched to 103% so the swap barely moves a line.

- **Page title** (`headline-lg`, 24px, 700, tight). **Section title** (`headline-md`, 18px, 700). **Marketing hero** (`headline-display`, 48px rising to 60px, 700, tight, balanced).
- **Body** is 14 to 18px at 1.6 line height.
- **Eyebrow** (`eyebrow`, 12px, 600, sentence case) is the small label: column heads, keys in a list, the name of a section.
- **Button** (14px, 600). Small buttons go to 13px, large to 15px.
- **Mono** (`value-mono`, 13px) only where characters are read one by one: fingerprints, recovery words, IDs, tokens, invite and offer codes, URLs shown for copying, the extension in a file mark, sizes and dates in a technical detail block, `kbd` and `code`, terminal snippets, the security page's tables. Dates and sizes in ordinary lists are the sans with tabular figures.
- **Links** (`text-link`) are blue and underlined, in the text face.

Everything is sentence case. Nothing is uppercase, and nothing is letter-spaced wide. Bold (700) is for headings, `strong` and the active nav tab; 600 for labels and buttons.

## Layout

The page is a desk with a sheet on it, not a grid of cells.

- **Public pages.** A quiet header on the desk: the mark and name, the nav, the appearance control. The content sits on a sheet or directly on the desk in a reading column. Footers are plain lines of small text.
- **Auth pages.** One sheet, centred, holding the form; beside or beneath it, "What happens when you…" in three plain sentences for that flow (sign in, create an account, recover). Explain, never reassure: no status dots, no assurance blurbs.
- **Forms.** A label above its field, a hint or error line under it, fields stacked with 16 to 20px between them. Secondary links sit beside the one primary button at the end.
- **The app shell.** A collapsible sidebar (256px, 48px in icon mode) in the desk colour with the mark, nav items, a storage meter, and the profile menu at the bottom. The content region is one sheet. The active nav item is a tab cut into the sheet's edge: it takes the sheet colour with bold ink text and square right corners, so it reads as joined to the sheet.
- **Lists.** Rows on a sheet, 48px, a rule hairline between them, no vertical dividers. Key and value lists use dotted leaders: a dotted rule under each row, key on the left in muted text, value on the right.
- **Reading pages** (legal, blog) are a single 672px column.
- Page gutters are 20px, 40px from the small breakpoint.

## Elevation & Depth

There are three levels and two shadows. The desk is flat. A sheet lies on it with `shadow-sheet` (a 1px ink edge below and a soft, tight drop: `0 1px 0` at 12% ink, `0 14px 30px -22px` at 45%). A card floats above with `shadow-overlay` (`0 1px 0`, `0 22px 44px -20px` at 55%). Rows, inline cards, buttons and fields have no shadow. Focus is a 2px outline in primary, inset by 2px. In dark mode the steps are the same and the shadows go to near-black.

## Shapes

Corners are barely turned: 2px for sheets, badges, checkboxes and file marks, 3px for buttons, fields, menus and cards, 4px at most. Fully round is for avatars and tag dots only. Icons are 16px stroke icons, paired with text.

- **A file** is a small sheet with its top-right corner turned (`clip-path: polygon(0 0, 68% 0, 100% 24%, 100% 100%, 0 100%)`), 24 by 30px in a row, in the muted fill with a hairline edge and its lowercase extension in 7.5px mono at the foot. An image keeps its thumbnail, clipped to the same shape.
- **A folder** is a tabbed folder (`clip-path: polygon(0 0, 44% 0, 54% 18%, 100% 18%, 100% 100%, 0 100%)`), 30 by 24px, in the highlighter colour with a primary hairline.
- Both come from `FileMark` in `components/drive/file-mark.tsx`, which also has a large size for the grid and the details panel. There is one implementation.

## Components

- **Button.** 3px radius, the text face at 600. `default` is the blue fill and there is one per screen. `secondary` is an ink fill. `outline` is a sheet-coloured button with the input edge; `ghost` has no edge and fills with muted on hover; `row` (with `size="row"`) is the full-width 56px row used in account settings: ink label on the left, blue arrow on the right. `destructive` is the one solid status fill, for confirming a destructive action; `destructive-outline` opens a dangerous flow; `link` is an inline text link. Sizes are 28, 32, 40 and 48px. Buttons move 1px on press and carry press and release sounds; links get the same cues through delegation. Do not pile typographic classes onto a button where it is used.
- **Input.** 40px, the sheet colour, the input edge, 3px radius, the text face; 16px text on small screens so iOS does not zoom. Mono only when the value is a code.
- **Checkbox.** 18px, 2px radius, input edge, blue fill when checked. Its toggle sound plays from `onCheckedChange`, so label clicks sound the same.
- **Selected row.** A highlighter band: the accent colour inset a little top and bottom (12% and 88%), with no side bar and no ring. It is the only gradient in the system, and it has hard stops.
- **Badge.** A 22px eyebrow pill with a 2px radius. `default` is the highlighter; `success`, `warning` and `destructive` are the status colour on its soft fill; `outline` and `secondary` are neutral.
- **Alert.** A soft status fill with the status colour for its icon and title, 3px radius, no shadow; enters with a 4px drop. Inline, for anything the user must act on.
- **Tag.** A small solid chip in the tag's own colour with text that reads on it. The five presets map to tokens and follow the theme; a custom hex colour gets ink or sheet-coloured text, whichever contrasts more.
- **Toast** (`ui/toast.tsx`, Base UI). A card at the bottom right with the overlay shadow: a status icon, a title, a description, a close button. Toasts only confirm something that already happened (a value copied, a kit downloaded), dismiss themselves after 3.5s, and stack with an 8px peek. Call `toast.add({ type, title, description })`.
- **Dialogs, menus, popovers.** Cards: raised colour, 3px radius, overlay shadow. Menu items are 36px in the text face with eyebrow group labels; the highlighted item takes the highlighter. The profile menu holds appearance, interface sounds, account links, and sign out. Right-clicking the mark opens the brand menu with an in-place "Copied" state.
- **Account rows.** Each account-settings section is a row (56px, label left, blue arrow right) that collapses into its inline form: change password, rotate recovery phrase, rotate master key, delete account. An editable value (the name) is a row that is itself the control and swaps in place for its form. Only one form is open at a time; opening another closes the rest. Every form asks for the current password, and its button reads the same as the row that opened it.
- **Sidebar.** shadcn sidebar retuned: desk colour, muted-text items that turn to ink on hover, the active item as the tab described under Layout, tooltips when collapsed, storage meter and profile trigger in the footer, state persisted in the `sidebar_state` cookie and read on the server for the first paint.
- **Ledger**, **Note** and **Cta** are the MDX components available to content authors: a key and value list with dotted leaders, a soft-filled aside, and a closing call to action.

## Do's and Don'ts

- Do put a page's content on one sheet, and lift only what interrupts.
- Do use one blue button per screen, at the end of the form.
- Do set everything in sentence case in the text face; keep mono for characters read one by one.
- Do check light and dark; both come from the same tokens, and a component never hard-codes a colour or adds a `dark:` colour override. The white ground behind a QR code and the black behind a video or PDF canvas are the only exceptions.
- Do make clickable things look clickable: muted text is for labels and metadata only. Anything interactive is set in ink or blue, fills on hover, and is either a button or underlined. On a row, the arrow is blue.
- Do show status as the status colour on its soft fill, with a word.
- Do keep security claims to what the code does, and units binary (KiB, MiB, GiB).
- Don't add a paper texture, a torn or deckled edge, a skeuomorphic stamp, a serif face, a gradient, a glow, a decorative illustration, an icon tile, a pulsing dot, an emoji or an exclamation mark.
- Don't write assurance blurbs ("bank-grade", "your data is safe with us"), and never a timeline claim on a public page.
- Don't set text in black, or a heading, label, button or paragraph in mono or uppercase.
- Don't draw a grid of lines; a rule between rows is enough.
- Don't give a row, an inline card or a button a shadow, or round anything past 4px except an avatar or a tag dot.
- Don't use a solid status fill for anything but the destructive confirm button and a tag.
- Don't set a link, nav item, or row label in muted text; if it reads like a label, nobody clicks it.
- Don't use sheet-coloured text on primary in dark mode; use the on-primary token.

## Motion

Motion has a purpose or it does not ship: feedback for a press, a state that changed, content that arrived, or a change that would otherwise be jarring. Nothing animates on page load except the one auth-sheet entrance, and nothing animates on hover except colour.

- **Tooling.** CSS first. Motion for React (`motion/react`) is used only where CSS cannot: exit animations, height to auto, and interruptible state swaps. Helpers live in `components/motion.tsx`: `TextSwap`, `IconSwap`, `Collapse`, `PendingLabel`, `Spinner`, and `MotionProvider`, which sets the default spring and `reducedMotion="user"`.
- **Springs.** State swaps use `duration: 0.3, bounce: 0`. Content that arrives may use `duration: 0.45, bounce: 0.15`. If a spring looks wrong, raise damping.
- **Curves.** Entrances and exits use `ease-out-expo`; on-screen moves use `ease-in-out-cubic`; colour and border use `ease-out-soft` at 150ms. Never `ease-in`.
- **Durations.** 150ms press and colour, 200ms enter of errors and alerts, 220ms icon swaps, 300ms text swaps, 400ms the auth entrance and the account-settings collapses (delete, password, key rotation), 500ms progress fills.
- **Navigation bar.** A 2px `primary` hairline across the top of the window while the router loads a page under `/app` (`components/navigation-bar.tsx`). It waits 150ms, so a navigation that resolves at once never shows it; then it grows toward 85% over 8s on `ease-out-expo`, never reaching the end on its own, and on arrival fills and fades in 200ms. CSS transforms only, so it stays smooth while the next page's script is parsed. Fixed and inert: it takes no room and catches no clicks. It follows route loading only; a page that fetches after it appears still owns its own loading state.
- **Text swaps** crossfade with a 10px lift and a 2px blur. **Icon swaps** scale from 0.6. **Recovery words** stagger in at 25ms. **Menus** scale from 0.95 at their trigger's transform origin over 100ms.
- `prefers-reduced-motion` collapses every CSS animation, and `MotionConfig` limits Motion to opacity and colour.

## Sound

Sound confirms that something happened. It never announces that something might: there is no sound for a hover, a press, a toggle or a tick. Cues come from Cuelume, synthesised on the device, and are all played from code through `cue()` in `lib/sounds.ts`, so every flow sounds the same.

| Moment                                         | Cue       |
| ---------------------------------------------- | --------- |
| An action succeeded: saved, copied, shared     | `success` |
| A recoverable error is shown                   | `error`   |
| Email verified, recovery confirmed             | `ready`   |
| Something was put away: locked, stopped, moved | `droplet` |

Sound is **off until the person turns it on**, in the account menu; the choice persists in `localStorage` under `hushos-sounds`. A product called Hush does not make noise at someone who has not asked for it. Global volume is 0.55; confirmations play quieter. Never add a sound to a change the person did not start, and never on page load.

## Content

Legal pages and blog posts are MDX under `apps/web/src/content`, compiled at build time and server-rendered. Documents use relative imports for components (the `@/` alias is not resolved inside MDX). Every post carries `title`, `description`, `date`, `author` in front matter and ships Article structured data; legal pages carry `title`, `updated`, `summary`. The public site also serves `/robots.txt`, `/sitemap.xml`, `/llms.txt`, and `/design.md`.

## Email

Transactional emails (`packages/emails`) are Paper in table form: a desk-coloured body, one sheet-coloured container with a hairline border and a 3px radius, the mark on a small blue square beside the name, ink-blue text, the facts about the link as a key and value list with dotted leaders (purpose, expiry, uses, "password sent: never"), and one blue button with a 3px radius. Mono appears only on the link printed for copying. Dark mode swaps to the dark desk and sheet via `prefers-color-scheme` and Outlook's `[data-ogsc]`. Type falls back to Arial because mail clients do not load web fonts. Templates are rendered once at build time (`bun run email:render`) and filled at send time; preview with `bun run email:preview` on port 3001.

## Accessibility

- Atkinson Hyperlegible Next is chosen for its distinct letterforms; body text never drops below 14px, and text pairs meet WCAG AA on their grounds in both themes.
- Every interactive element has a visible focus outline.
- Status changes use `aria-live="polite"` on the element that reflects them; status is never colour alone.
- Icons are `aria-hidden` and paired with text; icon-only controls carry `aria-label`.
- Forms use `noValidate`, validate on submit, re-validate on change, and render errors inline with `role="alert"`.
- Inputs are 16px on small screens; the viewport is never locked, so pinch zoom stays available.
- Hit targets are at least 40px, 48px for list rows and 56px for account rows.
