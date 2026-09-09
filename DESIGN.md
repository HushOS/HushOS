---
version: alpha
name: HushOS Ledger
description: Design system for HushOS, an open-source, self-hostable, end-to-end encrypted productivity suite. Blocky, mono-labelled, honest. Light is paper and ink; dark is a black terminal. Dark tokens carry a -dark suffix.
colors:
    primary: '#3b6acc'
    primary-hover: '#2d5bbb'
    on-primary: '#ffffff'
    primary-dark: '#8fb4ff'
    primary-hover-dark: '#a4c3ff'
    on-primary-dark: '#000000'
    ink: '#1f1f1d'
    ink-dark: '#e6e8ee'
    background: '#f4f3ee'
    background-dark: '#000000'
    foreground: '#1f1f1d'
    foreground-dark: '#e6e8ee'
    surface: '#fbfaf6'
    surface-dark: '#0f1014'
    surface-raised: '#ffffff'
    surface-raised-dark: '#16181d'
    muted: '#ebe9e1'
    muted-dark: '#1a1c21'
    on-muted: '#6b6a63'
    on-muted-dark: '#9a9ea8'
    accent: '#e3e9f7'
    accent-dark: '#1c2335'
    on-accent: '#1e3466'
    on-accent-dark: '#e6e8ee'
    border: '#1f1f1d'
    border-dark: '#3a3d45'
    success: '#2a9d8f'
    success-dark: '#6fd3c3'
    warning: '#e9c46a'
    warning-dark: '#f0cf6e'
    error: '#e76f51'
    error-dark: '#f28a6f'
typography:
    headline-display:
        fontFamily: Geist Mono Variable
        fontSize: 72px
        fontWeight: 500
        lineHeight: 1.02
        letterSpacing: -0.02em
    headline-lg:
        fontFamily: Geist Variable
        fontSize: 30px
        fontWeight: 500
        lineHeight: 1.2
        letterSpacing: -0.02em
    headline-md:
        fontFamily: Geist Variable
        fontSize: 24px
        fontWeight: 500
        lineHeight: 1.25
        letterSpacing: -0.02em
    headline-sm:
        fontFamily: Geist Variable
        fontSize: 18px
        fontWeight: 500
        lineHeight: 1.35
        letterSpacing: -0.01em
    body-lg:
        fontFamily: Geist Variable
        fontSize: 18px
        fontWeight: 400
        lineHeight: 1.6
    body-md:
        fontFamily: Geist Variable
        fontSize: 15px
        fontWeight: 400
        lineHeight: 1.6
    body-sm:
        fontFamily: Geist Variable
        fontSize: 14px
        fontWeight: 400
        lineHeight: 1.6
    value-mono:
        fontFamily: Geist Mono Variable
        fontSize: 13px
        fontWeight: 400
        lineHeight: 1.5
    eyebrow:
        fontFamily: Geist Mono Variable
        fontSize: 11px
        fontWeight: 500
        lineHeight: 1
        letterSpacing: 0.12em
    button:
        fontFamily: Geist Mono Variable
        fontSize: 12px
        fontWeight: 500
        lineHeight: 1
        letterSpacing: 0.1em
rounded:
    none: 0px
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
    cell-padding: 16px
    cell-padding-lg: 20px
    bar-height: 44px
    row-height: 48px
    control-height: 40px
    control-height-lg: 48px
    action-height: 56px
    sidebar-width: 256px
    sidebar-width-icon: 48px
    container-reading: 672px
    container-auth: 672px
