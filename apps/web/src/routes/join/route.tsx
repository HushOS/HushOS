import { useQuery, useQueryClient } from '@tanstack/react-query';
import { createFileRoute, Link, useRouter } from '@tanstack/react-router';
import { useEffect, useState, useSyncExternalStore } from 'react';
import { AuthActions, AuthLayout, AuthNote, authLink } from '@/components/auth-layout';
import { Spinner } from '@/components/motion';
import { Button, buttonVariants } from '@/components/ui/button';
import { familyKeys } from '@/lib/families-shell';
import {
    billingQueryOptions,
    formatSpace,
    storageQueryOptions,
    useBillingEnabled,
} from '@/lib/queries';
import { personalPlanEnding } from '@/lib/plans';
import { GroupApiError, groupsApi } from '@/lib/groups/api';
import { errorCopy, familyField, joinInFamilyCopy } from '@/lib/groups/copy';
import { rememberReturn } from '@/lib/return-to';
import { forgetSession, sessionQueryOptions } from '@/lib/session';
import { signOut } from '@/lib/sign-out';
import { cue } from '@/lib/sounds';

export const Route = createFileRoute('/join')({
    headers: () => ({
        'Cache-Control': 'private, no-store',
        Vary: 'Cookie',
        'Referrer-Policy': 'no-referrer',
    }),
    head: () => ({
        meta: [
            { title: 'Join a family · HushOS' },
            { name: 'robots', content: 'noindex' },
            { name: 'referrer', content: 'no-referrer' },
        ],
    }),
    component: JoinPage,
});

/*
 * The mailed invitation, `/join#invite=<token>`. The token rides after the
 * `#`, so it never reaches a server log; this page keeps it in the tab
 * (sessionStorage) and takes it out of the address. Someone signed out signs
 * in or signs up and comes back here, token and all: that return is kept in
 * localStorage for up to an hour (lib/return-to), so it survives the sign-up
 * email opening in a new tab. That outlives the tab, the same trade-off a
 * shared link's key makes, and it is used once. Signed in, the invitation is
 * opened (route 14) and accepted (route 15), which leads to the join screen.
 * The tab's copy goes once the invitation is accepted, turns out used up, is
 * for another address, or the person switches account. Accepting lets nobody
 * in: the words and the join code come next. Someone already in a family
 * (one per account) is told to leave theirs first, and can't accept; the
 * invitation stays open, so they come back to the same link.
 */

const KEPT = 'hushos.invite';

