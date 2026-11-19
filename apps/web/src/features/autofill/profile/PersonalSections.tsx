'use client';

import { AutofillProfileSchema } from '@tailorit/shared/autofill';
import { TrashIcon } from '@/components/ui/icons';
import { IconButton } from '@/components/ui/IconButton';
import { useAuth } from '@/lib/auth';
import { COUNTRY_OPTIONS, PHONE_DEVICE_TYPE_OPTIONS, regionOptions, withCurrent } from '../options';
import { Section } from '../Section';
import { AddButton, FromResumeHint, SelectField, TextField } from './fields';
import { useProfileForm } from './form';

/** Another link a form may ask for ("Dribbble", "Google Scholar"): the contract keeps ten. */
const MAX_OTHER_LINKS = 10;

/** The contract's email rule: GET answers an empty email with the sign-in address only when this takes it. */
const EMAIL_RULE = AutofillProfileSchema.shape.contact.shape.email;

/** A country picker that may be left empty. */
export function CountryField({ path, label = 'Country' }: { path: string; label?: string }) {
  const form = useProfileForm();
  const value = form.read(path);
  return (
    <SelectField
      path={path}
      label={label}
      options={withCurrent(COUNTRY_OPTIONS, typeof value === 'string' ? value : null)}
      emptyLabel="No country"
      placeholder="Country"
    />
  );
}

/** A state or province: a list of codes for the United States and Canada (as forms offer them), else as written. */
export function RegionField({
  path,
  countryPath,
  label = 'State or province',
}: {
  path: string;
  countryPath: string;
  label?: string;
}) {
  const form = useProfileForm();
  const country = form.read(countryPath);
  const options = regionOptions(typeof country === 'string' ? country : null);
  if (!options) return <TextField path={path} label={label} maxLength={100} autoComplete="off" />;
  return (
    <SelectField
      path={path}
      label={label}
      options={withCurrent(options, form.text(path) || null)}
      emptyLabel="None"
      emptyValue=""
      placeholder={country === 'CA' ? 'Province' : 'State'}
    />
  );
}

/** A web address: the contract takes '' or one that starts with http:// or https://. */
function LinkField({
  path,
  label,
  placeholder = 'https://',
  hint,
}: {
  path: string;
  label: string;
  placeholder?: string;
  hint?: string;
}) {
  return (
    <TextField
      path={path}
      label={label}
      type="url"
      inputMode="url"
      maxLength={300}
      placeholder={placeholder}
      autoComplete="url"
      hint={hint}
    />
  );
}

export function NameSection() {
  return (
    <Section title="Name" description="As applications should show it.">
      <div className="grid gap-5 sm:grid-cols-2">
        <TextField path="profile.name.first" label="First name" required maxLength={100} autoComplete="given-name" />
        <TextField path="profile.name.middle" label="Middle name" maxLength={100} autoComplete="additional-name" />
        <TextField path="profile.name.last" label="Last name" required maxLength={100} autoComplete="family-name" />
        <TextField
          path="profile.name.suffix"
          label="Suffix"
          maxLength={20}
          placeholder="Jr., III"
          autoComplete="honorific-suffix"
        />
        <TextField
          path="profile.name.preferred"
          label="Preferred first name"
          maxLength={100}
          hint="Leave empty if it is your first name."
          autoComplete="nickname"
        />
      </div>
    </Section>
  );
}

