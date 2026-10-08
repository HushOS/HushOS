import type { SessionUser } from '@hushos/auth/protocol';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { useStore } from 'zustand';
import { LockKeyholeIcon } from 'lucide-react';
import { useRouter } from '@tanstack/react-router';
import { forgetSession } from '@/lib/session';
import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/motion';
import { UnlockDevice } from '@/components/unlock-device';
import { authClient } from '@/lib/auth-client';
import { driveClient, driveError, driveKeys, driveOpenQueryOptions } from '@/lib/drive';
import { useChangeFeed } from '@/lib/feed';
import { resumePendingRotation } from '@/lib/rotation';
import { prepareDownloads } from '@/lib/downloads';
import { forgetPreviews } from '@/lib/previews';
import { forgetThumbnails } from '@/lib/thumbnails';
import { restoreTransfers } from '@/lib/transfers';

/*
 * Every Drive page needs the account key unlocked on this device and
 * the workspace key opened in the worker. This gate does both, once, and hands
 * the root down; the pages inside never think about keys. Its own states sit in
 * the middle of the page, where an empty folder would be.
 */

export type DriveContextValue = { userId: string; workspaceId: string; rootId: string };
const DriveContext = createContext<DriveContextValue | null>(null);

export function useDrive() {
    const value = useContext(DriveContext);
    if (!value) throw new Error('useDrive must be used inside DriveShell.');
    return value;
}

/*
 * What Drive keeps running while the app is open, mounted once in the app
 * layout rather than in every page: the change feed, the transfer journal,
 * an unfinished rotation, the catalogue build, and the lock that empties them.
 * Pages come and go beneath it without starting any of that again.
 */
export function DriveRuntime({ user }: { user: SessionUser }) {
    const unlockedUser = useStore(authClient.store, (state) => state.unlockedUserId);
    const unlocked = unlockedUser === user.id;
    // A lock wipes every key in the worker. Forget the open workspace and the cached
    // listings with it, so unlocking unwraps everything again instead of trusting
    // names that were decrypted under keys the worker no longer holds.
    const queryClient = useQueryClient();
    const wasUnlocked = useRef(false);
    useEffect(() => {
        if (unlocked) {
            wasUnlocked.current = true;
            return;
        }
        if (!wasUnlocked.current) return;
        driveClient.close();
        forgetThumbnails();
        forgetPreviews();
        void queryClient.resetQueries({ queryKey: driveKeys.all });
    }, [unlocked, queryClient]);
    const opened = useQuery({ ...driveOpenQueryOptions(user.id), enabled: unlocked });
    const workspaceId = opened.data?.workspaceId;
    useChangeFeed(workspaceId ?? null, opened.data?.changeSeq ?? 0);
    useEffect(() => {
        if (!workspaceId) return;
        void restoreTransfers(workspaceId);
        prepareDownloads();
        resumePendingRotation(queryClient);
        // The catalogue: the tree mirrored on this device and opened, resumed from wherever it stopped.
        void driveClient.buildCatalogue(workspaceId);
        // Shares sealed before a contact had a post-quantum key are re-sealed once they do.
        void driveClient.upgradeShares().catch(() => {});
    }, [workspaceId, queryClient]);
    return null;
}

export function DriveShell({ user, children }: { user: SessionUser; children: ReactNode }) {
    const unlockedUser = useStore(authClient.store, (state) => state.unlockedUserId);
    const restoring = useStore(authClient.store, (state) => state.restoring);
    const unlocked = unlockedUser === user.id;
    const lockRevision = useStore(authClient.store, (state) => state.lockRevision);
    // Saved device access is tried before anything is called locked, so a refresh
    // shows "opening" and then the folder, never a flash of the unlock form. A
    // query, so the attempt is made once per account, credential and lock, and
    // its settling is the flag, not a state of this component's own.
    const restored = useQuery({
        queryKey: ['auth', 'restore', user.id, user.credentialVersion, lockRevision],
        queryFn: () =>
            authClient.restore(user, { validated: true }).then(
                () => true,
                () => false,
            ),
        staleTime: Infinity,
        retry: false,
    });
    const attempted = restored.isFetched;
    // The same query the runtime holds open: no second request, no second open.
    const opened = useQuery({ ...driveOpenQueryOptions(user.id), enabled: unlocked });
    const router = useRouter();
    async function signOut() {
        try {
            await authClient.logout();
        } finally {
            forgetSession(router.options.context.queryClient, false);
            await router.navigate({ to: '/login' });
            router.options.context.queryClient.clear();
        }
    }

    if (!unlocked) {
        if (restoring || !attempted) return <Opening />;
        return (
            <Centered>
                <span className="flex size-12 items-center justify-center rounded-full bg-accent text-accent-foreground">
                    <LockKeyholeIcon className="size-5" aria-hidden="true" />
                </span>
                <h1 className="mt-5 text-[26px] leading-tight font-extrabold tracking-[-0.03em]">
                    HushOS is locked here
                </h1>
                <p className="mt-1.5 text-[15px] text-muted-foreground">
                    Enter your password to open your files on this browser.
                </p>
                <UnlockDevice user={user} className="mt-5 w-full" />
            </Centered>
        );
    }
    if (opened.isPending) return <Opening />;
    if (opened.isError)
        return (
            <Centered>
                <h1 className="text-[26px] leading-tight font-extrabold tracking-[-0.03em]">
                    Your files didn’t open
                </h1>
                <p className="mt-1.5 text-[15px] text-muted-foreground">
                    {driveError(opened.error)}
                </p>
                <div className="mt-5 flex gap-2">
                    <Button onClick={() => void opened.refetch()}>Try again</Button>
                    <Button variant="ghost" onClick={() => void signOut()}>
                        Sign out
                    </Button>
                </div>
            </Centered>
        );
    return (
        <DriveContext.Provider
            value={{
                userId: user.id,
                workspaceId: opened.data.workspaceId,
                rootId: opened.data.root.id,
            }}
        >
            {children}
        </DriveContext.Provider>
    );
}

function Centered({ children }: { children: ReactNode }) {
    return (
        <div className="flex flex-1 items-center justify-center px-5 py-16 sm:px-8">
            <div className="flex w-full max-w-[380px] flex-col items-start">{children}</div>
        </div>
    );
}

/*
 * One line while the account and the files open, and after a few seconds a
 * second that says it is still going. Which step is slow is not something a
 * person can act on, so it is not named.
 */
function Opening() {
    const [late, setLate] = useState(false);
    useEffect(() => {
        const timer = setTimeout(() => setLate(true), 4_000);
        return () => clearTimeout(timer);
    }, []);
    return (
        <div className="flex flex-1 items-center justify-center px-5 py-16 sm:px-8">
            <output className="flex flex-col items-center gap-2 text-center">
                <Spinner className="size-5 text-primary" />
                <span className="text-base font-semibold">Opening your files…</span>
                <span className="h-5 text-sm text-muted-foreground">
                    {late ? 'Still opening. This can take a moment on a slow connection.' : ''}
                </span>
            </output>
        </div>
    );
}
