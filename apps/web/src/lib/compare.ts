/*
 * The comparison pages, as data. Each row names one thing a person deciding
 * between two drives would ask about, and answers it for both, in words a
 * person who does not know what encryption is can follow. Where the other
 * service is better, the page says so; a comparison that only flatters is
 * an advertisement, and people can tell. Facts about other services were
 * checked against their own pages in September 2026 and can change; the
 * `checked` date is shown on the page.
 */

export type Comparison = {
    slug: string;
    name: string;
    /* One line under the title. */
    summary: string;
    checked: string;
    rows: { topic: string; hushos: string; other: string }[];
    /* Where the other service is the better choice, plainly. */
    theirs: string[];
    /* Where HushOS is different, plainly. */
    ours: string[];
    /* How to bring files across. */
    switching: string;
};

const HUSHOS = {
    locked: 'No, never. Every file and its name is locked on your device before upload. We cannot read either.',
    password: 'Never sent to us, not even in a scrambled form. It is checked on your device.',
    sharing:
        'With people you choose, locked for each of them on your device in a way built to hold up against the computers of the future; or by a link with an optional password and end date. Stopping a share really stops it, even for what they had already seen.',
    open: 'Yes, all of it: the app and the server. Anyone can read it or run it.',
    selfHost: 'Yes, for free, with a Docker Compose guide.',
    free: '2 GiB, and more for every friend you invite.',
    apps: 'A web app that installs on any phone or computer, like an app.',
    company:
        'HushOS, incorporated in Delaware, United States; servers and storage in the European Union.',
    ads: 'None. Paid for by people who buy more storage, and by nothing else.',
};

