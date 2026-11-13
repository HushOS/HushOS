/*
 * The public roadmap (/roadmap), and the one place it is written: what has
 * shipped, what is being built, and what is planned. A pull request that
 * reaches hushos.com (merged and switched on), starts, drops or changes
 * something here updates this file and `updated` in the same pull request
 * (AGENTS.md).
 *
 * Every Shipped item says the month it reached hushos.com, and only what the
 * code does; Now, Next and Later never carry a date, because work ships when
 * it is ready. roadmap.test.ts holds the file to that.
 */

import type { LinkProps } from '@tanstack/react-router';

export type RoadmapArea = 'Drive' | 'Families' | 'Apps' | 'Messages' | 'Teams' | 'Platform';
export type RoadmapStatus = 'shipped' | 'now' | 'next' | 'later';

/*
 * Where an item points: a blog post (by slug), a page on this site, a document
 * in the repository's docs/ folder, a release (by tag) on GitHub, or a phone app's store listing
 * (the URL this server is configured with; left out where it has none, as a self-hosted copy may).
 */
export type RoadmapLink =
    | { kind: 'blog'; slug: string; label: string }
    /* Typed by the router: a page that doesn't exist fails the typecheck. */
    | { kind: 'page'; to: NonNullable<LinkProps['to']>; label: string }
    | { kind: 'docs'; path: string; label: string }
    | { kind: 'release'; tag: string; label: string }
    | { kind: 'store'; platform: 'ios' | 'android'; label: string };

type Base = {
    /* The item's anchor on the page (/roadmap#<id>): lowercase words and hyphens, never reused. */
    id: string;
    title: string;
    /* One or two plain sentences. */
    body: string;
    area: RoadmapArea;
    links?: RoadmapLink[];
};
export type ShippedItem = Base & { status: 'shipped'; month: string };
export type PlannedItem = Base & { status: 'now' | 'next' | 'later' };
export type RoadmapItem = ShippedItem | PlannedItem;

export type RoadmapSection = {
    status: RoadmapStatus;
    title: string;
    /* One line under the section's heading. */
    summary: string;
    items: RoadmapItem[];
};

/* The day this file last changed what the page says (YYYY-MM-DD). */
export const updated = '2026-11-14';

