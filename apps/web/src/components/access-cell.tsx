import { Link2Icon } from 'lucide-react';
import { PersonAvatar } from '@/components/person-avatar';

/*
 * The "Who can open" cell and sentence, apart from the drive's queries so the
 * public site's demos draw exactly what the app draws. drive/access.tsx
 * re-exports both for the app.
 */

export type Access = { people: { id: string; name: string }[]; links: number };

/* "You, Sam and anyone with the link": who can open it, said in full. */
function whoCanOpen({ people, links }: Access) {
    const parts = ['You', ...people.map((person) => person.name)];
    if (links > 0) parts.push('anyone with the link');
    return parts.length === 1 ? 'Only you' : `${parts.slice(0, -1).join(', ')} and ${parts.at(-1)}`;
}

/*
 * A row's "Who can open": the people and the link on it, or what it inherits, or
 * only you. In a detail panel (`detail`) it is the whole sentence, wrapping, with
 * no link icon: there is room to say it, and the icon is for rows short of it.
 */
export function AccessCell({
    access,
    inherited,
    detail = false,
}: {
    access: Access | undefined;
    inherited: boolean;
    detail?: boolean;
}) {
    if (access && detail)
        return <span className="text-[13px] leading-snug text-pretty">{whoCanOpen(access)}</span>;
    if (!access)
        return (
            <span className="text-[13px] text-muted-foreground">
                {inherited ? 'Same as folder' : 'Only you'}
            </span>
        );
    const { people, links } = access;
    return (
        <span className="flex min-w-0 items-center gap-2 text-[13px]">
            {people.length > 0 && (
                <span className="flex shrink-0 -space-x-1.5">
                    {people.slice(0, 3).map((person) => (
                        <PersonAvatar
                            key={person.id}
                            name={person.name}
                            seed={person.id}
                            size={22}
                            className="ring-2 ring-panel"
                        />
                    ))}
                </span>
            )}
            {/* A blue link icon marks "anyone with the link"; the words stay quiet. */}
            {links > 0 && (
                <Link2Icon
                    className="size-3.5 shrink-0 text-primary"
                    strokeWidth={2.4}
                    aria-hidden="true"
                />
            )}
            <span className="min-w-0 truncate text-muted-foreground">
                {people.length === 1 && people[0]!.name}
                {people.length > 1 && `${people.length} people`}
                {people.length > 0 && links > 0 && ' · '}
                {links > 0 && (people.length ? 'link' : 'Anyone with the link')}
            </span>
        </span>
    );
}
