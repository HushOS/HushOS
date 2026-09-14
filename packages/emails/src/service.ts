import { emailEnv, validateEmailAdapter } from '@hushos/env/email';
import { SESv2Client, SendEmailCommand } from '@aws-sdk/client-sesv2';
import nodemailer from 'nodemailer';
import { Resend } from 'resend';
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
 * two substitutions: the URL is escaped for the HTML variant because it sits in
 * an href and in visible text, and left as is for the plain-text variant.
 */
function fillTemplate(template: string, values: Record<string, string>, html: boolean) {
    let output = template;
    for (const [name, value] of Object.entries(values))
        output = output.replaceAll(`{{${name}}}`, html ? escapeHtml(value) : value);
    return output;
}

export async function sendVerificationEmail(
    to: string,
    verificationUrl: string,
    purpose: 'register' | 'recover' = 'register',
) {
    adapter ??= createEmailAdapter();
    const values = {
        verificationUrl,
        logoUrl: new URL('/email/hushos-logo-dark.png', verificationUrl).href,
    };
    const template = verifyEmail[purpose];
    await adapter.send({
        to,
        subject:
            purpose === 'recover' ? 'Recover your account · HushOS' : 'Verify your email · HushOS',
        html: fillTemplate(template.html, values, true),
        text: fillTemplate(template.text, values, false),
    });
}

/* Someone shared something with the recipient: who, what role, where to open it. Never the item's name. */
export async function sendShareEmail(
    to: string,
    input: {
        granterName: string;
        granterEmail: string;
        role: 'viewer' | 'editor';
        sharedUrl: string;
    },
) {
    adapter ??= createEmailAdapter();
    const values = {
        granterName: input.granterName,
        granterEmail: input.granterEmail,
        sharedUrl: input.sharedUrl,
        logoUrl: new URL('/email/hushos-logo-dark.png', input.sharedUrl).href,
    };
    const template = shareNotice[input.role];
    await adapter.send({
        to,
        subject: `${input.granterName} shared something with you · HushOS`,
        html: fillTemplate(template.html, values, true),
        text: fillTemplate(template.text, values, false),
    });
}
