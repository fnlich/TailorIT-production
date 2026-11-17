// @jsxRuntime automatic
// @jsxImportSource react
import type { EntryView, SectionView } from '../../model/view';
import { EntryItem } from './Entry';
import type { BlockLook } from './options';

// Short entries side by side, `perRow` equal columns (the template's CSS keys the grid to `data-per-row`). A row is one
// box, so each cell carries its entry's address itself, as an entry box does.

interface RowProps {
  section: SectionView;
  entries: readonly EntryView[];
  look: BlockLook;
}

export function Row({ section, entries, look }: RowProps) {
  return (
    <div className="rt-row" data-per-row={section.perRow}>
      {entries.map((entry) => (
        <div
          key={entry.path}
          className="rt-row-cell"
          data-rt-entry={entry.path}
          data-placeholder-entry={entry.placeholder ? '' : undefined}
        >
          <EntryItem section={section} entry={entry} look={look} />
        </div>
      ))}
    </div>
  );
}
