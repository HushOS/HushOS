import type { SecurityAction, SessionUser } from '@hushos/auth/protocol';
import { createFileRoute, Link, useRouter } from '@tanstack/react-router';
import { revalidateLogic, useForm } from '@tanstack/react-form';
import { ArrowRightIcon, ChevronRightIcon, PencilIcon, TriangleAlertIcon } from 'lucide-react';
import { useState } from 'react';
import { z } from 'zod';
import { AccountSecurityForm, securityLabels } from '@/components/account-security-form';
import { ProfileNameForm } from '@/components/profile-name-form';
import { AuthInput } from '@/components/auth-input';
import { CopyValue } from '@/components/copy-value';
import { FormActions, FormNote, FormTable } from '@/components/form-rows';
import { Collapse, PendingLabel } from '@/components/motion';
import { PageHeader } from '@/components/page-header';
import { Button } from '@/components/ui/button';
import { authClient } from '@/lib/auth-client';
import { authError } from '@/lib/form';
import { cue } from '@/lib/sounds';

export const Route = createFileRoute('/_authenticated/app/account')({
    head: () => ({ meta: [{ title: 'Account settings · HushOS' }] }),
    component: AccountPage,
});

const rowLabel = 'w-28 shrink-0 text-sm text-muted-foreground';

function Row({ label, value, copy }: { label: string; value: string; copy?: boolean }) {
    return (
        <div className="flex min-h-[46px] flex-wrap items-center gap-x-4 gap-y-1 px-4 py-3">
            <dt className={rowLabel}>{label}</dt>
            <dd
                className={`min-w-0 flex-1 wrap-anywhere ${copy ? 'font-mono text-[13px]' : 'text-sm'}`}
            >
                {copy ? <CopyValue value={value} label={label} /> : value}
            </dd>
        </div>
    );
}

/* An editable row: the whole row is the control, and the blue pencil says so. */
function EditableRow({
    label,
    value,
    disabled,
    onEdit,
}: {
    label: string;
    value: string;
    disabled?: boolean;
    onEdit: () => void;
}) {
    return (
        <button
            type="button"
            disabled={disabled}
            onClick={onEdit}
            aria-label={`Edit ${label.toLowerCase()}`}
            className="flex min-h-[46px] w-full cursor-pointer flex-wrap items-center gap-x-4 gap-y-1 px-4 py-3 text-left transition-colors outline-none hover:bg-muted focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring disabled:pointer-events-none disabled:opacity-50"
        >
            <span className={rowLabel}>{label}</span>
            <span className="flex min-w-0 flex-1 items-center justify-between gap-4 text-sm">
                <span className="truncate">{value}</span>
                <PencilIcon className="size-3.5 shrink-0 text-primary" aria-hidden="true" />
            </span>
        </button>
    );
}

const box = 'divide-y divide-rule overflow-hidden rounded-md border border-rule';

function Section({
    id,
    title,
    description,
    children,
}: {
    id: string;
    title: string;
    description: string;
    children: React.ReactNode;
}) {
    return (
        <section aria-labelledby={id} className="flex flex-col gap-4">
            <div>
                <h2 id={id} className="text-lg font-bold">
                    {title}
                </h2>
                <p className="mt-1.5 max-w-2xl text-sm leading-relaxed text-muted-foreground">
                    {description}
                </p>
            </div>
            <div className={box}>{children}</div>
        </section>
    );
}

/* What an action is for on the left, the button that starts it on the right. */
function ActionRow({
    title,
    description,
    tone = 'default',
    children,
}: {
    title: string;
    description: string;
    tone?: 'default' | 'destructive';
    children: React.ReactNode;
}) {
    return (
        <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-3 px-4 py-3.5">
            <div className="min-w-0 flex-1 basis-64">
                <p
                    className={`flex items-center gap-2 text-sm font-medium ${tone === 'destructive' ? 'text-destructive' : ''}`}
                >
                    {tone === 'destructive' && (
                        <TriangleAlertIcon className="size-3.5" aria-hidden="true" />
                    )}
                    {title}
                </p>
                <p className="mt-1 max-w-xl text-sm leading-relaxed text-muted-foreground">
                    {description}
                </p>
            </div>
            <div className="flex flex-wrap gap-2">{children}</div>
        </div>
    );
}

/*
 * A security action: its row opens into an inline form, using the same
 * collapse as the delete confirmation so every section moves alike.
 */
