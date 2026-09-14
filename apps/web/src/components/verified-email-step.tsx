import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Link, useLocation } from '@tanstack/react-router';
import { AuthLayout } from '@/components/auth-layout';
import { FormNote, FormTable } from '@/components/form-rows';
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
    return (
        <AuthLayout
            purpose={purpose}
            title={pending ? 'Verifying your email…' : 'Verify your email'}
            stamp={pending ? 'Checking link' : 'Link required'}
            description={
                pending
                    ? 'Checking the link you opened. This only takes a moment.'
                    : 'This step needs a valid verification link from your inbox.'
            }
            footer={
                !pending && (
                    <Link
                        to={purpose === 'register' ? '/register' : '/recover'}
                        className="text-link"
                    >
                        Request a new verification link
                    </Link>
                )
            }
        >
            <FormTable>
                {error ? (
                    <FormNote tone="destructive">{error}</FormNote>
                ) : (
                    <FormNote>
                        <span className="flex items-center gap-3">
                            {pending && <Spinner />}
                            {pending
                                ? 'Please keep this tab open.'
                                : 'Links expire after 30 minutes and can only be used once.'}
                        </span>
                    </FormNote>
                )}
            </FormTable>
        </AuthLayout>
    );
}
