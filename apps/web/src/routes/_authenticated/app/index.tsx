import { useQueryClient } from '@tanstack/react-query';
import { createFileRoute, Link, useRouter } from '@tanstack/react-router';
import { useEffect, useRef, useState } from 'react';
import { usePageRestored } from '@/lib/page-restore';
import { useStore } from 'zustand';
import { ArrowRightIcon, LockKeyholeIcon, LockKeyholeOpenIcon } from 'lucide-react';
import { IconSwap, Spinner, TextSwap } from '@/components/motion';
import { PageHeader } from '@/components/page-header';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { CopyValue } from '@/components/copy-value';
import { Button } from '@/components/ui/button';
import { UnlockDevice } from '@/components/unlock-device';
import { authClient } from '@/lib/auth-client';
import { billingApi } from '@/lib/billing-api';
import { billingQueryOptions, storageQueryOptions } from '@/lib/queries';
import { cue } from '@/lib/sounds';

export const Route = createFileRoute('/_authenticated/app/')({
    head: () => ({ meta: [{ title: 'Overview · HushOS' }] }),
    component: WorkspacePage,
});

function WorkspacePage() {
    const { user } = Route.useRouteContext();
    const router = useRouter();
    const queryClient = useQueryClient();
    const unlockedUser = useStore(authClient.store, (state) => state.unlockedUserId);
    const restoring = useStore(authClient.store, (state) => state.restoring);
    const rememberError = useStore(authClient.store, (state) => state.rememberError);
    const [initialized, setInitialized] = useState(false);
    const [checkingOut, setCheckingOut] = useState(false);
    const [error, setError] = useState('');
    // Back from Polar's checkout: show the app, not "Taking you to checkout…".
    usePageRestored(() => setCheckingOut(false));
    const unlocked = unlockedUser === user.id;
    const opening = !initialized || restoring;
    // Keyed on identity, not the `user` object, so a name change does not rerun setup.
    const latestUser = useRef(user);
    useEffect(() => {
        latestUser.current = user;
    }, [user]);
    useEffect(() => {
        let active = true;
        const current = latestUser.current;
        void authClient
            .restore(current, { validated: true })
            .then(() => authClient.initializeAccount(current))
            .then(async (needsBackup) => {
                if (!active) return;
                if (needsBackup)
                    await router.navigate({ to: '/setup/recovery-key', replace: true });
                await queryClient.invalidateQueries(storageQueryOptions);
                // Signed up from the pricing page: straight on to Polar's checkout for
                // that plan. If the checkout cannot be started, the billing page says why.
                const billing = await queryClient.fetchQuery(billingQueryOptions).catch(() => null);
                if (!active || !billing?.intendedPlan) return;
                setCheckingOut(true);
                try {
                    const { url } = await billingApi.checkout(billing.intendedPlan);
                    if (url) {
                        window.location.assign(url);
                        return;
                    }
                } catch {
                    /* Fall through to the billing page, which retries and shows the error. */
                }
                if (active)
                    await router.navigate({
                        to: '/app/billing',
                        search: { plan: billing.intendedPlan },
                        replace: true,
                    });
            })
            .catch(() => {
                if (active)
                    setError('Account setup could not finish. Please refresh to try again.');
            })
            .finally(() => {
                if (active) setInitialized(true);
            });
        return () => {
            active = false;
        };
    }, [user.id, user.credentialVersion, router, queryClient]);
    function lock() {
        setError('');
        void authClient
            .lock()
            .then(() => cue('droplet'))
            .catch(() => {
                cue('error');
                setError('Could not remove saved device access. Please try signing out.');
            });
    }
    if (checkingOut)
        return (
            <div className="flex flex-col">
                <PageHeader
                    eyebrow="Overview"
                    title={`Welcome, ${user.name}.`}
                    description="Your account is ready. Taking you to checkout for the plan you chose…"
                >
                    <Spinner className="size-4" />
                </PageHeader>
            </div>
        );
    return (
        <div className="flex flex-col">
            <PageHeader
                eyebrow="Overview"
                title={`Welcome, ${user.name}.`}
                description="Your account, your device, and your keys at a glance."
            />
            {(rememberError || error) && (
                <div className="flex flex-col gap-3 border-b px-5 py-5 sm:px-8">
                    {rememberError && (
                        <Alert variant="warning">
                            <AlertTitle>Saved device access needs attention</AlertTitle>
                            <AlertDescription>{rememberError}</AlertDescription>
                        </Alert>
                    )}
                    {error && (
                        <Alert variant="destructive">
                            <AlertDescription>{error}</AlertDescription>
                        </Alert>
                    )}
                </div>
            )}
            <div className="grid border-b lg:grid-cols-2">
                <section
                    aria-labelledby="device-title"
                    className="flex flex-col border-b lg:border-r lg:border-b-0"
                >
                    <div className="flex items-center justify-between gap-4 border-b px-5 py-3.5 sm:px-8">
                        <h2 id="device-title" className="eyebrow flex items-center gap-2.5">
                            <IconSwap id={opening ? 'opening' : unlocked ? 'unlocked' : 'locked'}>
                                {opening ? (
                                    <Spinner className="size-3.5" />
                                ) : unlocked ? (
                                    <LockKeyholeOpenIcon className="size-3.5" aria-hidden="true" />
                                ) : (
                                    <LockKeyholeIcon className="size-3.5" aria-hidden="true" />
                                )}
                            </IconSwap>
                            This device
                        </h2>
                        <Badge
                            variant={unlocked ? 'success' : opening ? 'outline' : 'warning'}
                            aria-live="polite"
                        >
                            <TextSwap>
                                {unlocked ? 'Unlocked' : opening ? 'Opening…' : 'Locked'}
                            </TextSwap>
                        </Badge>
                    </div>
                    {!unlocked && !opening ? (
                        <UnlockDevice
                            user={user}
                            onUnlocked={() => queryClient.invalidateQueries(storageQueryOptions)}
                        />
                    ) : (
                        <>
                            <p className="flex-1 px-5 py-5 text-sm leading-relaxed text-muted-foreground sm:px-8">
                                {unlocked
                                    ? 'Your account key is unlocked here. It stays available across tabs and refreshes until you lock it.'
                                    : 'Restoring saved device access…'}
                            </p>
                            <div className="flex border-t">
                                {unlocked ? (
                                    <Button
                                        variant="row"
                                        size="row"
                                        className="h-12 sm:px-8"
                                        onClick={lock}
                                    >
                                        Lock this device <LockKeyholeIcon aria-hidden="true" />
                                    </Button>
                                ) : (
                                    <span className="eyebrow flex h-12 items-center px-5 text-muted-foreground sm:px-8">
                                        One moment…
                                    </span>
                                )}
                            </div>
                        </>
                    )}
                </section>
                <section aria-labelledby="account-title" className="flex flex-col">
                    <div className="border-b px-5 py-3.5 sm:px-8">
                        <h2 id="account-title" className="eyebrow">
                            Account
                        </h2>
                    </div>
                    <dl className="flex-1 px-5 py-2 font-mono text-[13px] sm:px-8">
                        <div className="flex items-center justify-between gap-6 border-b border-dotted py-2.5">
                            <dt className="eyebrow text-muted-foreground">Name</dt>
                            <dd className="truncate">{user.name}</dd>
                        </div>
                        <div className="flex items-center justify-between gap-6 border-b border-dotted py-2.5">
                            <dt className="eyebrow text-muted-foreground">Email</dt>
                            <dd className="truncate">{user.email}</dd>
                        </div>
                        <div className="flex items-center justify-between gap-6 py-2.5">
                            <dt className="eyebrow text-muted-foreground">Account ID</dt>
                            <dd className="flex min-w-0">
                                <CopyValue value={user.id} label="Account ID" />
                            </dd>
                        </div>
                    </dl>
                    <div className="grid grid-cols-2 border-t">
                        <Button
                            variant="row"
                            size="row"
                            className="h-12 border-r sm:px-8"
                            render={<Link to="/app/account" />}
                            nativeButton={false}
                        >
                            Settings <ArrowRightIcon aria-hidden="true" />
                        </Button>
                        <Button
                            variant="row"
                            size="row"
                            className="h-12 sm:px-8"
                            render={<Link to="/app/recovery-key" />}
                            nativeButton={false}
                        >
                            Recovery phrase <ArrowRightIcon aria-hidden="true" />
                        </Button>
                    </div>
                </section>
            </div>
        </div>
    );
}
