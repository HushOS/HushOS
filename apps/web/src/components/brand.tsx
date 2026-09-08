import { Link, type LinkProps } from '@tanstack/react-router';
import { cn } from 'cn';
import { BookOpenIcon, CheckIcon, DownloadIcon } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Logo } from '@/components/logo';
import {
    ContextMenu,
    ContextMenuContent,
    ContextMenuItem,
    ContextMenuSeparator,
    ContextMenuTrigger,
} from '@/components/ui/context-menu';
import { logoSvg, wordmarkSvg } from '@/lib/brand';
import { cue } from '@/lib/sounds';

type Asset = 'wordmark' | 'logo';

/* The wordmark: the mark and HUSHOS set in mono caps, always inside a blue cell. */
export function Wordmark({
    className,
    compact = false,
}: {
    className?: string;
    compact?: boolean;
}) {
    return (
        <span className={cn('flex items-center gap-2.5', className)}>
            <Logo className="h-[18px] w-auto" />
            {!compact && (
                <span className="font-mono text-[13px] font-semibold tracking-[0.14em]">
                    HUSHOS
                </span>
            )}
        </span>
    );
}

function CopyTile({
    asset,
    copied,
    onCopy,
    children,
    label,
}: {
    asset: Asset;
    copied: Asset | null;
    onCopy: (asset: Asset) => void;
    children: React.ReactNode;
    label: string;
}) {
    const done = copied === asset;
    return (
        <ContextMenuItem
            closeOnClick={false}
            onClick={() => onCopy(asset)}
            className="group/tile flex-col items-stretch gap-0 p-0 focus:bg-transparent"
        >
            <span
                className={cn(
                    'relative flex h-16 items-center justify-center overflow-hidden border text-foreground transition-colors duration-150 group-focus/tile:bg-muted',
                    done && 'bg-success/30',
                )}
            >
                <span
                    className={cn(
                        'flex items-center transition-[opacity,transform] duration-200 ease-out-soft',
                        done && 'scale-90 opacity-0',
                    )}
                >
                    {children}
                </span>
                {done && (
                    <span className="absolute inset-0 grid place-items-center animate-in fade-in zoom-in-50 duration-200 ease-out-soft">
                        <CheckIcon className="size-6" strokeWidth={2.5} aria-hidden="true" />
                    </span>
                )}
            </span>
            <span
                aria-live="polite"
                className={cn(
                    'eyebrow px-1 pt-2 transition-colors duration-150',
                    done ? 'text-foreground' : 'text-muted-foreground',
                )}
            >
                {done ? 'Copied · SVG' : label}
            </span>
        </ContextMenuItem>
    );
}

/*
 * The brand cell of every header. Right-clicking opens a small brand menu:
 * copy the wordmark or logo as SVG, download the asset pack, read the guidelines.
 */
export function Brand({
    to = '/',
    className,
    compact = false,
}: {
    to?: LinkProps['to'];
    className?: string;
    compact?: boolean;
}) {
    const [copied, setCopied] = useState<Asset | null>(null);
    useEffect(() => {
        if (!copied) return;
        const timer = window.setTimeout(() => setCopied(null), 1_800);
        return () => window.clearTimeout(timer);
    }, [copied]);
    async function copy(asset: Asset) {
        try {
            await navigator.clipboard.writeText(asset === 'logo' ? logoSvg() : wordmarkSvg());
            cue('success', { volume: 0.4 });
            setCopied(asset);
        } catch {
            cue('error');
        }
    }
    return (
        <ContextMenu onOpenChange={(open) => !open && setCopied(null)}>
            <ContextMenuTrigger
                render={
                    <Link
                        to={to}
                        data-cuelume-hover="tick"
                        className={cn(
                            'flex items-center border-r bg-primary px-4 text-primary-foreground transition-colors hover:bg-primary-hover',
                            className,
                        )}
                    />
                }
            >
                <Wordmark compact={compact} />
            </ContextMenuTrigger>
            <ContextMenuContent className="w-72 p-2">
                <div className="grid grid-cols-2 gap-2">
                    <CopyTile
                        asset="wordmark"
                        copied={copied}
                        onCopy={(asset) => void copy(asset)}
                        label="Copy wordmark"
                    >
                        <Wordmark />
                    </CopyTile>
                    <CopyTile
                        asset="logo"
                        copied={copied}
                        onCopy={(asset) => void copy(asset)}
                        label="Copy logo"
                    >
                        <Logo className="h-6 w-auto" />
                    </CopyTile>
                </div>
                <ContextMenuSeparator className="my-2" />
                <ContextMenuItem
                    render={
                        <a
                            href="/brand/hushos-brand-assets.zip"
                            download
                            aria-label="Download brand assets"
                        />
                    }
                >
                    <DownloadIcon aria-hidden="true" /> Download brand assets
                </ContextMenuItem>
                <ContextMenuItem
                    render={
                        <a
                            href="/design.md"
                            target="_blank"
                            rel="noreferrer"
                            aria-label="Brand guidelines"
                        />
                    }
                >
                    <BookOpenIcon aria-hidden="true" /> Brand guidelines
                </ContextMenuItem>
            </ContextMenuContent>
        </ContextMenu>
    );
}
