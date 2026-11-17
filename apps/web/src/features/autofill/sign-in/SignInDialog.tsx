'use client';

import { AUTOFILL_SIGN_IN_LIMITS, type AutofillSignInItem } from '@tailorit/shared/autofill';
import { clsx } from 'clsx';
import { forwardRef, useRef, useState, type FormEvent } from 'react';
import { Button } from '@/components/ui/Button';
import { Dialog, DialogContent, DialogFooter } from '@/components/ui/Dialog';
import { Field, useFieldControl } from '@/components/ui/Field';
import { EyeIcon } from '@/components/ui/icons';
import { IconButton } from '@/components/ui/IconButton';
import { CONTROL_SURFACE, Input } from '@/components/ui/Input';
import { Notice } from '@/components/ui/Notice';
import { RadioGroup } from '@/components/ui/RadioGroup';
import { ApiError, userMessage } from '@/lib/api';
import { redirectToLogin } from '@/lib/navigation';
import { saveSignIn } from '../api';
import {
  EVERY_SITE_COVERS,
  bodyOf,
  existingFor,
  formOf,
  hostLabel,
  problemsOf,
  validateSignIn,
  type SignInForm,
  type SignInProblems,
  type SignInScope,
} from './signIn';

const SCOPE_OPTIONS: { value: SignInScope; label: string; description: string }[] = [
  {
    value: 'any',
    label: 'All job sites',
    description: `Used on ${EVERY_SITE_COVERS}, unless a site has a sign-in of its own.`,
  },
  { value: 'site', label: 'One site', description: 'Only on the site you name, such as one company’s Workday.' },
];

/**
 * Asks the password managers that read these hints (1Password, LastPass, Dashlane) to leave this form alone. Chrome's
 * own manager reads none of them and may still offer to save the password: the field's hint says to choose Never.
 */
const NOT_A_LOGIN = { 'data-1p-ignore': 'true', 'data-lpignore': 'true', 'data-form-type': 'other' } as const;

/** Stands for "a password was typed" in the page's own checks, which never see the password itself. */
const TYPED = '•';

/** What the dialog keeps in its state: everything but the password, which stays in its field. */
type SignInFields = Omit<SignInForm, 'password'>;

/**
 * The password box: a plain uncontrolled input, so the password lives in the field alone (never in React's state, and
 * never written back into the page as an attribute). The dialog reads it once, at the save.
 */
const PasswordInput = forwardRef<
  HTMLInputElement,
  { shown: boolean; disabled: boolean; placeholder?: string; onTyped: (typed: boolean) => void }
>(function PasswordInput({ shown, disabled, placeholder, onTyped }, ref) {
  const field = useFieldControl({});
  return (
    <input
      ref={ref}
      id={field.id}
      aria-describedby={field['aria-describedby']}
      aria-invalid={field['aria-invalid']}
      type={shown ? 'text' : 'password'}
      disabled={disabled}
      // "off", not "new-password": Chrome answers "new-password" by offering to make up a password.
      autoComplete="off"
      autoCapitalize="none"
      autoCorrect="off"
      spellCheck={false}
      maxLength={AUTOFILL_SIGN_IN_LIMITS.password}
      placeholder={placeholder}
      onChange={(event) => onTyped(event.currentTarget.value !== '')}
      className={clsx(CONTROL_SURFACE, 'h-9 w-full min-w-0 px-3 pr-11')}
      {...NOT_A_LOGIN}
    />
  );
});

/**
 * Adds or edits a job-site sign-in. The password is typed into its field and stays there: the save reads it once and
 * sends it, and the field is emptied as the save succeeds or the dialog closes. It is never shown back: editing without
 * a new password keeps the saved one. The save is a plain call, not a cached mutation, so nothing keeps the password.
 */
