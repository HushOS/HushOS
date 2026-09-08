'use client';

import { Toast as ToastPrimitive } from '@base-ui/react/toast';
import { cn } from 'cn';
import { CheckIcon, InfoIcon, TriangleAlertIcon, XIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/motion';

/*
 * Toasts are the one thing allowed to float: a raised cell, bottom right, with
 * the hard offset shadow. They confirm something that already happened (a copy,
 * a download); anything the user must act on stays inline as an Alert.
 */

const toast = ToastPrimitive.createToastManager();

function ToastProvider({ ...props }: ToastPrimitive.Provider.Props) {
    return <ToastPrimitive.Provider {...props} />;
}

function ToastPortal({ ...props }: ToastPrimitive.Portal.Props) {
    return <ToastPrimitive.Portal data-slot="toast-portal" {...props} />;
}

function ToastViewport({ className, ...props }: ToastPrimitive.Viewport.Props) {
    return (
        <ToastPrimitive.Viewport
            data-slot="toast-viewport"
            className={cn(
                'pointer-events-none fixed inset-x-4 bottom-4 z-50 mx-auto w-auto max-w-sm outline-none sm:right-6 sm:bottom-6 sm:left-auto sm:mx-0 sm:w-full',
                className,
            )}
            {...props}
        />
    );
}

function Toast({ className, ...props }: ToastPrimitive.Root.Props) {
    return (
        <ToastPrimitive.Root
            data-slot="toast"
            className={cn(
                'group/toast pointer-events-auto absolute right-0 bottom-0 z-[calc(1000-var(--toast-index))] w-full origin-bottom border bg-popover text-popover-foreground shadow-hard outline-none select-none will-change-transform focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring',
                '[--gap:0.5rem] [--height:var(--toast-frontmost-height,var(--toast-height))] [--offset-y:calc(var(--toast-offset-y)*-1+calc(var(--toast-index)*var(--gap)*-1)+var(--toast-swipe-movement-y))] [--peek:0.5rem] [--scale:calc(max(0,1-(var(--toast-index)*0.06)))] [--shrink:calc(1-var(--scale))]',
                'h-(--height) [transform:translateX(var(--toast-swipe-movement-x))_translateY(calc(var(--toast-swipe-movement-y)-(var(--toast-index)*var(--peek))-(var(--shrink)*var(--height))))_scale(var(--scale))] [transition:transform_400ms_var(--ease-out-expo),opacity_300ms_var(--ease-out-expo),height_150ms] motion-reduce:transition-none',
                "after:absolute after:top-full after:left-0 after:h-[calc(var(--gap)+1px)] after:w-full after:content-['']",
                'data-expanded:h-(--toast-height) data-expanded:[transform:translateX(var(--toast-swipe-movement-x))_translateY(var(--offset-y))]',
                'data-limited:opacity-0 data-starting-style:[transform:translateY(150%)]',
                '[&[data-ending-style]:not([data-limited]):not([data-swipe-direction])]:[transform:translateY(150%)]',
                'data-ending-style:data-[swipe-direction=down]:[transform:translateY(calc(var(--toast-swipe-movement-y)+150%))]',
                'data-ending-style:data-[swipe-direction=left]:[transform:translateX(calc(var(--toast-swipe-movement-x)-150%))_translateY(var(--offset-y))]',
                'data-ending-style:data-[swipe-direction=right]:[transform:translateX(calc(var(--toast-swipe-movement-x)+150%))_translateY(var(--offset-y))]',
                'data-ending-style:data-[swipe-direction=up]:[transform:translateY(calc(var(--toast-swipe-movement-y)-150%))]',
                'data-expanded:data-ending-style:data-[swipe-direction=down]:[transform:translateY(calc(var(--toast-swipe-movement-y)+150%))]',
                'data-expanded:data-ending-style:data-[swipe-direction=left]:[transform:translateX(calc(var(--toast-swipe-movement-x)-150%))_translateY(var(--offset-y))]',
                'data-expanded:data-ending-style:data-[swipe-direction=right]:[transform:translateX(calc(var(--toast-swipe-movement-x)+150%))_translateY(var(--offset-y))]',
                'data-expanded:data-ending-style:data-[swipe-direction=up]:[transform:translateY(calc(var(--toast-swipe-movement-y)-150%))]',
                className,
            )}
            {...props}
        />
    );
}

function ToastContent({ className, ...props }: ToastPrimitive.Content.Props) {
    return (
        <ToastPrimitive.Content
            data-slot="toast-content"
            className={cn(
                'flex h-full items-stretch overflow-hidden transition-opacity duration-200 ease-out-soft data-behind:opacity-0 data-expanded:opacity-100',
                className,
            )}
            {...props}
        />
    );
}

function ToastTitle({ className, ...props }: ToastPrimitive.Title.Props) {
    return (
        <ToastPrimitive.Title
            data-slot="toast-title"
            className={cn('eyebrow text-foreground', className)}
            {...props}
        />
    );
}

function ToastDescription({ className, ...props }: ToastPrimitive.Description.Props) {
    return (
        <ToastPrimitive.Description
            data-slot="toast-description"
            className={cn(
                'font-mono text-xs leading-relaxed wrap-anywhere text-muted-foreground',
                className,
            )}
            {...props}
        />
    );
}

function ToastAction({
    className,
    render = <Button variant="outline" size="sm" />,
    ...props
}: ToastPrimitive.Action.Props) {
    return (
        <ToastPrimitive.Action
            data-slot="toast-action"
            render={render}
            className={cn('shrink-0', className)}
            {...props}
        />
    );
}

function ToastClose({ className, children, ...props }: ToastPrimitive.Close.Props) {
    return (
        <ToastPrimitive.Close
            data-slot="toast-close"
            aria-label="Dismiss"
            data-cuelume-press="press"
            data-cuelume-release="release"
            className={cn(
                'flex w-10 shrink-0 cursor-pointer items-center justify-center border-l text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring',
                className,
            )}
            {...props}
        >
            {children ?? <XIcon className="size-4" aria-hidden="true" />}
        </ToastPrimitive.Close>
    );
}

/* The type stamp: a small square in the strip colour with an ink glyph. */
function ToastIcon({ type }: { type: string | undefined }) {
    let icon: ReactNode = null;
    let tone = '';
    if (type === 'success') {
        icon = <CheckIcon strokeWidth={3} aria-hidden="true" />;
        tone = 'bg-success text-success-foreground';
    } else if (type === 'error') {
        icon = <XIcon strokeWidth={3} aria-hidden="true" />;
        tone = 'bg-destructive text-destructive-foreground';
    } else if (type === 'warning') {
        icon = <TriangleAlertIcon strokeWidth={2.5} aria-hidden="true" />;
        tone = 'bg-warning text-warning-foreground';
    } else if (type === 'info') {
        icon = <InfoIcon strokeWidth={2.5} aria-hidden="true" />;
        tone = 'border bg-card text-foreground';
    } else if (type === 'loading') {
        icon = <Spinner className="size-3" />;
        tone = 'border bg-card text-foreground';
    }
    if (!icon) return null;
    return (
        <span
            data-slot="toast-icon"
            className={cn(
                'grid size-5 shrink-0 place-items-center [&_svg]:pointer-events-none [&_svg:not([class*=size-])]:size-3',
                tone,
            )}
        >
            {icon}
        </span>
    );
}

function ToastList() {
    const { toasts } = ToastPrimitive.useToastManager();
    return toasts.map((item) => (
        <Toast key={item.id} toast={item}>
            <ToastContent>
                <div className="flex min-w-0 flex-1 items-center gap-3 px-4 py-3">
                    <ToastIcon type={item.type} />
                    <div className="flex min-w-0 flex-1 flex-col gap-1">
                        <ToastTitle />
                        <ToastDescription />
                    </div>
                    <ToastAction />
                </div>
                <ToastClose />
            </ToastContent>
        </Toast>
    ));
}

function Toaster({ children, toastManager = toast, ...props }: ToastPrimitive.Provider.Props) {
    return (
        <ToastProvider toastManager={toastManager} timeout={3_500} {...props}>
            {children}
            <ToastPortal>
                <ToastViewport>
                    <ToastList />
                </ToastViewport>
            </ToastPortal>
        </ToastProvider>
    );
}

const createToastManager = ToastPrimitive.createToastManager;
const useToastManager = ToastPrimitive.useToastManager;

export {
    Toaster,
    Toast,
    ToastAction,
    ToastClose,
    ToastContent,
    ToastDescription,
    ToastPortal,
    ToastProvider,
    ToastTitle,
    ToastViewport,
    createToastManager,
    toast,
    useToastManager,
};
