// @jsxRuntime automatic
// @jsxImportSource react
import type { ReactNode } from 'react';
import type { ContactField } from '../model/view';

// The few icons a resume prints, drawn here from plain shapes on a 16-unit grid. They take the text's size (1em) and
// colour (currentColor), carry no text of their own, and are hidden from readers and from the PDF's tagged text.

interface IconProps {
  className?: string;
}

function Icon({ name, className, children }: IconProps & { name: string; children: ReactNode }) {
  return (
    <svg
      className={className ? `rt-icon ${className}` : 'rt-icon'}
      data-icon={name}
      width="1em"
      height="1em"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {children}
    </svg>
  );
}

/** A mobile handset. */
export function PhoneIcon(props: IconProps) {
  return (
    <Icon name="phone" {...props}>
      <rect x="4.25" y="1.25" width="7.5" height="13.5" rx="1.75" />
      <path d="M7 12h2" />
    </Icon>
  );
}

/** An envelope. */
export function MailIcon(props: IconProps) {
  return (
    <Icon name="mail" {...props}>
      <rect x="1.5" y="3" width="13" height="10" rx="1.5" />
      <path d="m2.25 4.25 5.75 4.5 5.75-4.5" />
    </Icon>
  );
}

/** "in" in a rounded square. */
export function LinkedinIcon(props: IconProps) {
  return (
    <Icon name="linkedin" {...props}>
      <rect x="1.5" y="1.5" width="13" height="13" rx="2.5" />
      <path d="M5 7.25v4M5 4.75v.01M8 11.25v-4M8 9c0-1.1.9-1.75 1.75-1.75S11.5 7.9 11.5 9v2.25" />
    </Icon>
  );
}

/** A cat's head: ears, a round crown and a round jaw. */
export function GithubIcon(props: IconProps) {
  return (
    <Icon name="github" {...props}>
      <path d="M3.5 2.5 6 4.6a6.6 6.6 0 0 1 4 0l2.5-2.1v4.6a4.5 4.5 0 0 1-9 0Z" />
      <path d="M6.25 8.5v.01M9.75 8.5v.01" />
    </Icon>
  );
}

/** A globe, for a web address. */
export function LinkIcon(props: IconProps) {
  return (
    <Icon name="link" {...props}>
      <circle cx="8" cy="8" r="6.5" />
      <path d="M1.5 8h13M8 1.5c1.8 1.9 2.7 4 2.7 6.5S9.8 12.6 8 14.5M8 1.5C6.2 3.4 5.3 5.5 5.3 8s.9 4.6 2.7 6.5" />
    </Icon>
  );
}

/** A map pin. */
export function MapPinIcon(props: IconProps) {
  return (
    <Icon name="map-pin" {...props}>
      <path d="M8 14.5S3 10 3 6.25a5 5 0 0 1 10 0C13 10 8 14.5 8 14.5Z" />
      <circle cx="8" cy="6.25" r="1.75" />
    </Icon>
  );
}

/** A calendar page with its two rings. */
export function CalendarIcon(props: IconProps) {
  return (
    <Icon name="calendar" {...props}>
      <rect x="1.75" y="2.75" width="12.5" height="11.5" rx="1.5" />
      <path d="M1.75 6.25h12.5M5.25 1.25v3M10.75 1.25v3" />
    </Icon>
  );
}

/** A filled diamond, the marker before a strength. */
export function StrengthIcon(props: IconProps) {
  return (
    <Icon name="strength" {...props}>
      <path d="M8 1.75 14.25 8 8 14.25 1.75 8Z" fill="currentColor" />
    </Icon>
  );
}

/** The icon before each contact detail in the header. */
export const CONTACT_ICONS: Readonly<Record<ContactField, (props: IconProps) => ReactNode>> = {
  phone: PhoneIcon,
  email: MailIcon,
  linkedin: LinkedinIcon,
  github: GithubIcon,
  portfolio: LinkIcon,
  location: MapPinIcon,
};
