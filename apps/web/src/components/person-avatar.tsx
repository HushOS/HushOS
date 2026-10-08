import { cn } from 'cn';

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

export function initialsOf(name: string) {
    return (
        name
            .trim()
            .split(/\s+/)
            .slice(0, 2)
            .map((part) => part[0]?.toUpperCase() ?? '')
            .join('') || '?'
    );
}

/* A person's initials on their own tone. `seed` is their id, so a rename keeps the colour. */
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
            style={{ width: size, height: size, fontSize: Math.round(size * 0.36) }}
        >
            {initialsOf(name)}
        </span>
    );
}
