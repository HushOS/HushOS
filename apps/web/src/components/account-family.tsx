import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { PersonAvatar } from '@/components/person-avatar';
import { Setting, SettingsGroup } from '@/components/settings';
import { buttonVariants } from '@/components/ui/button';
import {
    activeFamily,
    familiesQueryOptions,
    rolesLine,
    useGroupsEnabled,
} from '@/lib/families-shell';

/*
 * Account's way to Account → Family (/app/family, docs/families-shared-pool.md
 * 7.2), where the family is managed, its plan chosen and left, or, for
 * someone in none, one is created and invitations are listed. Hidden on a
 * server without families.
 */
export function AccountFamily({ userId }: { userId: string }) {
    const groups = useGroupsEnabled();
    const families = useQuery({ ...familiesQueryOptions(userId), enabled: groups });
    if (!groups) return null;
    const yours = activeFamily(families.data);
    return (
        <SettingsGroup title="Family" description="Your family, its plan, and invitations to you.">
            <Setting
                label="Family"
                action={
                    families.isSuccess && (
                        <Link
                            to="/app/family"
                            aria-label={yours ? `Open ${yours.name}` : 'Open Family'}
                            className={buttonVariants({ variant: 'outline' })}
                        >
                            Open
                        </Link>
                    )
                }
            >
                {yours ? (
                    <span className="flex min-w-0 items-center gap-3" data-your-family>
                        <PersonAvatar name={yours.name} seed={yours.id} />
                        <span className="flex min-w-0 flex-col">
                            <span className="truncate font-medium">{yours.name}</span>
                            <span className="truncate text-[13px] text-muted-foreground">
                                {rolesLine(yours.roles)}
                            </span>
                        </span>
                    </span>
                ) : (
                    <span className="text-muted-foreground">
                        {families.isPending ? 'Checking' : 'You’re not in a family.'}
                    </span>
                )}
            </Setting>
        </SettingsGroup>
    );
}