components:
    bar:
        height: '{spacing.bar-height}'
        backgroundColor: '{colors.background}'
    bar-cell:
        padding: '{spacing.cell-padding}'
        typography: '{typography.eyebrow}'
        textColor: '{colors.on-muted}'
    bar-cell-active:
        backgroundColor: '{colors.muted}'
        textColor: '{colors.foreground}'
    brand-cell:
        backgroundColor: '{colors.primary}'
        textColor: '{colors.on-primary}'
        padding: '{spacing.cell-padding}'
    button-primary:
        backgroundColor: '{colors.primary}'
        textColor: '{colors.on-primary}'
        rounded: '{rounded.none}'
        height: '{spacing.control-height}'
        padding: 16px
        typography: '{typography.button}'
    button-primary-hover:
        backgroundColor: '{colors.primary-hover}'
    button-outline:
        backgroundColor: '{colors.surface}'
        textColor: '{colors.foreground}'
        rounded: '{rounded.none}'
        height: '{spacing.control-height}'
        padding: 16px
    button-outline-hover:
        backgroundColor: '{colors.muted}'
    button-ghost:
        backgroundColor: transparent
        textColor: '{colors.on-muted}'
        height: '{spacing.control-height}'
    button-destructive:
        backgroundColor: '{colors.error}'
        textColor: '{colors.ink}'
        height: '{spacing.control-height}'
    form-table:
        backgroundColor: '{colors.surface}'
        rounded: '{rounded.none}'
    form-row-label:
        width: 152px
        typography: '{typography.eyebrow}'
        textColor: '{colors.on-muted}'
        padding: 16px
    input:
        backgroundColor: '{colors.surface}'
        textColor: '{colors.foreground}'
        rounded: '{rounded.none}'
        height: '{spacing.row-height}'
        padding: 16px
        typography: '{typography.value-mono}'
    form-action:
        backgroundColor: '{colors.primary}'
        textColor: '{colors.on-primary}'
        height: '{spacing.action-height}'
        width: 224px
    badge:
        rounded: '{rounded.none}'
        height: 24px
        padding: 8px
        typography: '{typography.eyebrow}'
    badge-success:
        backgroundColor: '{colors.success}'
        textColor: '{colors.ink}'
    badge-warning:
        backgroundColor: '{colors.warning}'
        textColor: '{colors.ink}'
    stamp:
        rounded: '{rounded.none}'
        padding: 8px
        typography: '{typography.eyebrow}'
    checkbox:
        size: 18px
        rounded: '{rounded.none}'
        backgroundColor: '{colors.surface}'
    checkbox-checked:
        backgroundColor: '{colors.primary}'
        textColor: '{colors.on-primary}'
    menu:
        backgroundColor: '{colors.surface-raised}'
        rounded: '{rounded.none}'
        padding: 4px
    menu-item:
        height: 36px
        padding: 8px
        typography: '{typography.value-mono}'
    sidebar:
        backgroundColor: '{colors.surface}'
        width: '{spacing.sidebar-width}'
---

# HushOS Ledger

HushOS asks people to put private things in it. Before any feature, the interface has one job: make that feel like a reasonable decision. The Ledger is how it does that. Every screen is a set of drawn cells with a label and a value, like a receipt or a spec sheet, because a ledger is the most honest register a screen can have. The tokens above are normative; the prose explains how to apply them.

It applies to `apps/web`. Tokens are implemented in `apps/web/src/styles.css` as OKLCH `light-dark()` values; the hex values above are their sRGB equivalents. Primitives live in `apps/web/src/components/ui` (shadcn Base UI, retuned) and the ledger-specific pieces in `apps/web/src/components` (`form-rows.tsx`, `site-header.tsx`, `auth-layout.tsx`, `app-sidebar.tsx`). Brand assets live in `apps/web/public/brand` and are generated from `apps/web/src/lib/brand.ts` with `bun run brand:assets`. This document is served publicly at `/design.md`.

## Overview

HushOS is an open-source, self-hostable, end-to-end encrypted productivity suite, beginning with Drive. Its audience is people and small teams who would rather verify than trust: developers, privacy-minded professionals, self-hosters.

The personality is blocky, precise, and a little playful. Think of a well-kept paper ledger or a terminal: hard rules, monospaced labels in caps, values that line up, and one colour strip for warmth. Nothing is rounded, nothing floats, nothing glows. Fun comes from the colour blocks, the stamps, and the sounds, never from decoration that carries no information.

Principles:

1. **Everything is a cell.** Content sits in bordered cells that share their rules. Headers are bars of cells. Forms are tables of rows. Navigation is a column of cells. If a thing is on screen it has an edge.
2. **Labels are mono caps, values are set to read.** Keys, headings, buttons, nav items and stamps are uppercase Geist Mono with wide tracking. Values in a table are mono. Paragraphs are Geist Sans, because mono tires on long copy.
3. **One blue points, three colours stamp.** Blue is the only action colour. Teal, yellow and coral appear as solid stamps and status blocks, never as text on the page background.
4. **Say only what the code does.** Copy describes implemented behaviour (OPAQUE sign-in, client-side key wrapping, recovery phrase, open source). It never claims more than the code does.
5. **State is a labelled block.** Locked, unlocked, verified, done, planned: each is a stamp with a word in it and one sentence next to it.
6. **Quiet motion, quiet sound.** Short transitions, no overshoot, a small acoustic signature on presses. Both respect user preferences.