export function ContactSection() {
  const form = useProfileForm();
  const { account } = useAuth();
  const email = form.text('profile.contact.email');
  // Sign-in takes some addresses the rule refuses ("jane&co@example.com"): applications get no email from those.
  const signInAddress = account?.email && EMAIL_RULE.safeParse(account.email).success ? account.email : null;
  return (
    <Section title="Contact" description="How employers reach you.">
      <div className="flex flex-col gap-5">
        <TextField
          path="profile.contact.email"
          label="Email"
          required
          type="email"
          maxLength={254}
          autoComplete="email"
          hint={!email.trim() && signInAddress ? `If empty, applications use ${signInAddress}.` : undefined}
        />
        <div className="grid gap-5 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_140px_140px]">
          <TextField
            path="profile.contact.phone.number"
            label="Phone"
            type="tel"
            maxLength={30}
            placeholder="+1 512 555 0100"
            autoComplete="tel"
          />
          <CountryField path="profile.contact.phone.country" label="Phone country" />
          <TextField path="profile.contact.phone.extension" label="Phone extension" inputMode="numeric" maxLength={8} />
          <SelectField
            path="profile.contact.phone.type"
            label="Phone type"
            options={PHONE_DEVICE_TYPE_OPTIONS}
            emptyLabel="Not said"
            placeholder="Phone type"
            hint="Mobile, home or work."
          />
        </div>
        <div className="grid gap-5 sm:grid-cols-2">
          <TextField path="profile.contact.address.line1" label="Address line 1" maxLength={200} autoComplete="address-line1" />
          <TextField path="profile.contact.address.line2" label="Address line 2" maxLength={200} autoComplete="address-line2" />
          <TextField path="profile.contact.address.city" label="City" maxLength={100} autoComplete="address-level2" />
          <RegionField path="profile.contact.address.region" countryPath="profile.contact.address.country" />
          <TextField path="profile.contact.address.postalCode" label="Postal code" maxLength={20} autoComplete="postal-code" />
          <CountryField path="profile.contact.address.country" />
        </div>
      </div>
    </Section>
  );
}

export function LinksSection() {
  const form = useProfileForm();
  const others = form.state.draft.profile.links.other;
  const changeOthers = (clears: string | null, next: (list: typeof others) => typeof others) =>
    form.dispatch({
      type: 'change',
      clears,
      recipe: (draft) => {
        const links = draft.profile.links;
        return { ...draft, profile: { ...draft.profile, links: { ...links, other: next(links.other) } } };
      },
    });
  return (
    <Section title="Links" description="Full addresses, starting with https://">
      <div className="flex flex-col gap-5">
        <div className="grid gap-5 sm:grid-cols-2">
          <LinkField path="profile.links.linkedin" label="LinkedIn" placeholder="https://www.linkedin.com/in/your-name" />
          <LinkField path="profile.links.github" label="GitHub" placeholder="https://github.com/your-name" />
          <LinkField path="profile.links.portfolio" label="Portfolio" />
          <LinkField path="profile.links.website" label="Website" />
          <LinkField
            path="profile.links.x"
            label="X (Twitter)"
            placeholder="https://x.com/your_name"
            hint="The address, or your @handle."
          />
          <LinkField
            path="profile.links.telegram"
            label="Telegram"
            placeholder="https://t.me/your_name"
            hint="The address, or your @username."
          />
        </div>
        {others.length > 0 && (
          <div className="flex flex-col gap-3">
            {others.map((link, index) => (
              <div key={index} className="grid grid-cols-[minmax(0,1fr)_minmax(0,2fr)_auto] items-start gap-3">
                <TextField path={`profile.links.other.${index}.label`} label="Label" maxLength={60} placeholder="Dribbble" />
                <LinkField path={`profile.links.other.${index}.url`} label="Address" />
                <IconButton
                  label={`Remove ${link.label || 'this link'}`}
                  tooltip="Remove"
                  icon={<TrashIcon size={16} />}
                  className="mt-6.5"
                  disabled={form.busy}
                  onClick={() => changeOthers('profile.links.other', (list) => list.filter((_, other) => other !== index))}
                />
              </div>
            ))}
          </div>
        )}
        {form.isFromResume('profile.links.other') && <FromResumeHint path="profile.links.other" />}
        <div>
          <AddButton
            label="Add another link"
            full={others.length >= MAX_OTHER_LINKS}
            onAdd={() => changeOthers(null, (list) => [...list, { label: '', url: '' }])}
          />
        </div>
      </div>
    </Section>
  );
}
