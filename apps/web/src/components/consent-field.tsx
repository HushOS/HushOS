import { Link } from '@tanstack/react-router';
import { messagesOf } from '@/components/auth-input';
import { FormRow } from '@/components/form-rows';
import { Checkbox } from '@/components/ui/checkbox';

export function ConsentField({
    checked,
    onChange,
    onBlur,
    errors,
    disabled,
}: {
    checked: boolean;
    onChange: (value: boolean) => void;
    onBlur?: () => void;
    errors: unknown[];
    disabled?: boolean;
}) {
    const message = messagesOf(errors);
    const invalid = message.length > 0;
    return (
        <FormRow label="Terms" htmlFor="agree" invalid={invalid}>
            <div className="flex h-12 items-center gap-3 px-4">
                <Checkbox
                    id="agree"
                    checked={checked}
                    onCheckedChange={(value) => onChange(value === true)}
                    onBlur={onBlur}
                    aria-invalid={invalid}
                    aria-describedby={invalid ? 'agree-error' : undefined}
                    disabled={disabled}
                />
                <label htmlFor="agree" className="font-mono text-sm leading-none select-none">
                    I agree to the{' '}
                    <Link to="/terms" target="_blank" className="text-link">
                        Terms of Service
                    </Link>{' '}
                    and{' '}
                    <Link to="/privacy" target="_blank" className="text-link">
                        Privacy Policy
                    </Link>
                    .
                </label>
            </div>
            {invalid && (
                <p
                    id="agree-error"
                    role="alert"
                    className="border-t bg-destructive/15 px-4 py-2 font-mono text-[11px] leading-relaxed text-foreground animate-in fade-in duration-200 ease-out-expo"
                >
                    {message}
                </p>
            )}
        </FormRow>
    );
}
