import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import {
    AlertDialog,
    AlertDialogCancel,
    AlertDialogContent,
    AlertDialogDescription,
    AlertDialogFooter,
    AlertDialogHeader,
    AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Spinner } from '@/components/motion';
import { Button } from '@/components/ui/button';
import { toast } from '@/components/ui/toast';
import { afterFamilyChange } from '@/lib/families';
import { errorCopy, outcomeCopy } from '@/lib/groups/copy';
import { deleteFamilyFolder } from '@/lib/spaces';
import { cue } from '@/lib/sounds';

/*
 * "Delete family folder", for those who manage the family (groups design
 * 2.10): the folder's tombstone on the member list, sent at once. It is gone
 * for everyone straight away, and the server deletes its files after 30 days.
 * Deleting destroys no key: whoever kept copies or keys keeps them, as after
 * a removal, and the copy says so.
 */
export function DeleteFamilyFolderDialog({
    userId,
    groupId,
    family,
    folder,
    onOpenChange,
    onDeleted,
}: {
    userId: string;
    groupId: string;
    family: string;
    folder: { workspaceId: string; name: string } | null;
    onOpenChange: (open: boolean) => void;
    onDeleted: () => void;
}) {
    const queryClient = useQueryClient();
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState('');

    async function remove() {
        if (!folder) return;
        setBusy(true);
        setError('');
        try {
            const staged = await deleteFamilyFolder(userId, groupId, folder.workspaceId);
            const failed =
                staged.status === 'sent'
                    ? outcomeCopy(staged.outcome, { family })
                    : staged.status === 'not-synced'
                      ? staged.sync.status === 'fork'
                          ? `${family}’s member list was shown differently to you.`
                          : `Couldn’t check ${family}. Try again.`
                      : 'Couldn’t delete the folder. Try again.';
            if (failed) throw new Error(failed);
            cue('success');
            toast.add({
                type: 'success',
                title: `“${folder.name}” is deleted`,
                description: 'Its files are deleted from the server after 30 days.',
            });
            onOpenChange(false);
            onDeleted();
        } catch (cause) {
            cue('error');
            setError(errorCopy(cause, { family }));
        } finally {
            setBusy(false);
            await afterFamilyChange(queryClient, userId);
        }
    }

    return (
        <AlertDialog
            open={folder !== null}
            onOpenChange={(next) => {
                if (busy) return;
                if (!next) setError('');
                onOpenChange(next);
            }}
        >
            <AlertDialogContent>
                <AlertDialogHeader>
                    <AlertDialogTitle>Delete “{folder?.name}”?</AlertDialogTitle>
                    <AlertDialogDescription>
                        It disappears for everyone in {family} now. Its files are deleted from the
                        server after 30 days. Anyone who kept copies or keys keeps them, as after
                        someone is removed. The folder can’t be restored.
                    </AlertDialogDescription>
                </AlertDialogHeader>
                {error && (
                    <p role="alert" className="text-sm text-destructive">
                        {error}
                    </p>
                )}
                <AlertDialogFooter>
                    <AlertDialogCancel disabled={busy}>Cancel</AlertDialogCancel>
                    <Button variant="destructive" disabled={busy} onClick={() => void remove()}>
                        {busy && <Spinner className="size-4" />}
                        Delete
                    </Button>
                </AlertDialogFooter>
            </AlertDialogContent>
        </AlertDialog>
    );
}
