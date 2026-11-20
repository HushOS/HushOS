import '@/lib/server-only';
import { appEnv } from '@hushos/env/app';

/*
 * /.well-known/security.txt (RFC 9116): where to report a vulnerability in this
 * instance. Served only when SECURITY_CONTACT is set, so an instance without one
 * names nobody. Expires must be present and should stay under a year; it is set six
 * months past today (UTC midnight, so the body is the same all day), meaning the file
 * stays valid for as long as the instance keeps serving it from live configuration.
 */

const DAY_MS = 24 * 60 * 60 * 1000;
const VALID_DAYS = 182;

export function securityTxt() {
    const contact = appEnv.SECURITY_CONTACT;
    if (!contact) return new Response('Not found', { status: 404 });
    const now = new Date();
    const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
    const expires = new Date(today + VALID_DAYS * DAY_MS).toISOString();
    const body = [
        `Contact: mailto:${contact}`,
        `Expires: ${expires}`,
        'Preferred-Languages: en',
        `Canonical: ${appEnv.APP_ORIGIN}/.well-known/security.txt`,
        '',
    ].join('\n');
    return new Response(body, {
        headers: {
            'Content-Type': 'text/plain; charset=utf-8',
            'Cache-Control': 'public, max-age=3600',
            'X-Content-Type-Options': 'nosniff',
        },
    });
}
