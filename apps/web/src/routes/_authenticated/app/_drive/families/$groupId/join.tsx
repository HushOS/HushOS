import { useQuery, useQueryClient } from '@tanstack/react-query';
import { createFileRoute, Link, useNavigate } from '@tanstack/react-router';
import { RotateCcwIcon } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { EmptyState, SkeletonRows } from '@/components/drive/file-list';
import { useDrive } from '@/components/drive/drive-shell';
import { ForkAlert } from '@/components/families/family-alerts';
import { Spinner } from '@/components/motion';
import { PageHeader } from '@/components/page-header';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { toast } from '@/components/ui/toast';
import {
    afterMembershipChange,
    familiesQueryOptions,
    familyContext,
    familyQueryOptions,
    firstName,
} from '@/lib/families';
import type { RosterFork } from '@hushos/crypto';
import { errorCopy } from '@/lib/groups/copy';
import { joinStatus, type JoinOutcome } from '@/lib/groups/join';
import { cue } from '@/lib/sounds';

export const Route = createFileRoute('/_authenticated/app/_drive/families/$groupId/join')({
    head: () => ({ meta: [{ title: 'Join a family · HushOS' }] }),
    component: JoinFamily,
});

/*
 * The newcomer's side (docs/optional-verification.md 3.2, 6.8; join.ts):
 * after Join, they wait until a manager lets them in from the family's page.
 * Route 2 is polled meanwhile; once it says they're in, this device joins on
 * first use and goes to the family page, as for any member. No words on
 * either side: checking each other is for later, from the members list.
 */

type Step =
    | { kind: 'loading' }
    /* `n` tells one entry into waiting from the next, so polling starts again each time. */
    | { kind: 'waiting'; n: number }
    | { kind: 'fork'; fork: RosterFork };

const POLL_MS = 3_000;

function JoinFamily() {
    const { groupId } = Route.useParams();
    const { userId } = useDrive();
    const queryClient = useQueryClient();
    const navigate = useNavigate();
    const ctx = familyContext(userId);
    const families = useQuery(familiesQueryOptions(userId));
    const summary = families.data?.find((family) => family.id === groupId);
    // Route 3 answers someone who accepted: who manages the family.
    const detail = useQuery({
        ...familyQueryOptions(userId, groupId),
        enabled: Boolean(summary),
        refetchInterval: 5_000,
    });
    const [step, setStep] = useState<Step>({ kind: 'loading' });
    const [error, setError] = useState('');
    const started = useRef(false);

    const family = summary?.name ?? 'the family';
    const managers = (detail.data?.members ?? []).filter(
        (member) => member.state === 'active' && member.roles.includes('members'),
    );
    const only = managers.length === 1 ? firstName(managers[0]!.name) : null;

    async function joined() {
        cue('success');
        toast.add({ type: 'success', title: `You’re in ${family}` });
        await afterMembershipChange(queryClient, userId);
        await navigate({ to: '/app/family', replace: true });
    }

    /* Each answer from join.ts, as a step. */
    function show(outcome: JoinOutcome | { status: 'member' }) {
        setError('');
        switch (outcome.status) {
            case 'joined':
                return void joined();
            case 'member':
                // This device already holds the family: nothing to join.
                return void navigate({ to: '/app/family', replace: true });
            case 'waiting':
                return setStep((current) =>
                    current.kind === 'waiting' ? current : { kind: 'waiting', n: Date.now() },
                );
            case 'fork':
                return setStep({ kind: 'fork', fork: outcome.fork });
        }
    }

    async function resume() {
        setError('');
        try {
            show(await joinStatus(ctx, groupId));
        } catch (cause) {
            // The retry button belongs to the loading step: whatever step this came from.
            setStep({ kind: 'loading' });
            setError(errorCopy(cause, { family }));
        }
    }

    useEffect(() => {
        if (started.current || !summary) return;
        started.current = true;
        void resume();
        // Started once the family is known; later list refreshes don't restart it.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [summary]);

    // Waiting: route 2 polled through joinStatus until the person is let in.
    useEffect(() => {
        if (step.kind !== 'waiting') return;
        let active = true;
        let timer: ReturnType<typeof setTimeout> | undefined;
        const tick = async () => {
            try {
                const outcome = await joinStatus(ctx, groupId);
                if (!active) return;
                if (outcome.status !== 'waiting') return show(outcome);
                setError('');
            } catch (cause) {
                if (active) setError(errorCopy(cause, { family }));
            }
            if (active) timer = setTimeout(() => void tick(), POLL_MS);
        };
        timer = setTimeout(() => void tick(), POLL_MS);
        return () => {
            active = false;
            clearTimeout(timer);
        };
        // One loop per entry into the waiting step.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [step.kind === 'waiting' ? step.n : 0]);

    if (families.isPending) return <SkeletonRows rows={3} />;
    if (families.isError || !summary)
        return (
            <EmptyState
                title="This family couldn’t be opened"
                body={
                    families.isError
                        ? errorCopy(families.error)
                        : 'You haven’t accepted an invitation to it, or it has ended.'
                }
            >
                <Link to="/app/family" className="text-sm font-semibold text-primary underline">
                    Family
                </Link>
            </EmptyState>
        );

    // 6.8: one manager is named; with more, whoever manages the family lets them in.
    const title =
        step.kind === 'waiting'
            ? only
                ? `Waiting for ${only}`
                : 'Waiting to be let in'
            : `Join ${family}`;
    const description =
        step.kind === 'waiting'
            ? only
                ? `${only} lets you in from the family’s page. This page updates when you’re in.`
                : `Someone who manages ${family} lets you in from the family’s page. This page updates when you’re in.`
            : undefined;

    return (
        <div className="flex flex-1 flex-col">
            <PageHeader
                back={<Link to="/app/family">Family</Link>}
                title={title}
                description={description}
            />
            {/* Always on the page, so each change of step is announced. */}
            <p
                aria-live="polite"
                className="sr-only"
                data-join-waiting={step.kind === 'waiting' || undefined}
            >
                {step.kind === 'waiting' ? title : ''}
            </p>
            <div className="flex max-w-[640px] flex-col gap-6 px-5 pb-10 sm:px-8">
                {error && (
                    <Alert variant="warning">
                        <AlertDescription>{error}</AlertDescription>
                    </Alert>
                )}
                {step.kind === 'loading' && !error && (
                    <output className="flex items-center gap-2 text-sm text-muted-foreground">
                        <Spinner className="size-4" />
                        Opening
                    </output>
                )}
                {step.kind === 'loading' && error && (
                    <div>
                        <Button variant="outline" onClick={() => void resume()}>
                            <RotateCcwIcon />
                            Try again
                        </Button>
                    </div>
                )}
                {step.kind === 'fork' && <ForkAlert family={family} fork={step.fork} />}
            </div>
        </div>
    );
}