export const sections: RoadmapSection[] = [
    {
        status: 'shipped',
        title: 'Shipped',
        summary: 'Live at hushos.com, and in a self-hosted copy that runs the latest code.',
        items: [
            {
                id: 'two-step-sign-in',
                status: 'shipped',
                month: 'November 2026',
                area: 'Platform',
                title: 'Two-step sign-in',
                body: 'After your password, a passkey or security key, a code from an authenticator app, one of ten backup codes, or your recovery phrase. You choose which is asked for first. It’s asked for at sign-in and before you change your password, your keys or the step, or delete your account. Turn it on in Account → Two-step sign-in; phones need version 1.6 to sign in once it’s on, and the next version to use a passkey.',
                links: [
                    {
                        kind: 'blog',
                        slug: 'two-step-sign-in',
                        label: 'What it protects, and what it doesn’t',
                    },
                ],
            },
            {
                id: 'phone-notifications',
                status: 'shipped',
                month: 'November 2026',
                area: 'Apps',
                title: 'Notifications on your phone',
                body: 'The same notifications in the iPhone and Android apps from version 1.4.1. They pass through push.hushos.com, which hands Apple and Google a random event ID and nothing about what happened. Turn them on in Account → Notifications.',
                links: [{ kind: 'blog', slug: 'notifications', label: 'How they stay private' }],
            },
            {
                id: 'browser-notifications',
                status: 'shipped',
                month: 'November 2026',
                area: 'Platform',
                title: 'Notifications in your browser',
                body: 'New sign-ins, removed devices, shares and family invitations, while HushOS is closed. A notification carries only a random event ID, encrypted to your browser; HushOS writes the words on your computer.',
                links: [{ kind: 'blog', slug: 'notifications', label: 'How they stay private' }],
            },
            {
                id: 'app-sign-up',
                status: 'shipped',
                month: 'November 2026',
                area: 'Apps',
                title: 'Create your account in the app',
                body: 'Make your account on your phone, without the web: confirm your email, choose a password, save your recovery kit, and your drive opens. On iPhone and Android from version 1.2.',
            },
            {
                id: 'phone-apps',
                status: 'shipped',
                month: 'November 2026',
                area: 'Apps',
                title: 'The iPhone app on the App Store',
                body: 'The same folders, sharing, links, families, files kept on the phone and HushOS in the phone’s Files app as the Android app, with Scan document. For iPhone, on iOS 26 and later.',
                links: [
                    { kind: 'store', platform: 'ios', label: 'Get it on the App Store' },
                    { kind: 'blog', slug: 'phone-apps', label: 'Read the announcement' },
                ],
            },
            {
                id: 'families-on-phones',
                status: 'shipped',
                month: 'November 2026',
                area: 'Apps',
                title: 'Families on iPhone',
                body: 'Family folders in the iPhone app, with joining, inviting and letting people in, as in the Android app.',
            },
            {
                id: 'families',
                status: 'shipped',
                // The month families are switched on at hushos.com, set when this is merged.
                month: 'November 2026',
                area: 'Families',
                title: 'Family plans',
                body: 'One plan’s storage for up to 20 people, covering everyone’s own files and the family folders. Someone who manages the family lets each newcomer in, and anyone in it can check the others with twelve words. On the web and in the iPhone and Android apps.',
                links: [{ kind: 'blog', slug: 'family-plans', label: 'Read the announcement' }],
            },
            {
                id: 'releases',
                status: 'shipped',
                month: 'October 2026',
                area: 'Platform',
                title: 'Numbered releases',
                body: 'One version number for the whole of HushOS since its first release, 0.9.0, with release notes on GitHub and image tags to match, such as 1.4.1, 1.4 and 1, so a self-hosted server can follow releases instead of every change.',
                links: [
                    {
                        kind: 'docs',
                        path: 'docs/self-hosting.md',
                        label: 'Pin a self-hosted server to a release',
                    },
                ],
            },
            {
                id: 'android-app',
                status: 'shipped',
                month: 'October 2026',
                area: 'Apps',
                title: 'The Android app on Google Play',
                body: 'Your folders, sharing and links, files kept on the phone to open without a connection, and HushOS in the phone’s Files app. It’s on Google Play, and its APK is also on each GitHub release.',
                links: [{ kind: 'store', platform: 'android', label: 'Get it on Google Play' }],
            },
            {
                id: 'devices',
                status: 'shipped',
                month: 'October 2026',
                area: 'Platform',
                title: 'Your devices',
                body: 'See every device signed in to your account, rename it, and sign it out with your password. You get an email when a new device signs in or a device is removed.',
            },
            {
                id: 'post-quantum-signatures',
                status: 'shipped',
                month: 'October 2026',
                area: 'Platform',
                title: 'Post-quantum signatures on your identity',
                body: 'Your identity, its key changes and every share between accounts are signed with ML-DSA-65 beside Ed25519, so a future quantum computer can’t forge them to move your contacts onto someone else’s keys. File and folder signatures stay Ed25519 for now.',
                links: [
                    {
                        kind: 'docs',
                        path: 'docs/identity-pq-design.md',
                        label: 'Read the design',
                    },
                ],
            },
            {
                id: 'drive',
                status: 'shipped',
                month: 'September 2026',
                area: 'Drive',
                title: 'HushOS Drive 1.0',
                body: 'Files and folders, locked on your device before they leave it, with previews, versions and Trash. Search and tags work on your device, so nothing you look for reaches us.',
                links: [{ kind: 'blog', slug: 'hushos-1-0', label: 'Read the announcement' }],
            },
            {
                id: 'sharing',
                status: 'shipped',
                month: 'September 2026',
                area: 'Drive',
                title: 'Sharing and links',
                body: 'Share a folder or file with people who can view or edit it, or send a link that needs no account, with an optional password and end date. Stopping a share or turning off a link replaces the folder keys beneath it, so later changes are sealed to keys the removed person never had.',
            },
            {
                id: 'post-quantum-sharing',
                status: 'shipped',
                month: 'September 2026',
                area: 'Platform',
                title: 'Post-quantum sharing',
                body: 'Shares between accounts are sealed with X25519 and ML-KEM-768 together, so a copy of our database taken today stays shut to a quantum computer later.',
                links: [{ kind: 'blog', slug: 'post-quantum-sharing', label: 'How it works' }],
            },
            {
                id: 'sign-in',
                status: 'shipped',
                month: 'September 2026',
                area: 'Platform',
                title: 'Sign-in that keeps your password',
                body: 'Your password is checked without ever leaving your device, not even as a scrambled copy.',
                links: [
                    {
                        kind: 'blog',
                        slug: 'why-your-password-never-leaves-your-device',
                        label: 'How it works',
                    },
                ],
            },
            {
                id: 'recovery-kit',
                status: 'shipped',
                month: 'September 2026',
                area: 'Platform',
                title: 'The recovery kit',
                body: 'A 24-word recovery phrase you print or write down once. It is the only way back in if you forget your password, because nobody else holds your keys.',
                links: [{ kind: 'page', to: '/security', label: 'Read about security' }],
            },
            {
                id: 'self-hosting',
                status: 'shipped',
                month: 'September 2026',
                area: 'Platform',
                title: 'Run it yourself',
                body: 'HushOS is open source. Run your own copy with Docker Compose, free; you choose how much space each account gets.',
                links: [
                    {
                        kind: 'docs',
                        path: 'docs/self-hosting.md',
                        label: 'Read the self-hosting guide',
                    },
                ],
            },
        ],
    },
    {
        status: 'now',
        title: 'Now',
        summary: 'Being built, or built and being finished.',
        items: [
            {
                id: 'companies',
                status: 'now',
                area: 'Teams',
                title: 'HushOS for companies',
                body: 'Folders that belong to the company, admins who add and remove people, with policies and an audit log, your own domain and single sign-on, and a choice of where files are kept, including your own storage bucket. Admins of a company plan will be able to open the company’s folders, through a key the company holds.',
                links: [{ kind: 'page', to: '/teams', label: 'HushOS for teams today' }],
            },
            {
                id: 'security-keys-and-device-approval',
                status: 'now',
                area: 'Platform',
                title: 'Approving a sign-in from another device',
                body: 'Confirm a new sign-in by approving it on a device you already use, beside a passkey and the authenticator app. You choose which one HushOS asks for first.',
                links: [
                    {
                        kind: 'docs',
                        path: 'docs/two-step-design.md',
                        label: 'Read the two-step design',
                    },
                    {
                        kind: 'docs',
                        path: 'docs/devices-design.md',
                        label: 'Read the devices design',
                    },
                ],
            },
            {
                id: 'passkeys',
                status: 'now',
                area: 'Platform',
                title: 'Sign in with a passkey',
                body: 'No password: a passkey on your phone, computer or security key signs you in and unlocks your account. It needs a browser or security key that supports it, and your recovery phrase stays the way back in if you lose your passkeys.',
            },
        ],
    },
    {
        status: 'next',
        title: 'Next',
        summary: 'What we plan to build once the work above is done.',
        items: [
            {
                id: 'editing',
                status: 'next',
                area: 'Drive',
                title: 'Editing in the browser',
                body: 'Edit text files, Markdown and CSV tables, and edit images, removing location data or redacting part of a picture. Everything happens on your device, and each editing session saves one new encrypted version.',
                links: [{ kind: 'docs', path: 'docs/editing-design.md', label: 'Read the design' }],
            },
            {
                id: 'file-tools',
                status: 'next',
                area: 'Drive',
                title: 'File tools',
                body: 'Open zip and tar archives without downloading them, extract them, or compress files into one. Turn photos into a PDF, merge or split PDFs, and convert images, HEIC included, all on your device.',
                links: [
                    { kind: 'docs', path: 'docs/file-tools-design.md', label: 'Read the design' },
                ],
            },
        ],
    },
    {
        status: 'later',
        title: 'Later',
        summary: 'Planned, not promised. What comes first depends on what people need.',
        items: [
            {
                id: 'desktop-apps',
                status: 'later',
                area: 'Apps',
                title: 'Desktop apps',
                body: 'HushOS in your computer’s file manager, the way it is in the Files app on a phone.',
            },
            {
                id: 'notes-documents',
                status: 'later',
                area: 'Drive',
                title: 'Notes and documents',
                body: 'Write notes and documents in HushOS itself, kept under the same keys as your files. This is new writing, apart from editing the files you already have.',
                links: [{ kind: 'blog', slug: 'hushos-1-0', label: 'Where it fits' }],
            },
            {
                id: 'editing-together',
                status: 'later',
                area: 'Drive',
                title: 'Editing together',
                body: 'Edit the same document with other people at the same time, with every change end-to-end encrypted between your devices.',
                links: [
                    {
                        kind: 'docs',
                        path: 'docs/editing-together-design.md',
                        label: 'Read the design',
                    },
                ],
            },
            {
                id: 'messages',
                status: 'later',
                area: 'Messages',
                title: 'Messages',
                body: 'Messages with the people already in your contacts, locked on your device the way your files are.',
                links: [{ kind: 'blog', slug: 'hushos-1-0', label: 'Where it fits' }],
            },
        ],
    },
];
