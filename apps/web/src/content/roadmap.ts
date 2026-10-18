/*
 * The public roadmap (/roadmap), and the one place it is written: what has
 * shipped, what is being built, and what is planned. A pull request that
 * ships, starts, drops or changes something here updates this file and
 * `updated` in the same pull request (AGENTS.md).
 *
 * Every Shipped item says the month it reached hushos.com, and only what the
 * code does; Now, Next and Later never carry a date, because work ships when
 * it is ready. roadmap.test.ts holds the file to that.
 */

export type RoadmapArea = 'Drive' | 'Families' | 'Apps' | 'Messages' | 'Teams' | 'Platform';
export type RoadmapStatus = 'shipped' | 'now' | 'next' | 'later';

/*
 * Where an item points: a blog post (by slug), a page on this site, a document
 * in the repository's docs/ folder, or a release (by tag) on GitHub.
 */
export type RoadmapLink =
    | { kind: 'blog'; slug: string; label: string }
    | { kind: 'page'; to: string; label: string }
    | { kind: 'docs'; path: string; label: string }
    | { kind: 'release'; tag: string; label: string };

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
export const updated = '2026-10-18';

export const sections: RoadmapSection[] = [
    {
        status: 'shipped',
        title: 'Shipped',
        summary: 'Live at hushos.com, and in a self-hosted copy that runs the latest code.',
        items: [
            {
                id: 'devices',
                status: 'shipped',
                month: 'October 2026',
                area: 'Platform',
                title: 'Your devices',
                body: 'See every browser signed in to your account, rename it, and sign it out with your password. You get an email when a device signs in or is removed.',
            },
            {
                id: 'post-quantum-signatures',
                status: 'shipped',
                month: 'October 2026',
                area: 'Platform',
                title: 'Post-quantum signatures',
                body: 'Your identity, its key changes and every share are signed with ML-DSA-65 beside Ed25519, so a future quantum computer can’t forge them to move your contacts onto someone else’s keys.',
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
                body: 'Share a folder or file with people who can view or edit it, or send a link that needs no account, with an optional password and end date. Stopping a share or turning off a link replaces the keys beneath it.',
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
                body: 'HushOS is open source. Run your own copy with Docker Compose, free, with as much space as your server has.',
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
                id: 'families',
                status: 'now',
                area: 'Families',
                title: 'Family plans',
                body: 'Family folders everyone in the family can open, with one storage pool for up to 20 people, and each newcomer checked with their twelve words before they join. It works on the web and isn’t switched on at hushos.com yet.',
            },
            {
                id: 'phone-apps',
                status: 'now',
                area: 'Apps',
                title: 'The iPhone and Android apps in the stores',
                body: 'The apps are built: your folders, sharing and links, files kept on the phone to open without a connection, and HushOS in the phone’s Files app. They are on their way to the App Store and Google Play. You make your account on the web.',
            },
            {
                id: 'families-on-phones',
                status: 'now',
                area: 'Apps',
                title: 'Families on iPhone and Android',
                body: 'Family folders in the apps, checked by the same rules as on the web.',
            },
            {
                id: 'releases',
                status: 'now',
                area: 'Platform',
                title: 'Numbered releases',
                body: 'One version number for the whole of HushOS, starting at 1.0.0, with a changelog and matching image tags, so a self-hosted server can follow a release instead of the latest build.',
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
                body: 'Edit text files, Markdown and CSV tables, and edit images, removing location data or redacting part of a picture. Everything happens on your device, and each save is a new encrypted version.',
                links: [{ kind: 'docs', path: 'docs/editing-design.md', label: 'Read the design' }],
            },
        ],
    },
    {
        status: 'later',
        title: 'Later',
        summary: 'Planned, not promised. What comes first depends on what people need.',
        items: [
            {
                id: 'companies',
                status: 'later',
                area: 'Teams',
                title: 'HushOS for companies',
                body: 'Folders that belong to the company, admins who add and remove people, with policies and an audit log, your own domain and single sign-on, and a choice of where files are kept, including your own storage bucket.',
                links: [{ kind: 'page', to: '/teams', label: 'HushOS for teams today' }],
            },
            {
                id: 'desktop-apps',
                status: 'later',
                area: 'Apps',
                title: 'Desktop apps',
                body: 'HushOS in your computer’s file manager, the way it is in the Files app on a phone.',
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
