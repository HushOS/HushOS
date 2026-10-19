import type { SessionUser } from '@hushos/auth/protocol';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { LockKeyholeIcon } from 'lucide-react';
import { useRouter } from '@tanstack/react-router';
import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/motion';
import { UnlockDevice } from '@/components/unlock-device';
import { authClient } from '@/lib/auth-client';
import { useAuthView } from '@/lib/auth-view';
import { backfillOwnConsent, bindContactsToQueries } from '@/lib/contacts';
import {
    closeSpaces,
    driveClient,
    driveError,
    driveKeys,
    driveOpenQueryOptions,
} from '@/lib/drive';
import { familiesSyncAllKey } from '@/lib/families-keys';
import { capabilitiesQueryOptions } from '@/lib/families-shell';
import { useChangeFeed } from '@/lib/feed';
import { preloadViewers } from '@/lib/preload';
import { resumePendingRotation } from '@/lib/rotation';
import { prepareDownloads } from '@/lib/downloads';
import { forgetPreviews } from '@/lib/previews';
import { forgetThumbnails } from '@/lib/thumbnails';
import { restoreTransfers } from '@/lib/transfers';
import { leaveApp } from '@/lib/sign-out';
import { cue } from '@/lib/sounds';

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
 * an unfinished rotation, the catalogue build, families' outbox and sync, and
 * the lock that empties them. Pages come and go beneath it without starting
 * any of that again.
 */
export function DriveRuntime({ user }: { user: SessionUser }) {
    const unlockedUser = useAuthView((state) => state.unlockedUserId);
    const unlocked = unlockedUser === user.id;
    // A lock wipes every key in the worker. Forget the open workspace and the cached
    // listings with it, so unlocking unwraps everything again instead of trusting
    // names that were decrypted under keys the worker no longer holds.
    const queryClient = useQueryClient();
    // Pins a share, rotation or open follows behind the scenes reach People at once.
    bindContactsToQueries(queryClient);
    const wasUnlocked = useRef(false);
    useEffect(() => {
        if (unlocked) {
            wasUnlocked.current = true;
            return;
        }
        if (!wasUnlocked.current) return;
        driveClient.close();
        closeSpaces();
        forgetThumbnails();
        forgetPreviews();
        void queryClient.resetQueries({ queryKey: driveKeys.all });
        // The worker forgot every family's chain and folder keys too: each family is checked again.
        void queryClient.resetQueries({ queryKey: ['families'] });
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
        // Shares sealed to a contact's keys before a succession this person followed, or to
        // keys of their own they replaced, are sealed again. Nothing here follows a contact's
        // served keys: only the person's own Check again does.
        void driveClient.upgradeShares().catch(() => {});
        // Consent for this account's own earlier key replacements that went up without it:
        // families check it on the links they follow (docs/groups-server.md 5).
        void backfillOwnConsent(user.id).catch(() => {});
        // Every viewer and grammar, at idle: what is fetched no longer says what was opened.
        preloadViewers();
    }, [workspaceId, queryClient, user.id]);
    // Families, app-wide: what the outbox holds is sent again and every family synced, so a
    // change made on another page (or before a reload) lands, and family folders open checked.
    // Only on a server that serves families, and the families layer loads only then (the
    // capability comes from lib/families-shell, which stays off that layer).
    const capabilities = useQuery({
        ...capabilitiesQueryOptions,
        enabled: workspaceId !== undefined,
    });
    /* Polls in a row that still found a key change walking: each waits longer. */
    const walkPolls = useRef(0);
    useQuery({
        // Account → Family (/app/family) reads the same query for its notices: this pass empties
        // the outbox before any family page syncs, so they would be lost otherwise.
        queryKey: familiesSyncAllKey(user.id),
        // Each pass also does what is due in each family, and walks key changes, in the background.
        queryFn: async () =>
            (await import('@/lib/families')).syncFamilies(user.id, {
                onChanged: () =>
                    void queryClient.invalidateQueries({ queryKey: ['families', user.id] }),
            }),
        enabled: unlocked && workspaceId !== undefined && capabilities.data?.groups === true,
        staleTime: 60_000,
        refetchOnWindowFocus: true,
        // While a key change walks a family folder, checked again every so often: a walk that
        // stopped resumes, and pages see it end.
        refetchInterval: (query) => {
            const results = query.state.data?.results;
            const walking =
                results !== undefined &&
                [...results.values()].some(
                    (result) =>
                        'areas' in result &&
                        result.areas.some((area) => area.view.rotation !== null),
                );
            if (!walking) {
                walkPolls.current = 0;
                return false;
            }
            // Twice as long each time a run is still there, up to ten minutes.
            walkPolls.current++;
            return Math.min(10 * 60_000, 30_000 * 2 ** (walkPolls.current - 1));
        },
        retry: false,
    });
    return null;
}

export function DriveShell({ user, children }: { user: SessionUser; children: ReactNode }) {
    const unlockedUser = useAuthView((state) => state.unlockedUserId);
    const restoring = useAuthView((state) => state.restoring);
    const unlocked = unlockedUser === user.id;
    const lockRevision = useAuthView((state) => state.lockRevision);
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
            await leaveApp(router, { dim: true });
        } catch {
            // Locked here and still signed in: the screen now says so and offers unlock.
            cue('error');
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
