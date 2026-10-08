'use client';

import { Toast as ToastPrimitive } from '@base-ui/react/toast';
import { cn } from 'cn';
import type * as React from 'react';
import { TriangleAlertIcon, XIcon } from 'lucide-react';
import { Spinner } from '@/components/motion';

/*
 * A toast is a dark notice, bottom right. It confirms something that already
 * happened (a copy, a move to Trash) and may offer one way back, such as Undo;
 * anything the user must act on stays inline as an Alert.
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
                'pointer-events-none fixed inset-x-4 bottom-[calc(1rem+var(--transfers-lift,0px)+var(--selection-lift,0px))] z-[70] mx-auto w-auto max-w-sm outline-none sm:right-6 sm:bottom-[calc(1.5rem+var(--transfers-lift,0px)+var(--selection-lift,0px))] sm:left-auto sm:mx-0 sm:w-full',
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
                'group/toast pointer-events-auto absolute right-0 bottom-0 z-[calc(1000-var(--toast-index))] w-full origin-bottom rounded-xl bg-snackbar text-on-snackbar shadow-xl outline-none select-none will-change-transform focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-snackbar-action',
                '[--gap:0.5rem] [--height:var(--toast-frontmost-height,var(--toast-height))] [--offset-y:calc(var(--toast-offset-y)*-1+calc(var(--toast-index)*var(--gap)*-1)+var(--toast-swipe-movement-y))] [--peek:0.5rem] [--scale:calc(max(0,1-(var(--toast-index)*0.06)))] [--shrink:calc(1-var(--scale))]',
                'h-(--height) [transform:translateX(var(--toast-swipe-movement-x))_translateY(calc(var(--toast-swipe-movement-y)-(var(--toast-index)*var(--peek))-(var(--shrink)*var(--height))))_scale(var(--scale))] [transition:transform_400ms_var(--ease-out-expo),opacity_300ms_var(--ease-out-expo),height_150ms] motion-reduce:transition-none',
                "after:absolute after:top-full after:left-0 after:h-[calc(var(--gap)+1px)] after:w-full after:content-['']",
                'data-expanded:h-(--toast-height) data-expanded:[transform:translateX(var(--toast-swipe-movement-x))_translateY(var(--offset-y))]',
                // Coming and going they fade as they slide: lifted over the transfers panel, a solid toast would cross it.
                'data-limited:opacity-0 data-starting-style:opacity-0 data-starting-style:[transform:translateY(150%)] data-ending-style:opacity-0',
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
                'flex h-full items-stretch overflow-hidden rounded-xl transition-opacity duration-200 ease-out-soft data-behind:opacity-0 data-expanded:opacity-100',
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
            className={cn('text-sm leading-snug font-semibold', className)}
            {...props}
        />
    );
}

function ToastDescription({ className, ...props }: ToastPrimitive.Description.Props) {
    return (
        <ToastPrimitive.Description
            data-slot="toast-description"
            className={cn('text-[13px] leading-snug wrap-anywhere opacity-80', className)}
            {...props}
        />
    );
}

/* The toast's one way back, such as Undo: words in the notice's accent colour. */
function ToastActionButton(props: React.ComponentProps<'button'>) {
    return (
        <button
            type="button"
            className="cursor-pointer rounded-md px-2 py-1 text-sm font-semibold text-snackbar-action outline-none hover:bg-on-snackbar/10 focus-visible:outline-2 focus-visible:outline-snackbar-action"
            {...props}
        />
    );
}

function ToastAction({
    className,
    render = <ToastActionButton />,
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
            className={cn(
                'flex w-10 shrink-0 cursor-pointer items-center justify-center opacity-70 transition-opacity outline-none hover:opacity-100 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-snackbar-action',
                className,
            )}
            {...props}
        >
            {children ?? <XIcon className="size-4" aria-hidden="true" />}
        </ToastPrimitive.Close>
    );
}

/* The type mark, only where the words need help: a failure, a warning, or work still going. */
function ToastIcon({ type }: { type: string | undefined }) {
    if (type === 'error')
        return (
            <XIcon
                data-slot="toast-icon"
                className="size-4 shrink-0"
                strokeWidth={2.6}
                aria-hidden="true"
            />
        );
    if (type === 'warning')
        return (
            <TriangleAlertIcon
                data-slot="toast-icon"
                className="size-4 shrink-0"
                strokeWidth={2.4}
                aria-hidden="true"
            />
        );
    if (type === 'loading') return <Spinner className="size-4 shrink-0" />;
    return null;
}

function ToastList() {
    const { toasts } = ToastPrimitive.useToastManager();
    return toasts.map((item) => (
        <Toast key={item.id} toast={item}>
            <ToastContent>
                <div className="flex min-w-0 flex-1 items-center gap-3 py-3.5 pr-1 pl-4">
                    <ToastIcon type={item.type} />
                    <div className="flex min-w-0 flex-1 flex-col gap-0.5">
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
