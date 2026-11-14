import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { UsersIcon } from 'lucide-react';
import { useState } from 'react';
import { EmptyState } from '@/components/drive/file-list';
import { CreateFamilyDialog } from '@/components/families/create-family-dialog';
import { DeclineInvitation } from '@/components/families/decline-invitation';
import { NoticeList } from '@/components/families/family-alerts';
import { ServerKnowsLine } from '@/components/families/server-knows';
import { PageHeader } from '@/components/page-header';
import { Setting, SettingsGroup, SettingsPage } from '@/components/settings';
import { Button, buttonVariants } from '@/components/ui/button';
import { myInvitationsQueryOptions } from '@/lib/families-shell';
import { defaultFamilyName, familyCheckoutCurrency } from '@/lib/family-signup';
import { personalPlanEnding } from '@/lib/plans';
import { billingQueryOptions, catalogueQueryOptions, useBillingEnabled } from '@/lib/queries';
import type { GroupSummary } from '@/lib/groups/api';
import type { GroupNotice } from '@/lib/groups/context';
import { errorCopy } from '@/lib/groups/copy';

const until = (iso: string) =>
    new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'long' });

/*
 * Account → Family (/app/family) for someone in no family
 * (docs/families-shared-pool.md 7.2). With nothing waiting for them, the page is its
 * empty state, centred in the pane: the place's icon, "No family yet", one line, and
 * Create a family. The families they wait to join and the invitations sent to their
 * address are sections that show only while there are some. Each invitation is accepted
 * from the link in its email, never from here (decision 6). `notices` are the app-wide
 * pass's, which may be about a family they have since left.
 */
export function NoFamily({
    userId,
    families,
    notices,
    nameOf,
    create,
    accountName,
}: {
    userId: string;
    families: readonly GroupSummary[];
    notices: readonly GroupNotice[];
    nameOf: (groupId: string) => string | undefined;
    /*
     * A family tier chosen on Plans or the pricing page, or at signup: Create a family opens
     * with it, and goes on to its checkout.
     */
    create?: { planId: string; currency?: string };
    /* The account's name, for the name a family made with a chosen tier starts with. */
    accountName?: string;
}) {
    const waiting = families.filter((at) => at.kind === 'family' && at.state === 'accepted');
    const invitations = useQuery(myInvitationsQueryOptions(userId));
    const [creating, setCreating] = useState(false);
    // Where plans are sold, a family's plan holds everyone's own files and the family folders.
    const billing = useBillingEnabled();
    const catalogue = useQuery({ ...catalogueQueryOptions, enabled: billing && Boolean(create) });
    const personal = useQuery({ ...billingQueryOptions, enabled: billing && Boolean(create) });
    const chosen = create ? catalogue.data?.families.find((at) => at.id === create.planId) : null;
    // Charged in the address's currency only where the tier is priced in it.
    const plan = chosen
        ? { plan: chosen, currency: familyCheckoutCurrency(chosen, create?.currency) }
        : undefined;
    // Arrived with a tier: the dialog opens with it, until it is closed. Not for someone waiting
    // to join a family: they're about to be in one, and are shown how to finish joining instead.
    const [dismissed, setDismissed] = useState(false);
    const open = creating || (Boolean(chosen) && !dismissed && waiting.length === 0);
    const invited = invitations.data ?? [];
    // Nothing on the page but the way to start: no family waited for, no invitation, nothing to say.
    // Not while the invitations are still being read, so the empty state never flashes before a list.
    const empty =
        waiting.length === 0 &&
        notices.length === 0 &&
        invitations.isSuccess &&
        invited.length === 0;
    return (
        <SettingsPage className="flex-1" data-no-family>
            <PageHeader title="Family">
                {/* With something on the page, Create a family is the header's. Not while waiting to join one: once let in it is theirs, and a second is refused. */}
                {!empty && !invitations.isPending && waiting.length === 0 && (
                    <Button onClick={() => setCreating(true)}>Create a family</Button>
                )}
            </PageHeader>
            {empty ? (
                <EmptyState
                    icon={UsersIcon}
                    title="No family yet"
                    body="Create one, or join from the link in an invitation email."
                    className="flex-1 justify-center"
                >
                    <Button onClick={() => setCreating(true)}>Create a family</Button>
                </EmptyState>
            ) : (
                <div className="flex flex-col gap-9 px-5 pb-10 sm:px-8">
                    {notices.length > 0 && <NoticeList notices={notices} nameOf={nameOf} />}
                    {waiting.length > 0 && (
                        <SettingsGroup title="Waiting to join">
                            {waiting.map((family) => (
                                <Setting
                                    key={family.id}
                                    label={family.name}
                                    action={
                                        <Link
                                            to="/app/families/$groupId/join"
                                            params={{ groupId: family.id }}
                                            aria-label={`Continue joining ${family.name}`}
                                            className={buttonVariants({ variant: 'outline' })}
                                        >
                                            Continue
                                        </Link>
                                    }
                                >
                                    <span className="flex flex-col items-start gap-1">
                                        <span className="text-muted-foreground">
                                            You accepted. You’re in once someone who manages it lets
                                            you in.
                                        </span>
                                        {/* Quiet, under the words: Continue is the row's way on. */}
                                        <DeclineInvitation
                                            userId={userId}
                                            groupId={family.id}
                                            family={family.name}
                                            className="-ml-3.5"
                                        />
                                    </span>
                                </Setting>
                            ))}
                        </SettingsGroup>
                    )}
                    {/* Only while there are some, or while saying they couldn't be read. */}
                    {(invited.length > 0 || invitations.isError) && (
                        <SettingsGroup title="Invitations">
                            {invited.length > 0 && (
                                <ul className="flex flex-col" aria-label="Invitations to you">
                                    {invited.map((invitation) => (
                                        <li
                                            key={invitation.id}
                                            className="flex flex-col gap-0.5 py-3"
                                            data-invitation-to={invitation.name}
                                        >
                                            <span className="font-medium">
                                                {invitation.inviterName
                                                    ? `${invitation.inviterName} invited you to ${invitation.name}`
                                                    : `You’re invited to ${invitation.name}`}
                                            </span>
                                            <span className="text-[13px] text-muted-foreground">
                                                Open the link in the invitation email to join. It
                                                stays open until {until(invitation.expiresAt)}.
                                            </span>
                                        </li>
                                    ))}
                                </ul>
                            )}
                            {invitations.isError && (
                                <p className="py-3 text-destructive">
                                    {errorCopy(invitations.error)}
                                </p>
                            )}
                        </SettingsGroup>
                    )}
                </div>
            )}
            {/* What the server knows of a family is said once there is one to speak of. */}
            {!empty && <ServerKnowsLine className="mt-auto" />}
            <CreateFamilyDialog
                userId={userId}
                open={open}
                onOpenChange={(next) => {
                    setCreating(next);
                    if (!next) setDismissed(true);
                }}
                plan={plan}
                // With a tier chosen the name is filled in, so one click goes on to checkout.
                defaultName={plan ? defaultFamilyName(accountName) : undefined}
                personalPlan={personalPlanEnding(
                    personal.data?.subscription,
                    'the family’s plan starts',
                )}
            />
        </SettingsPage>
    );
}
