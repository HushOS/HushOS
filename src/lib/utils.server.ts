import 'server-only';

import { createHmac } from 'crypto';
import { cache } from 'react';
import { cookies } from 'next/headers';
import { render } from '@react-email/render';
import { eq } from 'drizzle-orm';
import { CookieAttributes } from 'lucia';
import { createTransport } from 'nodemailer';
import SMTPTransport from 'nodemailer/lib/smtp-transport';
import { createDate, isWithinExpirationDate, TimeSpan } from 'oslo';
import { alphabet, generateRandomString } from 'oslo/crypto';
import { Resend } from 'resend';

import ConfirmationCode from '@/emails/confirmation-code';
import { serverEnvs } from '@/env/server';
import { db } from '@/server/db';
import { emailVerificationCodes } from '@/server/db/schema';
import { lucia } from '@/services/auth';

export function signMessage(message: string, signingKey: string) {
    const signature = createHmac('sha256', signingKey).update(message).digest('hex');
    return message + '.' + signature;
}

export function parseSignedMessage(signedMessage: string, signingKey: string) {
    const message = signedMessage.substring(0, signedMessage.lastIndexOf('.'));
    const signature = signedMessage.substring(signedMessage.lastIndexOf('.') + 1);

    if (message === undefined || signature === undefined) {
        return null;
    }

    const expectedMessage = signMessage(message, signingKey);
    if (signedMessage !== expectedMessage) {
        return null;
    }

    return message;
}

export function setSignedCookie(key: string, value: string, attributes: CookieAttributes) {
    try {
        const signedValue = signMessage(value, serverEnvs.COOKIE_SIGNING_SECRET);
        cookies().set(key, signedValue, attributes);
    } catch (e) {
        // Next.js throws error when attempting to set cookies when rendering page
    }
}

export function getSignedCookie(key: string) {
    const signedValue = cookies().get(key)?.value;
    if (!signedValue) return null;
    return parseSignedMessage(signedValue, serverEnvs.COOKIE_SIGNING_SECRET);
}

export const getUser = cache(async () => {
    const sessionId = getSignedCookie(lucia.sessionCookieName);
    if (!sessionId) return null;

    const { user, session } = await lucia.validateSession(sessionId);

    try {
        if (session && session.fresh) {
            const sessionCookie = lucia.createSessionCookie(session.id);
            setSignedCookie(sessionCookie.name, sessionCookie.value, sessionCookie.attributes);
        }

        if (!session) {
            const sessionCookie = lucia.createBlankSessionCookie();
            setSignedCookie(sessionCookie.name, sessionCookie.value, sessionCookie.attributes);
        }
    } catch {
        // Next.js throws error when attempting to set cookies when rendering page
    }

    return user;
});

function getSmtpTransporter() {
    let requiresAuth =
        typeof serverEnvs.SMTP_USERNAME !== 'undefined' &&
        typeof serverEnvs.SMTP_PASSWORD !== 'undefined';

    return createTransport(
        new SMTPTransport({
            auth: requiresAuth
                ? {
                      user: serverEnvs.SMTP_USERNAME,
                      pass: serverEnvs.SMTP_PASSWORD,
                  }
                : undefined,
            host: serverEnvs.SMTP_HOST,
            port: serverEnvs.SMTP_PORT,
            secure: serverEnvs.SMTP_SECURE,
        })
    );
}

export async function sendVerificationCode(emailAddress: string, code: string) {
    if (serverEnvs.EMAIL_PROVIDER === 'console') {
        console.info(`Email From: ${serverEnvs.EMAIL_FROM} | Email To: ${emailAddress}`);
        console.info(`Your confirmation code: ${code}`);
        return true;
    }

    try {
        if (serverEnvs.EMAIL_PROVIDER === 'resend') {
            const resend = new Resend(serverEnvs.RESEND_API_KEY);
            const { error } = await resend.emails.send({
                from: serverEnvs.EMAIL_FROM,
                to: emailAddress,
                subject: `Your confirmation code: ${code}`,
                react: ConfirmationCode({ validationCode: code }),
                text: `Your confirmation code: ${code}`,
            });

            return error === null;
        }

        const transporter = getSmtpTransporter();
        const html = render(ConfirmationCode({ validationCode: code }));
        await transporter.sendMail({
            from: serverEnvs.EMAIL_FROM,
            to: emailAddress,
            subject: `Your confirmation code: ${code}`,
            html,
            text: `Your confirmation code: ${code}`,
        });

        return true;
    } catch {
        return false;
    }
}

export async function generateEmailVerificationCode(userId: string): Promise<string> {
    const existingCode = await db
        .select({ code: emailVerificationCodes.code, expiresAt: emailVerificationCodes.expiresAt })
        .from(emailVerificationCodes)
        .where(eq(emailVerificationCodes.userId, userId));

    if (existingCode.length > 0 && isWithinExpirationDate(existingCode[0]!.expiresAt)) {
        return existingCode[0]!.code;
    }

    const code = generateRandomString(6, alphabet('0-9'));
    if (existingCode.length > 0) {
        await db.delete(emailVerificationCodes).where(eq(emailVerificationCodes.userId, userId));
    }

    await db.insert(emailVerificationCodes).values({
        userId,
        code,
        expiresAt: createDate(new TimeSpan(5, 'm')),
    });

    return code;
}
