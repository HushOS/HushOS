/*
 * The comparison pages, as data. Each row names one thing a person deciding
 * between two drives would ask about, and answers it for both, in words a
 * person who does not know what encryption is can follow. Where the other
 * service is better, the page says so; a comparison that only flatters is
 * an advertisement, and people can tell. Facts about other services were
 * checked against their own pages in September 2026 and can change; the
 * `checked` date is shown on the page.
 *
 * Every answer starts with a short answer that can be read at a glance, and
 * keeps the detail under it. The short answer only ever restates what the
 * detail (or the answer as it was first written) already says.
 */

export type Answer = {
    /* The answer at a glance: "Yes.", "Up to 15 GB.". */
    short: string;
    /* The rest of what is true, when there is more to say. */
    detail?: string;
};

export type Comparison = {
    slug: string;
    name: string;
    /* Whose own pages the facts were checked against: "Google". */
    maker: string;
    /* One line under the title. */
    summary: string;
    checked: string;
    rows: { topic: string; hushos: Answer; other: Answer }[];
    /* Where the other service is the better choice, plainly. */
    theirs: string[];
    /* Where HushOS is different, plainly. */
    ours: string[];
    /* How to bring files across, in three steps. */
    switching: string[];
};

const HUSHOS = {
    locked: {
        short: 'No, never.',
        detail: 'Every file and its name is locked on your device before upload. We cannot read either.',
    },
    password: {
        short: 'Never sent to us.',
        detail: 'Not even in a scrambled form. It is checked on your device.',
    },
    sharing: {
        short: 'With people, or by link.',
        detail: 'Locked on your device for each person you choose, in a way built to hold up against the computers of the future. Links can have a password and an end date. Stopping a share really stops it, even for what they had already seen.',
    },
    open: {
        short: 'Yes, all of it.',
        detail: 'The app and the server. Anyone can read it or run it.',
    },
    selfHost: {
        short: 'Yes, for free.',
        detail: 'With a Docker Compose guide.',
    },
    free: {
        short: '2 GB.',
        detail: 'And more for every friend you invite.',
    },
    apps: {
        short: 'A web app.',
        detail: 'It installs on any phone or computer, like an app.',
    },
    company: {
        short: 'HushOS, United States.',
        detail: 'Incorporated in Delaware. The hosted service keeps its servers and storage in the European Union.',
    },
    ads: {
        short: 'Storage plans, nothing else.',
        detail: 'No advertising. Paid for by people who buy more storage.',
    },
} satisfies Record<string, Answer>;

