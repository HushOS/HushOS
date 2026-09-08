import { emailEnv, validateEmailAdapter } from '@hushos/env/email';
import { SESv2Client, SendEmailCommand } from '@aws-sdk/client-sesv2';
import nodemailer from 'nodemailer';
import { render, toPlainText } from 'react-email';
import { Resend } from 'resend';

import VerifyEmail from './templates/verify-email';

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
                    if (error) throw new Error('Resend rejected email delivery.');
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
        default:
            throw new Error('EMAIL_ADAPTER must be smtp, resend, or ses.');
    }
}

let adapter: EmailAdapter | undefined;

export async function sendVerificationEmail(
    to: string,
    verificationUrl: string,
    purpose: 'register' | 'recover' = 'register',
) {
    adapter ??= createEmailAdapter();
    const html = await render(
        <VerifyEmail
            verificationUrl={verificationUrl}
            purpose={purpose}
            logoUrl={new URL('/email/hushos-logo-dark.png', verificationUrl).href}
        />,
    );
    await adapter.send({
        to,
        subject:
            purpose === 'recover' ? 'Recover your account · HushOS' : 'Verify your email · HushOS',
        html,
        text: toPlainText(html),
    });
}
