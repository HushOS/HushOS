import { useQuery } from '@tanstack/react-query';
import { Link, useLocation } from '@tanstack/react-router';
import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import { PersonAvatar } from '@/components/person-avatar';
import { Setting, SettingsGroup } from '@/components/settings';
import { Button, buttonVariants } from '@/components/ui/button';
import { familyBillingQueryOptions, type FamilyBilling } from '@/lib/family-billing';
import {
    activeFamily,
    familiesQueryOptions,
    myInvitationsQueryOptions,
    rolesLine,
    useGroupsEnabled,
} from '@/lib/families-shell';
import { errorCopy } from '@/lib/groups/copy';
import { useBillingEnabled } from '@/lib/queries';

/* The dialog brings the families data layer and the crypto worker: only once it is opened. */
const CreateFamilyDialog = lazy(async () => ({
    default: (await import('@/components/families/create-family-dialog')).CreateFamilyDialog,
}));

const until = (iso: string) =>
    new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'long' });

/* The plan in a few words, for whoever is looking: managers and members see the same glance. */
function planGlance(summary: FamilyBilling): string | null {
    if (!summary.enabled) return null;
    if (summary.view === 'member')
        return summary.hasPlan ? (summary.planName ?? 'On a plan') : 'No plan right now';
    const live = summary.subscription;
    if (live) return live.cancelAtPeriodEnd ? `${live.productName}, set to end` : live.productName;
    return summary.lastPlan ? `${summary.lastPlan.productName}, ended` : 'No plan yet';
}

/*
 * Account → Family (docs/families-shared-pool.md decision 6): the one place a
 * family starts from. In a family, it shows that family, your part in it and
 * its plan, and leads to its page, where members, invitations and Leave family
 * are. In none, it offers Create a family, says how joining works, and lists
 * the invitations sent to this account's address; each is accepted from the
 * link in its email, never from here. Hidden on a server without families.
 */
export function AccountFamily({ userId }: { userId: string }) {
    const groups = useGroupsEnabled();
    const billing = useBillingEnabled();
    const families = useQuery({ ...familiesQueryOptions(userId), enabled: groups });
    const yours = activeFamily(families.data);
    const waiting = families.data?.filter((at) => at.kind === 'family' && at.state === 'accepted');
    const invitations = useQuery({
        ...myInvitationsQueryOptions(userId),
        enabled: groups && families.isSuccess && !yours,
    });
    const plan = useQuery({
        ...familyBillingQueryOptions(userId, yours?.id ?? ''),
        enabled: billing && Boolean(yours),
    });
    const [creating, setCreating] = useState(false);

    // Arriving at #family (the old Families page, the pricing page, a family page's back link):
    // the section is below the fold on a phone.
    const hash = useLocation({ select: (location) => location.hash });
    const section = useRef<HTMLDivElement>(null);
    const ready = groups && !families.isPending;
    useEffect(() => {
        if (ready && hash === 'family') section.current?.scrollIntoView({ block: 'start' });
    }, [ready, hash]);

    if (!groups) return null;
    return (
        <div id="family" ref={section} className="scroll-mt-24" data-account-family>
            <SettingsGroup
                title="Family"
                description={
                    yours
                        ? 'You can be in one family. Its members share its folders.'
                        : 'People in a family share its folders. Everyone is checked before they join.'
                }
                action={
                    families.isSuccess && !yours ? (
                        <Button onClick={() => setCreating(true)}>Create a family</Button>
                    ) : undefined
                }
            >
                {families.isPending && (
                    <Setting label="Family">
                        <span className="text-muted-foreground">Checking</span>
                    </Setting>
                )}
                {families.isError && (
                    <Setting
                        label="Family"
                        action={
                            <Button variant="outline" onClick={() => void families.refetch()}>
                                Try again
                            </Button>
                        }
                    >
                        <span className="text-destructive">{errorCopy(families.error)}</span>
                    </Setting>
                )}
                {yours && (
                    <>
                        <Setting
                            label="Your family"
                            action={
                                <Link
                                    to="/app/families/$groupId"
                                    params={{ groupId: yours.id }}
                                    className={buttonVariants({ variant: 'outline' })}
                                >
                                    Open
                                </Link>
                            }
                            below={
                                <p className="text-[13px] text-muted-foreground">
                                    Members, invitations and Leave family are on its page.
                                </p>
                            }
                        >
                            <span className="flex min-w-0 items-center gap-3" data-your-family>
                                <PersonAvatar name={yours.name} seed={yours.id} />
                                <span className="flex min-w-0 flex-col">
                                    <span className="truncate font-medium">{yours.name}</span>
                                    <span className="truncate text-[13px] text-muted-foreground">
                                        {rolesLine(yours.roles)}
                                    </span>
                                </span>
                            </span>
                        </Setting>
                        {plan.data && planGlance(plan.data) && (
                            <Setting label="Plan">
                                <span data-family-plan-glance>{planGlance(plan.data)}</span>
                            </Setting>
                        )}
                    </>
                )}
                {!yours &&
                    waiting?.map((family) => (
                        <Setting
                            key={family.id}
                            label="Waiting to join"
                            action={
                                <Link
                                    to="/app/families/$groupId/join"
                                    params={{ groupId: family.id }}
                                    className={buttonVariants({ variant: 'outline' })}
                                >
                                    Continue
                                </Link>
                            }
                        >
                            <span className="truncate">{family.name}</span>
                        </Setting>
                    ))}
                {families.isSuccess && !yours && (
                    <Setting label="Invitations">
                        <div className="flex flex-col gap-3">
                            {invitations.data?.map((invitation) => (
                                <p
                                    key={invitation.id}
                                    className="flex flex-col"
                                    data-invitation-to={invitation.name}
                                >
                                    <span className="font-medium">
                                        {invitation.inviterName
                                            ? `${invitation.inviterName} invited you to ${invitation.name}`
                                            : `You’re invited to ${invitation.name}`}
                                    </span>
                                    <span className="text-[13px] text-muted-foreground">
                                        Open the link in the invitation email to join. It stays open
                                        until {until(invitation.expiresAt)}.
                                    </span>
                                </p>
                            ))}
                            {invitations.isSuccess && invitations.data.length === 0 && (
                                <span className="text-muted-foreground">
                                    None. Someone in a family invites you by email, and you join
                                    from the link in it.
                                </span>
                            )}
                            {invitations.isError && (
                                <span className="text-destructive">
                                    {errorCopy(invitations.error)}
                                </span>
                            )}
                        </div>
                    </Setting>
                )}
            </SettingsGroup>
            {creating && (
                <Suspense>
                    <CreateFamilyDialog userId={userId} open onOpenChange={setCreating} />
                </Suspense>
            )}
        </div>
    );
}
