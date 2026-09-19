import { useKeyHold } from '@tanstack/react-hotkeys';
import { useEffect, useState } from 'react';
import { keyLabel, shortcuts } from '@/components/drive/shortcuts';

/*
 * Hold the modifier for a moment and the shortcuts appear, bottom left, the way
 * a keyboard overlay does in a desktop app. Release and it goes. Nothing else
 * on the page moves.
 */
export function HotkeyHints() {
    const meta = useKeyHold('Meta');
    const control = useKeyHold('Control');
    const held = meta || control;
    // Armed by a timer once the key has been down for a moment; the timer's cleanup disarms it.
    const [armed, setArmed] = useState(false);
    useEffect(() => {
        if (!held) return;
        const timer = window.setTimeout(() => setArmed(true), 550);
        return () => {
            window.clearTimeout(timer);
            setArmed(false);
        };
    }, [held]);
    if (!held || !armed) return null;
    return (
        <output
            aria-live="polite"
            className="pointer-events-none fixed bottom-4 left-4 z-40 block max-w-sm rounded-xl border bg-popover p-3.5 text-popover-foreground shadow-overlay animate-in fade-in slide-in-from-bottom-1 duration-150 sm:bottom-6 sm:left-6"
        >
            <p className="eyebrow mb-2 text-muted-foreground">Keyboard</p>
            <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-xs">
                {shortcuts.map((shortcut) => (
                    <div key={shortcut.id} className="contents">
                        <dt className="flex items-center gap-1">
                            {shortcut.keys.map((key) => (
                                <Kbd key={key}>{keyLabel(key)}</Kbd>
                            ))}
                        </dt>
                        <dd className="text-muted-foreground">{shortcut.label}</dd>
                    </div>
                ))}
            </dl>
        </output>
    );
}

export function Kbd({ children }: { children: string }) {
    return (
        <kbd className="inline-flex h-5 min-w-5 items-center justify-center rounded-xs border bg-muted px-1 font-mono text-[10px] text-foreground">
            {children}
        </kbd>
    );
}
