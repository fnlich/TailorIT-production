// @jsxRuntime automatic
// @jsxImportSource react
import type { SectionView } from '../../model/view';
import { useSlots } from '../../slots';

/** A section's title over the rule the template draws under it. */
export function SectionHeading({ section }: { section: SectionView }) {
  const { Text } = useSlots();
  return (
    <div className="rt-heading">
      <Text field={section.heading} as="h2" className="rt-heading-text" />
    </div>
  );
}