export const comparisons: Comparison[] = [
    {
        slug: 'google-drive',
        name: 'Google Drive',
        maker: 'Google',
        summary:
            'Google Drive is the drive most people already have. It is generous and everywhere, and Google can read everything in it.',
        checked: '2026-09-14',
        rows: [
            {
                topic: 'Can the company read your files?',
                hushos: HUSHOS.locked,
                other: {
                    short: 'Yes.',
                    detail: 'Files are encrypted on Google’s servers with Google’s keys. Client-side encryption exists only on some Workspace business plans, set up by an administrator.',
                },
            },
            {
                topic: 'Your password',
                hushos: HUSHOS.password,
                other: {
                    short: 'Sent to Google.',
                    detail: 'To sign in, as with any Google account.',
                },
            },
            {
                topic: 'Sharing',
                hushos: HUSHOS.sharing,
                other: {
                    short: 'With people, or by link.',
                    detail: 'With viewer, commenter and editor roles. Google can read what you share.',
                },
            },
            {
                topic: 'Free storage',
                hushos: HUSHOS.free,
                other: {
                    short: 'Up to 15 GB.',
                    detail: 'Shared across Drive, Gmail and Photos.',
                },
            },
            {
                topic: 'Open source',
                hushos: HUSHOS.open,
                other: { short: 'No.' },
            },
            {
                topic: 'Run it yourself',
                hushos: HUSHOS.selfHost,
                other: { short: 'No.' },
            },
            {
                topic: 'Apps',
                hushos: HUSHOS.apps,
                other: {
                    short: 'Web, Windows, Mac, Android and iOS.',
                    detail: 'With Docs, Sheets and Slides built in.',
                },
            },
            {
                topic: 'How it is paid for',
                hushos: HUSHOS.ads,
                other: {
                    short: 'Storage plans.',
                    detail: 'And Google’s advertising business more broadly.',
                },
            },
        ],
        theirs: [
            'You want to write documents and spreadsheets together with other people, in the browser, at the same time. Google Docs is very good at that and HushOS does not do it.',
            'You need a lot of free space today. 15 GB is far more than the 2 GB HushOS starts you with.',
            'You live inside Gmail, Android or Chromebooks, where Drive is already there.',
        ],
        ours: [
            'Nobody but you can read your files or their names. Not Google, not us, not a system training on them.',
            'Your password is never sent anywhere.',
            'The code is public, and you can run the whole thing on a machine you own.',
            'Stopping a share actually stops it: the keys change, so what was shared stays shut.',
        ],
        switching: [
            'Download the folders you want from Google Drive. Google Takeout gives you everything at once.',
            'Drag them onto your HushOS Drive. Folders come across with their structure.',
            'Close the tab if you need to. Uploads pick up where they left off.',
        ],
    },
    {
        slug: 'proton-drive',
        name: 'Proton Drive',
        maker: 'Proton',
        summary:
            'Proton Drive is the closest thing to HushOS: encrypted on your device by default, made by people who mean it. The differences are about openness and where it runs.',
        checked: '2026-09-14',
        rows: [
            {
                topic: 'Can the company read your files?',
                hushos: HUSHOS.locked,
                other: {
                    short: 'No.',
                    detail: 'Files, names and folder structure are encrypted on your device by default.',
                },
            },
            {
                topic: 'Your password',
                hushos: HUSHOS.password,
                other: {
                    short: 'Never sent.',
                    detail: 'Proton uses SRP, a different protocol with the same result.',
                },
            },
            {
                topic: 'Sharing',
                hushos: HUSHOS.sharing,
                other: {
                    short: 'With Proton users, or by link.',
                    detail: 'Encrypted end to end. Links can have a password and an expiry date.',
                },
            },
            {
                topic: 'Free storage',
                hushos: HUSHOS.free,
                other: {
                    short: 'Up to 5 GB.',
                    detail: '2 GB to start, rising to 5 GB after a few setup steps.',
                },
            },
            {
                topic: 'Open source',
                hushos: HUSHOS.open,
                other: {
                    short: 'The apps only.',
                    detail: 'The apps are open source under the GPL and independently audited. The server is not.',
                },
            },
            {
                topic: 'Run it yourself',
                hushos: HUSHOS.selfHost,
                other: { short: 'No.' },
            },
            {
                topic: 'Apps',
                hushos: HUSHOS.apps,
                other: {
                    short: 'Web, Windows, Mac, Android and iOS.',
                    detail: 'With file sync on desktop.',
                },
            },
            {
                topic: 'Company',
                hushos: HUSHOS.company,
                other: {
                    short: 'Proton AG, Switzerland.',
                    detail: 'Servers in Switzerland and the European Union.',
                },
            },
        ],
        theirs: [
            'You want native apps today, with folder sync on your computer. Proton has years of them; HushOS is a web app you install.',
            'You already use Proton Mail, Calendar or Pass and want one account for all of it.',
            'You want a service with a long track record and published audits. HushOS 1.0 is new.',
        ],
        ours: [
            'The server is open too, not just the apps. You can run a complete HushOS for your family or team on a machine you own, for free.',
            'Sharing with people is sealed to a key you pinned and can check by fingerprint, so a swapped key is caught, and it is post-quantum: a copy of our database taken today stays shut to a quantum computer later.',
            'There is nothing to learn. One phrase to keep safe at sign-up, and then it is just a drive.',
        ],
        switching: [
            'Download your folders from Proton Drive.',
            'Drag them onto your HushOS Drive.',
            'That is the whole move. Both services keep your files readable only by you, so it is a plain download and upload; nothing has to be unlocked on a server in between.',
        ],
    },
    {
        slug: 'dropbox',
        name: 'Dropbox',
        maker: 'Dropbox',
        summary:
            'Dropbox made syncing folders feel normal. Its personal plans are still readable by Dropbox, and its encrypted option is for businesses only.',
        checked: '2026-09-14',
        rows: [
            {
                topic: 'Can the company read your files?',
                hushos: HUSHOS.locked,
                other: {
                    short: 'Yes, on personal plans.',
                    detail: 'End-to-end encryption exists only for chosen team folders on Advanced, Business Plus and Enterprise plans.',
                },
            },
            {
                topic: 'Your password',
                hushos: HUSHOS.password,
                other: {
                    short: 'Sent to Dropbox.',
                    detail: 'To sign in.',
                },
            },
            {
                topic: 'Sharing',
                hushos: HUSHOS.sharing,
                other: {
                    short: 'With people, or by link.',
                    detail: 'Passwords and expiry on paid plans. Dropbox can read what you share.',
                },
            },
            {
                topic: 'Free storage',
                hushos: HUSHOS.free,
                other: { short: '2 GB.' },
            },
            {
                topic: 'Open source',
                hushos: HUSHOS.open,
                other: { short: 'No.' },
            },
            {
                topic: 'Run it yourself',
                hushos: HUSHOS.selfHost,
                other: { short: 'No.' },
            },
            {
                topic: 'Apps',
                hushos: HUSHOS.apps,
                other: {
                    short: 'Web, Windows, Mac, Linux, Android and iOS.',
                    detail: 'With the folder sync it is known for.',
                },
            },
            {
                topic: 'How it is paid for',
                hushos: HUSHOS.ads,
                other: { short: 'Storage and team plans.' },
            },
        ],
        theirs: [
            'You want a folder on your computer that just stays in sync, today. That is what Dropbox is, and our desktop app is still coming.',
            'Your team already runs on Dropbox integrations with other tools.',
        ],
        ours: [
            'Private on every plan, including the free one, not only for business team folders.',
            'Your password never leaves your device.',
            'Open source and yours to run.',
            'Password-protected links, expiry, and real revocation are included, not a paid extra.',
        ],
        switching: [
            'Find your Dropbox folder. It is already on your computer.',
            'Drag it, or the parts you want, onto your HushOS Drive in the browser.',
            'Large folders upload in the background and resume if interrupted.',
        ],
    },
    {
        slug: 'icloud-drive',
        name: 'iCloud Drive',
        maker: 'Apple',
        summary:
            'iCloud Drive is built into every Apple device. It can be made private, but only if you find the switch, and only for people who use Apple.',
        checked: '2026-09-14',
        rows: [
            {
                topic: 'Can the company read your files?',
                hushos: HUSHOS.locked,
                other: {
                    short: 'Yes, by default.',
                    detail: 'Unless you turn on Advanced Data Protection, which is off by default. With it on, iCloud Drive is end-to-end encrypted.',
                },
            },
            {
                topic: 'Your password',
                hushos: HUSHOS.password,
                other: {
                    short: 'Sent to Apple.',
                    detail: 'Your Apple Account password, to sign in.',
                },
            },
            {
                topic: 'Sharing',
                hushos: HUSHOS.sharing,
                other: {
                    short: 'With people, or by link.',
                    detail: 'Shared content stays end-to-end encrypted only if everyone involved has Advanced Data Protection on.',
                },
            },
            {
                topic: 'Free storage',
                hushos: HUSHOS.free,
                other: {
                    short: '5 GB.',
                    detail: 'Shared with backups and photos.',
                },
            },
            {
                topic: 'Open source',
                hushos: HUSHOS.open,
                other: { short: 'No.' },
            },
            {
                topic: 'Run it yourself',
                hushos: HUSHOS.selfHost,
                other: { short: 'No.' },
            },
            {
                topic: 'Apps',
                hushos: HUSHOS.apps,
                other: {
                    short: 'iPhone, iPad, Mac, Windows and web.',
                    detail: 'Built into iPhone, iPad and Mac; a Windows app; a web app. Nothing for Android.',
                },
            },
            {
                topic: 'How it is paid for',
                hushos: HUSHOS.ads,
                other: { short: 'Storage plans and Apple hardware.' },
            },
        ],
        theirs: [
            'Everyone you share with uses Apple devices and you are all willing to turn on Advanced Data Protection.',
            'You want your iPhone backed up and your photos synced in the same place, with nothing to install.',
        ],
        ours: [
            'Private by default. There is no switch to find, and it works the same on Android, Windows and Linux.',
            'Sharing is private with anyone, including people with no account, through a link.',
            'Open source and yours to run.',
        ],
        switching: [
            'Find your iCloud Drive folder: in the Finder on a Mac, in File Explorer on Windows.',
            'Drag what you want onto your HushOS Drive in the browser.',
            'On an iPhone, share files from the Files app to the HushOS web app, or upload them from within it.',
        ],
    },
    {
        slug: 'onedrive',
        name: 'OneDrive',
        maker: 'Microsoft',
        summary:
            'OneDrive comes with Windows and Office. Microsoft can read what is in it; the Personal Vault adds a lock screen, not encryption you hold.',
        checked: '2026-09-14',
        rows: [
            {
                topic: 'Can the company read your files?',
                hushos: HUSHOS.locked,
                other: {
                    short: 'Yes.',
                    detail: 'Files are encrypted on Microsoft’s servers with Microsoft’s keys. Personal Vault asks you to verify your identity again; it does not change who holds the keys.',
                },
            },
            {
                topic: 'Your password',
                hushos: HUSHOS.password,
                other: {
                    short: 'Sent to Microsoft.',
                    detail: 'Your Microsoft account password, to sign in.',
                },
            },
            {
                topic: 'Sharing',
                hushos: HUSHOS.sharing,
                other: {
                    short: 'With people, or by link.',
                    detail: 'Passwords and expiry on Microsoft 365 plans. Microsoft can read what you share.',
                },
            },
            {
                topic: 'Free storage',
                hushos: HUSHOS.free,
                other: {
                    short: '5 GB.',
                    detail: 'Personal Vault holds three files on the free plan.',
                },
            },
            {
                topic: 'Open source',
                hushos: HUSHOS.open,
                other: { short: 'No.' },
            },
            {
                topic: 'Run it yourself',
                hushos: HUSHOS.selfHost,
                other: { short: 'No.' },
            },
            {
                topic: 'Apps',
                hushos: HUSHOS.apps,
                other: {
                    short: 'Windows, Mac, Android and iOS.',
                    detail: 'Built into Windows. Office opens files in place.',
                },
            },
            {
                topic: 'How it is paid for',
                hushos: HUSHOS.ads,
                other: { short: 'Microsoft 365 subscriptions and storage plans.' },
            },
        ],
        theirs: [
            'You live in Word, Excel and Outlook and want files to open and save there without thinking about it.',
            'Your files are already in the OneDrive folder on every Windows machine you own.',
        ],
        ours: [
            'Nobody but you can read your files or their names.',
            'Word and Excel files preview in HushOS too, without leaving your device.',
            'Your password never leaves your device, and there is no vault to remember to lock.',
            'Open source and yours to run.',
        ],
        switching: [
            'Find your OneDrive folder in File Explorer.',
            'Drag what you want onto your HushOS Drive in the browser.',
            'Close the tab if you need to. Large uploads run in the background and resume.',
        ],
    },
    {
        slug: 'mega',
        name: 'MEGA',
        maker: 'MEGA',
        summary:
            'MEGA gives away more encrypted storage than anyone. The service is closed, and the encryption is something you take on trust in the apps.',
        checked: '2026-09-14',
        rows: [
            {
                topic: 'Can the company read your files?',
                hushos: HUSHOS.locked,
                other: {
                    short: 'No.',
                    detail: 'Files are encrypted on your device by default.',
                },
            },
            {
                topic: 'Your password',
                hushos: HUSHOS.password,
                other: {
                    short: 'Not sent, but a key made from it is.',
                    detail: 'A key derived from your password is sent to sign in; the password itself is not.',
                },
            },
            {
                topic: 'Sharing',
                hushos: HUSHOS.sharing,
                other: {
                    short: 'With MEGA users, or by link.',
                    detail: 'The key travels in the link. Links can have a password and an expiry date.',
                },
            },
            {
                topic: 'Free storage',
                hushos: HUSHOS.free,
                other: { short: '20 GB.' },
            },
            {
                topic: 'Open source',
                hushos: HUSHOS.open,
                other: {
                    short: 'The apps only.',
                    detail: 'The apps are open source. The server is not.',
                },
            },
            {
                topic: 'Run it yourself',
                hushos: HUSHOS.selfHost,
                other: { short: 'No.' },
            },
            {
                topic: 'Apps',
                hushos: HUSHOS.apps,
                other: {
                    short: 'Web, Windows, Mac, Linux, Android and iOS.',
                    detail: 'With sync and a command line.',
                },
            },
            {
                topic: 'Company',
                hushos: HUSHOS.company,
                other: { short: 'MEGA, New Zealand.' },
            },
        ],
        theirs: [
            'You need a lot of encrypted space for free, right now. 20 GB is ten times our free plan.',
            'You want native apps and sync on every platform today.',
        ],
        ours: [
            'The whole thing is open, server included, and you can run it yourself.',
            'Stopping a share rotates the keys beneath it, so a former recipient holds nothing that still works.',
            'Shares are sealed with a post-quantum key beside the classical one, and the security page says exactly how.',
            'A design written down and tested before it was built, with the security page explaining every claim.',
        ],
        switching: [
            'Download your folders from MEGA.',
            'Drag them onto your HushOS Drive.',
            'That is the whole move. Both keep your files readable only by you, so nothing is exposed along the way.',
        ],
    },
];

export function findComparison(slug: string) {
    return comparisons.find((entry) => entry.slug === slug) ?? null;
}
