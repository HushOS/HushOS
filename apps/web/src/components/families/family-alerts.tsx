import type { RosterFork } from '@hushos/crypto';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import type { GroupNotice } from '@/lib/groups/context';
import { noticeCopy, noticeTitle } from '@/lib/groups/copy';

const FROM: Record<string, string> = {
    pin: 'your account’s earlier check',
    cache: 'this device’s earlier check',
    join: 'the join code you compared',
    served: 'what the server shows now',
};

/*
 * The hard warning (the 1c plan, section 3): an inline danger alert, never a
 * toast. Both sides' digests and where each came from go under Technical
 * details. Nothing resolves it automatically (decision D5); changes from
 * this device stop, since staging needs a chain that accepted.
 */
export function ForkAlert({ family, fork }: { family: string; fork: RosterFork }) {
    return (
        <Alert variant="destructive" data-fork={fork.version}>
            <AlertTitle>{family}’s member list was shown differently to you</AlertTitle>
            <AlertDescription>
                <p>
                    This device won’t change anything in {family} until it’s sorted. Tell the other
                    members, and don’t use this family until you’ve sorted it out together.
                </p>
                <details className="mt-2">
                    <summary className="cursor-pointer text-[13px] font-semibold text-foreground">
                        Technical details
                    </summary>
                    <dl className="mt-2 flex flex-col gap-2 text-[13px]">
                        <div>
                            <dt className="text-muted-foreground">
                                {fork.of === 'roster' ? 'Member list' : 'Family key'} version
                            </dt>
                            <dd className="font-mono">{fork.version}</dd>
                        </div>
                        {fork.sides.map((side) => (
                            <div key={side.digest + side.from.join()}>
                                <dt className="text-muted-foreground">
                                    From {side.from.map((from) => FROM[from] ?? from).join(', ')}
                                </dt>
                                <dd className="font-mono break-all">{side.digest}</dd>
                            </div>
                        ))}
                    </dl>
                </details>
            </AlertDescription>
        </Alert>
    );
}

/* What the data layer did on its own, said once per sync. */
export function NoticeList({
    notices,
    nameOf,
    personOf,
}: {
    notices: readonly GroupNotice[];
    /* The family a notice is about, by its id, when the page knows it. */
    nameOf?: (groupId: string) => string | undefined;
    /* A person a notice names, by their user id, when the page knows them. */
    personOf?: (userId: string) => string | undefined;
}) {
    if (notices.length === 0) return null;
    return (
        <div className="flex flex-col gap-2">
            {notices.map((notice, index) => {
                const family = 'groupId' in notice ? nameOf?.(notice.groupId) : undefined;
                const title = noticeTitle(notice, family);
                return (
                    <Alert
                        key={`${notice.kind}-${index}`}
                        variant={
                            notice.kind === 'changes-lost' ||
                            notice.kind === 'admission-dropped' ||
                            notice.kind === 'foreign-listing'
                                ? 'warning'
                                : 'info'
                        }
                        data-notice={notice.kind}
                    >
                        {title && <AlertTitle>{title}</AlertTitle>}
                        <AlertDescription>
                            {noticeCopy(notice, family, personOf, nameOf)}
                        </AlertDescription>
                    </Alert>
                );
            })}
        </div>
    );
}
