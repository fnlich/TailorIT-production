import type { BoardDescriptor } from '@tailorit/shared/sourcing';
import { IngestError } from '../types';

// v38 FRAME: the board config an admin's import gives a board kind's source (import-sources.ts rememberImportBoard):
// only the kind's own key, read by its normaliser from the import's config, else from the board's name.

/** A string value as written, or '' (import-sources.ts reads the import's config so). */
export const importText = (value: unknown): string => (typeof value === 'string' ? value : '');

/**
 * The board's own config key from an import (`{ <configKey>: <board> }`), or IngestError("The import named no <board
 * words>.") when neither the import's config nor the board's name names one its normaliser reads.
 */
export function importBoardConfig(
  board: Pick<BoardDescriptor, 'configKey' | 'label' | 'boardWords' | 'boardOf'>,
  given: Record<string, unknown>,
  name: string,
): Record<string, unknown> {
  const value = board.boardOf(importText(given[board.configKey]) || name);
  if (!value) throw new IngestError(`The import named no ${board.boardWords ?? `${board.label} board`}.`);
  return { [board.configKey]: value };
}