export function SignInDialog({
  item,
  items,
  onClose,
  onSaved,
}: {
  /** The sign-in being edited, or null to add one. */
  item: AutofillSignInItem | null;
  /** Every saved sign-in: a site saved already is replaced, and keeps its password when none is typed. */
  items: readonly AutofillSignInItem[];
  onClose: () => void;
  onSaved: (saved: AutofillSignInItem, replaced: AutofillSignInItem | null) => void;
}) {
  const [form, setForm] = useState<SignInFields>(() => {
    const { scope, site, email } = formOf(item, items);
    return { scope, site, email };
  });
  const passwordRef = useRef<HTMLInputElement>(null);
  // Whether the password box holds anything: the only thing the page knows about the password.
  const [typed, setTyped] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const [tried, setTried] = useState(false);
  const [saving, setSaving] = useState(false);
  const [serverProblems, setServerProblems] = useState<SignInProblems>({});
  const [formError, setFormError] = useState<string | null>(null);

  const replaces = item ?? existingFor(form, items);
  const hasSaved = replaces !== null;
  // Problems show once a save was tried, then follow each change.
  const problems: SignInProblems = { ...(tried ? validateSignIn({ ...form, password: typed ? TYPED : '' }, hasSaved) : {}) };
  for (const [field, message] of Object.entries(serverProblems) as [keyof SignInProblems, string][]) {
    problems[field] ??= message;
  }

  const update = (patch: Partial<SignInFields>) => {
    setForm((current) => ({ ...current, ...patch }));
    setServerProblems((current) => {
      const next = { ...current };
      if ('scope' in patch || 'site' in patch) delete next.site;
      if ('email' in patch) delete next.email;
      return next;
    });
  };

  const clearPassword = () => {
    if (passwordRef.current) passwordRef.current.value = '';
    setTyped(false);
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (saving) return;
    setTried(true);
    setFormError(null);
    const whole: SignInForm = { ...form, password: passwordRef.current?.value ?? '' };
    if (Object.keys(validateSignIn(whole, hasSaved)).length > 0) return;
    setSaving(true);
    try {
      const saved = await saveSignIn(bodyOf(whole));
      clearPassword();
      onSaved(saved, replaces);
    } catch (error) {
      if (error instanceof ApiError && error.isSessionExpired) {
        redirectToLogin();
        return;
      }
      const fields = error instanceof ApiError ? problemsOf(error.fields) : {};
      setServerProblems(fields);
      if (Object.keys(fields).length === 0) setFormError(userMessage(error, 'The sign-in could not be saved. Please try again.'));
    } finally {
      setSaving(false);
    }
  };

  const close = () => {
    if (saving) return;
    clearPassword();
    onClose();
  };

  const title = item ? 'Edit job-site sign-in' : 'Add a job-site sign-in';
  return (
    <Dialog open onOpenChange={(open) => !open && close()}>
      <DialogContent
        title={title}
        description="The email and password you use to sign in to job sites, for the extension's Sign-in mode Auto."
        size="lg"
      >
        <form
          onSubmit={(event) => void submit(event)}
          noValidate
          autoComplete="off"
          className="mt-5 flex flex-col gap-5"
          {...NOT_A_LOGIN}
        >
          {item ? (
            <div className="flex flex-col gap-1">
              <p className="text-sm leading-5 font-medium text-foreground">Used on</p>
              <p className="text-sm leading-5 text-foreground">{hostLabel(item.host)}</p>
            </div>
          ) : (
            <div className="flex flex-col gap-3">
              <Field label="Use it on">
                <RadioGroup
                  options={SCOPE_OPTIONS}
                  value={form.scope}
                  disabled={saving}
                  onValueChange={(scope) => update({ scope })}
                />
              </Field>
              {form.scope === 'site' && (
                <Field
                  label="Site"
                  required
                  error={problems.site}
                  hint="Its host name as the address bar shows it, such as acme.wd5.myworkdayjobs.com. A pasted address works too."
                >
                  <Input
                    value={form.site}
                    disabled={saving}
                    inputMode="url"
                    spellCheck={false}
                    autoCapitalize="none"
                    autoComplete="off"
                    placeholder="acme.wd5.myworkdayjobs.com"
                    maxLength={2048}
                    onChange={(event) => update({ site: event.target.value })}
                  />
                </Field>
              )}
              {replaces && (
                <p className="text-[13px] leading-5 text-muted-foreground">
                  This replaces the sign-in saved for {hostLabel(replaces.host)}. Leave the password empty to keep its saved one.
                </p>
              )}
            </div>
          )}

          <Field label="Email" required error={problems.email}>
            <Input
              type="email"
              value={form.email}
              disabled={saving}
              spellCheck={false}
              autoCapitalize="none"
              autoComplete="off"
              maxLength={AUTOFILL_SIGN_IN_LIMITS.email}
              onChange={(event) => update({ email: event.target.value })}
              {...NOT_A_LOGIN}
            />
          </Field>

          <Field
            label={hasSaved ? 'New password' : 'Password'}
            required={!hasSaved}
            optional={hasSaved}
            error={problems.password}
            hint={
              <>
                {hasSaved
                  ? 'Leave it empty to keep the saved password. It is never shown here. '
                  : 'Typed exactly as you sign in with it. '}
                If your browser offers to save this password, choose Never: TailorIT keeps it.
              </>
            }
          >
            <div className="relative flex items-center">
              <PasswordInput
                ref={passwordRef}
                shown={showPassword}
                disabled={saving}
                placeholder={hasSaved ? 'Keep the saved password' : undefined}
                onTyped={(now) => {
                  setTyped(now);
                  setServerProblems((current) => {
                    const next = { ...current };
                    delete next.password;
                    return next;
                  });
                }}
              />
              <span className="absolute right-2 flex items-center">
                <IconButton
                  label="Show password"
                  aria-pressed={showPassword}
                  size="xs"
                  disabled={saving}
                  icon={<EyeIcon size={16} weight={showPassword ? 'fill' : 'regular'} />}
                  onClick={() => setShowPassword((shown) => !shown)}
                />
              </span>
            </div>
          </Field>

          {formError && <Notice tone="error">{formError}</Notice>}
          <DialogFooter flush>
            <Button variant="outline" onClick={close} disabled={saving}>
              Cancel
            </Button>
            <Button type="submit" loading={saving}>
              {saving ? 'Saving...' : 'Save sign-in'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
