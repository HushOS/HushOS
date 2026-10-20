import { randomUUID } from 'node:crypto';
import { emailEnv, validateEmailAdapter } from '@hushos/env/email';
import { SESv2Client, SendEmailCommand } from '@aws-sdk/client-sesv2';
import nodemailer from 'nodemailer';
import { Resend } from 'resend';
import { groupInvitation } from './rendered/group-invitation';
import { securityNotice } from './rendered/security-notice';
import { shareNotice } from './rendered/share-notice';
import { verifyEmail } from './rendered/verify-email';

type EmailMessage = { to: string; subject: string; html: string; text: string };
type EmailAdapter = { send: (message: EmailMessage) => Promise<void> };

function createEmailAdapter(): EmailAdapter {
    validateEmailAdapter();
    const from = emailEnv.EMAIL_FROM;
    switch (emailEnv.EMAIL_ADAPTER) {
        case 'smtp': {
            const port = emailEnv.SMTP_PORT;
            if (!Number.isInteger(port) || port < 1 || port > 65535)
                throw new Error('SMTP_PORT must be a valid port.');
            const user = emailEnv.SMTP_USER;
            const pass = emailEnv.SMTP_PASSWORD;
            if (Boolean(user) !== Boolean(pass))
                throw new Error('Set both SMTP_USER and SMTP_PASSWORD.');
            const transport = nodemailer.createTransport({
                host: emailEnv.SMTP_HOST,
                port,
                secure: emailEnv.SMTP_SECURE ?? port === 465,
                requireTLS: emailEnv.SMTP_REQUIRE_TLS,
                auth: user && pass ? { user, pass } : undefined,
                connectionTimeout: 10_000,
                greetingTimeout: 10_000,
                socketTimeout: 15_000,
                disableFileAccess: true,
                disableUrlAccess: true,
            });
            return {
                async send(message) {
                    await transport.sendMail({ from, ...message });
                },
            };
        }
        case 'resend': {
            const resend = new Resend(emailEnv.RESEND_API_KEY);
            return {
                async send(message) {
                    const { error } = await resend.emails.send({ from, ...message });
                    if (error)
                        throw new Error('Resend rejected email delivery.', {
                            cause: Object.assign(new Error(error.name), { name: error.name }),
                        });
                },
            };
        }
        case 'ses': {
            const ses = new SESv2Client({ region: emailEnv.AWS_REGION, maxAttempts: 2 });
            return {
                async send(message) {
                    await ses.send(
                        new SendEmailCommand({
                            FromEmailAddress: from,
                            Destination: { ToAddresses: [message.to] },
                            Content: {
                                Simple: {
                                    Subject: { Data: message.subject, Charset: 'UTF-8' },
                                    Body: {
                                        Html: { Data: message.html, Charset: 'UTF-8' },
                                        Text: { Data: message.text, Charset: 'UTF-8' },
                                    },
                                },
                            },
                        }),
                        { abortSignal: AbortSignal.timeout(15_000) },
                    );
                },
            };
        }
        case 'log':
            return {
                async send(message) {
                    // The verification link is in the text body; `docker compose logs web` shows it.
                    console.info(
                        `[email] To: ${message.to}\n[email] Subject: ${message.subject}\n${message.text
                            .split('\n')
                            .map((line) => `[email] ${line}`)
                            .join('\n')}`,
                    );
                },
            };
        default:
            throw new Error('EMAIL_ADAPTER must be smtp, resend, ses, or log.');
    }
}

let adapter: EmailAdapter | undefined;

function escapeHtml(value: string) {
    return value
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;')
        .replaceAll("'", '&#39;');
}

/*
 * The templates were rendered at build time (scripts/render.tsx). Filling them is
 * substitution: values are escaped for the HTML variant because they sit in
 * hrefs and visible text, and left as they are for the plain-text variant.
 * One pass, with a function for each value: what a person typed is never read as
 * a replacement pattern ($& or $') or as another placeholder. A placeholder no
 * value fills refuses the message rather than sending the raw token.
 */
function fillTemplate(template: string, values: Record<string, string>, html: boolean) {
    return template.replace(/\{\{(\w+)\}\}/g, (_token, name: string) => {
        const value = Object.hasOwn(values, name) ? values[name] : undefined;
        if (value === undefined)
            throw Object.assign(new Error(`No value fills the email placeholder ${name}.`), {
                name: 'EmailPlaceholderError',
            });
        return html ? escapeHtml(value) : value;
    });
}

