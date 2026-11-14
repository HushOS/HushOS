/* A key's cap, as the command palette and Search show a shortcut's keys. */
export function Kbd({ children }: { children: string }) {
    return (
        <kbd className="inline-flex h-5 min-w-5 items-center justify-center rounded-xs border bg-muted px-1 font-mono text-[10px] text-foreground">
            {children}
        </kbd>
    );
}
