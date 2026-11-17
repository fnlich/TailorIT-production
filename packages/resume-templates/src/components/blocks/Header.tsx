// @jsxRuntime automatic
// @jsxImportSource react
import { Fragment } from 'react';
import type { ContactView, ResumeView } from '../../model/view';
import { useSlots } from '../../slots';
import { CONTACT_ICONS } from '../icons';

// The header across the top of page 1: the name, the title under it, the contact details, and the photo at the side.
// The template's spec says how the contacts print: each after its icon, as plain items, or as a line with " | " (or
// the template's own separator) between them; and, when it lists them in lines, in which order and on which line. A
// contact that is a link is an <a> around its text; the editor stops the click and edits instead.

function ContactText({ contact }: { contact: ContactView }) {
  const { Text, links } = useSlots();
  const text = <Text field={contact} />;
  if (!contact.href) return text;
  return links ? (
    <a className="rt-contact-link" href={contact.href}>
      {text}
    </a>
  ) : (
    <span className="rt-contact-link">{text}</span>
  );
}

/** The contacts of one line, with the template's separator between them when it prints separators. */
function ContactItems({ view, contacts }: { view: ResumeView; contacts: readonly ContactView[] }) {
  const style = view.spec.header.contact;
  const separator = view.spec.header.separator ?? ' | ';
  return contacts.map((contact, index) => {
    const Icon = CONTACT_ICONS[contact.field];
    return (
      <Fragment key={contact.path}>
        {style === 'separators' && index > 0 ? <span className="rt-contact-sep">{separator}</span> : null}
        <span className="rt-contact" data-contact={contact.field}>
          {style === 'icons' ? <Icon /> : null}
          <ContactText contact={contact} />
        </span>
      </Fragment>
    );
  });
}

function Contacts({ view }: { view: ResumeView }) {
  const style = view.spec.header.contact;
  const contacts = view.header.contacts;
  if (contacts.length === 0) return null;
  if (!view.spec.header.contactLines) {
    return (
      <div className="rt-contacts" data-style={style}>
        <ContactItems view={view} contacts={contacts} />
      </div>
    );
  }
  // The template's lines, each with something on it, in order.
  const lines = [...new Set(contacts.map((contact) => contact.line))].sort((a, b) => a - b);
  return (
    <div className="rt-contacts" data-style={style}>
      {lines.map((line) => (
        <div key={line} className="rt-contact-line">
          <ContactItems view={view} contacts={contacts.filter((contact) => contact.line === line)} />
        </div>
      ))}
    </div>
  );
}

export function Header({ view }: { view: ResumeView }) {
  const { Text, Photo } = useSlots();
  const { name, title, photo } = view.header;
  return (
    <header className="rt-header" data-align={view.spec.header.align}>
      <div className="rt-header-main">
        <Text field={name} as="h1" className="rt-name" />
        {title ? <Text field={title} as="p" className="rt-title" /> : null}
        <Contacts view={view} />
      </div>
      {photo ? <Photo photoId={photo.photoId} shape={photo.shape} className="rt-header-photo" /> : null}
    </header>
  );
}
