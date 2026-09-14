import type { SessionUser } from '@hushos/auth/protocol';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { useStore } from 'zustand';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
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

export function DriveShell({ user, children }: { user: SessionUser; children: ReactNode }) {
    const unlockedUser = useStore(authClient.store, (state) => state.unlockedUserId);
    const restoring = useStore(authClient.store, (state) => state.restoring);
    const restoreStep = useStore(authClient.store, (state) => state.restoreStep);
    const unlocked = unlockedUser === user.id;
    // Saved device access is tried before anything is called locked, so a refresh
    // shows "opening" and then the folder, never a flash of the unlock form.
    const [attempted, setAttempted] = useState(false);
    useEffect(() => {
        let active = true;
        void authClient
            .restore(user, { validated: true })
            .catch(() => {})
            .finally(() => {
                if (active) setAttempted(true);
            });
        return () => {
            active = false;
        };
    }, [user]);
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
    }, [workspaceId, queryClient]);

    if (!unlocked) {
        if (restoring || !attempted)
            return (
                <Waiting
                    description="Restoring your keys on this device."
                    slow={RESTORE_STEPS[restoreStep ?? 'rehydrate']}
                />
            );
        return (
            <Centered>
                <p className="eyebrow mb-3 text-muted-foreground">Locked</p>
                <h1 className="text-2xl font-medium tracking-tight">Unlock this device</h1>
                <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
                    Your files are encrypted with keys only you hold. Enter your password to open
                    them here.
                </p>
                <UnlockDevice user={user} className="mt-6 w-full border bg-card text-left" />
            </Centered>
        );
    }
    if (opened.isPending) return <Waiting description="Unwrapping your folder keys." />;
    if (opened.isError)
        return (
            <Centered>
                <Alert variant="destructive" className="text-left">
                    <AlertTitle>Drive could not open</AlertTitle>
                    <AlertDescription>{driveError(opened.error)}</AlertDescription>
                </Alert>
                <Button variant="outline" className="mt-4" onClick={() => void opened.refetch()}>
                    Try again
                </Button>
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
            <div className="flex w-full max-w-md flex-col items-center text-center">{children}</div>
        </div>
    );
}

/* What each restore step is waiting on, in the words shown when it takes long. */
const RESTORE_STEPS = {
    rehydrate: 'Still reading saved settings on this device.',
    session: 'Still checking your session with the server.',
    'device-key': 'Still reading the saved device key from this browser’s storage.',
    worker: 'Still unwrapping your account key.',
} as const;

/*
 * The waiting state names its step once it has taken longer than it should,
 * so a person stuck here can say what it was doing.
 */
function Waiting({ description, slow }: { description: string; slow?: string }) {
    const [late, setLate] = useState(false);
    useEffect(() => {
        if (!slow) return;
        const timer = setTimeout(() => setLate(true), 4_000);
        return () => clearTimeout(timer);
    }, [slow]);
    return (
        <Centered>
            <Spinner className="size-4 text-muted-foreground" />
            <p className="mt-4 font-mono text-xs text-muted-foreground">{description}</p>
            {late && slow && (
                <p className="mt-2 max-w-sm font-mono text-xs text-muted-foreground">{slow}</p>
            )}
        </Centered>
    );
}