function SecurityRow({
    action,
    user,
    title,
    description,
    open,
    disabled,
    before,
    onOpen,
    onClose,
    onSuccess,
    onPending,
}: {
    action: SecurityAction;
    user: SessionUser;
    title: string;
    description: string;
    open: boolean;
    disabled: boolean;
    /* A sibling action that shares the row. */
    before?: React.ReactNode;
    onOpen: () => void;
    onClose: () => void;
    onSuccess: () => void;
    onPending: (pending: boolean) => void;
}) {
    return (
        <>
            <Collapse open={!open}>
                <ActionRow title={title} description={description}>
                    {before}
                    <Button variant="outline" size="sm" disabled={disabled} onClick={onOpen}>
                        {securityLabels[action]} <ArrowRightIcon aria-hidden="true" />
                    </Button>
                </ActionRow>
            </Collapse>
            <Collapse open={open}>
                <AccountSecurityForm
                    user={user}
                    action={action}
                    onCancel={onClose}
                    onPending={onPending}
                    onSuccess={onSuccess}
                />
            </Collapse>
        </>
    );
}

function AccountPage() {
    const { user } = Route.useRouteContext();
    const router = useRouter();
    const [securityAction, setSecurityAction] = useState<SecurityAction | null>(null);
    const [securityPending, setSecurityPending] = useState(false);
    const [securitySuccess, setSecuritySuccess] = useState('');
    const [editingName, setEditingName] = useState(false);
    const [nameSuccess, setNameSuccess] = useState('');
    const [confirming, setConfirming] = useState(false);
    const [pending, setPending] = useState(false);
    const [error, setError] = useState('');
    /* One inline form at a time: opening any of them closes the others. */
    function openSecurity(action: SecurityAction) {
        setSecurityAction(action);
        setSecuritySuccess('');
        setEditingName(false);
        setNameSuccess('');
        setConfirming(false);
    }
    const deleteFields = z.object({
        email: z
            .string()
            .trim()
            .refine(
                (value) => value.toLowerCase() === user.email.toLowerCase(),
                'Enter your account email to confirm.',
            ),
        password: z.string().min(1, 'Enter your password.').max(128),
    });
    const form = useForm({
        defaultValues: { email: '', password: '' },
        validationLogic: revalidateLogic(),
        validators: { onDynamic: deleteFields },
        onSubmit: async ({ value }) => {
            setPending(true);
            setError('');
            try {
                await authClient.deleteAccount(value.password);
                form.reset();
                router.options.context.queryClient.clear();
                await router.invalidate();
                await router.navigate({ to: '/account-deleted', replace: true });
            } catch (error) {
                cue('error');
                setError(authError(error));
            } finally {
                setPending(false);
            }
        },
    });
    return (
        <div className="flex flex-col">
            <PageHeader
                eyebrow="Account"
                title="Account settings"
                description="Manage your password, encryption keys, and account."
            />
            <div className="flex max-w-3xl flex-col gap-10 px-5 py-6 sm:px-8 sm:py-8">
                <Section
                    id="profile-title"
                    title="You"
                    description="Your name, email, and password."
                >
                    <Collapse open={Boolean(nameSuccess)}>
                        <output className="block">
                            <FormNote>{nameSuccess}</FormNote>
                        </output>
                    </Collapse>
                    <Collapse open={!editingName}>
                        <EditableRow
                            label="Name"
                            value={user.name}
                            disabled={securityPending || pending}
                            onEdit={() => {
                                setEditingName(true);
                                setNameSuccess('');
                                setSecurityAction(null);
                                setSecuritySuccess('');
                                setConfirming(false);
                            }}
                        />
                    </Collapse>
                    <Collapse open={editingName}>
                        <ProfileNameForm
                            user={user}
                            onCancel={() => setEditingName(false)}
                            onPending={setSecurityPending}
                            onSuccess={() => {
                                setEditingName(false);
                                setNameSuccess('Name updated.');
                            }}
                        />
                    </Collapse>
                    <dl>
                        <Row label="Email" value={user.email} />
                    </dl>
                    <Collapse open={Boolean(securitySuccess)}>
                        <output className="block">
                            <FormNote>{securitySuccess}</FormNote>
                        </output>
                    </Collapse>
                    <SecurityRow
                        action="password"
                        user={user}
                        title="Password"
                        description="The password you use to sign in and unlock your account key on this device."
                        open={securityAction === 'password'}
                        disabled={securityPending || pending}
                        onOpen={() => openSecurity('password')}
                        onClose={() => setSecurityAction(null)}
                        onPending={setSecurityPending}
                        onSuccess={() => {
                            setSecurityAction(null);
                            setSecuritySuccess(
                                'Password changed. Other sessions have been signed out.',
                            );
                        }}
                    />
                </Section>
                <Section
                    id="recovery-title"
                    title="If you forget your password"
                    description="Your 24 words are the only way to reset a forgotten password without losing your account key. Review them any time this device is unlocked."
                >
                    <SecurityRow
                        action="recovery-key"
                        user={user}
                        title="Recovery phrase"
                        description="Rotating it makes 24 new words; the old ones stop working."
                        open={securityAction === 'recovery-key'}
                        disabled={securityPending || pending}
                        before={
                            <Button
                                variant="outline"
                                size="sm"
                                render={<Link to="/app/recovery-key" />}
                                nativeButton={false}
                            >
                                View recovery phrase <ArrowRightIcon aria-hidden="true" />
                            </Button>
                        }
                        onOpen={() => openSecurity('recovery-key')}
                        onClose={() => setSecurityAction(null)}
                        onPending={setSecurityPending}
                        onSuccess={() => setSecurityAction(null)}
                    />
                </Section>
                <details className="group flex flex-col">
                    <summary className="flex cursor-pointer list-none items-center gap-2 rounded-xs select-none [&::-webkit-details-marker]:hidden">
                        <ChevronRightIcon
                            className="size-4 text-muted-foreground transition-transform group-open:rotate-90"
                            aria-hidden="true"
                        />
                        <h2 className="text-lg font-bold">Advanced</h2>
                    </summary>
                    <p className="mt-1.5 max-w-2xl text-sm leading-relaxed text-muted-foreground">
                        Your master key, your account ID, and deleting the account.
                    </p>
                    <div className={`${box} mt-4`}>
                        <SecurityRow
                            action="master-key"
                            user={user}
                            title="Master key"
                            description="The root key that protects your account’s private keys. Rotating it also creates a new recovery phrase."
                            open={securityAction === 'master-key'}
                            disabled={securityPending || pending}
                            onOpen={() => openSecurity('master-key')}
                            onClose={() => setSecurityAction(null)}
                            onPending={setSecurityPending}
                            onSuccess={() => setSecurityAction(null)}
                        />
                        <dl>
                            <Row label="Account ID" value={user.id} copy />
                        </dl>
                        <Collapse open={!confirming}>
                            <ActionRow
                                tone="destructive"
                                title="Permanently delete account"
                                description="This deletes your profile, personal workspace, storage allowance, encryption-key bundles, and all sessions. Your recovery phrase cannot restore a deleted account."
                            >
                                <Button
                                    variant="destructive-outline"
                                    size="sm"
                                    disabled={securityPending}
                                    onClick={() => {
                                        setConfirming(true);
                                        setSecurityAction(null);
                                        setSecuritySuccess('');
                                        setEditingName(false);
                                        setNameSuccess('');
                                    }}
                                >
                                    Delete account… <ArrowRightIcon aria-hidden="true" />
                                </Button>
                            </ActionRow>
                        </Collapse>
                        <Collapse open={confirming}>
                            <form
                                onSubmit={(event) => {
                                    event.preventDefault();
                                    void form.handleSubmit();
                                }}
                                noValidate
                                aria-busy={pending}
                            >
                                <FormTable className="border-0">
                                    <form.Field name="email">
                                        {(field) => (
                                            <AuthInput
                                                label="Email"
                                                hint="Type your account email to confirm."
                                                id="delete-email"
                                                name={field.name}
                                                type="email"
                                                autoComplete="off"
                                                placeholder={user.email}
                                                value={field.state.value}
                                                onChange={(event) =>
                                                    field.handleChange(event.target.value)
                                                }
                                                onBlur={field.handleBlur}
                                                errors={field.state.meta.errors}
                                                disabled={pending}
                                                required
                                            />
                                        )}
                                    </form.Field>
                                    <form.Field name="password">
                                        {(field) => (
                                            <AuthInput
                                                label="Password"
                                                id="delete-password"
                                                name={field.name}
                                                type="password"
                                                autoComplete="current-password"
                                                value={field.state.value}
                                                onChange={(event) =>
                                                    field.handleChange(event.target.value)
                                                }
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
                                                variant="destructive"
                                                size="lg"
                                                type="submit"
                                                disabled={pending}
                                            >
                                                <PendingLabel
                                                    pending={pending}
                                                    idle="Delete forever"
                                                    busy="Deleting…"
                                                />
                                                <TriangleAlertIcon aria-hidden="true" />
                                            </Button>
                                        }
                                    >
                                        <button
                                            type="button"
                                            className="text-link"
                                            disabled={pending}
                                            onClick={() => {
                                                setConfirming(false);
                                                form.reset();
                                                setError('');
                                            }}
                                        >
                                            Cancel
                                        </button>
                                    </FormActions>
                                </FormTable>
                            </form>
                        </Collapse>
                    </div>
                </details>
            </div>
        </div>
    );
}
