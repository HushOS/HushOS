import { revalidateLogic, useForm } from '@tanstack/react-form';
import { useState } from 'react';
import { z } from 'zod';
import { AuthInput } from '@/components/auth-input';
import { AuthNote } from '@/components/auth-layout';
import { Button } from '@/components/ui/button';
import { authClient } from '@/lib/auth-client';
import { authError } from '@/lib/form';
import { cue } from '@/lib/sounds';

const unlockFields = z.object({ password: z.string().min(1, 'Enter your password.').max(128) });

/*
 * Unlocks HushOS on this browser without leaving the page. Signing in again
 * runs OPAQUE for the known email, which is exactly what unlocking is.
 */
export function UnlockDevice({
    user,
    onUnlocked,
    onCancel,
    className,
}: {
    user: { email: string };
    onUnlocked?: () => void | Promise<void>;
    /* In a dialog: Cancel beside Unlock. */
    onCancel?: () => void;
    className?: string;
}) {
    const [pending, setPending] = useState(false);
    const [error, setError] = useState('');
    const form = useForm({
        defaultValues: { password: '' },
        validationLogic: revalidateLogic(),
        validators: { onDynamic: unlockFields },
        onSubmit: async ({ value }) => {
            setPending(true);
            setError('');
            try {
                await authClient.login(user.email, value.password);
                form.reset();
                cue('success');
                await onUnlocked?.();
            } catch (error) {
                cue('error');
                setError(authError(error));
            } finally {
                setPending(false);
            }
        },
    });
    return (
        <form
            className={className}
            onSubmit={(event) => {
                event.preventDefault();
                void form.handleSubmit();
            }}
            aria-busy={pending}
            noValidate
        >
            <div className="flex flex-col gap-4">
                {error && <AuthNote tone="danger">{error}</AuthNote>}
                <form.Field name="password">
                    {(field) => (
                        <AuthInput
                            label="Password"
                            hint={user.email}
                            id="unlock-password"
                            name={field.name}
                            type="password"
                            autoComplete="current-password"
                            value={field.state.value}
                            onChange={(event) => field.handleChange(event.target.value)}
                            onBlur={field.handleBlur}
                            errors={field.state.meta.errors}
                            disabled={pending}
                            required
                            maxLength={128}
                        />
                    )}
                </form.Field>
                <div className="flex justify-end gap-2">
                    {onCancel && (
                        <Button
                            type="button"
                            variant="outline"
                            disabled={pending}
                            onClick={onCancel}
                        >
                            Cancel
                        </Button>
                    )}
                    <Button type="submit" size={onCancel ? 'default' : 'lg'} disabled={pending}>
                        {pending ? 'Unlocking…' : 'Unlock'}
                    </Button>
                </div>
            </div>
        </form>
    );
}
