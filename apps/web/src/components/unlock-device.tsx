import { revalidateLogic, useForm } from '@tanstack/react-form';
import { ArrowRightIcon } from 'lucide-react';
import { useState } from 'react';
import { z } from 'zod';
import { AuthInput } from '@/components/auth-input';
import { FormActions, FormNote, FormTable } from '@/components/form-rows';
import { PendingLabel } from '@/components/motion';
import { Button } from '@/components/ui/button';
import { authClient } from '@/lib/auth-client';
import { authError } from '@/lib/form';
import { cue } from '@/lib/sounds';

const unlockFields = z.object({ password: z.string().min(1, 'Enter your password.').max(128) });

/*
 * Unlocks the account key on this device without leaving the page. Signing in
 * again runs OPAQUE for the known email, which is exactly what unlocking is.
 */
export function UnlockDevice({
    user,
    onUnlocked,
    className,
}: {
    user: { email: string };
    onUnlocked?: () => void | Promise<void>;
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
            <FormTable className="border-0">
                <form.Field name="password">
                    {(field) => (
                        <AuthInput
                            label="Password"
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
                {error && <FormNote tone="destructive">{error}</FormNote>}
                <FormActions
                    action={
                        <Button
                            type="submit"
                            size="lg"
                            disabled={pending}
                            data-cuelume-press="pulse"
                        >
                            <PendingLabel pending={pending} idle="Unlock" busy="Unlocking…" />
                            <ArrowRightIcon aria-hidden="true" />
                        </Button>
                    }
                >
                    <span className="truncate">{user.email}</span>
                </FormActions>
            </FormTable>
        </form>
    );
}
