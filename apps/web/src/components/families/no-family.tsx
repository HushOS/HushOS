import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useState } from 'react';
import { CreateFamilyDialog } from '@/components/families/create-family-dialog';
import { NoticeList } from '@/components/families/family-alerts';
import { ServerKnowsLine } from '@/components/families/server-knows';
import { PageHeader } from '@/components/page-header';
import { Setting, SettingsGroup } from '@/components/settings';
import { Button, buttonVariants } from '@/components/ui/button';
import { myInvitationsQueryOptions } from '@/lib/families-shell';
import type { GroupSummary } from '@/lib/groups/api';
import type { GroupNotice } from '@/lib/groups/context';
import { errorCopy } from '@/lib/groups/copy';

const until = (iso: string) =>
    new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'long' });

/*
 * Account → Family (/app/family) for someone in no family
 * (docs/families-shared-pool.md 7.2): what a family is, Create a family, the
 * families they wait to join, and the invitations sent to their address. Each
 * invitation is accepted from the link in its email, never from here
 * (decision 6). `notices` are the app-wide pass's, which may be about a
 * family they have since left.
 */
export function NoFamily({
    userId,
    families,
    notices,
    nameOf,
}: {
    userId: string;
    families: readonly GroupSummary[];
    notices: readonly GroupNotice[];
    nameOf: (groupId: string) => string | undefined;
}) {
    const waiting = families.filter((at) => at.kind === 'family' && at.state === 'accepted');
    const invitations = useQuery(myInvitationsQueryOptions(userId));
    const [creating, setCreating] = useState(false);
    return (
        <div className="flex flex-1 flex-col" data-no-family>
            <PageHeader
                title="Family"
                description="A family shares folders, and everyone in it is checked before they join. You can be in one family."
            >
                <Button onClick={() => setCreating(true)}>Create a family</Button>
            </PageHeader>
            <div className="flex max-w-3xl flex-col gap-9 px-5 pb-10 sm:px-8">
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
                                <span className="text-muted-foreground">
                                    You accepted. Check each other’s words to finish.
                                </span>
                            </Setting>
                        ))}
                    </SettingsGroup>
                )}
                <SettingsGroup
                    title="Invitations"
                    description="Someone in a family invites you by email, and you join from the link in it."
                >
                    {invitations.isSuccess && invitations.data.length > 0 && (
                        <ul className="flex flex-col" aria-label="Invitations to you">
                            {invitations.data.map((invitation) => (
                                <li
                                    key={invitation.id}
                                    className="flex flex-col gap-0.5 border-b border-rule py-4 last:border-0"
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
                                </li>
                            ))}
                        </ul>
                    )}
                    {invitations.isSuccess && invitations.data.length === 0 && (
                        <p className="py-4 text-muted-foreground">No invitations right now.</p>
                    )}
                    {invitations.isError && (
                        <p className="py-4 text-destructive">{errorCopy(invitations.error)}</p>
                    )}
                </SettingsGroup>
            </div>
            <ServerKnowsLine className="mt-auto" />
            <CreateFamilyDialog userId={userId} open={creating} onOpenChange={setCreating} />
        </div>
    );
}
