import type { ReportCategory } from '@hushos/drive/api';

/*
 * What goes into an evidence packet beside the evidence: who to file with, on
 * what clock, and how to handle the material. Written for an operator who has
 * never done this before and is doing it under time pressure. General
 * guidance, kept current by hand; not legal advice, and it says so.
 */

export type Authority = { name: string; where: string; url: string; note?: string };

export type Guidance = {
    title: string;
    /* The clock the queue runs on, in the operator's words. */
    deadline: string;
    handling: string[];
    authorities: Authority[];
    /* Whether the packet may carry the files themselves. */
    includeFiles: boolean;
};

export const GUIDANCE: Record<ReportCategory, Guidance> = {
    csam: {
        title: 'Child sexual abuse material',
        deadline:
            'File as soon as reasonably possible after confirming. In the United States 18 U.S.C. § 2258A requires a CyberTipline report from any provider with actual knowledge, and reported material must be preserved for one year. The queue targets one day.',
        handling: [
            'Do not download, copy, forward or keep the files anywhere outside the evidence store and the report you file. Possession is an offence in most jurisdictions even for the person reporting; the reporting channels below are the lawful route.',
            'This packet therefore contains hashes and metadata only, never the files. Give the files to the authority through its own upload (the CyberTipline form and API accept them), or let them request access.',
            'Look only as much as needed to confirm. Every open is on the report’s record.',
            'Keep the report on hold. Mark it as filed with the report number you receive, which holds it indefinitely.',
        ],
        authorities: [
            {
                name: 'NCMEC CyberTipline',
                where: 'United States, and any provider serving people in the United States',
                url: 'https://report.cybertip.org/',
                note: 'Registered electronic service providers can file through the CyberTipline API instead of the form.',
            },
            {
                name: 'Internet Watch Foundation',
                where: 'United Kingdom',
                url: 'https://report.iwf.org.uk/',
            },
            {
                name: 'Canadian Centre for Child Protection (Cybertip.ca)',
                where: 'Canada',
                url: 'https://www.cybertip.ca/',
            },
            {
                name: 'INHOPE member hotline',
                where: 'Most of Europe and 50 other countries',
                url: 'https://www.inhope.org/EN/hotlines',
                note: 'Find the hotline for the country the instance is operated in.',
            },
            {
                name: 'National Cyber Crime Reporting Portal',
                where: 'India',
                url: 'https://cybercrime.gov.in/',
            },
            {
                name: 'eSafety Commissioner',
                where: 'Australia',
                url: 'https://www.esafety.gov.au/report',
            },
        ],
        includeFiles: false,
    },
    terrorism: {
        title: 'Terrorist or violent extremist content',
        deadline:
            'In the European Union a removal order under the Terrorist Content Online Regulation must be acted on within one hour of receipt. Treat every report in this category as if that order is coming: the queue gives it one hour.',
        handling: [
            'Remove the content first, then file. A live link is the harm.',
            'Preserve everything: removal orders and later prosecutions ask for the content, the uploader’s account details and the timeline. Keep the report on hold.',
            'Files are included in this packet; hand them only to the authority.',
        ],
        authorities: [
            {
                name: 'Europol Internet Referral Unit',
                where: 'European Union',
                url: 'https://www.europol.europa.eu/report-a-crime/report-terrorism',
            },
            {
                name: 'Counter Terrorism Policing (Action Counters Terrorism)',
                where: 'United Kingdom',
                url: 'https://act.campaign.gov.uk/',
            },
            {
                name: 'FBI tips',
                where: 'United States',
                url: 'https://tips.fbi.gov/',
            },
            {
                name: 'Global Internet Forum to Counter Terrorism',
                where: 'Hash sharing among providers',
                url: 'https://gifct.org/',
                note: 'For matching, not for reporting.',
            },
        ],
        includeFiles: true,
    },
    ncii: {
        title: 'Intimate images shared without consent',
        deadline:
            'In the United States the Take It Down Act requires removal within 48 hours of a valid request from the person depicted. The queue gives it 48 hours from the report; removing sooner is better.',
        handling: [
            'Remove first when the report is credible; the person depicted is harmed every hour it stays up.',
            'The person depicted, not a bystander, has standing to ask most helplines for help. If the reporter is that person, point them at the helplines below as well.',
            'Files are included in this packet; hand them only to the authority or to the person’s own lawyer at their request. If the person depicted may be under 18, treat it as child sexual abuse material instead: hashes only, and NCMEC.',
        ],
        authorities: [
            {
                name: 'StopNCII.org',
                where: 'Worldwide, run by the Revenge Porn Helpline',
                url: 'https://stopncii.org/',
                note: 'Hash matching so the images cannot be re-uploaded on participating platforms.',
            },
            {
                name: 'Revenge Porn Helpline',
                where: 'United Kingdom',
                url: 'https://revengepornhelpline.org.uk/',
            },
            {
                name: 'Cyber Civil Rights Initiative',
                where: 'United States',
                url: 'https://cybercivilrights.org/',
            },
            {
                name: 'eSafety Commissioner',
                where: 'Australia',
                url: 'https://www.esafety.gov.au/report/image-based-abuse',
            },
            {
                name: 'Local police',
                where: 'Everywhere',
                url: '',
                note: 'Sharing intimate images without consent is a crime in most countries.',
            },
        ],
        includeFiles: true,
    },
    malware: {
        title: 'Malware or phishing',
        deadline:
            'No statutory clock; the queue gives it three days. Remove as soon as confirmed, since every download is a new victim.',
        handling: [
            'Do not open the files outside a sandbox. Hashes are usually enough for the recipients below.',
            'Files are included in this packet for analysts; share them only through channels that expect malware.',
        ],
        authorities: [
            {
                name: 'Your national CERT or CSIRT',
                where: 'Everywhere',
                url: 'https://www.first.org/members/teams/',
            },
            {
                name: 'Google Safe Browsing report',
                where: 'Worldwide',
                url: 'https://safebrowsing.google.com/safebrowsing/report_badware/',
            },
            {
                name: 'Anti-Phishing Working Group',
                where: 'Worldwide',
                url: 'https://apwg.org/reportphishing/',
            },
            {
                name: 'VirusTotal',
                where: 'Analysis, not reporting',
                url: 'https://www.virustotal.com/',
            },
        ],
        includeFiles: true,
    },
    copyright: {
        title: 'Copyright infringement',
        deadline:
            'No statutory clock for a report from a bystander; the queue gives it a week. A formal notice from the rights holder starts the takedown process your jurisdiction defines.',
        handling: [
            'A report here is not a takedown notice. Ask the rights holder for a proper notice (in the United States a DMCA notice under 17 U.S.C. § 512(c)(3); in the European Union a notice under Article 16 of the Digital Services Act) before removing on copyright grounds alone.',
            'Give the uploader the notice and the chance to counter-notice where the law provides one.',
            'Files are included in this packet; the rights holder may ask for them.',
        ],
        authorities: [
            {
                name: 'The rights holder or their agent',
                where: 'Everywhere',
                url: '',
                note: 'Copyright is enforced by the holder, not by an authority.',
            },
            {
                name: 'US Copyright Office designated-agent directory',
                where: 'United States',
                url: 'https://dmca.copyright.gov/osp/',
            },
        ],
        includeFiles: true,
    },
    harassment: {
        title: 'Harassment or threats',
        deadline:
            'No statutory clock; the queue gives it three days. A credible threat of violence is a police matter today, not a queue item.',
        handling: [
            'Preserve before removing: the target may need the content as evidence.',
            'If the target is identifiable and the threat is credible, contact the police in their country and let them advise on removal.',
            'Files are included in this packet.',
        ],
        authorities: [
            {
                name: 'Local police',
                where: 'Everywhere',
                url: '',
                note: 'Threats of violence are crimes everywhere; use the emergency number when someone is in danger now.',
            },
            {
                name: 'eSafety Commissioner',
                where: 'Australia',
                url: 'https://www.esafety.gov.au/report/adult-cyber-abuse',
            },
        ],
        includeFiles: true,
    },
    other: {
        title: 'Something else',
        deadline: 'No statutory clock; the queue gives it a week.',
        handling: [
            'Read the reason, look, decide. If what you find fits another category, reopen and handle it under that category’s rules.',
            'Files are included in this packet.',
        ],
        authorities: [],
        includeFiles: true,
    },
};

export const DISCLAIMER =
    'This guidance is general and maintained by hand. It is not legal advice. Which authority applies depends on where the instance is operated and where the people involved are; when in doubt, ask a lawyer before you act, but do not let that delay removing content that is harming someone.';