## Colors

Light mode is paper and ink: a warm off-white ground, near-black ink for text and every rule. Dark mode is a black terminal: pure black ground, graphite rules, off-white text. Neither uses gradients. In code every value is OKLCH in a single `light-dark()`.

- **Ink (#1f1f1d, dark #e6e8ee):** text, rules, and the solid fill for the secondary button and avatar. In light mode the border _is_ the ink; in dark mode rules step down to graphite (#3a3d45) so cells read without shouting.
- **Background (#f4f3ee, dark #000000):** the page. Warm paper in light; full black in dark.
- **Surface (#fbfaf6, dark #0f1014):** form tables, cards, the sidebar. Slightly lifted from the ground.
- **Surface-raised (#ffffff, dark #16181d):** menus and popovers, which also carry a hard 4px offset shadow in the border colour.
- **Muted (#ebe9e1, dark #1a1c21):** hover fills, active nav cells, footers of cards.
- **Primary (#3b6acc, dark #8fb4ff):** the action block, the brand cell, focus outlines, the checked checkbox. Text on it is white in light and black in dark.
- **Success (#2a9d8f teal), Warning (#e9c46a yellow), Error (#e76f51 coral):** the strip colours. Used as solid blocks with ink text (badges, stamps, alert fills at 15 to 35% alpha), and at full strength for the coloured square in a status line.
- **The colour strip** (blue, ink, yellow, teal, coral) is the one ornament. It sits at the right end of the marketing header and nowhere else.

## Typography

Geist Mono Variable carries the chrome; Geist Variable carries the reading. Both are bundled from Fontsource with a metric-matched Arial fallback.

- **Eyebrow** (`eyebrow`, 11px mono, 500, 0.12em tracking, uppercase) is the workhorse: cell headings, keys, nav items, badges, stamps, footer text.
- **Button** (12px mono, 500, 0.1em tracking, uppercase). Large buttons go to 13px.
- **Value** (`value-mono`, 13px mono) for anything in a table cell: emails, IDs, recovery words, status rows, menu items.
- **Display** (`headline-display`, 72px mono, 500, tight) is reserved for the marketing headline and the auth aside. Page titles inside the app are Geist Sans (`headline-lg`).
- **Body** is Geist Sans at 14 to 18px with 1.6 line height. Body paragraphs are never uppercase and never mono.

Weight tops out at 600 (the wordmark). Bold is never used.

## Layout

The page is a grid of rules, not a stack of boxes.

- **The bar.** Every public page opens with a 44px header bar: the blue brand cell, nav cells separated by vertical rules, empty space, the colour strip, the appearance cell. Footers are a bar of eyebrow cells. Cells are 16px padded and full-height.
- **Split pages.** Marketing and auth pages divide into a 4/8 or 5/7 column grid with a vertical rule. The left column is a ledger of facts, then "What happens when you…" in three plain sentences for that flow (sign in, create an account, recover), with a large mono headline pinned to the bottom; the right column holds the form or the copy. Explain, never reassure: no status dots, no assurance blurbs.
- **Form tables.** A form is one bordered table on the surface colour. Each field is a row: a 152px label cell on the left, the control on the right, a hint or error line under the value. The last row holds secondary links on the left and the 56px blue action block on the right. Nothing floats outside the table.
- **The app shell.** A collapsible shadcn sidebar (256px, 48px in icon mode) with the brand cell, nav cells, a storage meter, and the profile menu at the bottom. The inset has a 44px bar with the sidebar trigger, a section eyebrow, and a device-status cell. Content is full-bleed: page headers and sections separated by horizontal rules, never floating cards with margins.
- **Reading pages** (legal, blog) are a single 672px column.
- Page gutters are 20px, 40px from the small breakpoint inside split sections.

## Elevation & Depth

There are no soft shadows. Depth is a rule. Surfaces step from background to surface to raised surface, and floating elements (menus, popovers) carry a hard 4px offset shadow in the border colour. Focus is a 2px outline in primary, inset by 2px on cells and offset by 2px on checkboxes. In dark mode the raised surface is lighter than the surface and the rules are graphite; nothing else changes.

## Shapes

Every corner is square. The single radius token is `none`. Blocks are rectangles that share edges: a table's rows share one rule, a grid's cells share one rule, adjacent buttons share one rule. Icons are 16px stroke icons at 14px inside eyebrows. The logo sits in a blue rectangle, never a circle.

## Components

- **Button.** Square, mono caps. `primary` is the blue block and there is one per screen. `secondary` is an ink block. `outline` is a bordered surface cell, `ghost` a borderless cell that fills on hover; `row` (with `size="row"`) is the full-width 56px cell used in the app: ink label on the left, blue arrow on the right. `destructive` is a coral block with ink text; `destructive-outline` opens a dangerous flow. Large buttons are 48px, action blocks in a form table are 56px. Buttons move 1px on press and carry press and release sounds; links get the same cues through delegation.
- **Form table, row, actions** (`form-rows.tsx`). The only way to lay out a form. `AuthInput` renders a row with an optional hint or error line; `ConsentField` renders the agreement row; `FormNote` renders a message row; `FormActions` renders the last row.
- **Input.** 48px inside a row, borderless within the table, mono text, 16px on small screens so iOS does not zoom. A password row has a 64px SHOW/HIDE cell on the right.
- **Checkbox.** 18px square, ink border, blue fill when checked, check icon at 3px stroke. Its toggle sound plays from `onCheckedChange`, so label clicks sound the same.
- **Badge.** 24px eyebrow block. `success` teal, `warning` yellow, `destructive` coral, all with ink text; `outline` for neutral.
- **Stamp.** An eyebrow in a bordered cell under a form: the claims the code actually keeps. `warning` tone is the yellow block.
- **Alert.** A bordered row with an icon; tinted fill at low alpha; enters with a 4px drop. Inline, for anything the user must act on.
- **Toast** (`ui/toast.tsx`, Base UI). The one floating element: a raised cell bottom right with the hard shadow, a 20px stamp in the strip colour (teal check, coral cross), an eyebrow title, a mono description, and a 40px close cell. Toasts only confirm something that already happened (a value copied, a kit downloaded), dismiss themselves after 3.5s, and stack with an 8px peek. Call `toast.add({ type, title, description })`.
- **Menus.** Raised surface, square, hard offset shadow, 36px mono items, eyebrow group labels. The profile menu holds appearance, interface sounds, account links, and sign out. Right-clicking the brand cell opens the brand menu with an in-place "Copied" state.
- **Account rows.** Each account-settings section is a ghost row (56px, label left, arrow right) that collapses into its inline form table: change password, rotate recovery phrase, rotate master key, delete account. An editable value (the name) is a ledger row that is itself the control: value on the left, a blue pencil at the far right, and it swaps in place for its form. Only one form is open at a time; opening another closes the rest. Every form asks for the current password, and its action block reads the same as the row that opened it.
- **Sidebar.** shadcn sidebar retuned: square, mono items, tooltips when collapsed, storage meter and profile trigger in the footer, state persisted in the `sidebar_state` cookie and read on the server for the first paint.
- **Ledger** and **Note** are the two MDX components available to content authors.

## Do's and Don'ts

- Do give every element an edge; if it has no rule, it does not belong.
- Do use one blue block per screen and keep it in the last row of the form table.
- Do set labels in eyebrow mono caps and paragraphs in sans.
- Do check light and dark; in dark mode the ground is pure black and there is no gradient anywhere.
- Do make clickable things look clickable: muted grey is for labels and metadata only. Anything interactive is set in ink or blue, fills on hover, and either sits in its own cell or is underlined. On a row, the arrow is blue.
- Do keep security claims to what the code does.
- Don't round a corner, add a soft shadow, a gradient, a glow, a grid texture, a pulsing dot, or an emoji.
- Don't label forms with numbers; use stamps that stay true ("Step 1 of 2", "Existing account").
- Don't set body copy in mono or uppercase.
- Don't put strip colours on text; they are fills with ink text.
- Don't set a link, nav cell, or row label in muted grey; if it reads like a label, nobody clicks it.
- Don't use white text on primary in dark mode; use the on-primary token.

## Motion

Motion has a purpose or it does not ship: feedback for a press, a state that changed, content that arrived, or a change that would otherwise be jarring. Nothing animates on page load except the one auth-card entrance, and nothing animates on hover except colour.

- **Tooling.** CSS first. Motion for React (`motion/react`) is used only where CSS cannot: exit animations, height to auto, and interruptible state swaps. Helpers live in `components/motion.tsx`: `TextSwap`, `IconSwap`, `Collapse`, `PendingLabel`, `Spinner`, and `MotionProvider`, which sets the default spring and `reducedMotion="user"`.
- **Springs.** State swaps use `duration: 0.3, bounce: 0`. Content that arrives may use `duration: 0.45, bounce: 0.15`. If a spring looks wrong, raise damping.
- **Curves.** Entrances and exits use `ease-out-expo`; on-screen moves use `ease-in-out-cubic`; colour and border use `ease-out-soft` at 150ms. Never `ease-in`.
- **Durations.** 150ms press and colour, 200ms enter of errors and alerts, 220ms icon swaps, 300ms text swaps, 400ms the auth entrance and the account-settings collapses (delete, password, key rotation), 500ms progress fills.
- **Text swaps** crossfade with a 10px lift and a 2px blur. **Icon swaps** scale from 0.6. **Recovery words** stagger in at 25ms. **Menus** scale from 0.95 at their trigger's transform origin over 100ms.
- `prefers-reduced-motion` collapses every CSS animation, and `MotionConfig` limits Motion to opacity and colour.

## Sound

Interface sounds come from Cuelume, synthesised on the device. They are wired once in `lib/sounds.ts`.

| Moment                               | Cue                 | How                                        |
| ------------------------------------ | ------------------- | ------------------------------------------ |
| Any button or link press and release | `press` / `release` | `Button` attributes; anchors by delegation |
| Primary submit                       | `pulse`             | `data-cuelume-press="pulse"`               |
| Nav and menu links on hover          | `tick`              | `data-cuelume-hover="tick"`                |
| Theme and reveal toggles             | `toggle`            | `data-cuelume-toggle`                      |
| Checkbox                             | `toggle`            | `cue('toggle')` in `onCheckedChange`       |
| Action succeeded                     | `success`           | `cue('success')`                           |
| Recoverable error shown              | `error`             | `cue('error')`                             |
| Email verified, recovery confirmed   | `ready`             | `cue('ready')`                             |
| Device locked                        | `droplet`           | `cue('droplet')`                           |

Global volume is 0.55; confirmations after a click play quieter. Sounds are on by default, can be turned off in the profile menu, and persist in `localStorage` under `hushos-sounds`. Never add a sound to a change the user did not initiate, and never on page load.

## Content

Legal pages and blog posts are MDX under `apps/web/src/content`, compiled at build time and server-rendered. Documents use relative imports for components (the `@/` alias is not resolved inside MDX). Every post carries `title`, `description`, `date`, `author` in front matter and ships Article structured data; legal pages carry `title`, `updated`, `summary`. The public site also serves `/robots.txt`, `/sitemap.xml`, `/llms.txt`, and `/design.md`.

## Email

Transactional emails (`packages/emails`) are the Ledger in table form: paper ground, an ink-bordered card, the blue brand cell with the white mark and HUSHOS in mono caps, a two-column ledger of facts about the link (purpose, expiry, uses, "password sent: never"), and one full-width blue action block. Dark mode is the black terminal via `prefers-color-scheme` and Outlook's `[data-ogsc]`. Fonts fall back to the system mono and sans because mail clients do not load web fonts. Preview with `bun run email:preview` on port 3001.

## Accessibility

- Every interactive element has a visible focus outline.
- Status changes use `aria-live="polite"` on the element that reflects them.
- Icons are `aria-hidden` and paired with text; icon-only controls carry `aria-label`.
- Forms use `noValidate`, validate on submit, re-validate on change, and render errors inline with `role="alert"`.
- Inputs are 16px on small screens; the viewport is never locked, so pinch zoom stays available.
- Hit targets are at least 40px, 48px for rows and 56px for action blocks.
