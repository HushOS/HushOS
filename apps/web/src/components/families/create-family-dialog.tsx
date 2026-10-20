import type { FamilyPlan } from '@hushos/billing/api';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { useId, useRef, useState, type FormEvent } from 'react';
import { Button } from '@/components/ui/button';
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogHeader,
    DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { toast } from '@/components/ui/toast';
import { groupBillingApi } from '@/lib/billing-api';
import { authError } from '@/lib/form';
import { usePageRestored } from '@/lib/page-restore';
import { familyTierName } from '@/lib/plans';
import { tierTooSmall } from '@/lib/family-billing';
import { formatQuota, storageQueryOptions, useBillingEnabled } from '@/lib/queries';
import {
    afterFamilyChange,
    afterMembershipChange,
    familiesQueryOptions,
    familyContext,
} from '@/lib/families';
import { createInFamilyCopy, errorCopy, outcomeCopy } from '@/lib/groups/copy';
import { createFamily } from '@/lib/groups/outbox';
import { cue } from '@/lib/sounds';

/*
 * "Create a family": one name, then the worker makes the family's keys, its
 * member list with you as organizer and the first shared folder ("Family"),
 * and the outbox sends it. A creation that could not reach the server stays
 * on this device and is sent again on the next visit: said, not hidden.
 * Someone already in a family is told to leave it first, before any keys are
 * made (one family per account); the server refuses it too.
 *
 * From Plans, with a tier chosen (`plan`), the family is made the same way and
 * then goes straight to Polar's checkout for that tier
 * (docs/families-shared-pool.md 7.4). A checkout that can't start leaves the
 * family made, on its page, where Choose a plan offers the tiers again.
 * `personalPlan` says what happens to a personal plan of theirs (personalPlanEnding): it
 * ends when the family's plan starts, and that is said before they go on (3.3).
 */
