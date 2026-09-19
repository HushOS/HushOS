import { Link, type LinkProps } from '@tanstack/react-router';
import { cn } from 'cn';
import { BookOpenIcon, CheckIcon, CodeIcon, DownloadIcon } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Logo } from '@/components/logo';
import {
    ContextMenu,
    ContextMenuContent,
    ContextMenuItem,
    ContextMenuSeparator,
    ContextMenuTrigger,
} from '@/components/ui/context-menu';
import { LOGO_SIDE, logoSvg, wordmarkSvg, WORDMARK_SIZE } from '@/lib/brand';
import { cue } from '@/lib/sounds';

type Asset = 'wordmark' | 'logo';
type Format = 'svg' | 'png';
type Copied = { asset: Asset; format: Format };

/* The wordmark: the mark on a small blue square, and the name beside it in the text face. */
export function Wordmark({
    className,
    compact = false,
}: {
    className?: string;
    compact?: boolean;
}) {
    return (
        <span className={cn('flex items-center gap-2', className)}>
            <span className="grid size-6 shrink-0 place-items-center rounded-md bg-primary text-primary-foreground">
                <Logo className="h-3.5 w-auto" />
            </span>
            {!compact && <span className="text-base font-bold tracking-tight">HushOS</span>}
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
    copied: Copied | null;
    onCopy: (asset: Asset) => void;
    children: React.ReactNode;
    label: string;
}) {
    const done = copied?.asset === asset && copied.format === 'png';
    return (
        <ContextMenuItem
            closeOnClick={false}
            onClick={() => onCopy(asset)}
            className="group/tile flex-col items-stretch gap-0 p-0 focus:bg-transparent"
        >
            <span
                className={cn(
                    'relative flex h-16 items-center justify-center overflow-hidden rounded-md border border-rule text-foreground transition-colors duration-150 group-focus/tile:bg-muted',
                    done && 'bg-success-soft text-success',
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
                {done ? 'Copied · PNG' : label}
            </span>
        </ContextMenuItem>
    );
}

/* A plain row for the vector copy; the check replaces the icon while the copy is fresh. */
function SvgItem({
    asset,
    copied,
    onCopy,
    children,
}: {
    asset: Asset;
    copied: Copied | null;
    onCopy: (asset: Asset) => void;
    children: React.ReactNode;
}) {
    const done = copied?.asset === asset && copied.format === 'svg';
    return (
        <ContextMenuItem closeOnClick={false} onClick={() => onCopy(asset)}>
            {done ? (
                <CheckIcon aria-hidden="true" className="text-success" />
            ) : (
                <CodeIcon aria-hidden="true" />
            )}
            <span aria-live="polite">{done ? 'Copied' : children}</span>
        </ContextMenuItem>
    );
}

/*
 * The brand link of every header. Right-clicking opens a small brand menu:
 * copy the wordmark or logo as PNG (or SVG), download the asset pack, read the guidelines.
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
    const [copied, setCopied] = useState<Copied | null>(null);
    useEffect(() => {
        if (!copied) return;
        const timer = window.setTimeout(() => setCopied(null), 1_800);
        return () => window.clearTimeout(timer);
    }, [copied]);
    async function copySvg(asset: Asset) {
        try {
            await navigator.clipboard.writeText(asset === 'logo' ? logoSvg() : wordmarkSvg());
            cue('success', { volume: 0.4 });
            setCopied({ asset, format: 'svg' });
        } catch {
            cue('error');
        }
    }
    /* The same mark rasterised on this device at twice its canvas, for places that take no SVG. */
    async function copyPng(asset: Asset) {
        try {
            const svg = asset === 'logo' ? logoSvg() : wordmarkSvg();
            const size = asset === 'logo' ? { width: LOGO_SIDE, height: LOGO_SIDE } : WORDMARK_SIZE;
            const image = new Image();
            image.decoding = 'async';
            await new Promise<void>((resolve, reject) => {
                image.onload = () => resolve();
                image.onerror = () => reject(new Error('The mark could not be drawn.'));
                image.src = `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
            });
            const canvas = document.createElement('canvas');
            canvas.width = size.width * 2;
            canvas.height = size.height * 2;
            canvas.getContext('2d')!.drawImage(image, 0, 0, canvas.width, canvas.height);
            const blob = await new Promise<Blob | null>((resolve) =>
                canvas.toBlob(resolve, 'image/png'),
            );
            if (!blob) throw new Error('The mark could not be drawn.');
            await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
            cue('success', { volume: 0.4 });
            setCopied({ asset, format: 'png' });
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
                        className={cn('flex items-center rounded-md text-foreground', className)}
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
                        onCopy={(asset) => void copyPng(asset)}
                        label="Copy wordmark"
                    >
                        <Wordmark />
                    </CopyTile>
                    <CopyTile
                        asset="logo"
                        copied={copied}
                        onCopy={(asset) => void copyPng(asset)}
                        label="Copy logo"
                    >
                        <Logo className="h-6 w-auto" />
                    </CopyTile>
                </div>
                <ContextMenuSeparator className="my-2" />
                <SvgItem asset="wordmark" copied={copied} onCopy={(asset) => void copySvg(asset)}>
                    Copy wordmark as SVG
                </SvgItem>
                <SvgItem asset="logo" copied={copied} onCopy={(asset) => void copySvg(asset)}>
                    Copy logo as SVG
                </SvgItem>
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
