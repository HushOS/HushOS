/*
 * About's "first room in a bigger house", drawn: Drive's room has its lamp on;
 * the rooms still to come are pencilled in, and say so. Every room is labelled
 * in the drawing itself, so pointing at one only lifts it; nothing is hidden
 * behind a hover. The list beside it in the text carries the same facts.
 */

/* Two rooms a floor inside walls from 30 to 370; a long name takes two lines. */
const rooms = [
    { name: ['Drive'], note: 'Here now', x: 44, y: 152, lit: true },
    { name: ['Desktop apps'], note: 'Coming', x: 206, y: 152 },
    { name: ['Messages'], note: 'Coming', x: 44, y: 262 },
    { name: ['Notes and', 'documents'], note: 'Coming', x: 206, y: 262 },
];

export function House() {
    return (
        <figure className="mt-8">
            {/* oxlint-disable jsx-a11y/prefer-tag-over-role -- an inline drawing; role=img reads its label as one image */}
            <svg
                viewBox="0 0 400 390"
                role="img"
                aria-label="A house of four rooms. Drive is lit and here now; desktop apps, messages, and notes and documents are coming."
                className="mx-auto block w-full max-w-[420px] text-foreground"
            >
                {/* Roof and walls, in ink. */}
                <path
                    d="M20 140 L200 30 L380 140"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="3"
                    strokeLinejoin="round"
                />
                <rect
                    x="30"
                    y="140"
                    width="340"
                    height="230"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="3"
                />
                {rooms.map((room) => (
                    <g key={room.name.join(' ')}>
                        <rect
                            className="house-room"
                            data-lit={room.lit ? '' : undefined}
                            x={room.x}
                            y={room.y}
                            width="150"
                            height="96"
                            rx="6"
                            stroke="currentColor"
                            strokeWidth="1.5"
                        />
                        <text
                            x={room.x + 14}
                            y={room.y + 30}
                            fontSize="15"
                            fontWeight="700"
                            fill={room.lit ? 'var(--id-on-lamp, currentColor)' : 'currentColor'}
                        >
                            {room.name.map((line, index) => (
                                <tspan key={line} x={room.x + 14} dy={index ? 18 : 0}>
                                    {line}
                                </tspan>
                            ))}
                        </text>
                        <text
                            x={room.x + 14}
                            y={room.y + 78}
                            fontSize="12"
                            fill={room.lit ? 'var(--id-on-lamp, currentColor)' : 'currentColor'}
                            className="house-note"
                            fontFamily="var(--font-mono)"
                        >
                            {room.note}
                        </text>
                    </g>
                ))}
                {/* The chimney, standing on the roof's slope (y = 85 and 101 there). */}
                <path
                    d="M290 85 V62 H316 V101"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="3"
                    strokeLinejoin="round"
                />
            </svg>
            {/* oxlint-enable jsx-a11y/prefer-tag-over-role */}
        </figure>
    );
}