/*
 * One message from a rendered template. Every message ends with a hidden marker
 * of its own: Gmail folds the end of a message behind "•••" when it matches an
 * earlier one in the same thread, and in two notices that end was the button.
 */
function compose(
    to: string,
    subject: string,
    template: { html: string; text: string },
    values: Record<string, string>,
): EmailMessage {
    const filled = { ...values, marker: randomUUID() };
    return {
        to,
        subject,
        html: fillTemplate(template.html, filled, true),
        text: fillTemplate(template.text, filled, false),
    };
}

async function deliver(message: EmailMessage) {
    adapter ??= createEmailAdapter();
    await adapter.send(message);
}

const logoUrl = (base: string) => new URL('/email/hushos-logo-square.png', base).href;

export function composeVerificationEmail(
    to: string,
    verificationUrl: string,
    purpose: 'register' | 'recover' = 'register',
) {
    return compose(
        to,
        purpose === 'recover' ? 'Recover your account · HushOS' : 'Verify your email · HushOS',
        verifyEmail[purpose],
        { verificationUrl, logoUrl: logoUrl(verificationUrl) },
    );
}

export async function sendVerificationEmail(
    to: string,
    verificationUrl: string,
    purpose: 'register' | 'recover' = 'register',
) {
    await deliver(composeVerificationEmail(to, verificationUrl, purpose));
}

type ShareInput = {
    granterName: string;
    granterEmail: string;
    role: 'viewer' | 'editor';
    sharedUrl: string;
};

/* Someone shared something with the recipient: who, what role, where to open it. Never the item's name. */
export function composeShareEmail(to: string, input: ShareInput) {
    return compose(
        to,
        `${input.granterName} shared something with you · HushOS`,
        shareNotice[input.role],
        {
            granterName: input.granterName,
            granterEmail: input.granterEmail,
            sharedUrl: input.sharedUrl,
            logoUrl: logoUrl(input.sharedUrl),
        },
    );
}

export async function sendShareEmail(to: string, input: ShareInput) {
    await deliver(composeShareEmail(to, input));
}

export type SecurityNoticeKind = keyof typeof securityNotice;

/*
 * Each subject carries when it happened, so two notices are two conversations:
 * Gmail threads mail from one sender by subject, and in a thread it hides what
 * a message shares with the one before.
 */
const securitySubjects: Record<SecurityNoticeKind, (when: string) => string> = {
    'new-device': (when) => `New sign-in to your account · ${when} · HushOS`,
    'device-removed': (when) => `A device was removed from your account · ${when} · HushOS`,
    'devices-removed': (when) => `Devices were removed from your account · ${when} · HushOS`,
    'password-attempts': (when) =>
        `Someone kept trying to confirm your password · ${when} · HushOS`,
};

type SecurityInput = { kind: SecurityNoticeKind; when: string; count?: number; accountUrl: string };

/*
 * A security notice about the account's devices: when it happened (written by
 * the caller, in UTC), how many devices for a removal of all others, and a link
 * to the device list. It carries nothing the device said about itself.
 */
export function composeSecurityNotice(to: string, input: SecurityInput) {
    return compose(to, securitySubjects[input.kind](input.when), securityNotice[input.kind], {
        when: input.when,
        count: String(input.count ?? 1),
        accountUrl: input.accountUrl,
        logoUrl: logoUrl(input.accountUrl),
    });
}

export async function sendSecurityNotice(to: string, input: SecurityInput) {
    await deliver(composeSecurityNotice(to, input));
}

type InvitationInput = {
    inviterName: string;
    inviterEmail: string;
    groupName: string;
    joinUrl: string;
};

/*
 * An invitation into a family: who sent it, the family's name, and the
 * one-time link (its token in the fragment). The name is the organiser's own
 * text: escaped like every value, and never in the subject, which leads with
 * the inviter.
 */
export function composeGroupInvitation(to: string, input: InvitationInput) {
    return compose(
        to,
        `${input.inviterName} invited you to join a family · HushOS`,
        groupInvitation,
        {
            inviterName: input.inviterName,
            inviterEmail: input.inviterEmail,
            groupName: input.groupName,
            joinUrl: input.joinUrl,
            logoUrl: logoUrl(input.joinUrl),
        },
    );
}

export async function sendGroupInvitation(to: string, input: InvitationInput) {
    await deliver(composeGroupInvitation(to, input));
}