export function CreateFamilyDialog({
    userId,
    open,
    onOpenChange,
    plan,
    personalPlan,
}: {
    userId: string;
    open: boolean;
    onOpenChange: (open: boolean) => void;
    plan?: { plan: FamilyPlan; currency: string };
    personalPlan?: string | null;
}) {
    const id = useId();
    const queryClient = useQueryClient();
    const navigate = useNavigate();
    // Where plans are sold, a family chooses one before anyone can join (docs/groups-design.md 3.5).
    const billing = useBillingEnabled();
    const [name, setName] = useState('');
    const [pending, setPending] = useState(false);
    const [error, setError] = useState('');
    const yours = useQuery(familiesQueryOptions(userId)).data?.find(
        (at) => at.kind === 'family' && at.state === 'active',
    );
    // A tier smaller than their own files can't be the new family's first plan (the server
    // refuses it at checkout): said, and nothing is made, before the family exists.
    const storage = useQuery({ ...storageQueryOptions, enabled: Boolean(plan) });
    const tooSmall = plan ? tierTooSmall(storage.data, plan.plan) : null;
    // Once submitted, the family being made is about to be "yours": it refuses nothing then.
    const refusal = yours && !pending ? createInFamilyCopy(yours.name) : tooSmall || '';
    // Back from Polar's checkout (the browser's back button restores this page as it was, from
    // before the family existed): the family is made and has no plan yet, so its page, where
    // Choose a plan offers the tiers again, is where this goes on, never a second Create.
    const leftFor = useRef<string | null>(null);
    usePageRestored(() => {
        setPending(false);
        if (!leftFor.current) return;
        leftFor.current = null;
        onOpenChange(false);
        setName('');
        void afterMembershipChange(queryClient, userId);
        void navigate({ to: '/app/family' });
    });

    async function submit(event: FormEvent) {
        event.preventDefault();
        const trimmed = name.trim();
        if (!trimmed || refusal) return;
        setPending(true);
        setError('');
        try {
            const { groupId, outcome } = await createFamily(familyContext(userId), trimmed);
            // Read again before anything else, the checkout included: whatever page comes back
            // (a reload, Back from Polar) knows the family exists. This dialog stays while it does.
            await afterFamilyChange(queryClient, userId);
            if (outcome.status === 'landed') {
                if (plan) {
                    try {
                        const { url } = await groupBillingApi.checkout(
                            groupId,
                            plan.plan.id,
                            plan.currency,
                        );
                        leftFor.current = groupId;
                        window.location.assign(url);
                        // Busy until the browser has left for the checkout.
                        return;
                    } catch (cause) {
                        cue('error');
                        toast.add({
                            type: 'error',
                            title: `${trimmed} created, but the checkout didn’t open`,
                            description: `${authError(cause)} Choose a plan on its page.`,
                        });
                        onOpenChange(false);
                        setName('');
                        setPending(false);
                        await navigate({ to: '/app/family' });
                        return;
                    }
                }
                cue('success');
                toast.add({ type: 'success', title: `${trimmed} created` });
                onOpenChange(false);
                setName('');
                setPending(false);
                await navigate({ to: '/app/family' });
                return;
            }
            if (outcome.status === 'pending') {
                toast.add({
                    type: 'info',
                    title: 'Saved on this device',
                    description:
                        'HushOS couldn’t reach the server. It finishes creating the family when it can.',
                });
                onOpenChange(false);
                setPending(false);
                return;
            }
            cue('error');
            setError(outcomeCopy(outcome, { family: trimmed }) ?? '');
        } catch (cause) {
            cue('error');
            setError(errorCopy(cause, { family: trimmed }));
        }
        setPending(false);
    }

    return (
        <Dialog open={open} onOpenChange={(next) => !pending && onOpenChange(next)}>
            <DialogContent className="sm:max-w-[440px]">
                <DialogHeader>
                    <DialogTitle>Create a family</DialogTitle>
                    <DialogDescription>
                        {refusal ||
                            (plan
                                ? `You’ll be its organizer. Then you pay for ${familyTierName(plan.plan)}, ${formatQuota(plan.plan.quotaBytes)} for everyone’s own files and the family folders, and invite people by email.`
                                : billing
                                  ? 'You’ll be its organizer. Then choose a plan and invite people by email.'
                                  : 'You’ll be its organizer. Then invite people by email.')}
                    </DialogDescription>
                    {!refusal && plan && personalPlan && (
                        <p className="text-sm" data-personal-plan-ends>
                            {personalPlan} From then on your files use the family’s storage.
                        </p>
                    )}
                </DialogHeader>
                <form
                    noValidate
                    onSubmit={(event) => void submit(event)}
                    className="flex flex-col gap-4"
                >
                    <div className="flex flex-col gap-1.5">
                        <label htmlFor={id} className="text-[13px] font-semibold">
                            Name
                        </label>
                        <Input
                            id={id}
                            autoComplete="off"
                            maxLength={100}
                            value={name}
                            onChange={(event) => setName(event.target.value)}
                            placeholder="Lindqvist family"
                            disabled={Boolean(refusal) || pending}
                            aria-invalid={Boolean(error) || undefined}
                            aria-describedby={`${id}-hint`}
                        />
                        <p
                            id={`${id}-hint`}
                            role={error ? 'alert' : undefined}
                            className={`text-[13px] ${error ? 'text-destructive' : 'text-muted-foreground'}`}
                        >
                            {error || 'Everyone you invite sees this name, and so does the server.'}
                        </p>
                    </div>
                    <div className="flex justify-end gap-2">
                        <Button
                            type="button"
                            variant="outline"
                            disabled={pending}
                            onClick={() => onOpenChange(false)}
                        >
                            Cancel
                        </Button>
                        <Button
                            type="submit"
                            disabled={pending || !name.trim() || Boolean(refusal)}
                        >
                            {pending ? 'Creating…' : plan ? 'Create and pay' : 'Create family'}
                        </Button>
                    </div>
                </form>
            </DialogContent>
        </Dialog>
    );
}
