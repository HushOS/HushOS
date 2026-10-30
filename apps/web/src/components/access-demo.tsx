import { Link2Icon } from 'lucide-react';
import { useState } from 'react';
import { AccessCell } from '@/components/access-cell';
import { FolderMark } from '@/components/folder-mark';
import { PersonAvatar } from '@/components/person-avatar';
import { SiteSwitch } from '@/components/site';

/*
 * Teams' "Who can open?": one sample folder and three made-up colleagues. The
 * folder row is the app's own (its mark, its access cell, its avatars), and each
 * change says what HushOS does underneath in the security page's terms, with
 * the limits that page states. Nothing is saved or sent.
 */

type Role = 'view' | 'edit';
type Person = { id: string; name: string; role: Role | null };

const cast: Person[] = [
    { id: 'demo-sam', name: 'Sam', role: null },
    { id: 'demo-priya', name: 'Priya', role: null },
    { id: 'demo-jonas', name: 'Jonas', role: null },
];

const start =
    'Only you can open this folder. Share it with someone, or make a link, to see what changes.';

/* Shorter words on a phone: at 360px the three full labels are wider than the switch below the name. */
const roleOptions = [
    {
        value: 'none' as const,
        label: (
            <>
                <span className="sm:hidden">None</span>
                <span className="max-sm:hidden">Not shared</span>
            </>
        ),
    },
    {
        value: 'view' as const,
        label: (
            <>
                <span className="sm:hidden">View</span>
                <span className="max-sm:hidden">Can view</span>
            </>
        ),
    },
    {
        value: 'edit' as const,
        label: (
            <>
                <span className="sm:hidden">Edit</span>
                <span className="max-sm:hidden">Can edit</span>
            </>
        ),
    },
];

const switchClass =
    'w-full sm:w-auto [&_button]:h-9 [&_button]:px-3 [&_button]:text-sm pointer-coarse:[&_button]:h-11';

export function AccessDemo() {
    const [people, setPeople] = useState(cast);
    const [link, setLink] = useState(false);
    const [note, setNote] = useState(start);
    const shared = people.filter((person) => person.role);

    function setRole(id: string, role: Role | null) {
        const person = people.find((entry) => entry.id === id);
        if (!person) return;
        const { name } = person;
        const before = person.role;
        // Picking what is already chosen changes nothing, so it says nothing.
        if (role === before) return;
        setPeople(people.map((entry) => (entry.id === id ? { ...entry, role } : entry)));
        if (role && !before)
            setNote(
                `Once you’ve added ${name}, your device locks a copy of the folder’s key for ${name}, so only ${name}’s devices can open it. ${name} ${role === 'edit' ? 'can add and change files' : 'can open and download'}.`,
            );
        else if (role)
            setNote(
                role === 'edit'
                    ? `${name} can now add and change files too.`
                    : `${name} can now open and download, but not change anything.`,
            );
        else
            setNote(
                `${name} is refused on their next request. Your device then changes the folder’s keys and locks them again for everyone who still has access, so nothing added later opens for ${name}. Anything ${name} already downloaded stays with ${name}.`,
            );
    }

    function setLinkOn(on: boolean) {
        if (on === link) return;
        setLink(on);
        setNote(
            on
                ? 'Anyone with the link can open the folder in their browser, without an account. The secret part of the link sits after the #, which browsers never send to us.'
                : 'The link is refused on its next request, and the folder’s keys change for everyone who still has access, so nothing added later opens through it. Anything already downloaded stays where it is.',
        );
    }

    return (
        <figure
            aria-labelledby="access-demo-title"
            // The app's cell rings its avatars in `card`; here that is the raised panel.
            className="mt-14 [--card:var(--id-raised,var(--card))] [--panel:var(--id-raised,var(--card))] rounded-xl border border-rule bg-[var(--id-raised,var(--card))] p-5 sm:p-8"
        >
            <h3 id="access-demo-title" className="text-xl font-bold">
                Try it: who can open?
            </h3>
            <div className="mt-6 grid gap-8 lg:grid-cols-[6fr_5fr] lg:gap-12">
                <div className="flex flex-col gap-4">
                    {/* The folder as its row in the app: the mark, the name, who can open. */}
                    <div className="flex items-center gap-3 rounded-md border border-rule p-3 sm:p-4">
                        <FolderMark box={36} />
                        <span className="flex min-w-0 flex-col gap-1">
                            <span className="text-[15px] font-medium">Client work</span>
                            {/* Nothing shared is no access entry at all, as the app's index has none. */}
                            <AccessCell
                                access={
                                    shared.length || link
                                        ? {
                                              people: shared.map(({ id, name }) => ({ id, name })),
                                              links: link ? 1 : 0,
                                          }
                                        : undefined
                                }
                                inherited={false}
                            />
                        </span>
                    </div>
                    <ul className="flex flex-col">
                        {people.map((person) => (
                            <li
                                key={person.id}
                                className="flex flex-wrap items-center justify-between gap-3 border-b border-rule py-3 last:border-b-0"
                            >
                                <span className="flex items-center gap-3 text-[15px] font-medium">
                                    <PersonAvatar name={person.name} seed={person.id} size={28} />
                                    {person.name}
                                </span>
                                <SiteSwitch
                                    label={`What ${person.name} can do`}
                                    value={person.role ?? 'none'}
                                    onChange={(value) =>
                                        setRole(person.id, value === 'none' ? null : value)
                                    }
                                    options={roleOptions}
                                    className={switchClass}
                                />
                            </li>
                        ))}
                        <li className="flex flex-wrap items-center justify-between gap-3 pt-3">
                            <span className="flex items-center gap-3 text-[15px] font-medium">
                                <span aria-hidden="true" className="grid size-7 place-items-center">
                                    <Link2Icon className="size-[18px] text-primary" />
                                </span>
                                Anyone with the link
                            </span>
                            <SiteSwitch
                                label="Anyone with the link"
                                value={link ? 'on' : 'off'}
                                onChange={(value) => setLinkOn(value === 'on')}
                                options={[
                                    { value: 'off', label: 'Off' },
                                    { value: 'on', label: 'On' },
                                ]}
                                className={switchClass}
                            />
                        </li>
                    </ul>
                </div>
                <div className="flex flex-col justify-center gap-3">
                    <p className="eyebrow text-muted-foreground">What HushOS does</p>
                    <p aria-live="polite" className="text-[17px] leading-relaxed text-pretty">
                        {note}
                    </p>
                    <p className="text-xs text-muted-foreground">
                        A demo with made-up people. Nothing here is saved or sent.
                    </p>
                </div>
            </div>
        </figure>
    );
}
