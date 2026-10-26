import { cn } from 'cn';
import { initialsOf } from '@/lib/initials';

const TONES = [
    'bg-avatar1 text-on-avatar1',
    'bg-avatar2 text-on-avatar2',
    'bg-avatar3 text-on-avatar3',
    'bg-avatar4 text-on-avatar4',
] as const;

/* A stable tone per person, so the same person has the same colour in every list. */
function toneOf(seed: string) {
    let hash = 0;
    for (const char of seed) hash = (hash * 31 + char.charCodeAt(0)) | 0;
    return TONES[Math.abs(hash) % TONES.length]!;
}

/*
 * A person's initials on their own tone, the one avatar for a person everywhere (the account
 * menu, members, contacts, share sheets). `seed` is their user id, so a rename keeps the colour
 * and the same person has the same colour in every place. `name` is the person's name alone:
 * a suffix such as "(you)" is the caller's to show beside it.
 */
export function PersonAvatar({
    name,
    seed,
    size = 36,
    className,
}: {
    name: string;
    seed: string;
    size?: number;
    className?: string;
}) {
    return (
        <span
            aria-hidden="true"
            className={cn(
                'grid shrink-0 place-items-center rounded-full font-bold',
                toneOf(seed),
                className,
            )}
            // Never under 8px, so a small mark (the sidebar's 20px) still reads.
            style={{ width: size, height: size, fontSize: Math.max(8, Math.round(size * 0.36)) }}
        >
            {initialsOf(name)}
        </span>
    );
}
