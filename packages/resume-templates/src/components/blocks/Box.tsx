// @jsxRuntime automatic
// @jsxImportSource react
import type { BoxContent } from '../../model/flows';
import type { ResumeView } from '../../model/view';
import { EntryItem } from './Entry';
import type { BlockLook } from './options';
import { Row } from './Row';
import { SectionHeading } from './SectionHeading';
import { Chips, SkillGroup } from './Skills';
import { Summary } from './Summary';

/** The inside of one box, by what the flow put in it, in the template's look (its icons, heads and lists). */
export function Box({ content, look }: { content: BoxContent; view: ResumeView; look: BlockLook }) {
  switch (content.type) {
    case 'heading':
      return <SectionHeading section={content.section} />;
    case 'entry':
      return <EntryItem section={content.section} entry={content.entry} look={look} />;
    case 'row':
      return <Row section={content.section} entries={content.entries} look={look} />;
    case 'summary':
      return <Summary section={content.section} />;
    case 'skills':
      return <SkillGroup section={content.section} group={content.group} look={look} />;
    case 'chips':
      return <Chips section={content.section} look={look} />;
  }
}
