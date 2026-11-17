// @jsxRuntime automatic
// @jsxImportSource react
import type { SectionView } from '../../model/view';
import { useSlots } from '../../slots';

/** The summary paragraph, with its formatting and links. */
export function Summary({ section }: { section: SectionView }) {
  const { RichText } = useSlots();
  if (section.body.type !== 'summary') return null;
  return <RichText field={section.body.text} as="div" className="rt-summary" />;
}