export const comparisons: Comparison[] = [
    {
        slug: 'google-drive',
        name: 'Google Drive',
        summary:
            'Google Drive is the drive most people already have. It is generous and everywhere, and Google can read everything in it.',
        checked: '2026-09-14',
        rows: [
            {
                topic: 'Can the company read your files?',
                hushos: HUSHOS.locked,
                other: 'Yes. Files are encrypted on Google’s servers with Google’s keys. Client-side encryption exists only on some Workspace business plans, set up by an administrator.',
            },
            {
                topic: 'Your password',
                hushos: HUSHOS.password,
                other: 'Sent to Google to sign in, as with any Google account.',
            },
            {
                topic: 'Sharing',
                hushos: HUSHOS.sharing,
                other: 'With people or by link, with viewer, commenter and editor roles. Google can read what you share.',
            },
            {
                topic: 'Free storage',
                hushos: HUSHOS.free,
                other: 'Up to 15 GB, shared across Drive, Gmail and Photos.',
            },
            {
                topic: 'Open source',
                hushos: HUSHOS.open,
                other: 'No.',
            },
            {
                topic: 'Run it yourself',
                hushos: HUSHOS.selfHost,
                other: 'No.',
            },
            {
                topic: 'Apps',
                hushos: HUSHOS.apps,
                other: 'Web, Windows, Mac, Android and iOS, with Docs, Sheets and Slides built in.',
            },
            {
                topic: 'How it is paid for',
                hushos: HUSHOS.ads,
                other: 'Storage plans, and Google’s advertising business more broadly.',
            },
        ],
        theirs: [
            'You want to write documents and spreadsheets together with other people, in the browser, at the same time. Google Docs is very good at that and HushOS does not do it.',
            'You need a lot of free space today. Fifteen gigabytes is far more than the two HushOS starts you with.',
            'You live inside Gmail, Android or Chromebooks, where Drive is already there.',
        ],
        ours: [
            'Nobody but you can read your files or their names. Not Google, not us, not a system training on them.',
            'Your password is never sent anywhere.',
            'The code is public, and you can run the whole thing on a machine you own.',
            'Stopping a share actually stops it: the keys change, so what was shared stays shut.',
        ],
        switching:
            'Download the folders you want from Google Drive (Google Takeout gives you everything at once), then drag them onto your HushOS Drive. Folders come across with their structure, and uploads pick up where they left off if you close the tab.',
    },
    {
        slug: 'proton-drive',
        name: 'Proton Drive',
        summary:
            'Proton Drive is the closest thing to HushOS: encrypted on your device by default, made by people who mean it. The differences are about openness and where it runs.',
        checked: '2026-09-14',
        rows: [
            {
                topic: 'Can the company read your files?',
                hushos: HUSHOS.locked,
                other: 'No. Files, names and folder structure are encrypted on your device by default.',
            },
            {
                topic: 'Your password',
                hushos: HUSHOS.password,
                other: 'Never sent. Proton uses SRP, a different protocol with the same result.',
            },
            {
                topic: 'Sharing',
                hushos: HUSHOS.sharing,
                other: 'With Proton users and by link, with optional password and expiry, encrypted end to end.',
            },
            {
                topic: 'Free storage',
                hushos: HUSHOS.free,
                other: '2 GB, rising to 5 GB after a few setup steps.',
            },
            {
                topic: 'Open source',
                hushos: HUSHOS.open,
                other: 'The apps are open source under the GPL and independently audited. The server is not.',
            },
            {
                topic: 'Run it yourself',
                hushos: HUSHOS.selfHost,
                other: 'No.',
            },
            {
                topic: 'Apps',
                hushos: HUSHOS.apps,
                other: 'Web, Windows, Mac, Android and iOS, with file sync on desktop.',
            },
            {
                topic: 'Company',
                hushos: HUSHOS.company,
                other: 'Proton AG, Switzerland; servers in Switzerland and the European Union.',
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
        switching:
            'Download your folders from Proton Drive and drag them onto your HushOS Drive. Both services keep your files readable only by you, so the move is a plain download and upload; nothing has to be unlocked on a server in between.',
    },
    {
        slug: 'dropbox',
        name: 'Dropbox',
        summary:
            'Dropbox made syncing folders feel normal. Its personal plans are still readable by Dropbox, and its encrypted option is for businesses only.',
        checked: '2026-09-14',
        rows: [
            {
                topic: 'Can the company read your files?',
                hushos: HUSHOS.locked,
                other: 'Yes, on personal plans. End-to-end encryption exists only for chosen team folders on Advanced, Business Plus and Enterprise plans.',
            },
            {
                topic: 'Your password',
                hushos: HUSHOS.password,
                other: 'Sent to Dropbox to sign in.',
            },
            {
                topic: 'Sharing',
                hushos: HUSHOS.sharing,
                other: 'With people or by link, with passwords and expiry on paid plans. Dropbox can read what you share.',
            },
            {
                topic: 'Free storage',
                hushos: HUSHOS.free,
                other: '2 GB.',
            },
            {
                topic: 'Open source',
                hushos: HUSHOS.open,
                other: 'No.',
            },
            {
                topic: 'Run it yourself',
                hushos: HUSHOS.selfHost,
                other: 'No.',
            },
            {
                topic: 'Apps',
                hushos: HUSHOS.apps,
                other: 'Web, Windows, Mac, Linux, Android and iOS, with the folder sync it is known for.',
            },
            {
                topic: 'How it is paid for',
                hushos: HUSHOS.ads,
                other: 'Storage and team plans.',
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
        switching:
            'Your Dropbox folder is already on your computer. Drag it, or the parts you want, onto your HushOS Drive in the browser. Large folders upload in the background and resume if interrupted.',
    },
    {
        slug: 'icloud-drive',
        name: 'iCloud Drive',
        summary:
            'iCloud Drive is built into every Apple device. It can be made private, but only if you find the switch, and only for people who use Apple.',
        checked: '2026-09-14',
        rows: [
            {
                topic: 'Can the company read your files?',
                hushos: HUSHOS.locked,
                other: 'Yes, unless you turn on Advanced Data Protection, which is off by default. With it on, iCloud Drive is end-to-end encrypted.',
            },
            {
                topic: 'Your password',
                hushos: HUSHOS.password,
                other: 'Your Apple Account password is sent to Apple to sign in.',
            },
            {
                topic: 'Sharing',
                hushos: HUSHOS.sharing,
                other: 'With people and by link. Shared content stays end-to-end encrypted only if everyone involved has Advanced Data Protection on.',
            },
            {
                topic: 'Free storage',
                hushos: HUSHOS.free,
                other: '5 GB, shared with backups and photos.',
            },
            {
                topic: 'Open source',
                hushos: HUSHOS.open,
                other: 'No.',
            },
            {
                topic: 'Run it yourself',
                hushos: HUSHOS.selfHost,
                other: 'No.',
            },
            {
                topic: 'Apps',
                hushos: HUSHOS.apps,
                other: 'Built into iPhone, iPad and Mac; a Windows app; a web app. Nothing for Android.',
            },
            {
                topic: 'How it is paid for',
                hushos: HUSHOS.ads,
                other: 'Storage plans and Apple hardware.',
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
        switching:
            'On a Mac, your iCloud Drive folder is in the Finder; on Windows, in File Explorer. Drag what you want onto your HushOS Drive in the browser. On an iPhone, share files from the Files app to the HushOS web app or upload them from within it.',
    },
    {
        slug: 'onedrive',
        name: 'OneDrive',
        summary:
            'OneDrive comes with Windows and Office. Microsoft can read what is in it; the Personal Vault adds a lock screen, not encryption you hold.',
        checked: '2026-09-14',
        rows: [
            {
                topic: 'Can the company read your files?',
                hushos: HUSHOS.locked,
                other: 'Yes. Files are encrypted on Microsoft’s servers with Microsoft’s keys. Personal Vault asks you to verify your identity again; it does not change who holds the keys.',
            },
            {
                topic: 'Your password',
                hushos: HUSHOS.password,
                other: 'Your Microsoft account password is sent to Microsoft to sign in.',
            },
            {
                topic: 'Sharing',
                hushos: HUSHOS.sharing,
                other: 'With people or by link, with passwords and expiry on Microsoft 365 plans. Microsoft can read what you share.',
            },
            {
                topic: 'Free storage',
                hushos: HUSHOS.free,
                other: '5 GB. Personal Vault holds three files on the free plan.',
            },
            {
                topic: 'Open source',
                hushos: HUSHOS.open,
                other: 'No.',
            },
            {
                topic: 'Run it yourself',
                hushos: HUSHOS.selfHost,
                other: 'No.',
            },
            {
                topic: 'Apps',
                hushos: HUSHOS.apps,
                other: 'Built into Windows; apps for Mac, Android and iOS; Office opens files in place.',
            },
            {
                topic: 'How it is paid for',
                hushos: HUSHOS.ads,
                other: 'Microsoft 365 subscriptions and storage plans.',
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
        switching:
            'Your OneDrive folder is in File Explorer. Drag what you want onto your HushOS Drive in the browser. Large uploads run in the background and resume if you close the tab.',
    },
    {
        slug: 'mega',
        name: 'MEGA',
        summary:
            'MEGA gives away more encrypted storage than anyone. The service is closed, and the encryption is something you take on trust in the apps.',
        checked: '2026-09-14',
        rows: [
            {
                topic: 'Can the company read your files?',
                hushos: HUSHOS.locked,
                other: 'No. Files are encrypted on your device by default.',
            },
            {
                topic: 'Your password',
                hushos: HUSHOS.password,
                other: 'A key derived from it is sent to sign in; the password itself is not.',
            },
            {
                topic: 'Sharing',
                hushos: HUSHOS.sharing,
                other: 'With MEGA users and by link, where the key travels in the link, with optional password and expiry.',
            },
            {
                topic: 'Free storage',
                hushos: HUSHOS.free,
                other: '20 GB.',
            },
            {
                topic: 'Open source',
                hushos: HUSHOS.open,
                other: 'The apps are open source. The server is not.',
            },
            {
                topic: 'Run it yourself',
                hushos: HUSHOS.selfHost,
                other: 'No.',
            },
            {
                topic: 'Apps',
                hushos: HUSHOS.apps,
                other: 'Web, Windows, Mac, Linux, Android and iOS, with sync and a command line.',
            },
            {
                topic: 'Company',
                hushos: HUSHOS.company,
                other: 'MEGA, New Zealand.',
            },
        ],
        theirs: [
            'You need a lot of encrypted space for free, right now. Twenty gigabytes is ten times our free plan.',
            'You want native apps and sync on every platform today.',
        ],
        ours: [
            'The whole thing is open, server included, and you can run it yourself.',
            'Stopping a share rotates the keys beneath it, so a former recipient holds nothing that still works.',
            'Shares are sealed with a post-quantum key beside the classical one, and the security page says exactly how.',
            'A design written down and tested before it was built, with the security page explaining every claim.',
        ],
        switching:
            'Download your folders from MEGA and drag them onto your HushOS Drive. Both keep your files readable only by you, so nothing is exposed along the way.',
    },
];

export function findComparison(slug: string) {
    return comparisons.find((entry) => entry.slug === slug) ?? null;
}
