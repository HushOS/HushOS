import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Link, useLocation } from '@tanstack/react-router';
import { AuthActions, AuthLayout } from '@/components/auth-layout';
import { buttonVariants } from '@/components/ui/button';
import { Spinner } from '@/components/motion';
import { authClient } from '@/lib/auth-client';
import { authError } from '@/lib/form';
import { cue } from '@/lib/sounds';

type Enrollment = { id: string; email: string };
export function VerifiedEmailStep({
    initialEnrollment,
    purpose,
    children,
}: {
    initialEnrollment: Enrollment | null;
    purpose: 'register' | 'recover';
    children: (enrollment: Enrollment) => ReactNode;
}) {
    const hash = useLocation({ select: (location) => location.hash });
    const processed = useRef<string | undefined>(undefined);
    const [enrollment, setEnrollment] = useState(initialEnrollment);
    const [error, setError] = useState('');
    const [pending, setPending] = useState(false);
    useEffect(() => {
        if (processed.current === hash) return;
        processed.current = hash;
        const token = new URLSearchParams(window.location.hash.slice(1)).get('verify');
        if (window.location.hash)
            window.history.replaceState(window.history.state, '', window.location.pathname);
        if (!token) return;
        // The URL fragment is an external, one-time email-verification event.
        // eslint-disable-next-line react/set-state-in-effect
        setPending(true);
        void authClient
            .verifyEmail(token)
            .then(({ enrollment }) => {
                if (enrollment.purpose !== purpose)
                    throw new Error(
                        'This link belongs to a different account flow. Request a new link.',
                    );
                cue('ready');
                setEnrollment(enrollment);
            })
            .catch((error) => {
                cue('error');
                setError(authError(error));
            })
            .finally(() => setPending(false));
    }, [hash, purpose]);
    if (enrollment && !pending && !error) return children(enrollment);
    const otherFlow = error.includes('different account flow');
    // Used, late, or unknown to the server all read the same: it isn't valid any more.
    const expired = /expired|invalid|used|not valid|no longer/i.test(error);
    if (pending)
        return (
            <AuthLayout title="Checking your link…">
                <output className="flex items-center gap-2.5 text-sm text-muted-foreground">
                    <Spinner />
                    This only takes a moment.
                </output>
            </AuthLayout>
        );
    return (
        <AuthLayout
            title={
                !error
                    ? 'Open the link from your email'
                    : otherFlow
                      ? 'This link is for something else'
                      : expired
                        ? 'This link has expired'
                        : 'This link didn’t work'
            }
            description={
                !error
                    ? 'This page needs the link we emailed you. It works once, for 30 minutes.'
                    : otherFlow
                      ? purpose === 'register'
                          ? 'It resets a password rather than creating an account. Open the newest email, or ask for a new link here.'
                          : 'It creates an account rather than resetting a password. Open the newest email, or ask for a new link here.'
                      : expired
                        ? 'Links work once, for 30 minutes. Send yourself a new one and open the newest email.'
                        : error
            }
        >
            <AuthActions
                action={
                    <Link
                        to={purpose === 'register' ? '/register' : '/recover'}
                        className={buttonVariants({ size: 'lg' })}
                    >
                        Send a new link
                    </Link>
                }
            />
        </AuthLayout>
    );
}