const fromHash = () => /(?:^#|&)invite=([A-Za-z0-9_-]+)/.exec(window.location.hash)?.[1] ?? null;

/* The token from the address, or the one this tab kept: read only, so it can be a snapshot. */
function readToken() {
    const inHash = fromHash();
    if (inHash) return inHash;
    try {
        return window.sessionStorage.getItem(KEPT);
    } catch {
        return null;
    }
}

/* Keeps the token in this tab and takes it out of the address bar and history. */
function keepToken() {
    const inHash = fromHash();
    if (!inHash) return;
    try {
        window.sessionStorage.setItem(KEPT, inHash);
        window.history.replaceState(
            window.history.state,
            '',
            window.location.pathname + window.location.search,
        );
    } catch {
        /* No storage: the token stays in the address, where it was. */
    }
}

const subscribe = (onChange: () => void) => {
    window.addEventListener('hashchange', onChange);
    return () => window.removeEventListener('hashchange', onChange);
};

function forgetToken() {
    try {
        window.sessionStorage.removeItem(KEPT);
    } catch {
        /* Nothing kept. */
    }
}

function JoinPage() {
    // Read on the client only: the server never sees the fragment and renders the spinner.
    const token = useSyncExternalStore(subscribe, readToken, () => undefined);
    useEffect(keepToken, [token]);
    const session = useQuery(sessionQueryOptions);

    if (token === undefined || session.isPending)
        return (
            <AuthLayout title="Opening your invitation" art="JOIN">
                <Spinner className="size-5 text-primary" />
            </AuthLayout>
        );
    if (!token)
        return (
            <AuthLayout
                title="This invitation link is incomplete"
                description="Open the link from the invitation email again. If it still doesn’t work, ask for a new invitation."
                art="JOIN"
            />
        );
    const back = () => rememberReturn(`/join#invite=${token}`);
    if (!session.data)
        return (
            <AuthLayout
                title="You’re invited to a family"
                description="Sign in, or create a HushOS account, with the email address the invitation was sent to."
                art="JOIN"
            >
                <AuthActions
                    action={
                        <Link to="/login" onClick={back} className={buttonVariants()}>
                            Sign in
                        </Link>
                    }
                >
                    <span>
                        New to HushOS?{' '}
                        <Link to="/register" onClick={back} className={authLink}>
                            Create an account
                        </Link>
                    </span>
                </AuthActions>
            </AuthLayout>
        );
    // Keyed by the token: another invitation opened in this tab starts afresh, not at the last one's error.
    return <OpenInvitation key={token} token={token} email={session.data.email} onSignOut={back} />;
}

function OpenInvitation({
    token,
    email,
    onSignOut,
}: {
    token: string;
    email: string;
    onSignOut: () => void;
}) {
    const router = useRouter();
    const queryClient = useQueryClient();
    const [accepting, setAccepting] = useState(false);
    const [error, setError] = useState<unknown>(null);
    // Where plans are sold, a newcomer's own files draw from the family's storage once they're
    // let in, and a personal plan they pay for ends then (docs/families-shared-pool.md 3.2,
    // 3.3): said before they accept, with their own figure. Their own figures only: they are in
    // no family yet, so the server's are theirs.
    const billing = useBillingEnabled();
    const storage = useQuery({ ...storageQueryOptions, enabled: billing });
    const personal = useQuery({ ...billingQueryOptions, enabled: billing });
    const opened = useQuery({
        queryKey: ['invitations', 'open', token, email],
        queryFn: () =>
            groupsApi.openInvitation(token).catch((cause: unknown) => {
                // Used, cancelled or expired: nothing to come back to.
                if (cause instanceof GroupApiError && cause.code === 'gone') forgetToken();
                throw cause;
            }),
        staleTime: Infinity,
        retry: false,
    });

    async function accept() {
        setAccepting(true);
        setError(null);
        try {
            const { groupId } = await groupsApi.acceptInvitation(token);
            forgetToken();
            cue('success');
            await queryClient.invalidateQueries({ queryKey: familyKeys.all });
            await router.navigate({
                to: '/app/families/$groupId/join',
                params: { groupId },
                replace: true,
            });
        } catch (cause) {
            cue('error');
            setError(cause);
            // Final for this account: used up, someone else's address, or already a member.
            if (
                cause instanceof GroupApiError &&
                (cause.code === 'gone' ||
                    cause.code === 'email-mismatch' ||
                    cause.code === 'already-member')
            )
                forgetToken();
        } finally {
            setAccepting(false);
        }
    }

    async function switchAccount() {
        // The return saved after sign-out carries the token; the tab's own copy goes.
        forgetToken();
        try {
            await signOut();
        } finally {
            forgetSession(router.options.context.queryClient, false);
            // After sign-out, which drops any saved return: back here once signed in again.
            onSignOut();
            await router.navigate({ to: '/login' });
            router.options.context.queryClient.clear();
        }
    }

    const signedInAs = (
        <span>
            Signed in as {email}.{' '}
            <button type="button" className={authLink} onClick={() => void switchAccount()}>
                Use another account
            </button>
        </span>
    );

    if (opened.isPending)
        return (
            <AuthLayout title="Opening your invitation" art="JOIN">
                <Spinner className="size-5 text-primary" />
            </AuthLayout>
        );
    if (opened.isError) {
        const gone = opened.error instanceof GroupApiError && opened.error.code === 'gone';
        // Sent to another address: the server says nothing more, and neither does the page.
        if (opened.error instanceof GroupApiError && opened.error.code === 'email-mismatch')
            return (
                <AuthLayout
                    title="This invitation is for someone else"
                    description="It was sent to another email address. Sign in with that address to open it."
                    art="JOIN"
                    footer={signedInAs}
                />
            );
        return (
            <AuthLayout
                title={gone ? 'This invitation is no longer open' : 'This invitation didn’t open'}
                description={
                    gone
                        ? 'It was used, cancelled, or it ran out. Ask the person who invited you for a new one.'
                        : errorCopy(opened.error)
                }
                art="JOIN"
                footer={signedInAs}
            >
                {!gone && (
                    <Button variant="outline" onClick={() => void opened.refetch()}>
                        Try again
                    </Button>
                )}
            </AuthLayout>
        );
    }

    const invitation = opened.data;
    const inviter = invitation.inviter;
    const code = error instanceof GroupApiError ? error.code : null;
    // Theirs as opening the invitation found it, or as accepting did (they joined one meanwhile).
    const yours =
        invitation.inFamily ??
        (code === 'in-family' && error instanceof GroupApiError ? familyField(error.data) : null);
    const ownFiles =
        storage.data && !storage.data.pool ? formatSpace(storage.data.usedBytes) : null;
    const ownPlan = personalPlanEnding(personal.data?.subscription, 'you’re let in');
    const storageLine =
        !ownFiles || code === 'email-mismatch' || code === 'already-member'
            ? null
            : ownPlan
              ? `${ownPlan} From then on your files use ${invitation.name}’s storage. They take ${ownFiles} now.`
              : `Once you’re let in, your files use ${invitation.name}’s storage. They take ${ownFiles} now.`;
    return (
        <AuthLayout
            title={
                inviter
                    ? `${inviter.name} invited you to ${invitation.name}`
                    : `You’re invited to ${invitation.name}`
            }
            description={inviter?.email ? `From ${inviter.email}` : undefined}
            art="JOIN"
            footer={signedInAs}
        >
            {!yours && (
                <p className="text-[15px] leading-relaxed">
                    After you accept, you and {inviter ? inviter.name.split(/\s+/)[0] : 'they'}{' '}
                    check it’s really each other, on a call or in person. Then you’re let in.
                </p>
            )}
            {!yours && storageLine && (
                <p className="text-[15px] leading-relaxed" data-join-storage>
                    {storageLine}
                </p>
            )}
            {yours ? (
                <AuthNote tone="info">
                    {joinInFamilyCopy(yours.name, invitation.name, invitation.expiresAt)}{' '}
                    <Link to="/app/family" className={authLink}>
                        Open {yours.name}
                    </Link>
                </AuthNote>
            ) : error !== null && code === 'already-member' ? (
                <AuthNote tone="info" title="You’re already in this family">
                    <Link to="/app/family" className={authLink}>
                        Open {invitation.name}
                    </Link>
                </AuthNote>
            ) : error !== null ? (
                <AuthNote tone="danger">
                    {code === 'email-mismatch'
                        ? `This invitation is for another email address than ${email}. Sign in with that one.`
                        : errorCopy(error, { family: invitation.name })}
                </AuthNote>
            ) : null}
            <AuthActions
                action={
                    <Button
                        disabled={accepting || code === 'email-mismatch' || yours !== null}
                        onClick={() => void accept()}
                    >
                        {accepting ? 'Accepting…' : 'Accept'}
                    </Button>
                }
            />
        </AuthLayout>
    );
}
