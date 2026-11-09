import { familyContext } from '@/lib/families';
import { runDue } from '@/lib/groups/removal';
import type { SyncResult } from '@/lib/groups/sync';
import { walkPending } from '@/lib/spaces';
import { setFamilyWork } from '@/lib/family-work-state';

export { useFamilyWork, type FamilyWork } from '@/lib/family-work-state';

/*
 * What a family page does on its own after each sync (1c step 7): what route
 * 3 says is due (grants for everyone; for those who manage the family,
 * departures marked left, fold-ins, folders owed new keys, a previous
 * top-folder key to repair), then every key change still walking a folder,
 * in the background. One pass per family at a time; the latest sync that
 * came while one ran starts the next. Loaded with the family pages only.
 */

const passes = new Map<string, Promise<void>>();
/* A sync that came while a pass ran: the next pass starts from it once this one ends. */
const queued = new Map<string, () => void>();

/*
 * After a sync of the family: what is due, then the walks. `onChanged` runs
 * when what was due moved something (a roster landed), so the pages sync again
 * and show it; a walk that ends says so itself (walks.ts familyWalkEndings).
 */
export function startFamilyWork(
    userId: string,
    groupId: string,
    result: SyncResult,
    options: { manager: boolean; onChanged: () => void },
) {
    if (result.status !== 'accepted') return;
    if (passes.has(groupId)) {
        queued.set(groupId, () => startFamilyWork(userId, groupId, result, options));
        return;
    }
    const ctx = familyContext(userId);
    setFamilyWork(groupId, { running: true });
    const pass = (async () => {
        try {
            const report = await runDue(ctx, groupId, {
                manager: options.manager,
                areas: result.areas,
            });
            setFamilyWork(groupId, { error: null, needsCheck: report.needsCheck });
            if (report.done.length > 0) options.onChanged();
        } catch (error) {
            setFamilyWork(groupId, {
                error: error instanceof Error ? error.message : 'Please try again.',
            });
        }
        // Everyone walks what is running (the server lets any member): a walk resumes from the
        // server's state at every sync, one tab per folder.
        walkPending(userId, groupId, result.areas);
    })().finally(() => {
        passes.delete(groupId);
        setFamilyWork(groupId, { running: false });
        const next = queued.get(groupId);
        queued.delete(groupId);
        next?.();
    });
    passes.set(groupId, pass);
}
