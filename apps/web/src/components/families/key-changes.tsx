import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Spinner } from '@/components/motion';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { toast } from '@/components/ui/toast';
import { useFamilyWork } from '@/lib/family-work';
import { afterFamilyChange, familyContext } from '@/lib/families';
import { errorCopy, outcomeCopy } from '@/lib/groups/copy';
import { replaceKeys } from '@/lib/groups/removal';
import type { AreaState } from '@/lib/groups/sync';
import { cue } from '@/lib/sounds';
import { useFamilyWalks } from '@/lib/spaces';

/*
 * Key changes on the family page (1c step 7): how far the walk of each family
 * folder has got after a removal, a departure or Replace keys (the walk runs
 * in the background on a manager's device and resumes on the next open), and
 * Replace keys itself, under Technical details for those who manage the
 * family. Folder names are sealed in their top folders; one that did not open
 * here is "A family folder".
 */

export function KeyChangeNotice({
    groupId,
    family,
    areas,
}: {
    groupId: string;
    family: string;
    areas: readonly AreaState[];
}) {
    const walks = useFamilyWalks(groupId);
    const work = useFamilyWork(groupId);
    const nameOf = (workspaceId: string) =>
        areas.find((area) => area.workspaceId === workspaceId)?.name ?? 'A family folder';
    const running = areas.filter((area) => area.view.rotation !== null);
    const failed = walks.filter((walk) => walk.error !== null);
    const done = walks.reduce((sum, walk) => sum + walk.done, 0);
    return (
        <>
            {running.length > 0 && (
                <Alert variant="info" data-key-change="walking">
                    <AlertTitle>Replacing keys in the family folders</AlertTitle>
                    <AlertDescription>
                        {running.length === 1
                            ? `${nameOf(running[0]!.workspaceId)} is getting new keys.`
                            : `${running.length} folders are getting new keys.`}{' '}
                        {done > 0 ? `${done} ${done === 1 ? 'item' : 'items'} done so far. ` : ''}
                        Everything stays readable meanwhile; an upload to a folder waits until its
                        new keys reach it.
                    </AlertDescription>
                </Alert>
            )}
            {failed.map((walk) => (
                <Alert key={walk.workspaceId} variant="warning" data-key-change="stopped">
                    <AlertTitle>Replacing keys in {nameOf(walk.workspaceId)} stopped</AlertTitle>
                    <AlertDescription>
                        {walk.error} {retryWords(walk.retry, family)}
                    </AlertDescription>
                </Alert>
            ))}
            {work.error && (
                <Alert variant="warning" data-family-work="stopped">
                    <AlertTitle>HushOS couldn’t finish an earlier change to {family}</AlertTitle>
                    <AlertDescription>
                        {work.error} It tries again the next time it checks the family.
                    </AlertDescription>
                </Alert>
            )}
        </>
    );
}

/* When a stopped walk is tried again, as this tab has it lined up (lib/spaces.ts FamilyWalk). */
function retryWords(retry: number | 'online' | null, family: string) {
    if (retry === 'online') return 'HushOS tries again once this device is back online.';
    if (retry === null) return `HushOS tries again the next time it checks ${family}.`;
    const at = new Date(retry).toLocaleTimeString(undefined, {
        hour: 'numeric',
        minute: '2-digit',
    });
    return `HushOS tries again by itself at ${at}, while it’s open here.`;
}

/* Technical details: each family folder's key version, and Replace keys for managers. */
export function FolderKeys({
    userId,
    groupId,
    family,
    areas,
    manager,
}: {
    userId: string;
    groupId: string;
    family: string;
    areas: readonly AreaState[];
    manager: boolean;
}) {
    const queryClient = useQueryClient();
    const [busy, setBusy] = useState<string | null>(null);

    async function replace(area: AreaState) {
        const name = area.name ?? 'the family folder';
        setBusy(area.workspaceId);
        try {
            const staged = await replaceKeys(familyContext(userId), groupId, area.workspaceId);
            const failed =
                staged.status === 'sent'
                    ? outcomeCopy(staged.outcome, { family })
                    : `Couldn’t check ${family}. Try again.`;
            if (failed) throw new Error(failed);
            cue('success');
            toast.add({
                type: 'success',
                title: `Replacing the keys of “${name}”`,
                description: 'Everything in it gets the new keys in the background.',
            });
        } catch (cause) {
            cue('error');
            toast.add({
                type: 'error',
                title: 'Couldn’t replace the keys',
                description: errorCopy(cause, { family }),
            });
        } finally {
            setBusy(null);
            void afterFamilyChange(queryClient, userId);
        }
    }

    if (areas.length === 0) return null;
    return (
        <ul className="mt-3 flex flex-col gap-2" aria-label="Family folder keys">
            {areas.map((area) => (
                <li
                    key={area.workspaceId}
                    data-folder-keys={area.name ?? area.workspaceId}
                    className="flex items-center gap-3"
                >
                    <span className="min-w-0 flex-1">
                        <span className="block truncate font-medium">
                            {area.name ?? 'A family folder'}
                        </span>
                        <span className="block text-muted-foreground tabular-nums">
                            Key version {area.view.workspaceKeyVersion}
                            {area.view.rotation ? ' · Finishing a key change…' : ''}
                        </span>
                    </span>
                    {manager && (
                        <Button
                            variant="outline"
                            disabled={busy !== null || area.view.rotation !== null || !area.opened}
                            onClick={() => void replace(area)}
                        >
                            {busy === area.workspaceId && <Spinner className="size-4" />}
                            Replace keys
                        </Button>
                    )}
                </li>
            ))}
        </ul>
    );
}
