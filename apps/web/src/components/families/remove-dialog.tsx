import { useQueryClient } from '@tanstack/react-query';
import { CheckIcon } from 'lucide-react';
import { useState } from 'react';
import { Spinner } from '@/components/motion';
import {
    AlertDialog,
    AlertDialogCancel,
    AlertDialogContent,
    AlertDialogDescription,
    AlertDialogFooter,
    AlertDialogHeader,
    AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from '@/components/ui/dialog';
import { cue } from '@/lib/sounds';
import { afterFamilyChange, familyContext, firstName, type FamilyMember } from '@/lib/families';
import { errorCopy } from '@/lib/groups/copy';
import { removeMember, type RemovalOutcome, type RemovalStep } from '@/lib/groups/removal';
// Loads the family folders' clients, which build a removal's rotations and walk them.
import '@/lib/spaces';

/*
 * "Remove from family" (1c step 7): asked once, then a sheet that shows the
 * removal going hold, finish, remove (lib/groups/removal.ts). The walk of
 * each family folder that follows runs in the background, and the family
 * page says how far it got. When someone paused this manager's changes, it
 * says so plainly; when that someone is the person being removed (they manage
 * the family too), it offers the way out: stop them managing first, then
 * remove them.
 */

type Phase =
    | { kind: 'confirm' }
    | { kind: 'running'; step: RemovalStep; demote: boolean }
    | { kind: 'done'; outcome: RemovalOutcome; demoted: boolean }
    | { kind: 'error'; message: string };

const STEPS: { step: RemovalStep; label: (who: string) => string }[] = [
    { step: 'demote', label: (who) => `Stopping ${who} managing the family` },
    { step: 'hold', label: (who) => `Pausing ${who}’s changes` },
    { step: 'finish', label: () => 'Finishing an earlier key change' },
    { step: 'remove', label: (who) => `Removing ${who}` },
];

export function RemoveDialog({
    userId,
    groupId,
    family,
    member,
    names = {},
    onClose,
}: {
    userId: string;
    groupId: string;
    family: string;
    member: FamilyMember;
    /* First names by user id, as route 3 gives them: who paused this manager, when it says. */
    names?: Record<string, string>;
    onClose: () => void;
}) {
    const queryClient = useQueryClient();
    const who = firstName(member.name);
    const [phase, setPhase] = useState<Phase>({ kind: 'confirm' });
    const busy = phase.kind === 'running';

    async function run(demote: boolean) {
        setPhase({ kind: 'running', step: demote ? 'demote' : 'hold', demote });
        try {
            const outcome = await removeMember(familyContext(userId), groupId, member.userId, {
                family,
                demoteFirst: demote,
                onStep: (step) => setPhase({ kind: 'running', step, demote }),
            });
            cue(outcome.status === 'removed' ? 'success' : 'error');
            setPhase({ kind: 'done', outcome, demoted: demote });
        } catch (cause) {
            cue('error');
            setPhase({ kind: 'error', message: errorCopy(cause, { family, person: who }) });
        } finally {
            void afterFamilyChange(queryClient, userId);
        }
    }

    if (phase.kind === 'confirm')
        return (
            <AlertDialog open onOpenChange={(open) => !open && onClose()}>
                <AlertDialogContent>
                    <AlertDialogHeader>
                        <AlertDialogTitle>
                            Remove {who} from {family}?
                        </AlertDialogTitle>
                        <AlertDialogDescription>
                            {who} loses the family folders straight away. HushOS replaces their
                            keys, which can take a few minutes.
                        </AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                        <AlertDialogCancel>Cancel</AlertDialogCancel>
                        <Button variant="destructive" onClick={() => void run(false)}>
                            Remove from family
                        </Button>
                    </AlertDialogFooter>
                </AlertDialogContent>
            </AlertDialog>
        );

    const steps = STEPS.filter(
        (entry) =>
            entry.step !== 'demote' ||
            (phase.kind === 'running' && phase.demote) ||
            (phase.kind === 'done' && phase.demoted),
    );
    const at = phase.kind === 'running' ? steps.findIndex((s) => s.step === phase.step) : -1;
    const removed = phase.kind === 'done' && phase.outcome.status === 'removed';
    return (
        <Dialog open onOpenChange={(open) => !open && !busy && onClose()}>
            <DialogContent className="sm:max-w-[480px]" data-removal={phase.kind}>
                <DialogHeader>
                    <DialogTitle>Remove {who}</DialogTitle>
                    <DialogDescription>
                        {who} loses the family folders straight away. HushOS replaces their keys,
                        which can take a few minutes.
                    </DialogDescription>
                </DialogHeader>
                <ol className="flex flex-col gap-2 text-[15px]" aria-label="Progress">
                    {steps.map((entry, index) => {
                        const finished = removed || (at >= 0 && index < at);
                        const current = index === at;
                        return (
                            <li
                                key={entry.step}
                                data-step={entry.step}
                                data-state={finished ? 'done' : current ? 'current' : 'waiting'}
                                className="flex items-center gap-2"
                            >
                                <span className="flex size-5 items-center justify-center">
                                    {finished ? (
                                        <CheckIcon className="size-4 text-primary" aria-hidden />
                                    ) : current ? (
                                        <Spinner className="size-4 text-muted-foreground" />
                                    ) : (
                                        <span className="size-1.5 rounded-full bg-muted-foreground/40" />
                                    )}
                                </span>
                                <span
                                    className={current || finished ? '' : 'text-muted-foreground'}
                                >
                                    {entry.label(who)}
                                </span>
                            </li>
                        );
                    })}
                </ol>
                {phase.kind === 'done' && (
                    <Outcome
                        outcome={phase.outcome}
                        who={who}
                        family={family}
                        targetId={member.userId}
                        names={names}
                        onDemote={() => void run(true)}
                    />
                )}
                {phase.kind === 'error' && (
                    <p role="alert" className="text-sm text-destructive">
                        {phase.message}
                    </p>
                )}
                <DialogFooter>
                    {phase.kind === 'error' && (
                        <Button variant="outline" onClick={() => void run(false)}>
                            Try again
                        </Button>
                    )}
                    <Button
                        variant={removed ? 'default' : 'outline'}
                        disabled={busy}
                        onClick={onClose}
                    >
                        {busy ? (
                            <>
                                <Spinner className="size-4" />
                                Remove
                            </>
                        ) : removed ? (
                            'Done'
                        ) : (
                            'Close'
                        )}
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}

function Outcome({
    outcome,
    who,
    family,
    targetId,
    names,
    onDemote,
}: {
    outcome: RemovalOutcome;
    who: string;
    family: string;
    targetId: string;
    names: Record<string, string>;
    onDemote: () => void;
}) {
    switch (outcome.status) {
        case 'removed':
            return (
                <p className="text-sm" data-outcome="removed">
                    {who} is no longer in {family}. HushOS is replacing the family folders’ keys in
                    the background; you can close this.
                </p>
            );
        case 'held': {
            const by = outcome.heldBy;
            // Named only as route 3 names them; nobody is blamed on a guess.
            const holder = by && by !== targetId ? (names[by] ?? null) : null;
            if (by !== targetId || !outcome.targetManages)
                return (
                    <p className="text-sm" data-outcome="held">
                        {holder
                            ? `${holder} paused your changes in ${family} for now, so ${who} wasn’t removed. Try again later, or ask ${holder}.`
                            : `Your changes in ${family} are paused for now, so ${who} wasn’t removed. Try again later, or ask the family’s other managers.`}
                    </p>
                );
            return (
                <div className="flex flex-col gap-3 text-sm" data-outcome="held">
                    <p>
                        {who} manages {family} too and paused your changes, so you can’t remove them
                        yet. Stop them managing the family first: that ends their pause, then HushOS
                        removes them.
                    </p>
                    <div>
                        <Button variant="destructive-outline" onClick={onDemote}>
                            Stop managing, then remove
                        </Button>
                    </div>
                </div>
            );
        }
        case 'changed':
            return (
                <p className="text-sm" data-outcome="changed">
                    {who} isn’t in {family} any more, so there was nothing to remove.
                </p>
            );
        case 'pending':
            return (
                <p className="text-sm" data-outcome="pending">
                    {outcome.message}
                </p>
            );
        case 'wiped':
            return (
                <p className="text-sm" data-outcome="wiped">
                    You’re not in {family} any more.
                </p>
            );
        case 'failed':
            return (
                <p role="alert" className="text-sm text-destructive" data-outcome="failed">
                    {outcome.message}
                </p>
            );
    }
}
